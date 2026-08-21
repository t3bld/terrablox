/**
 * Reading a raw `terraform.tfstate` into the thin inventory the state tab shows.
 *
 * This is the one place in the app that touches unredacted Terraform state, and
 * it exists to make sure nothing else ever has to. State holds generated
 * passwords, private keys and connection strings in clear text — `random_password`
 * writes its result, `aws_db_instance` keeps the master password, `tls_private_key`
 * keeps the key itself. So the mapping here is an allow-list, not a filter: an
 * attribute has to be named to survive, and a resource type this code has never
 * seen contributes its address and nothing else.
 *
 * The format is not the same as `terraform show -json`. Raw state is version 4:
 * a flat `resources` array where each entry carries its own `module` path and a
 * list of `instances`, each with an `index_key` and an `attributes` object.
 */

import type { StateOutput, StateResource, StateSnapshot } from "./state";

/** The only attributes allowed out of a resource's `attributes` object. */
const ALLOWED_ATTRIBUTES = ["id", "arn"] as const;

/** Long values are worth nothing on screen and are a good hiding place. */
const MAX_OUTPUT_LENGTH = 200;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Rebuilds the Terraform address of one instance.
 *
 * Terraform does not store the address; it stores the pieces. Getting this right
 * matters beyond cosmetics — the state tab groups by module path and the
 * architecture view matches on address, and both parse it back out of this
 * string.
 */
function addressOf(params: {
  module: string | null;
  mode: string;
  type: string;
  name: string;
  indexKey: string | number | null;
}): string {
  const prefix = params.module ? `${params.module}.` : "";
  const kind = params.mode === "data" ? "data." : "";
  const index =
    params.indexKey === null
      ? ""
      : typeof params.indexKey === "number"
        ? `[${params.indexKey}]`
        : `["${params.indexKey}"]`;

  return `${prefix}${kind}${params.type}.${params.name}${index}`;
}

function toResources(entry: unknown): StateResource[] {
  const record = asRecord(entry);
  if (!record) return [];

  const type = asString(record.type);
  const name = asString(record.name);
  if (!type || !name) return [];

  const mode = asString(record.mode) ?? "managed";
  const module = asString(record.module);
  const provider = asString(record.provider);
  const instances = Array.isArray(record.instances) ? record.instances : [];

  return instances.flatMap((raw) => {
    const instance = asRecord(raw);
    if (!instance) return [];

    const indexKey =
      typeof instance.index_key === "string" ||
      typeof instance.index_key === "number"
        ? instance.index_key
        : null;

    // Everything except `id` and `arn` is dropped here, deliberately and
    // silently: `attributes` is where the secrets live.
    const attributes = asRecord(instance.attributes) ?? {};
    const picked: Record<(typeof ALLOWED_ATTRIBUTES)[number], string | null> = {
      id: null,
      arn: null,
    };
    for (const key of ALLOWED_ATTRIBUTES) {
      picked[key] = asString(attributes[key]);
    }

    return [
      {
        address: addressOf({ module, mode, type, name, indexKey }),
        type,
        name,
        mode,
        provider,
        index: indexKey,
        id: picked.id,
        arn: picked.arn,
      },
    ];
  });
}

/**
 * Outputs, with the sensitive ones reduced to the fact that they exist.
 *
 * A sensitive output never carries its value past this function. The non-sensitive
 * ones are stringified and truncated, because an output can be an entire object
 * and a state tab is not a JSON viewer.
 */
function toOutputs(raw: unknown): StateOutput[] {
  const record = asRecord(raw);
  if (!record) return [];

  return Object.entries(record).flatMap<StateOutput>(([name, value]) => {
    const output = asRecord(value);
    if (!output) return [];

    const sensitive = output.sensitive === true;
    if (sensitive) return [{ name, sensitive: true, value: null }];

    const plain = output.value;
    const text =
      typeof plain === "string"
        ? plain
        : plain === null || plain === undefined
          ? ""
          : JSON.stringify(plain);

    return [
      {
        name,
        sensitive: false,
        value: text.slice(0, MAX_OUTPUT_LENGTH),
      },
    ];
  });
}

/**
 * Parses raw state, tolerating anything that is not it.
 *
 * A bucket can hold a state written by a newer Terraform, a half-finished
 * upload, or something else entirely. Every one of those has to read as "no
 * inventory" rather than throw, because the alternative is a tab that breaks on
 * data the user cannot see or fix.
 */
export function parseTerraformState(
  raw: string,
  meta: { lastModified: string | null },
): StateSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const record = asRecord(parsed);
  if (!record) return null;

  // Version 4 has been Terraform's state format since 0.12. Anything else is
  // not something this mapping can claim to understand.
  const version = typeof record.version === "number" ? record.version : 0;
  if (version !== 4) return null;

  const resources = Array.isArray(record.resources)
    ? record.resources.flatMap(toResources)
    : [];

  return {
    version,
    // The state has no "generated at"; the object's own timestamp is the honest
    // answer to "how current is this".
    generatedAt: meta.lastModified ?? "",
    terraformVersion: asString(record.terraform_version),
    resources,
    outputs: toOutputs(record.outputs),
  };
}
