"use client";

export type { CodeViewerProps, CodeViewerTheme } from "./code-viewer";
export { CodeViewer } from "./code-viewer";
export type { CodeViewerFileItem, CodeViewerFileListProps } from "./file-list";
export { CodeViewerFileList } from "./file-list";
export {
  HCL_LANGUAGE_ID,
  languageFromFilename,
  registerHclLanguage,
} from "./language";
