import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderEvidenceMarkdown, verifyEvidence } from "../src/evidence.js";
import { buildHistory } from "../src/history.js";
import { renderPreview } from "../src/preview.js";
import { buildPrompt, commitList } from "../src/prompt.js";
import { runTaglore } from "../src/run.js";
import { AiNotesSchema, type ReleaseNotes } from "../src/schema.js";

const commits = [
  { sha: "a42f19c0000000000000000000000000000000aa", author: "a", subject: "feat: combined search filters", body: "" },
  { sha: "c19e4a10000000000000000000000000000000bb", author: "a", subject: "fix: filter chips overflow", body: "" },
];
const notes = () =>
  AiNotesSchema.parse({
    title: "Better search",
    summary: "s",
    highlights: [
      { title: "Combine filters", description: "d", commits: ["a42f19c", "deadbee"] },
      { title: "Invented dashboard", description: "d", commits: ["1234567"] },
    ],
    fixes: [{ title: "Chips fit", commits: ["c19e4a1"] }, { title: "No evidence given" }],
  });

describe("verifyEvidence", () => {
  it("keeps only commits that exist in the range and reports unsupported statements", () => {
    const { notes: out, report } = verifyEvidence(notes(), commits, "warn");
    expect(out.highlights[0]!.commits).toEqual(["a42f19c"]); // invented hash dropped
    expect(out.highlights).toHaveLength(2); // warn keeps the statement
    expect(report.unverified.map((u) => u.title)).toEqual(["Invented dashboard", "No evidence given"]);
    expect(report.removed).toBe(false);
    expect(report.items[0]!.commits[0]!.subject).toBe("feat: combined search filters");
  });
  it("strict removes statements without a real commit", () => {
    const { notes: out, report } = verifyEvidence(notes(), commits, "strict");
    expect(out.highlights.map((h) => h.title)).toEqual(["Combine filters"]);
    expect(out.fixes.map((h) => h.title)).toEqual(["Chips fit"]);
    expect(report.removed).toBe(true);
    expect(renderEvidenceMarkdown(report)).toContain("2 statements were removed");
  });
  it("renders a review table that cannot be broken by commit subjects", () => {
    const evil = [{ ...commits[0]!, subject: "feat: x | <img src=x> `y`" }];
    const md = renderEvidenceMarkdown(verifyEvidence(notes(), evil, "warn").report);
    expect(md).not.toContain("<img");
    expect(md).toContain("⚠️ none");
  });
});

