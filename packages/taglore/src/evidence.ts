import type { Commit } from "./collect.js";
import type { AiNotes, NoteItem } from "./schema.js";

export type EvidenceMode = "warn" | "strict";
const SECTIONS = ["breaking", "highlights", "improvements", "fixes"] as const;
export type Section = (typeof SECTIONS)[number];

export interface EvidenceItem {
  section: Section;
  title: string;
  description: string;
  /** Commits that exist in the compared range and were cited for this statement. */
  commits: { sha: string; subject: string }[];
}

export interface EvidenceReport {
  mode: EvidenceMode;
  items: EvidenceItem[];
  /** Statements with no commit in the compared range behind them. */
  unverified: { section: Section; title: string }[];
  /** True when strict mode removed the unverified statements from the notes. */
  removed: boolean;
}

/**
 * Checks every statement against the real commit range. A cited hash only counts
 * when it is a commit between the two compared versions; invented or out-of-range
 * hashes are dropped. Statements left without any commit are "unverified":
 * reported in warn mode, removed in strict mode.
 *
 * This proves a statement points at real changes, not that its wording is accurate.
 */
export function verifyEvidence(notes: AiNotes, commits: Commit[], mode: EvidenceMode): { notes: AiNotes; report: EvidenceReport } {
  const find = (sha: string) => commits.find((c) => c.sha.startsWith(sha));
  const report: EvidenceReport = { mode, items: [], unverified: [], removed: false };
  const out = { ...notes };

  for (const section of SECTIONS) {
    const kept: NoteItem[] = [];
    for (const item of notes[section]) {
      const real = [...new Map(item.commits.map(find).filter((c): c is Commit => !!c).map((c) => [c.sha, c])).values()];
      const checked: NoteItem = { ...item, commits: real.map((c) => c.sha.slice(0, 7)) };
      if (!real.length) {
        report.unverified.push({ section, title: item.title });
        if (mode === "strict") continue;
      }
      kept.push(checked);
      report.items.push({ section, title: item.title, description: item.description, commits: real.map((c) => ({ sha: c.sha.slice(0, 7), subject: c.subject })) });
    }
    out[section] = kept;
  }
  report.removed = mode === "strict" && report.unverified.length > 0;
  return { notes: out, report };
}

const LABEL: Record<Section, string> = { breaking: "Breaking", highlights: "Highlight", improvements: "Improvement", fixes: "Fix" };
const cell = (s: string) => s.replace(/[|<>`\r\n]/g, " ").replace(/\s+/g, " ").trim();

/** Review table for the workflow run summary. */
export function renderEvidenceMarkdown(r: EvidenceReport): string {
  if (!r.items.length && !r.unverified.length) return "";
  let md = "### 🔎 Evidence\n\n";
  if (r.unverified.length) {
    md += r.removed
      ? `**${r.unverified.length} statement${r.unverified.length > 1 ? "s were" : " was"} removed** because no commit in this release supports ${r.unverified.length > 1 ? "them" : "it"}: ${r.unverified.map((u) => cell(u.title)).join("; ")}.\n\n`
      : `⚠️ **${r.unverified.length} statement${r.unverified.length > 1 ? "s have" : " has"} no supporting commit.** Check before publishing, or set \`evidence: strict\` to remove such statements.\n\n`;
  } else md += "Every statement is backed by at least one commit in this release.\n\n";
  md += "| | Statement | Supporting commits |\n|---|---|---|\n";
  for (const i of r.items) {
    const ev = i.commits.length ? i.commits.map((c) => `\`${c.sha}\` ${cell(c.subject)}`).join("<br>") : "⚠️ none";
    md += `| ${LABEL[i.section]} | ${cell(i.title)} | ${ev} |\n`;
  }
  return md + "\n";
}
