import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** What a placeholder can refer to: {version}, {from}, {to}, {previousVersion}, {releaseType}. */
export interface ReleaseVars {
  version: string;
  from: string | null;
  to: string;
  releaseType: string;
}

const MAX_FACTS_BYTES = 32 * 1024;

/** Replaces {version}, {from}, {previousVersion}, {to} and {releaseType}. Unknown braces stay as they are. */
export function fillPlaceholders(text: string, v: ReleaseVars): string {
  const map: Record<string, string> = {
    version: v.version,
    from: v.from ?? "",
    previousVersion: v.from ?? "",
    to: v.to,
    releaseType: v.releaseType,
  };
  return text.replace(/\{(version|from|previousVersion|to|releaseType)\}/g, (_, k: string) => map[k] ?? "");
}

function cap(text: string): string {
  const t = text.trim();
  if (Buffer.byteLength(t) <= MAX_FACTS_BYTES) return t;
  return Buffer.from(t).subarray(0, MAX_FACTS_BYTES).toString("utf8") + "\n[... facts truncated ...]";
}

/**
 * Per-release facts for the AI, from a file path with placeholders (missing file = no facts)
 * and/or a command that gets the release in TAGLORE_* environment variables.
 */
export async function loadFacts(
  o: { factsFile?: string; factsCommand?: string; cwd: string },
  v: ReleaseVars,
  log: { info(m: string): void },
): Promise<string | null> {
  const parts: string[] = [];
  if (o.factsFile) {
    const path = fillPlaceholders(o.factsFile, v);
    try {
      const text = await readFile(resolve(o.cwd, path), "utf8");
      if (text.trim()) {
        parts.push(text);
        log.info(`Facts for ${v.version} from ${path}`);
      }
    } catch {
      log.info(`No facts file for ${v.version} (${path}).`);
    }
  }
  if (o.factsCommand) {
    const out = await runFactsCommand(o.factsCommand, v, o.cwd);
    if (out.trim()) {
      parts.push(out);
      log.info(`Facts for ${v.version} from facts-command`);
    }
  }
  return parts.length ? cap(parts.join("\n\n")) : null;
}

/** Runs the maintainer's command through the shell. A failing command stops the run: missing facts would mean wrong notes. */
export function runFactsCommand(command: string, v: ReleaseVars, cwd: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: {
        ...process.env,
        TAGLORE_VERSION: v.version,
        TAGLORE_FROM: v.from ?? "",
        TAGLORE_TO: v.to,
        TAGLORE_RELEASE_TYPE: v.releaseType,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`facts-command timed out after ${timeoutMs / 1000}s.`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      if (Buffer.byteLength(out) < MAX_FACTS_BYTES * 2) out += d;
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`facts-command could not start: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(out);
      else reject(new Error(`facts-command exited with ${code} for ${v.version}: ${err.trim().slice(0, 500)}`));
    });
  });
}
