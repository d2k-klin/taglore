"use client";

import { useEffect, useMemo, useState } from "react";
import { DEFAULT_HISTORY_URL, filterReleases, formatDate, loadHistory } from "./core.js";
import type { NoteItem, ReleaseNotes } from "./types.js";

export interface ChangelogLabels {
  search: string;
  empty: string;
  highlights: string;
  improvements: string;
  fixes: string;
  breaking: string;
}

const DEFAULT_LABELS: ChangelogLabels = {
  search: "Search releases",
  empty: "No releases found.",
  highlights: "Highlights",
  improvements: "Improvements",
  fixes: "Fixes",
  breaking: "Action needed",
};

export interface ChangelogProps {
  /** Where history.json is served. Default: /release-notes/history.json */
  url?: string;
  /** Pass releases directly (e.g. imported at build time) instead of fetching. */
  data?: ReleaseNotes[];
  /** Hide the search box. */
  noSearch?: boolean;
  /** Show only releases that were announced (hides patch releases). */
  announcedOnly?: boolean;
  /** Locale for dates. Default: the browser's. */
  locale?: string;
  labels?: Partial<ChangelogLabels>;
  className?: string;
}

function Section({ title, items, kind }: { title: string; items: NoteItem[]; kind: string }) {
  if (!items?.length) return null;
  return (
    <section className={`taglore-wn__section taglore-wn__section--${kind}`}>
      <h3 className="taglore-wn__section-title">{title}</h3>
      <ul className="taglore-wn__list">
        {items.map((i, idx) => (
          <li key={idx} className="taglore-wn__item">
            <strong className="taglore-wn__item-title">{i.title}</strong>
            {i.description ? <span className="taglore-wn__item-desc"> {i.description}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Searchable release history for a /changelog page. Text is rendered as plain text. */
export function Changelog({ url = DEFAULT_HISTORY_URL, data, noSearch, announcedOnly, locale, labels, className }: ChangelogProps) {
  const [releases, setReleases] = useState<ReleaseNotes[]>(data ?? []);
  const [query, setQuery] = useState("");
  const l = { ...DEFAULT_LABELS, ...labels };

  useEffect(() => {
    if (data) {
      setReleases(data);
      return;
    }
    const ctrl = new AbortController();
    loadHistory(url, ctrl.signal)
      .then(setReleases)
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) console.warn("[taglore changelog]", e);
      });
    return () => ctrl.abort();
  }, [url, data]);

  const shown = useMemo(
    () => filterReleases(announcedOnly ? releases.filter((r) => r.announce) : releases, query),
    [releases, query, announcedOnly],
  );

  return (
    <div className={["taglore-cl", className].filter(Boolean).join(" ")}>
      {!noSearch && (
        <input
          type="search"
          className="taglore-cl__search"
          placeholder={l.search}
          aria-label={l.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <div className="taglore-cl__list">
        {shown.length === 0 && <p className="taglore-cl__empty">{l.empty}</p>}
        {shown.map((r) => (
          <article key={r.version} className={`taglore-cl__release taglore-cl__release--${r.releaseType}`}>
            <p className="taglore-cl__meta">
              <span className="taglore-cl__version">{r.version}</span>
              <time className="taglore-cl__date">{formatDate(r.date, locale)}</time>
            </p>
            <h2 className="taglore-cl__title">{r.title}</h2>
            <p className="taglore-cl__summary">{r.summary}</p>
            <Section title={l.breaking} items={r.breaking} kind="breaking" />
            <Section title={l.highlights} items={r.highlights} kind="highlights" />
            <Section title={l.improvements} items={r.improvements} kind="improvements" />
            <Section title={l.fixes} items={r.fixes} kind="fixes" />
          </article>
        ))}
      </div>
    </div>
  );
}
