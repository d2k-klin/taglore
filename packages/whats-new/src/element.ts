import "./changelog-element.js";
import { DEFAULT_STORAGE_KEY, DEFAULT_URL, loadNotes, shouldShow, writeSeen } from "./core.js";
import { CSS } from "./styles.js";
import type { NoteItem, ReleaseNotes } from "./types.js";

/**
 * <taglore-whats-new> — framework-free What's New dialog for any web frontend
 * (Vue, Angular, Svelte, Django/Rails/Laravel templates, plain HTML).
 *
 *   <script type="module" src="/release-notes/taglore-whats-new.js"></script>
 *   <taglore-whats-new src="/release-notes/latest.json" storage-key="myapp:whats-new"></taglore-whats-new>
 *
 * Attributes: src, storage-key, show-on-first-visit, no-auto-open, compact, unstyled,
 * label-heading, label-highlights, label-improvements, label-fixes, label-breaking, label-close.
 * With no-auto-open the dialog never opens by itself: the element gets an `unseen` attribute
 * and fires "taglore:unseen" instead, so the app can show a badge and call show() from a menu.
 * Methods: show(), dismiss(). Property: unseen.
 * Events: "taglore:unseen", "taglore:open", "taglore:dismiss" (detail = notes).
 * All text is set with textContent, never as HTML.
 */
export class TagloreWhatsNewElement extends HTMLElement {
  private notes: ReleaseNotes | null = null;
  private dialog: HTMLDialogElement | null = null;
  private ctrl: AbortController | null = null;

  static get observedAttributes() {
    return ["src"];
  }

  connectedCallback() {
    if (!this.hasAttribute("unstyled")) injectStyles();
    void this.load();
  }

  disconnectedCallback() {
    this.ctrl?.abort();
  }

  attributeChangedCallback(_name: string, oldValue: string | null, newValue: string | null) {
    if (this.isConnected && oldValue !== null && oldValue !== newValue) void this.load();
  }

  private get storageKey() {
    return this.getAttribute("storage-key") ?? DEFAULT_STORAGE_KEY;
  }

  private label(name: string, fallback: string) {
    return this.getAttribute(`label-${name}`) ?? fallback;
  }

  private async load() {
    this.ctrl?.abort();
    this.ctrl = new AbortController();
    try {
      const notes = await loadNotes(this.getAttribute("src") ?? DEFAULT_URL, this.ctrl.signal);
      if (!notes) {
        this.removeAttribute("unseen");
        return;
      }
      this.notes = notes;
      this.render();
      const unseen = shouldShow(notes, this.storageKey, this.hasAttribute("show-on-first-visit"));
      // Reset first: a new src may point at notes that are already seen.
      this.toggleAttribute("unseen", unseen);
      if (unseen) {
        this.dispatchEvent(new CustomEvent("taglore:unseen", { detail: notes, bubbles: true }));
        if (!this.hasAttribute("no-auto-open")) this.show();
      }
    } catch (e) {
      if (!this.ctrl.signal.aborted) console.warn("[taglore-whats-new]", e);
    }
  }

  /** True when there is an announcement the user has not dismissed yet. */
  get unseen(): boolean {
    return this.hasAttribute("unseen");
  }

  /** Opens the current announcement (e.g. from a "What's new" menu item). */
  show() {
    if (!this.dialog || !this.notes) return;
    if (!this.dialog.open) this.dialog.showModal?.();
    // Start at the top, also when the dialog is reopened after scrolling (and for unstyled use).
    this.dialog.scrollTop = 0;
    const body = this.dialog.querySelector<HTMLElement>(".taglore-wn__body");
    if (body) body.scrollTop = 0;
    // Browsers would focus the scrolling body (a focusable scroller). The close button is the
    // intended first stop, and it is always in view now that only the body scrolls.
    this.dialog.querySelector<HTMLElement>(".taglore-wn__close")?.focus({ preventScroll: true });
    this.dispatchEvent(new CustomEvent("taglore:open", { detail: this.notes, bubbles: true }));
  }

  /** Marks the announcement as seen and closes it. */
  dismiss() {
    if (!this.notes) return;
    writeSeen(this.storageKey, this.notes.version);
    this.removeAttribute("unseen");
    if (this.dialog?.open) this.dialog.close();
    this.dispatchEvent(new CustomEvent("taglore:dismiss", { detail: this.notes, bubbles: true }));
  }

  private render() {
    const n = this.notes!;
    const compact = this.hasAttribute("compact");
    const d = el("dialog", "taglore-wn");
    d.setAttribute("aria-labelledby", "taglore-wn-title");
    d.addEventListener("cancel", (e) => {
      e.preventDefault();
      this.dismiss();
    });

    const header = el("header", "taglore-wn__header");
    header.append(
      el("p", "taglore-wn__eyebrow", `${this.label("heading", "What's new")} · ${n.version}`),
      Object.assign(el("h2", "taglore-wn__title", n.title), { id: "taglore-wn-title" }),
      el("p", "taglore-wn__summary", n.summary),
    );

    const body = el("div", "taglore-wn__body");
    section(body, "breaking", this.label("breaking", "Action needed"), n.breaking);
    section(body, "highlights", this.label("highlights", "Highlights"), n.highlights);
    if (!compact) section(body, "improvements", this.label("improvements", "Improvements"), n.improvements);
    if (!compact) section(body, "fixes", this.label("fixes", "Fixes"), n.fixes);

    const footer = el("footer", "taglore-wn__footer");
    const btn = el("button", "taglore-wn__close", this.label("close", "Got it"));
    btn.type = "button";
    btn.addEventListener("click", () => this.dismiss());
    footer.append(btn);

    d.append(header, body, footer);
    this.replaceChildren(d);
    this.dialog = d;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function section(parent: HTMLElement, kind: string, title: string, items: NoteItem[]) {
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

function injectStyles() {
  if (document.getElementById("taglore-wn-styles")) return;
  const style = document.createElement("style");
  style.id = "taglore-wn-styles";
  style.textContent = CSS;
  document.head.append(style);
}

if (typeof customElements !== "undefined" && !customElements.get("taglore-whats-new")) {
  customElements.define("taglore-whats-new", TagloreWhatsNewElement);
}

export { TagloreChangelogElement } from "./changelog-element.js";
