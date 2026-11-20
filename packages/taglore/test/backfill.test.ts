import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BODY_START } from "../src/publish/github-release.js";
import { runTaglore } from "../src/run.js";

const silent = { info: () => {}, warn: () => {} };

interface Rel {
  id: number;
  tag_name: string;
  name: string;
  body: string;
  draft?: boolean;
  immutable?: boolean;
  make_latest?: string;
  assets: { id: number; name: string; content: string }[];
}

let repo: string;
let fakeCopilot: string;
let srv: http.Server;
let base: string;
const releases: Rel[] = [];
let nextId = 100;
const log: string[] = [];
let immutableRepo = false;
const branches = new Map<string, string>();
const commits = new Map<string, { tree: string; parents: string[] }>();
const trees = new Map<string, Record<string, string>>();
// The mock API on 127.0.0.1 is reached directly, whatever proxy the environment configures.
const direct = new Agent();
const octokitOptions = { request: { fetch: (url: string, init: object) => undiciFetch(url, { ...init, dispatcher: direct }) } };

const json = (rel: Rel) => ({
  id: rel.id,
  tag_name: rel.tag_name,
  name: rel.name,
  body: rel.body,
  draft: !!rel.draft,
  immutable: !!rel.immutable,
  html_url: `https://example.test/${rel.tag_name}`,
  upload_url: `${base}/upload/${rel.id}/assets{?name,label}`,
  assets: rel.assets.map((a) => ({ id: a.id, name: a.name })),
});

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "taglore-backfill-"));
  const sh = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  sh(["init", "-q", "-b", "main"]);
  sh(["config", "user.email", "t@example.com"]);
  sh(["config", "user.name", "t"]);
  const commit = (f: string, msg: string) => {
    writeFileSync(join(repo, f), msg);
    sh(["add", "."]);
    sh(["commit", "-qm", msg]);
  };
  commit("a.txt", "feat: first feature");
  sh(["tag", "v1.0.0"]);
  commit("b.txt", "fix: login bug");
  sh(["tag", "v1.0.1"]);
  commit("c.txt", "feat: dark mode");
  sh(["tag", "v1.1.0"]);
  commit("d.txt", "fix: typo");
  sh(["tag", "v1.1.1"]);
  commit("e.txt", "feat: export to CSV");
  sh(["tag", "v1.2.0"]);

  fakeCopilot = join(tmpdir(), `fake-copilot-backfill-${Date.now()}.sh`);
  writeFileSync(
    fakeCopilot,
    `#!/bin/sh\ncat >/dev/null\necho '{"title":"Better every day","summary":"Small steps.","highlights":[{"title":"Polish","description":"Nicer."}],"improvements":[],"fixes":[],"breaking":[]}'\n`,
  );
  chmodSync(fakeCopilot, 0o755);

  // Before onboarding: v1.0.0 already went through Taglore, v1.0.1 has a hand-written release.
  releases.push({
    id: 1,
    tag_name: "v1.0.0",
    name: "v1.0.0",
    body: "old",
    assets: [{ id: 11, name: "taglore.json", content: JSON.stringify({ schemaVersion: 1, version: "v1.0.0", previousVersion: null, releaseType: "minor", announce: true, date: "2026-01-01", title: "First", summary: "Hello.", highlights: [], improvements: [], fixes: [], breaking: [], generator: { name: "taglore", version: "1.0.0", provider: "copilot", model: "default" } }) }],
  });
  releases.push({ id: 2, tag_name: "v1.0.1", name: "v1.0.1 hotfix", body: "Hotfix written by hand.", assets: [] });
  // A broken asset must not stop onboarding: v1.1.0 gets new notes.
  releases.push({ id: 3, tag_name: "v1.1.0", name: "v1.1.0", body: "", assets: [{ id: 31, name: "taglore.json", content: "not json{" }] });

  srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", base);
      // Octokit encodes "heads/branch" in ref paths; GitHub accepts both forms.
      const p = decodeURIComponent(url.pathname);
      res.setHeader("content-type", "application/json");
      const send = (code: number, body: unknown) => {
        res.statusCode = code;
        res.end(typeof body === "string" ? body : JSON.stringify(body));
      };
      let m: RegExpMatchArray | null;
      // Like GitHub: drafts are only visible in the list, not by tag.
      if (req.method === "GET" && (m = p.match(/^\/repos\/o\/r\/releases\/tags\/(.+)$/))) {
        const rel = releases.find((r) => r.tag_name === decodeURIComponent(m![1]!) && !r.draft);
        return rel ? send(200, json(rel)) : send(404, { message: "Not Found" });
      }
      if (req.method === "GET" && p === "/repos/o/r/releases") return send(200, releases.map(json));
      if (req.method === "POST" && p === "/repos/o/r/releases") {
        const b = JSON.parse(raw);
        const rel: Rel = { id: nextId++, tag_name: b.tag_name, name: b.name, body: b.body, draft: !!b.draft, make_latest: b.make_latest, assets: [] };
        releases.push(rel);
        log.push(`create ${b.tag_name}${b.draft ? " draft" : ""}`);
        return send(201, json(rel));
      }
      if (req.method === "PATCH" && (m = p.match(/^\/repos\/o\/r\/releases\/(\d+)$/))) {
        const rel = releases.find((r) => r.id === Number(m![1]))!;
        const b = JSON.parse(raw);
        if (b.name !== undefined) rel.name = b.name;
        if (b.body !== undefined) rel.body = b.body;
        if (b.make_latest !== undefined) rel.make_latest = b.make_latest;
        if (b.draft === false && rel.draft) {
          rel.draft = false;
          if (immutableRepo) rel.immutable = true;
          log.push(`publish ${rel.tag_name}`);
        }
        return send(200, json(rel));
      }
      if (req.method === "GET" && (m = p.match(/^\/repos\/o\/r\/releases\/(\d+)\/assets$/))) {
        const rel = releases.find((r) => r.id === Number(m![1]))!;
        return send(200, rel.assets.map((a) => ({ id: a.id, name: a.name })));
      }
      if (req.method === "DELETE" && (m = p.match(/^\/repos\/o\/r\/releases\/assets\/(\d+)$/))) {
        for (const r of releases) r.assets = r.assets.filter((a) => a.id !== Number(m![1]));
        res.statusCode = 204;
        return res.end();
      }
      if (req.method === "GET" && (m = p.match(/^\/repos\/o\/r\/releases\/assets\/(\d+)$/))) {
        const a = releases.flatMap((r) => r.assets).find((x) => x.id === Number(m![1]));
        res.setHeader("content-type", "application/octet-stream");
        return a ? send(200, a.content) : send(404, { message: "Not Found" });
      }
      if (req.method === "POST" && (m = p.match(/^\/upload\/(\d+)\/assets$/))) {
        const rel = releases.find((r) => r.id === Number(m![1]))!;
        if (rel.immutable) return send(422, { message: "Cannot upload assets to an immutable release." });
        rel.assets.push({ id: nextId++, name: url.searchParams.get("name")!, content: raw });
        log.push(`upload ${rel.tag_name} ${url.searchParams.get("name")}`);
        return send(201, {});
      }
      // Git data + contents API for history-branch.
      if (req.method === "GET" && (m = p.match(/^\/repos\/o\/r\/git\/ref\/heads\/(.+)$/))) {
        const sha = branches.get(decodeURIComponent(m[1]!));
        return sha ? send(200, { object: { sha } }) : send(404, { message: "Not Found" });
      }
      if (req.method === "GET" && (m = p.match(/^\/repos\/o\/r\/git\/commits\/(.+)$/))) return send(200, { sha: m[1], tree: { sha: commits.get(m[1]!)!.tree } });
      if (req.method === "POST" && p === "/repos/o/r/git/trees") {
        const b = JSON.parse(raw);
        const base = b.base_tree ? trees.get(b.base_tree)! : {};
        const files = { ...base };
        for (const t of b.tree) files[t.path] = t.content;
        const sha = `tree${nextId++}`;
        trees.set(sha, files);
        return send(201, { sha });
      }
      if (req.method === "POST" && p === "/repos/o/r/git/commits") {
        const b = JSON.parse(raw);
        const sha = `commit${nextId++}`;
        commits.set(sha, { tree: b.tree, parents: b.parents });
        return send(201, { sha });
      }
      if (req.method === "POST" && p === "/repos/o/r/git/refs") {
        const b = JSON.parse(raw);
        branches.set(b.ref.replace("refs/heads/", ""), b.sha);
        return send(201, {});
      }
      if (req.method === "PATCH" && (m = p.match(/^\/repos\/o\/r\/git\/refs\/heads\/(.+)$/))) {
        branches.set(decodeURIComponent(m[1]!), JSON.parse(raw).sha);
        return send(200, {});
      }
      if (req.method === "GET" && (m = p.match(/^\/repos\/o\/r\/contents\/(.+)$/))) {
        const head = branches.get(url.searchParams.get("ref")!);
        const content = head ? trees.get(commits.get(head)!.tree)![decodeURIComponent(m[1]!)] : undefined;
        if (content === undefined) return send(404, { message: "Not Found" });
        res.setHeader("content-type", "application/vnd.github.raw");
        return send(200, content);
      }
      send(404, { message: `No mock for ${req.method} ${p}` });
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

