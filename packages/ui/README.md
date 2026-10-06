# @terrablox/ui

The design system. Every app in this repo takes its tokens, its Tailwind preset
and its components from here, so they cannot drift apart.

## The tokens live in exactly one file

`src/styles/styles.css` defines the palette, the radius, the Tailwind directives
and the shared base rules. An app's own stylesheet is expected to contain one
line:

```css
@import "@terrablox/ui/styles.css";
```

This is not a style preference. When the dashboard redefined the same custom
properties locally, both blocks shipped and the cascade decided the winner — so
the values in this package were dead code, and a second app importing them would
have rendered a different palette than the product it was advertising. Adding a
colour means editing the preset, never an app.

The `@tailwind` directives are here for the same reason: they expand to the whole
generated framework, and a second copy in an app emits it twice.

## What belongs here

The test is whether a second app would render it **unchanged and with the same
meaning**.

- Yes → this package. `TabsNav`, `WizardSteps`, `InfoHint`, `NavigationProgress`,
  `ComingLater` all pass: a marketing page has tabs, steps and hints too.
- No → the app. `PageHeader` is breadcrumbs plus a sidebar trigger, `PageSkeleton`
  is a loading state, `AgentMarkdown` is tuned to the width of a chat bubble.
  Each of those would have exactly one consumer here, which is a shared component
  in name only.

`apps/dashboard/src/components/layout/README.md` applies the same rule from the
app's side.

## Conventions

- **Subpath imports only** (`@terrablox/ui/button`). There is no barrel file, so
  a page pulls in the components it names and nothing else.
- **Components import each other relatively** (`./button`), never through the
  package name — that would resolve back out through `exports` and make the
  package depend on itself.
- **No app knowledge.** No database types, no API routes, no app URLs. `next` is a
  peer dependency, used only by `NavigationProgress`, which needs `usePathname`.
