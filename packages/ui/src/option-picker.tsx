"use client";

import { ChevronDown } from "lucide-react";
import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { Label } from "./label";

export interface OptionPickerOption {
  value: string;
  label: string;
}

export function OptionPicker({
  id,
  label,
  onChange,
  options,
  value,
}: {
  id: string;
  label: string;
  onChange: (value: string) => void;
  options: readonly OptionPickerOption[];
  value: string;
}) {
  const selected = options.find((option) => option.value === value);

  return (
    <div className="space-y-1.5">
      <Label className="text-xs" htmlFor={id}>
        {label}
      </Label>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            className="w-full justify-between font-normal"
            id={id}
            variant="outline"
          >
            <span className="truncate">{selected?.label ?? value}</span>
            <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-72 w-[--radix-dropdown-menu-trigger-width] overflow-y-auto"
        >
          <DropdownMenuRadioGroup onValueChange={onChange} value={value}>
            {options.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
