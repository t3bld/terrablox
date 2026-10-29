/**
 * Which private module libraries a project's Terraform pulls from.
 *
 * `terraform init` clones each `git::https://github.com/<org>/…` module with
 * whatever credentials git has. In Actions that is the job's GITHUB_TOKEN, which
 * can only read the repository running the workflow — so a project calling
 * Porsche modules needs a token of its own for that organisation. This decides
 * whether a project needs one, so projects that don't keep byte-identical
 * workflows.
 *
 * Pure: no `server-only`, no I/O.
 */

import type { ModuleLibraryDefinition } from "@/lib/module-library/libraries";

/** What the pipeline and the checklist need to know about one library. */
export interface PrivateModuleAccess {
  libraryId: string;
  libraryName: string;
  org: string;
  secretName: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The libraries whose organisation any `source = "…github.com/<org>/…"` names. */
export function librariesUsedBy(
  contents: Iterable<string>,
  libraries: readonly ModuleLibraryDefinition[],
): PrivateModuleAccess[] {
  const texts = [...contents];

  return libraries
    .filter((library) => {
      const pattern = new RegExp(
        `source\\s*=\\s*"[^"\\n]*github\\.com[/:]${escapeRegExp(library.org)}/`,
        "i",
      );
      return texts.some((text) => pattern.test(text));
    })
    .map((library) => ({
      libraryId: library.id,
      libraryName: library.name,
      org: library.org,
      secretName: library.pipelineSecret,
    }));
}
