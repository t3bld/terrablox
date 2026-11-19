import { describe, expect, it } from "vitest";
import {
  describeAwsValueProblem,
  findAwsValueProblems,
  moduleArgumentProblems,
  newAwsValueProblems,
} from "./aws-value-guard";

const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries));

function first<T>(list: T[]): T {
  const [entry] = list;
  if (entry === undefined) throw new Error("expected a problem");
  return entry;
}

// The block that failed the apply in porsche-code/terrablox-test.
const FAILED = `
module "sg_app" {
  source      = "git::https://github.com/terrablox/terrablox-aws-security-group.git?ref=master"
  name        = "terrablox-proto-app"
  description = "Prototype host: HTTP/HTTPS in (Caddy), HTTPS/HTTP out, Postgres to the VPC"
  egress_rules = {
    https = {
      description = "HTTPS to GitHub, Copilot, AWS APIs, MCP servers, Let's Encrypt"
      from_port   = 443
      to_port     = 443
      ip_protocol = "tcp"
      cidr_ipv4   = "0.0.0.0/0"
    }
    http = {
      description = "HTTP for OS package repositories"
      from_port   = 80
    }
  }
}
`;

describe("finding values AWS rejects", () => {
  it("finds the apostrophe that failed the apply, and nothing else", async () => {
    const problems = await findAwsValueProblems(files({ "main.tf": FAILED }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      file: "main.tf",
      block: "module.sg_app",
      path: "egress_rules.https.description",
      invalid: ["'"],
      tooLong: false,
      suggestion:
        "HTTPS to GitHub, Copilot, AWS APIs, MCP servers, Lets Encrypt",
    });
  });

  it("accepts every character AWS allows", async () => {
    const allowed = "aZ09 ._-:/()#,@[]+=&;{}!$*";
    const problems = await findAwsValueProblems(
      files({
        "main.tf": `module "sg" {\n  description = "${allowed}"\n  ingress_rules = { a = { description = "${allowed}" } }\n}\n`,
      }),
    );
    expect(problems).toEqual([]);
  });

  it("checks the classic module shape and the group description", async () => {
    const problems = await findAwsValueProblems(
      files({
        "main.tf": `module "sg" {
  description = "Web — public"
  ingress_with_cidr_blocks = [{ description = "a\\"b" }]
}
`,
      }),
    );
    expect(problems.map((p) => [p.path, p.invalid])).toEqual([
      ["description", ["—"]],
      ["ingress_with_cidr_blocks[0].description", ['"']],
    ]);
  });

  it("leaves modules that are not security groups alone", async () => {
    const problems = await findAwsValueProblems(
      files({
        "main.tf": `module "rds" {\n  description = "The app's database"\n}\n`,
      }),
    );
    expect(problems).toEqual([]);
  });

  it("checks security group resources and rule resources", async () => {
    const problems = await findAwsValueProblems(
      files({
        "sg.tf": `
resource "aws_security_group" "web" {
  description = "Web's group"
  ingress {
    description = "ok"
  }
  egress {
    description = "née"
  }
}
resource "aws_vpc_security_group_egress_rule" "out" {
  description = "Let's"
}
resource "aws_iam_role" "r" {
  description = "Isn't checked"
}
`,
      }),
    );
    expect(problems.map((p) => `${p.block} ${p.path}`)).toEqual([
      "aws_security_group.web description",
      "aws_security_group.web egress[0].description",
      "aws_vpc_security_group_egress_rule.out description",
    ]);
  });

  it("checks only the literal part of an interpolated value", async () => {
    const problems = await findAwsValueProblems(
      files({
        "main.tf": `module "sg" {\n  egress_rules = {\n    a = { description = "To \${var.host}" }\n    b = { description = "\${var.x}'s" }\n  }\n}\n`,
      }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]?.path).toBe("egress_rules.b.description");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation, not a JavaScript placeholder.
    expect(problems[0]?.suggestion).toBe("${var.x}s");
  });

  it("flags a literal description over 255 characters", async () => {
    const long = "a".repeat(256);
    const problem = first(
      await findAwsValueProblems(
        files({
          "main.tf": `module "sg" {\n  egress_rules = { a = { description = "${long}" } }\n}\n`,
        }),
      ),
    );
    expect(problem.tooLong).toBe(true);
    expect(problem.suggestion).toHaveLength(255);
    expect(describeAwsValueProblem(problem)).toContain(
      "is 256 characters long (at most 255)",
    );
  });

  it("skips files that do not parse, which the parse guard reports", async () => {
    expect(
      await findAwsValueProblems(files({ "broken.tf": 'module "x" {' })),
    ).toEqual([]);
  });
});

describe("guarding an edit", () => {
  it("refuses an edit that introduces a rejected value", async () => {
    const before = files({ "main.tf": FAILED.replace("Let's", "Lets") });
    const after = files({ "main.tf": FAILED });
    const problems = await newAwsValueProblems(before, after);
    expect(problems).toHaveLength(1);
  });

  it("does not block an unrelated edit on a value that was already there", async () => {
    const before = files({ "main.tf": FAILED });
    const after = files({
      "main.tf": FAILED.replace('"terrablox-proto-app"', '"renamed"'),
    });
    expect(await newAwsValueProblems(before, after)).toEqual([]);
  });

  it("ignores files the edit did not change", async () => {
    const same = files({ "main.tf": FAILED });
    expect(await newAwsValueProblems(same, same)).toEqual([]);
  });

  it("explains what to change, for a person or a model", async () => {
    const problem = first(
      await findAwsValueProblems(files({ "main.tf": FAILED })),
    );
    expect(describeAwsValueProblem(problem)).toBe(
      `module.sg_app egress_rules.https.description contains "'", which AWS rejects in a security group rule description (allowed: letters, digits, spaces and . _ - : / ( ) # , @ [ ] + = & ; { } ! $ *). Use for example "HTTPS to GitHub, Copilot, AWS APIs, MCP servers, Lets Encrypt".`,
    );
  });
});

describe("checking an agent's argument before it is queued", () => {
  it("refuses a rule input with a rejected description", async () => {
    const problems = await moduleArgumentProblems(
      "sg_app",
      "egress_rules",
      `{ https = { description = "Let's Encrypt", from_port = 443 } }`,
      ["description", "egress_rules", "ingress_rules"],
    );
    expect(problems.map((p) => p.path)).toEqual([
      "egress_rules.https.description",
    ]);
  });

  it("checks a group description only on a security group module", async () => {
    expect(
      await moduleArgumentProblems("sg", "description", `"Web's"`, [
        "description",
        "ingress_rules",
      ]),
    ).toHaveLength(1);
    expect(
      await moduleArgumentProblems("rds", "description", `"App's DB"`, [
        "description",
        "engine",
      ]),
    ).toEqual([]);
  });

  it("ignores inputs that are not descriptions or rules", async () => {
    expect(
      await moduleArgumentProblems("sg", "name", `"it's"`, ["ingress_rules"]),
    ).toEqual([]);
  });
});
