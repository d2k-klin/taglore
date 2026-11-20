import { getOctokit } from "@actions/github";

type Octokit = ReturnType<typeof getOctokit>;

export const RELEASE_ASSET_NAME = "taglore.json";

export type ReleaseBodyMode = "replace" | "prepend" | "append";
export const BODY_START = "<!-- taglore:start -->";
export const BODY_END = "<!-- taglore:end -->";

/**
 * Combines Taglore's notes with a release body written by someone else (e.g. Release Please's
 * changelog). Taglore's part sits between markers, so a re-run replaces it instead of stacking.
 */
export function composeBody(existing: string | null | undefined, notes: string, mode: ReleaseBodyMode): string {
  const block = `${BODY_START}\n${notes.trim()}\n${BODY_END}`;
  if (mode === "replace" || !existing) return block;
  const start = existing.indexOf(BODY_START);
  const end = existing.indexOf(BODY_END);
  const other = (start !== -1 && end > start ? existing.slice(0, start) + existing.slice(end + BODY_END.length) : existing).trim();
  if (!other) return block;
  return mode === "prepend" ? `${block}\n\n---\n\n${other}` : `${other}\n\n---\n\n${block}`;
}

export interface ReleaseAsset {
  name: string;
  content: string;
  contentType?: string;
}

/**
 * True when a release body is nothing but Taglore's block (written by Taglore alone).
 * An empty body proves nothing about who created the release, so it doesn't count.
 */
export function isOnlyTagloreBody(body: string | null | undefined): boolean {
  if (!body?.trim()) return false;
  const start = body.indexOf(BODY_START);
  const end = body.indexOf(BODY_END);
  return start !== -1 && end > start && (body.slice(0, start) + body.slice(end + BODY_END.length)).trim() === "";
}

export interface RepoRef {
  owner: string;
  repo: string;
}

export function parseRepo(full: string): RepoRef {
  const [owner, repo] = full.split("/");
  if (!owner || !repo) throw new Error(`Invalid repository "${full}", expected owner/name`);
  return { owner, repo };
}

export class GitHubReleases {
  private octokit: Octokit;
  /** octokitOptions: extra Octokit options, e.g. a custom request.fetch (used by tests). */
  constructor(token: string, private ref: RepoRef, baseUrl?: string, octokitOptions: Record<string, unknown> = {}) {
    this.octokit = getOctokit(token, { ...(baseUrl ? { baseUrl } : {}), ...octokitOptions });
  }

  async findByTag(tag: string) {
    try {
      const { data } = await this.octokit.rest.repos.getReleaseByTag({ ...this.ref, tag });
      return data;
    } catch (e: unknown) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  }

  /** Drafts are invisible to getReleaseByTag, so look for one in the release list. */
  async findDraftByTag(tag: string) {
    const { data } = await this.octokit.rest.repos.listReleases({ ...this.ref, per_page: 100 });
    return data.find((r) => r.draft && r.tag_name === tag) ?? null;
  }

