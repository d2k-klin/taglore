import { collectChanges, DEFAULT_EXCLUDES, normalizePaths, type ChangeSet } from "./collect.js";
import { type EvidenceMode, type EvidenceReport, renderEvidenceMarkdown, skippedEvidence, verifyEvidence } from "./evidence.js";
import { fallbackNotes } from "./fallback.js";
import { buildHistory, HISTORY_ASSET_NAME } from "./history.js";
import { renderPreview } from "./preview.js";
import { git, isShallow, listTags, refDate, resolveRef } from "./git.js";
import { renderMarkdown } from "./markdown.js";
import { TAGLORE_VERSION } from "./meta.js";
import { buildPrompt, extractJson } from "./prompt.js";
import { copilotProvider } from "./providers/copilot.js";
import { githubModelsProvider } from "./providers/github-models.js";
import type { AiProvider, ProviderName } from "./providers/types.js";
import { type OutFile, writeOutputDir } from "./publish/files.js";
import { GitHubReleases, parseRepo, RELEASE_ASSET_NAME, type ReleaseBodyMode } from "./publish/github-release.js";
import { uploadToS3 } from "./publish/s3.js";
import { sanitizeNotes } from "./sanitize.js";
import { assertFailOn, describeCounts, gateViolations } from "./security/diff.js";
import { renderSecuritySection } from "./security/markdown.js";
import { runSecurityScan } from "./security/scan.js";
import type { FailOn, SecurityReport } from "./security/types.js";
import { AiNotesSchema, type AiNotes, type History, type ReleaseNotes, ReleaseNotesSchema, type ReleaseType, SCHEMA_VERSION } from "./schema.js";
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
  /** @internal Set for the per-tag runs of a backfill. */
  backfillRun?: boolean;
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

