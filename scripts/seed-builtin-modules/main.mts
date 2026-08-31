/**
 * Imports the module catalogue TerraBlox ships with.
 *
 * Every repository named `terrablox-aws-*` in the configured GitHub org is
 * imported with a null owner, which makes it visible to every user without anyone
 * importing anything. Run it once per installation, and again whenever the
 * upstream modules should be refreshed:
 *
 *   GITHUB_TOKEN=$(gh auth token) pnpm db:builtin:sync
 *
 * Two refs per repository: the default branch, which follows upstream, and the
 * newest release tag, which does not. Users then choose in the version switcher
 * between tracking upstream and pinning. Re-running the sync updates the branch
 * rows in place — that is what "follows upstream" means — while a new upstream
 * release simply adds a version rather than moving an existing one.
 *
 * Idempotent, because the unique key is `(sourceId, versionTag,
 * terraformRootFolder)` and the pipeline updates rather than inserts on a hit.
 *
 * GitHub stays the source of truth: nothing is vendored, and the database holds
 * only the analysis, exactly as it does for a repository a user imports.
 *
 * The token needs no scopes for public repositories — it is required only because
 * GitHub's unauthenticated rate limit (60 requests an hour) cannot carry ~50
 * repositories, each of which costs a tree listing plus one request per `.tf`
 * file.
 */

// Imported through the app's own module rather than `@terrablox/database`
// directly: pnpm only links a workspace package into the node_modules of the
// packages that depend on it, and `scripts/` depends on nothing.
import { prisma } from "@/lib/database";
import {
  type GitRefType,
  type ImportTimings,
  importModuleFromGit,
} from "@/lib/modules/import-from-git";
import {
  BUILTIN_USER_ID,
  builtinModulesEnabled,
} from "@/lib/modules/ownership";
import { pickLatest } from "@/lib/terraform/versions";

/** Which repositories make up the catalogue. */
const ORG = process.env.TERRABLOX_BUILTIN_ORG ?? "terrablox";
const PREFIX = process.env.TERRABLOX_BUILTIN_PREFIX ?? "terrablox-aws-";

/**
 * Where submodules live in these repositories.
 *
 * `terraform-aws-modules` repos put each submodule in its own folder under
 * `modules/`, and the pipeline treats a folder with no `.tf` of its own as a
 * container and imports each child. One value covers the whole catalogue.
 */
const SUBMODULE_CONTAINER = "modules";

/**
 * The only tag on a shipped source, so the modules page can filter to the
 * catalogue in one click.
 *
 * One tag rather than several. `aws` said nothing when every module in the
 * catalogue is AWS, `built-in` duplicated a fact the row already carries in its
 * null owner, and a per-service tag repeated the name right next to the name.
 * Three tags on every card is three things to read past.
 */
const CATALOGUE_TAGS = ["terrablox"];

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
const SERVICE_NAMES: Readonly<Record<string, string>> = {
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

interface GithubRepo {
  name: string;
  full_name: string;
  description: string | null;
  archived: boolean;
  default_branch: string;
}

interface GithubTag {
  name: string;
}

interface Ref {
  refName: string;
  refType: GitRefType;
}

function resolveToken(): string {
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
        "  GITHUB_TOKEN=$(gh auth token) pnpm db:builtin:sync",
      ].join("\n"),
    );
    process.exit(1);
  }

  return token;
}

