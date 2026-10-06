import { describe, expect, it } from "vitest";

import { resolveMarkdownUrl, safeImageSrc, safeLinkHref } from "./safe-url";

describe("safeLinkHref", () => {
  it("keeps the schemes a README legitimately links with", () => {
    expect(safeLinkHref("https://example.com")).toBe("https://example.com");
    expect(safeLinkHref("http://example.com")).toBe("http://example.com");
    expect(safeLinkHref("mailto:a@example.com")).toBe("mailto:a@example.com");
    expect(safeLinkHref("#section")).toBe("#section");
    expect(safeLinkHref("/relative")).toBe("/relative");
  });

  it("drops javascript:, including the forms a browser tolerates", () => {
    // A naive startsWith() check misses every one of these but the first.
    expect(safeLinkHref("javascript:alert(1)")).toBeUndefined();
    expect(safeLinkHref("JavaScript:alert(1)")).toBeUndefined();
    expect(safeLinkHref("  javascript:alert(1)")).toBeUndefined();
    expect(safeLinkHref("java\tscript:alert(1)")).toBeUndefined();
    expect(safeLinkHref("java\nscript:alert(1)")).toBeUndefined();
  });

  it("drops data: for links", () => {
    // A data:text/html navigation runs script; no README needs one.
    expect(
      safeLinkHref("data:text/html,<script>alert(1)</script>"),
    ).toBeUndefined();
  });

  it("drops other active schemes", () => {
    expect(safeLinkHref("vbscript:msgbox(1)")).toBeUndefined();
    expect(safeLinkHref("file:///etc/passwd")).toBeUndefined();
  });
});

describe("safeImageSrc", () => {
  it("allows data:, which is inert in an img and widely used for badges", () => {
    expect(safeImageSrc("data:image/png;base64,iVBOR")).toBe(
      "data:image/png;base64,iVBOR",
    );
  });

  it("still drops javascript:", () => {
    expect(safeImageSrc("javascript:alert(1)")).toBeUndefined();
  });
});

describe("resolveMarkdownUrl", () => {
  const base = "https://raw.githubusercontent.com/o/r/main";

  it("rebases a relative target against the repository", () => {
    expect(resolveMarkdownUrl("docs/img.png", base, "image")).toBe(
      `${base}/docs/img.png`,
    );
    expect(resolveMarkdownUrl("./docs/img.png", base, "image")).toBe(
      `${base}/docs/img.png`,
    );
  });

  it("leaves an absolute target alone", () => {
    expect(resolveMarkdownUrl("https://example.com/x.png", base, "image")).toBe(
      "https://example.com/x.png",
    );
  });

  it("validates after resolving, not before", () => {
    // The scheme check has to see the final string: a relative path is harmless
    // before rebasing and could be anything after.
    expect(
      resolveMarkdownUrl("javascript:alert(1)", base, "link"),
    ).toBeUndefined();
  });

  it("works without a base", () => {
    expect(resolveMarkdownUrl("https://example.com", null, "link")).toBe(
      "https://example.com",
    );
    expect(
      resolveMarkdownUrl("javascript:alert(1)", null, "link"),
    ).toBeUndefined();
  });
});
