"use client";

import type { LucideIcon } from "lucide-react";
import { useRef } from "react";

export interface TabDefinition<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  /** Rendered as a pill; omit or pass 0 to hide it. */
  count?: number;
}

interface TabsNavProps<T extends string> {
  tabs: TabDefinition<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Namespaces the aria ids; pair it with `tabPanelProps`. */
  idPrefix: string;
  label: string;
}

/**
 * The one tab strip in the app.
 *
 * A real tablist rather than a row of buttons: arrow keys move between tabs and
 * only the selected one is in the tab order, which is what a keyboard user and
 * a screen reader expect from something that looks like this.
 */
export function TabsNav<T extends string>({
  tabs,
  value,
  onChange,
  idPrefix,
  label,
}: TabsNavProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function move(from: number, delta: number) {
    const next = (from + delta + tabs.length) % tabs.length;
    const tab = tabs[next];
    if (!tab) return;

    onChange(tab.value);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex shrink-0 items-stretch gap-1 overflow-x-auto border-b px-4"
    >
      {tabs.map((tab, index) => {
        const active = tab.value === value;
        const Icon = tab.icon;

        return (
          <button
            key={tab.value}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.value}`}
            aria-selected={active}
            aria-controls={`${idPrefix}-panel-${tab.value}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") move(index, 1);
              if (event.key === "ArrowLeft") move(index, -1);
            }}
            className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors ${
              active
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {Icon ? <Icon className="h-4 w-4" /> : null}
            {tab.label}
            {tab.count ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                {tab.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** Ties a panel to its tab; spread it on the element holding the tab content. */
export function tabPanelProps(idPrefix: string, value: string) {
  return {
    id: `${idPrefix}-panel-${value}`,
    role: "tabpanel" as const,
    "aria-labelledby": `${idPrefix}-tab-${value}`,
  };
}
