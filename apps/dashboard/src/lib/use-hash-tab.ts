"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Keeps a tab selection in the URL fragment, so a tab can be linked to and the
 * browser's back button returns to the tab that was open rather than the
 * default one.
 *
 * The fragment is used rather than a query parameter because it never reaches
 * the server: switching tabs is a purely client-side concern and should not
 * invalidate a cached route.
 */
export function useHashTab<T extends string>(
  tabs: readonly T[],
  fallback: T,
  /** Re-reads the fragment when this changes, e.g. on navigating to another
   * module. Without it the previous tab would linger on the new page. */
  resetKey?: string,
  /** Retired fragments mapped to their replacement, so links handed out before
   * a tab was renamed still land on the right place instead of the fallback. */
  aliases?: Readonly<Record<string, T>>,
): [T, (next: T) => void] {
  const [tab, setTab] = useState<T>(fallback);

  // Held in a ref so callers may pass an inline array without re-subscribing
  // the history listeners on every render.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const aliasesRef = useRef(aliases);
  aliasesRef.current = aliases;

  // `resetKey` is listed without being read: it exists purely to re-run this
  // effect, which re-reads the fragment after navigating to another module.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate re-run trigger
  useEffect(() => {
    const read = () => {
      const raw = decodeURIComponent(window.location.hash.replace(/^#/, ""));
      const match = tabsRef.current.find((candidate) => candidate === raw);

      if (match) {
        setTab(match);
        return;
      }

      const alias = aliasesRef.current?.[raw];
      if (alias) {
        setTab(alias);
        // Canonicalise without adding an entry, so the address bar agrees with
        // what is on screen and a fresh bookmark uses the current name.
        window.history.replaceState(null, "", `#${alias}`);
        return;
      }

      setTab(fallback);
    };

    read();

    // `popstate` covers back and forward; `hashchange` additionally covers a
    // fragment edited directly in the address bar.
    window.addEventListener("popstate", read);
    window.addEventListener("hashchange", read);

    return () => {
      window.removeEventListener("popstate", read);
      window.removeEventListener("hashchange", read);
    };
  }, [fallback, resetKey]);

  const select = useCallback((next: T) => {
    setTab(next);

    const current = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    if (current === next) return;

    // `pushState` rather than assigning `location.hash`: the latter fires
    // `hashchange`, which would immediately re-read what was just written.
    window.history.pushState(null, "", `#${next}`);
  }, []);

  return [tab, select];
}
