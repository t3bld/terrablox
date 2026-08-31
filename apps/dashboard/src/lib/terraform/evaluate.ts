/**
 * Evaluates the HCL expressions that decide whether a block exists.
 *
 * This is the difference between drawing the code and drawing the deployment.
 * The upstream VPC module declares seven kinds of subnet, a NAT gateway, a VPN
 * gateway and an egress-only gateway; a project that asks for two public and two
 * database subnets gets four subnets and an internet gateway. Reading HCL alone
 * cannot tell those apart, so the diagram drew all eleven and was wrong about
 * nine of them — including labelling the database subnet public, because its
 * route to the internet gateway is *in the code*, behind a variable nobody set.
 *
 * Not a Terraform interpreter, and deliberately not trying to be. It is a
 * three-valued evaluator: every expression is either a known value or unknown,
 * and unknown is a first-class answer rather than a failure. Callers act only on
 * a known result, so the worst case of an expression this cannot handle is the
 * behaviour that existed before — draw it and say so.
 *
 * The soundness rule everywhere below: never return a value the real evaluation
 * could contradict. `false && unknown` is false, because no value of the right
 * operand changes that. `unknown && true` stays unknown. Getting this backwards
 * would hide infrastructure that exists, which is the one failure mode worth
 * engineering against — an extra box is a nuisance, a missing box is a lie.
 */

/**
 * A value, or `undefined` for "cannot be determined".
 *
 * `null` is a real Terraform value and means something different: `for_each =
 * null` creates nothing, whereas an unknown `for_each` might create anything.
 */
export type TerraformValue =
  | string
  | number
  | boolean
  | null
  | TerraformValue[]
  | { [key: string]: TerraformValue }
  | undefined;

/** A variable as the analyser recorded it. */
export interface EvaluationVariable {
  name: string;
  /** Absent when the variable has no default, which leaves it unknown. */
  default?: unknown;
}

export interface EvaluationScope {
  /** Effective value per variable: the caller's argument, else the default. */
  readonly variables: ReadonlyMap<string, TerraformValue>;
  /** Local expressions as written, evaluated on demand. */
  readonly locals: ReadonlyMap<string, string>;
  /** Memoised locals; a local is routinely read by a dozen blocks. */
  readonly resolved: Map<string, TerraformValue>;
  /** Locals currently being evaluated, so `local.a = local.b` cannot recurse. */
  readonly resolving: Set<string>;
  /**
   * `count.index`, when evaluating one instance of a block rather than the block.
   *
   * This is what turns a `count = 2` subnet into two subnets with names: its
   * availability zone is `element(var.azs, count.index)`, an expression that says
   * nothing until the index is bound.
   */
  readonly index?: number;
}

/**
 * The same scope, positioned at one instance of a block.
 *
 * The variable and local maps are shared, memo included. Safe because HCL only
 * makes `count` available inside a resource block: a local cannot mention
 * `count.index`, so no memoised local can depend on the index this varies.
 */
export function withIndex(
  scope: EvaluationScope,
  index: number,
): EvaluationScope {
  return { ...scope, index };
}

export interface ScopeInput {
  /** The module's own `variable` blocks, for their defaults. */
  variables?: readonly EvaluationVariable[];
  /** The module's own `locals`, as written. */
  locals?: readonly { name: string; expression: string | null }[];
  /**
   * Arguments the caller sets on this module call, as written.
   *
   * Their presence is what licenses using defaults for everything else: knowing
   * the whole argument list means an unset variable really does take its default.
   * Omit them and the caller should not build a scope at all — evaluating a
   * module against defaults it was never called with is how a NAT gateway that
   * exists gets erased from the picture.
   */
  arguments?: Readonly<Record<string, string>>;
  /** Scope the arguments are written in, i.e. the caller's. */
  callerScope?: EvaluationScope;
}

/** Long enough for the real guards; a bound against a pathological expression. */
const MAX_EXPRESSION_LENGTH = 4000;
const MAX_DEPTH = 40;

