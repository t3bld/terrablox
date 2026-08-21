import { isKnownAwsIcon } from "@/lib/terraform/aws-icon-manifest";

/**
 * Where a module's icon comes from.
 *
 * Deliberately a choice of one source rather than a priority list. A repository
 * that ships an `icon.png` and a hand-picked AWS icon can both be recorded on the
 * same row, so something has to say which one wins — and if that were a fixed
 * order, "show the plain mark" and "show the AWS icon anyway" would be impossible
 * to express without deleting data.
 *
 * - `repo` — the `icon.png` the repository ships.
 * - `aws`  — one of the bundled AWS service icons, by name.
 * - `none` — the neutral mark.
 *
 * Every mode falls back to the neutral mark when its source is missing. None of
 * them falls back to a *different* source: an icon that changes to something else
 * because a file was deleted upstream is harder to explain than a plain box.
 */
export const ICON_MODES = ["repo", "aws", "none"] as const;

export type IconMode = (typeof ICON_MODES)[number];

/** The default for a row nobody has made a choice for. */
export const DEFAULT_ICON_MODE: IconMode = "repo";

/**
 * One decision about a module's icon: the mode, plus the AWS icon name that mode
 * `aws` needs. Kept together because writing one without the other leaves a row
 * that says "use the AWS icon" and does not say which.
 */
export interface IconChoiceValue {
  mode: IconMode;
  /** Bundled AWS icon file name without the extension. Only used by mode `aws`. */
  iconName: string | null;
}

export function isIconMode(value: unknown): value is IconMode {
  return (
    typeof value === "string" &&
    (ICON_MODES as readonly string[]).includes(value)
  );
}

/**
 * Reads an icon choice off an untrusted request body.
 *
 * Returns null when the caller said nothing, which callers treat as "leave what
 * is stored alone" — the catalogue re-sync sends no icon and must not reset a
 * choice somebody made by hand.
 *
 * The name is checked against the bundled set rather than trusted, because it
 * ends up in an image `src`: an unknown name would render as a broken image
 * instead of falling back to the neutral mark. A mode of `aws` with no usable
 * name degrades to `repo`, which is the same thing the row would have shown
 * before anyone touched the icon.
 */
export function parseIconChoice(input: unknown): IconChoiceValue | null {
  if (!input || typeof input !== "object") return null;

  const raw = input as { mode?: unknown; iconName?: unknown };
  if (!isIconMode(raw.mode)) return null;

  const iconName =
    typeof raw.iconName === "string" && isKnownAwsIcon(raw.iconName)
      ? raw.iconName
      : null;

  if (raw.mode === "aws" && !iconName) {
    return { mode: "repo", iconName: null };
  }

  return { mode: raw.mode, iconName };
}

/**
 * The file names a repository can use to declare its own icon, in the order they
 * are preferred. Root only: a picture deeper in the tree belongs to documentation,
 * not to the module.
 */
export const REPO_ICON_FILES = ["icon.png", "icon.svg"] as const;

/**
 * The icon file a repository ships, given its blob paths.
 *
 * Shared by the importer, which reads the tree it fetched anyway, and by the
 * import dialog, which needs to know whether to offer the option at all. One
 * definition so the dialog cannot offer something the importer would not find.
 */
export function findRepoIconPath(blobPaths: Iterable<string>): string | null {
  const paths = new Set(blobPaths);

  for (const candidate of REPO_ICON_FILES) {
    if (paths.has(candidate)) return candidate;
  }

  return null;
}
