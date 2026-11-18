import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { normalizePaths } from "../collect.js";
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
  /** Extra syft --exclude patterns for the repository scan, e.g. "./test/**". */
  excludes?: string[];
  /**
   * Container image to scan as well, as a template: "ghcr.io/acme/app:{version}" or
   * "acme/app:{semver}". {version} is the tag (v1.9.0), {semver} the tag without the "v".
   * The previous version's image is resolved from the same template.
   */
  image?: string;
  /** Monorepos: scan only these folders/files of the repository (the image scan is unaffected). */
  paths?: string[];
  log: { info(m: string): void; warn(m: string): void };
}

export interface SecurityScanResult {
  report: SecurityReport;
  /** CycloneDX SBOM of the repository at the released tag (lockfiles and manifests). */
  sbom: string;
  /** CycloneDX SBOM of the released container image, when an image was scanned. */
  imageSbom: string | null;
}

/** Expands {version} / {semver} in an image template. */
export function expandImage(template: string, version: string): string {
  if (!/\{(version|semver)\}/.test(template)) {
    throw new Error(`security-image "${template}" must contain {version} or {semver}, so the previous release's image can be found.`);
  }
  return template.replaceAll("{version}", version).replaceAll("{semver}", version.replace(/^[^\d]*/, ""));
}

interface CdxDoc {
  metadata?: { component?: CdxRef } & Record<string, unknown>;
  components?: CdxRef[];
  dependencies?: { ref: string; dependsOn?: string[] }[];
}
interface CdxRef {
  "bom-ref"?: string;
  purl?: string;
  name?: string;
  version?: string;
}

/**
 * One CycloneDX document from several scans of the same version (one per path).
 * Components and dependency relationships are de-duplicated; each path's root component is
 * kept as a component so its dependencies stay attached.
 */
export function mergeCycloneDx(docs: string[]): string {
  if (docs.length === 1) return docs[0]!;
  const parsed = docs.map((d) => JSON.parse(d) as CdxDoc);
  const key = (c: CdxRef) => c["bom-ref"] ?? c.purl ?? `${c.name}@${c.version}`;
  const seen = new Set<string>();
  const components: CdxRef[] = [];
  const add = (c: CdxRef | undefined) => {
    if (!c || seen.has(key(c))) return;
    seen.add(key(c));
    components.push(c);
  };
  // Path roots after the first become components, so their dependency entries resolve.
  parsed.slice(1).forEach((d) => add(d.metadata?.component));
  parsed.forEach((d) => (d.components ?? []).forEach(add));
  const deps = new Map<string, Set<string>>();
  for (const d of parsed) {
    for (const dep of d.dependencies ?? []) {
      const set = deps.get(dep.ref) ?? new Set<string>();
      (dep.dependsOn ?? []).forEach((x) => set.add(x));
      deps.set(dep.ref, set);
    }
  }
  const dependencies = [...deps].map(([ref, set]) => ({ ref, dependsOn: [...set] }));
  return JSON.stringify({ ...parsed[0], components, ...(dependencies.length ? { dependencies } : {}) }, null, 2);
}

