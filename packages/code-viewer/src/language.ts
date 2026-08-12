import type * as Monaco from "monaco-editor";

export const HCL_LANGUAGE_ID = "hcl";

type MonacoApi = typeof Monaco;

const extensionLanguageMap: Readonly<Record<string, string>> = {
  bash: "shell",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  cxx: "cpp",
  dockerfile: "dockerfile",
  go: "go",
  gql: "graphql",
  graphql: "graphql",
  h: "cpp",
  hcl: HCL_LANGUAGE_ID,
  hpp: "cpp",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  md: "markdown",
  mjs: "javascript",
  php: "php",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sass: "scss",
  scss: "scss",
  sh: "shell",
  sql: "sql",
  swift: "swift",
  tf: HCL_LANGUAGE_ID,
  tfvars: HCL_LANGUAGE_ID,
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  txt: "plaintext",
  yaml: "yaml",
  yml: "yaml",
};

const filenameLanguageMap: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
};

const configuredMonacoInstances = new WeakSet<MonacoApi>();

export function languageFromFilename(
  filename: string | undefined,
  fallback = "plaintext",
): string {
  const normalized = filename?.trim().toLowerCase();

  if (!normalized) {
    return fallback;
  }

  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? normalized;
  const languageByName = filenameLanguageMap[basename];

  if (languageByName) {
    return languageByName;
  }

  const extensionStart = basename.lastIndexOf(".");

  if (extensionStart < 0 || extensionStart === basename.length - 1) {
    return fallback;
  }

  const extension = basename.slice(extensionStart + 1);

  return extensionLanguageMap[extension] ?? fallback;
}

export function registerHclLanguage(monaco: MonacoApi): void {
  if (configuredMonacoInstances.has(monaco)) {
    return;
  }

  if (
    !monaco.languages
      .getLanguages()
      .some((language) => language.id === HCL_LANGUAGE_ID)
  ) {
    monaco.languages.register({
      id: HCL_LANGUAGE_ID,
      aliases: ["HCL", "Terraform", "tfvars"],
      extensions: [".hcl", ".tf", ".tfvars"],
      mimetypes: ["text/x-hcl", "text/x-terraform"],
    });
  }

  monaco.languages.setLanguageConfiguration(HCL_LANGUAGE_ID, {
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    comments: {
      lineComment: "//",
      blockComment: ["/*", "*/"],
    },
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
    ],
  });

  monaco.languages.setMonarchTokensProvider(HCL_LANGUAGE_ID, {
    defaultToken: "",
    tokenPostfix: ".hcl",
    brackets: [
      { open: "{", close: "}", token: "delimiter.curly" },
      { open: "[", close: "]", token: "delimiter.square" },
      { open: "(", close: ")", token: "delimiter.parenthesis" },
    ],
    keywords: ["true", "false", "null"],
    operators: [
      "=",
      "==",
      "!=",
      "<",
      ">",
      "<=",
      ">=",
      "+",
      "-",
      "*",
      "/",
      "%",
      "!",
      "&&",
      "||",
      "?",
      ":",
    ],
    symbols: /[=><!~?:&|+\-*/^%]+/,
    tokenizer: {
      root: [
        { include: "@whitespace" },
        [
          /<<-?\s*([A-Za-z_][\w-]*)/,
          { token: "string.heredoc.delimiter", next: "@heredoc.$1" },
        ],
        [/[A-Za-z_][\w-]*(?=\s*(?:"[^"]*"\s*)*\{)/, "type.identifier"],
        [/[A-Za-z_][\w-]*(?=\s*=)/, "attribute.name"],
        [/\$\{/, { token: "delimiter.bracket", next: "@interpolation" }],
        [
          /[A-Za-z_][\w-]*/,
          { cases: { "@keywords": "keyword", "@default": "identifier" } },
        ],
        [/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
        [/"/, { token: "string.quote", next: "@string" }],
        [/[{}()[\]]/, "@brackets"],
        [/@symbols/, { cases: { "@operators": "operator", "@default": "" } }],
        [/[,.]/, "delimiter"],
      ],
      whitespace: [
        [/[ \t\r\n]+/, "white"],
        [/#.*$/, "comment"],
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
      string: [
        [/\$\{/, { token: "delimiter.bracket", next: "@interpolation" }],
        [/[^\\"$]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, { token: "string.quote", next: "@pop" }],
        [/./, "string"],
      ],
      interpolation: [
        [/\}/, { token: "delimiter.bracket", next: "@pop" }],
        { include: "root" },
      ],
      heredoc: [
        [/^\s*$S2\s*$/, { token: "string.heredoc.delimiter", next: "@pop" }],
        [/.*$/, "string.heredoc"],
      ],
    },
  });

  configuredMonacoInstances.add(monaco);
}
