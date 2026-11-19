/**
 * Values AWS rejects that Terraform cannot see coming.
 *
 * `terraform validate` and `plan` check types, not the character sets AWS
 * enforces, so a value like `"Let's Encrypt"` in a security group rule
 * description passes both and fails half-way through an apply, with the
 * resources before it already created:
 *
 *   InvalidParameterValue: Invalid rule description. Valid descriptions are
 *   strings less than 256 characters from the following set: a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*
 *
 * This finds them in the configuration itself, so an edit carrying one is
 * refused before it is committed, and a run is refused before it starts.
 *
 * Deliberately narrow. Each rule names exactly where its constraint applies;
 * a guess that flagged valid values would block edits nobody can fix.
 */

/** One value AWS will reject, with enough to correct it. */
export interface AwsValueProblem {
  file: string;
  /** Where it is, e.g. `module.sg_app` → `egress_rules.https.description`. */
  block: string;
  path: string;
  value: string;
  /** The characters AWS does not accept, each once, in order of appearance. */
  invalid: string[];
  /** Too long, as opposed to (or as well as) the wrong characters. */
  tooLong: boolean;
  rule: AwsValueRule;
  /** The value with the offending characters taken out. */
  suggestion: string;
}

export interface AwsValueRule {
  /** What the value is, for the message: "security group rule description". */
  what: string;
  /** Matches one character AWS does not allow. */
  disallowed: RegExp;
  /** The allowed set, as AWS phrases it. */
  allowed: string;
  maxLength: number;
}

/**
 * Security group and security group rule descriptions, in a VPC.
 *
 * The same set for both, from the EC2 API reference for `CreateSecurityGroup`
 * and `AuthorizeSecurityGroupIngress`/`Egress`. EC2-Classic allowed any ASCII,
 * which no account created since 2013 has.
 */
export const SECURITY_GROUP_DESCRIPTION: AwsValueRule = {
  what: "security group description",
  disallowed: /[^a-zA-Z0-9. _\-:/()#,@[\]+=&;{}!$*]/g,
  allowed:
    "letters, digits, spaces and . _ - : / ( ) # , @ [ ] + = & ; { } ! $ *",
  maxLength: 255,
};

const SECURITY_GROUP_RULE_DESCRIPTION: AwsValueRule = {
  ...SECURITY_GROUP_DESCRIPTION,
  what: "security group rule description",
};

/** Resources whose own `description` is a rule description. */
const RULE_RESOURCES = new Set([
  "aws_security_group_rule",
  "aws_vpc_security_group_ingress_rule",
  "aws_vpc_security_group_egress_rule",
]);

/**
 * A module input that holds security group rules.
 *
 * Covers both module shapes in use: the current `ingress_rules`/`egress_rules`
 * maps, and the classic `ingress_with_cidr_blocks` family. Only these, so a
 * module that happens to have an input called `ingress` for something else is
 * not read as a security group.
 */
const RULE_INPUT = /^(ingress|egress)_(rules|with_[a-z_]+)$/;

/** The parser: HCL text to the JSON shape `@cdktf/hcl2json` returns. */
export type HclToJson = (
  path: string,
  content: string,
) => Promise<Record<string, unknown>>;

export const hclToJson: HclToJson = async (path, content) => {
  const { parse } = await import("@cdktf/hcl2json");
  return (await parse(path, content)) as Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** hcl2json wraps each block body in a one-element array. */
function bodies(value: unknown): Record<string, unknown>[] {
  const list = Array.isArray(value) ? value : [value];
  return list
    .map(record)
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

/**
 * The literal text of a value, without its interpolations.
 *
 * `"web-${var.env}"` is checked as `"web-"`: what the expression produces is
 * not known here, and the literal part is still sent to AWS as written.
 */
function literalPart(value: string): string {
  return value.replace(/[$%]\{[^}]*\}/g, "");
}

function check(
  value: unknown,
  rule: AwsValueRule,
  at: { file: string; block: string; path: string },
): AwsValueProblem | null {
  if (typeof value !== "string") return null;

  const literal = literalPart(value);
  const invalid = [...new Set(literal.match(rule.disallowed) ?? [])];
  // Only a value with no interpolation has a length we know.
  const tooLong = literal === value && value.length > rule.maxLength;
  if (invalid.length === 0 && !tooLong) return null;

  // Split keeps the interpolations at the odd indexes, and only the literal
  // text between them is cleaned.
  const suggestion = value
    .split(/([$%]\{[^}]*\})/)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replace(rule.disallowed, ""),
    )
    .join("")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, rule.maxLength);

  return { ...at, value, invalid, tooLong, rule, suggestion };
}

/** Every `description` anywhere inside a module's rule input. */
function descriptionsIn(
  value: unknown,
  path: string,
  visit: (value: unknown, path: string) => void,
): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      descriptionsIn(entry, `${path}[${index}]`, visit);
    }
    return;
  }
  const object = record(value);
  if (!object) return;
  for (const [key, entry] of Object.entries(object)) {
    if (key === "description") visit(entry, `${path}.description`);
    else descriptionsIn(entry, `${path}.${key}`, visit);
  }
}

