/* Shapes follow real Syft CycloneDX JSON and Grype JSON output (trimmed to the fields Taglore reads). */

export const sbomBase = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  components: [
    { type: "library", name: "lodash", version: "4.17.15", purl: "pkg:npm/lodash@4.17.15", licenses: [{ license: { id: "MIT" } }] },
    { type: "library", name: "minimist", version: "1.2.0", purl: "pkg:npm/minimist@1.2.0", licenses: [{ license: { id: "MIT" } }] },
    { type: "library", name: "left-pad", version: "1.3.0", purl: "pkg:npm/left-pad@1.3.0", licenses: [{ license: { id: "WTFPL" } }] },
    { type: "file", name: "/package-lock.json" },
  ],
};

export const sbomHead = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  components: [
    { type: "library", name: "lodash", version: "4.17.21", purl: "pkg:npm/lodash@4.17.21", licenses: [{ license: { id: "MIT" } }] },
    { type: "library", name: "minimist", version: "1.2.0", purl: "pkg:npm/minimist@1.2.0", licenses: [{ license: { id: "MIT" } }] },
    { type: "library", name: "@scope/http", version: "0.21.0", purl: "pkg:npm/%40scope/http@0.21.0", licenses: [{ expression: "MIT OR Apache-2.0" }] },
  ],
};

const match = (id: string, severity: string, name: string, version: string, fix: string[], cve?: string) => ({
  vulnerability: {
    id,
    severity,
    dataSource: `https://github.com/advisories/${id}`,
    fix: { versions: fix, state: fix.length ? "fixed" : "not-fixed" },
  },
  relatedVulnerabilities: cve ? [{ id: cve }] : [],
  artifact: { name, version, type: "npm", purl: `pkg:npm/${name.replace("@", "%40")}@${version}` },
});

export const grypeBase = {
  matches: [
    match("GHSA-35jh-r3h4-6jhm", "High", "lodash", "4.17.15", ["4.17.21"], "CVE-2021-23337"),
    match("GHSA-p6mc-m468-83gw", "High", "lodash", "4.17.15", ["4.17.19"], "CVE-2020-8203"),
    match("GHSA-vh95-rmgr-6w4m", "Medium", "minimist", "1.2.0", ["1.2.3"], "CVE-2020-7598"),
    // Duplicate match for the same finding at another location: must be counted once.
    match("GHSA-vh95-rmgr-6w4m", "Medium", "minimist", "1.2.0", ["1.2.3"], "CVE-2020-7598"),
  ],
  descriptor: { name: "grype", version: "0.0.0-test" },
};

export const grypeHead = {
  matches: [
    match("GHSA-vh95-rmgr-6w4m", "Medium", "minimist", "1.2.0", ["1.2.3"], "CVE-2020-7598"),
    match("GHSA-4w2v-q235-vp99", "Critical", "@scope/http", "0.21.0", [], "CVE-2099-0001"),
  ],
  descriptor: { name: "grype", version: "0.0.0-test" },
};
