import { collectChanges, DEFAULT_EXCLUDES, type ChangeSet } from "./collect.js";
import { fallbackNotes } from "./fallback.js";
import { git, isShallow, listTags, refDate, resolveRef } from "./git.js";
import { renderMarkdown } from "./markdown.js";
import { TAGLORE_VERSION } from "./meta.js";
import { buildPrompt, extractJson } from "./prompt.js";
import { copilotProvider } from "./providers/copilot.js";
import { githubModelsProvider } from "./providers/github-models.js";
import type { AiProvider, ProviderName } from "./providers/types.js";
import { type OutFile, writeOutputDir } from "./publish/files.js";
import { GitHubReleases, parseRepo, RELEASE_ASSET_NAME } from "./publish/github-release.js";
import { uploadToS3 } from "./publish/s3.js";
import { sanitizeNotes } from "./sanitize.js";
import { assertFailOn, describeCounts, gateViolations } from "./security/diff.js";
import { renderSecuritySection } from "./security/markdown.js";
import { runSecurityScan } from "./security/scan.js";
import type { FailOn, SecurityReport } from "./security/types.js";
import { AiNotesSchema, type AiNotes, type ReleaseNotes, ReleaseNotesSchema, type ReleaseType, SCHEMA_VERSION } from "./schema.js";
import { announcementBase, type CompareMode, compareSemver, parseSemver, releaseTypeOf, resolveBase, shouldAnnounce } from "./version.js";

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface TagloreOptions {
  cwd?: string;
  /** Release ref (tag). Default: the tag that triggered the workflow, or the tag on HEAD. */
  to?: string;
  /** Base ref, only used with compare: "explicit". */
  from?: string;
  compare?: CompareMode;
  tagPrefix?: string;

  provider?: ProviderName;
  model?: string;
  copilotToken?: string;
  copilotCommand?: string;
  copilotArgs?: string[];
  /** Which release types get AI notes. Others use commit-based notes. Default: major, minor. */
  aiFor?: ReleaseType[];
  onAiFailure?: "fallback" | "fail";

  announceOn?: ReleaseType[];
  excludes?: string[];
  maxDiffKb?: number;
  language?: string;
  tone?: string;
  audience?: string;
  productName?: string;
  instructions?: string;

  /** GitHub token for releases (contents: write) and, with github-models, inference. */
  githubToken?: string;
  repository?: string;
  githubApiUrl?: string;
  githubServerUrl?: string;
  publishGithubRelease?: boolean;
  releaseDraft?: boolean;
  includeCommits?: boolean;
  /** Existing taglore.json to use as latest.json on patch releases (instead of downloading it). */
  baselineFile?: string;

  outputDir?: string;
  s3Uri?: string;
  s3Region?: string;
  dryRun?: boolean;
  log?: Logger;

  /** Scan both versions with Syft + Grype and add a Security section, security.json and sbom.cdx.json. */
  security?: boolean;
  /** Fail (before publishing anything) when the release introduces vulnerabilities at or above this severity. */
  securityFailOn?: FailOn;
  /** Max vulnerability rows in the Markdown table (the rest stay in security.json). */
  securityMaxItems?: number;
  /** Extra Syft exclude patterns, e.g. "./test/**". */
  securityExcludes?: string[];
  syftCommand?: string;
  /** Also scan this container image, e.g. "ghcr.io/acme/app:{version}" ({semver} = tag without "v"). Implies security. */
  securityImage?: string;
  /**
   * Reuse notes written by an earlier Taglore step (its release.json) instead of generating them again.
   * Typical use: notes before docker build (baked into the image), security with the image scan after it.
   */
  notesFrom?: string;
  grypeCommand?: string;
}

export interface TagloreResult {
  version: string;
  previousVersion: string | null;
  releaseType: ReleaseType;
  announce: boolean;
  provider: string;
  notes: ReleaseNotes;
  /** The announcement apps should show (this release, or the last major/minor). */
  latest: ReleaseNotes | null;
  markdown: string;
  files: OutFile[];
  writtenFiles: string[];
  s3Keys: string[];
  releaseUrl: string | null;
  compareUrl: string | null;
  /** Full security report when security scanning was enabled. */
  security: SecurityReport | null;
}

const consoleLog: Logger = { info: (m) => console.log(m), warn: (m) => console.warn(`warning: ${m}`) };

