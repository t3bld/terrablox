"use client";

import type { CSSProperties } from "react";

export interface CodeViewerFileItem {
  path: string;
  label?: string;
  disabled?: boolean;
}

export interface CodeViewerFileListProps {
  files: readonly CodeViewerFileItem[];
  selectedPath?: string;
  onSelect: (file: CodeViewerFileItem) => void;
  className?: string;
  style?: CSSProperties;
  buttonClassName?: string;
  selectedButtonClassName?: string;
}

const listStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const buttonStyle: CSSProperties = {
  background: "transparent",
  border: 0,
  borderRadius: 6,
  color: "inherit",
  cursor: "pointer",
  font: "inherit",
  overflow: "hidden",
  padding: "6px 8px",
  textAlign: "left",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const selectedButtonStyle: CSSProperties = {
  background: "hsl(var(--accent, 210 40% 96%))",
};

export function CodeViewerFileList({
  files,
  selectedPath,
  onSelect,
  className,
  style,
  buttonClassName,
  selectedButtonClassName,
}: CodeViewerFileListProps) {
  return (
    <nav
      aria-label="Code files"
      className={className}
      style={{ ...listStyle, ...style }}
    >
      {files.map((file) => {
        const selected = file.path === selectedPath;

        return (
          <button
            aria-current={selected ? "page" : undefined}
            className={
              selected
                ? (selectedButtonClassName ?? buttonClassName)
                : buttonClassName
            }
            disabled={file.disabled}
            key={file.path}
            onClick={() => onSelect(file)}
            style={
              selected
                ? { ...buttonStyle, ...selectedButtonStyle }
                : buttonStyle
            }
            title={file.path}
            type="button"
          >
            {file.label ?? file.path}
          </button>
        );
      })}
    </nav>
  );
}
