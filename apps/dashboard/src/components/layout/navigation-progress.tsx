"use client";

import { cn } from "@terrablox/ui/lib/utils";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Feedback for the part of a navigation nothing else covers.
 *
 * `loading.tsx` is a Suspense fallback, so it only appears once the router has
 * committed the new segment. Everything before that — resolving the route and
 * fetching its payload — leaves the old page on screen with no sign that the
 * click registered, which is what reads as a frozen UI.
 */

/** Under this a transition feels instant, so a bar would only flash. */
const SHOW_AFTER_MS = 120;
/** Releases the bar when a click never turned into a navigation. */
const GIVE_UP_MS = 15_000;
/** Long enough for the finished bar to be seen before it goes. */
const FADE_MS = 250;

type Phase = "idle" | "running" | "done";

export function NavigationProgress() {
  const pathname = usePathname();
  const [phase, setPhase] = useState<Phase>("idle");
  const [width, setWidth] = useState(0);

  const timers = useRef<number[]>([]);
  // The pathname at the last render, so a committed navigation is detectable
  // without treating the very first render as one.
  const settledPath = useRef(pathname);

  const clearTimers = useCallback(() => {
    for (const id of timers.current) window.clearTimeout(id);
    timers.current = [];
  }, []);

  const startTimer = useCallback((fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);

  const begin = useCallback(() => {
    clearTimers();

    startTimer(() => {
      setPhase("running");
      setWidth(0);
      // A frame at zero width first, otherwise the bar appears already grown
      // instead of moving.
      requestAnimationFrame(() => setWidth(80));
      startTimer(() => {
        setPhase("idle");
        setWidth(0);
      }, GIVE_UP_MS);
    }, SHOW_AFTER_MS);
  }, [clearTimers, startTimer]);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      // Modified clicks open a new tab; the current page never changes.
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const anchor = (event.target as Element | null)?.closest?.("a");
      if (!anchor) return;
      if (anchor.hasAttribute("download")) return;
      if (anchor.target && anchor.target !== "_self") return;

      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;

      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // Same route, only the fragment differs: no segment is fetched.
      if (url.pathname === window.location.pathname) return;

      begin();
    }

    document.addEventListener("click", onClick, { capture: true });
    return () => document.removeEventListener("click", onClick, true);
  }, [begin]);

  useEffect(() => {
    if (pathname === settledPath.current) return;
    settledPath.current = pathname;

    clearTimers();
    setPhase((current) => (current === "running" ? "done" : "idle"));
    setWidth(100);
    startTimer(() => {
      setPhase("idle");
      setWidth(0);
    }, FADE_MS);
  }, [pathname, clearTimers, startTimer]);

  useEffect(() => clearTimers, [clearTimers]);

  if (phase === "idle") return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5"
    >
      <div
        className={cn(
          "h-full bg-primary transition-[width,opacity] ease-out",
          phase === "done"
            ? "opacity-0 duration-200"
            : "opacity-100 duration-[1200ms]",
        )}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}