  /**
   * Creates or updates the release and attaches the assets.
   *
   * New releases are created as a draft, the assets are attached, and only then is the release
   * published. That is the order immutable releases require (assets can't be added after
   * publishing) and it means nobody sees a release without its files.
   *
   * An existing published release keeps its state: Taglore updates the text (allowed even for
   * immutable releases) and attaches the assets unless the release is immutable. A draft that
   * someone else created (e.g. Release Please with draft: true) stays a draft.
   *
   * bodyMode replace: Taglore owns title and body. prepend/append: Taglore's notes go before/after
   * the existing body and the existing title is kept.
   */
  async publish(o: {
    tag: string;
    name: string;
    body: string;
    prerelease: boolean;
    draft: boolean;
    makeLatest: boolean;
    bodyMode?: ReleaseBodyMode;
    assets: ReleaseAsset[];
    log?: { info(m: string): void; warn(m: string): void };
  }): Promise<{ html_url: string; assetsAttached: boolean }> {
    const mode = o.bodyMode ?? "replace";
    const log = o.log ?? { info: () => {}, warn: () => {} };
    const existing = (await this.findByTag(o.tag)) ?? (await this.findDraftByTag(o.tag));

    if (existing && !existing.draft) {
      const { data } = await this.octokit.rest.repos.updateRelease({
        ...this.ref,
        release_id: existing.id,
        ...(mode === "replace" || !existing.name ? { name: o.name } : {}),
        body: composeBody(existing.body, o.body, mode),
      });
      if ((existing as { immutable?: boolean }).immutable) {
        log.warn(
          `${o.tag} is an immutable release: its notes were updated, but files can't be attached after publishing. Earlier runs and patch releases can't read them from here; use history-branch to keep the history.`,
        );
        return { html_url: data.html_url, assetsAttached: false };
      }
      const attached = await this.attachAll(data, o.assets, o.tag, log);
      return { html_url: data.html_url, assetsAttached: attached };
    }

    let draft = existing;
    // A draft that holds only Taglore's notes is one an earlier run left behind: finish it.
    const ownDraft = !draft || isOnlyTagloreBody(draft.body);
    if (draft) {
      const { data } = await this.octokit.rest.repos.updateRelease({
        ...this.ref,
        release_id: draft.id,
        ...(mode === "replace" || !draft.name ? { name: o.name } : {}),
        body: composeBody(draft.body, o.body, mode),
        prerelease: o.prerelease,
      });
      draft = data;
    } else {
      const { data } = await this.octokit.rest.repos.createRelease({
        ...this.ref,
        tag_name: o.tag,
        name: o.name,
        body: composeBody(null, o.body, mode),
        prerelease: o.prerelease,
        draft: true,
      });
      draft = data;
    }
    await this.attachAll(draft, o.assets, o.tag, log);
    if (o.draft || !ownDraft) {
      if (!ownDraft) log.info(`${o.tag} is a draft someone else created; it stays a draft.`);
      return { html_url: draft.html_url, assetsAttached: true };
    }
    const { data: published } = await this.octokit.rest.repos.updateRelease({
      ...this.ref,
      release_id: draft.id,
      draft: false,
      make_latest: o.makeLatest ? "true" : "false",
    });
    return { html_url: published.html_url, assetsAttached: true };
  }

  private async attachAll(release: { id: number; upload_url: string }, assets: ReleaseAsset[], tag: string, log: { warn(m: string): void }) {
    try {
      for (const a of assets) await this.uploadAsset(release, a.name, a.content, a.contentType);
      return true;
    } catch (e) {
      // A release made immutable between our read and the upload, or by an org-wide policy.
      if ((e as { status?: number }).status === 422 && /immutable/i.test(String((e as Error).message))) {
        log.warn(`${tag} is an immutable release: files can't be attached after publishing. Use history-branch to keep the history.`);
        return false;
      }
      throw e;
    }
  }

  /** @deprecated Use publish(). Kept for callers of the 1.x API: creates or updates without assets. */
  async upsert(o: { tag: string; name: string; body: string; prerelease: boolean; draft: boolean; makeLatest: boolean; bodyMode?: ReleaseBodyMode }) {
    await this.publish({ ...o, assets: [] });
    return (await this.findByTag(o.tag)) ?? (await this.findDraftByTag(o.tag))!;
  }

  /** Uploads (or replaces) a release asset. Uses the release's own upload_url, so GitHub Enterprise Server works too. */
  async uploadAsset(release: { id: number; upload_url: string }, name: string, content: string, contentType = "application/json") {
    const { data: assets } = await this.octokit.rest.repos.listReleaseAssets({ ...this.ref, release_id: release.id, per_page: 100 });
    for (const a of assets.filter((a) => a.name === name)) {
      await this.octokit.rest.repos.deleteReleaseAsset({ ...this.ref, asset_id: a.id });
    }
    await this.octokit.request({
      method: "POST",
      url: release.upload_url,
      name,
      data: content,
      headers: { "content-type": contentType },
    });
  }

  /** Reads taglore.json from an earlier release. Returns null if the release or asset doesn't exist. */
  async readAsset(tag: string, name = RELEASE_ASSET_NAME): Promise<string | null> {
    const release = await this.findByTag(tag);
    const asset = release?.assets.find((a) => a.name === name);
    if (!asset) return null;
    const res = await this.octokit.request("GET /repos/{owner}/{repo}/releases/assets/{asset_id}", {
      ...this.ref,
      asset_id: asset.id,
      headers: { accept: "application/octet-stream" },
    });
    const data = res.data as unknown;
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
    return JSON.stringify(data);
  }
}
