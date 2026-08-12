# @terrablox/code-viewer

Read-only Monaco-based source viewer for Terrablox packages. Monaco is bundled from the local `monaco-editor` dependency; the package configures `@monaco-editor/react` with `loader.config({ monaco })` so it does not load from jsDelivr or another CDN. It also registers Monaco's basic editor worker with webpack 5's `new Worker(new URL(..., import.meta.url))` pattern, guarded so setup only runs in the browser.

## API

```tsx
import { CodeViewer, CodeViewerFileList, languageFromFilename } from "@terrablox/code-viewer";
```

- `CodeViewer`: renders a single read-only source file.
  - `value: string`
  - `language?: string`
  - `filename?: string` infers the Monaco language when `language` is omitted
  - `height?: string | number` defaults to `"100%"`
  - `theme?: "auto" | "light" | "dark"` defaults to `"auto"`; auto watches `document.documentElement.classList` for Tailwind's `dark` class
  - `wordWrap?: "off" | "on" | "wordWrapColumn" | "bounded"` defaults to `"on"`
  - `options?: EditorProps["options"]` for additional Monaco options; read-only mode is always enforced
- `languageFromFilename(filename, fallback?)`: maps common extensions to Monaco language ids. `.tf`, `.tfvars`, and `.hcl` map to the package's `hcl` language.
- `CodeViewerFileList`: optional presentational file list. It takes `files`, `selectedPath`, and `onSelect`; it contains no fetching or API logic.

## Next.js App Router usage

Monaco is browser-only. In `apps/dashboard`, import it from a Client Component with SSR disabled:

```tsx
"use client";

import dynamic from "next/dynamic";

const CodeViewer = dynamic(
  () => import("@terrablox/code-viewer").then((mod) => mod.CodeViewer),
  { ssr: false },
);

export function SourcePanel({ code, filename }: { code: string; filename: string }) {
  return <CodeViewer value={code} filename={filename} height="70vh" />;
}
```

Also add the workspace package to Next's transpilation list:

```mjs
const nextConfig = {
  transpilePackages: [
    "@terrablox/auth",
    "@terrablox/database",
    "@terrablox/git-import",
    "@terrablox/ui",
    "@terrablox/code-viewer",
  ],
};
```

No custom webpack rule is required for the bundled editor worker.

## HCL/Terraform highlighting

Monaco does not ship a Terraform/HCL language. This package registers a small Monarch tokenizer for common HCL constructs: block headers, attributes, strings, heredocs, line and block comments, numbers, booleans, and `${...}` interpolation.
