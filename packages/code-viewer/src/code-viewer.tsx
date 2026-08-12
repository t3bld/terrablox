"use client";

import Editor, {
  type BeforeMount,
  type EditorProps,
  loader,
  type OnMount,
} from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import { languageFromFilename, registerHclLanguage } from "./language";
import { configureMonacoWorkers } from "./monaco-workers";

loader.config({ monaco });
configureMonacoWorkers();

export type CodeViewerTheme = "auto" | "light" | "dark";

export interface CodeViewerProps {
  value: string;
  language?: string;
  filename?: string;
  height?: number | string;
  theme?: CodeViewerTheme;
  wordWrap?: "off" | "on" | "wordWrapColumn" | "bounded";
  className?: string;
  style?: CSSProperties;
  loading?: ReactNode;
  options?: EditorProps["options"];
  beforeMount?: BeforeMount;
  onMount?: OnMount;
}

function rootHasDarkClass(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
  );
}

function useMonacoTheme(theme: CodeViewerTheme): "vs" | "vs-dark" {
  const [rootIsDark, setRootIsDark] = useState(rootHasDarkClass);

  useEffect(() => {
    if (theme !== "auto") {
      return;
    }

    const root = document.documentElement;
    const updateTheme = () => setRootIsDark(root.classList.contains("dark"));
    const observer = new MutationObserver(updateTheme);

    updateTheme();
    observer.observe(root, { attributeFilter: ["class"], attributes: true });

    return () => observer.disconnect();
  }, [theme]);

  if (theme === "dark") {
    return "vs-dark";
  }

  if (theme === "light") {
    return "vs";
  }

  return rootIsDark ? "vs-dark" : "vs";
}

export function CodeViewer({
  value,
  language,
  filename,
  height = "100%",
  theme = "auto",
  wordWrap = "on",
  className,
  style,
  loading,
  options,
  beforeMount,
  onMount,
}: CodeViewerProps) {
  const resolvedLanguage = language ?? languageFromFilename(filename);
  const resolvedTheme = useMonacoTheme(theme);
  const editorOptions = useMemo<EditorProps["options"]>(() => {
    const mergedOptions: EditorProps["options"] = {
      automaticLayout: true,
      folding: true,
      lineNumbers: "on",
      minimap: { enabled: false },
      renderLineHighlight: "none",
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      // Monaco pins the enclosing block to the top edge while scrolling. In a
      // read-only viewer that only costs a line of code behind a shadow.
      stickyScroll: { enabled: false },
      wordWrap,
      ...(options ?? {}),
      readOnlyMessage: { value: "This viewer is read-only." },
    };

    mergedOptions.readOnly = true;
    mergedOptions.domReadOnly = true;

    return mergedOptions;
  }, [options, wordWrap]);

  const handleBeforeMount: BeforeMount = (monacoInstance) => {
    registerHclLanguage(monacoInstance);
    beforeMount?.(monacoInstance);
  };

  return (
    // The height must live on this wrapper: Monaco's own container is sized in
    // percent, which collapses to zero unless an ancestor has a real height.
    <div className={className} style={{ height, ...style }}>
      <Editor
        beforeMount={handleBeforeMount}
        height="100%"
        language={resolvedLanguage}
        loading={loading}
        onMount={onMount}
        options={editorOptions}
        path={filename}
        theme={resolvedTheme}
        value={value}
      />
    </div>
  );
}
