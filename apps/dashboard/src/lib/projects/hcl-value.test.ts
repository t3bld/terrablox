// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Terraform interpolation under test, not JavaScript placeholders.
import { parse } from "@cdktf/hcl2json";
import {
  coerceHclValue,
  renderLocalsBlock,
} from "@terrablox/terraform/hcl-edit";
import { describe, expect, it } from "vitest";

/** Whether `value` parses as the right-hand side of a local. */
async function parsesAsLocal(value: string): Promise<boolean> {
  try {
    await parse("locals.tf", renderLocalsBlock([{ name: "v", value }]));
    return true;
  } catch {
    return false;
  }
}

describe("coerceHclValue", () => {
  it("passes expressions through", () => {
    expect(coerceHclValue("module.vpc.id")).toBe("module.vpc.id");
    expect(coerceHclValue('["a", "b"]')).toBe('["a", "b"]');
    expect(coerceHclValue("42")).toBe("42");
    expect(coerceHclValue('merge(local.a, { b = "c" })')).toBe(
      'merge(local.a, { b = "c" })',
    );
  });

  it("quotes a bare word", () => {
    expect(coerceHclValue("t3.micro")).toBe('"t3.micro"');
    expect(coerceHclValue("")).toBe('""');
  });

  it("keeps quotes inside an interpolation unescaped", async () => {
    const value = coerceHclValue('REGISTRY=${split("/", module.ecr.url)[0]}');
    expect(value).toBe('"REGISTRY=${split("/", module.ecr.url)[0]}"');
    expect(await parsesAsLocal(value)).toBe(true);
  });

  it("escapes quotes and backslashes in the literal text", async () => {
    const value = coerceHclValue('say "hi" \\ bye');
    expect(value).toBe('"say \\"hi\\" \\\\ bye"');
    expect(await parsesAsLocal(value)).toBe(true);
  });

  it("escapes an unclosed interpolation instead of breaking the file", async () => {
    const value = coerceHclValue("cost is ${ unclosed");
    expect(await parsesAsLocal(value)).toBe(true);
  });

  it("passes a heredoc through unchanged", async () => {
    const heredoc = [
      "<<EOT",
      "#!/bin/bash",
      'REGISTRY=${split("/", module.ecr.repository_url)[0]}',
      "cat > /etc/caddy <<CADDY",
      "$host {",
      "  reverse_proxy app:3001",
      "}",
      "CADDY",
      "EOT",
    ].join("\n");

    expect(coerceHclValue(heredoc)).toBe(heredoc);
    expect(await parsesAsLocal(heredoc)).toBe(true);
  });

  it("writes multi-line text as a heredoc with a marker it does not contain", async () => {
    const value = coerceHclValue("line one\nEOT\nline ${local.x}");
    expect(value.startsWith("<<EOT_1\n")).toBe(true);
    expect(await parsesAsLocal(value)).toBe(true);
  });
});
