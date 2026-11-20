import { git } from "./git.js";

export interface Commit {
  sha: string;
  author: string;
  subject: string;
  body: string;
}

export interface ChangedFile {
  status: string;
  path: string;
}

export interface ChangeSet {
  from: string | null;
  to: string;
  commits: Commit[];
  files: ChangedFile[];
  stat: string;
  diff: string;
  diffTruncated: boolean;
  /** Per-file diffs in priority order (user-facing code first, tests/CI/docs last). */
  fileDiffs?: FileDiff[];
}

export interface FileDiff {
  path: string;
  diff: string;
  /** Cut to the per-file cap while collecting. */
  truncated: boolean;
  /** 0 = focus-paths, 1 = normal, 2 = tests, CI, docs, tooling. */
  priority: number;
}

/** Paths that rarely change what users see. They go last when the context budget runs out. */
const LOW_PRIORITY = [
  /(^|\/)(tests?|__tests__|specs?|e2e|cypress|playwright|fixtures?|__fixtures__|mocks?|__mocks__|testdata|test-utils)(\/|$)/i,
  /\.(test|spec|stories|story|bench)\.[a-z0-9]+$/i,
  /(^|\/)(\.github|\.circleci|\.husky|\.vscode|\.devcontainer)\//i,
  /(^|\/)(\.gitlab-ci\.yml|jenkinsfile|azure-pipelines\.yml|\.pre-commit-config\.yaml)$/i,
  /(^|\/)(docs?|examples?|scripts?|tools?|benchmarks?|storybook|\.storybook)\//i,
  /\.(md|mdx|rst|adoc)$/i,
  /(^|\/)[^/]*\.config\.[a-z0-9]+$/i,
  /(^|\/)(tsconfig[^/]*\.json|\.eslintrc[^/]*|\.prettierrc[^/]*|biome\.jsonc?|\.editorconfig|\.gitignore|\.dockerignore|renovate\.json|dependabot\.ya?ml)$/i,
];

/** Minimal glob for focus-paths: ** (any folders), * (within a folder), ?. A plain folder matches everything below it. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!/[*?]/.test(g)) return new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\/$/, "")}(\/|$)`);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*" && g[i + 1] === "*") {
      re += g[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += g[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function filePriority(path: string, focus: RegExp[]): number {
  if (focus.some((r) => r.test(path))) return 0;
  return LOW_PRIORITY.some((r) => r.test(path)) ? 2 : 1;
}

export const DEFAULT_EXCLUDES = [
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/bun.lockb",
  "**/bun.lock",
  "**/*.lock",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/node_modules/**",
  "**/*.min.js",
  "**/*.map",
  "**/*.snap",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.svg",
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.webp",
  "**/*.ico",
  "**/*.woff",
  "**/*.woff2",
  "**/*.pdf",
  "**/*.zip",
];

const RS = "\x1e";
const US = "\x1f";

function range(from: string | null, to: string): string {
  return from ? `${from}..${to}` : to;
}

function excludePathspecs(excludes: string[]): string[] {
  return excludes.map((e) => `:(exclude,glob)${e}`);
}

/**
 * Validates the folders/files a release is about (monorepos). Paths are relative to the
 * repository root; absolute paths and ".." are refused so nothing outside the repo is read.
 */
export function normalizePaths(paths: string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of paths ?? []) {
    // Backslashes count as separators too, so "..\\x" cannot slip past the ".." check on Windows.
    const p = raw.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    if (!p || p === ".") continue;
    if (p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split("/").includes("..") || p.startsWith(":")) {
      throw new Error(`Invalid path "${raw}": use a folder or file relative to the repository root, without "..".`);
    }
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** Only commits that touch `paths` (all commits when empty). */
export async function collectCommits(from: string | null, to: string, cwd: string, paths: string[] = []): Promise<Commit[]> {
  const out = await git(
    ["log", "--no-merges", `--format=%H${US}%an${US}%s${US}%b${RS}`, range(from, to), ...(paths.length ? ["--", ...paths] : [])],
    cwd,
  );
  return out
    .split(RS)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha = "", author = "", subject = "", body = ""] = r.split(US);
      return { sha, author, subject: subject.trim(), body: body.trim() };
    });
}

/**
 * Collects commits, changed files and a size-capped diff.
 * Each file's diff is capped so one huge file cannot crowd out the rest.
 */
export async function collectChanges(opts: {
  from: string | null;
  to: string;
  cwd: string;
  excludes: string[];
  maxDiffBytes: number;
  /** Limit the release to these folders/files (monorepos). Empty: the whole repository. */
  paths?: string[];
  /** Globs whose diffs go first when the budget runs out (e.g. src/app/**). */
  focusPaths?: string[];
}): Promise<ChangeSet> {
  const { from, to, cwd, excludes, maxDiffBytes } = opts;
  const paths = normalizePaths(opts.paths);
  const commits = await collectCommits(from, to, cwd, paths);

  // For a first release there is no base; diff against the empty tree.
  const base = from ?? (await git(["hash-object", "-t", "tree", "/dev/null"], cwd)).trim();
  const pathspec = ["--", ...(paths.length ? paths : ["."]), ...excludePathspecs(excludes)];

  const nameStatus = await git(["diff", "--name-status", "--no-renames", base, to, ...pathspec], cwd);
  const files = nameStatus
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [status = "", ...rest] = l.split("\t");
      return { status, path: rest.join("\t") };
    });

  const stat = await git(["diff", "--stat=120", base, to, ...pathspec], cwd);

  const focus = (opts.focusPaths ?? []).filter((f) => f.trim()).map(globToRegExp);
  // User-facing code first, tests/CI/docs last: when the budget runs out, the least useful part is cut.
  const ordered = files
    .map((f, i) => ({ f, i, priority: filePriority(f.path, focus) }))
    .sort((a, b) => a.priority - b.priority || a.i - b.i);
  const perFileCap = Math.max(4_000, Math.floor(maxDiffBytes / Math.max(1, Math.min(files.length, 20))));
  const fileDiffs: FileDiff[] = [];
  let size = 0;
  let truncated = false;
  for (const { f, priority } of ordered) {
    if (size >= maxDiffBytes) {
      truncated = true;
      fileDiffs.push({ path: f.path, diff: "", truncated: true, priority });
      continue;
    }
    let chunk = await git(["diff", "--unified=2", "--no-color", base, to, "--", f.path], cwd);
    let cut = false;
    if (Buffer.byteLength(chunk) > perFileCap) {
      chunk = chunk.slice(0, perFileCap) + `\n[... diff for ${f.path} truncated ...]\n`;
      cut = true;
      truncated = true;
    }
    size += Buffer.byteLength(chunk);
    fileDiffs.push({ path: f.path, diff: chunk, truncated: cut, priority });
  }
  let diff = fileDiffs.map((d) => d.diff).join("");
  if (Buffer.byteLength(diff) > maxDiffBytes) {
    diff = diff.slice(0, maxDiffBytes) + "\n[... remaining diff truncated ...]\n";
    truncated = true;
  }

  return { from, to, commits, files, stat, diff, diffTruncated: truncated, fileDiffs };
}
