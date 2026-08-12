---
applyTo: "apps/dashboard/src/**/*.tsx"
---

# Dashboard UI conventions

Read `apps/dashboard/src/components/layout/README.md` before building or
changing a screen. The short version:

- Every page in the app shell renders `<PageHeader …/>` from
  `@/components/layout/page-header`. Do not write a local `<header>` element.
- The sidebar toggle belongs in `AppSidebar`, not in the page header. The
  `SidebarTrigger` inside `PageHeader` is deliberately `md:hidden` — on mobile
  the sidebar is an overlay and cannot hold its own opener. Do not add a second
  trigger.
- Navigation upwards is expressed with the `breadcrumbs` prop, not with a back
  button. The last breadcrumb is the current page and carries no `href`.
- Tab strips use `TabsNav` + `tabPanelProps` from
  `@/components/layout/tabs-nav`. They provide the ARIA roles and arrow-key
  navigation; a hand-written row of buttons does not.
- Primitives come from `@terrablox/ui` (`Button`, `Badge`, `Card`, `Input`,
  `Skeleton`, …). Add a missing primitive to that package instead of styling a
  raw element in a page.
- Style with design tokens (`text-muted-foreground`, `border`, `bg-muted`,
  `bg-primary/5`). No raw hex colours, no ad-hoc pixel sizes.
- If a screen needs a header or tab variant that does not exist yet, extend the
  shared component so every other screen benefits — never fork it into a page.
- Comments explain *why*, in one line where possible.

Verification before you call a UI change done:

```bash
pnpm exec biome check --write <touched paths>
cd apps/dashboard && pnpm exec tsc --noEmit
```
