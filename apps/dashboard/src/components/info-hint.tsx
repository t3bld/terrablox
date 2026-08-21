"use client";

import { Button } from "@terrablox/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@terrablox/ui/popover";
import { Info } from "lucide-react";

/**
 * An explanation behind an info icon, next to the thing it explains.
 *
 * For prose that is worth having once and re-reading never. Printed under every
 * heading it pushed the content it described further down the page each time, and
 * after the first read it was noise on every visit.
 *
 * Lives here rather than next to one screen's primitives: the cost tab and the
 * agent harness both use it, and a heading that explains itself is not a property
 * of either of them.
 */
export function InfoHint({
  label,
  children,
}: {
  /** Names what is being explained, for screen readers. */
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label={`About ${label}`}
          className="h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground"
          size="icon"
          type="button"
          variant="ghost"
        >
          <Info className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 text-muted-foreground text-sm leading-relaxed"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
