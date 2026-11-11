import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTaglore } from "../src/run.js";
import { grypeBase, grypeHead, sbomBase, sbomHead } from "./fixtures/security.js";
import { expandImage } from "../src/security/scan.js";

const deb = (name: string, version: string) => ({ type: "library", name, version, purl: `pkg:deb/debian/${name}@${version}`, licenses: [] });
const debVuln = (id: string, sev: string, name: string, version: string, fix: string[]) => ({
  vulnerability: { id, severity: sev, dataSource: `https://security-tracker.debian.org/tracker/${id}`, fix: { versions: fix, state: fix.length ? "fixed" : "not-fixed" } },
  artifact: { name, version, type: "deb", purl: `pkg:deb/debian/${name}@${version}` },
});
const imgBase = { components: [deb("openssl", "3.0.1")], "x-grype": { matches: [debVuln("CVE-2022-0778", "High", "openssl", "3.0.1", ["3.0.2"])] } };
const imgHead = { components: [deb("openssl", "3.0.13"), deb("zlib1g", "1.2.13")], "x-grype": { matches: [debVuln("CVE-2023-45853", "Low", "zlib1g", "1.2.13", [])] } };

let repo: string;
let bin: string;
const silent = { info: () => {}, warn: () => {} };

function sh(args: string[]) {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "taglore-sec-"));
  bin = mkdtempSync(join(tmpdir(), "taglore-sec-bin-"));
  sh(["init", "-q", "-b", "main"]);
  sh(["config", "user.email", "t@example.com"]);
  sh(["config", "user.name", "t"]);
  // Each version carries the SBOM our fake syft "finds" and, inside it, the findings our fake grype "reports".
  writeFileSync(join(repo, ".fixture-sbom.json"), JSON.stringify({ ...sbomBase, "x-grype": grypeBase }));
  sh(["add", "."]);
  sh(["commit", "-qm", "feat: first"]);
  sh(["tag", "v1.0.0"]);
  writeFileSync(join(repo, ".fixture-sbom.json"), JSON.stringify({ ...sbomHead, "x-grype": grypeHead }));
  sh(["add", "."]);
  sh(["commit", "-qm", "feat: upgrade lodash, add http client"]);
  sh(["tag", "v1.1.0"]);

  // Fake syft: writes <dir>/.fixture-sbom.json to the requested cyclonedx-json file.
  writeFileSync(
    join(bin, "syft"),
    `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
if (a[0] === "version") { console.log(JSON.stringify({ version: "1.0.0-test" })); process.exit(0); }
const out = a[a.indexOf("-o") + 1].split("=")[1];
const src = a[0];
if (src.startsWith("dir:")) { fs.copyFileSync(path.join(src.slice(4), ".fixture-sbom.json"), out); process.exit(0); }
const img = path.join(process.env.FAKE_IMAGES || "/nonexistent", src.replace(/[^a-z0-9.]/gi, "_") + ".json");
if (!fs.existsSync(img)) { console.error("image not found: " + src); process.exit(1); }
fs.copyFileSync(img, out);
`,
  );
  // Fake grype: prints the findings embedded in the SBOM. Refuses to scan unless the DB is frozen.
  writeFileSync(
    join(bin, "grype"),
    `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
if (a[0] === "version") { console.log(JSON.stringify({ version: "0.0.0-test" })); process.exit(0); }
if (a[0] === "db") process.exit(0);
if (process.env.GRYPE_DB_AUTO_UPDATE !== "false") { console.error("db not frozen"); process.exit(3); }
const file = a.find((x) => x.startsWith("sbom:")).slice(5);
console.log(JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))["x-grype"]));
`,
  );
  chmodSync(join(bin, "syft"), 0o755);
  chmodSync(join(bin, "grype"), 0o755);
});

let images: string;
beforeAll(() => {
  images = mkdtempSync(join(tmpdir(), "taglore-sec-img-"));
  const put = (ref: string, doc: unknown) => writeFileSync(join(images, ref.replace(/[^a-z0-9.]/gi, "_") + ".json"), JSON.stringify(doc));
  put("ghcr.io/acme/app:v1.0.0", imgBase);
  put("ghcr.io/acme/app:v1.1.0", imgHead);
  put("acme/only-new:1.1.0", imgHead);
  process.env.FAKE_IMAGES = images;
});

