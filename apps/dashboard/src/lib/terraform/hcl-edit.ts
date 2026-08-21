/**
 * Surgical edits on Terraform source text.
 *
 * The graph writes back into files a human also maintains, so the source is
 * edited as text rather than re-rendered from the parsed AST: `@cdktf/hcl2json`
 * discards comments, ordering and formatting, and printing it back would turn
 * every graph interaction into a full-file rewrite in the diff.
 *
 * All scanning goes through {@link advance}, which steps over strings, heredocs
 * and comments as single units. A brace inside `"${a ? "{" : "}"}"` therefore
 * never changes the nesting depth.
 */

export interface HclBlock {
  type: string;
  labels: string[];
  /** Offset of the first character of `type`. */
  start: number;
  /** Offset just past the closing brace. */
  end: number;
  /** Offset just past the opening brace. */
  bodyStart: number;
  /** Offset of the closing brace. */
  bodyEnd: number;
}

const BLOCK_HEADER_RE =
  /^([A-Za-z_][A-Za-z0-9_-]*)((?:[ \t]+(?:"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_-]*))*)[ \t]*\{/;

const LABEL_RE = /"((?:[^"\\]|\\.)*)"|([A-Za-z_][A-Za-z0-9_-]*)/g;

/**
 * Returns the index just past the construct starting at `i`.
 *
 * Quoted strings, heredocs and comments are consumed whole; anything else
 * advances by a single character.
 */
function advance(source: string, i: number): number {
  const ch = source[i];

  if (ch === '"') return skipQuoted(source, i);
  if (ch === "#") return skipToLineEnd(source, i);
  if (ch === "/" && source[i + 1] === "/") return skipToLineEnd(source, i);
  if (ch === "/" && source[i + 1] === "*") {
    const close = source.indexOf("*/", i + 2);
    return close === -1 ? source.length : close + 2;
  }
  if (ch === "<" && source[i + 1] === "<") return skipHeredoc(source, i);

  return i + 1;
}

function skipToLineEnd(source: string, i: number): number {
  const nl = source.indexOf("\n", i);
  return nl === -1 ? source.length : nl;
}

/**
 * Consumes a quoted string including `${...}` interpolations, which may
 * themselves contain quoted strings and braces.
 */
function skipQuoted(source: string, start: number): number {
  let i = start + 1;

  while (i < source.length) {
    const ch = source[i];

    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') return i + 1;

    if ((ch === "$" || ch === "%") && source[i + 1] === "{") {
      i = skipInterpolation(source, i + 2);
      continue;
    }

    i++;
  }

  return source.length;
}

/** Consumes the body of a `${`/`%{` template up to and including its `}`. */
function skipInterpolation(source: string, start: number): number {
  let i = start;
  let depth = 1;

  while (i < source.length && depth > 0) {
    const ch = source[i];

    if (ch === '"') {
      i = skipQuoted(source, i);
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    i++;
  }

  return i;
}

/**
 * Consumes a heredoc. The terminator is the marker alone on its own line, so
 * the marker text appearing inside the body does not end it.
 */
function skipHeredoc(source: string, start: number): number {
  const header = /^<<[-~]?([A-Za-z_][A-Za-z0-9_]*)[ \t]*\r?\n/.exec(
    source.slice(start),
  );
  if (!header?.[1]) return start + 1;

  const marker = header[1];
  let i = start + header[0].length;

  const terminator = new RegExp(`^[ \\t]*${marker}[ \\t]*(\\r?\\n|$)`);

  while (i < source.length) {
    const lineEnd = source.indexOf("\n", i);
    const end = lineEnd === -1 ? source.length : lineEnd + 1;
    const match = terminator.exec(source.slice(i, end));
    if (match) return i + match[0].length;
    i = end;
  }

  return source.length;
}

/** Offset of the matching `}` for the `{` at `openBrace`. */
function matchBrace(source: string, openBrace: number): number {
  let i = openBrace + 1;
  let depth = 1;

  while (i < source.length) {
    const ch = source[i];

    if (ch === "{") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }

    const next = advance(source, i);
    i = next > i ? next : i + 1;
  }

  return -1;
}

