import { Badge } from "@terrablox/ui/badge";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ModuleDetail } from "@/components/module-detail";
import {
  ModuleFieldEmpty,
  ModuleFieldList,
  ModuleFieldNote,
} from "@/components/module-field-list";
import {
  type CatalogueEntry,
  catalogueSlugs,
  findCatalogueEntry,
  repoUrl,
  sortedInputs,
} from "@/lib/catalogue";

export function generateStaticParams(): { slug: string }[] {
  return catalogueSlugs().map((slug) => ({ slug }));
}

export function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Metadata {
  const entry = findCatalogueEntry(params.slug);
  if (!entry) return {};

  return {
    title: `${entry.name} variables`,
    description: `The variables the ${entry.name} module takes and the outputs it returns, at ${entry.version}.`,
  };
}

/** A type as the module declares it, drawn the way the dashboard draws one. */
function TypeBadge({ type }: { type: string }) {
  // Complex types run to several lines of HCL. Truncated to one line with the whole
  // thing in the tooltip, rather than wrapped, so one `object({...})` cannot push a
  // row taller than the twenty around it.
  const isComplex = /^(object|list|map|set|tuple)\b/.test(type);

  return (
    <code
      className={`rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground text-xs ${
        isComplex ? "block max-w-full truncate whitespace-nowrap" : ""
      }`}
      title={type}
    >
      {type}
    </code>
  );
}

/**
 * One input variable.
 *
 * Row layout taken from the dashboard's `InputRow`: name, whether it is required, then
 * the type pushed to the right, with the description and the default under them.
 */
function InputRow({ input }: { input: CatalogueEntry["inputs"][number] }) {
  const isMultilineDefault =
    input.default !== null &&
    (input.default.length > 60 || input.default.includes("\n"));

  return (
    <div className="border-b px-4 py-3 last:border-b-0 hover:bg-muted/40">
      <div className="flex flex-wrap items-center gap-2">
        <code className="break-all font-medium font-mono text-sm">
          {input.name}
        </code>

        {input.required ? (
          <Badge variant="destructive">required</Badge>
        ) : (
          <Badge variant="secondary">optional</Badge>
        )}

        {input.type ? (
          <span className="ml-auto min-w-0 max-w-full sm:max-w-[60%]">
            <TypeBadge type={input.type} />
          </span>
        ) : null}
      </div>

      {input.description ? (
        <p className="mt-1.5 text-muted-foreground text-sm leading-relaxed">
          {input.description}
        </p>
      ) : null}

      {/* Only for optional inputs. A required variable has no default by definition,
          and the snapshot stores `null` for both "no default" and "defaults to null" —
          so printing one for a required input would invent a value. */}
      {!input.required && input.default !== null ? (
        <div
          className={`mt-2 text-xs ${
            isMultilineDefault
              ? "flex flex-col gap-1"
              : "flex items-start gap-2"
          }`}
        >
          <span className="shrink-0 pt-0.5 text-muted-foreground">Default</span>
          <code
            className={`min-w-0 rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground ${
              isMultilineDefault
                ? "block max-h-40 w-full overflow-auto whitespace-pre"
                : ""
            }`}
          >
            {input.default}
          </code>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Variables tab: the module's interface, both directions.
 *
 * Inputs and outputs are one tab because they are one question. A reader here is working
 * out whether this module fits what they are building, and that means what they must
 * supply and what they get back to wire into the next module — the dashboard folds them
 * together for the same reason. Each list collapses so a module with two hundred and
 * thirty-six inputs does not bury its nine outputs.
 */
export default function ModuleVariablesPage({
  params,
}: {
  params: { slug: string };
}) {
  const entry = findCatalogueEntry(params.slug);
  if (!entry) notFound();

  const inputs = sortedInputs(entry);
  const required = inputs.filter((input) => input.required).length;
  const totalInputs = entry.inputs.length + entry.omitted.inputs;
  const totalOutputs = entry.outputs.length + entry.omitted.outputs;

  return (
    <ModuleDetail entry={entry} tab="variables">
      <div className="space-y-4">
        <ModuleFieldList
          shown={inputs.length}
          title="Inputs"
          total={totalInputs}
        >
          {inputs.length === 0 ? (
            <ModuleFieldEmpty>
              This module declares no variables of its own.
            </ModuleFieldEmpty>
          ) : (
            inputs.map((input) => <InputRow input={input} key={input.name} />)
          )}

          {/* The required count is exact even though the list is truncated, and that
              rests on an invariant in the snapshot rather than on luck: the generator
              keeps required inputs first and fills the remainder alphabetically, and the
              most any module requires is four against a cap of forty. So "none required"
              is a claim about all of them, not just the forty shown. If that cap ever
              drops below the largest required count, this line starts lying quietly —
              which is why it is written down here. */}
          {inputs.length > 0 ? (
            <ModuleFieldNote>
              {required > 0
                ? `${required} of ${totalInputs} must be supplied; the rest have defaults.`
                : `All ${totalInputs} are optional — the module deploys with none of them set.`}
              {/* The snapshot caps each module at forty inputs, and the VPC module has
                  two hundred and thirty-six. Saying which forty these are matters more
                  than the omission does: a reader who assumes the list is complete will
                  conclude the module cannot do something it can. */}
              {entry.omitted.inputs > 0 ? (
                <>
                  {" "}
                  Showing {entry.inputs.length}, so the site stays a static
                  download —{" "}
                  <a
                    className="underline underline-offset-2"
                    href={`${repoUrl(entry)}#inputs`}
                    rel="noreferrer noopener"
                    target="_blank"
                  >
                    the remaining {entry.omitted.inputs} are in the source
                  </a>
                  .
                </>
              ) : null}
            </ModuleFieldNote>
          ) : null}
        </ModuleFieldList>

        <ModuleFieldList
          shown={entry.outputs.length}
          title="Outputs"
          total={totalOutputs}
        >
          {entry.outputs.length === 0 ? (
            <ModuleFieldEmpty>
              This module returns nothing, so nothing downstream can depend on
              it.
            </ModuleFieldEmpty>
          ) : (
            entry.outputs.map((output) => (
              <div
                className="border-b px-4 py-3 last:border-b-0 hover:bg-muted/40"
                key={output.name}
              >
                {/* No type badge. Terraform gives outputs no declared type, and unlike
                    the dashboard this snapshot does not carry the value expression an
                    inference would read — so there is nothing here to show rather than
                    a guess to dress up. */}
                <code className="break-all font-medium font-mono text-sm">
                  {output.name}
                </code>

                {output.description ? (
                  <p className="mt-1.5 text-muted-foreground text-sm leading-relaxed">
                    {output.description}
                  </p>
                ) : null}
              </div>
            ))
          )}

          {entry.outputs.length > 0 ? (
            <ModuleFieldNote>
              What the agent wires into the next module. An edge on the
              architecture diagram is one of these consumed by something else.
              {entry.omitted.outputs > 0 ? (
                <>
                  {" "}
                  Showing {entry.outputs.length} of {totalOutputs} —{" "}
                  <a
                    className="underline underline-offset-2"
                    href={`${repoUrl(entry)}#outputs`}
                    rel="noreferrer noopener"
                    target="_blank"
                  >
                    the rest are in the source
                  </a>
                  .
                </>
              ) : null}
            </ModuleFieldNote>
          ) : null}
        </ModuleFieldList>
      </div>
    </ModuleDetail>
  );
}