export function createScope(input: ScopeInput): EvaluationScope {
  const locals = new Map<string, string>();
  for (const local of input.locals ?? []) {
    if (local.expression !== null) locals.set(local.name, local.expression);
  }

  const variables = new Map<string, TerraformValue>();
  for (const variable of input.variables ?? []) {
    // A required variable has no default and nothing to fall back on. Left out
    // rather than stored as undefined so `has` still means "declared with a
    // usable value" — the lookup returns unknown either way.
    if (Object.hasOwn(variable, "default")) {
      variables.set(variable.name, fromParsedHcl(variable.default));
    }
  }

  const scope: EvaluationScope = {
    variables,
    locals,
    resolved: new Map(),
    resolving: new Set(),
  };

  // Applied last so an argument overrides the default, and evaluated in the
  // caller's scope because that is where `local.azs` means something.
  for (const [name, expression] of Object.entries(input.arguments ?? {})) {
    variables.set(
      name,
      input.callerScope
        ? evaluateExpression(expression, input.callerScope)
        : undefined,
    );
  }

  return scope;
}

/**
 * A value straight out of the HCL parser.
 *
 * `@cdktf/hcl2json` returns literals as real JSON — `default = []` arrives as an
 * array — and wraps anything unevaluated in `${…}`. So the only thing to detect
 * is that wrapper: a default that is an expression cannot be resolved here,
 * because Terraform forbids defaults from referencing anything anyway.
 */
function fromParsedHcl(raw: unknown): TerraformValue {
  if (raw === null) return null;
  if (typeof raw === "number" || typeof raw === "boolean") return raw;

  if (typeof raw === "string") {
    return raw.includes("${") ? undefined : raw;
  }

  if (Array.isArray(raw)) return raw.map(fromParsedHcl);

  if (typeof raw === "object") {
    const out: { [key: string]: TerraformValue } = {};
    for (const [key, value] of Object.entries(raw)) {
      out[key] = fromParsedHcl(value);
    }
    return out;
  }

  return undefined;
}

/** Whether a block guarded by this expression produces anything. */
export type Multiplicity = "created" | "absent" | "unknown";

/**
 * Resolves a `count`/`for_each` guard as recorded by the analyser.
 *
 * The two sentinel values come from `readMultiplicityGuard`, which cannot always
 * hand back an expression: `count = 0` is a block switched off in the source, and
 * a bare `"count"`/`"for_each"` means the parser returned something that was not
 * a string at all.
 */
export function resolveMultiplicity(
  guard: string | null | undefined,
  scope: EvaluationScope,
): Multiplicity {
  if (guard === null || guard === undefined) return "created";
  if (guard === "count = 0") return "absent";
  if (guard === "count" || guard === "for_each") return "unknown";

  return existenceOf(evaluateExpression(guard, scope));
}

/**
 * How many instances a guard produces, or null when that cannot be settled.
 *
 * Stronger than {@link resolveMultiplicity} and used for a different purpose: not
 * "is this drawn" but "how many boxes is it". Two public subnets across two
 * availability zones are two places things can sit, and a diagram that draws one
 * cannot say which of them holds the instance wired to `public_subnets[0]`.
 *
 * Null rather than 1 for an unresolved guard, so a caller can tell "one" from "no
 * idea" — the second must not be expanded into anything.
 */
export function resolveInstances(
  guard: string | null | undefined,
  scope: EvaluationScope,
): number | null {
  // No guard is a plain block: exactly one instance, no evaluation needed.
  if (guard === null || guard === undefined) return 1;
  if (guard === "count = 0") return 0;
  if (guard === "count" || guard === "for_each") return null;

  const value = evaluateExpression(guard, scope);

  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (Array.isArray(value)) return value.length;
  if (value !== null && typeof value === "object") {
    return Object.keys(value).length;
  }
  // `count = var.enabled` is not valid Terraform, but a resolved `false` still
  // means nothing is created; `true` says nothing about how many.
  if (value === false) return 0;

  return null;
}

