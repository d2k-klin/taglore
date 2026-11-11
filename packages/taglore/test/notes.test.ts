import { describe, expect, it } from "vitest";
import { fallbackNotes } from "../src/fallback.js";
import { extractJson } from "../src/prompt.js";
import { cleanText, sanitizeNotes } from "../src/sanitize.js";
import { AiNotesSchema } from "../src/schema.js";

describe("sanitize", () => {
  it("strips HTML, links, URLs and markdown", () => {
    expect(cleanText('Click <a href="x">here</a> [now](https://evil.example) or https://evil.example/path **bold**', 200)).toBe(
      "Click here now or bold",
    );
    expect(cleanText("javascript:alert(1) safe", 100)).toBe("safe");
    expect(cleanText("a".repeat(50), 10)).toHaveLength(10);
  });
  it("drops empty items", () => {
    const n = sanitizeNotes(
      AiNotesSchema.parse({ title: "T", summary: "S", highlights: [{ title: "<b></b>", description: "" }, { title: "Real" }] }),
    );
    expect(n.highlights).toEqual([{ title: "Real", description: "", commits: [] }]);
  });
});

describe("extractJson", () => {
  it("handles fenced and chatty responses", () => {
    expect(extractJson('Sure!\n```json\n{"title":"a","summary":"b"}\n```')).toEqual({ title: "a", summary: "b" });
    expect(extractJson('Here you go {"title":"a","summary":"b"} done')).toEqual({ title: "a", summary: "b" });
    expect(() => extractJson("no json")).toThrow();
  });
});

describe("fallbackNotes", () => {
  it("groups conventional commits and skips chores", () => {
    const n = fallbackNotes(
      [
        { sha: "1", author: "a", subject: "feat(ui): add dark mode", body: "" },
        { sha: "2", author: "a", subject: "fix: crash on login", body: "" },
        { sha: "3", author: "a", subject: "chore: bump deps", body: "" },
        { sha: "4", author: "a", subject: "feat!: new auth flow", body: "" },
        { sha: "5", author: "a", subject: "perf: faster search", body: "" },
      ],
      "v1.9.0",
    );
    expect(n.highlights.map((h) => h.title)).toEqual(["ui: Add dark mode", "New auth flow"]);
    expect(n.fixes.map((h) => h.title)).toEqual(["Crash on login"]);
    expect(n.improvements.map((h) => h.title)).toEqual(["Faster search"]);
    expect(n.breaking.map((h) => h.title)).toEqual(["New auth flow"]);
  });
});
