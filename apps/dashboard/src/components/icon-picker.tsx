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
import { Box, ChevronsUpDown, Github, Loader2, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { IconChoiceValue, IconMode } from "@/lib/modules/icon";
import { AWS_ICON_NAMES } from "@/lib/terraform/aws-icon-manifest";

/**
 * Picks one of the bundled AWS icons.
 *
 * The list is 809 entries, so it is searched rather than scrolled, and capped per
 * render: a popover that lays out eight hundred images is slower to open than the
 * search is to type into.
 */
const VISIBLE_LIMIT = 60;

export function IconPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string | null;
  onChange: (iconName: string | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const pool = needle
      ? AWS_ICON_NAMES.filter((name) => name.includes(needle))
      : AWS_ICON_NAMES;

    return pool.slice(0, VISIBLE_LIMIT);
  }, [query]);

  const hidden = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const total = needle
      ? AWS_ICON_NAMES.filter((name) => name.includes(needle)).length
      : AWS_ICON_NAMES.length;

    return Math.max(0, total - matches.length);
  }, [query, matches.length]);

  return (
    <div className="flex items-center gap-2">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-background">
        {value ? (
          // biome-ignore lint/performance/noImgElement: an SVG from our own public folder, which next/image passes through untouched anyway.
          <img
            alt=""
            className="h-full w-full object-contain p-1"
            src={`/aws-icons/${value}.svg`}
          />
        ) : (
          <Box className="h-4 w-4 text-muted-foreground" />
        )}
      </span>

      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <Button
            className="h-9 flex-1 justify-between gap-1 font-normal"
            disabled={disabled}
            variant="outline"
          >
            <span
              className={value ? "font-mono text-xs" : "text-muted-foreground"}
            >
              {value ?? "Search the AWS icons…"}
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>

        <PopoverContent className="w-80 p-0">
          {/* Filtering is done above, so cmdk is told not to do it again — its own
              scoring would reorder a list that is already in the order the search
              produced. */}
          <Command shouldFilter={false}>
            <CommandInput
              onValueChange={setQuery}
              placeholder="Search 809 AWS icons"
              value={query}
            />
            <CommandList>
              <CommandEmpty>No icon matches.</CommandEmpty>

              <CommandGroup>
                {matches.map((name) => (
                  <CommandItem
                    key={name}
                    onSelect={() => {
                      onChange(name);
                      setOpen(false);
                    }}
                    value={name}
                  >
                    {/* biome-ignore lint/performance/noImgElement: sixty 16px
                        SVGs from our own `public`, lazily loaded. */}
                    <img
                      alt=""
                      className="h-4 w-4 shrink-0 object-contain"
                      loading="lazy"
                      src={`/aws-icons/${name}.svg`}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      {name}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>

              {hidden > 0 ? (
                <p className="px-3 py-2 text-[10px] text-muted-foreground">
                  {hidden} more — keep typing to narrow it down.
                </p>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {value ? (
        <Button
          aria-label="Clear icon"
          className="h-9 w-9 shrink-0"
          disabled={disabled}
          onClick={() => onChange(null)}
          size="icon"
          variant="ghost"
        >
          <X className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  );
}

/** What the import dialog knows about an `icon.png` in the chosen repository. */
export type RepoIconState =
  | { status: "unknown" }
  | { status: "loading" }
  | { status: "absent" }
  /** `previewUrl` only resolves for public repositories; private ones show a glyph. */
  | { status: "present"; path: string; previewUrl: string };

/**
 * The whole icon decision: which source, and — for the AWS set — which icon.
 *
 * Three options rather than a single optional picker, because the repository's own
 * `icon.png` and the bundled set are both real answers and the person importing is
 * the one who knows which fits. The repository option is only offered once we have
 * actually seen the file: an option that silently does nothing is worse than one
 * that is not there.
 */
export function IconChoice({
  value,
  onChange,
  repoIcon,
  disabled = false,
}: {
  value: IconChoiceValue;
  onChange: (next: IconChoiceValue) => void;
  repoIcon: RepoIconState;
  disabled?: boolean;
}) {
  const options: Array<{
    mode: IconMode;
    label: string;
    hint: string;
    available: boolean;
  }> = [
    {
      mode: "repo",
      label: "From the repository",
      hint:
        repoIcon.status === "loading"
          ? "Looking for icon.png…"
          : repoIcon.status === "present"
            ? repoIcon.path
            : "No icon.png in this repository",
      available: repoIcon.status === "present",
    },
    {
      mode: "aws",
      label: "AWS service icon",
      hint: "Pick from the 809 bundled icons",
      available: true,
    },
    {
      mode: "none",
      label: "Default",
      hint: "A plain mark, no picture",
      available: true,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3">
        {options.map((option) => {
          const selected = value.mode === option.mode;
          const unavailable = !option.available;

          return (
            <button
              aria-pressed={selected}
              className={`flex items-start gap-2 rounded-md border p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                selected ? "border-primary bg-muted/40" : "hover:bg-muted/50"
              } ${unavailable || disabled ? "cursor-not-allowed opacity-50" : ""}`}
              disabled={disabled || unavailable}
              key={option.mode}
              onClick={() => onChange({ ...value, mode: option.mode })}
              type="button"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded border bg-background">
                <OptionPreview
                  iconName={value.iconName}
                  mode={option.mode}
                  repoIcon={repoIcon}
                />
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-medium">
                  {option.label}
                </span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {option.hint}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {/* Only shown for the mode that needs it. Leaving the search visible under
          the other two would invite picking an icon that is then ignored. */}
      {value.mode === "aws" ? (
        <IconPicker
          disabled={disabled}
          onChange={(iconName) => onChange({ mode: "aws", iconName })}
          value={value.iconName}
        />
      ) : null}
    </div>
  );
}

/** The small square on each option, showing what that option would actually give. */
function OptionPreview({
  mode,
  iconName,
  repoIcon,
}: {
  mode: IconMode;
  iconName: string | null;
  repoIcon: RepoIconState;
}) {
  const [previewFailed, setPreviewFailed] = useState(false);

  if (mode === "repo") {
    if (repoIcon.status === "loading") {
      return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
    }

    if (repoIcon.status === "present" && !previewFailed) {
      return (
        // biome-ignore lint/performance/noImgElement: raw bytes from a repository we do not control, before any source row exists to proxy them through.
        <img
          alt=""
          className="h-full w-full object-contain p-0.5"
          onError={() => setPreviewFailed(true)}
          src={repoIcon.previewUrl}
        />
      );
    }

    // A private repository's raw URL is unreachable from the browser, so the file
    // we know exists still cannot be shown. The glyph says "the repository's own"
    // without pretending to know what it looks like.
    return (
      <Github
        className={`h-4 w-4 ${
          repoIcon.status === "present"
            ? "text-foreground"
            : "text-muted-foreground"
        }`}
      />
    );
  }

  if (mode === "aws" && iconName) {
    return (
      // biome-ignore lint/performance/noImgElement: an SVG from our own public folder, which next/image passes through untouched anyway.
      <img
        alt=""
        className="h-full w-full object-contain p-0.5"
        src={`/aws-icons/${iconName}.svg`}
      />
    );
  }

  return <Box className="h-4 w-4 text-muted-foreground" />;
}