function existenceOf(value: TerraformValue): Multiplicity {
  if (value === undefined) return "unknown";
  if (value === null) return "absent";
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value > 0
        ? "created"
        : "absent"
      : "unknown";
  }
  if (typeof value === "boolean") return value ? "created" : "absent";
  if (Array.isArray(value)) return value.length > 0 ? "created" : "absent";
  if (typeof value === "object") {
    return Object.keys(value).length > 0 ? "created" : "absent";
  }

  // A string guard means the expression was misread; guessing from it would be
  // worse than admitting the gap.
  return "unknown";
}

/**
 * Evaluates one expression. Never throws: a construct this does not implement
 * returns unknown, which every caller already has to handle.
 */
export function evaluateExpression(
  expression: string,
  scope: EvaluationScope,
): TerraformValue {
  const source = unwrapTemplate(expression);
  if (source === null || source.length > MAX_EXPRESSION_LENGTH)
    return undefined;

  try {
    const tokens = tokenize(source);
    if (!tokens) return undefined;

    const parser = new Parser(tokens, scope);
    const value = parser.expression(0);
    // Trailing tokens mean the grammar did not cover this expression, and a
    // partial read is exactly the kind of confident wrong answer to avoid.
    return parser.done() ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Strips the `${…}` the parser wraps whole expressions in.
 *
 * Returns null for a genuine template such as `"${local.prefix}-vpc"`, whose
 * value depends on string concatenation nobody here needs. A plain literal
 * (`"0.0.0.0/0"`, `2`) passes through untouched, which is what lets the same
 * function accept both stored guards and arguments typed on the canvas.
 */
function unwrapTemplate(expression: string): string | null {
  const text = expression.trim();
  if (!text.startsWith("${")) return text.includes("${") ? null : text;

  // Only a wrapper if its closing brace is the last character.
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0)
        return index === text.length - 1 ? text.slice(2, -1) : null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type Token =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string | undefined }
  | { kind: "name"; value: string }
  | { kind: "op"; value: string };

/** Longest first, so `>=` is never read as `>` followed by `=`. */
const OPERATORS = [
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "=>",
  "...",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ",",
  ".",
  ":",
  "?",
  "!",
  "<",
  ">",
  "+",
  "-",
  "*",
  "/",
  "%",
  "=",
];

const NAME_START = /[A-Za-z_]/;
const NAME_PART = /[A-Za-z0-9_-]/;

function tokenize(source: string): Token[] | null {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index] as string;

    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
      continue;
    }

    // A comment inside a stored expression is unusual but legal HCL.
    if (char === "#" || (char === "/" && source[index + 1] === "/")) {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }

    if (char === '"') {
      const end = endOfString(source, index);
      if (end === null) return null;
      const body = source.slice(index + 1, end);
      // An interpolated string is a value this cannot compute; the token still
      // has to exist so the surrounding expression parses and reports unknown.
      tokens.push({
        kind: "string",
        value: body.includes("${") ? undefined : unescapeString(body),
      });
      index = end + 1;
      continue;
    }

    if (char >= "0" && char <= "9") {
      let end = index;
      while (end < source.length && /[0-9]/.test(source[end] as string))
        end += 1;
      if (source[end] === "." && /[0-9]/.test(source[end + 1] ?? "")) {
        end += 1;
        while (end < source.length && /[0-9]/.test(source[end] as string))
          end += 1;
      }
      tokens.push({ kind: "number", value: Number(source.slice(index, end)) });
      index = end;
      continue;
    }

    if (NAME_START.test(char)) {
      let end = index + 1;
      while (end < source.length && NAME_PART.test(source[end] as string))
        end += 1;
      tokens.push({ kind: "name", value: source.slice(index, end) });
      index = end;
      continue;
    }

    const operator = OPERATORS.find((candidate) =>
      source.startsWith(candidate, index),
    );
    if (!operator) return null;

    tokens.push({ kind: "op", value: operator });
    index += operator.length;
  }

  return tokens;
}

