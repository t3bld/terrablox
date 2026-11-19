import { z } from "zod";
import {
  defaultPipelineSecret,
  LIBRARY_ID_PATTERN,
} from "@/lib/module-library/library-definition";

const ORG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const PREFIX_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const FOLDER_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const PIPELINE_SECRET_PATTERN = /^[A-Z][A-Z0-9_]{0,99}$/;

const name = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[\p{L}\p{N} ._()-]+$/u, "name contains unsupported characters");

const org = z.string().regex(ORG_PATTERN, "org is not a valid GitHub login");

const topics = z
  .array(
    z
      .string()
      .transform((topic) => topic.trim().toLowerCase())
      .pipe(z.string().regex(/^[a-z0-9][a-z0-9-]{0,49}$/, "invalid topic")),
  )
  .max(10)
  .transform((values) => [...new Set(values)]);

const prefix = z.string().regex(PREFIX_PATTERN, "invalid prefix").nullable();

const submoduleContainer = z
  .string()
  .regex(FOLDER_PATTERN, "invalid folder")
  .refine((folder) => !folder.split("/").includes(".."), "invalid folder")
  .nullable();

const pipelineSecret = z
  .string()
  .regex(PIPELINE_SECRET_PATTERN, "pipelineSecret must be UPPER_SNAKE_CASE")
  .refine(
    (secretName) => !secretName.startsWith("GITHUB_"),
    "GITHUB_ secrets are reserved",
  );

const needsSelection = (definition: {
  topics?: string[];
  prefix?: string | null;
}) => (definition.topics?.length ?? 0) > 0 || !!definition.prefix;

export const createLibraryBody = z
  .object({
    id: z
      .string()
      .regex(LIBRARY_ID_PATTERN, "id must match ^[a-z][a-z0-9-]{1,31}$"),
    name,
    scope: z.enum(["global", "user"]),
    visible: z.boolean().default(true),
    org,
    topics: topics.default([]),
    prefix: prefix.optional().default(null),
    publicOnly: z.boolean().optional(),
    submoduleContainer: submoduleContainer.optional().default(null),
    pipelineSecret: pipelineSecret.optional(),
  })
  .strict()
  .refine(needsSelection, {
    message:
      "needs at least one topic or a prefix, otherwise it would match every repository in the org",
  });

export const editLibraryBody = z
  .object({
    name: name.optional(),
    visible: z.boolean().optional(),
    org: org.optional(),
    topics: topics.optional(),
    prefix: prefix.optional(),
    publicOnly: z.boolean().optional(),
    submoduleContainer: submoduleContainer.optional(),
    pipelineSecret: pipelineSecret.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "No changes supplied.");

export const patchLibraryBody = editLibraryBody
  .safeExtend({ active: z.boolean().optional() })
  .refine((body) => Object.keys(body).length > 0, "No changes supplied.");

export type CreateLibraryBody = z.infer<typeof createLibraryBody>;
export type EditLibraryBody = z.infer<typeof editLibraryBody>;
export type PatchLibraryBody = z.infer<typeof patchLibraryBody>;

export function normalizedCreateData(body: CreateLibraryBody) {
  return {
    ...body,
    publicOnly: body.scope === "global" ? (body.publicOnly ?? true) : false,
    pipelineSecret: body.pipelineSecret ?? defaultPipelineSecret(body.id),
  };
}