async function currentTag(cwd: string): Promise<string> {
  const ref = process.env.GITHUB_REF ?? "";
  if (ref.startsWith("refs/tags/")) return ref.slice("refs/tags/".length);
  try {
    return (await git(["describe", "--tags", "--exact-match", "HEAD"], cwd)).trim();
  } catch {
    throw new Error('No release tag found. Run on a tag push, or pass "to" (e.g. --to v1.9.0).');
  }
}

function makeProvider(o: TagloreOptions): AiProvider | null {
  switch (o.provider ?? "copilot") {
    case "none":
      return null;
    case "github-models": {
      const token = o.githubToken ?? process.env.GITHUB_TOKEN;
      if (!token) throw new Error("github-models needs a GitHub token (GITHUB_TOKEN with models: read).");
      return githubModelsProvider({ token, model: o.model });
    }
    case "copilot":
      return copilotProvider({
        token: o.copilotToken ?? process.env.COPILOT_GITHUB_TOKEN,
        model: o.model,
        command: o.copilotCommand,
        extraArgs: o.copilotArgs,
      });
    default:
      throw new Error(`Unknown provider "${o.provider}". Use copilot, github-models or none.`);
  }
}

async function aiNotes(provider: AiProvider, changes: ChangeSet, o: TagloreOptions, version: string, prev: string | null, log: Logger) {
  const prompt = buildPrompt(changes, {
    productName: o.productName ?? (o.repository?.split("/")[1] ?? "this application"),
    version,
    previousVersion: prev,
    language: o.language ?? "English",
    tone: o.tone ?? "friendly and concise",
    audience: o.audience ?? "end users of the application",
    instructions: o.instructions,
  });
  log.info(`Asking ${provider.name} (${Math.round(Buffer.byteLength(prompt) / 1024)} KB prompt)...`);
  const res = await provider.generate(prompt);
  const parsed = AiNotesSchema.parse(extractJson(res.text));
  return { notes: parsed, model: res.model };
}