function endOfString(source: string, start: number): number | null {
  let index = start + 1;

  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === '"') return index;
    index += 1;
  }

  return null;
}

function unescapeString(body: string): string {
  return body.replace(/\\(.)/g, (_, char: string) => {
    if (char === "n") return "\n";
    if (char === "t") return "\t";
    return char;
  });
}

// ---------------------------------------------------------------------------
// Parsing and evaluation, fused
// ---------------------------------------------------------------------------

/**
 * Binding power per binary operator, lowest first. A precedence-climbing parser
 * rather than one function per level: the same table then documents the
 * precedence instead of it being implied by the call graph.
 */
const BINDING_POWER: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

class Parser {
  private at = 0;
  private depth = 0;
  private readonly tokens: Token[];
  private readonly scope: EvaluationScope;

  // Written out rather than declared as parameter properties: the seed scripts
  // run this source through Node's strip-only TypeScript loader, which rejects
  // them.
  constructor(tokens: Token[], scope: EvaluationScope) {
    this.tokens = tokens;
    this.scope = scope;
  }

  done(): boolean {
    return this.at >= this.tokens.length;
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.at + offset];
  }

  private eat(value: string): boolean {
    const token = this.peek();
    if (token?.kind === "op" && token.value === value) {
      this.at += 1;
      return true;
    }
    return false;
  }

  private expect(value: string): void {
    if (!this.eat(value)) throw new Error(`expected ${value}`);
  }

  expression(minimumPower: number): TerraformValue {
    if (++this.depth > MAX_DEPTH) throw new Error("too deep");
    try {
      return this.binary(minimumPower);
    } finally {
      this.depth -= 1;
    }
  }

  private binary(minimumPower: number): TerraformValue {
    let left = this.unary();

    for (;;) {
      const token = this.peek();
      if (token?.kind !== "op") break;

      if (token.value === "?" && minimumPower === 0) {
        this.at += 1;
        const whenTrue = this.expression(0);
        this.expect(":");
        const whenFalse = this.expression(0);
        left = conditional(left, whenTrue, whenFalse);
        continue;
      }

      const power = BINDING_POWER[token.value];
      if (power === undefined || power < minimumPower) break;

      this.at += 1;
      const right = this.expression(power + 1);
      left = apply(token.value, left, right);
    }

    return left;
  }

  private unary(): TerraformValue {
    if (this.eat("!")) return not(this.unary());
    if (this.eat("-")) {
      const value = this.unary();
      return typeof value === "number" ? -value : undefined;
    }

    return this.postfix(this.primary());
  }

  /** Attribute access and indexing, applied to whatever produced the value. */
  private postfix(value: TerraformValue): TerraformValue {
    let current = value;

    for (;;) {
      if (this.eat(".")) {
        const token = this.peek();
        if (token?.kind === "name" || token?.kind === "number") {
          this.at += 1;
          current = attribute(current, String(token.value));
          continue;
        }
        // A splat (`.*.id`) or anything else: consumed, value unknown.
        if (this.eat("*")) {
          current = undefined;
          continue;
        }
        throw new Error("bad attribute");
      }

      if (this.eat("[")) {
        const index = this.eat("*") ? undefined : this.expression(0);
        this.expect("]");
        current = this.eat("*") ? undefined : element(current, index);
        continue;
      }

      return current;
    }
  }

  private primary(): TerraformValue {
    const token = this.peek();
    if (!token) throw new Error("unexpected end");

    if (token.kind === "number" || token.kind === "string") {
      this.at += 1;
      return token.value;
    }

    if (token.kind === "op") {
      if (token.value === "(") {
        this.at += 1;
        const value = this.expression(0);
        this.expect(")");
        return value;
      }
      if (token.value === "[") return this.list();
      if (token.value === "{") return this.object();
      throw new Error(`unexpected ${token.value}`);
    }

    // A name: a keyword, a function call, or a reference.
    if (token.value === "true" || token.value === "false") {
      this.at += 1;
      return token.value === "true";
    }
    if (token.value === "null") {
      this.at += 1;
      return null;
    }

    const next = this.peek(1);
    if (next?.kind === "op" && next.value === "(") {
      this.at += 1;
      return this.call(token.value);
    }

    return this.reference();
  }

  private list(): TerraformValue {
    this.expect("[");
    const items: TerraformValue[] = [];

    while (!this.eat("]")) {
      // A `for` comprehension is a different grammar; its length is unknowable
      // here, so the whole literal is.
      const token = this.peek();
      if (token?.kind === "name" && token.value === "for") {
        this.skipBalanced("[", "]");
        return undefined;
      }

      items.push(this.expression(0));
      if (this.eat(",")) continue;
      this.expect("]");
      break;
    }

    return items;
  }

  private object(): TerraformValue {
    this.expect("{");
    const entries: { [key: string]: TerraformValue } = {};

    while (!this.eat("}")) {
      const token = this.peek();
      if (token?.kind === "name" && token.value === "for") {
        this.skipBalanced("{", "}");
        return undefined;
      }

      let key: string;
      if (token?.kind === "name") {
        key = token.value;
        this.at += 1;
      } else if (token?.kind === "string" && token.value !== undefined) {
        key = token.value;
        this.at += 1;
      } else {
        this.skipBalanced("{", "}");
        return undefined;
      }

      if (!this.eat("=") && !this.eat(":")) {
        this.skipBalanced("{", "}");
        return undefined;
      }

      entries[key] = this.expression(0);
      this.eat(",");
    }

    return entries;
  }

  /**
   * Rewinds to the opening delimiter and skips the whole construct.
   *
   * Needed because the parser has already consumed part of something it cannot
   * read; leaving the cursor mid-construct would make the *enclosing* expression
   * fail to parse, and a failed parse is reported for the whole guard rather
   * than for the part that was genuinely unreadable.
   */
  private skipBalanced(open: string, close: string): void {
    while (this.at > 0) {
      const token = this.tokens[this.at - 1];
      if (token?.kind === "op" && token.value === open) break;
      this.at -= 1;
    }

    let depth = 0;
    while (this.at < this.tokens.length) {
      const token = this.tokens[this.at];
      this.at += 1;
      if (token?.kind !== "op") continue;
      if (token.value === open) depth += 1;
      else if (token.value === close) {
        depth -= 1;
        if (depth === 0) return;
      }
    }

    throw new Error("unbalanced");
  }

  private call(name: string): TerraformValue {
    this.expect("(");
    const args: TerraformValue[] = [];

    while (!this.eat(")")) {
      args.push(this.expression(0));
      // `expand(...)` argument syntax; the value is unaffected.
      this.eat("...");
      if (this.eat(",")) continue;
      this.expect(")");
      break;
    }

    return callFunction(name, args);
  }

  private reference(): TerraformValue {
    const token = this.peek();
    if (token?.kind !== "name") throw new Error("expected name");
    this.at += 1;

    const root = token.value;

    if (root === "var" && this.eat(".")) {
      const name = this.name();
      // Declared without a default and not passed: unknown, which is also what
      // Terraform would call it until somebody supplies a value.
      return this.scope.variables.has(name)
        ? this.scope.variables.get(name)
        : undefined;
    }

    if (root === "local" && this.eat(".")) {
      return this.local(this.name());
    }

    // Bound only when one instance is being evaluated; unbound it is unknown,
    // which is right — the block as a whole has no single index.
    if (root === "count" && this.eat(".")) {
      return this.name() === "index" ? this.scope.index : undefined;
    }

    // Resources, data sources, module outputs, `each`, `count`, `path`: all real
    // and all unresolvable without a plan. The remaining path is consumed by
    // `postfix`, so the expression around them still parses.
    return undefined;
  }

  private name(): string {
    const token = this.peek();
    if (token?.kind !== "name") throw new Error("expected name");
    this.at += 1;
    return token.value;
  }

  private local(name: string): TerraformValue {
    if (this.scope.resolved.has(name)) return this.scope.resolved.get(name);

    const expression = this.scope.locals.get(name);
    if (expression === undefined) return undefined;

    // HCL rejects local cycles, but a malformed import must not hang the render.
    if (this.scope.resolving.has(name)) return undefined;
    this.scope.resolving.add(name);

    try {
      const value = evaluateExpression(expression, this.scope);
      this.scope.resolved.set(name, value);
      return value;
    } finally {
      this.scope.resolving.delete(name);
    }
  }
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

