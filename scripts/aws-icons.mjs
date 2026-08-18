/**
 * Vendors the AWS architecture icons and regenerates the manifest the browser
 * resolver reads. Two modes:
 *
 *   node scripts/aws-icons.mjs                   regenerate the manifest only
 *   node scripts/aws-icons.mjs ./package/icons   vendor from source, then regenerate
 *
 * Vendored rather than depended on: the set is reviewable in the repository,
 * the diagram works offline, and an upstream release cannot silently change
 * what a diagram looks like. To bump the upstream version:
 *
 *   npm pack aws-icons@3.3.0 && tar xzf aws-icons-3.3.0.tgz
 *   node scripts/aws-icons.mjs ./package/icons
 *
 * Read `apps/dashboard/public/aws-icons/README.md` first — the licensing of
 * these assets is not settled.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const dest = "apps/dashboard/public/aws-icons";
const manifest = "apps/dashboard/src/lib/terraform/aws-icon-manifest.ts";

/** `AmazonSageMaker` -> `sage-maker`, matching what the resolver expects. */
const kebab = (name) =>
  name
    .replace(/^(AWS|Amazon)/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const sha = (buffer) => createHash("sha1").update(buffer).digest("hex");

function vendor(source) {
  // The 26 hand-picked names are shorter and clearer than anything generated
  // ("cloudfront", not "cloud-front"), and the architecture table refers to
  // them. Their sources are skipped so one image never lands under two names.
  const curated = new Map();
  for (const file of readdirSync(dest).filter((f) => f.endsWith(".svg"))) {
    curated.set(
      sha(readFileSync(`${dest}/${file}`)),
      file.replace(/\.svg$/, ""),
    );
  }

  const taken = new Set(curated.values());
  let written = 0;
  let skipped = 0;
  const collisions = [];

  for (const category of readdirSync(source)) {
    const files = readdirSync(`${source}/${category}`).filter((f) =>
      f.endsWith(".svg"),
    );

    for (const file of files) {
      const body = readFileSync(`${source}/${category}/${file}`);
      if (curated.has(sha(body))) {
        skipped++;
        continue;
      }

      let name = kebab(file.replace(/\.svg$/, ""));
      if (taken.has(name)) {
        // The same product name in two categories: the category disambiguates.
        name = `${name}-${category.replace("architecture-", "")}`;
        collisions.push(name);
      }
      if (taken.has(name)) {
        console.error(`unresolved collision, skipped: ${name}`);
        continue;
      }

      taken.add(name);
      writeFileSync(`${dest}/${name}.svg`, body);
      written++;
    }
  }

  console.log(`wrote ${written}, kept ${skipped} curated`);
  if (collisions.length > 0) {
    console.log(`renamed on collision: ${collisions.join(", ")}`);
  }
}

function generateManifest() {
  const names = readdirSync(dest)
    .filter((file) => file.endsWith(".svg"))
    .map((file) => file.replace(/\.svg$/, ""))
    .sort();

  writeFileSync(
    manifest,
    `/**
 * Every file in \`apps/dashboard/public/aws-icons\`, without the extension.
 *
 * GENERATED — do not edit by hand. Regenerate after changing the icon folder:
 *   node scripts/aws-icons.mjs
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
  execFileSync("npx", ["biome", "format", "--write", manifest], {
    stdio: "ignore",
  });

  console.log(`${names.length} icons written to ${manifest}`);
}

const source = process.argv[2];
if (source) {
  vendor(source);
}
generateManifest();