function parseLabels(raw: string): string[] {
  const labels: string[] = [];
  LABEL_RE.lastIndex = 0;

  let match = LABEL_RE.exec(raw);
  while (match) {
    labels.push(match[1] ?? match[2] ?? "");
    match = LABEL_RE.exec(raw);
  }

  return labels;
}

/** Every top-level block in a file, in source order. */
export function listBlocks(source: string): HclBlock[] {
  const blocks: HclBlock[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    if (ch === undefined) break;

    // Only an identifier can begin a block header; everything else is trivia,
    // a stray attribute, or a construct `advance` knows how to skip.
    if (/[A-Za-z_]/.test(ch)) {
      const header = BLOCK_HEADER_RE.exec(source.slice(i));
      if (header?.[1]) {
        const openBrace = i + header[0].length - 1;
        const closeBrace = matchBrace(source, openBrace);
        if (closeBrace === -1) break;

        blocks.push({
          type: header[1],
          labels: parseLabels(header[2] ?? ""),
          start: i,
          end: closeBrace + 1,
          bodyStart: openBrace + 1,
          bodyEnd: closeBrace,
        });

        i = closeBrace + 1;
        continue;
      }
    }

    const next = advance(source, i);
    i = next > i ? next : i + 1;
  }

  return blocks;
}

export function findBlock(
  source: string,
  type: string,
  label: string,
): HclBlock | null {
  return (
    listBlocks(source).find(
      (block) => block.type === type && block.labels[0] === label,
    ) ?? null
  );
}

export interface ModuleBlockInput {
  name: string;
  source: string;
  version?: string | null;
  /** Raw HCL expressions, e.g. `{ vpc_id: 'module.vpc.id' }`. */
  attributes?: Record<string, string>;
}

export function renderModuleBlock(input: ModuleBlockInput): string {
  const head: Array<[string, string]> = [
    ["source", JSON.stringify(input.source)],
  ];
  if (input.version) head.push(["version", JSON.stringify(input.version)]);

  const rest = Object.entries(input.attributes ?? {});

  const lines = [
    `module ${JSON.stringify(input.name)} {`,
    ...alignAssignments(head),
    ...(rest.length > 0 ? ["", ...alignAssignments(rest)] : []),
    "}",
  ];

  return `${lines.join("\n")}\n`;
}

/** Pads names to a common width, the way `terraform fmt` does. */
function alignAssignments(entries: Array<[string, string]>): string[] {
  const width = entries.reduce((max, [name]) => Math.max(max, name.length), 0);
  return entries.map(([name, value]) => `  ${name.padEnd(width)} = ${value}`);
}

export function appendBlock(source: string, block: string): string {
  const trimmed = source.replace(/\s*$/, "");
  return trimmed.length === 0 ? block : `${trimmed}\n\n${block}`;
}

export function removeBlock(
  source: string,
  type: string,
  label: string,
): string | null {
  const block = findBlock(source, type, label);
  if (!block) return null;

  // Take the blank lines that separated the block from its neighbour with it,
  // otherwise repeated removals leave a growing gap behind.
  let start = block.start;
  while (start > 0 && /[ \t]/.test(source[start - 1] ?? "")) start--;

  let end = block.end;
  while (end < source.length && /[ \t\r]/.test(source[end] ?? "")) end++;
  if (source[end] === "\n") end++;
  while (end < source.length && /^\s*?\n/.test(source.slice(end))) {
    end += source.slice(end).indexOf("\n") + 1;
  }

  const before = source.slice(0, start).replace(/\s*$/, "");
  const after = source.slice(end).replace(/^\s*/, "");

  if (!before) return after;
  if (!after) return `${before}\n`;
  return `${before}\n\n${after}`;
}

