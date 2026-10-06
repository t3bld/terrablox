import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AWS_ICON_NAMES } from "@terrablox/terraform/aws-icon-manifest";
import { describe, expect, it } from "vitest";

/**
 * The icon manifest against the icons themselves.
 *
 * `AWS_ICON_NAMES` is a generated list of the files in `public/aws-icons`, and it exists
 * because the resolver runs in the browser and cannot look at a filesystem. That makes it
 * a copy, and a copy of 800 filenames with no check is a copy that drifts: a name removed
 * from the folder renders as a broken image, and one added without regenerating is an
 * icon nobody can select.
 *
 * The test lives in the app rather than in `@terrablox/terraform` on purpose. The package
 * holds the list and must not reach into the app's assets — that is the whole point of the
 * boundary. This is the one place where both sides are visible, so this is where they can
 * be compared.
 */

const ICON_DIR = fileURLToPath(
  new URL("../../../public/aws-icons", import.meta.url),
);

const onDisk = new Set(
  readdirSync(ICON_DIR)
    .filter((name) => name.endsWith(".svg"))
    .map((name) => name.slice(0, -".svg".length)),
);

describe("the AWS icon manifest", () => {
  it("finds the icon folder at all", () => {
    // Guards the guard: a wrong relative path would make every assertion below pass
    // against an empty set.
    expect(onDisk.size).toBeGreaterThan(100);
  });

  it("names only icons that exist", () => {
    // A name here that has no file is a broken image in somebody's module list.
    const missing = AWS_ICON_NAMES.filter((name) => !onDisk.has(name));
    expect(missing).toEqual([]);
  });

  it("names every icon that exists", () => {
    // A file that the manifest does not list cannot be chosen, so shipping it was
    // wasted — and it usually means the generator was not re-run.
    const unlisted = [...onDisk].filter(
      (name) => !AWS_ICON_NAMES.includes(name),
    );
    expect(unlisted).toEqual([]);
  });

  it("lists each name once", () => {
    expect(new Set(AWS_ICON_NAMES).size).toBe(AWS_ICON_NAMES.length);
  });

  it("stays sorted, so a regeneration is a readable diff", () => {
    expect([...AWS_ICON_NAMES]).toEqual([...AWS_ICON_NAMES].sort());
  });
});
