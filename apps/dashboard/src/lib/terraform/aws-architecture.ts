/**
 * Turns a module's Terraform resources into a coarse AWS architecture diagram —
 * the kind drawn by hand before any code exists: a VPC with public and private
 * subnets, a load balancer in front, a gateway at the edge.
 *
 * A resource graph is *not* an architecture diagram, and the difference is
 * editorial rather than technical. Roughly half of what Terraform declares is
 * wiring that nobody draws: route table associations, listener rules, IAM
 * policy documents, `terraform_data`. Showing all of it would produce the
 * Connections tab again, only with pictures.
 *
 * So this module is deliberately a *curated table* rather than a clever
 * algorithm. Terraform resource names and AWS service names have almost nothing
 * in common textually — `aws_eip` is "Amazon EC2 Elastic IP Address",
 * `aws_lb` is "Elastic Load Balancing" — and a matching heuristic tested
 * against real modules resolved 1 of 40 types. Anything not in the table is
 * omitted on purpose; adding a service is a one-line edit.
 *
 * What *is* automated is the picture. Choosing an icon is lookup, not judgment,
 * so `icon` may be left off and is then resolved from the resource type's
 * service prefix — see `resolveServiceIcon`. The role still has to be decided
 * by a person: a suffix heuristic tried against this table caught 23 of 40
 * `omit` cases and wanted to hide a WAF, and no rule tells you that
 * `aws_iam_role` and `aws_kms_key` do not belong on an architecture diagram.
 */

import { AWS_ICONS_BY_FLAT_NAME } from "./aws-icon-manifest";

/**
 * How a resource participates in the drawing.
 *
 * - `container` — a frame that other things sit inside (VPC, subnet)
 * - `service` — a box with an icon
 * - `omit` — wiring; never drawn
 */
export type ArchitectureRole = "container" | "service" | "omit";

export interface ArchitectureEntry {
  role: ArchitectureRole;
  /** File name under `/aws-icons`, without extension. */
  icon?: string;
  /** What a person would call it, not what Terraform calls it. */
  label?: string;
  /**
   * Resources sharing a key collapse into a single box. Terraform splits one
   * conceptual service across many resources — an HTTP API is five
   * `aws_apigatewayv2_*` blocks — and drawing each of them is exactly the
   * detail this view exists to avoid.
   */
  group?: string;
  /**
   * Services that live outside the VPC: edge services and global ones. Keeps
   * CloudFront and WAF from being drawn inside a subnet merely because they
   * reference something in there.
   */
  global?: boolean;
}

