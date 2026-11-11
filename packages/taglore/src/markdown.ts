import type { Commit } from "./collect.js";
import type { NoteItem, ReleaseNotes } from "./schema.js";

function section(title: string, items: NoteItem[]): string {
  if (!items.length) return "";
  const lines = items.map((i) => {
    const refs = i.commits.length ? ` (${i.commits.join(", ")})` : "";
    return (i.description ? `- **${i.title}**: ${i.description}` : `- ${i.title}`) + refs;
  });
  return `### ${title}\n\n${lines.join("\n")}\n\n`;
}

export function renderMarkdown(
  n: ReleaseNotes,
  opts: { commits: Commit[]; compareUrl?: string | null; includeCommits?: boolean; securitySection?: string },
): string {
  let md = `## ${n.title}\n\n${n.summary}\n\n`;
  md += section("⚠️ Breaking changes", n.breaking);
  md += section("✨ Highlights", n.highlights);
  md += section("🚀 Improvements", n.improvements);
  md += section("🐛 Fixes", n.fixes);
  if (opts.securitySection) md += opts.securitySection;

  if (opts.includeCommits !== false && opts.commits.length) {
    const list = opts.commits
      .slice(0, 200)
      .map((c) => `- ${c.subject.replace(/[<>]/g, "")} (${c.sha.slice(0, 7)})`)
      .join("\n");
    md += `<details>\n<summary>${opts.commits.length} commit${opts.commits.length > 1 ? "s" : ""}</summary>\n\n${list}\n\n</details>\n\n`;
  }
  if (opts.compareUrl) md += `**Full changelog:** ${opts.compareUrl}\n\n`;
  const ai = n.generator.provider === "fallback" ? "generated from commit messages" : `written with AI (${n.generator.provider})`;
  md += `<sub>Release notes ${ai} by [Taglore](https://github.com/d2k-klin/taglore).</sub>\n`;
  return md;
}
