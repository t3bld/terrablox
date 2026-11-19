import "server-only";

import { createHash } from "node:crypto";
import * as mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

import { database } from "@/lib/database";
import type { ProjectContextDocumentDto } from "@/lib/projects/types";

export const MAX_CONTEXT_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_CONTEXT_DOCUMENTS = 10;
export const CONTEXT_DOCUMENT_READ_CHARS = 20_000;
const PENDING_UPLOAD_HOURS = 24;

const MEDIA_TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
} as const;

type SupportedExtension = keyof typeof MEDIA_TYPES;

export class ContextDocumentError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ContextDocumentError";
  }
}

export interface ParsedContextDocument {
  originalName: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  content: Buffer;
  extractedText: string;
  characterCount: number;
}

function safeName(input: string): string {
  return (input.split(/[\\/]/).pop() ?? "document").trim().slice(0, 240);
}

function extensionOf(name: string): SupportedExtension | null {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  return extension in MEDIA_TYPES ? (extension as SupportedExtension) : null;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").split("\u0000").join("").trim();
}

function startsWith(bytes: Buffer, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

async function extractPdf(bytes: Buffer): Promise<string> {
  if (!startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    throw new ContextDocumentError("That file is not a valid PDF.");
  }

  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    const result = await parser.getText();
    return result.text;
  } catch {
    throw new ContextDocumentError(
      "The PDF could not be read. Password-protected PDFs are not supported.",
    );
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function extractDocx(bytes: Buffer): Promise<string> {
  if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    throw new ContextDocumentError(
      "That file is not a valid DOCX document. Save legacy .doc files as DOCX first.",
    );
  }

  try {
    const result = await mammoth.extractRawText({ buffer: bytes });
    return result.value;
  } catch {
    throw new ContextDocumentError("The DOCX document could not be read.");
  }
}

function extractPlainText(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ContextDocumentError("Text documents must use UTF-8 encoding.");
  }
}

/** Validates a file and extracts the deterministic plain text the agent reads. */
export async function parseContextDocument(
  file: File,
): Promise<ParsedContextDocument> {
  const originalName = safeName(file.name);
  const extension = extensionOf(originalName);

  if (!extension) {
    throw new ContextDocumentError(
      "Supported document types are PDF, DOCX, TXT and Markdown.",
    );
  }
  if (file.size === 0) {
    throw new ContextDocumentError("The document is empty.");
  }
  if (file.size > MAX_CONTEXT_DOCUMENT_BYTES) {
    throw new ContextDocumentError("A document may be at most 10 MB.", 413);
  }

  const content = Buffer.from(await file.arrayBuffer());
  const extracted =
    extension === "pdf"
      ? await extractPdf(content)
      : extension === "docx"
        ? await extractDocx(content)
        : extractPlainText(content);
  const extractedText = normalizeText(extracted);

  if (!extractedText) {
    throw new ContextDocumentError(
      extension === "pdf"
        ? "No readable text was found. Scanned PDFs need OCR and are not supported yet."
        : "No readable text was found in the document.",
    );
  }

  return {
    originalName,
    mediaType: MEDIA_TYPES[extension],
    byteSize: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
    content,
    extractedText,
    characterCount: extractedText.length,
  };
}

export function contextDocumentDto(row: {
  id: string;
  projectId: string | null;
  originalName: string;
  mediaType: string;
  byteSize: number;
  characterCount: number;
  createdAt: Date;
}): ProjectContextDocumentDto {
  return {
    id: row.id,
    name: row.originalName,
    mediaType: row.mediaType,
    byteSize: row.byteSize,
    characterCount: row.characterCount,
    createdAt: row.createdAt.toISOString(),
    downloadUrl: row.projectId
      ? `/api/projects/${row.projectId}/documents/${row.id}`
      : null,
  };
}

export async function removeExpiredPendingDocuments(): Promise<void> {
  await database.projectContextDocument
    .deleteMany({
      where: { projectId: null, expiresAt: { lt: new Date() } },
    })
    .catch(() => undefined);
}

export async function createPendingContextDocument(
  userId: string,
  parsed: ParsedContextDocument,
) {
  await removeExpiredPendingDocuments();

  const pendingCount = await database.projectContextDocument.count({
    where: { userId, projectId: null, expiresAt: { gt: new Date() } },
  });
  if (pendingCount >= MAX_CONTEXT_DOCUMENTS) {
    throw new ContextDocumentError(
      `At most ${MAX_CONTEXT_DOCUMENTS} documents may be staged at once.`,
      409,
    );
  }

  return database.projectContextDocument.create({
    data: {
      userId,
      ...parsed,
      expiresAt: new Date(Date.now() + PENDING_UPLOAD_HOURS * 60 * 60 * 1000),
    },
  });
}

export async function createProjectContextDocument(
  userId: string,
  projectId: string,
  parsed: ParsedContextDocument,
) {
  const count = await database.projectContextDocument.count({
    where: { projectId },
  });
  if (count >= MAX_CONTEXT_DOCUMENTS) {
    throw new ContextDocumentError(
      `A project may have at most ${MAX_CONTEXT_DOCUMENTS} context documents.`,
      409,
    );
  }

  return database.projectContextDocument.create({
    data: { userId, projectId, ...parsed, expiresAt: null },
  });
}

/** Reads one bounded slice for the agent; the original extraction remains whole. */
export async function readContextDocumentSlice(
  projectId: string,
  documentId: string,
  offset: number,
) {
  const document = await database.projectContextDocument.findFirst({
    where: { id: documentId, projectId },
    select: { originalName: true, mediaType: true, extractedText: true },
  });
  if (!document) return null;

  const start = Math.min(Math.max(0, offset), document.extractedText.length);
  const end = Math.min(
    document.extractedText.length,
    start + CONTEXT_DOCUMENT_READ_CHARS,
  );

  return {
    name: document.originalName,
    mediaType: document.mediaType,
    content: document.extractedText.slice(start, end),
    offset: start,
    nextOffset: end < document.extractedText.length ? end : null,
    totalCharacters: document.extractedText.length,
  };
}

/** Reads the one-file multipart request without letting it exceed the file cap. */
export async function contextDocumentFile(request: Request): Promise<File> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_CONTEXT_DOCUMENT_BYTES + 1024 * 1024
  ) {
    throw new ContextDocumentError("A document may be at most 10 MB.", 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ContextDocumentError("Expected a multipart document upload.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new ContextDocumentError("Choose a document to upload.");
  }
  return file;
}
