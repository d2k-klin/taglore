import { describeCounts } from "./diff.js";
import type { SecurityReport, Vulnerability } from "./types.js";

/* The Security section is built from scanner data only. No AI is involved. */

const SEV_LABEL: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  negligible: "Negligible",
  unknown: "Unknown",
};

/** Table cells must not break the Markdown table or inject markup. */
function cell(s: string): string {
  return s.replace(/[|<>`\r\n]/g, " ").replace(/\s+/g, " ").trim();
}

function idCell(v: Vulnerability): string {
  const label = cell(v.id);
  const cve = v.aliases.find((a) => a.startsWith("CVE-"));
  const shown = cve && !label.startsWith("CVE-") ? `${label} (${cell(cve)})` : label;
  return v.url ? `[${shown}](${v.url.replace(/[()\s<>]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase())})` : shown;
}

function table(rows: { mark: string; v: Vulnerability }[]): string {
  const head = "| | Vulnerability | Severity | Package | Fixed in |\n|---|---|---|---|---|\n";
  return (
    head +
    rows
      .map(({ mark, v }) =>
        `| ${mark} | ${idCell(v)} | ${SEV_LABEL[v.severity]} | ${cell(v.package)} ${cell(v.version)} | ${v.fixedIn.length ? cell(v.fixedIn.join(", ")) : "no fix yet"} |`,
      )
      .join("\n") +
    "\n"
  );
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function renderSecuritySection(r: SecurityReport, maxItems = 15): string {
  const s = r.summary;
  const total = (c: typeof s.open) => Object.values(c).reduce((a, b) => a + b, 0);
  const nIntro = total(s.introduced);
  const nFixed = total(s.fixed);
  const nOpen = total(s.open);
  let md = "### 🔒 Security\n\n";

  if (r.previousVersion) {
    if (!nIntro && !nFixed) md += `No change in known vulnerabilities since ${cell(r.previousVersion)}. `;
    else {
      const bits = [];
      if (nFixed) bits.push(`fixes **${plural(nFixed, "known vulnerability", "known vulnerabilities")}**`);
      if (nIntro) bits.push(`introduces **${nIntro}** (${describeCounts(s.introduced)})`);
      md += `Compared with ${cell(r.previousVersion)}, this release ${bits.join(" and ")}. `;
    }
  }
  md += nOpen ? `Known vulnerabilities in this version: ${describeCounts(s.open)}.\n\n` : "No known vulnerabilities in this version's dependencies.\n\n";

  const rows = [
    ...r.introduced.map((v) => ({ mark: "🆕", v })),
    ...r.fixed.map((v) => ({ mark: "✅", v })),
  ];
  // First release: list what is open, since there is nothing to compare against.
  const list = r.previousVersion ? rows : r.open.map((v) => ({ mark: "⚠️", v }));
  if (list.length) {
    md += table(list.slice(0, maxItems));
    if (list.length > maxItems) md += `\n…and ${list.length - maxItems} more in \`security.json\`.\n`;
    md += "\n";
  }

  const c = s.components;
  if (r.previousVersion && (c.added || c.removed || c.changed || r.newLicenses.length)) {
    const parts: string[] = [];
    if (c.added || c.removed || c.changed) parts.push(`Dependencies: ${c.added} added, ${c.removed} removed, ${c.changed} changed (${c.total} total).`);
    if (r.newLicenses.length) parts.push(`New licenses: ${r.newLicenses.map(cell).join(", ")}.`);
    md += parts.join(" ") + "\n\n";
  }

  for (const w of r.warnings) md += `> ⚠️ ${cell(w)}\n\n`;
  const what = r.sources.image ? `the repository's lockfiles and the image ${cell(r.sources.image)}` : "the repository's lockfiles and manifests";
  const files = r.sources.image ? "security.json, sbom.cdx.json and sbom-image.cdx.json" : "security.json and sbom.cdx.json";
  md += `<sub>Scanned ${what} with Syft ${cell(r.tools.syft ?? "?")} and Grype ${cell(r.tools.grype ?? "?")}; both versions were checked against the same vulnerability database. The full report and the CycloneDX SBOMs are attached as ${files}.</sub>\n\n`;
  return md;
}
