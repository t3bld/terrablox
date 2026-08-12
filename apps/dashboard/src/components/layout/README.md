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
