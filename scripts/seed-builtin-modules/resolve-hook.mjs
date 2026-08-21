/**
 * Makes the dashboard's server modules importable from a plain Node script.
 *
 * The seeding script reuses the very same import pipeline the app uses, which is
 * the whole point — a second pipeline for the shipped catalogue would be a second
 * Terraform parser to keep in step. But that pipeline is written for Next, so
 * three things have to be taught to Node:
 *
 *   - `@/…` is the dashboard's `src/…`, which normally only tsconfig and Next
 *     know about.
 *   - TypeScript source omits file extensions on relative imports (`./references`
 *     rather than `./references.ts`). Node's ESM resolver requires them.
 *   - `server-only` is a package whose entire job is to throw outside a React
 *     server bundle. Under Next it resolves to an empty module through the
 *     `react-server` export condition; here it is mapped to an empty module
 *     directly, so the guard keeps working for the app while a deliberate,
 *     server-side script can still run.
 *
 * A resolve hook rather than a bundler: it needs no dependency, and TypeScript
 * itself is handled by Node's built-in type stripping.
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboardSrc = path.resolve(here, "../../apps/dashboard/src");

/** `server-only` becomes this: a module that exports nothing and throws nothing. */
const EMPTY_MODULE = "data:text/javascript,export {};";

const EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs"];

/**
 * The file a bundler would pick for an extension-less path.
 *
 * Tries the path as given, then each extension, then the directory's `index`,
 * which is the order tsconfig's `moduleResolution: bundler` uses.
 */
function probeFile(basePath) {
  if (existsSync(basePath) && statSync(basePath).isFile()) return basePath;

  for (const extension of EXTENSIONS) {
    const candidate = `${basePath}${extension}`;
    if (existsSync(candidate)) return candidate;
  }

  for (const extension of EXTENSIONS) {
    const candidate = path.join(basePath, `index${extension}`);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only" || specifier === "client-only") {
    return { url: EMPTY_MODULE, shortCircuit: true, format: "module" };
  }

  if (specifier.startsWith("@/")) {
    const resolved = probeFile(
      path.join(dashboardSrc, specifier.slice("@/".length)),
    );
    if (resolved) {
      return { url: pathToFileURL(resolved).href, shortCircuit: true };
    }
  }

  // Relative imports inside the app's own TypeScript, e.g. `./references`.
  // Only attempted when the parent is a file so the join has a real base.
  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    const parentDir = path.dirname(fileURLToPath(context.parentURL));
    const resolved = probeFile(path.resolve(parentDir, specifier));
    if (resolved) {
      return { url: pathToFileURL(resolved).href, shortCircuit: true };
    }
  }

  return nextResolve(specifier, context);
}
