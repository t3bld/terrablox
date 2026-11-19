/**
 * `terraform fmt`, for the parts of it that our own edits can get wrong.
 *
 * The pipeline every project gets runs `terraform fmt -check`, so a file that
 * differs from fmt's output fails the run before `plan` starts. The editors in
 * `hcl-edit` insert attributes one at a time and cannot know the column the
 * block's other `=` signs sit at, so without this every edit risked a red run.
 *
 * Mirrors hclwrite's formatter (the code behind `terraform fmt`) line by line:
 *
 * - indentation: two spaces per open bracket, counted the way hclwrite counts
 *   them, so lopsided input is indented the same way fmt would indent it;
 * - the `=` of consecutive single-line assignments aligned to one column, where
 *   a blank line, a comment line or a line opening a multi-line value ends the
 *   group;
 * - trailing comments of consecutive lines aligned the same way;
 * - no trailing whitespace.
 *
 * Spacing between tokens inside a value is left as written. Heredoc bodies and
 * multi-line comments are copied verbatim, as fmt does.
 */

interface Line {
  /** Text up to the assignment `=`, or the whole line without one. */
  lead: string;
  /** From the assignment `=` to the end, when the line is a single-line assignment. */
  assign: string | null;
  /** A trailing comment, when the line has something before it. */
  comment: string | null;
  /** Bracket change counted the way hclwrite counts it for indentation. */
  netBrackets: number;
  /** Verbatim text following the line: heredoc body or multi-line comment. */
  tail: string;
  blank: boolean;
}

export function formatHcl(source: string): string {
  const lines = splitLines(source);

  // Indentation.
  const indents: number[] = [];
  const indentOf: number[] = [];
  for (const line of lines) {
    if (line.blank) {
      indentOf.push(0);
      continue;
    }
    const net = line.netBrackets;
    if (net < 0) {
      let closed = -net;
      while (closed > 0 && indents.length > 0) {
        const top = indents[indents.length - 1] as number;
        if (closed > top) {
          closed -= top;
          indents.pop();
        } else if (closed < top) {
          indents[indents.length - 1] = top - closed;
          closed = 0;
        } else {
          indents.pop();
          closed = 0;
        }
      }
    }
    indentOf.push(2 * indents.length);
    if (net > 0) indents.push(net);
  }

  const leads = lines.map((line, i) =>
    line.blank ? "" : " ".repeat(indentOf[i] as number) + line.lead,
  );

  // `=` alignment.
  const assignCol: Array<number | null> = lines.map(() => null);
  let start = -1;
  let max = 0;
  const closeAssign = (end: number) => {
    for (let i = start; i < end; i++) assignCol[i] = max + 1;
    start = -1;
    max = 0;
  };
  lines.forEach((line, i) => {
    if (line.assign === null) {
      if (start !== -1) closeAssign(i);
      return;
    }
    if (start === -1) start = i;
    max = Math.max(max, (leads[i] as string).length);
  });
  if (start !== -1) closeAssign(lines.length);

  const bodies = lines.map((line, i) => {
    const lead = leads[i] as string;
    if (line.assign === null) return lead;
    const col = assignCol[i] as number;
    return lead + " ".repeat(col - lead.length) + line.assign;
  });

  // Trailing comment alignment.
  const commentCol: Array<number | null> = lines.map(() => null);
  start = -1;
  max = 0;
  const closeComment = (end: number) => {
    for (let i = start; i < end; i++) commentCol[i] = max + 1;
    start = -1;
    max = 0;
  };
  lines.forEach((line, i) => {
    if (line.comment === null) {
      if (start !== -1) closeComment(i);
      return;
    }
    if (start === -1) start = i;
    max = Math.max(max, (bodies[i] as string).length);
  });
  if (start !== -1) closeComment(lines.length);

  return lines
    .map((line, i) => {
      let text = bodies[i] as string;
      if (line.comment !== null) {
        const col = commentCol[i] as number;
        text += " ".repeat(col - text.length) + line.comment;
      }
      return text + line.tail;
    })
    .join("\n");
}

/**
 * Splits `source` into logical lines.
 *
 * A heredoc or a block comment that runs over several lines stays with the line
 * it starts on, as its `tail`, because fmt treats it as one token.
 */
