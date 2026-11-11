import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTaglore } from "../src/run.js";
import { grypeBase, grypeHead, sbomBase, sbomHead } from "./fixtures/security.js";

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
const dir = a.find((x) => x.startsWith("dir:")).slice(4);
const out = a[a.indexOf("-o") + 1].split("=")[1];
fs.copyFileSync(path.join(dir, ".fixture-sbom.json"), out);
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

afterAll(() => {
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

  it("explains how to install missing scanners", async () => {
    await expect(runTaglore({ ...opts(), to: "v1.1.0", dryRun: true, syftCommand: "/nonexistent/syft" })).rejects.toThrow(/Syft not found/);
  });
});
