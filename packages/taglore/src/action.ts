import * as core from "@actions/core";
import { runTaglore } from "./run.js";
import type { ReleaseType } from "./schema.js";
import type { CompareMode } from "./version.js";
import type { ProviderName } from "./providers/types.js";

function input(name: string): string | undefined {
  const v = core.getInput(name).trim();
  return v === "" ? undefined : v;
}
function bool(name: string, def: boolean): boolean {
  const v = input(name);
  return v === undefined ? def : v.toLowerCase() === "true";
}
function list<T extends string>(name: string): T[] | undefined {
  const v = input(name);
  return v ? (v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) as T[]) : undefined;
}

/** Uses `copilot` from PATH, or installs @github/copilot into RUNNER_TEMP. */
async function ensureCopilot(version: string): Promise<string> {
  const { spawnSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  if (spawnSync("copilot", ["--version"], { stdio: "ignore" }).status === 0) return "copilot";
  const prefix = join(process.env.RUNNER_TEMP ?? tmpdir(), "taglore-copilot");
  core.info(`Installing @github/copilot@${version}...`);
  const r = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--prefix", prefix, `@github/copilot@${version}`], {
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error("Failed to install GitHub Copilot CLI");
  return join(prefix, "node_modules", ".bin", "copilot");
}

/** Uses syft/grype from PATH, or installs them into RUNNER_TEMP with Anchore's official install script. */
async function ensureAnchoreTool(name: "syft" | "grype", version: string): Promise<string> {
  const { spawnSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  if (!/^(latest|v?\d+\.\d+\.\d+)$/.test(version)) throw new Error(`Invalid ${name}-version "${version}"`);
  if (version === "latest" && spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0) return name;
  const dir = join(process.env.RUNNER_TEMP ?? tmpdir(), "taglore-bin");
  const tag = version === "latest" ? "" : version.startsWith("v") ? version : `v${version}`;
  core.info(`Installing ${name} ${version}...`);
  const r = spawnSync(
    "sh",
    ["-c", `curl -sSfL "https://raw.githubusercontent.com/anchore/${name}/main/install.sh" | sh -s -- -b "$1" $2`, "sh", dir, tag],
    { stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error(`Failed to install ${name}`);
  return join(dir, name);
}

async function main() {
  const githubToken = input("github-token") ?? process.env.GITHUB_TOKEN;
  const copilotToken = input("copilot-token");
  if (githubToken) core.setSecret(githubToken);
  if (copilotToken) core.setSecret(copilotToken);

  const from = input("from");
  const provider = (input("ai-provider") ?? "copilot") as ProviderName;
  const copilotCommand = provider === "copilot" ? await ensureCopilot(input("copilot-version") ?? "latest") : undefined;

  const securityImage = input("security-image");
  const security = bool("security-scan", false) || Boolean(securityImage);
  const syftCommand = security ? await ensureAnchoreTool("syft", input("syft-version") ?? "latest") : undefined;
  const grypeCommand = security ? await ensureAnchoreTool("grype", input("grype-version") ?? "latest") : undefined;

  const result = await runTaglore({
    copilotCommand,
    security,
    securityFailOn: input("security-fail-on") as "none" | "critical" | "high" | "medium" | "low" | undefined,
    securityMaxItems: input("security-max-items") ? Number(input("security-max-items")) : undefined,
    securityExcludes: list<string>("security-exclude"),
    syftCommand,
    grypeCommand,
    securityImage,
    notesFrom: input("notes-from"),
    evidence: input("evidence") as "warn" | "strict" | undefined,
    previewFile: input("preview-file"),
    historyLimit: input("history-limit") ? Number(input("history-limit")) : undefined,
    historyFile: input("history-file"),
    cwd: input("working-directory") ?? process.cwd(),
    to: input("to"),
    from,
    compare: (input("compare") as CompareMode | undefined) ?? (from ? "explicit" : "auto"),
    tagPrefix: input("tag-prefix"),
    provider,
    model: input("model"),
    // Copilot: a PAT wins; otherwise the workflow token (works when an org bills Copilot CLI).
    copilotToken: copilotToken ?? githubToken,
    copilotArgs: list<string>("copilot-args"),
    aiFor: list<ReleaseType>("ai-for"),
    onAiFailure: input("on-ai-failure") as "fallback" | "fail" | undefined,
    announceOn: list<ReleaseType>("announce-on"),
    excludes: list<string>("exclude"),
    maxDiffKb: input("max-diff-kb") ? Number(input("max-diff-kb")) : undefined,
    language: input("language"),
    tone: input("tone"),
    audience: input("audience"),
    productName: input("product-name"),
    instructions: input("instructions"),
    githubToken,
    publishGithubRelease: bool("publish-github-release", true),
    releaseDraft: bool("release-draft", false),
    includeCommits: bool("include-commits", true),
    baselineFile: input("baseline-file"),
    outputDir: input("output-dir"),
    s3Uri: input("s3-uri"),
    s3Region: input("s3-region"),
    dryRun: bool("dry-run", false),
    log: { info: (m) => core.info(m), warn: (m) => core.warning(m) },
  });

  // Artifact upload (optional): same files, for a later job such as a Docker build.
  const artifactName = input("upload-artifact");
  if (artifactName && artifactName !== "false" && !bool("dry-run", false)) {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { DefaultArtifactClient } = await import("@actions/artifact");
    const dir = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "taglore-"));
    const paths: string[] = [];
    for (const f of result.files) {
      const p = join(dir, f.name);
      await writeFile(p, f.content, "utf8");
      paths.push(p);
    }
    const name = artifactName === "true" ? "taglore-release-notes" : artifactName;
    await new DefaultArtifactClient().uploadArtifact(name, paths, dir, { retentionDays: 30 });
    core.info(`Uploaded artifact "${name}"`);
    core.setOutput("artifact-name", name);
  }

  core.setOutput("version", result.version);
  core.setOutput("previous-version", result.previousVersion ?? "");
  core.setOutput("release-type", result.releaseType);
  core.setOutput("announce", String(result.announce));
  core.setOutput("provider", result.provider);
  core.setOutput("release-url", result.releaseUrl ?? "");
  core.setOutput("markdown", result.markdown);
  core.setOutput("json", JSON.stringify(result.notes));
  const byName = (n: string) => result.writtenFiles.find((p) => p.endsWith(`/${n}`)) ?? "";
  core.setOutput("latest-json-path", byName("latest.json"));
  core.setOutput("release-json-path", byName("release.json"));
  core.setOutput("markdown-path", byName("RELEASE_NOTES.md"));
  core.setOutput("history-json-path", byName("history.json"));
  core.setOutput("unverified-statements", String(result.evidence.unverified.length));
  core.setOutput("security-json-path", byName("security.json"));
  core.setOutput("sbom-path", byName("sbom.cdx.json"));
  core.setOutput("image-sbom-path", byName("sbom-image.cdx.json"));
  if (result.security) {
    const sum = (c: Record<string, number>) => String(Object.values(c).reduce((a, b) => a + b, 0));
    const s = result.security.summary;
    core.setOutput("security-open", sum(s.open));
    core.setOutput("security-introduced", sum(s.introduced));
    core.setOutput("security-fixed", sum(s.fixed));
    core.setOutput("security-open-critical", String(s.open.critical));
    core.setOutput("security-open-high", String(s.open.high));
  }

  await core.summary
    .addHeading(`Taglore: ${result.version}`, 2)
    .addRaw(`From <code>${result.previousVersion ?? "first commit"}</code>, ${result.releaseType} release, announce: <b>${result.announce}</b>, notes by <b>${result.provider}</b>.`, true)
    .addBreak()
    .addRaw(result.markdown, true)
    .addRaw(`\n\n${result.evidenceMarkdown}`, true)
    .write();
}

main().catch((e) => core.setFailed(e instanceof Error ? e.message : String(e)));
