"use client";

import * as React from "react";
import { cn } from "./lib/utils";

export interface SliderProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {}

/** A native range input styled entirely from the shared dashboard tokens. */
const Slider = React.forwardRef<HTMLInputElement, SliderProps>(
  ({ className, ...props }, ref) => (
    <input
      className={cn("tb-slider", className)}
      ref={ref}
      type="range"
      {...props}
    />
  ),
);
Slider.displayName = "Slider";

export { Slider };
