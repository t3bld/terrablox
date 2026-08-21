"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * An agent reply, rendered as the markdown it is.
 *
 * The model writes lists, bold names and inline code because that is how it
 * explains a change — six modules with their settings is a list, not a paragraph.
 * Printed as plain text it arrived full of asterisks and backticks, which is worse
 * than no formatting at all: the reader has to mentally strip the syntax.
 *
 * Tuned tighter than the README renderer. A chat bubble is a few hundred pixels
 * wide, so the generous vertical rhythm of a document page would leave the text
 * mostly whitespace.
 */
export function AgentMarkdown({ children }: { children: string }) {
  return (
    <div
      className="
        prose prose-sm dark:prose-invert max-w-none
        prose-p:my-2 prose-p:leading-6
        prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-li:leading-6
        prose-headings:mt-3 prose-headings:mb-1.5 prose-headings:text-sm
        prose-headings:font-semibold
        prose-strong:font-semibold
        prose-hr:my-3
        prose-a:font-medium prose-a:underline-offset-4
        prose-code:rounded prose-code:bg-black/5 prose-code:px-1
        prose-code:py-0.5 prose-code:font-normal prose-code:text-[0.85em]
        prose-code:before:content-none prose-code:after:content-none
        dark:prose-code:bg-white/10
        prose-pre:my-2 prose-pre:overflow-x-auto prose-pre:border
        prose-pre:bg-black/5 prose-pre:p-3 prose-pre:text-xs
        dark:prose-pre:bg-white/5
        prose-table:my-2 prose-table:text-xs
        prose-th:border prose-th:px-2 prose-th:py-1
        prose-td:border prose-td:px-2 prose-td:py-1
        prose-blockquote:my-2 prose-blockquote:not-italic
        break-words
        first:[&>*:first-child]:mt-0 last:[&>*:last-child]:mb-0
      "
    >
      <ReactMarkdown
        components={{
          // Anything the agent links to is outside this app.
          a: ({ href, children: label, ...rest }) => (
            <a {...rest} href={href} rel="noreferrer noopener" target="_blank">
              {label}
            </a>
          ),
          table: ({ children: rows, ...rest }) => (
            <div className="my-2 w-full overflow-x-auto">
              <table {...rest}>{rows}</table>
            </div>
          ),
        }}
        remarkPlugins={[remarkGfm]}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
