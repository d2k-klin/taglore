import { getOctokit } from "@actions/github";

type Octokit = ReturnType<typeof getOctokit>;

export const RELEASE_ASSET_NAME = "taglore.json";

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
  constructor(token: string, private ref: RepoRef, baseUrl?: string) {
    this.octokit = getOctokit(token, baseUrl ? { baseUrl } : {});
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

  /** Creates the release, or updates the body of an existing one (e.g. created by another workflow). */
  async upsert(o: { tag: string; name: string; body: string; prerelease: boolean; draft: boolean; makeLatest: boolean }) {
    const existing = await this.findByTag(o.tag);
    if (existing) {
      const { data } = await this.octokit.rest.repos.updateRelease({
        ...this.ref,
        release_id: existing.id,
        name: o.name,
        body: o.body,
      });
      return data;
    }
    const { data } = await this.octokit.rest.repos.createRelease({
      ...this.ref,
      tag_name: o.tag,
      name: o.name,
      body: o.body,
      prerelease: o.prerelease,
      draft: o.draft,
      make_latest: o.makeLatest ? "true" : "false",
    });
    return data;
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
