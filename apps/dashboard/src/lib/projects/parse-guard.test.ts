import { describe, expect, it } from "vitest";
import {
  assertEditParses,
  hclParser,
  UnparseableEditError,
} from "./parse-guard";

const GOOD = 'locals {\n  name = "web"\n}\n';
// What the old quoting produced: `\"` inside an interpolation.
// biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation, not a JavaScript placeholder.
const BROKEN = 'locals {\n  r = "${split(\\"/\\", local.x)[0]}"\n}\n';

const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries));

describe("assertEditParses", () => {
  it("accepts an edit that still parses", async () => {
    await expect(
      assertEditParses(
        files({ "locals.tf": GOOD }),
        files({ "locals.tf": GOOD.replace("web", "api") }),
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses an edit that breaks a file", async () => {
    await expect(
      assertEditParses(
        files({ "locals.tf": GOOD }),
        files({ "locals.tf": BROKEN }),
      ),
    ).rejects.toThrow(/would leave locals\.tf unparseable/);
  });

  it("refuses writing more into a file that was already broken", async () => {
    await expect(
      assertEditParses(
        files({ "locals.tf": BROKEN }),
        files({ "locals.tf": `${BROKEN}\nlocals {\n  name = "web"\n}\n` }),
      ),
    ).rejects.toThrow(UnparseableEditError);
  });

  it("allows an edit that repairs a broken file", async () => {
    await expect(
      assertEditParses(
        files({ "locals.tf": BROKEN }),
        files({ "locals.tf": GOOD }),
      ),
    ).resolves.toBeUndefined();
  });

  it("ignores files the edit did not touch, and non-Terraform files", async () => {
    await expect(
      assertEditParses(
        files({ "broken.tf": BROKEN, "README.md": "x" }),
        files({ "broken.tf": BROKEN, "README.md": "{{{" }),
      ),
    ).resolves.toBeUndefined();
  });

  it("uses the real HCL parser by default", async () => {
    expect(await hclParser("locals.tf", GOOD)).toBeNull();
    expect(await hclParser("locals.tf", BROKEN)).toMatch(/Invalid character/);
  });
});
