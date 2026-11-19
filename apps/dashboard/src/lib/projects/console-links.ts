/**
 * Deep links from the deploy configuration to the thing each value names.
 *
 * Every builder returns null rather than a guess when its input is not the shape
 * it expects. A link into somebody's AWS account that lands on an empty page
 * reads as "this resource is gone", which is worse than no link.
 *
 * The AWS console cannot be told which account to open: it uses whichever one
 * the browser is signed in to. The links name the region and the resource, and
 * the account shown beside them is what tells the reader where to sign in.
 */

const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

/** The console's host, which differs in the partitions that are separate AWS deployments. */
function consoleHost(region: string): string {
  if (region.startsWith("cn-")) return "console.amazonaws.cn";
  if (region.startsWith("us-gov-")) return "console.amazonaws-us-gov.com";
  return "console.aws.amazon.com";
}

/** `arn:partition:service:region:account:resource`, or null. */
function parseArn(arn: string | null | undefined): {
  service: string;
  region: string;
  account: string;
  resource: string;
} | null {
  if (!arn) return null;
  const parts = arn.split(":");
  if (parts.length < 6 || parts[0] !== "arn") return null;
  const [, , service = "", region = "", account = "", ...rest] = parts;
  return { service, region, account, resource: rest.join(":") };
}

/** The repository on its deployment branch. */
export function githubRepoUrl(
  repoFullName: string | null | undefined,
  branch: string | null | undefined,
): string | null {
  if (!repoFullName || !/^[\w.-]+\/[\w.-]+$/.test(repoFullName)) return null;
  const base = `https://github.com/${repoFullName}`;
  return branch
    ? `${base}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`
    : base;
}

/** The IAM role's detail page. IAM is global, so the link names no region. */
export function iamRoleConsoleUrl(
  roleArn: string | null | undefined,
): string | null {
  const arn = parseArn(roleArn);
  if (!arn || arn.service !== "iam" || !arn.resource.startsWith("role/")) {
    return null;
  }
  // A role with a path (`role/ci/name`) is still addressed by its name alone.
  const name = arn.resource.split("/").pop();
  if (!name) return null;
  const host = roleArn?.startsWith("arn:aws-cn:")
    ? "console.amazonaws.cn"
    : roleArn?.startsWith("arn:aws-us-gov:")
      ? "console.amazonaws-us-gov.com"
      : "console.aws.amazon.com";
  return `https://${host}/iam/home#/roles/details/${encodeURIComponent(name)}`;
}

/** The bucket's object listing. */
export function s3BucketConsoleUrl(
  bucket: string | null | undefined,
  region: string | null | undefined,
): string | null {
  if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    return null;
  }
  const query =
    region && REGION.test(region) ? `?region=${region}&tab=objects` : "";
  const host =
    region && REGION.test(region)
      ? `s3.${consoleHost(region)}`
      : "s3.console.aws.amazon.com";
  return `https://${host}/s3/buckets/${encodeURIComponent(bucket)}${query}`;
}

/**
 * The customer-managed key's detail page.
 *
 * The region comes from the ARN rather than the project's setting: a key lives
 * where it was created, and the setting may have been changed since.
 */
export function kmsKeyConsoleUrl(
  keyArn: string | null | undefined,
): string | null {
  const arn = parseArn(keyArn);
  if (!arn || arn.service !== "kms" || !REGION.test(arn.region)) return null;
  if (!arn.resource.startsWith("key/")) return null;
  const id = arn.resource.slice("key/".length);
  if (!id) return null;
  return `https://${arn.region}.${consoleHost(arn.region)}/kms/home?region=${arn.region}#/kms/keys/${encodeURIComponent(id)}`;
}
