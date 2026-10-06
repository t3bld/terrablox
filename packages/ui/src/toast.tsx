"use client";

import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "./lib/utils";

/**
 * Transient messages, in one place at the bottom right.
 *
 * Written rather than depended on. What this needs is a stack, a timer and a
 * portal-free fixed container — a dependency for that would be more code to keep
 * current than the thing it replaces, and this file is the whole feature.
 *
 * What belongs here and what does not is the part worth being strict about. A toast
 * is the right home for the *outcome of something the user just did*: saved,
 * queued, failed. It is the wrong home for a standing condition — "this repository
 * cannot be read", "the role has to exist first", "this role gets
 * AdministratorAccess" — because those are true until something changes, and a
 * message that disappears after four seconds cannot say so. Those stay where the
 * thing they describe is.
 */
export type ToastVariant = "success" | "error" | "info";

export interface ToastOptions {
  variant?: ToastVariant;
  /** A second line, for the detail behind a one-line summary. */
  description?: string;
  /**
   * How long it stays, in ms. Null pins it until dismissed.
   *
   * Errors get longer by default: a failure is usually the thing the reader has to
   * act on, and they may have been looking somewhere else when it appeared.
   */
  duration?: number | null;
}

interface ToastEntry extends ToastOptions {
  id: number;
  message: string;
}

const DEFAULT_DURATION: Record<ToastVariant, number> = {
  success: 4_000,
  info: 5_000,
  error: 9_000,
};

/** The most that are shown at once; older ones drop off the top. */
const MAX_VISIBLE = 4;

interface ToastApi {
  toast: (message: string, options?: ToastOptions) => void;
  /** Shorthands, because the variant is the thing every call site knows. */
  success: (message: string, options?: Omit<ToastOptions, "variant">) => void;
  error: (message: string, options?: Omit<ToastOptions, "variant">) => void;
  info: (message: string, options?: Omit<ToastOptions, "variant">) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * The hook every call site uses.
 *
 * Throws when the provider is missing rather than returning a no-op: a swallowed
 * toast is a message the user never sees and nobody notices is gone.
 */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) {
    throw new Error("useToast must be used inside a ToastProvider");
  }
  return api;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [entries, setEntries] = useState<ToastEntry[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setEntries((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, options?: ToastOptions) => {
      const text = message.trim();
      if (!text) return;

      const id = nextId.current++;
      const variant = options?.variant ?? "info";
      const duration =
        options?.duration === undefined
          ? DEFAULT_DURATION[variant]
          : options.duration;

      setEntries((current) => {
        // Identical back-to-back messages are collapsed rather than stacked: a
        // retry that fails the same way twice is one fact, and two copies of it
        // read as two problems.
        const last = current[current.length - 1];
        if (last && last.message === text && last.variant === variant) {
          return current;
        }
        return [...current, { ...options, id, message: text, variant }].slice(
          -MAX_VISIBLE,
        );
      });

      if (duration !== null) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
    },
    [dismiss],
  );

  // Nothing may outlive the provider: a pending timer would call `setEntries` on
  // an unmounted tree.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      toast,
      success: (message, options) =>
        toast(message, { ...options, variant: "success" }),
      error: (message, options) =>
        toast(message, { ...options, variant: "error" }),
      info: (message, options) =>
        toast(message, { ...options, variant: "info" }),
      dismiss,
    }),
    [toast, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport entries={entries} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

const ICONS: Record<ToastVariant, typeof Info> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

const TONES: Record<ToastVariant, string> = {
  success: "text-emerald-600",
  error: "text-destructive",
  info: "text-muted-foreground",
};

function ToastViewport({
  entries,
  onDismiss,
}: {
  entries: ToastEntry[];
  onDismiss: (id: number) => void;
}) {
  return (
    // `output` rather than a div with `role="status"`: it is the element that role
    // belongs to, so assistive technology gets it without being told.
    <output
      // `pointer-events-none` on the stack and `auto` on each card: the empty
      // column above the toasts sits over the page, and without this it would
      // swallow clicks on whatever is underneath it.
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-end gap-2 p-4 sm:inset-x-auto sm:right-0"
      // Polite rather than assertive: these announce what just happened, and
      // interrupting a screen reader mid-sentence to say "saved" is worse than
      // waiting for the pause.
      aria-live="polite"
    >
      {entries.map((entry) => {
        const variant = entry.variant ?? "info";
        const Icon = ICONS[variant];

        return (
          <div
            className={cn(
              "pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-lg border bg-background p-3 shadow-lg",
              "animate-in slide-in-from-bottom-2 fade-in duration-200",
              variant === "error" && "border-destructive/40",
            )}
            key={entry.id}
          >
            <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", TONES[variant])} />

            <div className="min-w-0 flex-1">
              <p className="break-words text-sm">{entry.message}</p>
              {entry.description ? (
                <p className="mt-0.5 break-words text-muted-foreground text-xs">
                  {entry.description}
                </p>
              ) : null}
            </div>

            <button
              aria-label="Dismiss"
              className="-m-1 shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
              onClick={() => onDismiss(entry.id)}
              type="button"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </output>
  );
}
