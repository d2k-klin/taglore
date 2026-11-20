import { collectChanges, DEFAULT_EXCLUDES, normalizePaths, type ChangeSet } from "./collect.js";
import { type EvidenceMode, type EvidenceReport, renderEvidenceMarkdown, skippedEvidence, verifyEvidence } from "./evidence.js";
import { fallbackNotes } from "./fallback.js";
import { buildHistory, HISTORY_ASSET_NAME } from "./history.js";
import { renderPreview } from "./preview.js";
import { git, isShallow, listTags, refDate, resolveRef } from "./git.js";
import { renderMarkdown } from "./markdown.js";
import { TAGLORE_VERSION } from "./meta.js";
import { buildPromptWithReport, type ContextReport, extractJson } from "./prompt.js";
import { fillPlaceholders, loadFacts, type ReleaseVars } from "./facts.js";
import { compileTerms, evaluateAnswer, repairPrompt, styleIssues } from "./repair.js";
import { copilotProvider } from "./providers/copilot.js";
import { githubModelsProvider } from "./providers/github-models.js";
import type { AiProvider, ProviderName } from "./providers/types.js";
import { type OutFile, writeOutputDir } from "./publish/files.js";
import { GitHubReleases, parseRepo, RELEASE_ASSET_NAME, type ReleaseAsset, type ReleaseBodyMode } from "./publish/github-release.js";
import { uploadToS3 } from "./publish/s3.js";
import { sanitizeNotes } from "./sanitize.js";
import { assertFailOn, describeCounts, gateViolations } from "./security/diff.js";
import { renderSecuritySection } from "./security/markdown.js";
import { runSecurityScan } from "./security/scan.js";
import type { FailOn, SecurityReport } from "./security/types.js";
import { AiNotesSchema, type AiNotes, type History, HistorySchema, type ReleaseNotes, ReleaseNotesSchema, type ReleaseType, SCHEMA_VERSION } from "./schema.js";
import { BranchConflictError, BranchStore } from "./publish/branch-store.js";
import { announcementBase, type CompareMode, compareSemver, parseSemver, releaseTypeOf, resolveBase, type SemVer, shouldAnnounce, stableTags } from "./version.js";

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
  /** Which release types get AI notes. Others use commit-based notes. Default: major, minor (patches: see patchNotes). */
  aiFor?: ReleaseType[];
  /**
   * How patch releases are written. commits: from commit messages; ai: AI notes, the app keeps
   * the last major/minor announcement; announce: AI notes and a What's New of their own.
   * Adds to aiFor/announceOn, it never removes a type listed there. Default: ai.
   */
  patchNotes?: PatchNotesMode;
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
  /**
   * Monorepos: limit the release to these folders/files (commits, diff, evidence, security scan).
   * Pair with tagPrefix for per-app tags such as web-v1.2.0. Empty: the whole repository.
   */
  paths?: string[];
  /**
   * How to treat a GitHub Release that already has a body (e.g. Release Please's changelog):
   * replace (default) writes Taglore's notes and title; prepend/append keep the existing title and
   * body and put Taglore's notes before/after it. Re-runs replace only Taglore's part.
   */
  releaseBody?: ReleaseBodyMode;
  grypeCommand?: string;

  /**
   * What to do with statements no commit in the release supports.
   * warn (default): keep them and report them. strict: remove them.
   */
  evidence?: EvidenceMode;
  /** Write a self-contained review page (what users will see + the commits behind every statement). Also written on a dry run. */
  previewFile?: string;
  /** Releases kept in history.json (newest first). 0 turns history.json off. Default 20. */
  historyLimit?: number;
  /** Local history.json to continue from instead of reading earlier GitHub Releases. */
  historyFile?: string;
  /**
   * Onboarding: also write notes for up to this many earlier tags (oldest first), so the
   * changelog and patch releases have history from the first run. Tags whose GitHub Release
   * already has a taglore.json are skipped, so leaving it on costs one API call per tag.
   * Existing release text is kept (prepend) unless releaseBody is set. Max 50. Default 0.
   */
  backfill?: number;
  /**
   * Keep history.json and latest.json in this branch (created on first use, written through the
   * GitHub API). For immutable releases, or projects without GitHub Releases. Needs contents: write.
   */
  historyBranch?: string;
  /** Folder inside historyBranch. Default: none, or the tag prefix when it isn't "v" (monorepos). */
  historyBranchDir?: string;
  /** Facts for the AI per release: a file path with {version}/{from}/{to} placeholders. Missing file = no facts. */
  factsFile?: string;
  /** Facts for the AI per release: a shell command; gets TAGLORE_VERSION, TAGLORE_FROM, TAGLORE_TO, TAGLORE_RELEASE_TYPE. */
  factsCommand?: string;
  /** Words or /regex/ that must not appear in user-facing text (environment names, codenames...). */
  forbiddenTerms?: string[];
  /** What happens when the final notes still break a style rule: warn (default) or strict (fail, nothing published). */
  styleCheck?: "warn" | "strict";
  /** Globs whose diffs go first when a big release doesn't fit the context budget. */
  focusPaths?: string[];
  /**
   * Notes for the changes since the last release that aren't tagged yet (to defaults to HEAD).
   * No GitHub Release, no stored history; history.json gets the entry on top.
   */
  unreleased?: boolean;
  /** Version label for unreleased notes. Default: "Unreleased". */
  unreleasedLabel?: string;
  /** @internal Set for the per-tag runs of a backfill. */
  backfillRun?: boolean;
  /** @internal Notes already known to the caller (stored history, earlier backfill runs). */
  knownNotes?: ReleaseNotes[];
  /** @internal Extra Octokit options for the GitHub Releases client (tests). */
  octokitOptions?: Record<string, unknown>;
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
  /** Which commits stand behind each statement, and which statements have none. */
  evidence: EvidenceReport;
  /** Earlier tags that got notes written in this run (backfill), oldest first. */
  backfilled: string[];
  /** Review table for the evidence, as Markdown. */
  evidenceMarkdown: string;
  /** What part of the change the AI saw (null when no AI was asked). */
  context: ContextReport | null;
  /** Style rule violations left in the final notes (style-check: warn). */
  styleIssues: string[];
  history: History | null;
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