function splitLines(source: string): Line[] {
  const out: Line[] = [];
  let i = 0;

  while (i <= source.length) {
    let text = "";
    let tail = "";
    let net = 0;
    let countingNet = true;
    let assignAt = -1;
    let assignNet = 0;
    let assignOpen = false;
    let commentAt = -1;
    let tokensBeforeComment = false;
    let firstTokenSeen = false;

    // Skip the line's original indentation.
    while (i < source.length && (source[i] === " " || source[i] === "\t")) i++;

    while (i < source.length && source[i] !== "\n") {
      const ch = source[i] as string;
      const next = source[i + 1];

      // Comments run to the end of the line, or to `*/`.
      if (ch === "#" || (ch === "/" && next === "/")) {
        if (firstTokenSeen) tokensBeforeComment = true;
        commentAt = text.length;
        let end = source.indexOf("\n", i);
        if (end === -1) end = source.length;
        text += source.slice(i, end);
        i = end;
        break;
      }
      if (ch === "/" && next === "*") {
        let end = source.indexOf("*/", i + 2);
        end = end === -1 ? source.length : end + 2;
        const comment = source.slice(i, end);
        const nl = comment.indexOf("\n");
        if (nl !== -1) {
          // Multi-line: the first line here, the rest verbatim.
          if (firstTokenSeen) tokensBeforeComment = true;
          commentAt = text.length;
          text += comment.slice(0, nl);
          tail = comment.slice(nl);
          i = end;
          // Anything after `*/` on the closing line belongs to that line.
          const rest = source.indexOf("\n", i);
          const restEnd = rest === -1 ? source.length : rest;
          tail += source.slice(i, restEnd);
          i = restEnd;
          break;
        }
        // A one-line block comment is a comment token like any other.
        const after = source.slice(end).match(/^[ \t]*(\n|$)/);
        if (after) {
          if (firstTokenSeen) tokensBeforeComment = true;
          commentAt = text.length;
        }
        firstTokenSeen = true;
        text += comment;
        i = end;
        continue;
      }

      // Heredoc: the header line belongs here, the body is verbatim.
      if (ch === "<" && next === "<") {
        const header = /^<<(-?)([A-Za-z_][A-Za-z0-9_]*)[ \t]*\n/.exec(
          source.slice(i),
        );
        if (header) {
          firstTokenSeen = true;
          countingNet = false;
          if (assignAt !== -1 && assignOpen === false) assignOpen = true;
          const marker = header[2] as string;
          text += header[0].replace(/\n$/, "");
          let j = i + header[0].length;
          const bodyStart = j - 1;
          for (;;) {
            const nl = source.indexOf("\n", j);
            const end = nl === -1 ? source.length : nl;
            const lineText = source.slice(j, end);
            if (lineText.trim() === marker || nl === -1) {
              j = end;
              break;
            }
            j = end + 1;
          }
          tail = source.slice(bodyStart, j);
          i = j;
          // Text after the closing marker is not possible on the same line;
          // the next line starts after this newline.
          break;
        }
      }

      if (ch === '"') {
        const end = skipString(source, i);
        firstTokenSeen = true;
        text += source.slice(i, end);
        i = end;
        continue;
      }

      if (ch === "=") {
        const prev = text[text.length - 1];
        const isEqual =
          next !== "=" &&
          next !== ">" &&
          prev !== "=" &&
          prev !== "!" &&
          prev !== "<" &&
          prev !== ">";
        if (isEqual && assignAt === -1 && firstTokenSeen) {
          assignAt = text.length;
          assignNet = 0;
        }
      }

      if ("{[(".includes(ch)) {
        if (countingNet) net++;
        if (assignAt !== -1 && !assignOpen) assignNet++;
      } else if ("}])".includes(ch)) {
        if (countingNet) net--;
        if (assignAt !== -1 && !assignOpen) assignNet--;
      }

      if (ch !== " " && ch !== "\t") firstTokenSeen = true;
      text += ch;
      i++;
    }

    // A comment is one token and fmt copies it verbatim, trailing spaces included.
    const trimmed =
      commentAt !== -1 && tail === ""
        ? text.slice(0, commentAt).replace(/[ \t]+$/, "") +
          (commentAt > 0 && tokensBeforeComment ? " " : "") +
          text.slice(commentAt)
        : text.replace(/[ \t]+$/, "");
    const blank = trimmed === "" && tail === "";

    let lead = trimmed;
    let assign: string | null = null;
    let comment: string | null = null;

    if (!blank) {
      if (commentAt !== -1 && tokensBeforeComment) {
        comment = text.slice(commentAt);
        lead = text.slice(0, commentAt).replace(/[ \t]+$/, "");
      }
      if (assignAt !== -1 && assignNet === 0 && assignAt < lead.length) {
        const key = lead.slice(0, assignAt).replace(/[ \t]+$/, "");
        const value = lead.slice(assignAt + 1).replace(/^[ \t]+/, "");
        lead = key;
        assign = value ? `= ${value}` : "=";
      }
    }

    out.push({ lead, assign, comment, netBrackets: net, tail, blank });

    if (i >= source.length) break;
    i++; // the newline
  }

  return out;
}

/** Index just past the quoted string starting at `start`, interpolations included. */
function skipString(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "\n") return ch === '"' ? i + 1 : i;
    if ((ch === "$" || ch === "%") && source[i + 1] === "{") {
      i = skipTemplate(source, i + 2);
      continue;
    }
    i++;
  }
  return i;
}

function skipTemplate(source: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '"') {
      i = skipString(source, i);
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    i++;
  }
  return i;
}
