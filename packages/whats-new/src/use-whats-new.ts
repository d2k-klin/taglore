"use client";

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_STORAGE_KEY, DEFAULT_URL, loadNotes, shouldShow, writeSeen } from "./core.js";
import type { ReleaseNotes } from "./types.js";

export interface UseWhatsNewOptions {
  /** Where latest.json is served. Default: /release-notes/latest.json */
  url?: string;
  /** Pass notes directly (e.g. imported at build time) instead of fetching. */
  data?: ReleaseNotes | null;
  /** localStorage key for the last acknowledged version. Use one per app if several share a domain. */
  storageKey?: string;
  /** Show the current announcement to users who have never acknowledged one. Default: false (new users start "up to date"). */
  showOnFirstVisit?: boolean;
  /** Turn the hook off, e.g. for logged-out users. */
  enabled?: boolean;
  /**
   * Open the dialog by itself when there is an unseen announcement. Default: true.
   * Set false to never pop up: show a badge from `unseen` and call `show()` from a menu item.
   */
  autoOpen?: boolean;
}

export interface WhatsNewState {
  notes: ReleaseNotes | null;
  /** True while the dialog should be open. */
  open: boolean;
  /** True when there is an announcement the user has not dismissed yet (for a badge or dot). */
  unseen: boolean;
  /** Marks the current announcement as seen and closes it. */
  dismiss: () => void;
  /** Opens the current announcement again (e.g. from a "What's new" menu item). */
  show: () => void;
  error: Error | null;
}

export function useWhatsNew(options: UseWhatsNewOptions = {}): WhatsNewState {
  const { url = DEFAULT_URL, data, storageKey = DEFAULT_STORAGE_KEY, showOnFirstVisit = false, enabled = true, autoOpen = true } = options;
  const [notes, setNotes] = useState<ReleaseNotes | null>(data ?? null);
  const [open, setOpen] = useState(false);
  const [unseen, setUnseen] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (data !== undefined) {
      setNotes(data);
      if (data && shouldShow(data, storageKey, showOnFirstVisit)) {
        setUnseen(true);
        if (autoOpen) setOpen(true);
      }
      return;
    }
    const ctrl = new AbortController();
    loadNotes(url, ctrl.signal)
      .then((n) => {
        if (!n) return;
        setNotes(n);
        if (shouldShow(n, storageKey, showOnFirstVisit)) {
          setUnseen(true);
          if (autoOpen) setOpen(true);
        }
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setError(e instanceof Error ? e : new Error(String(e)));
      });
    return () => ctrl.abort();
  }, [url, data, storageKey, showOnFirstVisit, enabled, autoOpen]);

  const dismiss = useCallback(() => {
    if (notes) writeSeen(storageKey, notes.version);
    setOpen(false);
    setUnseen(false);
  }, [notes, storageKey]);

  const show = useCallback(() => {
    if (notes) setOpen(true);
  }, [notes]);

  return { notes, open, unseen, dismiss, show, error };
}
