import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";

/**
 * Builds the MCP App: the project graph as one self-contained HTML document.
 *
 * A `ui://` resource is a single string handed to the host over `resources/read`; there
 * is no origin a second file could load from, and the document's Content Security Policy
 * allows no network at all. So the script, the stylesheet and the markup are inlined, and
 * the result is committed as a TypeScript module, as `apps/mcp-server` does for its panel:
 * the server and `tsc` have it without a build having run first.
 *
 * The canvas inside is the web app's own component, and so are its styles. They are not
 * copied: the design tokens come from `@terrablox/ui`'s stylesheet, Tailwind generates
 * only the classes this package uses, and the canvas stylesheet is read from here. A change
 * to any of them reaches both deliveries on the next build of this document.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const src = path.join(here, "src/mcp-app");

/** Tokens, Tailwind's base and the utilities the canvas uses, as the web app gets them. */
async function buildStyles() {
  const tokensPath = path.join(here, "../ui/src/styles/styles.css");
  const tailwindConfig = {
    ...require("./tailwind.config.js"),
    // This package only: the web app scans every package, an iframe needs what it draws.
    // Without the generated module, which holds this very bundle as a string: scanning it
    // turns every class-like word in the output into CSS, and the next build then differs
    // depending on whether the file was there.
    content: [
      path.join(here, "src/**/*.{ts,tsx}"),
      `!${path.join(here, "src/mcp-app/app.generated.ts")}`,
    ],
  };

  const generated = await postcss([tailwindcss(tailwindConfig)]).process(
    readFileSync(tokensPath, "utf8"),
    { from: tokensPath },
  );

  const flow = readFileSync(
    require.resolve("@xyflow/react/dist/style.css"),
    "utf8",
  );
  // The canvas stylesheet minus its own `@import` of the file above, which is read
  // directly here because nothing resolves an `@import` inside an inlined `<style>`.
  const canvas = readFileSync(
    path.join(here, "src/styles.css"),
    "utf8",
  ).replace(/@import[^;]+;/g, "");

  const frame = `
    /* An iframe is not a page: the host decides its size and scrolling, and the
       gutter the tokens reserve for a scrollbar would be a stripe beside the canvas. */
    html { scrollbar-gutter: auto; overflow: hidden; }
    body { margin: 0; overflow: hidden; }
  `;

  const minified = await transform(
    [generated.css, flow, canvas, frame].join("\n"),
    { loader: "css", minify: true },
  );
  return minified.code;
}

/** The view itself, bundled for a browser that is not the dashboard's. */
async function buildScript() {
  const bundled = await build({
    bundle: true,
    entryPoints: [path.join(src, "main.tsx")],
    format: "esm",
    jsx: "automatic",
    platform: "browser",
    // The iframe is created by the host and could be any browser; these are the floors
    // that carry top-level `await` and modern syntax without a polyfill.
    target: ["es2022", "chrome111", "firefox111", "safari16"],
    define: { "process.env.NODE_ENV": '"production"' },
    minify: true,
    write: false,
    sourcemap: false,
    // `"use client"` at the top of the canvas is meant for Next's bundler and means
    // nothing here; esbuild says so, and saying so on every build teaches people to
    // ignore its warnings.
    logOverride: { "ignored-directive": "silent" },
    logLevel: "warning",
  });

  const script = bundled.outputFiles[0]?.text ?? "";
  if (!script) throw new Error("UI bundle came back empty");
  return script;
}

const [styles, script] = await Promise.all([buildStyles(), buildScript()]);

// A closing tag inside either would end the element early. esbuild will not emit one from
// this source, but a future string literal could, and the failure would look like a blank
// view rather than a broken build.
if (script.includes("</script")) {
  throw new Error("Bundle contains a closing script tag; cannot inline it.");
}
if (styles.includes("</style")) {
  throw new Error("Styles contain a closing style tag; cannot inline them.");
}

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Project graph</title>
    <style>${styles}</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">${script}</script>
  </body>
</html>
`;

// Written unformatted, then handed to biome by the `build:app` script, which is the
// arrangement `apps/mcp-server` uses for its generated file. The alternative is a repo
// where `pnpm lint` fails right after a build.
writeFileSync(
  path.join(src, "app.generated.ts"),
  [
    "// Generated by `pnpm --filter @terrablox/graph build:app`. Do not edit by hand.",
    "//",
    "// The project graph MCP App: the canvas, its styles and the view that hosts it, inlined",
    "// into one HTML document. Committed so that `tsc --noEmit` and the dashboard have it",
    "// without a build step having run first.",
    "",
    `export const GRAPH_APP_HTML = ${JSON.stringify(html)};`,
    "",
  ].join("\n"),
  "utf8",
);

console.log(
  `project graph app: ${(html.length / 1024).toFixed(0)} KB (script ${(script.length / 1024).toFixed(0)} KB, styles ${(styles.length / 1024).toFixed(0)} KB)`,
);
