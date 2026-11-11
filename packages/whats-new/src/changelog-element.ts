import { DEFAULT_HISTORY_URL, filterReleases, formatDate, loadHistory } from "./core.js";
import { CSS } from "./styles.js";
import type { NoteItem, ReleaseNotes } from "./types.js";

/**
 * <taglore-changelog> — a searchable release history for any web frontend.
 *
 *   <taglore-changelog src="/release-notes/history.json"></taglore-changelog>
 *
 * Attributes: src, no-search, announced-only (hide patch releases), locale, unstyled,
 * label-search, label-empty, label-highlights, label-improvements, label-fixes, label-breaking.
 * All text is set with textContent, never as HTML.
 */
export class TagloreChangelogElement extends HTMLElement {
  private releases: ReleaseNotes[] = [];
  private list: HTMLElement | null = null;
  private ctrl: AbortController | null = null;

  static get observedAttributes() {
    return ["src"];
  }

  connectedCallback() {
    if (!this.hasAttribute("unstyled") && !document.getElementById("taglore-wn-styles")) {
      const style = document.createElement("style");
      style.id = "taglore-wn-styles";
      style.textContent = CSS;
      document.head.append(style);
    }
    void this.load();
  }

  disconnectedCallback() {
    this.ctrl?.abort();
  }

  attributeChangedCallback(_n: string, oldValue: string | null, newValue: string | null) {
    if (this.isConnected && oldValue !== null && oldValue !== newValue) void this.load();
  }

  private label(name: string, fallback: string) {
    return this.getAttribute(`label-${name}`) ?? fallback;
  }

  private async load() {
    this.ctrl?.abort();
    this.ctrl = new AbortController();
    try {
      const all = await loadHistory(this.getAttribute("src") ?? DEFAULT_HISTORY_URL, this.ctrl.signal);
      this.releases = this.hasAttribute("announced-only") ? all.filter((r) => r.announce) : all;
      this.render();
    } catch (e) {
      if (!this.ctrl.signal.aborted) console.warn("[taglore-changelog]", e);
    }
  }

  private render() {
    const root = el("div", "taglore-cl");
    this.list = el("div", "taglore-cl__list");
    if (!this.hasAttribute("no-search")) {
      const input = el("input", "taglore-cl__search");
      input.type = "search";
      input.placeholder = this.label("search", "Search releases");
      input.setAttribute("aria-label", input.placeholder);
      input.addEventListener("input", () => this.renderList(input.value));
      root.append(input);
    }
    root.append(this.list);
    this.replaceChildren(root);
    this.renderList("");
  }

  private renderList(query: string) {
    if (!this.list) return;
    const shown = filterReleases(this.releases, query);
    const locale = this.getAttribute("locale") ?? undefined;
    const nodes = shown.map((r) => {
      const art = el("article", `taglore-cl__release taglore-cl__release--${r.releaseType}`);
      const meta = el("p", "taglore-cl__meta");
      meta.append(el("span", "taglore-cl__version", r.version), el("time", "taglore-cl__date", formatDate(r.date, locale)));
      art.append(meta, el("h2", "taglore-cl__title", r.title), el("p", "taglore-cl__summary", r.summary));
      section(art, "breaking", this.label("breaking", "Action needed"), r.breaking);
      section(art, "highlights", this.label("highlights", "Highlights"), r.highlights);
      section(art, "improvements", this.label("improvements", "Improvements"), r.improvements);
      section(art, "fixes", this.label("fixes", "Fixes"), r.fixes);
      return art;
    });
    this.list.replaceChildren(...(nodes.length ? nodes : [el("p", "taglore-cl__empty", this.label("empty", "No releases found."))]));
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function section(parent: HTMLElement, kind: string, title: string, items: NoteItem[] = []) {
  if (!items.length) return;
  const s = el("section", `taglore-wn__section taglore-wn__section--${kind}`);
  const ul = el("ul", "taglore-wn__list");
  for (const i of items) {
    const li = el("li", "taglore-wn__item");
    li.append(el("strong", "taglore-wn__item-title", i.title));
    if (i.description) li.append(el("span", "taglore-wn__item-desc", ` ${i.description}`));
    ul.append(li);
  }
  s.append(el("h3", "taglore-wn__section-title", title), ul);
  parent.append(s);
}

if (typeof customElements !== "undefined" && !customElements.get("taglore-changelog")) {
  customElements.define("taglore-changelog", TagloreChangelogElement);
}
