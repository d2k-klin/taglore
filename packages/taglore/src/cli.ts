#!/usr/bin/env node
import { parseArgs } from "node:util";
import { type PatchNotesMode, runTaglore } from "./run.js";
import { TAGLORE_VERSION } from "./meta.js";
import type { ReleaseType } from "./schema.js";
import type { CompareMode } from "./version.js";
import type { ProviderName } from "./providers/types.js";

const HELP = `taglore ${TAGLORE_VERSION}: AI-written release notes from git tags

Usage
  taglore generate [options]

Versions
  --to <ref>              Release tag (default: tag on HEAD, or GITHUB_REF)
  --from <ref>            Base ref (implies --compare explicit)
  --compare <mode>        auto | previous-tag | previous-minor | previous-major | explicit (default: auto)
  --tag-prefix <p>        Tag prefix (default: v), e.g. web-v for tags like web-v1.2.0
  --path <p>              Monorepos: limit the release to this folder or file (repeatable)
  --unreleased            Notes for the changes since the last release tag (to defaults to HEAD)
  --unreleased-label <l>  Version label for --unreleased (default: Unreleased)

AI
  --provider <name>       copilot | github-models | none (default: copilot)
  --model <id>            Model id passed to the provider
  --ai-for <types>        Release types that get AI notes (default: major,minor)
  --patch-notes <m>       commits | ai | announce: how patch releases are written (default: ai)
  --backfill <n>          Onboarding: also write notes for up to n earlier tags (max 50)
  --on-ai-failure <m>     fallback | fail (default: fallback)
  --language <lang>       Default: English
  --tone <text>           Default: "friendly and concise"
  --audience <text>       Default: "end users of the application"
  --instructions <text>   Extra guidance for the AI; {version}, {from}, {to}, {releaseType} are filled in
  --facts-file <path>     Per-release facts for the AI, e.g. docs/releases/{version}.md (missing = none)
  --facts-from <command>  Command that prints per-release facts; gets TAGLORE_VERSION, TAGLORE_FROM, TAGLORE_TO
  --forbid <term>         Word or /regex/ that must not appear in the notes (repeatable)
  --style-check <mode>    warn | strict: what happens when a style rule is still broken (default: warn)
  --focus <glob>          Diffs that go first when a big release doesn't fit (repeatable)
  --exclude <glob>        Extra path to keep out of the AI context (repeatable)
  --max-diff-kb <n>       Change context sent to the AI in KB (default: 300, github-models: 20, max 4096)

Security (needs syft and grype on PATH)
  --security              Add a Security section, security.json and sbom.cdx.json
  --security-fail-on <s>  none | critical | high | medium | low (default: none)
  --security-exclude <g>  Extra Syft exclude pattern (repeatable)
  --security-image <ref>  Also scan an image, e.g. ghcr.io/acme/app:{version} (implies --security)
  --notes-from <file>     Reuse an earlier release.json instead of generating notes

Review and history
  --evidence <mode>       warn | strict: keep or remove statements no commit supports (default: warn)
  --preview <file>        Write a review page: what users will see and the commits behind it
  --history-limit <n>     Releases kept in history.json (default: 20, 0 = off)
  --history-file <file>   Continue from a local history.json instead of GitHub Releases
                          (backfill skips the tags in it; patches find their announcement in it)
  --history-branch <b>    Keep history.json and latest.json in this branch (needs a token)

Output
  --out <dir>             Write latest.json, release.json, RELEASE_NOTES.md here
  --github / --no-github  Create or update the GitHub Release (default: --no-github in the CLI)
  --repo <owner/name>     Repository for GitHub publishing (default: GITHUB_REPOSITORY)
  --draft                 Create the GitHub Release as draft
  --release-body <m>      replace | prepend | append, for a release that already has a body
  --s3 <uri>              Upload the files to s3://bucket/prefix/
  --s3-region <region>
  --announce-on <types>   Release types that update latest.json (default: major,minor)
  --baseline <file>       taglore.json to reuse as latest.json for non-announced releases
  --dry-run               Print the notes, publish nothing
  --json                  Print the result as JSON instead of Markdown

Tokens are read from GITHUB_TOKEN and COPILOT_GITHUB_TOKEN.
`;