/**
 * `&&` and `||` are the only places where an unknown operand can still yield a
 * known result, and they are also where the guards actually live: every
 * `count = local.create_x && var.enable_y ? … : 0` in the upstream modules is
 * settled by one operand being false.
 */
function apply(
  operator: string,
  left: TerraformValue,
  right: TerraformValue,
): TerraformValue {
  if (operator === "&&") {
    if (left === false || right === false) return false;
    if (left === true && right === true) return true;
    return undefined;
  }
  if (operator === "||") {
    if (left === true || right === true) return true;
    if (left === false && right === false) return false;
    return undefined;
  }

  if (operator === "==" || operator === "!=") {
    if (left === undefined || right === undefined) return undefined;
    const equal = deepEqual(left, right);
    return operator === "==" ? equal : !equal;
  }

  if (typeof left !== "number" || typeof right !== "number") return undefined;

  switch (operator) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      return right === 0 ? undefined : left / right;
    case "%":
      return right === 0 ? undefined : left % right;
    default:
      return undefined;
  }
}

function not(value: TerraformValue): TerraformValue {
  return typeof value === "boolean" ? !value : undefined;
}

/**
 * An unknown condition still resolves when both branches agree, which is not a
 * curiosity: `var.unset ? local.count : local.count` and, more usefully,
 * `x ? 0 : 0` both say "nothing is created" whatever `x` is.
 */
