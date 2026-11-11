import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { GitHubReleases } from "./publish/github-release.js";
import { RELEASE_ASSET_NAME } from "./publish/github-release.js";
import { HistorySchema, type History, type ReleaseNotes, ReleaseNotesSchema, SCHEMA_VERSION } from "./schema.js";
import { compareSemver, type SemVer, stableTags } from "./version.js";

export const HISTORY_ASSET_NAME = "taglore-history.json";

export interface HistoryOptions {
  notes: ReleaseNotes;
  current: SemVer | null;
  tags: string[];
  prefix: string;
  limit: number;
  /** Local history.json to continue from (no GitHub needed). */
  historyFile?: string;
  cwd: string;
  releases: GitHubReleases | null;
  log: { info(m: string): void; warn(m: string): void };
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

  if (o.historyFile) {
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
  } else if (!o.releases) {
    o.log.info("No GitHub token or history-file: history.json contains this release only.");
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
