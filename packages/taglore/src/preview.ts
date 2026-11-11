import type { EvidenceReport } from "./evidence.js";
import type { NoteItem, ReleaseNotes } from "./schema.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function section(title: string, items: NoteItem[], kind: string): string {
  if (!items.length) return "";
  return `<h3 class="s ${kind}">${esc(title)}</h3><ul>${items
    .map((i) => `<li><strong>${esc(i.title)}</strong>${i.description ? ` <span>${esc(i.description)}</span>` : ""}</li>`)
    .join("")}</ul>`;
}

const LABEL = { breaking: "Breaking", highlights: "Highlight", improvements: "Improvement", fixes: "Fix" } as const;

/**
 * A self-contained page for reviewers: what users will see in the What's New dialog,
 * and which commits stand behind every statement. It lists commit subjects, so keep it
 * out of the files you ship to users.
 */
export function renderPreview(n: ReleaseNotes, evidence: EvidenceReport, opts: { repositoryUrl?: string | null } = {}): string {
  const commitLink = (sha: string) => (opts.repositoryUrl ? `<a href="${esc(opts.repositoryUrl)}/commit/${esc(sha)}"><code>${esc(sha)}</code></a>` : `<code>${esc(sha)}</code>`);
  const rows = evidence.items
    .map(
      (i) =>
        `<tr class="${i.commits.length ? "" : "warn"}"><td>${LABEL[i.section]}</td><td><strong>${esc(i.title)}</strong>${i.description ? `<br><span>${esc(i.description)}</span>` : ""}</td><td>${
          i.commits.length ? i.commits.map((c) => `${commitLink(c.sha)} ${esc(c.subject)}`).join("<br>") : "No supporting commit"
        }</td></tr>`,
    )
    .join("");
  const banner = evidence.unverified.length
    ? evidence.removed
      ? `<p class="banner warn">${evidence.unverified.length} statement(s) were removed because no commit in this release supports them: ${esc(evidence.unverified.map((u) => u.title).join("; "))}</p>`
      : `<p class="banner warn">${evidence.unverified.length} statement(s) have no supporting commit. Check them before publishing.</p>`
    : `<p class="banner ok">Every statement is backed by at least one commit in this release.</p>`;
  const ai = n.generator.provider === "fallback" ? "commit messages (no AI)" : `${esc(n.generator.provider)}${n.generator.model ? ` (${esc(n.generator.model)})` : ""}`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Preview: ${esc(n.version)}</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f3f4f6;color:#111827}
main{max-width:1000px;margin:0 auto;padding:32px 20px}
h1{font-size:20px;margin:0 0 4px}.meta{color:#6b7280;margin:0 0 24px}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;margin:32px 0 12px}
.dialog{background:#fff;border-radius:14px;box-shadow:0 12px 40px rgb(0 0 0/.15);max-width:560px;padding:24px}
.dialog .eyebrow{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#4f46e5;font-weight:600;margin:0 0 4px}
.dialog h2{all:unset;display:block;font-size:20px;font-weight:700;margin:0 0 8px}
.dialog p{margin:0;color:#6b7280}.dialog h3{font-size:14px;margin:16px 0 8px}.dialog h3.breaking{color:#b45309}
.dialog ul{margin:0;padding-left:18px;display:grid;gap:6px}.dialog li span{color:#6b7280}
.dialog .btn{display:inline-block;margin-top:20px;background:#4f46e5;color:#fff;border-radius:999px;padding:8px 18px;font-weight:600}
table{border-collapse:collapse;width:100%;background:#fff;border-radius:10px;overflow:hidden}
th,td{text-align:left;vertical-align:top;padding:10px 12px;border-bottom:1px solid #e5e7eb}th{background:#f9fafb;font-size:13px}
td span{color:#6b7280}tr.warn td{background:#fffbeb}code{font-size:13px}
.banner{padding:10px 14px;border-radius:8px;margin:0 0 12px}.banner.ok{background:#ecfdf5;color:#065f46}.banner.warn{background:#fffbeb;color:#92400e}
</style></head><body><main>
<h1>Release preview: ${esc(n.version)}</h1>
<p class="meta">${n.previousVersion ? `Compared with ${esc(n.previousVersion)}` : "First release"} · ${esc(n.releaseType)} release · ${n.announce ? "will be announced in the app" : "no new in-app announcement"} · written from ${ai}</p>
<h2>What users will see</h2>
<div class="dialog">
<p class="eyebrow">What's new · ${esc(n.version)}</p>
<h2>${esc(n.title)}</h2><p>${esc(n.summary)}</p>
${section("Action needed", n.breaking, "breaking")}${section("Highlights", n.highlights, "")}${section("Improvements", n.improvements, "")}${section("Fixes", n.fixes, "")}
<span class="btn">Got it</span>
</div>
<h2>Evidence</h2>
${banner}
<table><thead><tr><th></th><th>Statement</th><th>Supporting commits</th></tr></thead><tbody>${rows || '<tr><td colspan="3">No statements.</td></tr>'}</tbody></table>
</main></body></html>
`;
}
