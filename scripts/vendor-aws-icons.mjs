/**
 * Copies the AWS architecture icons out of `aws-icons` into `public/aws-icons`.
 *
 * Vendored rather than depended on: the set is reviewable in the repository,
 * the diagram works offline, and an upstream release cannot silently change
 * what a diagram looks like. Run after bumping the version below, then
 * regenerate the manifest:
 *
 *   npm pack aws-icons@3.3.0 && tar xzf aws-icons-3.3.0.tgz
 *   node scripts/vendor-aws-icons.mjs ./package/icons
 *   node scripts/generate-aws-icon-manifest.mjs
 *
 * Read `apps/dashboard/public/aws-icons/README.md` first — the licensing of
 * these assets is not settled.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const source = process.argv[2];
if (!source) {
  console.error(
    "usage: node scripts/vendor-aws-icons.mjs <path-to-package/icons>",
  );
  process.exit(1);
}

const dest = "apps/dashboard/public/aws-icons";

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

// The 26 hand-picked names are shorter and clearer than anything generated
// ("cloudfront", not "cloud-front"), and the architecture table refers to them.
// Their sources are skipped so one image never lands under two names.
const curated = new Map();
for (const file of readdirSync(dest).filter((f) => f.endsWith(".svg"))) {
  curated.set(sha(readFileSync(`${dest}/${file}`)), file.replace(/\.svg$/, ""));
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