export async function runTaglore(opts: TagloreOptions = {}): Promise<TagloreResult> {
  const o = { ...opts };
  const log = o.log ?? consoleLog;
  const cwd = o.cwd ?? process.cwd();
  const prefix = o.tagPrefix ?? "v";
  const compare = o.compare ?? "auto";
  const announceOn = o.announceOn ?? ["major", "minor"];
  const aiFor = o.aiFor ?? ["major", "minor"];
  const repository = o.repository ?? process.env.GITHUB_REPOSITORY;
  const serverUrl = o.githubServerUrl ?? process.env.GITHUB_SERVER_URL ?? "https://github.com";

  if (await isShallow(cwd)) {
    throw new Error("Shallow clone detected. Taglore needs tags and history: use actions/checkout with fetch-depth: 0.");
  }

  // 1. Versions
  const to = o.to ?? (await currentTag(cwd));
  await resolveRef(to, cwd);
  const tags = await listTags(cwd);
  const current = parseSemver(to, prefix);

  let from: string | null;
  let releaseType: ReleaseType;
  if (compare === "explicit") {
    if (!o.from) throw new Error('compare: "explicit" needs "from".');
    await resolveRef(o.from, cwd);
    from = o.from;
    releaseType = current ? releaseTypeOf(current) : "minor";
  } else {
    if (!current) throw new Error(`"${to}" is not a semver tag with prefix "${prefix}". Use compare: explicit for other refs.`);
    from = resolveBase(current, tags, compare, prefix)?.raw ?? null;
    releaseType = releaseTypeOf(current);
  }
  const announce = shouldAnnounce(releaseType, announceOn);
  log.info(`Taglore ${TAGLORE_VERSION}: ${from ?? "(first commit)"} -> ${to} [${releaseType}, announce=${announce}]`);

  // 2. Changes
  const provider = makeProvider(o);
  const maxDiffKb = o.maxDiffKb ?? (o.provider === "github-models" ? 20 : 100);
  const changes = await collectChanges({
    from,
    to,
    cwd,
    excludes: [...DEFAULT_EXCLUDES, ...(o.excludes ?? [])],
    maxDiffBytes: maxDiffKb * 1024,
  });
  log.info(`${changes.commits.length} commits, ${changes.files.length} files changed${changes.diffTruncated ? " (diff truncated)" : ""}`);

  // 2b. Security scan (deterministic, never AI). Runs before the AI call so a failing gate costs nothing.
  let security: SecurityReport | null = null;
  let sbom: string | null = null;
  let imageSbom: string | null = null;
  if (o.security || o.securityImage) {
    assertFailOn(o.securityFailOn ?? "none");
    const scan = await runSecurityScan({
      cwd,
      from,
      to,
      syft: o.syftCommand,
      grype: o.grypeCommand,
      excludes: o.securityExcludes,
      image: o.securityImage,
      log,
    });
    imageSbom = scan.imageSbom;
    security = scan.report;
    sbom = scan.sbom;
    log.info(`Security: open ${describeCounts(security.summary.open)}; introduced ${describeCounts(security.summary.introduced)}; fixed ${describeCounts(security.summary.fixed)}`);
    const violations = gateViolations(security, o.securityFailOn ?? "none");
    if (violations.length) {
      const list = violations.slice(0, 10).map((v) => `${v.id} (${v.severity}) in ${v.package} ${v.version}`).join("; ");
      throw new Error(
        `Security gate: ${violations.length} vulnerabilit${violations.length === 1 ? "y" : "ies"} at or above "${o.securityFailOn}" ${from ? `introduced since ${from}` : "in this first release"}: ${list}. Nothing was published.`,
      );
    }
  }

  // 3. Notes (AI or fallback)
  let body: AiNotes;
  let providerName = "fallback";
  let model: string | null = null;
  const reused = o.notesFrom ? await loadNotesFrom(o.notesFrom, to, cwd) : null;
  if (reused) {
    log.info(`Reusing the notes from ${o.notesFrom} (written by ${reused.generator.provider}).`);
    body = AiNotesSchema.parse(reused);
    providerName = reused.generator.provider;
    model = reused.generator.model;
  } else if (provider && aiFor.includes(releaseType) && changes.commits.length > 0) {
    try {
      const r = await aiNotes(provider, changes, o, to, from, log);
      body = r.notes;
      providerName = provider.name;
      model = r.model;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if ((o.onAiFailure ?? "fallback") === "fail") throw new Error(`AI generation failed: ${msg}`);
      log.warn(`AI generation failed, using commit-based notes instead. ${msg}`);
      body = fallbackNotes(changes.commits, to, { firstRelease: from === null });
    }
  } else {
    body = fallbackNotes(changes.commits, to, { firstRelease: from === null });
  }

  const notes = ReleaseNotesSchema.parse({
    ...sanitizeNotes(body),
    schemaVersion: SCHEMA_VERSION,
    version: to,
    previousVersion: from,
    releaseType,
    announce,
    date: await refDate(to, cwd),
    generator: { name: "taglore", version: TAGLORE_VERSION, provider: providerName, model },
    ...(security ? { security: security.summary } : {}),
  });

  // 4. Announcement for apps (latest.json)
  const releases =
    repository && (o.githubToken ?? process.env.GITHUB_TOKEN)
      ? new GitHubReleases((o.githubToken ?? process.env.GITHUB_TOKEN)!, parseRepo(repository), o.githubApiUrl)
      : null;

  let latest: ReleaseNotes | null = announce ? notes : null;
  if (!announce) {
    latest = await loadBaseline(o, current, tags, prefix, releases, log);
  }

  // 5. Render
  const compareUrl = repository && from ? `${serverUrl}/${repository}/compare/${from}...${to}` : null;
  const markdown = renderMarkdown(notes, {
    commits: changes.commits,
    compareUrl,
    includeCommits: o.includeCommits,
    securitySection: security ? renderSecuritySection(security, o.securityMaxItems) : undefined,
  });
  const files: OutFile[] = [
    { name: "release.json", content: JSON.stringify(notes, null, 2) + "\n", contentType: "application/json", cacheControl: "public, max-age=300" },
    { name: "RELEASE_NOTES.md", content: markdown, contentType: "text/markdown; charset=utf-8", cacheControl: "public, max-age=300" },
  ];
  if (security && sbom) {
    if (imageSbom) {
      files.push({ name: "sbom-image.cdx.json", content: imageSbom, contentType: "application/vnd.cyclonedx+json", cacheControl: "public, max-age=300" });
    }
    files.push(
      { name: "security.json", content: JSON.stringify(security, null, 2) + "\n", contentType: "application/json", cacheControl: "public, max-age=300" },
      { name: "sbom.cdx.json", content: sbom, contentType: "application/vnd.cyclonedx+json", cacheControl: "public, max-age=300" },
    );
  }
  if (latest) {
    files.push({ name: "latest.json", content: JSON.stringify(latest, null, 2) + "\n", contentType: "application/json", cacheControl: "public, max-age=60" });
  }

  // 6. Publish
  let writtenFiles: string[] = [];
  let s3Keys: string[] = [];
  let releaseUrl: string | null = null;

  if (o.dryRun) {
    log.info("Dry run: nothing published.");
  } else {
    if (o.outputDir) {
      writtenFiles = await writeOutputDir(o.outputDir, files, cwd);
      log.info(`Wrote ${writtenFiles.length} files to ${o.outputDir}`);
    }
    if (o.publishGithubRelease ?? true) {
      if (!releases) throw new Error("Publishing a GitHub Release needs a token and repository (or set publish-github-release: false).");
      const rel = await releases.upsert({
        tag: to,
        name: `${to}: ${notes.title}`,
        body: markdown,
        prerelease: releaseType === "prerelease",
        draft: o.releaseDraft ?? false,
        makeLatest: releaseType !== "prerelease",
      });
      await releases.uploadAsset(rel, RELEASE_ASSET_NAME, JSON.stringify(notes, null, 2) + "\n");
      for (const f of files.filter((f) => ["security.json", "sbom.cdx.json", "sbom-image.cdx.json"].includes(f.name))) {
        await releases.uploadAsset(rel, f.name, f.content, f.contentType);
      }
      releaseUrl = rel.html_url;
      log.info(`GitHub Release: ${releaseUrl}`);
    }
    if (o.s3Uri) {
      s3Keys = await uploadToS3(o.s3Uri, files, o.s3Region);
      log.info(`Uploaded ${s3Keys.length} files to ${o.s3Uri}`);
    }
  }

  return {
    version: to,
    previousVersion: from,
    releaseType,
    announce,
    provider: providerName,
    notes,
    latest,
    markdown,
    files,
    writtenFiles,
    s3Keys,
    releaseUrl,
    compareUrl,
    security,
  };
}

