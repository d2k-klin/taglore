import type { z } from "zod";
import type { Commit } from "./collect.js";
import { type AiNotes, AiNotesSchema } from "./schema.js";

const ITEM_LISTS = { highlights: 8, improvements: 15, fixes: 20, breaking: 10 } as const;

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const space = room.lastIndexOf(" ");
  return (space > max * 0.6 ? room.slice(0, space) : room).replace(/[\s,;:.-]+$/, "") + "…";
}

/**
 * Brings an AI answer within the schema's length limits: long strings are shortened at a word
 * boundary, long lists keep their first entries. Only used when length is the sole problem.
 */
export function trimToLimits(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = { ...(raw as Record<string, unknown>) };
  if (typeof r.title === "string") r.title = cut(r.title, 100);
  if (typeof r.summary === "string") r.summary = cut(r.summary, 600);
  for (const [key, max] of Object.entries(ITEM_LISTS)) {
    const list = r[key];
    if (!Array.isArray(list)) continue;
    r[key] = list.slice(0, max).map((item) => {
      if (!item || typeof item !== "object") return item;
      const it = { ...(item as Record<string, unknown>) };
      if (typeof it.title === "string") it.title = cut(it.title, 120);
      if (typeof it.description === "string") it.description = cut(it.description, 600);
      if (Array.isArray(it.commits)) it.commits = it.commits.slice(0, 30);
      return it;
    });
  }
  return r;
}

export function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const path = i.path.length ? i.path.join(".") : "(answer)";
    return `${path}: ${i.message}`;
  });
}

/** Compiles forbidden-terms: plain words match whole words, case-insensitive; /regex/flags is used as is. */
export function compileTerms(terms: string[] | undefined): { label: string; re: RegExp }[] {
  return (terms ?? [])
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const m = /^\/(.+)\/([a-z]*)$/.exec(t);
      if (m) return { label: t, re: new RegExp(m[1]!, m[2]!.replace("g", "")) };
      const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return { label: t, re: new RegExp(`(^|[^\\p{L}\\p{N}_])${esc}(?=$|[^\\p{L}\\p{N}_])`, "iu") };
    });
}

function userTexts(n: AiNotes): { where: string; text: string }[] {
  const out = [
    { where: "title", text: n.title },
    { where: "summary", text: n.summary },
  ];
  for (const key of Object.keys(ITEM_LISTS) as (keyof typeof ITEM_LISTS)[]) {
    n[key].forEach((it, i) => {
      out.push({ where: `${key}.${i}.title`, text: it.title });
      if (it.description) out.push({ where: `${key}.${i}.description`, text: it.description });
    });
  }
  return out;
}

/**
 * Style rules checked in code, not only asked for in the prompt: no commit hashes in user-facing
 * text, and none of the maintainer's forbidden terms (environment names, internal codenames...).
 */
export function styleIssues(n: AiNotes, commits: Commit[], terms: { label: string; re: RegExp }[]): string[] {
  const issues: string[] = [];
  const shas = commits.map((c) => c.sha.toLowerCase());
  for (const { where, text } of userTexts(n)) {
    for (const m of text.matchAll(/\b[0-9a-f]{7,40}\b/gi)) {
      const h = m[0].toLowerCase();
      if (shas.some((s) => s.startsWith(h))) issues.push(`${where}: contains the commit hash "${m[0]}"; hashes belong in "commits" only`);
    }
    for (const t of terms) {
      if (t.re.test(text)) issues.push(`${where}: contains the forbidden term "${t.label}"`);
    }
  }
  return issues;
}

export interface Evaluation {
  notes?: AiNotes;
  issues: string[];
  /** The answer was valid JSON whose only problems were lengths: trimToLimits can fix it. */
  trimmed?: AiNotes;
}

export function evaluateAnswer(text: string, extract: (t: string) => unknown, commits: Commit[], terms: { label: string; re: RegExp }[]): Evaluation {
  let raw: unknown;
  try {
    raw = extract(text);
  } catch (e) {
    return { issues: [`the answer was not a valid JSON object (${e instanceof Error ? e.message : String(e)})`] };
  }
  const parsed = AiNotesSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = describeIssues(parsed.error);
    const lengthOnly = parsed.error.issues.every((i) => i.code === "too_big");
    const fixed = lengthOnly ? AiNotesSchema.safeParse(trimToLimits(raw)) : null;
    return { issues, ...(fixed?.success ? { trimmed: fixed.data } : {}) };
  }
  return { notes: parsed.data, issues: styleIssues(parsed.data, commits, terms) };
}

export function repairPrompt(prompt: string, previous: string, issues: string[]): string {
  const prev = previous.length > 20_000 ? previous.slice(0, 20_000) + "\n[...]" : previous;
  return `${prompt}
YOUR PREVIOUS ANSWER
<<<ANSWER
${prev}
ANSWER>>>

It was rejected for these reasons:
${issues.map((i) => `- ${i}`).join("\n")}

Return the corrected JSON object only, in the same shape. Fix exactly these problems and keep everything else as it was.
`;
}
