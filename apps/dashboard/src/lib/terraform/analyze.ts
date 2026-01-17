import "server-only";

// NOTE: This analyzer is intentionally lightweight (no full HCL parser) and is used by
// `/api/modules/import-from-git` and `/api/modules/analyze-git`.

export interface TerraformVariable {
  name: string;
  description?: string | null;
  type?: string | null;
  default?: unknown;
  sensitive?: boolean;
}

export interface TerraformOutput {
  name: string;
  description?: string | null;
  sensitive?: boolean;
}

export interface TerraformProvider {
  name: string;
  version?: string | null;
}

export interface TerraformResource {
  kind: "resource" | "data";
  type: string;
  name: string;
}

export interface TerraformModuleCall {
  name: string;
  source?: string | null;
  version?: string | null;
}

export interface TerraformAnalysis {
  variables: TerraformVariable[];
  outputs: TerraformOutput[];
  providers: TerraformProvider[];
  resources: TerraformResource[];
  moduleCalls: TerraformModuleCall[];
}

function stripComments(input: string) {
  // Remove // and # comments (best-effort; avoids wrecking quoted strings by being conservative).
  return input
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("#") || trimmed.startsWith("//")) return "";
      // inline // is tricky; ignore.
      return line;
    })
    .join("\n");
}

function findBlocks(
  text: string,
  blockType: string,
): Array<{ name: string; body: string }> {
  // Very small HCL-ish parser: find `blockType "name" { ... }` and return body.
  // Balanced-brace scan; ignores braces in strings (best-effort).
  const out: Array<{ name: string; body: string }> = [];
  const re = new RegExp(`${blockType}\\s+\"([^\"]+)\"\\s*\\{`, "g");

  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const name = match[1] ?? "";
    const startIdx = re.lastIndex; // after the opening {
    let i = startIdx;
    let depth = 1;
    let inString: '"' | "'" | null = null;

    for (; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\" && i + 1 < text.length) {
          i++;
          continue;
        }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = ch;
        continue;
      }
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }

    if (depth !== 0) continue;
    const body = text.slice(startIdx, i);
    out.push({ name, body });
    re.lastIndex = i + 1;
  }

  return out;
}

function findTerraformBlock(text: string) {
  const re = /terraform\s*\{/g;
  const m = re.exec(text);
  if (!m) return null;
  const startIdx = re.lastIndex;
  let i = startIdx;
  let depth = 1;
  let inString: '"' | "'" | null = null;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\" && i + 1 < text.length) {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;
  return text.slice(startIdx, i);
}

function parseAssignments(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    // key = value
    const m = /^([A-Za-z0-9_\-]+)\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1] ?? "";
    out[key] = m[2] ?? "";
  }
  return out;
}

function unquote(s: string) {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function tryParseJsonLike(value: string): unknown {
  const v = value.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return unquote(v);
  }
  // Best-effort: don't attempt to eval HCL expressions.
  return v;
}

export function analyzeTerraformFromTexts(fileContents: string[]): TerraformAnalysis {
  const joined = stripComments(fileContents.join("\n\n"));

  const variables = findBlocks(joined, "variable").map(({ name, body }) => {
    const a = parseAssignments(body);
    return {
      name,
      description: a["description"] ? unquote(a["description"]) : null,
      type: a["type"] ? a["type"].trim() : null,
      default: a["default"] ? tryParseJsonLike(a["default"]) : undefined,
      sensitive: a["sensitive"]
        ? Boolean(tryParseJsonLike(a["sensitive"]))
        : undefined,
    } satisfies TerraformVariable;
  });

  const outputs = findBlocks(joined, "output").map(({ name, body }) => {
    const a = parseAssignments(body);
    return {
      name,
      description: a["description"] ? unquote(a["description"]) : null,
      sensitive: a["sensitive"]
        ? Boolean(tryParseJsonLike(a["sensitive"]))
        : undefined,
    } satisfies TerraformOutput;
  });

  const moduleCalls = findBlocks(joined, "module").map(({ name, body }) => {
    const a = parseAssignments(body);
    return {
      name,
      source: a["source"] ? unquote(a["source"]) : null,
      version: a["version"] ? unquote(a["version"]) : null,
    } satisfies TerraformModuleCall;
  });

  const resOut: TerraformResource[] = [];
  {
    const rre = /resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = rre.exec(joined))) {
      resOut.push({ kind: "resource", type: m[1] ?? "", name: m[2] ?? "" });
    }
    const dre = /data\s+"([^"]+)"\s+"([^"]+)"\s*\{/g;
    while ((m = dre.exec(joined))) {
      resOut.push({ kind: "data", type: m[1] ?? "", name: m[2] ?? "" });
    }
  }

  const providers: TerraformProvider[] = [];
  // provider "aws" { ... }
  for (const p of findBlocks(joined, "provider")) {
    const a = parseAssignments(p.body);
    providers.push({
      name: p.name,
      version: a["version"] ? unquote(a["version"]) : null,
    });
  }
  // terraform { required_providers { aws = { source = "hashicorp/aws", version = "~> 5.0" } } }
  const tf = findTerraformBlock(joined);
  if (tf) {
    const rpBlockMatch = /required_providers\s*\{([\s\S]*?)\}/m.exec(tf);
    const rpBody = rpBlockMatch?.[1];
    if (rpBody) {
      // Look for lines like: aws = { ... version = "..." }
      const entryRe = new RegExp(
        "([A-Za-z0-9_\\-]+)\\s*=\\s*\\{([\\s\\S]*?)}",
        "g",
      );
      let m: RegExpExecArray | null;
      while ((m = entryRe.exec(rpBody))) {
        const name = m[1] ?? "";
        const body = m[2] ?? "";
        const a = parseAssignments(body);
        const version = a["version"] ? unquote(a["version"]) : null;
        if (name) providers.push({ name, version });
      }
    }
  }

  // Dedup providers by name (keep first non-null version)
  const providerMap = new Map<string, TerraformProvider>();
  for (const p of providers) {
    const existing = providerMap.get(p.name);
    if (!existing) {
      providerMap.set(p.name, p);
    } else if (!existing.version && p.version) {
      providerMap.set(p.name, { ...existing, version: p.version });
    }
  }

  return {
    variables,
    outputs,
    providers: [...providerMap.values()],
    resources: resOut,
    moduleCalls,
  };
}
