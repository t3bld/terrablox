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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@terrablox/ui/dialog";
import { Input } from "@terrablox/ui/input";
import { Label } from "@terrablox/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@terrablox/ui/popover";
import { AlertCircle, Check, ChevronsUpDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ProjectDto } from "@/lib/projects/types";
import { AppRepoPicker, type AppRepoSelection } from "./app-repo-picker";

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: ProjectDto) => void;
}

interface RepoOwner {
  login: string;
  personal: boolean;
}

/**
 * The repository name a project name implies.
 *
 * Lowercased, spaces to hyphens, and anything GitHub would reject dropped rather
 * than sent: the API only accepts letters, digits, dots, underscores and hyphens,
 * so an umlaut or an ampersand in a project name would otherwise turn into a 400
 * from a field the user cannot see.
 */
export function repoNameFromProjectName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
}

/**
 * The same character rules as {@link repoNameFromProjectName}, without the
 * tidying up.
 *
 * For a name being typed rather than derived. Collapsing `--` or dropping a
 * trailing `-` while someone is still mid-word deletes the character they just
 * pressed, so only what GitHub would actually reject is refused here.
 */
export function sanitizeRepoName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "");
}

/** A name GitHub will accept: it has to carry something other than punctuation. */
function isUsableRepoName(value: string): boolean {
  return /[a-z0-9]/.test(value);
}

/**
 * Creates a project and the repository behind it.
 *
 * One path, not two. Adopting an existing repository was the other half of this
 * dialog and it asked more of the user than it gave: a repository picker, a folder
 * path and a guess about which of the two modes they were in. A project *is* its
 * repository here, so creating both together is the shape that needs no
 * explanation — and a fresh repository has exactly one possible Terraform root,
 * which is why nothing asks for one any more.
 */