async function loadBaseline(
  o: TagloreOptions,
  current: ReturnType<typeof parseSemver>,
  tags: string[],
  prefix: string,
  releases: GitHubReleases | null,
  log: Logger,
): Promise<ReleaseNotes | null> {
  if (o.baselineFile) {
    const { readFile } = await import("node:fs/promises");
    return ReleaseNotesSchema.parse(JSON.parse(await readFile(o.baselineFile, "utf8")));
  }
  // Candidates: earlier X.Y.0 releases, newest first. The first one that was announced wins.
  const candidates = current ? announcementCandidates(current, tags, prefix) : [];
  if (!candidates.length) {
    log.warn("No earlier major/minor release found; latest.json will not be written.");
    return null;
  }
  if (!releases) {
    log.warn(`Cannot fetch the ${candidates[0]!.raw} announcement without a GitHub token; latest.json will not be written. Use baseline-file to provide it.`);
    return null;
  }
  for (const c of candidates.slice(0, 10)) {
    const raw = await releases.readAsset(c.raw);
    if (!raw) continue;
    const parsed = ReleaseNotesSchema.safeParse(JSON.parse(raw));
    if (parsed.success && parsed.data.announce) {
      log.info(`Reusing the ${c.raw} announcement for latest.json`);
      return parsed.data;
    }
  }
  log.warn(`No earlier release has an announced ${RELEASE_ASSET_NAME} asset; latest.json will not be written.`);
  return null;
}

function announcementCandidates(current: NonNullable<ReturnType<typeof parseSemver>>, tags: string[], prefix: string) {
  const base = announcementBase(current, tags, prefix);
  const all = tags
    .map((t) => parseSemver(t, prefix))
    .filter((v): v is NonNullable<typeof v> => v !== null && !v.prerelease && v.patch === 0 && v.raw !== current.raw)
    .filter((v) => compareSemver(v, current) < 0)
    .sort(compareSemver)
    .reverse();
  // Prefer the release this patch belongs to (v1.9.0 for v1.9.3), then older ones.
  return base && base.raw !== current.raw ? [base, ...all.filter((v) => v.raw !== base.raw)] : all;
}

/** Loads an earlier step's release.json and checks it belongs to this release. */
async function loadNotesFrom(path: string, version: string, cwd: string): Promise<ReleaseNotes> {
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  let raw: string;
  try {
    raw = await readFile(resolve(cwd, path), "utf8");
  } catch {
    throw new Error(`notes-from: cannot read ${path}. Point it at the release.json written by the earlier Taglore step (output-dir).`);
  }
  const parsed = ReleaseNotesSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`notes-from: ${path} is not a Taglore release.json.`);
  if (parsed.data.version !== version) {
    throw new Error(`notes-from: ${path} is for ${parsed.data.version}, but this release is ${version}.`);
  }
  return parsed.data;
}