async function aiNotes(provider: AiProvider, changes: ChangeSet, o: TagloreOptions, version: string, prev: string | null, log: Logger, maxContextKb: number) {
  const prompt = buildPrompt(changes, {
    productName: o.productName ?? (o.repository?.split("/")[1] ?? "this application"),
    version,
    previousVersion: prev,
    language: o.language ?? "English",
    tone: o.tone ?? "friendly and concise",
    audience: o.audience ?? "end users of the application",
    instructions: o.instructions,
    paths: normalizePaths(o.paths),
    maxContextBytes: maxContextKb * 1024,
  });
  log.info(`Asking ${provider.name} (${Math.round(Buffer.byteLength(prompt) / 1024)} KB prompt)...`);
  const res = await provider.generate(prompt);
  const parsed = AiNotesSchema.parse(extractJson(res.text));
  return { notes: parsed, model: res.model };
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

  // 1b. Onboarding: earlier tags first, oldest first, so patches find their minor's notes.
  const backfilledNotes: ReleaseNotes[] = [];
  const backfilled: string[] = [];
  if (backfill > 0) {
    if (compare === "explicit" || !current) throw new Error("backfill needs SemVer tags; it cannot be combined with compare: explicit.");
    const b = await runBackfill(o, current, tags, prefix, backfill, repository, log);
    backfilledNotes.push(...b.notes);
    backfilled.push(...b.written);
  }

  // 2. Changes
  const provider = makeProvider(o);
  const maxDiffKb = o.maxDiffKb ?? (o.provider === "github-models" ? 20 : 100);
  const changes = await collectChanges({
    from,
    to,
    cwd,
    excludes: [...DEFAULT_EXCLUDES, ...(o.excludes ?? [])],
    paths,
    maxDiffBytes: maxDiffKb * 1024,
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
      const r = await aiNotes(provider, changes, o, to, from, log, maxDiffKb);
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
      ? new GitHubReleases((o.githubToken ?? process.env.GITHUB_TOKEN)!, parseRepo(repository), o.githubApiUrl, o.octokitOptions)
      : null;

  let latest: ReleaseNotes | null = announce ? notes : null;
  if (!announce) {
    latest = await loadBaseline(o, current, tags, prefix, releases, log);
    // Nothing earlier to show (Taglore was adopted on a patch, or no token to fetch it):
    // ship this release's notes, so the app's "What's new" menu still has content.
    // announce stays false, so nobody gets a popup for it.
    if (!latest && releaseType === "patch") {
      log.info("latest.json holds this release's own notes (announce: false, no popup).");
      latest = notes;
    }
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

  // 5b. History for a changelog page
  const historyLimit = o.historyLimit ?? 20;
  let history: History | null = null;
  if (historyLimit > 0 && releaseType !== "prerelease") {
    history = await buildHistory({ notes, current, tags, prefix, limit: historyLimit, historyFile: o.historyFile, cwd, releases, log, extra: backfilledNotes });
    files.push({ name: "history.json", content: JSON.stringify(history, null, 2) + "\n", contentType: "application/json", cacheControl: "public, max-age=60" });
  }

  // 5c. Review page (not part of the published files: it lists commit subjects)
  if (o.previewFile) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname, resolve } = await import("node:path");
    const target = resolve(cwd, o.previewFile);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, renderPreview(notes, evidence, { repositoryUrl: repository ? `${serverUrl}/${repository}` : null }), "utf8");
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
    if (o.publishGithubRelease ?? true) {
      if (!releases) throw new Error("Publishing a GitHub Release needs a token and repository (or set publish-github-release: false).");
      const rel = await releases.upsert({
        tag: to,
        name: `${to}: ${notes.title}`,
        body: markdown,
        prerelease: releaseType === "prerelease",
        draft: o.releaseDraft ?? false,
        // Backfilled releases are older: they must not take the "Latest" badge.
        makeLatest: releaseType !== "prerelease" && !o.backfillRun,
        bodyMode: releaseBody,
      });
      await releases.uploadAsset(rel, RELEASE_ASSET_NAME, JSON.stringify(notes, null, 2) + "\n");
      for (const f of files.filter((f) => ["security.json", "sbom.cdx.json", "sbom-image.cdx.json"].includes(f.name))) {
        await releases.uploadAsset(rel, f.name, f.content, f.contentType);
      }
      if (history) await releases.uploadAsset(rel, HISTORY_ASSET_NAME, JSON.stringify(history) + "\n");
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
    evidence,
    evidenceMarkdown: renderEvidenceMarkdown(evidence),
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
  if (!releases) {
    log.warn(`Cannot fetch the ${candidates[0]!.raw} announcement without a GitHub token. Use baseline-file to provide it.`);
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
  repository: string | undefined,
  log: Logger,
): Promise<{ notes: ReleaseNotes[]; written: string[] }> {
  const earlier = stableTags(tags, prefix)
    .filter((t) => compareSemver(t, current) < 0)
    .slice(-count);
  if (!earlier.length) {
    log.info("Backfill: no earlier tags.");
    return { notes: [], written: [] };
  }
  const token = o.githubToken ?? process.env.GITHUB_TOKEN;
  const releases = repository && token ? new GitHubReleases(token, parseRepo(repository), o.githubApiUrl, o.octokitOptions) : null;
  const publish = (o.publishGithubRelease ?? true) && !o.dryRun;
  if (publish && !releases) {
    log.warn("Backfill without a GitHub token: notes for earlier tags go into history.json only, not into their GitHub Releases.");
  }
  log.info(`Backfill: ${earlier.length} earlier tag(s), ${earlier[0]!.raw} to ${earlier.at(-1)!.raw}.`);
  const out: ReleaseNotes[] = [];
  const written: string[] = [];
  for (const tag of earlier) {
    const existing = releases ? await releases.readAsset(tag.raw) : null;
    if (existing) {
      const parsed = ReleaseNotesSchema.safeParse(JSON.parse(existing));
      if (parsed.success) {
        log.info(`Backfill: ${tag.raw} already has notes, skipped.`);
        out.push(parsed.data);
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
      outputDir: undefined,
      s3Uri: undefined,
      previewFile: undefined,
      notesFrom: undefined,
      baselineFile: undefined,
      historyFile: undefined,
      historyLimit: 0,
      security: false,
      securityImage: undefined,
      securityFailOn: undefined,
      releaseDraft: false,
      publishGithubRelease: publish && !!releases,
    });
    out.push(r.notes);
    written.push(tag.raw);
  }
  log.info(`Backfill: wrote notes for ${written.length} tag(s), ${earlier.length - written.length} already had them.`);
  return { notes: out, written };
}