async function aiNotes(
  provider: AiProvider,
  changes: ChangeSet,
  o: TagloreOptions,
  vars: ReleaseVars,
  log: Logger,
  maxContextKb: number,
  facts: string | null,
) {
  const { prompt, context } = buildPromptWithReport(changes, {
    productName: o.productName ?? (o.repository?.split("/")[1] ?? "this application"),
    version: vars.version,
    previousVersion: vars.from,
    language: o.language ?? "English",
    tone: o.tone ?? "friendly and concise",
    audience: o.audience ?? "end users of the application",
    instructions: o.instructions ? fillPlaceholders(o.instructions, vars) : undefined,
    paths: normalizePaths(o.paths),
    maxContextBytes: maxContextKb * 1024,
    facts,
  });
  logContext(context, log);
  const terms = compileTerms(o.forbiddenTerms);
  log.info(`Asking ${provider.name} (${Math.round(Buffer.byteLength(prompt) / 1024)} KB prompt)...`);
  const first = await provider.generate(prompt);
  let ev = evaluateAnswer(first.text, extractJson, changes.commits, terms);
  if (!ev.issues.length && ev.notes) return { notes: ev.notes, model: first.model, context };
  // Length is the only problem: shorten in code, no second request.
  if (ev.trimmed && !styleIssues(ev.trimmed, changes.commits, terms).length) {
    log.warn(`Shortened the AI answer to fit the limits: ${ev.issues.join("; ")}`);
    return { notes: ev.trimmed, model: first.model, context };
  }
  log.warn(`The AI answer was rejected (${ev.issues.slice(0, 5).join("; ")}). Asking once more with the reasons.`);
  const second = await provider.generate(repairPrompt(prompt, first.text, ev.issues));
  ev = evaluateAnswer(second.text, extractJson, changes.commits, terms);
  if (ev.notes) {
    if (!ev.issues.length) log.info("The corrected answer passed.");
    // Remaining style issues are reported by the final style check (warn or strict).
    return { notes: ev.notes, model: second.model, context };
  }
  if (ev.trimmed) {
    log.warn(`Shortened the corrected AI answer to fit the limits: ${ev.issues.join("; ")}`);
    return { notes: ev.trimmed, model: second.model, context };
  }
  throw new Error(`the answer was still invalid after a retry: ${ev.issues.slice(0, 5).join("; ")}`);
}

