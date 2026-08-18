# Layout primitives

Every screen in the app shell is assembled from the components in this folder.
They exist so that pages cannot drift apart visually: the header height, the
sidebar toggle, the breadcrumb trail and the tab styling are decided once, here.

## Rules

1. **Never hand-roll a `<header>` in a page.** Use `PageHeader`.
2. **The sidebar toggle lives in the sidebar**, in `AppSidebar`'s header. The
   `SidebarTrigger` inside `PageHeader` is `md:hidden` on purpose: on mobile the
   sidebar is an overlay and cannot hold its own opener. Do not make it visible
   on desktop — there would be two toggles for one thing.
3. **Breadcrumbs instead of back buttons.** The trail (`Projects / My project`)
   tells the user where they are *and* takes them back. A lone back arrow only
   does the second half.
4. **Actions belong in `actions`**, right-aligned. Secondary information goes
   into `meta`, not into the title.
5. **Never hand-roll a tab strip.** Use `TabsNav` for the buttons and spread
   `tabPanelProps(idPrefix, value)` on every panel — that is what wires up
   `role="tablist"`, arrow-key navigation and `aria-labelledby`.
6. **New variant needed? Add it here, not in the page.** If a screen needs
   something the primitive cannot do, extend the primitive so every other screen
   inherits the improvement.
7. **Use design tokens** (`text-muted-foreground`, `border`, `bg-primary/5`,
   `@terrablox/ui` components), never raw hex colours or one-off pixel values.

## Loading strategy

A navigation has three phases. Each one needs its own answer, and all three are
built the same way on every screen.

| Phase | What the user waits for | What covers it |
| --- | --- | --- |
| Click → route commits | The router resolving and fetching the segment | `NavigationProgress` |
| Segment renders | The `loading.tsx` boundary | `PageSkeleton` |
| Page fetches its data | The page's own `fetch` | The same skeleton, in the page |

Rules:

1. **Every route gets a `loading.tsx`.** Without it the previous page stays
   frozen on screen for the whole navigation.
2. **Build it from `PageSkeleton`**, so the sidebar and header stay put and only
   the body swaps. A skeleton that re-renders the shell reads as a second page
   load.
3. **The route skeleton and the in-page loading state must be the same
   component.** They run back to back; differing layouts read as a flicker.
   `ModuleDetailSkeleton` is the reference case.
4. **Never `return null` while something loads.** A blank screen is the one
   state that looks broken rather than busy. Render the skeleton instead.
5. **Skeletons, not spinners**, wherever the final layout is known — they show
   what is coming and avoid the layout shift a spinner leaves behind.
6. `NavigationProgress` waits ~120ms before appearing, so navigations that are
   already instant do not flash a bar.


## Usage

```tsx
<SidebarProvider>
  <AppSidebar />
  <SidebarInset>
    <PageHeader
      loading={loading}
      breadcrumbs={[
        { label: "Projects", href: "/projects" },
        { label: project?.name ?? "Project" },
      ]}
      meta={<RepoLink />}
      actions={<Button size="sm">Deploy</Button>}
    />

    <TabsNav
      tabs={TABS}
      value={tab}
      onChange={setTab}
      idPrefix="project"
      label="Project views"
    />

    <main {...tabPanelProps("project", tab)}>…</main>
  </SidebarInset>
</SidebarProvider>
```

`TABS` is a module-level constant so it is not re-created on every render:

```tsx
const TABS: TabDefinition<ProjectTab>[] = [
  { value: "code", label: "Code", icon: Workflow },
  { value: "deploy", label: "Deploy", icon: Rocket },
  { value: "state", label: "State", icon: Layers, count: resources.length },
];
```

## Review checklist

- [ ] Page uses `PageHeader`, no local `<header>` element.
- [ ] Last breadcrumb is the current page and has no `href`.
- [ ] Tabs use `TabsNav` + `tabPanelProps`.
- [ ] No duplicated `<h1>` inside the page body — the header owns the title.
- [ ] No raw colours, spacing follows the existing pages (`p-4`, `gap-2`).