function conditional(
  condition: TerraformValue,
  whenTrue: TerraformValue,
  whenFalse: TerraformValue,
): TerraformValue {
  if (condition === true) return whenTrue;
  if (condition === false) return whenFalse;
  if (
    whenTrue !== undefined &&
    whenFalse !== undefined &&
    deepEqual(whenTrue, whenFalse)
  ) {
    return whenTrue;
  }
  return undefined;
}

function attribute(value: TerraformValue, key: string): TerraformValue {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value) || typeof value !== "object") return undefined;
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function element(value: TerraformValue, index: TerraformValue): TerraformValue {
  if (value === undefined || index === undefined) return undefined;
  if (Array.isArray(value)) {
    return typeof index === "number" ? value[index] : undefined;
  }
  if (
    value !== null &&
    typeof value === "object" &&
    typeof index === "string"
  ) {
    return Object.hasOwn(value, index) ? value[index] : undefined;
  }
  return undefined;
}

function deepEqual(a: TerraformValue, b: TerraformValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => deepEqual(a[key], b[key]))
    );
  }
  return false;
}

/**
 * The handful of built-ins that decide multiplicity.
 *
 * Everything else returns unknown, on purpose. `length`, `max` and the list
 * helpers are what `count = local.create_x ? local.len_y : 0` reduces to in every
 * upstream module; adding `cidrsubnet` or `templatefile` would add risk without
 * changing a single box on the diagram.
 */
