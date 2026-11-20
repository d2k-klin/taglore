import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { GitHubReleases } from "./publish/github-release.js";
import { RELEASE_ASSET_NAME } from "./publish/github-release.js";
import { HistorySchema, type History, type ReleaseNotes, ReleaseNotesSchema, SCHEMA_VERSION } from "./schema.js";
import { compareSemver, parseSemver, type SemVer, stableTags } from "./version.js";

export const HISTORY_ASSET_NAME = "taglore-history.json";

export interface HistoryOptions {
  notes: ReleaseNotes;
  current: SemVer | null;
  tags: string[];
  prefix: string;
  limit: number;
  /** Local history.json to continue from (no GitHub needed). */
  historyFile?: string;
  /** Earlier releases already loaded by the caller (history-file / history-branch). Used as is. */
  stored?: ReleaseNotes[] | null;
  cwd: string;
  releases: GitHubReleases | null;
  log: { info(m: string): void; warn(m: string): void };
  /** Notes written in this run for earlier tags (backfill). Merged in, newest wins per version. */
  extra?: ReleaseNotes[];
}

function parseHistory(raw: string): ReleaseNotes[] | null {
  try {
    const parsed = HistorySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.releases : null;
  } catch {
    return null;
  }
}

/**
 * Builds history.json: this release followed by earlier ones, newest first.
 * Earlier releases come from (1) a local history file, (2) the history asset of the
 * nearest earlier GitHub Release, or (3) each earlier release's taglore.json asset.
 * No database: the GitHub Releases are the store.
 */
export async function buildHistory(o: HistoryOptions): Promise<History> {
  let earlier: ReleaseNotes[] = [];

  if (o.stored?.length) {
    // An empty stored history (first run with history-branch) still looks at the GitHub Releases.
    earlier = o.stored;
  } else if (o.historyFile) {
    const fromFile = parseHistory(await readFile(resolve(o.cwd, o.historyFile), "utf8"));
    if (!fromFile) throw new Error(`history-file: ${o.historyFile} is not a Taglore history.json.`);
    earlier = fromFile;
  } else if (o.releases && o.current) {
    const below = stableTags(o.tags, o.prefix)
      .filter((t) => compareSemver(t, o.current!) < 0)
      .reverse();
    // Fast path: the previous releases already carry the accumulated history.
    for (const tag of below.slice(0, 3)) {
      const raw = await o.releases.readAsset(tag.raw, HISTORY_ASSET_NAME);
      const list = raw ? parseHistory(raw) : null;
      if (list) {
        earlier = list;
        break;
      }
    }
    // First run in a repository that already has Taglore releases: collect them one by one.
    if (!earlier.length) {
      for (const tag of below.slice(0, o.limit)) {
        const raw = await o.releases.readAsset(tag.raw, RELEASE_ASSET_NAME);
        if (!raw) continue;
        try {
          const parsed = ReleaseNotesSchema.safeParse(JSON.parse(raw));
          if (parsed.success) earlier.push(parsed.data);
        } catch {
          // not a Taglore asset
        }
      }
    }
    if (below.length && !earlier.length) o.log.info("No earlier Taglore releases found; history.json starts with this release.");
  } else if (!o.releases && !o.stored && !o.extra?.length) {
    o.log.info("No GitHub token, history-file or history-branch: history.json contains this release only.");
  }

  if (o.extra?.length) {
    // Backfilled notes are fresh, so they win over older copies; then newest version first.
    const byVersion = new Map(earlier.map((r) => [r.version, r]));
    for (const r of o.extra) byVersion.set(r.version, r);
    earlier = [...byVersion.values()].sort((a, b) => {
      const va = parseSemver(a.version, o.prefix);
      const vb = parseSemver(b.version, o.prefix);
      return va && vb ? compareSemver(vb, va) : 0;
    });
  }
  const seen = new Set([o.notes.version]);
  const releases = [o.notes];
  for (const r of earlier) {
    if (seen.has(r.version)) continue;
    seen.add(r.version);
    releases.push(r);
  }
  return { schemaVersion: SCHEMA_VERSION, releases: releases.slice(0, o.limit) };
}