export interface AttributeSpan {
  name: string;
  /** Offset of the first character of the attribute name. */
  start: number;
  /**
   * Offset just past everything belonging to this attribute, which includes a
   * comment trailing it on the same line. That comment documents this value, so
   * deleting the attribute has to take it along.
   */
  end: number;
  valueStart: number;
  /**
   * Offset just past the value expression itself, stopping short of any
   * trailing comment. Rewriting a value splices here so the comment survives.
   */
  valueEnd: number;
  /** The value expression as written, without a trailing comment. */
  value: string;
}

/**
 * Top-level attributes of a block, in source order.
 *
 * Nested blocks are skipped, so `tags` inside `default_tags { }` is not
 * mistaken for the block's own `tags`.
 */
export function listBlockAttributes(
  source: string,
  block: HclBlock,
): AttributeSpan[] {
  const attributes: AttributeSpan[] = [];
  let i = block.bodyStart;

  while (i < block.bodyEnd) {
    const ch = source[i];
    if (ch === undefined) break;

    if (ch === "{") {
      const close = matchBrace(source, i);
      i = close === -1 ? block.bodyEnd : close + 1;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const assignment = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*=[ \t]*/.exec(
        source.slice(i, block.bodyEnd),
      );

      if (assignment?.[1]) {
        const valueStart = i + assignment[0].length;
        const end = findValueEnd(source, valueStart, block.bodyEnd);
        const valueEnd = trimTrailingComment(source, valueStart, end);
        attributes.push({
          name: assignment[1],
          start: i,
          end,
          valueStart,
          valueEnd,
          value: source.slice(valueStart, valueEnd),
        });
        i = end;
        continue;
      }

      // An identifier that is not an assignment starts a nested block header.
      const header = BLOCK_HEADER_RE.exec(source.slice(i, block.bodyEnd));
      if (header) {
        const openBrace = i + header[0].length - 1;
        const close = matchBrace(source, openBrace);
        i = close === -1 ? block.bodyEnd : close + 1;
        continue;
      }
    }

    const next = advance(source, i);
    i = next > i ? next : i + 1;
  }

  return attributes;
}

function findAttribute(
  source: string,
  block: HclBlock,
  name: string,
): AttributeSpan | null {
  return (
    listBlockAttributes(source, block).find((a) => a.name === name) ?? null
  );
}

/**
 * Where the value expression stops, given the span the scanner accepted.
 *
 * {@link findValueEnd} walks past a trailing comment because {@link advance}
 * consumes comments whole, so `env = "dev" # staging` would otherwise report
 * the comment as part of the value — which then shows up on the canvas node and
 * misreads the value's type. Only a comment at depth zero ends the value: one
 * inside an object or list is part of the expression the user wrote, and
 * dropping it would silently rewrite their file on the next edit.
 */
function trimTrailingComment(
  source: string,
  valueStart: number,
  end: number,
): number {
  let i = valueStart;
  let depth = 0;

  while (i < end) {
    const ch = source[i];
    if (ch === undefined) break;

    if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      i++;
      continue;
    }

    const startsComment =
      ch === "#" ||
      (ch === "/" && (source[i + 1] === "/" || source[i + 1] === "*"));

    if (depth === 0 && startsComment) {
      let stop = i;
      while (stop > valueStart && /[ \t]/.test(source[stop - 1] ?? "")) stop--;
      return stop;
    }

    const next = advance(source, i);
    i = next > i ? next : i + 1;
  }

  return end;
}

/**
 * A value ends at the first newline that is not inside a bracketed expression,
 * which is how HCL itself delimits attributes.
 */
function findValueEnd(
  source: string,
  valueStart: number,
  limit: number,
): number {
  let i = valueStart;
  let depth = 0;

  while (i < limit) {
    const ch = source[i];
    if (ch === undefined) break;

    if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      if (depth === 0) return i;
      depth--;
      i++;
      continue;
    }
    if (ch === "\n" && depth === 0) return i;

    const next = advance(source, i);
    i = next > i ? next : i + 1;
  }

  return limit;
}

/**
 * Sets a top-level attribute of a block already located by the caller.
 *
 * Split out from {@link setBlockAttribute} because `locals` blocks carry no
 * label and so cannot be found by one.
 */
