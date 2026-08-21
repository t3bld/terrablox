/**
 * Installs the resolve hook from {@link ./resolve-hook.mjs} for the main thread.
 *
 * Separate file because `module.register` has to run before the entry point is
 * loaded, which `node --import` guarantees and a plain import in the script would
 * not: by the time the script's own body runs, its static imports are resolved.
 */

import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./resolve-hook.mjs", pathToFileURL(import.meta.filename));
