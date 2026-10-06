import type { ModuleName } from "./modules";

/**
 * The scripted demo's material.
 *
 * Hand-authored rather than generated, and the honesty about that is on the page:
 * the real agent reads a repository, calls tools and commits. Nothing here talks to
 * a model. What it does show truthfully is the *shape* of an answer — which modules
 * a request resolves to, where they sit in a network, and the order the agent works
 * in — because all of that is copied from stacks the real thing produces.
 *
 * Module names are typed as {@link ModuleName}, so a scenario cannot advertise a
 * module the library does not have. A typo is a build error.
 */

/**
 * Where a module lands in the drawing.
 *
 * The same four places the product's architecture view uses, which is why they are
 * named after network position rather than after rows in a layout: `regional` is for
 * things that have no subnet at all — a certificate, a DNS zone, an IAM role — and
 * putting those in a subnet is the specific mistake the real view was fixed to stop
 * making.
 */
export type Placement = "regional" | "public" | "private" | "data";

export interface DemoModule {
  name: ModuleName;
  /** What this one is for, in the stack being built. */
  role: string;
  placement: Placement;
}

export interface DemoScenario {
  id: string;
  /** A short name for the stack, for step rails and headings. */
  title: string;
  /**
   * An example repository, for the wizard's first step.
   *
   * Invented names, and the step says so. The real picker lists what your GitHub
   * token can see, which a static site has no way to ask for — so rather than a
   * dead control wired to an OAuth flow that cannot exist here, the step offers
   * three examples and is honest that they are examples.
   */
  repo: { name: string; language: string };
  /** And an example document, for the same step's other source. */
  doc: { name: string; pages: number };
  /** The prompt shown on the suggestion chip, and typed out when picked. */
  prompt: string;
  /** Lower-case words that route free text to this scenario. */
  keywords: string[];
  /** What the agent says it is doing, in order. */
  steps: string[];
  modules: DemoModule[];
  /** The decision the agent would record, which is the part tools usually hide. */
  decision: { choice: string; reason: string };
  /** Named because it bills for existing, not for being used. */
  standingCost: string;
}

export const SCENARIOS: DemoScenario[] = [
  {
    id: "container-app",
    title: "Containerised web app",
    repo: { name: "acme/checkout-api", language: "TypeScript · Dockerfile" },
    doc: { name: "checkout-platform-requirements.pdf", pages: 14 },
    prompt: "A containerised web app with a Postgres database, public on HTTPS",
    keywords: [
      "container",
      "docker",
      "ecs",
      "fargate",
      "web app",
      "webapp",
      "postgres",
      "database",
      "api",
      "https",
    ],
    steps: [
      "Reading the project — the repository is empty",
      "describe_module vpc, ecs, rds, alb, acm",
      "record_decision — Fargate over EC2, RDS over self-hosted Postgres",
      "Placing 7 modules and wiring 11 inputs",
      "review_project — no unset required inputs",
    ],
    modules: [
      { name: "vpc", role: "Network, 3 AZs", placement: "regional" },
      { name: "acm", role: "TLS certificate", placement: "regional" },
      { name: "alb", role: "Public entry point", placement: "public" },
      { name: "ecs", role: "Fargate service", placement: "private" },
      { name: "ecr", role: "Image registry", placement: "regional" },
      { name: "rds", role: "PostgreSQL 16", placement: "data" },
      { name: "elasticache", role: "Session cache", placement: "data" },
    ],
    decision: {
      choice: "Fargate behind an ALB, RDS in isolated subnets",
      reason:
        "No instances to patch, and the database has no route to the internet — the app reaches it, nothing else does.",
    },
    standingCost:
      "The NAT gateway, the load balancer and the database instance bill per hour whether traffic arrives or not.",
  },
  {
    id: "static-site",
    title: "Static marketing site",
    repo: { name: "acme/marketing-site", language: "Astro · static output" },
    doc: { name: "website-relaunch-brief.docx", pages: 6 },
    prompt: "A static marketing site on a custom domain, cached worldwide",
    keywords: [
      "static",
      "landing",
      "marketing",
      "website",
      "cdn",
      "cloudfront",
      "s3",
      "domain",
    ],
    steps: [
      "Reading the project — the repository is empty",
      "describe_module s3-bucket, cloudfront, acm, route53",
      "record_decision — CloudFront with a private origin bucket",
      "Placing 4 modules and wiring 6 inputs",
      "review_project — no unset required inputs",
    ],
    modules: [
      {
        name: "s3-bucket",
        role: "Origin, no public access",
        placement: "regional",
      },
      { name: "cloudfront", role: "Global CDN", placement: "regional" },
      { name: "acm", role: "Certificate in us-east-1", placement: "regional" },
      { name: "route53", role: "DNS records", placement: "regional" },
    ],
    decision: {
      choice: "A private bucket read only by CloudFront",
      reason:
        "A public bucket is the usual shortcut and it means anyone can bypass the CDN, its logs and its WAF.",
    },
    standingCost:
      "Nothing here bills for existing. CloudFront and S3 are paid per request and per gigabyte.",
  },
  {
    id: "event-pipeline",
    title: "Event pipeline",
    repo: { name: "acme/order-events", language: "Python · serverless" },
    doc: { name: "order-events-design.md", pages: 9 },
    prompt: "An event pipeline: queue, Lambda workers, a table to write into",
    keywords: [
      "event",
      "queue",
      "sqs",
      "lambda",
      "serverless",
      "worker",
      "pipeline",
      "dynamodb",
      "async",
    ],
    steps: [
      "Reading the project — the repository is empty",
      "describe_module sqs, lambda, dynamodb-table, eventbridge",
      "record_decision — SQS in front of the workers, with a dead-letter queue",
      "Placing 5 modules and wiring 8 inputs",
      "review_project — no unset required inputs",
    ],
    modules: [
      {
        name: "eventbridge",
        role: "Ingest and routing",
        placement: "regional",
      },
      { name: "sqs", role: "Work queue + DLQ", placement: "regional" },
      { name: "lambda", role: "Workers", placement: "regional" },
      {
        name: "dynamodb-table",
        role: "Results, on-demand",
        placement: "regional",
      },
      { name: "kms", role: "Encryption key", placement: "regional" },
    ],
    decision: {
      choice: "A queue between the source and the workers",
      reason:
        "A failed invocation retries from the queue instead of losing the event, and a dead-letter queue is where the ones that keep failing end up.",
    },
    standingCost:
      "Nothing bills for existing. Lambda, SQS and an on-demand table are paid per use.",
  },
  {
    id: "kubernetes",
    title: "Kubernetes platform",
    repo: { name: "acme/platform-charts", language: "Helm · Kustomize" },
    doc: { name: "platform-target-architecture.pdf", pages: 22 },
    prompt: "A Kubernetes cluster with a private API and managed node groups",
    keywords: [
      "kubernetes",
      "k8s",
      "eks",
      "cluster",
      "helm",
      "node group",
      "nodes",
    ],
    steps: [
      "Reading the project — the repository is empty",
      "describe_module eks, vpc, iam, eks-pod-identity",
      "record_decision — private endpoint, managed node groups",
      "Placing 5 modules and wiring 9 inputs",
      "review_project — no unset required inputs",
    ],
    modules: [
      { name: "vpc", role: "Network, 3 AZs", placement: "regional" },
      { name: "eks", role: "Cluster, private endpoint", placement: "private" },
      {
        name: "eks-pod-identity",
        role: "IAM for workloads",
        placement: "regional",
      },
      { name: "iam", role: "Cluster and node roles", placement: "regional" },
      { name: "ecr", role: "Image registry", placement: "regional" },
    ],
    decision: {
      choice: "A private API endpoint and managed node groups",
      reason:
        "A public control plane is one misconfigured security group away from being reachable, and managed groups mean AMI updates are a version bump rather than a project.",
    },
    standingCost:
      "The EKS control plane and the NAT gateway bill per hour. Node instances bill whether pods are scheduled or not.",
  },
];

