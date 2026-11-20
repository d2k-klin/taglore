import { getOctokit } from "@actions/github";
import type { RepoRef } from "./github-release.js";

type Octokit = ReturnType<typeof getOctokit>;

/** The branch moved (or was created) by another run between our read and our write. */
export class BranchConflictError extends Error {}

const isConflict = (e: unknown) => {
  const status = (e as { status?: number }).status;
  return status === 409 || (status === 422 && /fast forward|already exists/i.test(String((e as Error).message)));
};

export interface BranchFile {
  path: string;
  content: string;
}

/**
 * Keeps Taglore's data (history.json, latest.json) in a branch of the repository, written
 * through the GitHub API. Needed when releases are immutable (no files can be attached after
 * publishing) or when a project doesn't use GitHub Releases at all.
 *
 * The branch is created as an orphan branch on first use, so it shares no history with the code.
 * Every write is one commit with all files.
 */
export class BranchStore {
  private octokit: Octokit;
  constructor(
    token: string,
    private ref: RepoRef,
    readonly branch: string,
    baseUrl?: string,
    octokitOptions: Record<string, unknown> = {},
  ) {
    if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("/") || branch.includes("..")) {
      throw new Error(`Invalid history-branch "${branch}".`);
    }
    this.octokit = getOctokit(token, { ...(baseUrl ? { baseUrl } : {}), ...octokitOptions });
  }

  /** The file's content, or null when the branch or the file doesn't exist yet. */
  async read(path: string): Promise<string | null> {
    try {
      const res = await this.octokit.rest.repos.getContent({ ...this.ref, path, ref: this.branch, mediaType: { format: "raw" } });
      const data = res.data as unknown;
      if (typeof data === "string") return data;
      if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
      return JSON.stringify(data);
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  }

  /**
   * Writes all files in one commit. Creates the branch (orphan) when it doesn't exist.
   * The ref update is not forced, so it only succeeds if nobody moved the branch since we read
   * its head; otherwise BranchConflictError tells the caller to re-read, merge and retry.
   */
  async write(files: BranchFile[], message: string): Promise<string> {
    try {
      return await this.writeOnce(files, message);
    } catch (e) {
      if (isConflict(e)) throw new BranchConflictError(`${this.branch} was updated by another run.`);
      throw e;
    }
  }

  private async writeOnce(files: BranchFile[], message: string): Promise<string> {
    const tree = files.map((f) => ({ path: f.path, mode: "100644" as const, type: "blob" as const, content: f.content }));
    let parent: string | null = null;
    try {
      const { data } = await this.octokit.rest.git.getRef({ ...this.ref, ref: `heads/${this.branch}` });
      parent = data.object.sha;
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
    }
    if (!parent) {
      const { data: t } = await this.octokit.rest.git.createTree({ ...this.ref, tree });
      const { data: c } = await this.octokit.rest.git.createCommit({ ...this.ref, message, tree: t.sha, parents: [] });
      await this.octokit.rest.git.createRef({ ...this.ref, ref: `refs/heads/${this.branch}`, sha: c.sha });
      return c.sha;
    }
    const { data: pc } = await this.octokit.rest.git.getCommit({ ...this.ref, commit_sha: parent });
    const { data: t } = await this.octokit.rest.git.createTree({ ...this.ref, base_tree: pc.tree.sha, tree });
    const { data: c } = await this.octokit.rest.git.createCommit({ ...this.ref, message, tree: t.sha, parents: [parent] });
    await this.octokit.rest.git.updateRef({ ...this.ref, ref: `heads/${this.branch}`, sha: c.sha, force: false });
    return c.sha;
  }
}