async function github<T>(token: string, url: string): Promise<T> {
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
async function listCatalogueRepos(token: string): Promise<GithubRepo[]> {
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
 * way next month pins to it. `compareVersionsDesc` ranks semver tags above branch
 * names, so the tag is what the UI offers as latest.
 *
 * A freshly forked repository with no tags yet still yields the branch rather
 * than being skipped.
 */
async function listRefs(token: string, repo: GithubRepo): Promise<Ref[]> {
  const refs: Ref[] = [{ refName: repo.default_branch, refType: "branch" }];

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
function serviceSlug(repoName: string): string {
  return repoName.slice(PREFIX.length).trim();
}

/**
 * The name shown in the library: the AWS service the module creates.
 *
 * A repository added upstream before {@link SERVICE_NAMES} learns about it falls
 * back to a title-cased slug — readable enough to ship, obviously not hand-written,
 * and reported at the end of the run so it gets a real name.
 */
function displayName(repoName: string): string {
  const slug = serviceSlug(repoName);
  const known = SERVICE_NAMES[slug];
  if (known) return known;

  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Adds one import's figures into a running total. */
function addTimings(into: ImportTimings, add: ImportTimings): void {
  into.totalMs += add.totalMs;
  into.treeMs += add.treeMs;
  into.fetchMs += add.fetchMs;
  into.parseMs += add.parseMs;
  into.dbMs += add.dbMs;
  into.fileCount += add.fileCount;
  into.folderCount += add.folderCount;
}

function emptyTimings(): ImportTimings {
  return {
    totalMs: 0,
    treeMs: 0,
    fetchMs: 0,
    parseMs: 0,
    dbMs: 0,
    fileCount: 0,
    folderCount: 0,
  };
}

async function main() {
  if (!builtinModulesEnabled()) {
    console.error(
      [
        "TERRABLOX_BUILTIN_MODULES is false, so this instance does not offer the",
        "shipped catalogue and syncing it would write rows nothing would read.",
        "",
        "Remove the variable (it defaults to on) or set it to true, then re-run.",
      ].join("\n"),
    );
    process.exit(1);
  }

  const token = resolveToken();

  console.log(`Reading ${ORG} for repositories named ${PREFIX}*…`);
  const repos = await listCatalogueRepos(token);

  if (repos.length === 0) {
    console.error(
      `No repositories named ${PREFIX}* found in ${ORG}. Check the org name and that the token can see it.`,
    );
    process.exit(1);
  }

  console.log(`Found ${repos.length} repositories.\n`);

  let importedRefs = 0;
  /** Repositories that fell back to a derived name; see {@link displayName}. */
  const unnamed: string[] = [];
  const failures: Array<{ repo: string; ref: string; message: string }> = [];
  const totals = emptyTimings();
  const startedAt = performance.now();

  // Sequential on purpose. Each repository is already a burst of parallel file
  // reads inside the pipeline, and running the repositories in parallel too
  // reliably trips GitHub's secondary rate limit.
  for (const [index, repo] of repos.entries()) {
    const position = `[${index + 1}/${repos.length}]`;

    if (!SERVICE_NAMES[serviceSlug(repo.name)]) {
      unnamed.push(repo.name);
    }

    let refs: Ref[];
    try {
      refs = await listRefs(token, repo);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ repo: repo.full_name, ref: "(refs)", message });
      console.error(
        `${position} ${repo.name} FAILED to list refs — ${message}`,
      );
      continue;
    }

    for (const { refName, refType } of refs) {
      try {
        const result = await importModuleFromGit({
          userId: BUILTIN_USER_ID,
          token,
          repoFullName: repo.full_name,
          refType,
          refName,
          terraformRootFolder: ".",
          terraformSubmodulesFolders: [SUBMODULE_CONTAINER],
          nameOverride: displayName(repo.name),
          description: repo.description,
          tags: CATALOGUE_TAGS,
          // Already known from listing the org, and the icon lookup would
          // otherwise re-ask GitHub for it once per ref.
          defaultBranch: repo.default_branch,
        });

        importedRefs++;
        addTimings(totals, result.timings);

        const t = result.timings;
        const submodules =
          result.submodules.length > 0
            ? `, ${result.submodules.length} submodules`
            : "";
        const warnings =
          result.warnings.length > 0
            ? `, ${result.warnings.length} file(s) unparsed`
            : "";

        // One line per ref, kept to what a watching human can read: which repo,
        // which ref, how long. The per-phase timings still land in the summary
        // totals at the end, where they are actually comparable.
        console.log(
          `${position} ${repo.name} @ ${refName}${submodules}${warnings}` +
            ` — ${seconds(t.totalMs)}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ repo: repo.full_name, ref: refName, message });
        // Kept going: one unreadable ref should not cost the other hundred.
        console.error(
          `${position} ${repo.name} @ ${refName} FAILED — ${message}`,
        );
      }
    }
  }

  const wallMs = performance.now() - startedAt;

  console.log(
    `\nImported ${importedRefs} refs across ${repos.length} repositories in ${seconds(wallMs)}.`,
  );

  // fetch and parse overlap each other, because folders are analysed
  // concurrently, so these are sums of work rather than slices of the wall
  // clock. The point is the ratio: it says whether fetching or parsing is worth
  // attacking.
  console.log(
    [
      "Where the time went (summed, not wall clock):",
      `  tree listing  ${seconds(totals.treeMs)}`,
      `  file fetching ${seconds(totals.fetchMs)}`,
      `  HCL parsing   ${seconds(totals.parseMs)}`,
      `  database      ${seconds(totals.dbMs)}`,
      `  ${totals.fileCount} files across ${totals.folderCount} folders`,
    ].join("\n"),
  );

  if (unnamed.length > 0) {
    console.log(
      [
        "",
        `${unnamed.length} repositor${unnamed.length === 1 ? "y has" : "ies have"} no entry in SERVICE_NAMES and got a derived name:`,
        ...unnamed.map((name) => `  ${name} -> ${displayName(name)}`),
        "",
        "Add them to SERVICE_NAMES in scripts/seed-builtin-modules/main.mts.",
      ].join("\n"),
    );
  }

  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const failure of failures) {
      console.log(`  ${failure.repo} @ ${failure.ref}: ${failure.message}`);
    }
  }

  const [modules, sources] = await Promise.all([
    prisma.terraformModule.count({ where: { userId: BUILTIN_USER_ID } }),
    prisma.terraformModuleSource.count({ where: { userId: BUILTIN_USER_ID } }),
  ]);
  console.log(
    `\nThe catalogue now holds ${modules} module rows across ${sources} repositories.`,
  );

  await prisma.$disconnect();
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