export function setAttributeInBlock(
  source: string,
  block: HclBlock,
  name: string,
  value: string,
): string {
  const existing = findAttribute(source, block, name);
  if (existing) {
    return (
      source.slice(0, existing.valueStart) +
      value +
      source.slice(existing.valueEnd)
    );
  }

  const indent = detectBodyIndent(source, block);
  const body = source.slice(block.bodyStart, block.bodyEnd).replace(/\s*$/, "");
  const closingIndent = closingBraceIndent(source, block);

  const nextBody = `${body}\n${indent}${name} = ${value}\n${closingIndent}`;

  return (
    source.slice(0, block.bodyStart) + nextBody + source.slice(block.bodyEnd)
  );
}

/** Removes a top-level attribute of a block already located by the caller. */
export function removeAttributeInBlock(
  source: string,
  block: HclBlock,
  name: string,
): string {
  const existing = findAttribute(source, block, name);
  if (!existing) return source;

  const lineStart = source.lastIndexOf("\n", existing.start) + 1;
  let end = existing.end;
  if (source[end] === "\r") end++;
  if (source[end] === "\n") end++;

  return source.slice(0, lineStart) + source.slice(end);
}

/**
 * Sets a top-level attribute of a block, adding it before the closing brace
 * when it is not declared yet. Returns null when the block does not exist.
 */
export function setBlockAttribute(
  source: string,
  params: { type: string; label: string; name: string; value: string },
): string | null {
  const block = findBlock(source, params.type, params.label);
  if (!block) return null;

  return setAttributeInBlock(source, block, params.name, params.value);
}

export function removeBlockAttribute(
  source: string,
  params: { type: string; label: string; name: string },
): string | null {
  const block = findBlock(source, params.type, params.label);
  if (!block) return null;

  return removeAttributeInBlock(source, block, params.name);
}

/** Indentation of the block's first body line, falling back to two spaces. */
function detectBodyIndent(source: string, block: HclBlock): string {
  const body = source.slice(block.bodyStart, block.bodyEnd);
  const match = /\n([ \t]+)\S/.exec(body);
  return match?.[1] ?? "  ";
}

/**
 * Renames a block's first label. References elsewhere in the file are not
 * touched; the caller knows which addresses point at the block.
 */
