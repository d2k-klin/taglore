import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizePaths } from "../src/collect.js";
import { BODY_END, BODY_START, composeBody, GitHubReleases } from "../src/publish/github-release.js";
import { runTaglore } from "../src/run.js";

const silent = { info: () => {}, warn: () => {} };

describe("composeBody", () => {
  const rp = "## [1.2.0](https://example.com) (2026-11-18)\n\n### Features\n\n* web: dark mode (abc1234)";
  it("replace writes only Taglore's notes", () => {
    expect(composeBody(rp, "## Notes", "replace")).toBe(`${BODY_START}\n## Notes\n${BODY_END}`);
  });
  it("prepend keeps the existing changelog below", () => {
    const b = composeBody(rp, "## Notes", "prepend");
    expect(b.startsWith(`${BODY_START}\n## Notes\n${BODY_END}\n\n---\n\n`)).toBe(true);
    expect(b.endsWith(rp)).toBe(true);
  });
  it("append keeps the existing changelog above", () => {
    const b = composeBody(rp, "## Notes", "append");
    expect(b.startsWith(rp)).toBe(true);
    expect(b.endsWith(`${BODY_START}\n## Notes\n${BODY_END}`)).toBe(true);
  });
  it("re-runs replace only Taglore's part instead of stacking", () => {
    const once = composeBody(rp, "## First", "prepend");
    const twice = composeBody(once, "## Second", "prepend");
    expect(twice).not.toContain("## First");
    expect(twice.split(BODY_START)).toHaveLength(2);
    expect(twice.endsWith(rp)).toBe(true);
  });
  it("an empty existing body is just the notes", () => {
    expect(composeBody("", "## Notes", "append")).toBe(`${BODY_START}\n## Notes\n${BODY_END}`);
  });
});

describe("normalizePaths", () => {
  it("treats backslashes as separators", () => {
    expect(normalizePaths(["apps\\web\\"])).toEqual(["apps/web"]);
  });
  it("cleans and de-duplicates", () => {
    expect(normalizePaths(["./apps/web/", "apps/web", " packages/ui ", "", "."])).toEqual(["apps/web", "packages/ui"]);
  });
  it("refuses paths outside the repository", () => {
    for (const bad of ["/etc", "../other", "apps/../../x", "C:/x", ":(glob)*", "..\\outside", "apps\\..\\..\\x"]) {
      expect(() => normalizePaths([bad])).toThrow(/Invalid path/);
    }
  });
});

describe("monorepo: paths", () => {
  let repo: string;
  const sh = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  const commit = (file: string, msg: string) => {
    mkdirSync(join(repo, file, ".."), { recursive: true });
    writeFileSync(join(repo, file), msg);
    sh(["add", "."]);
    sh(["commit", "-qm", msg]);
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "taglore-mono-"));
    sh(["init", "-q", "-b", "main"]);
    sh(["config", "user.email", "t@example.com"]);
    sh(["config", "user.name", "t"]);
    commit("apps/web/index.ts", "feat(web): first page");
    commit("apps/api/server.ts", "feat(api): first endpoint");
    sh(["tag", "web-v1.0.0"]);
    commit("apps/web/theme.ts", "feat(web): dark mode");
    commit("apps/api/auth.ts", "feat(api): token auth");
    commit("packages/ui/button.ts", "fix(ui): button focus ring");
    commit("README.md", "docs: readme");
    sh(["tag", "web-v1.1.0"]);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("only describes commits that touch the given paths", async () => {
    const r = await runTaglore({
      cwd: repo,
      to: "web-v1.1.0",
      tagPrefix: "web-v",
      paths: ["apps/web", "packages/ui"],
      provider: "none",
      publishGithubRelease: false,
      dryRun: true,
      log: silent,
    });
    expect(r.previousVersion).toBe("web-v1.0.0");
    expect(r.notes.highlights.map((h) => h.title)).toEqual(["web: Dark mode"]);
    expect(r.notes.fixes.map((h) => h.title)).toEqual(["ui: Button focus ring"]);
    expect(r.markdown).not.toContain("token auth");
    expect(r.markdown).not.toContain("readme");
    expect(r.evidence.unverified).toEqual([]);
  });

  it("without paths, the whole repository counts", async () => {
    const r = await runTaglore({ cwd: repo, to: "web-v1.1.0", tagPrefix: "web-v", provider: "none", publishGithubRelease: false, dryRun: true, log: silent });
    expect(r.notes.highlights.map((h) => h.title).sort()).toEqual(["api: Token auth", "web: Dark mode"]);
  });

  it("rejects an invalid release-body value", async () => {
    await expect(
      runTaglore({ cwd: repo, to: "web-v1.1.0", tagPrefix: "web-v", provider: "none", publishGithubRelease: false, dryRun: true, releaseBody: "merge" as never, log: silent }),
    ).rejects.toThrow(/Invalid release-body "merge"/);
  });
});

describe("GitHub Release created by Release Please", () => {
  const rpBody = "## [1.1.0](https://github.com/o/r/compare/v1.0.0...v1.1.0)\n\n### Features\n\n* dark mode";
  const calls: { method: string; url: string; body: Record<string, unknown> }[] = [];
  let srv: http.Server;
  let base: string;
  // The mock API on 127.0.0.1 is reached directly, whatever proxy the environment configures.
  const direct = new Agent();
  const opts = { request: { fetch: (url: string, init: object) => undiciFetch(url, { ...init, dispatcher: direct }) } };

  beforeAll(async () => {
    srv = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        calls.push({ method: req.method ?? "", url: req.url ?? "", body: raw ? JSON.parse(raw) : {} });
        res.setHeader("content-type", "application/json");
        if (req.url === "/repos/o/r/releases/tags/v1.1.0") {
          return res.end(JSON.stringify({ id: 7, name: "v1.1.0", body: rpBody, html_url: "x", upload_url: "x", assets: [] }));
        }
        if (req.method === "PATCH") return res.end(JSON.stringify({ id: 7, html_url: "x", upload_url: "x" }));
        res.statusCode = 404;
        res.end('{"message":"Not Found"}');
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    srv.close();
    void direct.close();
  });

  it("prepend keeps Release Please's title and changelog", async () => {
    const gh = new GitHubReleases("t", { owner: "o", repo: "r" }, base, opts);
    await gh.upsert({ tag: "v1.1.0", name: "v1.1.0: Dark mode", body: "## Dark mode is here", prerelease: false, draft: false, makeLatest: true, bodyMode: "prepend" });
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body.name).toBeUndefined();
    expect(String(patch.body.body).startsWith(`${BODY_START}\n## Dark mode is here\n${BODY_END}`)).toBe(true);
    expect(String(patch.body.body).endsWith(rpBody)).toBe(true);
  });

  it("replace takes over title and body", async () => {
    calls.length = 0;
    const gh = new GitHubReleases("t", { owner: "o", repo: "r" }, base, opts);
    await gh.upsert({ tag: "v1.1.0", name: "v1.1.0: Dark mode", body: "## Dark mode is here", prerelease: false, draft: false, makeLatest: true });
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body.name).toBe("v1.1.0: Dark mode");
    expect(String(patch.body.body)).not.toContain("### Features");
  });
});