export function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateProjectDialogProps) {
  const [name, setName] = useState("");
  /**
   * A repository name typed by hand, or `null` to keep following the project
   * name.
   *
   * Two states rather than one string kept in sync: with a single field, every
   * keystroke in the project name would have to decide whether it may overwrite
   * what is in the repository field, and "the user has taken this over" is the
   * fact that decision needs.
   *
   * Taking over is one-way for the life of the dialog, including clearing the
   * field to empty. Refilling it from the project name at that moment would put
   * text back into a field someone just emptied; the empty field disables
   * Create instead, and the placeholder still shows what would have been used.
   */
  const [repoOverride, setRepoOverride] = useState<string | null>(null);
  const [owner, setOwner] = useState("");
  const [ownerPickerOpen, setOwnerPickerOpen] = useState(false);
  const [isPrivate, setIsPrivate] = useState(true);
  const [appRepo, setAppRepo] = useState<AppRepoSelection | null>(null);

  const [owners, setOwners] = useState<RepoOwner[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on close so a cancelled attempt does not bleed into the next one. The
  // owner list is kept: it is a fact about the account, not about this attempt.
  useEffect(() => {
    if (open) return;
    setName("");
    setRepoOverride(null);
    setOwnerPickerOpen(false);
    setIsPrivate(true);
    setAppRepo(null);
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    fetch("/api/git-provider/github/owners")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled) return;
        const list = (body?.owners ?? []) as RepoOwner[];
        setOwners(list);
        // The personal namespace is the default because it always exists and
        // needs nobody's permission. It is sent as an empty owner, which is what
        // makes the API use the personal endpoint.
        setOwner("");
      })
      .catch(() => {
        // An empty list still creates under the personal account, which is the
        // default anyway — so there is nothing to report here.
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const derivedRepoName = useMemo(() => repoNameFromProjectName(name), [name]);
  const repoName = repoOverride ?? derivedRepoName;

  const personal = owners.find((entry) => entry.personal);
  const organisations = useMemo(
    () => owners.filter((entry) => !entry.personal),
    [owners],
  );

  /** The personal namespace is an empty owner, which is what makes the API use
   *  the personal endpoint — so it is an option here like any other. */
  const ownerOptions = useMemo(
    () => [
      { value: "", label: personal?.login ?? "Your account", personal: true },
      ...organisations.map((entry) => ({
        value: entry.login,
        label: entry.login,
        personal: false,
      })),
    ],
    [personal, organisations],
  );

  const selectedOwner =
    ownerOptions.find((option) => option.value === owner) ?? ownerOptions[0];

  // A search over three rows is chrome, not help. Shown once the list is longer
  // than the eye can take in at a glance.
  const searchableOwners = ownerOptions.length > 5;

  const canSubmit = name.trim().length > 0 && isUsableRepoName(repoName);

  async function submit() {
    if (!canSubmit || submitting) return;

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          repo: {
            name: repoName,
            owner: owner || null,
            private: isPrivate,
          },
          appRepo,
        }),
      });

      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error ?? "Failed to create project");
      }

      onCreated(body.project as ProjectDto);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
        </DialogHeader>

        {/* `pt-2` on top of the dialog's own header spacing: the title sat close
            enough to the first label to read as its caption. */}
        <div className="space-y-4 pt-2">
          <div className="grid gap-2">
            <Label htmlFor="project-name">Project name</Label>
            <Input
              id="project-name"
              onChange={(event) => setName(event.target.value)}
              placeholder="Platform landing zone"
              value={name}
            />
          </div>

          {/* A field rather than a note. The derived name is what will exist on
              GitHub afterwards, so it is shown — and since the derivation drops
              anything GitHub would reject, the one person who knows what the
              repository should be called can say so. */}
          <div className="grid gap-2">
            <Label htmlFor="repo-name">Repository name</Label>
            <Input
              className="font-mono text-sm"
              id="repo-name"
              onChange={(event) =>
                setRepoOverride(sanitizeRepoName(event.target.value))
              }
              placeholder={derivedRepoName || "platform-landing-zone"}
              value={repoName}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="repo-owner">Organisation</Label>
            <Popover onOpenChange={setOwnerPickerOpen} open={ownerPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  aria-expanded={ownerPickerOpen}
                  className="h-10 w-full justify-between gap-1 font-normal"
                  disabled={submitting}
                  id="repo-owner"
                  role="combobox"
                  variant="outline"
                >
                  {/* No "(your account)" beside it: the login is the user's own,
                      and they know which one that is. */}
                  <span className="min-w-0 truncate">
                    {selectedOwner?.label ?? "Your account"}
                  </span>
                  <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>

              {/* Matched to the trigger so the list lines up with the field it
                  belongs to, rather than the popover's default 18rem. */}
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
                <Command>
                  {searchableOwners ? (
                    <CommandInput placeholder="Search organisations" />
                  ) : null}
                  <CommandList>
                    <CommandEmpty>No organisation matches.</CommandEmpty>
                    <CommandGroup>
                      {ownerOptions.map((option) => (
                        <CommandItem
                          key={option.value || "__personal"}
                          onSelect={() => {
                            setOwner(option.value);
                            setOwnerPickerOpen(false);
                          }}
                          // cmdk filters and navigates on this, so it carries the
                          // visible text rather than the empty personal value.
                          value={option.label}
                        >
                          <Check
                            className={`h-3.5 w-3.5 shrink-0 ${
                              option.value === owner
                                ? "opacity-100"
                                : "opacity-0"
                            }`}
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {option.label}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              checked={isPrivate}
              className="h-4 w-4"
              onChange={(event) => setIsPrivate(event.target.checked)}
              type="checkbox"
            />
            Private repository
          </label>

          {/* Asked here rather than later because it changes the first answer the
              agent gives. Infrastructure that fits an application has to come
              from how that application is built, and nobody wants to describe
              their own codebase in a chat box. */}
          {/* The explanation sits between the label and the control, because it
              is what tells someone whether to fill the field in at all — read
              after the picker it arrives too late to be a decision. */}
          <div className="grid gap-2 border-t pt-4">
            <Label htmlFor="app-repo">
              Application repository{" "}
              <span className="font-normal text-muted-foreground">
                — optional
              </span>
            </Label>
            <p className="text-xs text-muted-foreground">
              The agent gets read-only access to the application repository you
              are creating this infrastructure for.
            </p>
            <AppRepoPicker
              disabled={submitting}
              onChange={setAppRepo}
              triggerId="app-repo"
              value={appRepo}
            />
          </div>

          {error ? (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            disabled={submitting}
            onClick={() => onOpenChange(false)}
            variant="outline"
          >
            Cancel
          </Button>
          <Button disabled={!canSubmit || submitting} onClick={submit}>
            {submitting ? "Creating…" : "Create project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