function logContext(c: ContextReport, log: Logger) {
  if (!c.truncated) {
    log.info(`AI context: all ${c.commits.total} commits and ${c.files.diffFull} file diffs fit in ${c.budgetKb} KB.`);
    return;
  }
  const parts = [`${c.commits.shown}/${c.commits.total} commits`, `${c.files.diffFull}/${c.files.total} file diffs in full`];
  if (c.files.diffPartial.length) parts.push(`${c.files.diffPartial.length} cut short`);
  if (c.files.diffOmitted.length) parts.push(`${c.files.diffOmitted.length} left out`);
  log.warn(
    `AI context: the release is larger than max-diff-kb (${c.budgetKb} KB); the AI saw ${parts.join(", ")}. User-facing code goes first; tests, CI and docs last.` +
      (c.files.diffOmitted.length ? ` Left out: ${c.files.diffOmitted.slice(0, 15).join(", ")}${c.files.diffOmitted.length > 15 ? ", ..." : ""}.` : "") +
      " Raise max-diff-kb or set focus-paths to change that.",
  );
}

export type PatchNotesMode = "commits" | "ai" | "announce";

export async function runTaglore(opts: TagloreOptions = {}): Promise<TagloreResult> {
  const o = { ...opts };
  const log = o.log ?? consoleLog;
  const cwd = o.cwd ?? process.cwd();
  const prefix = o.tagPrefix ?? "v";
  const compare = o.compare ?? "auto";
  const patchNotes = o.patchNotes ?? "ai";
  if (!["commits", "ai", "announce"].includes(patchNotes)) {
    throw new Error(`Invalid patch-notes "${patchNotes}". Use commits, ai or announce.`);
  }
  const announceOn: ReleaseType[] = [...(o.announceOn ?? ["major", "minor"])];
  const aiFor: ReleaseType[] = [...(o.aiFor ?? ["major", "minor"])];
  if (patchNotes !== "commits" && !aiFor.includes("patch")) aiFor.push("patch");
  if (patchNotes === "announce" && !announceOn.includes("patch")) announceOn.push("patch");
  const paths = normalizePaths(o.paths);
  const releaseBody = o.releaseBody ?? (o.backfillRun ? "prepend" : "replace");
  const backfill = o.backfill ?? 0;
  if (!Number.isInteger(backfill) || backfill < 0 || backfill > 50) {
    throw new Error(`Invalid backfill "${o.backfill}". Use a number of earlier tags from 0 to 50.`);
  }
  if (!["replace", "prepend", "append"].includes(releaseBody)) {
    throw new Error(`Invalid release-body "${releaseBody}". Use replace, prepend or append.`);
  }
  const repository = o.repository ?? process.env.GITHUB_REPOSITORY;
  const serverUrl = o.githubServerUrl ?? process.env.GITHUB_SERVER_URL ?? "https://github.com";

  if (await isShallow(cwd)) {
    throw new Error("Shallow clone detected. Taglore needs tags and history: use actions/checkout with fetch-depth: 0.");
  }

  // 1. Versions
  const unreleased = !!o.unreleased;
  const to = o.to ?? (unreleased ? "HEAD" : await currentTag(cwd));
  const toSha = await resolveRef(to, cwd);
  const tags = await listTags(cwd);
  let current = parseSemver(to, prefix);

  let from: string | null;
  let releaseType: ReleaseType;
  if (unreleased) {
    // Changes since the newest release that is part of this branch.
    if (o.from) await resolveRef(o.from, cwd);
    from = o.from ?? (await latestMergedTag(to, prefix, cwd));
    releaseType = "unreleased";
    // A version just above the base, so earlier releases (history, announcement) resolve as for a patch.
    const base = from ? parseSemver(from, prefix) : null;
    current = base ? { ...base, patch: base.patch + 1, prerelease: null, raw: o.unreleasedLabel ?? "Unreleased" } : null;
    if (!aiFor.includes("unreleased")) aiFor.push("unreleased");
  } else if (compare === "explicit") {
    if (!o.from) throw new Error('compare: "explicit" needs "from".');
    await resolveRef(o.from, cwd);
    from = o.from;
    releaseType = current ? releaseTypeOf(current) : "minor";
  } else {
    if (!current) throw new Error(`"${to}" is not a semver tag with prefix "${prefix}". Use compare: explicit for other refs.`);
    from = resolveBase(current, tags, compare, prefix)?.raw ?? null;
    releaseType = releaseTypeOf(current);
  }
  // Unreleased changes are never announced, whatever announce-on says.
  const announce = !unreleased && shouldAnnounce(releaseType, announceOn);
  const version = unreleased ? (o.unreleasedLabel ?? "Unreleased") : to;
  const vars: ReleaseVars = { version, from, to, releaseType };
  log.info(`Taglore ${TAGLORE_VERSION}: ${from ?? "(first commit)"} -> ${to}${unreleased ? ` as "${version}"` : ""} [${releaseType}, announce=${announce}]`);

  // GitHub access and the stored history (history-file or history-branch), read once.
  const token = o.githubToken ?? process.env.GITHUB_TOKEN;
  const releases = repository && token ? new GitHubReleases(token, parseRepo(repository), o.githubApiUrl, o.octokitOptions) : null;
  const branchDir = (o.historyBranchDir ?? (prefix === "v" ? "" : prefix.replace(/[^A-Za-z0-9._-]/g, "_"))).replace(/^\/+|\/+$/g, "");
  const branchPath = (name: string) => (branchDir ? `${branchDir}/${name}` : name);
  let store: BranchStore | null = null;
  if (o.historyBranch && !o.backfillRun) {
    if (!repository || !token) throw new Error("history-branch needs a GitHub token and repository (contents: write).");
    store = new BranchStore(token, parseRepo(repository), o.historyBranch, o.githubApiUrl, o.octokitOptions);
  }
  const stored = o.backfillRun ? null : await loadStoredHistory(o, cwd, store, branchPath("history.json"), log);
  const known = new Map<string, ReleaseNotes>();
  for (const n of [...(stored ?? []), ...(o.knownNotes ?? [])]) known.set(n.version, n);

  // 1b. Onboarding: earlier tags first, oldest first, so patches find their minor's notes.
  const backfilledNotes: ReleaseNotes[] = [];
  const backfilled: string[] = [];
  if (backfill > 0) {
    if (compare === "explicit" || !current) throw new Error("backfill needs SemVer tags; it cannot be combined with compare: explicit.");
    const b = await runBackfill(o, current, tags, prefix, backfill, releases, known, log);
    backfilledNotes.push(...b.notes);
    backfilled.push(...b.written);
    for (const n of b.notes) known.set(n.version, n);
  }

  // 2. Changes
  const provider = makeProvider(o);
  // Copilot CLI models have 128k+ tokens of context: 300 KB (~75-90k tokens) leaves room for
  // instructions and the answer. GitHub Models' free tier caps a request at 8k input tokens.
  const maxDiffKb = o.maxDiffKb ?? (o.provider === "github-models" ? 20 : 300);
  if (!Number.isFinite(maxDiffKb) || maxDiffKb < 1 || maxDiffKb > 4096) {
    throw new Error(`Invalid max-diff-kb "${o.maxDiffKb}". Use a size in KB from 1 to 4096.`);
  }
  const changes = await collectChanges({
    from,
    to,
    cwd,
    excludes: [...DEFAULT_EXCLUDES, ...(o.excludes ?? [])],
    paths,
    maxDiffBytes: maxDiffKb * 1024,
    focusPaths: o.focusPaths,
  });
  log.info(
    `${changes.commits.length} commits, ${changes.files.length} files changed${paths.length ? ` in ${paths.join(", ")}` : ""}${changes.diffTruncated ? " (diff truncated)" : ""}`,
  );

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
      paths,
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
  let context: ContextReport | null = null;
  let providerName = "fallback";
  let model: string | null = null;
  const reused = o.notesFrom ? await loadNotesFrom(o.notesFrom, version, cwd) : null;
  if (reused) {
    log.info(`Reusing the notes from ${o.notesFrom} (written by ${reused.generator.provider}).`);
    body = AiNotesSchema.parse(reused);
    providerName = reused.generator.provider;
    model = reused.generator.model;
  } else if (provider && aiFor.includes(releaseType) && changes.commits.length > 0) {
    try {
      const facts = await loadFacts({ factsFile: o.factsFile, factsCommand: o.factsCommand, cwd }, vars, log);
      const r = await aiNotes(provider, changes, o, vars, log, maxDiffKb, facts);
      body = r.notes;
      providerName = provider.name;
      model = r.model;
      context = r.context;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Missing facts would mean wrong notes, not merely plainer ones: stop instead of falling back.
      if (/^facts-(command|file)/.test(msg)) throw e;
      if ((o.onAiFailure ?? "fallback") === "fail") throw new Error(`AI generation failed: ${msg}`);
      log.warn(`AI generation failed, using commit-based notes instead. ${msg}`);
      body = fallbackNotes(changes.commits, version, { firstRelease: from === null });
    }
  } else {
    body = fallbackNotes(changes.commits, version, { firstRelease: from === null });
  }

  // 3a. Style rules, checked in code (the AI step already retried once with the reasons).
  const styleCheck = o.styleCheck ?? "warn";
  if (styleCheck !== "warn" && styleCheck !== "strict") throw new Error(`Invalid style-check "${styleCheck}". Use warn or strict.`);
  // Reused notes (notes-from) are checked too: they may have been edited by hand after the review.
  const remainingStyle = styleIssues(body, changes.commits, compileTerms(o.forbiddenTerms));
  if (remainingStyle.length) {
    if (styleCheck === "strict") throw new Error(`Style check failed, nothing was published: ${remainingStyle.join("; ")}`);
    log.warn(`Style check: ${remainingStyle.join("; ")}`);
  }

  // 3b. Evidence: every statement must point at real commits in this range.
  const evidenceMode = o.evidence ?? "warn";
  if (evidenceMode !== "warn" && evidenceMode !== "strict") throw new Error(`Invalid evidence "${evidenceMode}". Use warn or strict.`);
  // Reused notes (notes-from) were checked when they were written. Checking them again would
  // flag or, in strict mode, delete statements from notes that are already published, and
  // notes written before 1.2 carry no commit references at all.
  const checked = reused
    ? { notes: sanitizeNotes(body), report: skippedEvidence(evidenceMode) }
    : verifyEvidence(sanitizeNotes(body), changes.commits, evidenceMode);
  const evidence = checked.report;
  if (reused) log.info("Evidence check skipped: the notes were checked when they were written.");
  if (evidence.unverified.length) {
    const titles = evidence.unverified.map((u) => u.title).join("; ");
    log.warn(
      evidence.removed
        ? `Removed ${evidence.unverified.length} statement(s) with no supporting commit: ${titles}`
        : `${evidence.unverified.length} statement(s) have no supporting commit (evidence: strict removes them): ${titles}`,
    );
  }

  const notes = ReleaseNotesSchema.parse({
    ...checked.notes,
    schemaVersion: SCHEMA_VERSION,
    version,
    previousVersion: from,
    releaseType,
    announce,
    date: await refDate(to, cwd),
    generator: { name: "taglore", version: TAGLORE_VERSION, provider: providerName, model },
    ...(security ? { security: security.summary } : {}),
  });

  // 4. Announcement for apps (latest.json)
  let latest: ReleaseNotes | null = announce ? notes : null;
  if (!announce) {
    latest = await loadBaseline(o, current, tags, prefix, releases, known, log);
    // Nothing earlier to show (Taglore was adopted on a patch, or no token to fetch it):
    // ship this release's notes, so the app's "What's new" menu still has content.
    // announce stays false, so nobody gets a popup for it.
    if (!latest && releaseType === "patch") {
      log.info("latest.json holds this release's own notes (announce: false, no popup).");
      latest = notes;
    }
  }

  // 5. Render
  const compareUrl = repository && from ? `${serverUrl}/${repository}/compare/${from}...${unreleased ? toSha : to}` : null;
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

  // 5b. History for a changelog page
  const historyLimit = o.historyLimit ?? 20;
  let history: History | null = null;
  if (historyLimit > 0 && releaseType !== "prerelease") {
    history = await buildHistory({ notes, current, tags, prefix, limit: historyLimit, stored, cwd, releases, log, extra: backfilledNotes });
    files.push({ name: "history.json", content: JSON.stringify(history, null, 2) + "\n", contentType: "application/json", cacheControl: "public, max-age=60" });
  }

  // 5c. Review page (not part of the published files: it lists commit subjects)
  if (o.previewFile) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname, resolve } = await import("node:path");
    const target = resolve(cwd, o.previewFile);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, renderPreview(notes, evidence, { repositoryUrl: repository ? `${serverUrl}/${repository}` : null, context, styleIssues: remainingStyle }), "utf8");
    log.info(`Preview written to ${o.previewFile}`);
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
    if (unreleased && (o.publishGithubRelease ?? true)) {
      log.info("Unreleased notes: no GitHub Release is created.");
    } else if (o.publishGithubRelease ?? true) {
      if (!releases) throw new Error("Publishing a GitHub Release needs a token and repository (or set publish-github-release: false).");
      const assets: ReleaseAsset[] = [{ name: RELEASE_ASSET_NAME, content: JSON.stringify(notes, null, 2) + "\n", contentType: "application/json" }];
      for (const f of files.filter((f) => ["security.json", "sbom.cdx.json", "sbom-image.cdx.json"].includes(f.name))) {
        assets.push({ name: f.name, content: f.content, contentType: f.contentType });
      }
      if (history) assets.push({ name: HISTORY_ASSET_NAME, content: JSON.stringify(history) + "\n", contentType: "application/json" });
      const rel = await releases.publish({
        tag: to,
        name: `${to}: ${notes.title}`,
        body: markdown,
        prerelease: releaseType === "prerelease",
        draft: o.releaseDraft ?? false,
        // Backfilled releases are older: they must not take the "Latest" badge.
        makeLatest: releaseType !== "prerelease" && !o.backfillRun,
        bodyMode: releaseBody,
        assets,
        log,
      });
      releaseUrl = rel.html_url;
      log.info(`GitHub Release: ${releaseUrl}`);
    }
    if (store && releaseType !== "prerelease" && !unreleased) {
      // Another run may have written the branch since we read it: then re-read, merge, try again.
      let base = [...known.values()];
      for (let attempt = 1; ; attempt++) {
        const all = mergeNotes([notes, ...backfilledNotes, ...base], prefix).slice(0, 500);
        const branchFiles = [{ path: branchPath("history.json"), content: JSON.stringify({ schemaVersion: SCHEMA_VERSION, releases: all }, null, 2) + "\n" }];
        if (latest) branchFiles.push({ path: branchPath("latest.json"), content: JSON.stringify(latest, null, 2) + "\n" });
        try {
          await store.write(branchFiles, `taglore: ${to}`);
          log.info(`History branch: wrote ${branchFiles.map((f) => f.path).join(", ")} to ${store.branch} (${all.length} releases).`);
          break;
        } catch (e) {
          if (!(e instanceof BranchConflictError) || attempt >= 3) throw e;
          log.warn(`History branch: ${store.branch} changed while this run was working; merging and trying again.`);
          base = (await loadStoredHistory(o, cwd, store, branchPath("history.json"), log)) ?? [];
        }
      }
    }
    if (o.s3Uri) {
      s3Keys = await uploadToS3(o.s3Uri, files, o.s3Region);
      log.info(`Uploaded ${s3Keys.length} files to ${o.s3Uri}`);
    }
  }

  return {
    version,
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
    evidence,
    evidenceMarkdown: renderEvidenceMarkdown(evidence),
    context,
    styleIssues: remainingStyle,
    history,
    backfilled,
  };
}

