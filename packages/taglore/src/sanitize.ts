import type { AiNotes, NoteItem } from "./schema.js";

/**
 * AI output ends up in front of end users, so treat it as untrusted:
 * strip HTML, markdown links, bare URLs, control characters and code fences.
 */
export function cleanText(input: string, max: number): string {
  let s = input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\b(?:https?|ftp|file|javascript|data|vbscript):\S+/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/[*`#<>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + "…";
  return s;
}

function cleanItems(items: NoteItem[], limit: number): NoteItem[] {
  return items
    .map((i) => ({
      title: cleanText(i.title, 120),
      description: cleanText(i.description ?? "", 600),
      commits: [...new Set((i.commits ?? []).filter((c) => /^[0-9a-f]{7,40}$/i.test(c)).map((c) => c.toLowerCase().slice(0, 7)))],
    }))
    .filter((i) => i.title.length > 0)
    .slice(0, limit);
}

export function sanitizeNotes(n: AiNotes): AiNotes {
  return {
    title: cleanText(n.title, 100) || "New release",
    summary: cleanText(n.summary, 600),
    highlights: cleanItems(n.highlights, 8),
    improvements: cleanItems(n.improvements, 15),
    fixes: cleanItems(n.fixes, 20),
    breaking: cleanItems(n.breaking, 10),
  };
}
