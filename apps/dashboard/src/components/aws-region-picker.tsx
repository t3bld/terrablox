"use client";

import { Button } from "@terrablox/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@terrablox/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@terrablox/ui/popover";
import { Check, ChevronsUpDown } from "lucide-react";
import { useMemo, useState } from "react";

import {
  AWS_REGION_AREAS,
  AWS_REGIONS,
  type AwsRegion,
  findAwsRegion,
} from "@/lib/aws/regions";

/** The shape the API routes validate against, so an unlisted region is checked. */
const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d$/;

/**
 * Picks an AWS region by name or by code.
 *
 * A dropdown rather than a text field: nobody remembers whether Ireland is
 * `eu-west-1` or `eu-west-2`, and a typo in a region is only discovered when
 * CloudFormation refuses an endpoint. Searchable because thirty-odd rows is past
 * the point where scanning beats typing — and the search matches the human name
 * too, so "frankfurt" and "eu-central" both find the same row.
 *
 * A region that is not on the list can still be entered: the list is bundled with
 * the app and AWS adds regions without asking, so being unlisted must not mean
 * being unusable.
 */
export function AwsRegionPicker({
  value,
  onChange,
  disabled = false,
  triggerId,
  className,
}: {
  value: string;
  onChange: (region: string) => void;
  disabled?: boolean;
  /** So a `Label` elsewhere can point at the trigger. */
  triggerId?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = findAwsRegion(value);
  const needle = query.trim().toLowerCase();

  const groups = useMemo(() => {
    const matches = (region: AwsRegion) =>
      !needle ||
      region.code.includes(needle) ||
      region.name.toLowerCase().includes(needle) ||
      region.area.toLowerCase().includes(needle);

    return AWS_REGION_AREAS.map((area) => ({
      area,
      regions: AWS_REGIONS.filter(
        (region) => region.area === area && matches(region),
      ),
    })).filter((group) => group.regions.length > 0);
  }, [needle]);

  /**
   * The row for a region this build has never heard of.
   *
   * Offered for the current value, so an existing setting never vanishes from
   * its own picker, and for anything typed that is shaped like a region.
   */
  const unlisted = [
    ...new Set(
      [value, needle].filter(
        (candidate) =>
          candidate.length > 0 &&
          REGION_PATTERN.test(candidate) &&
          !findAwsRegion(candidate),
      ),
    ),
  ];

  const choose = (region: string) => {
    onChange(region);
    setQuery("");
    setOpen(false);
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          className={`h-10 justify-between gap-1 font-normal ${className ?? ""}`}
          disabled={disabled}
          id={triggerId}
          role="combobox"
          variant="outline"
        >
          <span className="min-w-0 truncate">
            {value ? (
              <>
                <span className="font-mono text-xs">{value}</span>
                {selected ? (
                  <span className="ml-2 text-muted-foreground text-xs">
                    {selected.name}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="text-muted-foreground">Pick a region</span>
            )}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>

      {/* A fixed width rather than the trigger's: each row is a code and a name
          side by side, and matching a narrow trigger would truncate both. */}
      <PopoverContent align="start" className="w-[22rem] p-0">
        {/* Filtered above, because the search has to match the area heading as
            well as the row, which cmdk's own scoring does not see. */}
        <Command shouldFilter={false}>
          <CommandInput
            onValueChange={setQuery}
            placeholder="Search by name or code"
            value={query}
          />
          <CommandList>
            <CommandEmpty>No region matches.</CommandEmpty>

            {groups.map((group) => (
              <CommandGroup heading={group.area} key={group.area}>
                {group.regions.map((region) => (
                  <CommandItem
                    key={region.code}
                    onSelect={() => choose(region.code)}
                    value={region.code}
                  >
                    <Check
                      className={`h-3.5 w-3.5 shrink-0 ${
                        region.code === value ? "opacity-100" : "opacity-0"
                      }`}
                    />
                    <span className="w-32 shrink-0 font-mono text-xs">
                      {region.code}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
                      {region.name}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}

            {unlisted.length > 0 ? (
              <CommandGroup heading="Not on this list">
                {unlisted.map((code) => (
                  <CommandItem key={code} onSelect={() => choose(code)}>
                    <Check
                      className={`h-3.5 w-3.5 shrink-0 ${
                        code === value ? "opacity-100" : "opacity-0"
                      }`}
                    />
                    <span className="w-32 shrink-0 font-mono text-xs">
                      {code}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
                      Use it anyway
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
