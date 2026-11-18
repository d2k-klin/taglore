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
  make_latest?: string;
  assets: { id: number; name: string; content: string }[];
}

let repo: string;
let fakeCopilot: string;
let srv: http.Server;
let base: string;
const releases: Rel[] = [];
let nextId = 100;
// The mock API on 127.0.0.1 is reached directly, whatever proxy the environment configures.
const direct = new Agent();
const octokitOptions = { request: { fetch: (url: string, init: object) => undiciFetch(url, { ...init, dispatcher: direct }) } };

const json = (rel: Rel) => ({
  id: rel.id,
  tag_name: rel.tag_name,
  name: rel.name,
  body: rel.body,
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

  srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", base);
      const p = url.pathname;
      res.setHeader("content-type", "application/json");
      const send = (code: number, body: unknown) => {
        res.statusCode = code;
        res.end(typeof body === "string" ? body : JSON.stringify(body));
      };
      let m: RegExpMatchArray | null;
      if (req.method === "GET" && (m = p.match(/^\/repos\/o\/r\/releases\/tags\/(.+)$/))) {
        const rel = releases.find((r) => r.tag_name === decodeURIComponent(m![1]!));
        return rel ? send(200, json(rel)) : send(404, { message: "Not Found" });
      }
      if (req.method === "POST" && p === "/repos/o/r/releases") {
        const b = JSON.parse(raw);
        const rel: Rel = { id: nextId++, tag_name: b.tag_name, name: b.name, body: b.body, make_latest: b.make_latest, assets: [] };
        releases.push(rel);
        return send(201, json(rel));
      }
      if (req.method === "PATCH" && (m = p.match(/^\/repos\/o\/r\/releases\/(\d+)$/))) {
        const rel = releases.find((r) => r.id === Number(m![1]))!;
        const b = JSON.parse(raw);
        if (b.name !== undefined) rel.name = b.name;
        if (b.body !== undefined) rel.body = b.body;
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
        rel.assets.push({ id: nextId++, name: url.searchParams.get("name")!, content: raw });
        return send(201, {});
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
    expect(releases.find((x) => x.tag_name === "v1.1.0")!.make_latest).toBe("false");
    expect(releases.find((x) => x.tag_name === "v1.1.1")!.make_latest).toBe("false");
    expect(releases.find((x) => x.tag_name === "v1.2.0")!.make_latest).toBe("true");
    for (const t of ["v1.0.1", "v1.1.0", "v1.1.1", "v1.2.0"]) {
      expect(releases.find((x) => x.tag_name === t)!.assets.map((a) => a.name)).toContain("taglore.json");
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
