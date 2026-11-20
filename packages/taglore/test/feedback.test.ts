import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { collectChanges, filePriority, globToRegExp } from "../src/collect.js";
import { buildPromptWithReport } from "../src/prompt.js";
import { compileTerms, styleIssues, trimToLimits } from "../src/repair.js";
import { runTaglore } from "../src/run.js";

const silent = { info: () => {}, warn: () => {} };
const good = (title = "Faster search") =>
  JSON.stringify({ title, summary: "Search is quicker.", highlights: [{ title: "Quicker search", description: "Results show up sooner.", commits: [] }], improvements: [], fixes: [], breaking: [] });

let repo: string;
let work: string;
let fake: string;
let shas: Record<string, string>;

/** Fake Copilot CLI: records every prompt, answers from answers/<n>.txt (the last one repeats). */
function answers(...list: string[]) {
  const dir = join(work, "answers");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  list.forEach((a, i) => writeFileSync(join(dir, `${i + 1}.txt`), a));
  rmSync(join(work, "prompts"), { recursive: true, force: true });
  mkdirSync(join(work, "prompts"));
}
const prompts = () => {
  const dir = join(work, "prompts");
  const out: string[] = [];
  for (let i = 1; existsSync(join(dir, `${i}.txt`)); i++) out.push(readFileSync(join(dir, `${i}.txt`), "utf8"));
  return out;
};

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "taglore-feedback-"));
  repo = join(work, "repo");
  mkdirSync(repo);
  const sh = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  sh(["init", "-q", "-b", "main"]);
  sh(["config", "user.email", "t@example.com"]);
  sh(["config", "user.name", "t"]);
  shas = {};
  const commit = (files: Record<string, string>, msg: string) => {
    for (const [f, c] of Object.entries(files)) {
      mkdirSync(join(repo, f, ".."), { recursive: true });
      writeFileSync(join(repo, f), c);
    }
    sh(["add", "."]);
    sh(["commit", "-qm", msg]);
    shas[msg] = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
  };
  commit({ "src/app.ts": "export const a = 1;\n" }, "feat: first");
  sh(["tag", "v1.0.0"]);
  commit({ "src/search.ts": "export const search = () => 1;\n".repeat(50), "test/search.test.ts": "it('x', () => {});\n".repeat(400), ".github/workflows/ci.yml": "on: push\n".repeat(300) }, "feat: faster search");
  sh(["tag", "v1.1.0"]);
  commit({ "src/fix.ts": "export const fix = 1;\n" }, "fix: login");
  sh(["tag", "v1.1.1"]);
  commit({ "src/next.ts": "export const next = 1;\n" }, "feat: upcoming export");

  fake = join(work, "copilot.mjs");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = ${JSON.stringify(work)};