export const ARCHITECTURE_MAP: Record<string, ArchitectureEntry> = {
  // ---- Frames -----------------------------------------------------------
  aws_vpc: { role: "container", icon: "vpc", label: "VPC" },
  aws_subnet: { role: "container", icon: "subnet-private", label: "Subnet" },

  // ---- Network edge -----------------------------------------------------
  aws_internet_gateway: {
    role: "service",
    icon: "internet-gateway",
    label: "Internet Gateway",
  },
  aws_nat_gateway: {
    role: "service",
    icon: "nat-gateway",
    label: "NAT Gateway",
  },
  aws_egress_only_internet_gateway: {
    role: "service",
    icon: "internet-gateway",
    label: "Egress-only Internet Gateway",
  },
  aws_vpc_endpoint: {
    role: "service",
    icon: "vpc-endpoint",
    label: "VPC Endpoint",
  },
  aws_vpn_gateway: {
    role: "service",
    icon: "vpn-gateway",
    label: "VPN Gateway",
  },
  aws_eip: { role: "service", icon: "elastic-ip", label: "Elastic IP" },

  // ---- Compute ----------------------------------------------------------
  aws_instance: { role: "service", icon: "ec2", label: "EC2 Instance" },
  aws_launch_template: {
    role: "service",
    icon: "ec2",
    label: "Launch Template",
  },
  aws_autoscaling_group: {
    role: "service",
    icon: "ec2-auto-scaling",
    label: "Auto Scaling Group",
  },
  aws_ecs_service: { role: "service", icon: "ecs", label: "ECS Service" },
  aws_ecs_cluster: { role: "service", icon: "ecs", label: "ECS Cluster" },
  aws_eks_cluster: { role: "service", icon: "eks", label: "EKS Cluster" },
  aws_lambda_function: { role: "service", icon: "lambda", label: "Lambda" },

  // ---- Load balancing ---------------------------------------------------
  // The listeners, rules and attachments belong to the balancer that owns
  // them; drawing them separately is precisely the noise this view avoids.
  aws_lb: {
    role: "service",
    icon: "elastic-load-balancing",
    label: "Load Balancer",
    group: "load-balancer",
  },
  aws_alb: {
    role: "service",
    icon: "elastic-load-balancing",
    label: "Load Balancer",
    group: "load-balancer",
  },
  aws_lb_target_group: {
    role: "service",
    icon: "elastic-load-balancing",
    label: "Load Balancer",
    group: "load-balancer",
  },
  aws_lb_listener: { role: "omit" },
  aws_lb_listener_rule: { role: "omit" },
  aws_lb_target_group_attachment: { role: "omit" },
  aws_alb_listener: { role: "omit" },

  // ---- Edge and API -----------------------------------------------------
  aws_cloudfront_distribution: {
    role: "service",
    icon: "cloudfront",
    label: "CloudFront",
    group: "cloudfront",
    global: true,
  },
  // Not a service but a wire: it makes a load balancer reachable as a
  // CloudFront origin. Drawn on its own it produced a second CloudFront box and
  // swallowed the one edge worth having — omitting it lets the bridge in
  // `architecture-graph` join CloudFront straight to the balancer.
  aws_cloudfront_vpc_origin: { role: "omit" },
  aws_cloudfront_origin_access_control: { role: "omit" },
  aws_cloudfront_origin_access_identity: { role: "omit" },
  aws_apigatewayv2_api: {
    role: "service",
    icon: "api-gateway",
    label: "API Gateway",
    group: "api-gateway",
    global: true,
  },
  aws_apigatewayv2_stage: {
    role: "service",
    icon: "api-gateway",
    label: "API Gateway",
    group: "api-gateway",
    global: true,
  },
  aws_apigatewayv2_domain_name: {
    role: "service",
    icon: "api-gateway",
    label: "API Gateway",
    group: "api-gateway",
    global: true,
  },
  aws_apigatewayv2_integration: { role: "omit" },
  aws_apigatewayv2_route: { role: "omit" },
  aws_apigatewayv2_deployment: { role: "omit" },
  aws_apigatewayv2_api_mapping: { role: "omit" },
  aws_api_gateway_rest_api: {
    role: "service",
    icon: "api-gateway",
    label: "API Gateway",
    group: "api-gateway",
    global: true,
  },
  aws_wafv2_web_acl: {
    role: "service",
    icon: "waf",
    label: "WAF",
    group: "waf",
    global: true,
  },
  aws_wafv2_web_acl_association: { role: "omit" },
  aws_wafv2_web_acl_logging_configuration: { role: "omit" },

  // ---- Services reachable through module calls --------------------------
  // Named explicitly where the derived icon would be wrong: EventBridge is not
  // CloudWatch, and a Transit Gateway is not an EC2 instance, but both derive
  // that way from their `aws_cloudwatch_*` / `aws_ec2_*` type names.
  aws_backup_vault: { role: "service", label: "Backup" },
  aws_cloudtrail: { role: "service", label: "CloudTrail" },
  aws_cloudwatch_event_rule: {
    role: "service",
    icon: "event-bridge",
    label: "EventBridge",
    group: "eventbridge",
    global: true,
  },
  aws_cognito_user_pool: { role: "service", label: "Cognito" },
  aws_docdb_cluster: { role: "service", label: "DocumentDB" },
  aws_ec2_transit_gateway: {
    role: "service",
    icon: "transit-gateway",
    label: "Transit Gateway",
  },
  aws_ecr_repository: { role: "service", label: "ECR" },
  aws_kinesis_firehose_delivery_stream: {
    role: "service",
    icon: "data-firehose",
    label: "Data Firehose",
  },
  aws_kinesis_stream: { role: "service", label: "Kinesis" },
  aws_msk_cluster: { role: "service", label: "MSK" },
  aws_opensearch_domain: { role: "service", label: "OpenSearch" },
  aws_redshift_cluster: { role: "service", label: "Redshift" },
  aws_secretsmanager_secret: { role: "service", label: "Secrets Manager" },
  aws_sfn_state_machine: { role: "service", label: "Step Functions" },
  aws_ssm_parameter: { role: "service", label: "Systems Manager" },

  // ---- Storage and data -------------------------------------------------
  aws_s3_bucket: {
    role: "service",
    icon: "s3",
    label: "S3 Bucket",
    global: true,
  },
  aws_db_instance: { role: "service", icon: "rds", label: "RDS Instance" },
  aws_rds_cluster: { role: "service", icon: "rds", label: "Aurora Cluster" },
  aws_dynamodb_table: {
    role: "service",
    icon: "dynamodb",
    label: "DynamoDB Table",
    global: true,
  },
  aws_elasticache_cluster: {
    role: "service",
    icon: "elasticache",
    label: "ElastiCache",
  },
  aws_efs_file_system: { role: "service", icon: "efs", label: "EFS" },

  // ---- Observability ----------------------------------------------------
  aws_cloudwatch_log_group: {
    role: "service",
    icon: "cloudwatch",
    label: "CloudWatch Logs",
    group: "cloudwatch",
    global: true,
  },
  aws_flow_log: {
    role: "service",
    icon: "cloudwatch",
    label: "CloudWatch Logs",
    group: "cloudwatch",
    global: true,
  },
  aws_cloudwatch_log_resource_policy: { role: "omit" },
  aws_cloudwatch_metric_alarm: { role: "omit" },

  // ---- Messaging --------------------------------------------------------
  aws_sns_topic: {
    role: "service",
    icon: "sns",
    label: "SNS Topic",
    global: true,
  },
  aws_sqs_queue: {
    role: "service",
    icon: "sqs",
    label: "SQS Queue",
    global: true,
  },

  // ---- Wiring: real resources nobody draws ------------------------------
  aws_route_table: { role: "omit" },
  aws_route: { role: "omit" },
  aws_route_table_association: { role: "omit" },
  aws_main_route_table_association: { role: "omit" },
  aws_security_group: { role: "omit" },
  aws_default_security_group: { role: "omit" },
  aws_security_group_rule: { role: "omit" },
  aws_vpc_security_group_ingress_rule: { role: "omit" },
  aws_vpc_security_group_egress_rule: { role: "omit" },
  aws_network_acl: { role: "omit" },
  aws_network_acl_rule: { role: "omit" },
  aws_iam_role: { role: "omit" },
  aws_iam_role_policy: { role: "omit" },
  aws_iam_policy: { role: "omit" },
  aws_iam_role_policy_attachment: { role: "omit" },
  aws_iam_instance_profile: { role: "omit" },
  aws_kms_key: { role: "omit" },
  aws_kms_alias: { role: "omit" },
  aws_lambda_permission: { role: "omit" },
  aws_acm_certificate: { role: "omit" },
  aws_acm_certificate_validation: { role: "omit" },
  aws_route53_record: { role: "omit" },
  aws_vpc_endpoint_service: { role: "omit" },
  aws_ec2_managed_prefix_list: { role: "omit" },
  aws_s3_bucket_policy: { role: "omit" },
  aws_s3_bucket_versioning: { role: "omit" },
  aws_s3_bucket_public_access_block: { role: "omit" },
  aws_s3_bucket_server_side_encryption_configuration: { role: "omit" },

  // ---- Not AWS at all ---------------------------------------------------
  // Listed so they are omitted knowingly rather than reported as gaps in the
  // table; `unmappedTypes` should only ever name real AWS services.
  terraform_data: { role: "omit" },
  null_resource: { role: "omit" },
  random_bytes: { role: "omit" },
  random_id: { role: "omit" },
  random_string: { role: "omit" },
  random_password: { role: "omit" },
  random_pet: { role: "omit" },
  random_uuid: { role: "omit" },
  time_sleep: { role: "omit" },
  local_file: { role: "omit" },
  tls_private_key: { role: "omit" },
};