function callFunction(name: string, args: TerraformValue[]): TerraformValue {
  const numbers = () =>
    args.every((value) => typeof value === "number")
      ? (args as number[])
      : undefined;

  switch (name) {
    case "length": {
      const value = args[0];
      if (value === undefined || value === null) return undefined;
      if (Array.isArray(value)) return value.length;
      if (typeof value === "string") return value.length;
      if (typeof value === "object") return Object.keys(value).length;
      return undefined;
    }

    case "max": {
      const values = numbers();
      return values?.length ? Math.max(...values) : undefined;
    }
    case "min": {
      const values = numbers();
      return values?.length ? Math.min(...values) : undefined;
    }

    // `try` and `coalesce` differ in Terraform (errors versus nulls) and agree
    // here: the first argument that is known and not null.
    case "try":
    case "coalesce": {
      for (const value of args) {
        if (value === undefined) return undefined;
        if (value !== null) return value;
      }
      return null;
    }
    case "coalescelist": {
      for (const value of args) {
        if (value === undefined) return undefined;
        if (Array.isArray(value) && value.length > 0) return value;
      }
      return [];
    }

    case "concat": {
      const out: TerraformValue[] = [];
      for (const value of args) {
        if (!Array.isArray(value)) return undefined;
        out.push(...value);
      }
      return out;
    }
    case "compact": {
      const value = args[0];
      if (!Array.isArray(value)) return undefined;
      return value.filter((item) => item !== "" && item !== null);
    }
    case "distinct": {
      const value = args[0];
      if (!Array.isArray(value)) return undefined;
      const out: TerraformValue[] = [];
      for (const item of value) {
        if (!out.some((kept) => deepEqual(kept, item))) out.push(item);
      }
      return out;
    }
    case "flatten": {
      const value = args[0];
      if (!Array.isArray(value)) return undefined;
      const out: TerraformValue[] = [];
      for (const item of value) {
        if (Array.isArray(item)) out.push(...item);
        else out.push(item);
      }
      return out;
    }

    case "contains": {
      const [haystack, needle] = args;
      if (!Array.isArray(haystack) || needle === undefined) return undefined;
      return haystack.some((item) => deepEqual(item, needle));
    }

    /**
     * Wraps rather than overruns, which is the whole reason modules use it:
     * `element(var.azs, count.index)` spreads six subnets over three zones.
     */
    case "element": {
      const [list, index] = args;
      if (!Array.isArray(list) || typeof index !== "number") return undefined;
      if (list.length === 0) return undefined;
      return list[((index % list.length) + list.length) % list.length];
    }

    /**
     * Here for one expression, and it is the one that names an availability zone:
     *
     *   availability_zone = length(regexall("^[a-z]{2}-", element(var.azs,
     *     count.index))) > 0 ? element(var.azs, count.index) : null
     *
     * which is how the upstream VPC module tells a zone name (`eu-central-1a`)
     * from a zone id (`euc1-az2`). Terraform's regex dialect is RE2 and this uses
     * JavaScript's; the two agree on the character classes and anchors that
     * appear in module source, and a pattern either engine rejects throws, which
     * the caller reads as unknown.
     */
    case "regexall": {
      const [pattern, subject] = args;
      if (typeof pattern !== "string" || typeof subject !== "string")
        return undefined;
      try {
        return [...subject.matchAll(new RegExp(pattern, "g"))].map(
          (match) => match[0] as string,
        );
      } catch {
        return undefined;
      }
    }

    case "keys": {
      const value = args[0];
      if (value === null || value === undefined) return undefined;
      if (Array.isArray(value) || typeof value !== "object") return undefined;
      return Object.keys(value);
    }

    case "toset":
    case "tolist": {
      const value = args[0];
      return Array.isArray(value) ? value : undefined;
    }
    case "tonumber": {
      const value = args[0];
      if (typeof value === "number") return value;
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
      }
      return undefined;
    }
    case "tobool": {
      const value = args[0];
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
      return undefined;
    }

    case "merge": {
      const out: { [key: string]: TerraformValue } = {};
      for (const value of args) {
        if (value === null || value === undefined) return undefined;
        if (Array.isArray(value) || typeof value !== "object") return undefined;
        Object.assign(out, value);
      }
      return out;
    }

    case "lookup": {
      const [source, key, fallback] = args;
      const found = element(source, key);
      return found === undefined ? fallback : found;
    }

    default:
      return undefined;
  }
}
