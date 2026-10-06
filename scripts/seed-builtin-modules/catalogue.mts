/**
 * What the shipped catalogue *is*: which repositories, and what to call them.
 *
 * Extracted from `main.mts` when a second script needed the same answers — the
 * website's catalogue snapshot, which reads the same repositories and must show the
 * same names. `SERVICE_NAMES` in two places would be fifty entries that drift, and
 * the drift would show up as the library and the marketing page disagreeing about
 * what a module is called.
 *
 * No database and no Prisma import: this is the GitHub half, and the snapshot
 * generator has no database at all.
 */

import { pickLatest } from "@terrablox/terraform/versions";

/** Which repositories make up the catalogue. */
export const ORG = process.env.TERRABLOX_BUILTIN_ORG ?? "terrablox";
export const PREFIX = process.env.TERRABLOX_BUILTIN_PREFIX ?? "terrablox-aws-";

/**
 * Where submodules live in these repositories.
 *
 * `terraform-aws-modules` repos put each submodule in its own folder under
 * `modules/`, and the pipeline treats a folder with no `.tf` of its own as a
 * container and imports each child. One value covers the whole catalogue.
 */
export const SUBMODULE_CONTAINER = "modules";

/**
 * The only tag on a shipped source, so the modules page can filter to the
 * catalogue in one click.
 *
 * One tag rather than several. `aws` said nothing when every module in the
 * catalogue is AWS, `built-in` duplicated a fact the row already carries in its
 * null owner, and a per-service tag repeated the name right next to the name.
 * Three tags on every card is three things to read past.
 */
export const CATALOGUE_TAGS = ["terrablox"];

/**
 * Service slug to the name AWS uses for that service.
 *
 * By hand, because there is no rule to derive it: `apigateway-v2` is API Gateway,
 * `wafv2` is WAF, `elasticache` capitalises in the middle, and `fsx` is FSx. Any
 * mechanical transform would produce "Apigateway V2" and be wrong in a way that
 * looks careless on the busiest line of the library.
 *
 * The vendor prefix is dropped — `Amazon`/`AWS` on all fifty entries is fifty
 * repetitions of nothing. Services AWS itself brands by acronym keep the acronym,
 * because "VPC" is what the person scanning the list is looking for and
 * "Virtual Private Cloud" is what they would have to read to find it.
 */
export const SERVICE_NAMES: Readonly<Record<string, string>> = {
  acm: "Certificate Manager",
  alb: "Application Load Balancer",
  apigateway: "API Gateway",
  "app-runner": "App Runner",
  appconfig: "AppConfig",
  appsync: "AppSync",
  autoscaling: "EC2 Auto Scaling",
  batch: "Batch",
  cloudfront: "CloudFront",
  cloudwatch: "CloudWatch",
  // Not an AWS service: the module ships Lambda functions that forward logs to
  // Datadog, and calling it anything else would misfile it.
  "datadog-forwarders": "Datadog Forwarders",
  dms: "DMS",
  "dynamodb-table": "DynamoDB",
  "ec2-instance": "EC2",
  ecr: "ECR",
  ecs: "ECS",
  efs: "EFS",
  eks: "EKS",
  "eks-pod-identity": "EKS Pod Identity",
  elasticache: "ElastiCache",
  // The classic load balancer, which is what AWS now calls it to tell it apart
  // from the ALB the sibling module creates.
  elb: "Classic Load Balancer",
  emr: "EMR",
  eventbridge: "EventBridge",
  fsx: "FSx",
  "global-accelerator": "Global Accelerator",
  grafana: "Managed Grafana",
  iam: "IAM",
  kms: "KMS",
  lambda: "Lambda",
  "memory-db": "MemoryDB",
  "msk-kafka-cluster": "MSK",
  "network-firewall": "Network Firewall",
  opensearch: "OpenSearch Service",
  prometheus: "Managed Service for Prometheus",
  rds: "RDS",
  "rds-aurora": "Aurora",
  "rds-proxy": "RDS Proxy",
  redshift: "Redshift",
  route53: "Route 53",
  "s3-bucket": "S3",
  "secrets-manager": "Secrets Manager",
  // A VPC resource rather than a service of its own, so it is named after what it
  // creates.
  "security-group": "Security Group",
  sns: "SNS",
  sqs: "SQS",
  "ssm-parameter": "SSM Parameter Store",
  "step-functions": "Step Functions",
  "transit-gateway": "Transit Gateway",
  vpc: "VPC",
  "vpn-gateway": "VPN Gateway",
  waf: "WAF",
};

