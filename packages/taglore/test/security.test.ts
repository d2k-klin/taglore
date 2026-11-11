import { describe, expect, it } from "vitest";
import { diffScans, gateViolations } from "../src/security/diff.js";
import { renderSecuritySection } from "../src/security/markdown.js";
import { parseCycloneDx, parseGrype, purlKey } from "../src/security/parse.js";
import { grypeBase, grypeHead, sbomBase, sbomHead } from "./fixtures/security.js";

const meta = (prev: string | null) => ({ version: "v1.1.0", previousVersion: prev, scannedAt: "2026-11-11T00:00:00Z", tools: { syft: "1.0.0", grype: "0.90.0" } });
const base = { components: parseCycloneDx(sbomBase), vulns: parseGrype(grypeBase) };
const head = { components: parseCycloneDx(sbomHead), vulns: parseGrype(grypeHead) };

describe("parsing", () => {
  it("reads purl identity including scoped npm packages", () => {
    expect(purlKey("pkg:npm/%40scope/http@0.21.0?x=1")).toEqual({ type: "npm", key: "npm:@scope/http", name: "@scope/http" });
    expect(purlKey("pkg:golang/github.com/a/b@v1.2.3")).toEqual({ type: "golang", key: "golang:github.com/a/b", name: "github.com/a/b" });
    expect(purlKey("not-a-purl")).toBeNull();
  });
  it("skips file components and dedupes findings", () => {
    expect(base.components.size).toBe(3);
    expect(base.vulns.size).toBe(3);
    expect(head.vulns.get("GHSA-vh95-rmgr-6w4m|npm|minimist")?.aliases).toEqual(["CVE-2020-7598"]);
  });
});

describe("diffScans", () => {
  const r = diffScans(base, head, meta("v1.0.0"));
  it("splits findings into introduced, fixed and open", () => {
    expect(r.introduced.map((v) => v.id)).toEqual(["GHSA-4w2v-q235-vp99"]);
    expect(r.fixed.map((v) => v.id).sort()).toEqual(["GHSA-35jh-r3h4-6jhm", "GHSA-p6mc-m468-83gw"]);
    expect(r.open.map((v) => v.id)).toEqual(["GHSA-4w2v-q235-vp99", "GHSA-vh95-rmgr-6w4m"]); // critical first
    expect(r.summary.fixed.high).toBe(2);
    expect(r.summary.introduced.critical).toBe(1);
    expect(r.summary.open).toMatchObject({ critical: 1, medium: 1, high: 0 });
  });
  it("reports dependency and license changes", () => {
    expect(r.components.added.map((c) => c.name)).toEqual(["@scope/http"]);
    expect(r.components.removed.map((c) => c.name)).toEqual(["left-pad"]);
    expect(r.components.changed).toEqual([{ name: "lodash", type: "npm", from: "4.17.15", to: "4.17.21" }]);
    expect(r.newLicenses).toEqual(["MIT OR Apache-2.0"]);
  });
  it("first release: only open findings, no diff", () => {
    const first = diffScans(null, head, meta(null));
    expect(first.introduced).toEqual([]);
    expect(first.fixed).toEqual([]);
    expect(first.open).toHaveLength(2);
    expect(first.components.added).toEqual([]);
  });
});

describe("gate", () => {
  const r = diffScans(base, head, meta("v1.0.0"));
  it("fails on introduced findings at or above the threshold", () => {
    expect(gateViolations(r, "none")).toEqual([]);
    expect(gateViolations(r, "critical").map((v) => v.id)).toEqual(["GHSA-4w2v-q235-vp99"]);
    // The open medium (minimist) is not introduced, so it does not fail the gate.
    expect(gateViolations(r, "medium").map((v) => v.id)).toEqual(["GHSA-4w2v-q235-vp99"]);
  });
  it("first release gates on everything open", () => {
    expect(gateViolations(diffScans(null, head, meta(null)), "medium")).toHaveLength(2);
  });
});

