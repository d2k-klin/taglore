import { vulnKey } from "./parse.js";
import {
  SEVERITIES,
  type Component,
  type FailOn,
  type SecurityReport,
  type SeverityCounts,
  type Vulnerability,
} from "./types.js";

export function emptyCounts(): SeverityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, negligible: 0, unknown: 0 };
}

export function countBySeverity(list: Vulnerability[]): SeverityCounts {
  const c = emptyCounts();
  for (const v of list) c[v.severity]++;
  return c;
}

const RANK: Record<string, number> = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));

/** Most severe first, then by package and id for a stable order. */
export function sortVulns(list: Vulnerability[]): Vulnerability[] {
  return [...list].sort(
    (a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9) || a.package.localeCompare(b.package) || a.id.localeCompare(b.id),
  );
}

export interface ScanResult {
  components: Map<string, Component>;
  vulns: Map<string, Vulnerability>;
}

/**
 * Compares two scans of the same project. Both must have been scanned with the same
 * vulnerability database, so a difference means the code changed, not the data.
 * base = null for a first release: everything is reported as open, nothing as introduced/fixed.
 */
export function diffScans(
  base: ScanResult | null,
  head: ScanResult,
  meta: { version: string; previousVersion: string | null; scannedAt: string; tools: SecurityReport["tools"] },
): SecurityReport {
  const open = sortVulns([...head.vulns.values()]);
  const introduced = base ? sortVulns([...head.vulns.values()].filter((v) => !base.vulns.has(vulnKey(v)))) : [];
  const fixed = base ? sortVulns([...base.vulns.values()].filter((v) => !head.vulns.has(vulnKey(v)))) : [];

  const added: Component[] = [];
  const removed: Component[] = [];
  const changed: SecurityReport["components"]["changed"] = [];
  if (base) {
    for (const [k, c] of head.components) {
      const old = base.components.get(k);
      if (!old) added.push(c);
      else if (old.version !== c.version) changed.push({ name: c.name, type: c.type, from: old.version, to: c.version });
    }
    for (const [k, c] of base.components) if (!head.components.has(k)) removed.push(c);
  }
  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

  const licenses = (s: ScanResult | null) => new Set([...(s?.components.values() ?? [])].flatMap((c) => c.licenses));
  const baseLicenses = licenses(base);
  const newLicenses = base ? [...licenses(head)].filter((l) => !baseLicenses.has(l)).sort() : [];

  return {
    schemaVersion: 1,
    version: meta.version,
    previousVersion: meta.previousVersion,
    scannedAt: meta.scannedAt,
    tools: meta.tools,
    summary: {
      open: countBySeverity(open),
      introduced: countBySeverity(introduced),
      fixed: countBySeverity(fixed),
      components: { total: head.components.size, added: added.length, removed: removed.length, changed: changed.length },
    },
    introduced,
    fixed,
    open,
    components: { added: added.sort(byName), removed: removed.sort(byName), changed: changed.sort(byName) },
    newLicenses,
  };
}

/**
 * Findings that break the gate. Normally the introduced ones; for a first release
 * (nothing to compare against) every open finding counts.
 */
export function gateViolations(report: SecurityReport, failOn: FailOn): Vulnerability[] {
  if (failOn === "none") return [];
  const limit = RANK[failOn] ?? -1;
  const pool = report.previousVersion === null ? report.open : report.introduced;
  return pool.filter((v) => (RANK[v.severity] ?? 9) <= limit);
}

export function describeCounts(c: SeverityCounts): string {
  const parts = SEVERITIES.filter((s) => c[s] > 0).map((s) => `${c[s]} ${s}`);
  return parts.length ? parts.join(", ") : "none";
}
