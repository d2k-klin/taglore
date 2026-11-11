#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runTaglore } from "./run.js";
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
  --tag-prefix <p>        Tag prefix (default: v)

AI
  --provider <name>       copilot | github-models | none (default: copilot)
  --model <id>            Model id passed to the provider
  --ai-for <types>        Release types that get AI notes (default: major,minor)
  --on-ai-failure <m>     fallback | fail (default: fallback)
  --language <lang>       Default: English
  --tone <text>           Default: "friendly and concise"
  --audience <text>       Default: "end users of the application"
  --instructions <text>   Extra guidance for the AI
  --exclude <glob>        Extra path to keep out of the AI context (repeatable)
  --max-diff-kb <n>       Diff size sent to the AI (default: 100, github-models: 20)

Security (needs syft and grype on PATH)
  --security              Add a Security section, security.json and sbom.cdx.json
  --security-fail-on <s>  none | critical | high | medium | low (default: none)
  --security-exclude <g>  Extra Syft exclude pattern (repeatable)
  --security-image <ref>  Also scan an image, e.g. ghcr.io/acme/app:{version} (implies --security)
  --notes-from <file>     Reuse an earlier release.json instead of generating notes

Output
  --out <dir>             Write latest.json, release.json, RELEASE_NOTES.md here
  --github / --no-github  Create or update the GitHub Release (default: --no-github in the CLI)
  --repo <owner/name>     Repository for GitHub publishing (default: GITHUB_REPOSITORY)
  --draft                 Create the GitHub Release as draft
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
    log: quiet ? { info: () => {}, warn: (m) => console.error(`warning: ${m}`) } : undefined,
  });

  if (values.json) console.log(JSON.stringify({ ...result, files: result.files.map((f) => f.name) }, null, 2));
  else if (values["dry-run"] || !values.out) console.log(`\n${result.markdown}`);
}

main().catch((e) => {
  console.error(`taglore: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
