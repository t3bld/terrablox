import { z } from "zod";

/**
 * The shapes more than one route needs, and the patterns that keep user text out of
 * generated infrastructure code.
 *
 * The AWS field patterns are not only input hygiene. `stateBucket` and
 * `stateKmsKeyArn` are interpolated into a `backend.tf` that Terrablox commits and
 * that `terraform init` then reads, and `projectName` reaches a CloudFormation
 * template. Anything unvalidated there is template injection into a file the user is
 * told to trust — so the constraint belongs next to the other AWS patterns rather
 * than at the renderer, where it would be one guard away from being forgotten.
 */

/** `arn:aws:iam::123456789012:role/deploy`, including the China/GovCloud partitions. */
export const roleArn = z
  .string()
  .trim()
  .regex(
    /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/,
    "Expected an IAM role ARN, e.g. arn:aws:iam::123456789012:role/deploy",
  );

export const accountId = z
  .string()
  .trim()
  .regex(/^\d{12}$/, "An AWS account ID is 12 digits");

export const region = z
  .string()
  .trim()
  .regex(
    /^[a-z]{2}(-[a-z]+)+-\d$/,
    "Expected an AWS region, e.g. eu-central-1",
  );

/**
 * S3 bucket naming rules, as AWS enforces them.
 *
 * 3–63 characters, lower case, digits, dots and hyphens, starting and ending
 * alphanumeric. The pattern is what stops a quote or a newline from closing the HCL
 * string this value lands in.
 */
export const bucketName = z
  .string()
  .trim()
  .min(3, "A bucket name is at least 3 characters")
  .max(63, "A bucket name is at most 63 characters")
  .regex(
    /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/,
    "A bucket name may only contain lower-case letters, digits, dots and hyphens",
  )
  // `192.168.0.1` is a valid-looking name AWS rejects, and the error it returns is
  // reported against the stack rather than the field.
  .refine((value) => !/^\d+\.\d+\.\d+\.\d+$/.test(value), {
    message: "A bucket name may not look like an IP address",
  });

/** `arn:aws:kms:eu-central-1:123456789012:key/<uuid>`, or an alias ARN. */
export const kmsKeyArn = z
  .string()
  .trim()
  .regex(
    /^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:(key\/[a-fA-F0-9-]+|alias\/[\w/_-]+)$/,
    "Expected a KMS key ARN, e.g. arn:aws:kms:eu-central-1:123456789012:key/…",
  );

/**
 * `owner/repo`.
 *
 * Both halves are path segments in every GitHub API URL built from this value, so the
 * character class matters: a slash or a `..` would move the request to a different
 * endpoint. GitHub's own rules are stricter than this, but this is enough to keep the
 * value inside one path segment each side.
 */
export const repoFullName = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/,
    "Expected a repository as owner/name",
  )
  .refine((value) => !value.includes(".."), {
    message: "Expected a repository as owner/name",
  });

/**
 * A git ref: branch, tag or release name.
 *
 * Permissive on purpose — refs legitimately contain slashes (`release/1.2`) — but no
 * control characters and no `..`, which git itself forbids and which would otherwise
 * traverse when the value is used as a path segment.
 */
export const gitRef = z
  .string()
  .trim()
  .min(1)
  .max(255)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  .refine((value) => !/[\x00-\x1f\x7f~^:?*[\\]/.test(value), {
    message: "That is not a valid git ref",
  })
  .refine((value) => !value.includes(".."), {
    message: "That is not a valid git ref",
  });

/**
 * Free text a person typed, e.g. a project name or a description.
 *
 * Capped rather than pattern-matched: these are display strings and restricting the
 * characters would reject legitimate names in any language. The cap is what stops an
 * unbounded string from being persisted, and callers that interpolate the value into
 * generated code slugify it rather than relying on this.
 */
export function displayText(max = 200) {
  return z.string().trim().min(1).max(max);
}

/** The same, but where clearing the field is meaningful. `""` becomes null. */
export function optionalText(max = 2000) {
  return z
    .string()
    .max(max)
    .transform((value) => value.trim() || null)
    .nullable();
}

/** A repository-relative folder, e.g. `modules/vpc` or `.`. */
export const relativeFolder = z
  .string()
  .trim()
  .max(400)
  .refine((value) => !value.startsWith("/"), {
    message: "Expected a repository-relative path",
  })
  .refine((value) => !value.split("/").includes(".."), {
    message: "A path may not contain ..",
  })
  // A newline here would break out of the `working-directory:` scalar in the
  // generated workflow YAML.
  .refine((value) => !/[\r\n]/.test(value), {
    message: "Expected a single-line path",
  });

/** Canvas coordinates. Finite, so a NaN cannot reach the database. */
export const position = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

/** Tag lists, deduplicated and bounded on both axes. */
export const tags = z
  .array(z.string().trim().min(1).max(60))
  .max(40, "That is more tags than a module needs")
  .transform((values) => [...new Set(values)]);