afterAll(() => {
  srv.close();
  void direct.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(fakeCopilot, { force: true });
});

const run = (out: string) =>
  runTaglore({
    cwd: repo,
    to: "v1.2.0",
    backfill: 10,
    copilotCommand: fakeCopilot,
    githubToken: "t",
    repository: "o/r",
    githubApiUrl: base,
    octokitOptions,
    outputDir: out,
    log: silent,
  });

describe("backfill on onboarding", () => {
  it("writes notes for earlier tags, oldest first, and builds the full history", async () => {
    const out = join(repo, "out-1");
    const r = await run(out);
    expect(r.backfilled).toEqual(["v1.0.1", "v1.1.0", "v1.1.1"]);

    // Already processed: untouched. Hand-written release: kept, Taglore's notes on top.
    expect(releases.find((x) => x.tag_name === "v1.0.0")!.body).toBe("old");
    const hotfix = releases.find((x) => x.tag_name === "v1.0.1")!;
    expect(hotfix.name).toBe("v1.0.1 hotfix");
    expect(hotfix.body.startsWith(BODY_START)).toBe(true);
    expect(hotfix.body.endsWith("Hotfix written by hand.")).toBe(true);

    // Older releases never take the Latest badge; this release does.
    expect(releases.find((x) => x.tag_name === "v1.1.1")!.make_latest).toBe("false");
    expect(releases.find((x) => x.tag_name === "v1.2.0")!.make_latest).toBe("true");
    for (const t of ["v1.0.1", "v1.1.0", "v1.1.1", "v1.2.0"]) {
      expect(releases.find((x) => x.tag_name === t)!.assets.map((a) => a.name)).toContain("taglore.json");
      // The broken asset was replaced, not kept next to the new one.
      expect(releases.find((x) => x.tag_name === t)!.assets.filter((a) => a.name === "taglore.json")).toHaveLength(1);
    }

    const history = JSON.parse(readFileSync(join(out, "history.json"), "utf8"));
    expect(history.releases.map((x: { version: string }) => x.version)).toEqual(["v1.2.0", "v1.1.1", "v1.1.0", "v1.0.1", "v1.0.0"]);
    expect(JSON.parse(readFileSync(join(out, "latest.json"), "utf8")).version).toBe("v1.2.0");
  });

  it("is safe to leave on: a second run writes nothing new", async () => {
    const r = await run(join(repo, "out-2"));
    expect(r.backfilled).toEqual([]);
    const history = JSON.parse(readFileSync(join(repo, "out-2", "history.json"), "utf8"));
    expect(history.releases).toHaveLength(5);
  });

  it("without a token, the earlier notes still land in history.json", async () => {
    const out = join(repo, "out-local");
    const saved = { t: process.env.GITHUB_TOKEN, r: process.env.GITHUB_REPOSITORY };
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_REPOSITORY;
    const r = await runTaglore({ cwd: repo, to: "v1.2.0", backfill: 2, provider: "none", publishGithubRelease: false, outputDir: out, log: silent }).finally(() => {
      if (saved.t !== undefined) process.env.GITHUB_TOKEN = saved.t;
      if (saved.r !== undefined) process.env.GITHUB_REPOSITORY = saved.r;
    });
    expect(r.backfilled).toEqual(["v1.1.0", "v1.1.1"]);
    const history = JSON.parse(readFileSync(join(out, "history.json"), "utf8"));
    expect(history.releases.map((x: { version: string }) => x.version)).toEqual(["v1.2.0", "v1.1.1", "v1.1.0"]);
  });

  it("rejects out-of-range values and explicit compares", async () => {
    await expect(runTaglore({ cwd: repo, to: "v1.2.0", backfill: 51, provider: "none", dryRun: true, log: silent })).rejects.toThrow(/Invalid backfill/);
    await expect(runTaglore({ cwd: repo, compare: "explicit", from: "v1.0.0", to: "v1.2.0", backfill: 5, provider: "none", dryRun: true, log: silent })).rejects.toThrow(/backfill needs SemVer tags/);
  });
});

