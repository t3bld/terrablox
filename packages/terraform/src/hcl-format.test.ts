import { describe, expect, it } from "vitest";
import { formatHcl } from "./hcl-format";

/**
 * Expected outputs are what `terraform fmt` produces for the same input.
 */
describe("formatHcl", () => {
  it("aligns consecutive assignments and indents blocks", () => {
    const input = [
      'module "vpc" {',
      'source = "git::https://example.com/vpc.git"',
      '  cidr     =    "10.0.0.0/16"',
      "enable_nat_gateway = false",
      "}",
      "",
    ].join("\n");

    expect(formatHcl(input)).toBe(
      [
        'module "vpc" {',
        '  source             = "git::https://example.com/vpc.git"',
        '  cidr               = "10.0.0.0/16"',
        "  enable_nat_gateway = false",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("starts a new alignment group after a comment, a blank line or a multi-line value", () => {
    const input = [
      "terraform {",
      '  backend "s3" {',
      '    bucket         = "b"',
      "    encrypt        = true",
      "    # Locking.",
      "    use_lockfile   = true",
      "  }",
      "}",
      'resource "x" "y" {',
      "  a = 1",
      "  rules = {",
      "    http = { port = 80 }",
      "  }",
      "  longer_name = 2",
      "",
      "  b = 3",
      "}",
      "",
    ].join("\n");

    expect(formatHcl(input)).toBe(
      [
        "terraform {",
        '  backend "s3" {',
        '    bucket  = "b"',
        "    encrypt = true",
        "    # Locking.",
        "    use_lockfile = true",
        "  }",
        "}",
        'resource "x" "y" {',
        "  a = 1",
        "  rules = {",
        "    http = { port = 80 }",
        "  }",
        "  longer_name = 2",
        "",
        "  b = 3",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("aligns a heredoc assignment and leaves its body alone", () => {
    const input = [
      "locals {",
      '  name = "web"',
      "  user_data = <<EOT",
      "#!/bin/bash",
      "   echo  {",
      "EOT",
      "}",
      "",
    ].join("\n");

    expect(formatHcl(input)).toBe(
      [
        "locals {",
        '  name      = "web"',
        "  user_data = <<EOT",
        "#!/bin/bash",
        "   echo  {",
        "EOT",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("is a no-op on formatted input", () => {
    const formatted = "locals {\n  a   = 1 # one\n  bcd = 2 # two\n}\n";
    expect(formatHcl(formatted)).toBe(formatted);
  });
});