async function loadBaseline(
  o: TagloreOptions,
  current: ReturnType<typeof parseSemver>,
  tags: string[],
  prefix: string,
  releases: GitHubReleases | null,
  known: Map<string, ReleaseNotes>,
  log: Logger,
): Promise<ReleaseNotes | null> {
  if (o.baselineFile) {
    const { readFile } = await import("node:fs/promises");
    return ReleaseNotesSchema.parse(JSON.parse(await readFile(o.baselineFile, "utf8")));
  }
  // Candidates: earlier X.Y.0 releases, newest first. The first one that was announced wins.
  const candidates = current ? announcementCandidates(current, tags, prefix) : [];
  if (!candidates.length) {
    log.warn("No earlier major/minor release found to reuse as the announcement.");
    return null;
  }
  // The stored history (history-file / history-branch, or this run's backfill) needs no API calls.
  for (const c of candidates) {
    const k = known.get(c.raw);
    if (k?.announce) {
      log.info(`Reusing the ${c.raw} announcement for latest.json`);
      return k;
    }
  }
  if (!releases) {
    log.warn(`Cannot fetch the ${candidates[0]!.raw} announcement without a GitHub token. Use history-file, history-branch or baseline-file to provide it.`);
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
  log.warn(`No earlier release has an announced ${RELEASE_ASSET_NAME} asset to reuse.`);
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

/**
 * Writes notes for earlier tags, oldest first. A tag whose GitHub Release already carries a
 * taglore.json is skipped and its notes are reused. Each tag runs the normal pipeline
 * (compare rules, AI, evidence, GitHub Release) without files, S3, security or history.
 */
async function runBackfill(
  o: TagloreOptions,
  current: SemVer,
  tags: string[],
  prefix: string,
  count: number,
  releases: GitHubReleases | null,
  known: Map<string, ReleaseNotes>,
  log: Logger,
): Promise<{ notes: ReleaseNotes[]; written: string[] }> {
  const earlier = stableTags(tags, prefix)
    .filter((t) => compareSemver(t, current) < 0)
    .slice(-count);
  if (!earlier.length) {
    log.info("Backfill: no earlier tags.");
    return { notes: [], written: [] };
  }
  const publish = (o.publishGithubRelease ?? true) && !o.dryRun;
  if (publish && !releases) {
    log.warn("Backfill without a GitHub token: notes for earlier tags go into history.json only, not into their GitHub Releases.");
  }
  // Tags already in the stored history (history-file / history-branch) need nothing at all.
  const missing = earlier.filter((t) => !known.has(t.raw));
  log.info(
    `Backfill: ${earlier.length} earlier tag(s), ${earlier[0]!.raw} to ${earlier.at(-1)!.raw}; ${missing.length} not in the stored history.`,
  );
  const out: ReleaseNotes[] = earlier.filter((t) => known.has(t.raw)).map((t) => known.get(t.raw)!);
  const written: string[] = [];
  const seen = new Map(known);
  for (const tag of missing) {
    const existing = releases ? await releases.readAsset(tag.raw) : null;
    if (existing) {
      let raw: unknown = null;
      try {
        raw = JSON.parse(existing);
      } catch {
        // A broken asset is treated like a missing one: the tag gets new notes.
      }
      const parsed = ReleaseNotesSchema.safeParse(raw);
      if (parsed.success) {
        log.info(`Backfill: ${tag.raw} already has notes on its release, skipped.`);
        out.push(parsed.data);
        seen.set(parsed.data.version, parsed.data);
        continue;
      }
    }
    log.info(`Backfill: writing notes for ${tag.raw}...`);
    const r = await runTaglore({
      ...o,
      to: tag.raw,
      from: undefined,
      backfill: 0,
      backfillRun: true,
      knownNotes: [...seen.values()],
      outputDir: undefined,
      s3Uri: undefined,
      previewFile: undefined,
      notesFrom: undefined,
      baselineFile: undefined,
      historyFile: undefined,
      historyBranch: undefined,
      historyLimit: 0,
      security: false,
      securityImage: undefined,
      securityFailOn: undefined,
      releaseDraft: false,
      publishGithubRelease: publish && !!releases,
    });
    out.push(r.notes);
    seen.set(r.notes.version, r.notes);
    written.push(tag.raw);
  }
  log.info(`Backfill: wrote notes for ${written.length} tag(s), ${earlier.length - written.length} already had them.`);
  return { notes: out, written };
}

/** The newest stable release tag that is part of `ref` (null when there is none). */
async function latestMergedTag(ref: string, prefix: string, cwd: string): Promise<string | null> {
  const merged = (await git(["tag", "--merged", ref], cwd)).split("\n").map((t) => t.trim()).filter(Boolean);
  return stableTags(merged, prefix).at(-1)?.raw ?? null;
}

/** Newest first by SemVer; later entries never replace an earlier one with the same version. */
export function mergeNotes(list: ReleaseNotes[], prefix: string): ReleaseNotes[] {
  const byVersion = new Map<string, ReleaseNotes>();
  for (const n of list) if (!byVersion.has(n.version)) byVersion.set(n.version, n);
  return [...byVersion.values()].sort((a, b) => {
    const va = parseSemver(a.version, prefix);
    const vb = parseSemver(b.version, prefix);
    if (va && vb) return compareSemver(vb, va);
    return va ? 1 : vb ? -1 : 0;
  });
}

/**
 * The stored history: history-file (CLI, any storage you like) or history-branch.
 * null when neither is configured. A missing file or branch is an empty history (first run).
 */
async function loadStoredHistory(o: TagloreOptions, cwd: string, store: BranchStore | null, branchFile: string, log: Logger): Promise<ReleaseNotes[] | null> {
  if (o.historyFile) {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    let raw: string;
    try {
      raw = await readFile(resolve(cwd, o.historyFile), "utf8");
    } catch {
      log.info(`history-file: ${o.historyFile} doesn't exist yet; starting a new history.`);
      return [];
    }
    const parsed = parseHistoryList(raw);
    if (!parsed) throw new Error(`history-file: ${o.historyFile} is not a Taglore history.json.`);
    return parsed;
  }
  if (store) {
    const raw = await store.read(branchFile);
    if (raw === null) {
      log.info(`History branch: no ${branchFile} in ${store.branch} yet; it is created on publish.`);
      return [];
    }
    const parsed = parseHistoryList(raw);
    if (!parsed) throw new Error(`history-branch: ${branchFile} in ${store.branch} is not a Taglore history.json.`);
    return parsed;
  }
  return null;
}

function parseHistoryList(raw: string): ReleaseNotes[] | null {
  try {
    const parsed = HistorySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.releases : null;
  } catch {
    return null;
  }
}