const i = process.argv.indexOf("-p");
const prompt = i > -1 ? process.argv[i + 1] : readFileSync(0, "utf8");
let n = 1;
while (existsSync(join(dir, "prompts", n + ".txt"))) n++;
writeFileSync(join(dir, "prompts", n + ".txt"), prompt);
let a = n;
while (a > 1 && !existsSync(join(dir, "answers", a + ".txt"))) a--;
process.stdout.write(readFileSync(join(dir, "answers", a + ".txt"), "utf8"));
`,
  );
  chmodSync(fake, 0o755);
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

const base = { publishGithubRelease: false, log: silent } as const;
let saved: { t?: string; r?: string };
beforeEach(() => {
  saved = { t: process.env.GITHUB_TOKEN, r: process.env.GITHUB_REPOSITORY };
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_REPOSITORY;
  return () => {
    if (saved.t !== undefined) process.env.GITHUB_TOKEN = saved.t;
    if (saved.r !== undefined) process.env.GITHUB_REPOSITORY = saved.r;
  };
});

describe("per-release facts", () => {
  it("fills placeholders and passes the facts file and command output to the AI", async () => {
    mkdirSync(join(repo, "facts"), { recursive: true });
    writeFileSync(join(repo, "facts", "v1.1.0.md"), "Search v2 is switched on in production.");
    answers(good());
    const r = await runTaglore({
      ...base,
      cwd: repo,
      to: "v1.1.0",
      copilotCommand: fake,
      instructions: "Say {version} came after {from}.",
      factsFile: "facts/{version}.md",
      factsCommand: 'echo "flags for $TAGLORE_VERSION since $TAGLORE_FROM"',
    });
    expect(r.provider).toBe("copilot");
    const [p] = prompts();
    expect(p).toContain("Say v1.1.0 came after v1.0.0.");
    expect(p).toContain("Search v2 is switched on in production.");
    expect(p).toContain("flags for v1.1.0 since v1.0.0");
    expect(p).toContain("RELEASE FACTS FROM THE MAINTAINER");
  });

  it("a missing facts file means no facts; a failing command stops the run", async () => {
    answers(good());
    await runTaglore({ ...base, cwd: repo, to: "v1.1.1", copilotCommand: fake, factsFile: "facts/{version}.md" });
    expect(prompts()[0]).not.toContain("RELEASE FACTS");
    await expect(runTaglore({ ...base, cwd: repo, to: "v1.1.1", copilotCommand: fake, factsCommand: "exit 3" })).rejects.toThrow(/facts-command exited with 3/);
  });
});

describe("self-repairing output", () => {
  it("shortens an answer whose only problem is length, without a second request", async () => {
    answers(good("A".repeat(60) + " " + "B".repeat(60)));
    const r = await runTaglore({ ...base, cwd: repo, to: "v1.1.0", copilotCommand: fake });
    expect(prompts()).toHaveLength(1);
    expect(r.notes.title.length).toBeLessThanOrEqual(100);
    expect(r.notes.title.endsWith("…")).toBe(true);
  });

  it("asks again with the reasons when the answer is invalid", async () => {
    answers(JSON.stringify({ title: "No summary" }), good());
    const r = await runTaglore({ ...base, cwd: repo, to: "v1.1.0", copilotCommand: fake });
    const ps = prompts();
    expect(ps).toHaveLength(2);
    expect(ps[1]).toContain("It was rejected for these reasons:");
    expect(ps[1]).toContain("summary");
    expect(r.provider).toBe("copilot");
    expect(r.notes.title).toBe("Faster search");
  });

  it("retries on forbidden terms and commit hashes, then passes", async () => {
    const hash = shas["feat: faster search"]!.slice(0, 7);
    answers(good(`Faster search on staging (${hash})`), good());
    const r = await runTaglore({ ...base, cwd: repo, to: "v1.1.0", copilotCommand: fake, forbiddenTerms: ["staging", "/prod-[a-z]+/i"] });
    const ps = prompts();
    expect(ps).toHaveLength(2);
    expect(ps[1]).toContain('forbidden term "staging"');
    expect(ps[1]).toContain(`commit hash "${hash}"`);
    expect(r.styleIssues).toEqual([]);
  });

  it("style-check strict fails when the retry still breaks a rule; warn reports it", async () => {
    answers(good("Faster search on staging"));
    await expect(
      runTaglore({ ...base, cwd: repo, to: "v1.1.0", copilotCommand: fake, forbiddenTerms: ["staging"], styleCheck: "strict" }),
    ).rejects.toThrow(/Style check failed/);
    answers(good("Faster search on staging"));
    const r = await runTaglore({ ...base, cwd: repo, to: "v1.1.0", copilotCommand: fake, forbiddenTerms: ["staging"] });
    expect(r.styleIssues[0]).toContain('forbidden term "staging"');
  });

  it("unit: trimming, term matching", () => {
    const t = trimToLimits({ title: "word ".repeat(40), summary: "s", highlights: Array.from({ length: 12 }, () => ({ title: "x" })) }) as { title: string; highlights: unknown[] };
    expect(t.title.length).toBeLessThanOrEqual(100);
    expect(t.highlights).toHaveLength(8);
    const terms = compileTerms(["dev", "/eu-(west|central)-\\d/"]);
    const notes = { title: "Developer tools", summary: "Now in eu-west-1.", highlights: [], improvements: [], fixes: [], breaking: [] };
    // "dev" is a whole word: "Developer" doesn't match.
    expect(styleIssues(notes, [], terms)).toEqual(['summary: contains the forbidden term "/eu-(west|central)-\\d/"']);
  });
});

describe("big releases", () => {
  it("puts user-facing code first and reports what was left out", async () => {
    const changes = await collectChanges({ from: "v1.0.0", to: "v1.1.0", cwd: repo, excludes: [], maxDiffBytes: 8 * 1024 });
    expect(changes.fileDiffs!.map((d) => d.path)).toEqual(["src/search.ts", ".github/workflows/ci.yml", "test/search.test.ts"]);
    const { context } = buildPromptWithReport(changes, {
      productName: "x",
      version: "v1.1.0",
      previousVersion: "v1.0.0",
      language: "English",
      tone: "t",
      audience: "a",
      maxContextBytes: 6 * 1024,
    });
    expect(context.truncated).toBe(true);
    expect(context.files.diffFull).toBeGreaterThanOrEqual(1);
    expect([...context.files.diffPartial, ...context.files.diffOmitted]).toContain("test/search.test.ts");
    expect(context.files.diffOmitted).not.toContain("src/search.ts");
  });

  it("focus-paths go first", async () => {
    const changes = await collectChanges({ from: "v1.0.0", to: "v1.1.0", cwd: repo, excludes: [], maxDiffBytes: 64 * 1024, focusPaths: ["test/**"] });
    expect(changes.fileDiffs![0]!.path).toBe("test/search.test.ts");
    expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/c.ts")).toBe(true);
    expect(globToRegExp("apps/web").test("apps/web/page.tsx")).toBe(true);
    expect(filePriority("docs/guide.md", [])).toBe(2);
    expect(filePriority("src/components/Button.tsx", [])).toBe(1);
  });
});

describe("unreleased", () => {
  it("writes an Unreleased entry from the last tag to HEAD, on top of the history", async () => {
    answers(good("Export is coming"));
    const out = join(work, "out-unreleased");
    const r = await runTaglore({ ...base, cwd: repo, unreleased: true, copilotCommand: fake, outputDir: out });
    expect(r.version).toBe("Unreleased");
    expect(r.previousVersion).toBe("v1.1.1");
    expect(r.releaseType).toBe("unreleased");
    expect(r.announce).toBe(false);
    expect(r.notes.title).toBe("Export is coming");
    const history = JSON.parse(readFileSync(join(out, "history.json"), "utf8"));
    expect(history.releases[0].version).toBe("Unreleased");
    expect(prompts()[0]).toContain("from v1.1.1 to Unreleased");
  });

  it("takes a custom label", async () => {
    answers(good());
    const r = await runTaglore({ ...base, cwd: repo, unreleased: true, unreleasedLabel: "Upcoming", copilotCommand: fake, dryRun: true });
    expect(r.notes.version).toBe("Upcoming");
  });
});

describe("history file as the store", () => {
  it("backfill skips tags already in the history file, and patches find their announcement in it", async () => {
    const first = await runTaglore({ ...base, cwd: repo, to: "v1.1.0", provider: "none", dryRun: true });
    const file = join(work, "history.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, releases: [first.notes] }));
    answers(good());
    const out = join(work, "out-history");
    const r = await runTaglore({ ...base, cwd: repo, to: "v1.1.1", backfill: 10, historyFile: file, copilotCommand: fake, outputDir: out });
    // v1.1.0 is in the file, so only v1.0.0 is written.
    expect(r.backfilled).toEqual(["v1.0.0"]);
    // No token: the announcement comes from the file, not from GitHub.
    expect(JSON.parse(readFileSync(join(out, "latest.json"), "utf8")).version).toBe("v1.1.0");
    const history = JSON.parse(readFileSync(join(out, "history.json"), "utf8"));
    expect(history.releases.map((x: { version: string }) => x.version)).toEqual(["v1.1.1", "v1.1.0", "v1.0.0"]);
  });

  it("a history file that doesn't exist yet starts a new history", async () => {
    const r = await runTaglore({ ...base, cwd: repo, to: "v1.1.1", provider: "none", historyFile: join(work, "nope.json"), dryRun: true });
    expect(r.history?.releases.map((x) => x.version)).toEqual(["v1.1.1"]);
  });
});
