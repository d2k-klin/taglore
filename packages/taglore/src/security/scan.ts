import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { git } from "../git.js";
import { diffScans, type ScanResult } from "./diff.js";
import { parseCycloneDx, parseGrype } from "./parse.js";
import type { SecurityReport } from "./types.js";

const exec = promisify(execFile);
const MAX_BUFFER = 512 * 1024 * 1024;

export interface SecurityScanOptions {
  cwd: string;
  from: string | null;
  to: string;
  /** Path or command for syft / grype. Default: on PATH. */
  syft?: string;
  grype?: string;
  /** Extra syft --exclude patterns, e.g. "./test/**". */
  excludes?: string[];
  log: { info(m: string): void; warn(m: string): void };
}

export interface SecurityScanResult {
  report: SecurityReport;
  /** CycloneDX SBOM of the released version, as produced by Syft. */
  sbom: string;
}

async function toolVersion(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await exec(cmd, ["version", "-o", "json"], { maxBuffer: 1024 * 1024 });
    return (JSON.parse(stdout) as { version?: string }).version ?? null;
  } catch {
    try {
      const { stdout } = await exec(cmd, ["--version"]);
      return stdout.trim().split(/\s+/).pop() ?? null;
    } catch {
      return null;
    }
  }
}

async function scanTree(dir: string, label: string, o: SecurityScanOptions, syft: string, grype: string, env: NodeJS.ProcessEnv) {
  const sbomFile = join(dir, "..", `${label}.cdx.json`);
  const excludes = ["./.git/**", ...(o.excludes ?? [])].flatMap((e) => ["--exclude", e]);
  await exec(syft, [`dir:${dir}`, "-q", "-o", `cyclonedx-json=${sbomFile}`, ...excludes], { env, maxBuffer: MAX_BUFFER });
  const sbom = await readFile(sbomFile, "utf8");
  // cwd = repository root so a .grype.yaml there (ignore rules, VEX) applies to both versions.
  const { stdout } = await exec(grype, [`sbom:${sbomFile}`, "-q", "-o", "json"], { cwd: o.cwd, env, maxBuffer: MAX_BUFFER });
  const scan: ScanResult = { components: parseCycloneDx(JSON.parse(sbom)), vulns: parseGrype(JSON.parse(stdout)) };
  return { scan, sbom };
}

/**
 * Builds an SBOM and a vulnerability scan for both versions and compares them.
 * Each version is checked out into its own git worktree, so the scan reflects the
 * committed manifests and lockfiles at that tag, not whatever is in the workspace.
 */
export async function runSecurityScan(o: SecurityScanOptions): Promise<SecurityScanResult> {
  const syft = o.syft ?? "syft";
  const grype = o.grype ?? "grype";
  const [syftVersion, grypeVersion] = await Promise.all([toolVersion(syft), toolVersion(grype)]);
  if (!syftVersion) throw new Error(`Syft not found (${syft}). Install it: https://github.com/anchore/syft#installation`);
  if (!grypeVersion) throw new Error(`Grype not found (${grype}). Install it: https://github.com/anchore/grype#installation`);

  // Download the vulnerability database once, then freeze it so both versions are judged by the same data.
  o.log.info(`Updating the Grype vulnerability database (grype ${grypeVersion})...`);
  // Same cwd as the scans, so a repository .grype.yaml (e.g. db.cache-dir) applies to the update too.
  await exec(grype, ["db", "update"], { cwd: o.cwd, maxBuffer: MAX_BUFFER });
  const env = { ...process.env, GRYPE_DB_AUTO_UPDATE: "false", SYFT_CHECK_FOR_APP_UPDATE: "false", GRYPE_CHECK_FOR_APP_UPDATE: "false" };

  const root = await mkdtemp(join(tmpdir(), "taglore-security-"));
  const trees: string[] = [];
  const checkout = async (ref: string, name: string) => {
    const dir = join(root, name);
    await git(["worktree", "add", "--detach", "--force", dir, ref], o.cwd);
    trees.push(dir);
    return dir;
  };

  try {
    o.log.info(`Scanning ${o.to} with Syft ${syftVersion}...`);
    const head = await scanTree(await checkout(o.to, "head"), "head", o, syft, grype, env);
    let base: ScanResult | null = null;
    if (o.from) {
      o.log.info(`Scanning ${o.from} for comparison...`);
      base = (await scanTree(await checkout(o.from, "base"), "base", o, syft, grype, env)).scan;
    }
    const report = diffScans(base, head.scan, {
      version: o.to,
      previousVersion: o.from,
      scannedAt: new Date().toISOString(),
      tools: { syft: syftVersion, grype: grypeVersion },
    });
    return { report, sbom: head.sbom };
  } finally {
    for (const dir of trees) {
      await git(["worktree", "remove", "--force", dir], o.cwd).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
    await git(["worktree", "prune"], o.cwd).catch(() => undefined);
  }
}