/** Union of two scans of the same version (repository + image). */
export function mergeScans(a: ScanResult, b: ScanResult): ScanResult {
  const components = new Map(a.components);
  for (const [k, list] of b.components) {
    const merged = [...(components.get(k) ?? [])];
    for (const c of list) if (!merged.some((m) => m.version === c.version)) merged.push(c);
    components.set(k, merged);
  }
  const vulns = new Map(a.vulns);
  for (const [k, v] of b.vulns) if (!vulns.has(k)) vulns.set(k, v);
  return { components, vulns };
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

interface Ctx {
  o: SecurityScanOptions;
  syft: string;
  grype: string;
  env: NodeJS.ProcessEnv;
  root: string;
}

/** Syft SBOM + Grype scan of one source ("dir:/path" or an image reference). */
async function scanSource(ctx: Ctx, source: string, label: string, extraArgs: string[] = []) {
  const sbomFile = join(ctx.root, `${label}.cdx.json`);
  await exec(ctx.syft, [source, "-q", "-o", `cyclonedx-json=${sbomFile}`, ...extraArgs], { env: ctx.env, maxBuffer: MAX_BUFFER });
  const sbom = await readFile(sbomFile, "utf8");
  // cwd = repository root so a .grype.yaml there (ignore rules, VEX) applies to every scan.
  const { stdout } = await exec(ctx.grype, [`sbom:${sbomFile}`, "-q", "-o", "json"], { cwd: ctx.o.cwd, env: ctx.env, maxBuffer: MAX_BUFFER });
  const scan: ScanResult = { components: parseCycloneDx(JSON.parse(sbom)), vulns: parseGrype(JSON.parse(stdout)) };
  return { scan, sbom };
}

/**
 * Builds SBOMs and vulnerability scans for both versions and compares them.
 * - Repository: each version is checked out into its own git worktree, so the scan reflects
 *   the committed manifests and lockfiles at that tag.
 * - Image (optional): the released image and the previous release's image, which adds
 *   OS packages and anything installed during the build.
 * One vulnerability database is downloaded and frozen for all scans.
 */
export async function runSecurityScan(o: SecurityScanOptions): Promise<SecurityScanResult> {
  const syft = o.syft ?? "syft";
  const grype = o.grype ?? "grype";
  // Validated here too: runSecurityScan is public API and must not scan outside the repository.
  const paths = normalizePaths(o.paths);
  const headImage = o.image ? expandImage(o.image, o.to) : null;
  const baseImage = o.image && o.from ? expandImage(o.image, o.from) : null;

  const [syftVersion, grypeVersion] = await Promise.all([toolVersion(syft), toolVersion(grype)]);
  if (!syftVersion) throw new Error(`Syft not found (${syft}). Install it: https://github.com/anchore/syft#installation`);
  if (!grypeVersion) throw new Error(`Grype not found (${grype}). Install it: https://github.com/anchore/grype#installation`);

  o.log.info(`Updating the Grype vulnerability database (grype ${grypeVersion})...`);
  // Same cwd as the scans, so a repository .grype.yaml (e.g. db.cache-dir) applies to the update too.
  await exec(grype, ["db", "update"], { cwd: o.cwd, maxBuffer: MAX_BUFFER });
  const env = { ...process.env, GRYPE_DB_AUTO_UPDATE: "false", SYFT_CHECK_FOR_APP_UPDATE: "false", GRYPE_CHECK_FOR_APP_UPDATE: "false" };

  const root = await mkdtemp(join(tmpdir(), "taglore-security-"));
  const ctx: Ctx = { o, syft, grype, env, root };
  const trees: string[] = [];
  const warnings: string[] = [];
  const checkout = async (ref: string, name: string) => {
    const dir = join(root, name);
    await git(["worktree", "add", "--detach", "--force", dir, ref], o.cwd);
    trees.push(dir);
    return dir;
  };
  const excludes = ["./.git/**", ...(o.excludes ?? [])].flatMap((e) => ["--exclude", e]);

  const { lstat, realpath } = await import("node:fs/promises");
  const { sep } = await import("node:path");
  /** Repository scan of one version: the whole tree, or only the given paths. */
  const scanRepo = async (dir: string, label: string) => {
    if (!paths.length) return scanSource(ctx, `dir:${dir}`, label, excludes);
    const root = await realpath(dir);
    const parts: { scan: ScanResult; sbom: string }[] = [];
    for (const [i, p] of paths.entries()) {
      const full = join(dir, p);
      const st = await lstat(full).catch(() => null);
      if (!st) continue; // e.g. an app that did not exist yet in the previous version
      // A symlink, or a path that resolves outside the checkout through a symlinked parent,
      // would let the scan read files outside the selected paths.
      const real = await realpath(full);
      if (st.isSymbolicLink() || (real !== root && !real.startsWith(root + sep)) || real !== join(root, p)) {
        throw new Error(`Path "${p}" is or passes through a symbolic link. List the real folder or file instead.`);
      }
      parts.push(await scanSource(ctx, `${st.isDirectory() ? "dir" : "file"}:${full}`, `${label}-${i}`, st.isDirectory() ? excludes : []));
    }
    if (!parts.length) return { scan: { components: new Map(), vulns: new Map() } as ScanResult, sbom: JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.6", components: [] }) };
    return { scan: parts.slice(1).reduce((a, b) => mergeScans(a, b.scan), parts[0]!.scan), sbom: mergeCycloneDx(parts.map((x) => x.sbom)) };
  };

  try {
    o.log.info(`Scanning the repository at ${o.to}${paths.length ? ` (${paths.join(", ")})` : ""} with Syft ${syftVersion}...`);
    const headRepo = await scanRepo(await checkout(o.to, "head"), "head-repo");
    let head = headRepo.scan;
    let imageSbom: string | null = null;
    let headImageScan: ScanResult | null = null;
    if (headImage) {
      o.log.info(`Scanning image ${headImage}...`);
      const r = await scanSource(ctx, headImage, "head-image").catch((e: unknown) => {
        throw new Error(`Could not scan image ${headImage}. Build or push it before this step. ${e instanceof Error ? e.message : e}`);
      });
      headImageScan = r.scan;
      imageSbom = r.sbom;
      head = mergeScans(head, r.scan);
    }

    let base: ScanResult | null = null;
    if (o.from) {
      o.log.info(`Scanning the repository at ${o.from} for comparison...`);
      base = (await scanRepo(await checkout(o.from, "base"), "base-repo")).scan;
      if (baseImage && headImageScan) {
        try {
          o.log.info(`Scanning image ${baseImage} for comparison...`);
          base = mergeScans(base, (await scanSource(ctx, baseImage, "base-image")).scan);
        } catch {
          // Without the old image we can't tell what the image changed. Count its findings as
          // unchanged (open) instead of calling all of them "introduced".
          const msg = `The previous image ${baseImage} could not be scanned, so image findings are listed as open but not compared.`;
          o.log.warn(msg);
          warnings.push(msg);
          base = mergeScans(base, headImageScan);
        }
      }
    }

    const report = diffScans(base, head, {
      version: o.to,
      previousVersion: o.from,
      scannedAt: new Date().toISOString(),
      tools: { syft: syftVersion, grype: grypeVersion },
    });
    report.sources = { repository: true, image: headImage, previousImage: baseImage, paths };
    report.warnings = warnings;
    return { report, sbom: headRepo.sbom, imageSbom };
  } finally {
    for (const dir of trees) {
      await git(["worktree", "remove", "--force", dir], o.cwd).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
    await git(["worktree", "prune"], o.cwd).catch(() => undefined);
  }
}