export function renameBlockLabel(
  source: string,
  type: string,
  label: string,
  newLabel: string,
): string | null {
  const block = findBlock(source, type, label);
  if (!block) return null;

  const header = source.slice(block.start, block.bodyStart);
  const renamed = header.replace(
    new RegExp(`"${escapeRegExp(label)}"`),
    JSON.stringify(newLabel),
  );

  return source.slice(0, block.start) + renamed + source.slice(block.bodyStart);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function closingBraceIndent(source: string, block: HclBlock): string {
  const lineStart = source.lastIndexOf("\n", block.bodyEnd) + 1;
  const indent = source.slice(lineStart, block.bodyEnd);
  return /^[ \t]*$/.test(indent) ? indent : "";
}

/**
 * Turns a wanted name into one no block in `taken` uses, by appending a
 * counter. Terraform rejects duplicate labels, so a collision would otherwise
 * produce a configuration that no longer plans.
 */
export function uniqueBlockLabel(
  taken: Iterable<string>,
  wanted: string,
): string {
  const used = new Set(taken);
  const base =
    wanted
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/^[^a-z_]+/, "")
      .replace(/_+$/, "") || "module";

  if (!used.has(base)) return base;

  let n = 2;
  while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/**
 * Editing `locals`, which behaves unlike every other block in this file.
 *
 * A local is not a block — it is one entry inside a `locals { }` block, and a
 * file may hold several such blocks that Terraform merges. So "add a local" is
 * "set a key", and the block that key belongs in has to be chosen rather than
 * addressed: an existing key is edited where it already lives, and a new one
 * goes into the first block so a file does not accumulate one block per value.
 */

/** The `locals` blocks in a file, in source order. They take no labels. */
export function findLocalsBlocks(source: string): HclBlock[] {
  return listBlocks(source).filter((block) => block.type === "locals");
}

export interface LocalEntry {
  name: string;
  /** The expression as written, e.g. `"production"` or `module.vpc.id`. */
  value: string;
}

/**
 * Every local declared in a file, across all its `locals` blocks.
 *
 * A name declared twice is reported once, keeping the first — Terraform rejects
 * the duplicate anyway, and picking the later one would make the graph disagree
 * with the error the user is about to see.
 */
export function listLocalsEntries(source: string): LocalEntry[] {
  const entries: LocalEntry[] = [];
  const seen = new Set<string>();

  for (const block of findLocalsBlocks(source)) {
    for (const attribute of listBlockAttributes(source, block)) {
      if (seen.has(attribute.name)) continue;
      seen.add(attribute.name);
      entries.push({ name: attribute.name, value: attribute.value.trim() });
    }
  }

  return entries;
}

/** The `locals` block declaring `name`, or null when no block does. */
export function findLocalsBlockDeclaring(
  source: string,
  name: string,
): HclBlock | null {
  for (const block of findLocalsBlocks(source)) {
    if (listBlockAttributes(source, block).some((a) => a.name === name)) {
      return block;
    }
  }
  return null;
}

/**
 * Sets a local, editing it where it is declared or adding it to the first
 * `locals` block. Returns null when the file has no such block, which is the
 * caller's signal to render one.
 */
export function setLocalsEntry(
  source: string,
  name: string,
  value: string,
): string | null {
  const declaring = findLocalsBlockDeclaring(source, name);
  if (declaring) return setAttributeInBlock(source, declaring, name, value);

  const first = findLocalsBlocks(source)[0];
  if (!first) return null;

  return setAttributeInBlock(source, first, name, value);
}

/**
 * Removes a local, and the `locals` block with it once it holds nothing else.
 *
 * An empty `locals { }` is valid Terraform but reads as an oversight, and it
 * would collect the next local added anywhere in the project.
 */
export function removeLocalsEntry(source: string, name: string): string | null {
  const block = findLocalsBlockDeclaring(source, name);
  if (!block) return null;

  const without = removeAttributeInBlock(source, block, name);

  // Re-read rather than reuse `block`: the removal moved every offset after it.
  const remaining = findLocalsBlocks(without).find(
    (candidate) => candidate.start === block.start,
  );
  if (!remaining) return without;

  const stillHolds = listBlockAttributes(without, remaining).length > 0;
  if (stillHolds) return without;

  return removeBlockAt(without, remaining);
}

/**
 * Removes a block located by the caller, taking the blank lines around it.
 *
 * {@link removeBlock} finds its block by label, which a `locals` block has not.
 */
function removeBlockAt(source: string, block: HclBlock): string {
  let start = block.start;
  while (start > 0 && /[ \t]/.test(source[start - 1] ?? "")) start--;

  let end = block.end;
  while (end < source.length && /[ \t\r]/.test(source[end] ?? "")) end++;
  if (source[end] === "\n") end++;
  while (end < source.length && /^\s*?\n/.test(source.slice(end))) {
    end += source.slice(end).indexOf("\n") + 1;
  }

  const before = source.slice(0, start).replace(/\s*$/, "");
  const after = source.slice(end).replace(/^\s*/, "");

  if (!before) return after;
  if (!after) return `${before}\n`;
  return `${before}\n\n${after}`;
}

/** Renames a local in place, leaving references for the caller to update. */
export function renameLocalsEntry(
  source: string,
  name: string,
  newName: string,
): string | null {
  const block = findLocalsBlockDeclaring(source, name);
  if (!block) return null;

  const existing = listBlockAttributes(source, block).find(
    (a) => a.name === name,
  );
  if (!existing) return null;

  return (
    source.slice(0, existing.start) +
    newName +
    source.slice(existing.start + name.length)
  );
}

export function renderLocalsBlock(entries: LocalEntry[]): string {
  const lines = [
    "locals {",
    ...alignAssignments(entries.map((entry) => [entry.name, entry.value])),
    "}",
  ];

  return `${lines.join("\n")}\n`;
}
