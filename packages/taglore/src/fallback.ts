import type { Commit } from "./collect.js";
import type { AiNotes, NoteItem } from "./schema.js";

const CC_RE = /^(?<type>\w+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?:\s*(?<desc>.+)$/;
const SKIP = new Set(["chore", "ci", "build", "test", "tests", "style", "refactor", "docs", "release", "revert"]);

function item(desc: string, scope: string | undefined, sha: string): NoteItem {
  const t = desc.charAt(0).toUpperCase() + desc.slice(1);
  return { title: scope ? `${scope}: ${t}` : t, description: "", commits: [sha.slice(0, 7)] };
}

/** Notes without AI, grouped by Conventional Commit type. Used when AI is disabled or fails. */
/** For a first release (no earlier version) nothing can break, so breaking changes are dropped. */
export function fallbackNotes(commits: Commit[], version: string, opts: { firstRelease?: boolean } = {}): AiNotes {
  const highlights: NoteItem[] = [];
  const improvements: NoteItem[] = [];
  const fixes: NoteItem[] = [];
  const breaking: NoteItem[] = [];

  for (const c of commits) {
    const m = CC_RE.exec(c.subject);
    const isBreaking = Boolean(m?.groups?.bang) || /BREAKING[ -]CHANGE:/.test(c.body);
    if (!m?.groups) {
      if (!/^(merge|bump|wip)\b/i.test(c.subject)) improvements.push(item(c.subject, undefined, c.sha));
      continue;
    }
    const { type = "", scope, desc = "" } = m.groups;
    const t = type.toLowerCase();
    if (isBreaking && !opts.firstRelease) breaking.push(item(desc, scope, c.sha));
    if (t === "feat") highlights.push(item(desc, scope, c.sha));
    else if (t === "fix") fixes.push(item(desc, scope, c.sha));
    else if (t === "perf") improvements.push(item(desc, scope, c.sha));
    else if (!SKIP.has(t)) improvements.push(item(desc, scope, c.sha));
  }

  const parts = [
    highlights.length && `${highlights.length} new feature${highlights.length > 1 ? "s" : ""}`,
    improvements.length && `${improvements.length} improvement${improvements.length > 1 ? "s" : ""}`,
    fixes.length && `${fixes.length} fix${fixes.length > 1 ? "es" : ""}`,
  ].filter(Boolean);

  return {
    title: opts.firstRelease ? `First release: ${version}` : `Release ${version}`,
    summary: opts.firstRelease
      ? "The first public release."
      : parts.length
        ? `This release includes ${parts.join(", ")}.`
        : "Maintenance release.",
    highlights: highlights.slice(0, 8),
    improvements: improvements.slice(0, 15),
    fixes: fixes.slice(0, 20),
    breaking: breaking.slice(0, 10),
  };
}