/**
 * Attributes that mean "lives inside". Terraform expresses containment as an
 * ordinary reference, so the attribute name is the only thing separating
 * "is placed in this subnet" from "happens to mention it".
 */
export const CONTAINMENT_ATTRIBUTES: Record<string, "vpc" | "subnet"> = {
  vpc_id: "vpc",
  subnet_id: "subnet",
  subnet_ids: "subnet",
};

/**
 * Terraform prefixes whose icon cannot be found by name. Nearly all of them are
 * abbreviations (`dx` is Direct Connect, `db` is RDS) or names AWS has since
 * changed (`elasticsearch` is now OpenSearch).
 *
 * Only prefixes that actually fail the automatic lookup belong here — `lambda`,
 * `sagemaker` and the other ~100 that resolve on their own are deliberately
 * absent, so this list stays a list of exceptions rather than a second map.
 */
const SERVICE_ICON_ALIASES: Record<string, string> = {
  // ---- Networking and delivery ------------------------------------------
  lb: "elastic-load-balancing",
  alb: "elastic-load-balancing",
  elb: "elastic-load-balancing",
  dx: "direct-connect",
  api: "api-gateway",
  apigatewayv2: "api-gateway",
  vpclattice: "vpc-lattice",
  networkmanager: "cloud-wan",
  globalaccelerator: "global-accelerator",

  // ---- Storage and data --------------------------------------------------
  s3control: "s3",
  s3tables: "s3",
  ebs: "elastic-block-store",
  db: "rds",
  docdb: "document-db",
  dax: "dynamodb",
  elasticsearch: "open-search-service",
  opensearch: "open-search-service",
  opensearchserverless: "open-search-service",
  dms: "database-migration-service",
  redshiftserverless: "redshift",

  // ---- Compute and containers -------------------------------------------
  ecr: "elastic-container-registry",
  ecrpublic: "elastic-container-registry",
  imagebuilder: "ec2-image-builder",
  batch: "batch",
  sfn: "step-functions",
  serverlessapplicationrepository: "serverless-application-repository",

  // ---- Messaging and integration ----------------------------------------
  msk: "managed-streamingfor-apache-kafka",
  mskconnect: "managed-streamingfor-apache-kafka",
  ses: "simple-email-service",
  sesv2: "simple-email-service",
  schemas: "event-bridge",
  cloudwatchevent: "event-bridge",

  // ---- Security ----------------------------------------------------------
  iam: "identityand-access-management",
  ssoadmin: "iam-identity-center",
  identitystore: "iam-identity-center",
  kms: "key-management-service",
  acm: "certificate-manager",
  acmpca: "certificate-manager-certificate-authority",
  wafv2: "waf",
  wafregional: "waf",
  macie2: "macie",
  securityhub: "security-hub",
  guardduty: "guard-duty",
  inspector2: "inspector",

  // ---- Management --------------------------------------------------------
  ssm: "systems-manager",
  ssmcontacts: "systems-manager",
  ssmincidents: "systems-manager",
  ct: "cloud-trail",
  cur: "costand-usage-report",
  ce: "cost-explorer",
  servicecatalog: "service-catalog",
  prometheus: "managed-servicefor-prometheus",
  grafana: "managed-grafana",
  xray: "x-ray",

  // ---- Everything else ---------------------------------------------------
  iot: "io-t-core",
  quicksight: "quick-suite",
  workspacesweb: "work-spaces",
  transfer: "transfer-family",
  mediaconvert: "elemental-media-convert",
  medialive: "elemental-media-live",
  mediapackage: "elemental-media-package",
  mediastore: "elemental-media-store",
};

