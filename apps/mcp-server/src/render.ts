import { resolveCatalogueEntry } from "@terrablox/catalogue";
import {
  coerceHclValue,
  renderModuleBlock,
} from "@terrablox/terraform/hcl-edit";

import type { Stack } from "./stack.js";

/**
 * The stack as Terraform, with every source pinned to the tag the catalogue names.
 *
 * The pinning is the point rather than a detail. An agent writing `source =
 * "terraform-aws-modules/vpc/aws"` with no version produces a configuration whose meaning
 * changes when upstream releases, and that is the failure this whole library exists to
 * avoid — so the version never comes from the caller. It comes from the snapshot, which
 * got it from a real tag on a real repository.
 *
 * `renderModuleBlock` does the writing, the same function the product uses to edit HCL in
 * a repository. Same quoting rules, same handling of a bare string versus an expression,
 * so the code an agent gets here is the code the harness would have committed.
 */
export function renderStack(stack: Stack): string {
  const blocks: string[] = [];

  for (const call of stack.calls) {
    const entry = resolveCatalogueEntry(call.module);
    if (!entry) continue;

    // Coerced, not passed through. `renderModuleBlock` writes attribute values verbatim,
    // and an agent supplies `us-east-1` as readily as `module.vpc.id` — the first has to be
    // quoted or it parses as a reference to a variable nobody declared. A real bug, caught
    // by reading the rendered output rather than by the type checker.
    const attributes: Record<string, string> = {};
    for (const [name, value] of Object.entries(call.arguments ?? {})) {
      attributes[name] = coerceHclValue(value);
    }

    blocks.push(
      renderModuleBlock({
        name: call.name,
        // The git source rather than a registry address: these modules are published as
        // repositories, and `?ref=` is what pins one to a tag.
        source: `git::https://github.com/${entry.repo}.git?ref=${entry.version}`,
        attributes,
      }),
    );
  }

  return blocks.join("\n\n");
}
