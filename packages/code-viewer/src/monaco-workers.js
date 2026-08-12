let workersConfigured = false;

/**
 * Points Monaco at its editor worker.
 *
 * The specifier must stay relative: webpack only treats `new URL(...,
 * import.meta.url)` as an asset reference for relative paths, and a bare
 * `monaco-editor/...` specifier fails to resolve at build time. `monaco-editor`
 * is a direct dependency of this package, so pnpm always links it into
 * `packages/code-viewer/node_modules`, which is what this path targets.
 */
export function configureMonacoWorkers() {
  if (typeof window === "undefined" || workersConfigured) {
    return;
  }

  window.MonacoEnvironment = {
    ...(window.MonacoEnvironment ?? {}),
    getWorker() {
      return new Worker(
        new URL(
          "../node_modules/monaco-editor/esm/vs/editor/editor.worker.js",
          import.meta.url,
        ),
        // No `type: "module"`: webpack emits a classic IIFE bundle here, and a
        // module worker would forbid the importScripts() it uses for chunks.
        { name: "monaco-editor-worker" },
      );
    },
  };

  workersConfigured = true;
}