/** The scenario the composer suggests first. */
export const DEFAULT_SCENARIO = SCENARIOS[0] as DemoScenario;

/** Matches a keyword only as a whole word, so `api` misses "capital". */
function mentions(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i").test(text);
}

/**
 * Routes typed text to a scenario, or to nothing.
 *
 * Two things this used to get wrong, both of which made the demo look like the thing
 * the page argues against.
 *
 * It matched on substrings, so "capital expenditure" contained `api` and built a
 * container app, and "spanish" contained `spa` and built a static site. Whole-word
 * matching only.
 *
 * And with no hits at all it returned the first scenario anyway. A visitor who typed
 * something unrelated watched the demo confidently assemble a Postgres stack, which
 * is a live demonstration of guessing — on a page whose headline is that this tool
 * does not guess. `null` now, and the caller says so.
 *
 * Still deliberately crude, and it does not pretend otherwise: a scored keyword
 * match is honest about being one. Ties go to the earlier scenario.
 */
export function matchScenario(input: string): DemoScenario | null {
  const text = input.toLowerCase();

  let best: DemoScenario | null = null;
  let bestScore = 0;

  for (const scenario of SCENARIOS) {
    const score = scenario.keywords.reduce(
      (count, keyword) => count + (mentions(text, keyword) ? 1 : 0),
      0,
    );
    if (score > bestScore) {
      best = scenario;
      bestScore = score;
    }
  }

  return best;
}

/** The frames the drawing groups modules into, in network order. */
export const FRAMES: { id: Placement; label: string; hint: string }[] = [
  { id: "regional", label: "Region", hint: "no subnet of their own" },
  {
    id: "public",
    label: "Public subnets",
    hint: "reachable from the internet",
  },
  { id: "private", label: "Private subnets", hint: "egress through NAT" },
  { id: "data", label: "Isolated subnets", hint: "no route out" },
];

/**
 * The deploy step's checklist, which is the product's real wizard in miniature.
 *
 * The same four setup stacks in the same order as `apps/dashboard`'s deployment
 * wizard, and the same reason for the order: the role has to exist before a stack can
 * be created with it, and the state backend has to exist before a workflow can write
 * to it. The apply is the fifth row rather than a separate panel — it is the thing
 * the other four exist to make possible, so it belongs in the same list.
 *
 * `detail` is what the real wizard shows once a step finishes. The bucket name is
 * shaped like the ones the product generates — project slug, account id, random tail
 * — but the account number and the tail are invented, and the step says so rather
 * than dressing an example up as a reading from somebody's AWS.
 */
export const DEPLOY_STEPS: readonly {
  label: string;
  detail: string;
}[] = [
  {
    label: "Connect the AWS account",
    detail: "Signed in with IAM Identity Center.",
  },
  {
    label: "Create the deployment role",
    detail: "The GitHub OIDC provider and the role can be assumed.",
  },
  {
    label: "Deploy the Terraform state backend",
    detail: "Created the S3 bucket to store the Terraform state.",
  },
  {
    label: "Commit the workflows",
    detail: "Wires the CI/CD pipeline into your repository.",
  },
  {
    label: "Deploy the infrastructure",
    detail: "Created the infrastructure in your cloud account.",
  },
];