describe("prompt budget", () => {
  const many = Array.from({ length: 400 }, (_, i) => ({ sha: `${String(i).padStart(7, "0")}${"0".repeat(33)}`, author: "a", subject: `feat: change number ${i}`, body: "x".repeat(3000) }));
  const changes = { from: "v1", to: "v2", commits: many, files: Array.from({ length: 3000 }, (_, i) => ({ status: "M", path: `src/some/long/path/file-${i}.ts` })), stat: "s".repeat(50_000), diff: "d\n".repeat(60_000), diffTruncated: false };
  const base = { productName: "p", version: "v2", previousVersion: "v1", language: "English", tone: "t", audience: "a" };
  it("keeps the whole context inside the budget, however long the commit history is", () => {
    const budget = 100 * 1024;
    const prompt = buildPrompt(changes, { ...base, maxContextBytes: budget });
    expect(Buffer.byteLength(prompt)).toBeLessThan(budget + 6 * 1024); // context + fixed instructions
    expect(prompt).toContain("0000399 feat: change number 399"); // subjects survive, bodies are cut first
    expect(prompt).toContain("<<<DIFF (truncated)");
    expect(Buffer.byteLength(buildPrompt(changes, { ...base, maxContextBytes: 20 * 1024 }))).toBeLessThan(26 * 1024);
  });
  it("drops commit bodies before commits", () => {
    const text = commitList(many, 30_000);
    expect(text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(400);
    expect(text).not.toContain("xxxx");
  });
});

const rel = (version: string, announce = true): ReleaseNotes =>
  ({ schemaVersion: 1, version, previousVersion: null, releaseType: "minor", announce, date: "2026-01-01", title: `T ${version}`, summary: "s", highlights: [], improvements: [], fixes: [], breaking: [], generator: { name: "taglore", version: "1", provider: "fallback", model: null } }) as ReleaseNotes;
const log = { info: () => {}, warn: () => {} };

describe("buildHistory", () => {
  const tags = ["v1.0.0", "v1.1.0", "v1.1.1", "v1.2.0"];
  const current = { raw: "v1.2.0", major: 1, minor: 2, patch: 0, prerelease: null };
  const fake = (assets: Record<string, string>) => ({ readAsset: async (tag: string, name = "taglore.json") => assets[`${tag}/${name}`] ?? null }) as never;

  it("continues from the previous release's history asset", async () => {
    const prev = JSON.stringify({ schemaVersion: 1, releases: [rel("v1.1.1"), rel("v1.1.0"), rel("v1.0.0")] });
    const h = await buildHistory({ notes: rel("v1.2.0"), current, tags, prefix: "v", limit: 3, cwd: ".", releases: fake({ "v1.1.1/taglore-history.json": prev }), log });
    expect(h.releases.map((r) => r.version)).toEqual(["v1.2.0", "v1.1.1", "v1.1.0"]); // newest first, limited
  });
  it("collects earlier taglore.json assets on the first run", async () => {
    const h = await buildHistory({ notes: rel("v1.2.0"), current, tags, prefix: "v", limit: 20, cwd: ".", releases: fake({ "v1.1.0/taglore.json": JSON.stringify(rel("v1.1.0")), "v1.0.0/taglore.json": JSON.stringify(rel("v1.0.0")), "v1.1.1/taglore.json": "not json" }), log });
    expect(h.releases.map((r) => r.version)).toEqual(["v1.2.0", "v1.1.0", "v1.0.0"]);
  });
  it("works without GitHub", async () => {
    const h = await buildHistory({ notes: rel("v1.2.0"), current, tags, prefix: "v", limit: 20, cwd: ".", releases: null, log });
    expect(h.releases).toHaveLength(1);
  });
});

describe("renderPreview", () => {
  it("escapes everything and flags unsupported statements", () => {
    const n = { ...rel("v1.2.0"), title: "<script>alert(1)</script>", highlights: [{ title: "A <b>", description: "", commits: [] }] } as ReleaseNotes;
    const { report } = verifyEvidence(AiNotesSchema.parse(n), commits, "warn");
    const html = renderPreview(n, report, { repositoryUrl: "https://github.com/a/b" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("No supporting commit");
  });
});

describe("runTaglore with evidence, preview and history", () => {
  let repo: string;
  let copilot: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "taglore-ev-"));
    const sh = (a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
    const commit = (f: string, m: string) => {
      writeFileSync(join(repo, f), m);
      sh(["add", "."]);
      sh(["commit", "-qm", m]);
    };
    sh(["init", "-q", "-b", "main"]);
    sh(["config", "user.email", "t@example.com"]);
    sh(["config", "user.name", "t"]);
    commit("a", "feat: first");
    sh(["tag", "v1.0.0"]);
    commit("b", "feat: dark mode");
    sh(["tag", "v1.1.0"]);
    // Stand-in for Copilot: cites the real "dark mode" commit for one statement and invents another.
    copilot = join(repo, "..", `fake-copilot-ev-${Date.now()}.js`);
    writeFileSync(
      copilot,
      `#!/usr/bin/env node
const p = process.argv[process.argv.indexOf("-p") + 1] || "";
const sha = (/- ([0-9a-f]{7}) feat: dark mode/.exec(p) || [])[1];
console.log(JSON.stringify({ title: "Dark mode", summary: "Easier on the eyes.", highlights: [
  { title: "Dark mode", description: "Switch themes.", commits: [sha] },
  { title: "Offline sync", description: "Made up.", commits: ["fffffff"] }] }));
`,
    );
    chmodSync(copilot, 0o755);
  });
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(copilot, { force: true });
  });
  const opts = () => ({ cwd: repo, to: "v1.1.0", copilotCommand: copilot, publishGithubRelease: false, log });

  it("warn: keeps the invented statement but reports it; writes the preview even on a dry run", async () => {
    const preview = join(repo, "..", `preview-${Date.now()}.html`);
    const r = await runTaglore({ ...opts(), dryRun: true, previewFile: preview });
    expect(r.evidence.unverified.map((u) => u.title)).toEqual(["Offline sync"]);
    expect(r.notes.highlights).toHaveLength(2);
    expect(r.notes.highlights[0]!.commits).toHaveLength(1);
    expect(r.markdown).toMatch(/- \*\*Dark mode\*\*: Switch themes\. \([0-9a-f]{7}\)/);
    expect(readFileSync(preview, "utf8")).toContain("1 statement(s) have no supporting commit");
    rmSync(preview);
  });

  it("strict: the invented statement never reaches users; history.json is written", async () => {
    const out = join(repo, "..", `out-ev-${Date.now()}`);
    const r = await runTaglore({ ...opts(), evidence: "strict", outputDir: out });
    expect(r.notes.highlights.map((h) => h.title)).toEqual(["Dark mode"]);
    expect(JSON.parse(readFileSync(join(out, "latest.json"), "utf8")).highlights).toHaveLength(1);
    const history = JSON.parse(readFileSync(join(out, "history.json"), "utf8"));
    expect(history.releases.map((x: ReleaseNotes) => x.version)).toEqual(["v1.1.0"]);
    // Next release continues from the local file.
    const r2 = await runTaglore({ cwd: repo, to: "v1.0.0", provider: "none", publishGithubRelease: false, dryRun: true, historyFile: join(out, "history.json"), log });
    expect(r2.history?.releases.map((x) => x.version)).toEqual(["v1.0.0", "v1.1.0"]);
    const off = await runTaglore({ ...opts(), dryRun: true, historyLimit: 0 });
    expect(off.history).toBeNull();
    expect(existsSync(join(out, "preview.html"))).toBe(false);
    rmSync(out, { recursive: true, force: true });
  });

  it("commit-based notes are fully evidenced", async () => {
    const r = await runTaglore({ ...opts(), provider: "none", dryRun: true });
    expect(r.evidence.unverified).toEqual([]);
    expect(r.notes.highlights[0]!.commits).toHaveLength(1);
  });
});
