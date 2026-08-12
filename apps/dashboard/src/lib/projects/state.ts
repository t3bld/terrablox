/**
 * Reading the Terraform state inventory the pipeline publishes.
 *
 * The snapshot is deliberately thin — identifiers only, see
 * `renderStateWorkflow` — so everything a person wants to see beyond a resource
 * address is reconstructed here: a readable name, the AWS service it belongs
 * to, and a link into the console. That reconstruction is a lookup table rather
 * than cleverness, for the same reason `aws-architecture.ts` is: Terraform
 * resource types and AWS console URLs have no shared structure to derive from.
 */

import {
  ARCHITECTURE_MAP,
  resolveServiceIcon,
} from "@/lib/terraform/aws-architecture";

export interface StateResource {
  /** Full Terraform address, e.g. `module.vpc.aws_subnet.private[0]`. */
  address: string;
  type: string;
  name: string;
  mode: string;
  provider: string | null;
  index: string | number | null;
  id: string | null;
  arn: string | null;
}

export interface StateOutput {
  name: string;
  sensitive: boolean;
  /** Null when the output is marked sensitive; the pipeline never exports it. */
  value: string | null;
}

export interface StateSnapshot {
  version: number;
  generatedAt: string;
  terraformVersion: string | null;
  resources: StateResource[];
  outputs: StateOutput[];
}

/** What the state tab receives, including the reasons it may be empty. */
export interface ProjectStateDto {
  snapshot: StateSnapshot | null;
  /** The region the console links are built for. */
  region: string;
  /** Where the snapshot lives, so the user can inspect it in Git. */
  fileUrl: string;
  /** False when the pipeline that writes the snapshot has not been generated. */
  hasWorkflow: boolean;
  /** Set when the snapshot could not be read or parsed. */
  problem: string | null;
}

/**
 * A resource as the state tab shows it.
 *
 * `managed: false` marks data sources: they are read, not created, and mixing
 * them into a list of deployed infrastructure would overstate what the project
 * owns.
 */
export interface StateResourceView extends StateResource {
  label: string;
  icon: string | undefined;
  managed: boolean;
  /** Module path, or an empty string for the root module. */
  modulePath: string;
  consoleUrl: string | null;
}

export interface StateModuleGroup {
  path: string;
  label: string;
  resources: StateResourceView[];
}

/**
 * Parses the snapshot, tolerating anything that is not one.
 *
 * The file is written by a workflow that may be older than this code, or may
 * have been edited by hand, so a malformed snapshot has to read as "no data"
 * rather than crash the tab.
 */
export function parseStateSnapshot(raw: string): StateSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;

  const resources = Array.isArray(record.resources)
    ? record.resources.flatMap((entry) => {
        const resource = toResource(entry);
        return resource ? [resource] : [];
      })
    : [];

  const outputs = Array.isArray(record.outputs)
    ? record.outputs.flatMap((entry) => {
        const output = toOutput(entry);
        return output ? [output] : [];
      })
    : [];

  return {
    version: typeof record.version === "number" ? record.version : 1,
    generatedAt:
      typeof record.generatedAt === "string" ? record.generatedAt : "",
    terraformVersion:
      typeof record.terraformVersion === "string"
        ? record.terraformVersion
        : null,
    resources,
    outputs,
  };
}

function toResource(entry: unknown): StateResource | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.address !== "string" || typeof record.type !== "string") {
    return null;
  }

  return {
    address: record.address,
    type: record.type,
    name: typeof record.name === "string" ? record.name : record.address,
    mode: typeof record.mode === "string" ? record.mode : "managed",
    provider: typeof record.provider === "string" ? record.provider : null,
    index:
      typeof record.index === "string" || typeof record.index === "number"
        ? record.index
        : null,
    id: typeof record.id === "string" ? record.id : null,
    arn: typeof record.arn === "string" ? record.arn : null,
  };
}

function toOutput(entry: unknown): StateOutput | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.name !== "string") return null;

  return {
    name: record.name,
    sensitive: record.sensitive === true,
    value: typeof record.value === "string" ? record.value : null,
  };
}