/**
 * Finds the icon for a resource type from its service prefix.
 *
 * `aws_lambda_function` -> `lambda`, `aws_sagemaker_endpoint` -> `sage-maker`.
 * Matching ignores hyphens because the vendored file names are derived from
 * AWS's product names (`AmazonSageMaker` -> `sage-maker`) while Terraform
 * writes them closed up.
 *
 * Returns `undefined` rather than a guess when nothing matches — the caller
 * renders a box without a picture, which is better than a broken image.
 */
export function resolveServiceIcon(resourceType: string): string | undefined {
  const prefix = resourceType.replace(/^aws_/, "").split("_")[0];
  if (!prefix) return undefined;

  const alias = SERVICE_ICON_ALIASES[prefix];
  if (alias) return alias;

  return AWS_ICONS_BY_FLAT_NAME.get(prefix);
}

export function architectureEntry(
  resourceType: string,
): ArchitectureEntry | null {
  const entry = ARCHITECTURE_MAP[resourceType];
  if (!entry) return null;
  if (entry.role !== "service" || entry.icon) return entry;

  // Curated entries win; this only fills the gap for one-line additions that
  // never named an icon.
  const icon = resolveServiceIcon(resourceType);

  return icon ? { ...entry, icon } : entry;
}

/**
 * Wrapper modules *are* the architecture of many repositories: `aac-aws-vmland`
 * creates almost nothing itself, it wires twenty `cbbac-aws-*` modules
 * together. Unless those calls become boxes, such a diagram stays empty no
 * matter how good the resource handling is.
 *
 * A call is classified by mapping its repository name onto the resource type it
 * stands for, then reusing the table above. That keeps one decision in one
 * place: a KMS key is off the diagram whether it arrived as a resource or as a
 * module call, and a service added to the table is picked up by both paths.
 */