function list<T extends string>(v: string | undefined): T[] | undefined {
  return v ? (v.split(",").map((s) => s.trim()).filter(Boolean) as T[]) : undefined;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      to: { type: "string" },
      from: { type: "string" },
      compare: { type: "string" },
      "tag-prefix": { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      "ai-for": { type: "string" },
      "patch-notes": { type: "string" },
      backfill: { type: "string" },
      "on-ai-failure": { type: "string" },
      language: { type: "string" },
      tone: { type: "string" },
      audience: { type: "string" },
      instructions: { type: "string" },
      exclude: { type: "string", multiple: true },
      "max-diff-kb": { type: "string" },
      out: { type: "string" },
      github: { type: "boolean" },
      "no-github": { type: "boolean" },
      repo: { type: "string" },
      draft: { type: "boolean" },
      s3: { type: "string" },
      "s3-region": { type: "string" },
      "announce-on": { type: "string" },
      baseline: { type: "string" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      security: { type: "boolean" },
      "security-fail-on": { type: "string" },
      "security-exclude": { type: "string", multiple: true },
      "security-image": { type: "string" },
      "notes-from": { type: "string" },
      path: { type: "string", multiple: true },
      "release-body": { type: "string" },
      evidence: { type: "string" },
      preview: { type: "string" },
      "history-limit": { type: "string" },
      "history-file": { type: "string" },
      "history-branch": { type: "string" },
      unreleased: { type: "boolean" },
      "unreleased-label": { type: "string" },
      "facts-file": { type: "string" },
      "facts-from": { type: "string" },
      forbid: { type: "string", multiple: true },
      "style-check": { type: "string" },
      focus: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.version) return console.log(TAGLORE_VERSION);
  if (values.help || positionals[0] !== "generate") return console.log(HELP);

  const quiet = Boolean(values.json);
  const result = await runTaglore({
    to: values.to,
    from: values.from,
    compare: (values.compare as CompareMode | undefined) ?? (values.from ? "explicit" : "auto"),
    tagPrefix: values["tag-prefix"],
    provider: values.provider as ProviderName | undefined,
    model: values.model,
    aiFor: list<ReleaseType>(values["ai-for"]),
    patchNotes: values["patch-notes"] as PatchNotesMode | undefined,
    backfill: values.backfill !== undefined ? Number(values.backfill) : undefined,
    onAiFailure: values["on-ai-failure"] as "fallback" | "fail" | undefined,
    language: values.language,
    tone: values.tone,
    audience: values.audience,
    instructions: values.instructions,
    excludes: values.exclude,
    maxDiffKb: values["max-diff-kb"] ? Number(values["max-diff-kb"]) : undefined,
    outputDir: values.out,
    publishGithubRelease: Boolean(values.github) && !values["no-github"],
    repository: values.repo,
    releaseDraft: values.draft,
    s3Uri: values.s3,
    s3Region: values["s3-region"],
    announceOn: list<ReleaseType>(values["announce-on"]),
    baselineFile: values.baseline,
    dryRun: values["dry-run"],
    security: values.security,
    securityFailOn: values["security-fail-on"] as "none" | "critical" | "high" | "medium" | "low" | undefined,
    securityExcludes: values["security-exclude"],
    securityImage: values["security-image"],
    notesFrom: values["notes-from"],
    paths: values.path,
    releaseBody: values["release-body"] as "replace" | "prepend" | "append" | undefined,
    evidence: values.evidence as "warn" | "strict" | undefined,
    previewFile: values.preview,
    historyLimit: values["history-limit"] ? Number(values["history-limit"]) : undefined,
    historyFile: values["history-file"],
    historyBranch: values["history-branch"],
    unreleased: values.unreleased,
    unreleasedLabel: values["unreleased-label"],
    factsFile: values["facts-file"],
    factsCommand: values["facts-from"],
    forbiddenTerms: values.forbid,
    styleCheck: values["style-check"] as "warn" | "strict" | undefined,
    focusPaths: values.focus,
    log: quiet ? { info: () => {}, warn: (m) => console.error(`warning: ${m}`) } : undefined,
  });

  if (values.json) console.log(JSON.stringify({ ...result, files: result.files.map((f) => f.name) }, null, 2));
  else if (values["dry-run"] || !values.out) console.log(`\n${result.markdown}`);
}

main().catch((e) => {
  console.error(`taglore: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