describe("review regressions", () => {
  it("rejects an invalid fail-on value instead of disabling the gate", () => {
    const r = diffScans(base, head, meta("v1.0.0"));
    expect(() => gateViolations(r, "hgh" as never)).toThrow(/Invalid security-fail-on "hgh"/);
  });
  it("keeps Maven packages with the same artifactId but different groups apart", () => {
    const m = (group: string) => ({
      vulnerability: { id: "GHSA-same", severity: "High", fix: { versions: [], state: "unknown" } },
      artifact: { name: "core", version: "1.0", type: "java-archive", purl: `pkg:maven/${group}/core@1.0` },
    });
    const before = parseGrype({ matches: [m("com.a")] });
    const after = parseGrype({ matches: [m("com.a"), m("com.b")] });
    expect(after.size).toBe(2);
    const r = diffScans({ components: new Map(), vulns: before }, { components: new Map(), vulns: after }, meta("v1.0.0"));
    expect(r.introduced.map((v) => v.package)).toEqual(["com.b/core"]);
  });
  it("detects a change when several versions of a package coexist", () => {
    const sbom = (versions: string[], lic: string) => ({
      components: versions.map((v) => ({ type: "library", name: "foo", version: v, purl: `pkg:npm/foo@${v}`, licenses: [{ license: { id: v === "1.1" ? lic : "MIT" } }] })),
    });
    const r = diffScans(
      { components: parseCycloneDx(sbom(["1.0", "2.0"], "MIT")), vulns: new Map() },
      { components: parseCycloneDx(sbom(["1.1", "2.0"], "BSD-3-Clause")), vulns: new Map() },
      meta("v1.0.0"),
    );
    expect(r.components.changed).toEqual([{ name: "foo", type: "npm", from: "1.0, 2.0", to: "1.1, 2.0" }]);
    expect(r.newLicenses).toEqual(["BSD-3-Clause"]);
    expect(r.summary.components.total).toBe(2);
  });
  it("renders license-only changes", () => {
    const sbom = (lic: string) => ({ components: [{ type: "library", name: "foo", version: "1.0", purl: "pkg:npm/foo@1.0", licenses: [{ license: { id: lic } }] }] });
    const r = diffScans(
      { components: parseCycloneDx(sbom("MIT")), vulns: new Map() },
      { components: parseCycloneDx(sbom("AGPL-3.0-only")), vulns: new Map() },
      meta("v1.0.0"),
    );
    expect(renderSecuritySection(r)).toContain("New licenses: AGPL-3.0-only.");
  });
});

describe("renderSecuritySection", () => {
  it("summarises and lists introduced and fixed findings", () => {
    const md = renderSecuritySection(diffScans(base, head, meta("v1.0.0")));
    expect(md).toContain("### 🔒 Security");
    expect(md).toContain("fixes **2 known vulnerabilities** and introduces **1** (1 critical)");
    expect(md).toContain("| 🆕 | [GHSA-4w2v-q235-vp99 (CVE-2099-0001)](https://github.com/advisories/GHSA-4w2v-q235-vp99) | Critical | @scope/http 0.21.0 | no fix yet |");
    expect(md).toContain("| ✅ |");
    expect(md).toContain("Dependencies: 1 added, 1 removed, 1 changed (3 total). New licenses: MIT OR Apache-2.0.");
  });
  it("escapes table-breaking content and caps rows", () => {
    const evil = parseGrype({
      matches: Array.from({ length: 20 }, (_, i) => ({
        vulnerability: { id: `X-${i}|<img>`, severity: "Low", fix: { versions: [], state: "unknown" } },
        artifact: { name: "pkg|name", version: "1", type: "npm" },
      })),
    });
    const md = renderSecuritySection(diffScans(null, { components: new Map(), vulns: evil }, meta(null)), 5);
    expect(md).not.toContain("<img>");
    expect(md).toContain("pkg name 1");
    expect(md).toContain("…and 15 more in `security.json`.");
  });
  it("says so when nothing changed", () => {
    const same = diffScans(head, head, meta("v1.0.0"));
    expect(renderSecuritySection(same)).toContain("No change in known vulnerabilities since v1.0.0.");
  });
});