export interface GithubRepo {
  name: string;
  full_name: string;
  description: string | null;
  archived: boolean;
  default_branch: string;
}

interface GithubTag {
  name: string;
}

export type CatalogueRefType = "branch" | "tag";

export interface CatalogueRef {
  refName: string;
  refType: CatalogueRefType;
}

export function resolveToken(command: string): string {
  const token =
    process.env.TERRABLOX_SEED_GITHUB_TOKEN ??
    process.env.GITHUB_TOKEN ??
    process.env.GH_TOKEN ??
    null;

  if (!token) {
    console.error(
      [
        "No GitHub token found.",
        "",
        "The catalogue reads ~50 public repos from GitHub. Public repos don't need",
        "any scopes, but without a token the rate limit (60 req/h) is too low.",
        "",
        `  GITHUB_TOKEN=$(gh auth token) ${command}`,
      ].join("\n"),
    );
    process.exit(1);
  }

  return token;
}

export async function github<T>(token: string, url: string): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const response = await fetch(url, { headers });

  if (!response.ok) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const hint =
      remaining === "0"
        ? " (GitHub rate limit exhausted — wait for the window to reset)"
        : "";
    throw new Error(
      `GitHub ${response.status} ${response.statusText} for ${url}${hint}`,
    );
  }

  return (await response.json()) as T;
}

/** Every catalogue repository, following pagination. */
export async function listCatalogueRepos(token: string): Promise<GithubRepo[]> {
  const found: GithubRepo[] = [];

  for (let page = 1; page <= 10; page++) {
    const batch = await github<GithubRepo[]>(
      token,
      `https://api.github.com/orgs/${ORG}/repos?per_page=100&type=public&page=${page}`,
    );

    found.push(...batch);
    if (batch.length < 100) break;
  }

  return (
    found
      .filter((repo) => repo.name.startsWith(PREFIX))
      // An archived fork is no longer being kept in step with upstream, so
      // shipping it would hand every user a module that quietly went stale.
      .filter((repo) => !repo.archived)
      .sort((a, b) => a.name.localeCompare(b.name))
  );
}

/**
 * The refs to import for a repository: its default branch, and its newest tag.
 *
 * The branch is taken from the repository itself rather than assumed — these
 * forks default to `master`, not `main`, and hardcoding either would silently
 * skip every repository that disagreed.
 *
 * Both refs are worth having because they answer different questions. The branch
 * is what upstream currently says, so a user who wants fixes as they land follows
 * it. A tag never moves, so a user who wants a project to keep planning the same
 * way next month pins to it.
 *
 * A freshly forked repository with no tags yet still yields the branch rather
 * than being skipped.
 */
export async function listRefs(
  token: string,
  repo: GithubRepo,
): Promise<CatalogueRef[]> {
  const refs: CatalogueRef[] = [
    { refName: repo.default_branch, refType: "branch" },
  ];

  const tags = await github<GithubTag[]>(
    token,
    `https://api.github.com/repos/${repo.full_name}/tags?per_page=100`,
  );

  const latest = pickLatest(tags.map((tag) => ({ versionTag: tag.name })));

  // Guarded in case a repository tags its default branch under the same name,
  // which would otherwise import the same ref twice.
  if (latest?.versionTag && latest.versionTag !== repo.default_branch) {
    refs.push({ refName: latest.versionTag, refType: "tag" });
  }

  return refs;
}

/** `terrablox-aws-rds-aurora` -> `rds-aurora`. */
export function serviceSlug(repoName: string): string {
  return repoName.slice(PREFIX.length).trim();
}

/**
 * The name shown in the library: the AWS service the module creates.
 *
 * A repository added upstream before {@link SERVICE_NAMES} learns about it falls
 * back to a title-cased slug — readable enough to ship, obviously not hand-written,
 * and reported at the end of a run so it gets a real name.
 */
export function displayName(repoName: string): string {
  const slug = serviceSlug(repoName);
  const known = SERVICE_NAMES[slug];
  if (known) return known;

  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