/** `module.network.module.vpc.aws_vpc.this` -> `module.network.module.vpc`. */
export function modulePathOf(address: string): string {
  const parts = address.split(".");
  const path: string[] = [];

  while (parts[0] === "module" && parts.length >= 2) {
    const name = parts[1] ?? "";
    path.push("module", name);
    parts.splice(0, 2);
  }

  return path.join(".");
}

/** `aws_nat_gateway` -> `NAT Gateway`, using the curated names where they exist. */
export function resourceLabel(type: string): string {
  const curated = ARCHITECTURE_MAP[type]?.label;
  if (curated) return curated;

  return type
    .replace(/^aws_/, "")
    .split("_")
    .map((word) => (word.length <= 3 ? word.toUpperCase() : titleCase(word)))
    .join(" ");
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export interface ArnParts {
  partition: string;
  service: string;
  region: string;
  account: string;
  /** Everything after the account, e.g. `service/cluster/name`. */
  resource: string;
}

export function parseArn(arn: string): ArnParts | null {
  const parts = arn.split(":");
  if (parts.length < 6 || parts[0] !== "arn") return null;

  return {
    partition: parts[1] ?? "",
    service: parts[2] ?? "",
    region: parts[3] ?? "",
    account: parts[4] ?? "",
    resource: parts.slice(5).join(":"),
  };
}

/** The last segment of an ARN resource part, which is usually the name. */
function arnName(arn: string | null): string | null {
  const parsed = arn ? parseArn(arn) : null;
  if (!parsed) return null;

  const segments = parsed.resource.split("/");
  return segments[segments.length - 1] || null;
}

type ConsoleLinkBuilder = (
  resource: StateResource,
  region: string,
) => string | null;

function regional(
  path: (id: string, region: string) => string,
): ConsoleLinkBuilder {
  return (resource, region) => {
    const id = resource.id;
    if (!id || !region) return null;
    return `https://${region}.console.aws.amazon.com/${path(id, region)}`;
  };
}

/**
 * Deep links into the AWS console, per resource type.
 *
 * Curated rather than derived: every console has its own URL shape, several
 * take an id where the neighbouring one takes an ARN, and the global services
 * reject a region entirely. A wrong guess lands the user on an error page, so
 * an unlisted type gets no link at all.
 */
const CONSOLE_LINKS: Record<string, ConsoleLinkBuilder> = {
  // ---- Network ----------------------------------------------------------
  aws_vpc: regional(
    (id, r) => `vpcconsole/home?region=${r}#VpcDetails:VpcId=${id}`,
  ),
  aws_subnet: regional(
    (id, r) => `vpcconsole/home?region=${r}#SubnetDetails:subnetId=${id}`,
  ),
  aws_security_group: regional(
    (id, r) => `ec2/home?region=${r}#SecurityGroup:groupId=${id}`,
  ),
  aws_nat_gateway: regional(
    (id, r) =>
      `vpcconsole/home?region=${r}#NatGatewayDetails:natGatewayId=${id}`,
  ),
  aws_internet_gateway: regional(
    (id, r) =>
      `vpcconsole/home?region=${r}#InternetGateway:internetGatewayId=${id}`,
  ),
  aws_route_table: regional(
    (id, r) => `vpcconsole/home?region=${r}#RouteTables:routeTableId=${id}`,
  ),
  aws_vpc_endpoint: regional(
    (id, r) => `vpcconsole/home?region=${r}#Endpoints:vpcEndpointId=${id}`,
  ),
  aws_eip: regional(
    (id, r) => `ec2/home?region=${r}#ElasticIpDetails:AllocationId=${id}`,
  ),

  // ---- Compute ----------------------------------------------------------
  aws_instance: regional(
    (id, r) => `ec2/home?region=${r}#InstanceDetails:instanceId=${id}`,
  ),
  aws_launch_template: regional(
    (id, r) =>
      `ec2/home?region=${r}#LaunchTemplateDetails:launchTemplateId=${id}`,
  ),
  aws_autoscaling_group: regional(
    (id, r) =>
      `ec2/home?region=${r}#AutoScalingGroupDetails:id=${encodeURIComponent(id)}`,
  ),
  aws_lambda_function: regional(
    (id, r) => `lambda/home?region=${r}#/functions/${encodeURIComponent(id)}`,
  ),
  aws_ecs_cluster: regional(
    (id, r) =>
      `ecs/v2/clusters/${encodeURIComponent(arnName(id) ?? id)}?region=${r}`,
  ),
  aws_eks_cluster: regional((id, r) => `eks/home?region=${r}#/clusters/${id}`),

  // ---- Load balancing ---------------------------------------------------
  aws_lb: (resource, region) => {
    const name = arnName(resource.arn ?? resource.id);
    if (!name || !region) return null;
    return `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#LoadBalancers:search=${encodeURIComponent(name)}`;
  },
  aws_lb_target_group: (resource, region) => {
    const name = arnName(resource.arn ?? resource.id);
    if (!name || !region) return null;
    return `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#TargetGroups:search=${encodeURIComponent(name)}`;
  },

  // ---- Storage and data -------------------------------------------------
  aws_s3_bucket: (resource, region) =>
    resource.id
      ? `https://s3.console.aws.amazon.com/s3/buckets/${encodeURIComponent(resource.id)}?region=${region}`
      : null,
  aws_dynamodb_table: regional(
    (id, r) =>
      `dynamodbv2/home?region=${r}#table?name=${encodeURIComponent(id)}`,
  ),
  aws_db_instance: regional(
    (id, r) =>
      `rds/home?region=${r}#database:id=${encodeURIComponent(id)};is-cluster=false`,
  ),
  aws_rds_cluster: regional(
    (id, r) =>
      `rds/home?region=${r}#database:id=${encodeURIComponent(id)};is-cluster=true`,
  ),
  aws_elasticache_cluster: regional(
    (id, r) => `elasticache/home?region=${r}#/redis/${encodeURIComponent(id)}`,
  ),
  aws_efs_file_system: regional(
    (id, r) => `efs/home?region=${r}#/file-systems/${encodeURIComponent(id)}`,
  ),
  aws_ecr_repository: (resource, region) => {
    const parsed = resource.arn ? parseArn(resource.arn) : null;
    if (!parsed || !resource.id) return null;
    return `https://${region}.console.aws.amazon.com/ecr/repositories/private/${parsed.account}/${encodeURIComponent(resource.id)}?region=${region}`;
  },

  // ---- Messaging and integration ----------------------------------------
  aws_sqs_queue: regional(
    (id, r) => `sqs/v2/home?region=${r}#/queues/${encodeURIComponent(id)}`,
  ),
  aws_sns_topic: regional(
    (id, r) => `sns/v3/home?region=${r}#/topic/${encodeURIComponent(id)}`,
  ),
  aws_sfn_state_machine: regional(
    (id, r) =>
      `states/home?region=${r}#/statemachines/view/${encodeURIComponent(id)}`,
  ),
  aws_api_gateway_rest_api: regional(
    (id, r) => `apigateway/main/apis/${id}/resources?region=${r}`,
  ),
  aws_apigatewayv2_api: regional(
    (id, r) => `apigateway/main/api-detail?api=${id}&region=${r}`,
  ),

  // ---- Security and identity --------------------------------------------
  // IAM, CloudFront and Route 53 are global: the console rejects a region.
  aws_iam_role: (resource) =>
    resource.id
      ? `https://console.aws.amazon.com/iam/home#/roles/${encodeURIComponent(resource.id)}`
      : null,
  aws_iam_policy: (resource) =>
    resource.arn
      ? `https://console.aws.amazon.com/iam/home#/policies/${encodeURIComponent(resource.arn)}`
      : null,
  aws_iam_user: (resource) =>
    resource.id
      ? `https://console.aws.amazon.com/iam/home#/users/${encodeURIComponent(resource.id)}`
      : null,
  aws_kms_key: regional((id, r) => `kms/home?region=${r}#/kms/keys/${id}`),
  aws_secretsmanager_secret: (resource, region) => {
    const name = arnName(resource.arn) ?? resource.id;
    if (!name || !region) return null;
    return `https://${region}.console.aws.amazon.com/secretsmanager/secret?name=${encodeURIComponent(name)}&region=${region}`;
  },
  aws_cognito_user_pool: regional(
    (id, r) => `cognito/v2/idp/user-pools/${id}/users?region=${r}`,
  ),
  aws_acm_certificate: regional(
    (id, r) =>
      `acm/home?region=${r}#/certificates/${encodeURIComponent(arnName(id) ?? id)}`,
  ),

  // ---- Edge and DNS -----------------------------------------------------
  aws_cloudfront_distribution: (resource) =>
    resource.id
      ? `https://console.aws.amazon.com/cloudfront/v4/home#/distributions/${resource.id}`
      : null,
  aws_route53_zone: (resource) =>
    resource.id
      ? `https://console.aws.amazon.com/route53/v2/hostedzones#ListRecordSets/${resource.id}`
      : null,

  // ---- Observability -----------------------------------------------------
  // The log group console double-encodes the slashes in a group name.
  aws_cloudwatch_log_group: regional(
    (id, r) =>
      `cloudwatch/home?region=${r}#logsV2:log-groups/log-group/${encodeURIComponent(
        id,
      ).replace(/%2F/g, () => "$252F")}`,
  ),
};

export function awsConsoleUrl(
  resource: StateResource,
  region: string,
): string | null {
  const build = CONSOLE_LINKS[resource.type];
  if (!build) return null;

  try {
    return build(resource, region);
  } catch {
    return null;
  }
}

export function toResourceView(
  resource: StateResource,
  region: string,
): StateResourceView {
  return {
    ...resource,
    label: resourceLabel(resource.type),
    // The curated icon wins: it distinguishes a public from a private subnet,
    // which the service-prefix lookup cannot.
    icon:
      ARCHITECTURE_MAP[resource.type]?.icon ??
      resolveServiceIcon(resource.type),
    managed: resource.mode !== "data",
    modulePath: modulePathOf(resource.address),
    consoleUrl:
      resource.mode === "data" ? null : awsConsoleUrl(resource, region),
  };
}

/**
 * Groups by module, root first.
 *
 * A flat list of two hundred addresses is the thing this tab exists to avoid:
 * the module boundaries are what makes a real state readable, and they are the
 * same boundaries the code tab draws as boxes.
 */
export function groupByModule(
  resources: StateResourceView[],
): StateModuleGroup[] {
  const groups = new Map<string, StateModuleGroup>();

  for (const resource of resources) {
    const existing = groups.get(resource.modulePath);
    if (existing) {
      existing.resources.push(resource);
      continue;
    }

    groups.set(resource.modulePath, {
      path: resource.modulePath,
      label: resource.modulePath === "" ? "Root" : resource.modulePath,
      resources: [resource],
    });
  }

  return [...groups.values()].sort((a, b) => {
    if (a.path === "") return -1;
    if (b.path === "") return 1;
    return a.path.localeCompare(b.path);
  });
}

/**
 * Resource counts for the summary strip.
 *
 * Counted by what a person would call the thing rather than by its Terraform
 * type prefix: `aws_lb` and `aws_alb` are one kind of box on the diagram, and
 * splitting them apart would make the strip a second, worse resource list.
 */
export function countByKind(
  resources: StateResourceView[],
): { kind: string; icon: string | undefined; count: number }[] {
  const counts = new Map<string, { icon: string | undefined; count: number }>();

  for (const resource of resources) {
    const entry = counts.get(resource.label);
    if (entry) {
      entry.count += 1;
      continue;
    }
    counts.set(resource.label, { icon: resource.icon, count: 1 });
  }

  return [...counts.entries()]
    .map(([kind, entry]) => ({ kind, ...entry }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}