afterAll(() => {
  rmSync(images, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

const opts = () => ({
  cwd: repo,
  provider: "none" as const,
  publishGithubRelease: false,
  security: true,
  syftCommand: join(bin, "syft"),
  grypeCommand: join(bin, "grype"),
  log: silent,
});

describe("runTaglore with security scanning", () => {
  it("scans both versions in worktrees and publishes the report files", async () => {
    const out = join(repo, "..", `out-${Date.now()}`);
    const r = await runTaglore({ ...opts(), to: "v1.1.0", outputDir: out });
    expect(r.previousVersion).toBe("v1.0.0");
    expect(r.security?.summary.fixed.high).toBe(2);
    expect(r.security?.summary.introduced.critical).toBe(1);
    expect(r.notes.security?.open.critical).toBe(1);
    expect(r.markdown).toContain("### 🔒 Security");
    expect(JSON.parse(readFileSync(join(out, "security.json"), "utf8")).introduced[0].id).toBe("GHSA-4w2v-q235-vp99");
    expect(JSON.parse(readFileSync(join(out, "sbom.cdx.json"), "utf8")).bomFormat).toBe("CycloneDX");
    // Worktrees are cleaned up.
    expect(execFileSync("git", ["worktree", "list"], { cwd: repo }).toString().trim().split("\n")).toHaveLength(1);
    rmSync(out, { recursive: true, force: true });
  });

  it("blocks the release before publishing when the gate trips", async () => {
    const out = join(repo, "..", `out-gate-${Date.now()}`);
    await expect(runTaglore({ ...opts(), to: "v1.1.0", outputDir: out, securityFailOn: "high" })).rejects.toThrow(
      /Security gate: 1 vulnerability at or above "high" introduced since v1.0.0: GHSA-4w2v-q235-vp99 \(critical\)/,
    );
    expect(existsSync(out)).toBe(false);
  });

  it("first release reports open findings without a diff", async () => {
    const r = await runTaglore({ ...opts(), to: "v1.0.0", dryRun: true });
    expect(r.security?.previousVersion).toBeNull();
    expect(r.security?.open).toHaveLength(3);
    expect(r.markdown).toContain("Known vulnerabilities in this version: 2 high, 1 medium.");
  });

  it("rejects an invalid gate value before scanning", async () => {
    await expect(runTaglore({ ...opts(), to: "v1.1.0", dryRun: true, securityFailOn: "hgh" as never })).rejects.toThrow(/Invalid security-fail-on/);
  });

  it("scans the built image too and compares it with the previous release's image", async () => {
    const out = join(repo, "..", `out-img-${Date.now()}`);
    const r = await runTaglore({ ...opts(), to: "v1.1.0", outputDir: out, securityImage: "ghcr.io/acme/app:{version}" });
    const sec = r.security!;
    expect(sec.sources).toEqual({ repository: true, image: "ghcr.io/acme/app:v1.1.0", previousImage: "ghcr.io/acme/app:v1.0.0" });
    expect(sec.fixed.map((v) => v.id)).toContain("CVE-2022-0778"); // openssl fixed in the image
    expect(sec.introduced.map((v) => v.id).sort()).toEqual(["CVE-2023-45853", "GHSA-4w2v-q235-vp99"]);
    expect(sec.components.changed.map((c) => c.name)).toContain("openssl");
    expect(sec.warnings).toEqual([]);
    expect(r.markdown).toContain("the image ghcr.io/acme/app:v1.1.0");
    expect(JSON.parse(readFileSync(join(out, "sbom-image.cdx.json"), "utf8")).components[0].name).toBe("openssl");
    rmSync(out, { recursive: true, force: true });
  });

  it("does not call image findings 'introduced' when the previous image is gone", async () => {
    const r = await runTaglore({ ...opts(), to: "v1.1.0", dryRun: true, securityImage: "acme/only-new:{semver}" });
    const sec = r.security!;
    expect(sec.warnings[0]).toMatch(/previous image acme\/only-new:1.0.0 could not be scanned/);
    expect(sec.introduced.map((v) => v.id)).toEqual(["GHSA-4w2v-q235-vp99"]); // repository finding only
    expect(sec.open.map((v) => v.id)).toContain("CVE-2023-45853");
    expect(r.markdown).toContain("> ⚠️ The previous image acme/only-new:1.0.0 could not be scanned");
  });

  it("fails clearly when the released image is missing", async () => {
    await expect(runTaglore({ ...opts(), to: "v1.1.0", dryRun: true, securityImage: "ghcr.io/acme/missing:{version}" })).rejects.toThrow(
      /Could not scan image ghcr.io\/acme\/missing:v1.1.0. Build or push it before this step/,
    );
  });

  it("reuses notes from an earlier step instead of generating them again", async () => {
    const out = join(repo, "..", `out-reuse-${Date.now()}`);
    const first = await runTaglore({ cwd: repo, to: "v1.1.0", provider: "none", publishGithubRelease: false, outputDir: out, log: silent });
    const second = await runTaglore({ ...opts(), to: "v1.1.0", dryRun: true, notesFrom: join(out, "release.json"), securityImage: "ghcr.io/acme/app:{version}" });
    expect(second.notes.title).toBe(first.notes.title);
    expect(second.notes.highlights).toEqual(first.notes.highlights);
    expect(second.notes.security?.introduced.critical).toBe(1);
    await expect(runTaglore({ ...opts(), to: "v1.0.0", dryRun: true, notesFrom: join(out, "release.json") })).rejects.toThrow(
      /is for v1.1.0, but this release is v1.0.0/,
    );
    rmSync(out, { recursive: true, force: true });
  });

  it("explains how to install missing scanners", async () => {
    await expect(runTaglore({ ...opts(), to: "v1.1.0", dryRun: true, syftCommand: "/nonexistent/syft" })).rejects.toThrow(/Syft not found/);
  });
});

describe("expandImage", () => {
  it("fills {version} and {semver}", () => {
    expect(expandImage("ghcr.io/a/b:{version}", "v1.2.3")).toBe("ghcr.io/a/b:v1.2.3");
    expect(expandImage("a/b:{semver}", "v1.2.3")).toBe("a/b:1.2.3");
    expect(expandImage("a/b:{semver}", "app-v2.0.0")).toBe("a/b:2.0.0");
  });
  it("rejects a template without a placeholder", () => {
    expect(() => expandImage("a/b:latest", "v1.0.0")).toThrow(/must contain \{version\} or \{semver\}/);
  });
});
