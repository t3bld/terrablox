"use client";

import * as React from "react";
import { cn } from "./lib/utils";

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {}

/**
 * A native select, styled like `Input`.
 *
 * Native rather than a listbox built from divs: it inherits keyboard handling,
 * type-ahead and the platform's mobile picker, none of which a custom widget
 * gets for free.
 */
const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <select
        className={cn(
          "flex",
          "h-10",
          "w-full",
          "rounded-md",
          "border",
          "border-input",
          "bg-background",
          "px-3",
          "py-2",
          "text-sm",
          "ring-offset-background",
          "focus-visible:outline-none",
          "focus-visible:ring-2",
          "focus-visible:ring-ring",
          "focus-visible:ring-offset-2",
          "disabled:cursor-not-allowed",
          "disabled:opacity-50",
          className,
        )}
        ref={ref}
        {...props}
      >
        {children}
      </select>
    );
  },
);
Select.displayName = "Select";

export { Select };
