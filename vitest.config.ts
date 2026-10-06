import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";

/**
 * Resolves `import "server-only"` to nothing while tests run.
 *
 * That import has no runtime behaviour. It exists so a bundler fails the build when a
 * client component pulls in a module that must never reach the browser, and the real
 * package resolves to something that *throws* outside a server build — which is exactly
 * what a Node test looks like.
 *
 * Stubbing it does not weaken the guarantee: `next build` and `tsc` still see the real
 * package, and they are what enforce it. This only lets a test import the server half of
 * a module to exercise the pure functions inside it, which is where the logic worth
 * testing has ended up.
 *
 * A plugin rather than `resolve.alias` because an alias declared alongside `projects` is
 * not applied to them, and a silent no-op is worse than a slightly longer config.
 */
function stubServerOnly(): Plugin {
  const virtual = "\0terrablox:server-only";

  return {
    name: "terrablox:stub-server-only",
    enforce: "pre",
    resolveId: (id) => (id === "server-only" ? virtual : null),
    load: (id) => (id === virtual ? "export {};" : null),
  };
}

/**
 * One test runner for the whole monorepo.
 *
 * A single config rather than one per workspace: every test here is a unit test over a
 * pure function, so there is nothing per-package to configure, and a contributor should
 * not have to find out which of eight directories holds the settings for the file they
 * just wrote.
 *
 * Two projects rather than one, and the reason is the boundary this repo is built on.
 * The dashboard resolves `@/…` to its own source; nothing else may, because a library that
 * reaches into the app is the one dependency direction that would make the libraries
 * pointless. Giving only the dashboard project that alias means such an import fails here
 * as well as in `tsc`, rather than quietly working in tests and breaking on build.
 *
 * The split is by that alias, not by directory — which is why the second project reaches
 * into `apps/` for one workspace. See its own comment.
 *
 * `node` environment throughout. Nothing under test touches the DOM — the React
 * components are deliberately thin, and the logic worth testing was moved out of them
 * into modules that need no browser. If that changes, the component project gets its own
 * entry with `environment: "jsdom"` rather than all of them paying for a DOM they do not
 * use.
 *
 * Vitest does not type-check. It does not need to: the tests live inside each
 * workspace's `tsconfig`, so `pnpm type-check` covers them, and it has already caught
 * assertions written against an API that had moved on.
 */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [stubServerOnly()],
        resolve: {
          alias: {
            "@": fileURLToPath(
              new URL("./apps/dashboard/src", import.meta.url),
            ),
          },
        },
        test: {
          name: "dashboard",
          environment: "node",
          include: ["apps/dashboard/src/**/*.test.ts"],
        },
      },
      {
        plugins: [stubServerOnly()],
        test: {
          name: "libraries",
          environment: "node",
          include: [
            "packages/*/src/**/*.test.ts",
            // The MCP server sits under `apps/` so the dashboard's Docker image excludes
            // it — the runtime stage copies `packages/` wholesale but only
            // `apps/dashboard`. In every other respect it belongs here: it declares no
            // `@/` alias and must not reach into the dashboard, so it gets the same
            // alias-free resolution the packages get. Named by that property rather than
            // by the folder, which is why this project is no longer called "packages".
            "apps/mcp-server/src/**/*.test.ts",
          ],
          // The packages are being extracted one at a time; an empty project is a
          // truthful state, not a failure.
          passWithNoTests: true,
        },
      },
    ],
  },
});
