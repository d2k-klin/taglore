/** Matches schema/release.schema.json (schemaVersion 1). */
export interface NoteItem {
  title: string;
  description: string;
  /** Short SHAs of the commits behind this statement (Taglore 1.2+). */
  commits?: string[];
}

/** history.json: every release, newest first. */
export interface History {
  schemaVersion: 1;
  releases: ReleaseNotes[];
}

export interface ReleaseNotes {
  schemaVersion: 1;
  version: string;
  previousVersion: string | null;
  releaseType: "major" | "minor" | "patch" | "prerelease";
  announce: boolean;
  date: string;
  title: string;
  summary: string;
  highlights: NoteItem[];
  improvements: NoteItem[];
  fixes: NoteItem[];
  breaking: NoteItem[];
  generator: { name: "taglore"; version: string; provider: string; model: string | null };
}

export function isReleaseNotes(v: unknown): v is ReleaseNotes {
  if (!v || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  return (
    n.schemaVersion === 1 &&
    typeof n.version === "string" &&
    typeof n.title === "string" &&
    typeof n.summary === "string" &&
    typeof n.announce === "boolean" &&
    Array.isArray(n.highlights)
  );
}

/** Compares "v1.10.0" and "1.9.2" numerically. Returns >0 when a is newer. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => (v.match(/\d+/g) ?? []).slice(0, 3).map(Number);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