/** Problems in one parsed file. */
export function problemsInParsed(
  file: string,
  parsed: Record<string, unknown>,
): AwsValueProblem[] {
  const problems: AwsValueProblem[] = [];
  const add = (problem: AwsValueProblem | null) => {
    if (problem) problems.push(problem);
  };

  for (const [name, value] of Object.entries(record(parsed.module) ?? {})) {
    const block = `module.${name}`;
    for (const body of bodies(value)) {
      const ruleInputs = Object.keys(body).filter((key) =>
        RULE_INPUT.test(key),
      );
      // A module with rule inputs is a security group module, so its own
      // `description` is the group's.
      if (ruleInputs.length > 0) {
        add(
          check(body.description, SECURITY_GROUP_DESCRIPTION, {
            file,
            block,
            path: "description",
          }),
        );
      }
      for (const input of ruleInputs) {
        descriptionsIn(body[input], input, (entry, path) =>
          add(
            check(entry, SECURITY_GROUP_RULE_DESCRIPTION, {
              file,
              block,
              path,
            }),
          ),
        );
      }
    }
  }

  for (const [type, byName] of Object.entries(record(parsed.resource) ?? {})) {
    if (type !== "aws_security_group" && !RULE_RESOURCES.has(type)) continue;
    for (const [name, value] of Object.entries(record(byName) ?? {})) {
      const block = `${type}.${name}`;
      for (const body of bodies(value)) {
        if (RULE_RESOURCES.has(type)) {
          add(
            check(body.description, SECURITY_GROUP_RULE_DESCRIPTION, {
              file,
              block,
              path: "description",
            }),
          );
          continue;
        }
        add(
          check(body.description, SECURITY_GROUP_DESCRIPTION, {
            file,
            block,
            path: "description",
          }),
        );
        for (const nested of ["ingress", "egress"] as const) {
          for (const [index, rule] of bodies(body[nested]).entries()) {
            add(
              check(rule.description, SECURITY_GROUP_RULE_DESCRIPTION, {
                file,
                block,
                path: `${nested}[${index}].description`,
              }),
            );
          }
        }
      }
    }
  }

  return problems;
}

/**
 * Problems in a set of files. A file that does not parse contributes none:
 * reporting it is the parse guard's job, and its message is the useful one.
 */
export async function findAwsValueProblems(
  files: ReadonlyMap<string, string>,
  parser: HclToJson = hclToJson,
): Promise<AwsValueProblem[]> {
  const problems: AwsValueProblem[] = [];
  for (const [file, content] of files) {
    if (!file.endsWith(".tf")) continue;
    try {
      problems.push(...problemsInParsed(file, await parser(file, content)));
    } catch {
      // Unparseable: see above.
    }
  }
  return problems;
}

function key(problem: AwsValueProblem): string {
  return `${problem.block}\u0000${problem.path}\u0000${problem.value}`;
}

/**
 * Problems an edit introduces. One that was already in the repository does not
 * block an edit elsewhere: the run preflight reports those.
 */
export async function newAwsValueProblems(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  parser: HclToJson = hclToJson,
): Promise<AwsValueProblem[]> {
  const changed = new Map(
    [...after].filter(
      ([path, content]) => path.endsWith(".tf") && before.get(path) !== content,
    ),
  );
  if (changed.size === 0) return [];

  const previous = new Map([...before].filter(([path]) => changed.has(path)));
  const existing = new Set(
    (await findAwsValueProblems(previous, parser)).map(key),
  );
  return (await findAwsValueProblems(changed, parser)).filter(
    (problem) => !existing.has(key(problem)),
  );
}

function quoted(chars: string[]): string {
  return chars.map((char) => (char === " " ? "space" : `"${char}"`)).join(", ");
}

/**
 * One sentence per problem, written for whoever has to fix it: a person in the
 * canvas, or a model that gets this back as a tool result.
 */
export function describeAwsValueProblem(problem: AwsValueProblem): string {
  const where = `${problem.block} ${problem.path}`;
  const reasons = [
    problem.invalid.length > 0 ? `contains ${quoted(problem.invalid)}` : null,
    problem.tooLong
      ? `is ${problem.value.length} characters long (at most ${problem.rule.maxLength})`
      : null,
  ].filter(Boolean);

  return `${where} ${reasons.join(" and ")}, which AWS rejects in a ${problem.rule.what} (allowed: ${problem.rule.allowed}). Use for example ${JSON.stringify(problem.suggestion)}.`;
}

export function describeAwsValueProblems(problems: AwsValueProblem[]): string {
  return problems.map(describeAwsValueProblem).join(" ");
}

/**
 * Checks one module argument before it is written, for the agent's tools.
 *
 * The commit guard sees the same problem, but the chat applies an agent's
 * edits after its turn has ended, when it can no longer act on the refusal.
 * Checked when the tool is called, the reason comes back as the tool's error
 * and the model corrects the value in the same turn.
 *
 * `declaredInputs` is what decides whether a bare `description` is a security
 * group's: only in a module that also takes rule inputs.
 */
export async function moduleArgumentProblems(
  moduleName: string,
  input: string,
  valueHcl: string,
  declaredInputs: readonly string[],
  parser: HclToJson = hclToJson,
): Promise<AwsValueProblem[]> {
  const isRuleInput = RULE_INPUT.test(input);
  const isGroupDescription =
    input === "description" &&
    declaredInputs.some((name) => RULE_INPUT.test(name));
  if (!isRuleInput && !isGroupDescription) return [];

  // A stand-in rule input makes the module read as a security group, so its
  // `description` is checked as the group's.
  const marker = isGroupDescription ? "\n  egress_rules = {}" : "";
  const source = `module ${JSON.stringify(moduleName)} {\n  ${input} = ${valueHcl}${marker}\n}\n`;

  try {
    return problemsInParsed("main.tf", await parser("main.tf", source));
  } catch {
    // A value that does not parse is refused by the type check and the parse
    // guard, with messages about that.
    return [];
  }
}
