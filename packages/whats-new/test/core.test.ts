import { beforeEach, describe, expect, it } from "vitest";
import { filterReleases, shouldShow } from "../src/core.js";
import type { ReleaseNotes } from "../src/types.js";

const store = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
};
const notes = (version: string, announce = true) => ({ version, announce }) as ReleaseNotes;

describe("shouldShow", () => {
  beforeEach(() => store.clear());
  it("marks first-time visitors as up to date", () => {
    expect(shouldShow(notes("v1.9.0"), "k", false)).toBe(false);
    expect(store.get("k")).toBe("v1.9.0");
  });
  it("shows to first-time visitors when asked", () => {
    expect(shouldShow(notes("v1.9.0"), "k", true)).toBe(true);
  });
  it("shows newer versions once", () => {
    store.set("k", "v1.8.0");
    expect(shouldShow(notes("v1.9.0"), "k", false)).toBe(true);
    store.set("k", "v1.9.0");
    expect(shouldShow(notes("v1.9.0"), "k", false)).toBe(false);
  });
  it("never shows non-announcements", () => {
    store.set("k", "v1.0.0");
    expect(shouldShow(notes("v1.9.1", false), "k", true)).toBe(false);
  });
});

describe("filterReleases", () => {
  const r = (version: string, title: string, items: string[]) =>
    ({ version, title, summary: "", breaking: [], highlights: items.map((t) => ({ title: t, description: "" })), improvements: [], fixes: [] }) as unknown as ReleaseNotes;
  const all = [r("v1.2.0", "Search", ["Fuzzy search", "Dark mode"]), r("v1.1.0", "Exports", ["CSV export"])];
  it("returns everything for an empty query", () => {
    expect(filterReleases(all, "  ")).toBe(all);
  });
  it("keeps only matching items, or the whole release when its title matches", () => {
    expect(filterReleases(all, "dark")[0]!.highlights.map((h) => h.title)).toEqual(["Dark mode"]);
    expect(filterReleases(all, "exports")[0]!.highlights).toHaveLength(1);
    expect(filterReleases(all, "v1.2.0")[0]!.highlights).toHaveLength(2);
    expect(filterReleases(all, "nothing here")).toEqual([]);
    expect(filterReleases(all, "csv EXPORT").map((x) => x.version)).toEqual(["v1.1.0"]);
  });
});