const MODULE_SERVICE_TYPES: Record<string, string> = {
  acm: "aws_acm_certificate",
  alb: "aws_lb",
  "api-gateway": "aws_apigatewayv2_api",
  apigateway: "aws_apigatewayv2_api",
  "application-load-balancer": "aws_lb",
  autoscaling: "aws_autoscaling_group",
  backup: "aws_backup_vault",
  certificate: "aws_acm_certificate",
  cloudfront: "aws_cloudfront_distribution",
  cloudtrail: "aws_cloudtrail",
  cloudwatch: "aws_cloudwatch_log_group",
  "cognito-user-pool": "aws_cognito_user_pool",
  cognito: "aws_cognito_user_pool",
  documentdb: "aws_docdb_cluster",
  dynamodb: "aws_dynamodb_table",
  ec2: "aws_instance",
  ecr: "aws_ecr_repository",
  ecs: "aws_ecs_service",
  efs: "aws_efs_file_system",
  eks: "aws_eks_cluster",
  elasticache: "aws_elasticache_cluster",
  elb: "aws_lb",
  eventbridge: "aws_cloudwatch_event_rule",
  firehose: "aws_kinesis_firehose_delivery_stream",
  "http-api": "aws_apigatewayv2_api",
  iam: "aws_iam_role",
  kinesis: "aws_kinesis_stream",
  kms: "aws_kms_key",
  lambda: "aws_lambda_function",
  "load-balancer": "aws_lb",
  msk: "aws_msk_cluster",
  "nat-gateway": "aws_nat_gateway",
  nlb: "aws_lb",
  opensearch: "aws_opensearch_domain",
  rds: "aws_rds_cluster",
  redshift: "aws_redshift_cluster",
  route53: "aws_route53_record",
  s3: "aws_s3_bucket",
  "secrets-manager": "aws_secretsmanager_secret",
  secretsmanager: "aws_secretsmanager_secret",
  "security-group": "aws_security_group",
  sns: "aws_sns_topic",
  sqs: "aws_sqs_queue",
  ssm: "aws_ssm_parameter",
  stepfunctions: "aws_sfn_state_machine",
  subnet: "aws_subnet",
  "transit-gateway": "aws_ec2_transit_gateway",
  vpc: "aws_vpc",
  waf: "aws_wafv2_web_acl",
  wafv2: "aws_wafv2_web_acl",
};

/**
 * Reduces `cbbac-aws-alb` to `alb`. Everything up to and including the last
 * `aws-` is company prefix and noise; what follows is what the module builds.
 */
export function moduleServiceToken(repoName: string): string {
  const lower = repoName
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "");
  const marker = lower.lastIndexOf("aws-");
  const tail = marker >= 0 ? lower.slice(marker + 4) : lower;

  return tail.replace(/^terraform-/, "").replace(/-modules?$/, "");
}

/**
 * Returns how a module call should be drawn, or `null` when its name says
 * nothing recognisable. Callers draw an unlabelled box in that case rather than
 * dropping it — an unrecognised module may well be the most important thing on
 * the diagram.
 */
export function moduleArchitectureEntry(
  repoName: string,
): ArchitectureEntry | null {
  const token = moduleServiceToken(repoName);
  const type =
    MODULE_SERVICE_TYPES[token] ??
    // `my-alb` has no `aws-` marker; its last segment still carries the service.
    MODULE_SERVICE_TYPES[token.slice(token.lastIndexOf("-") + 1)];

  return type ? architectureEntry(type) : null;
}
