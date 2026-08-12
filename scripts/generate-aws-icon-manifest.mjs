/**
 * Writes `aws-icon-manifest.ts` from the contents of `public/aws-icons`.
 *
 * Run after adding or removing icons:
 *   node scripts/generate-aws-icon-manifest.mjs
 */

import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";

const dir = "apps/dashboard/public/aws-icons";
const out = "apps/dashboard/src/lib/terraform/aws-icon-manifest.ts";

const names = readdirSync(dir)
  .filter((file) => file.endsWith(".svg"))
  .map((file) => file.replace(/\.svg$/, ""))
  .sort();

writeFileSync(
  out,
  `/**
 * Every file in \`apps/dashboard/public/aws-icons\`, without the extension.
 *
 * GENERATED — do not edit by hand. Regenerate after changing the icon folder:
 *   node scripts/generate-aws-icon-manifest.mjs
 *
 * The icon resolver runs in the browser and cannot look at the filesystem, so
 * it checks this list instead. Without it a guessed name would render as a
 * broken image rather than falling back cleanly.
 */

export const AWS_ICON_NAMES: readonly string[] = [
${names.map((name) => `  "${name}",`).join("\n")}
];

/** Hyphens dropped, so the Terraform prefix \`sagemaker\` finds \`sage-maker\`. */
export const AWS_ICONS_BY_FLAT_NAME: ReadonlyMap<string, string> = new Map(
  AWS_ICON_NAMES.map((name) => [name.replaceAll("-", ""), name] as const)
    // A shorter name is the more general icon: prefer \`waf\` over
    // \`waf-bot-control\` when both could match the same prefix.
    .sort((a, b) => b[1].length - a[1].length),
);
`,
);

// Written unformatted on purpose — letting the formatter own the layout keeps
// regeneration from producing a diff against itself.
execFileSync("npx", ["biome", "format", "--write", out], { stdio: "ignore" });

console.log(`${names.length} icons written to ${out}`);