describe("immutable releases and the history branch", () => {
  const reset = (immutable: boolean) => {
    releases.splice(0);
    log.splice(0);
    branches.clear();
    commits.clear();
    trees.clear();
    immutableRepo = immutable;
  };
  const gh = { githubToken: "t", repository: "o/r", githubApiUrl: base, octokitOptions, copilotCommand: "", log: silent };

  it("creates a draft, attaches the files, and only then publishes", async () => {
    reset(true);
    const r = await runTaglore({ ...gh, githubApiUrl: base, cwd: repo, to: "v1.0.0", copilotCommand: fakeCopilot, historyLimit: 5 });
    expect(r.releaseUrl).toBeTruthy();
    const i = log.indexOf("create v1.0.0 draft");
    const uploads = log.filter((l) => l.startsWith("upload v1.0.0")).map((l) => log.indexOf(l));
    const pub = log.indexOf("publish v1.0.0");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(uploads.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...uploads)).toBeLessThan(pub);
    expect(releases.find((x) => x.tag_name === "v1.0.0")!.immutable).toBe(true);
  });

  it("an existing immutable release gets its notes updated and no upload error", async () => {
    // v1.0.0 is published and immutable now: a re-run must not fail.
    const r = await runTaglore({ ...gh, githubApiUrl: base, cwd: repo, to: "v1.0.0", copilotCommand: fakeCopilot, historyLimit: 5 });
    expect(r.releaseUrl).toBeTruthy();
    expect(releases.filter((x) => x.tag_name === "v1.0.0")).toHaveLength(1);
  });

  it("finishes a draft an earlier run left behind instead of creating a second one", async () => {
    reset(false);
    releases.push({ id: 7, tag_name: "v1.0.1", name: "v1.0.1", body: `${BODY_START}\nold\n<!-- taglore:end -->`, draft: true, assets: [] });
    await runTaglore({ ...gh, githubApiUrl: base, cwd: repo, to: "v1.0.1", copilotCommand: fakeCopilot, historyLimit: 0 });
    const v = releases.filter((x) => x.tag_name === "v1.0.1");
    expect(v).toHaveLength(1);
    expect(v[0]!.draft).toBe(false);
  });

  it("keeps a draft someone else wrote as a draft", async () => {
    reset(false);
    releases.push({ id: 8, tag_name: "v1.1.0", name: "v1.1.0", body: "Written by Release Please", draft: true, assets: [] });
    await runTaglore({ ...gh, githubApiUrl: base, cwd: repo, to: "v1.1.0", copilotCommand: fakeCopilot, historyLimit: 0, releaseBody: "prepend" });
    const v = releases.find((x) => x.tag_name === "v1.1.0")!;
    expect(v.draft).toBe(true);
    expect(v.body).toContain("Written by Release Please");
    expect(v.assets.map((a) => a.name)).toContain("taglore.json");
  });

  it("history-branch: stores history.json and latest.json in a branch, without GitHub Releases", async () => {
    reset(false);
    const out = join(repo, "out-branch");
    const r = await runTaglore({ ...gh, githubApiUrl: base, cwd: repo, to: "v1.1.1", copilotCommand: fakeCopilot, historyBranch: "taglore-data", publishGithubRelease: false, backfill: 10, outputDir: out });
    expect(r.backfilled).toEqual(["v1.0.0", "v1.0.1", "v1.1.0"]);
    expect(releases).toHaveLength(0);
    const tree = trees.get(commits.get(branches.get("taglore-data")!)!.tree)!;
    const stored = JSON.parse(tree["history.json"]!);
    expect(stored.releases.map((x: { version: string }) => x.version)).toEqual(["v1.1.1", "v1.1.0", "v1.0.1", "v1.0.0"]);
    // A patch: latest.json is v1.1.0's announcement, found in this run's backfill.
    expect(JSON.parse(tree["latest.json"]!).version).toBe("v1.1.0");
    // The orphan branch's first commit has no parents.
    expect(commits.get(branches.get("taglore-data")!)!.parents).toEqual([]);

    // Next release: everything earlier comes from the branch, nothing is written again.
    const r2 = await runTaglore({ ...gh, githubApiUrl: base, cwd: repo, to: "v1.2.0", copilotCommand: fakeCopilot, historyBranch: "taglore-data", publishGithubRelease: false, backfill: 10, outputDir: out });
    expect(r2.backfilled).toEqual([]);
    expect(r2.history!.releases).toHaveLength(5);
    const head = branches.get("taglore-data")!;
    expect(commits.get(head)!.parents).toHaveLength(1);
    expect(JSON.parse(trees.get(commits.get(head)!.tree)!["latest.json"]!).version).toBe("v1.2.0");
  });
});
