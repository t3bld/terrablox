/**
 * Which AWS service a Terraform resource type belongs to.
 *
 * Grouping a module's resources by provider answers nothing: every resource in
 * an AWS module reports the same provider, so the list collapses into one
 * bucket sorted alphabetically by `aws_*`. That ordering scatters things that
 * belong together — the ECS service, its task definition and its scaling policy
 * end up in three different places — while putting `aws_iam_role` next to
 * `aws_instance` for no reason other than spelling.
 *
 * The service prefix carries the signal instead, and it is mostly derivable:
 * `aws_ecs_service` is ECS, `aws_lambda_function` is Lambda. Mostly, not
 * always, which is why there is a small override table above the prefix table.
 * `aws_cloudwatch_event_rule` is EventBridge rather than CloudWatch, and the
 * networking primitives — `aws_subnet`, `aws_route_table`, `aws_nat_gateway` —
 * share no prefix at all despite all being VPC.
 */

/** Types whose prefix would name the wrong service. */
export const SERVICE_BY_TYPE: Record<string, string> = {
  // Not CloudWatch, despite the `aws_cloudwatch_` prefix.
  aws_cloudwatch_event_rule: "EventBridge",
  aws_cloudwatch_event_target: "EventBridge",
  aws_cloudwatch_event_bus: "EventBridge",
  aws_cloudwatch_log_group: "CloudWatch Logs",
  aws_cloudwatch_log_stream: "CloudWatch Logs",
  aws_cloudwatch_log_resource_policy: "CloudWatch Logs",

  // Billed and drawn as VPC, but each carries its own prefix.
  aws_flow_log: "VPC",
  aws_default_security_group: "VPC",
  // Without these the `default` prefix falls through to the title-caser and
  // names a service "Default", which is not a thing.
  aws_default_route_table: "VPC",
  aws_default_network_acl: "VPC",
  aws_default_vpc: "VPC",
  aws_default_subnet: "VPC",
  aws_main_route_table_association: "VPC",
  aws_ec2_managed_prefix_list: "VPC",

  aws_ec2_transit_gateway: "Transit Gateway",
  aws_ec2_transit_gateway_vpc_attachment: "Transit Gateway",
  aws_ec2_transit_gateway_route_table: "Transit Gateway",

  // The on-premises end of a Site-to-Site VPN. Its `customer` prefix would
  // otherwise be title-cased into a service called "Customer".
  aws_customer_gateway: "Site-to-Site VPN",
  // An EBS volume attached to an instance. `volume` alone names nothing.
  aws_volume_attachment: "EC2",
};

/** `aws_<prefix>_...` -> service. Covers the long tail on its own. */
export const SERVICE_BY_PREFIX: Record<string, string> = {
  // ---- Networking -------------------------------------------------------
  vpc: "VPC",
  subnet: "VPC",
  route: "VPC",
  internet: "VPC",
  egress: "VPC",
  nat: "VPC",
  network: "VPC",
  security: "VPC",
  dx: "Direct Connect",
  globalaccelerator: "Global Accelerator",
  /**
   * Everything below this line exists because of the same failure mode.
   *
   * An unmapped prefix falls through to {@link titleCasePrefix}, which produces a
   * plausible-looking name — "RAM", "Appsync", "Networkfirewall", "VPN" — that no
   * icon is keyed under, because icons are keyed by service label. The name then
   * reads as deliberate while the picture beside it is silently missing, which is
   * the worst of the three possible outcomes: a wrong name would at least be
   * visible. Every prefix that appears in a real module belongs here.
   */
  ram: "Resource Access Manager",
  vpn: "Site-to-Site VPN",
  appsync: "AppSync",
  apprunner: "App Runner",
  appconfig: "AppConfig",
  networkfirewall: "Network Firewall",
  dms: "DMS",
  // Folded into their parent service, the way `s3control` and `elasticsearch`
  // already are: these are variants of one thing to a reader looking at a
  // diagram, and each new label is another icon to keep in step.
  opensearchserverless: "OpenSearch",
  mskconnect: "MSK",
  s3vectors: "S3",
  emrserverless: "EMR",
  emrcontainers: "EMR",
  scheduler: "EventBridge",
  pipes: "EventBridge",
  rolesanywhere: "IAM",

  // ---- Compute ----------------------------------------------------------
  instance: "EC2",
  eip: "EC2",
  ebs: "EC2",
  ami: "EC2",
  key: "EC2",
  launch: "EC2",
  placement: "EC2",
  spot: "EC2",
  autoscaling: "EC2 Auto Scaling",
  appautoscaling: "Application Auto Scaling",
  ecs: "ECS",
  eks: "EKS",
  ecr: "ECR",
  ecrpublic: "ECR",
  lambda: "Lambda",
  batch: "Batch",
  serverlessapplicationrepository: "Serverless Application Repository",

  // ---- Load balancing and edge ------------------------------------------
  lb: "Elastic Load Balancing",
  alb: "Elastic Load Balancing",
  elb: "Elastic Load Balancing",
  cloudfront: "CloudFront",
  api: "API Gateway",
  apigatewayv2: "API Gateway",
  waf: "WAF",
  wafv2: "WAF",
  wafregional: "WAF",

  // ---- Databases --------------------------------------------------------
  db: "RDS",
  rds: "RDS",
  docdb: "DocumentDB",
  dynamodb: "DynamoDB",
  dax: "DynamoDB",
  elasticache: "ElastiCache",
  opensearch: "OpenSearch",
  elasticsearch: "OpenSearch",
  redshift: "Redshift",
  redshiftserverless: "Redshift",
  msk: "MSK",
  neptune: "Neptune",
  timestreamwrite: "Timestream",
  memorydb: "MemoryDB",

  // ---- Storage ----------------------------------------------------------
  s3: "S3",
  s3control: "S3",
  s3tables: "S3",
  glacier: "S3 Glacier",
  efs: "EFS",
  fsx: "FSx",
  backup: "Backup",
  storagegateway: "Storage Gateway",

  // ---- Messaging and integration ----------------------------------------
  sqs: "SQS",
  sns: "SNS",
  kinesis: "Kinesis",
  sfn: "Step Functions",
  schemas: "EventBridge",
  mq: "Amazon MQ",
  ses: "SES",
  sesv2: "SES",

  // ---- Observability ----------------------------------------------------
  cloudwatch: "CloudWatch",
  cloudtrail: "CloudTrail",
  xray: "X-Ray",
  grafana: "Managed Grafana",
  prometheus: "Managed Prometheus",

  // ---- Security and identity --------------------------------------------
  iam: "IAM",
  kms: "KMS",
  secretsmanager: "Secrets Manager",
  ssm: "Systems Manager",
  ssoadmin: "IAM Identity Center",
  identitystore: "IAM Identity Center",
  acm: "Certificate Manager",
  acmpca: "Private Certificate Authority",
  cognito: "Cognito",
  guardduty: "GuardDuty",
  securityhub: "Security Hub",
  inspector2: "Inspector",
  macie2: "Macie",
  shield: "Shield",
  organizations: "Organizations",

  // ---- DNS and discovery ------------------------------------------------
  route53: "Route 53",
  route53resolver: "Route 53 Resolver",
  servicediscovery: "Cloud Map",

  // ---- Analytics --------------------------------------------------------
  glue: "Glue",
  athena: "Athena",
  emr: "EMR",
  quicksight: "QuickSight",
  lakeformation: "Lake Formation",

  // ---- Developer tooling -------------------------------------------------
  codebuild: "CodeBuild",
  codepipeline: "CodePipeline",
  codecommit: "CodeCommit",
  codedeploy: "CodeDeploy",
  cloudformation: "CloudFormation",
  servicecatalog: "Service Catalog",
};

/**
 * The icon for a service, keyed by the label the functions below return.
 *
 * Keyed by service rather than by resource type so the picture can never
 * contradict the name printed beside it: `aws_flow_log` is grouped under VPC,
 * and drawing it with the CloudWatch icon its resource type suggests would
 * label one box two different things.
 */
export const ICON_BY_SERVICE: Record<string, string> = {
  // ---- Networking -------------------------------------------------------
  VPC: "vpc",
  "Transit Gateway": "transit-gateway",
  "Site-to-Site VPN": "siteto-site-vpn",
  "Direct Connect": "direct-connect",
  "Global Accelerator": "global-accelerator",
  "Resource Access Manager": "resource-access-manager",

  // ---- Compute ----------------------------------------------------------
  EC2: "ec2",
  "EC2 Auto Scaling": "ec2-auto-scaling",
  "Application Auto Scaling": "application-auto-scaling",
  "App Runner": "app-runner",
  ECS: "ecs",
  EKS: "eks",
  ECR: "elastic-container-registry",
  Lambda: "lambda",
  Batch: "batch",
  "Serverless Application Repository": "serverless-application-repository",

  // ---- Load balancing and edge ------------------------------------------
  "Elastic Load Balancing": "elastic-load-balancing",
  CloudFront: "cloudfront",
  "API Gateway": "api-gateway",
  WAF: "waf",

  // ---- Databases --------------------------------------------------------
  RDS: "rds",
  DMS: "database-migration-service",
  DocumentDB: "document-db",
  DynamoDB: "dynamodb",
  ElastiCache: "elasticache",
  OpenSearch: "open-search-service",
  Redshift: "redshift",
  MSK: "managed-streamingfor-apache-kafka",
  Neptune: "neptune",
  Timestream: "timestream",
  MemoryDB: "memory-db",

  // ---- Storage ----------------------------------------------------------
  S3: "s3",
  "S3 Glacier": "simple-storage-service-glacier",
  EFS: "efs",
  FSx: "f-sx",
  Backup: "backup",
  "Storage Gateway": "storage-gateway",

  // ---- Messaging and integration ----------------------------------------
  SQS: "sqs",
  SNS: "sns",
  Kinesis: "kinesis",
  "Step Functions": "step-functions",
  EventBridge: "event-bridge",
  "Amazon MQ": "mq",
  SES: "simple-email-service",
  AppSync: "app-sync",

  // ---- Observability ----------------------------------------------------
  CloudWatch: "cloudwatch",
  "CloudWatch Logs": "cloud-watch-logs",
  CloudTrail: "cloud-trail",
  "X-Ray": "x-ray",
  "Managed Grafana": "managed-grafana",
  "Managed Prometheus": "managed-servicefor-prometheus",

  // ---- Security and identity --------------------------------------------
  IAM: "identityand-access-management",
  KMS: "key-management-service",
  "Secrets Manager": "secrets-manager",
  "Systems Manager": "systems-manager",
  "IAM Identity Center": "iam-identity-center",
  "Certificate Manager": "certificate-manager",
  "Private Certificate Authority": "certificate-manager-certificate-authority",
  Cognito: "cognito",
  GuardDuty: "guard-duty",
  "Security Hub": "security-hub",
  Inspector: "inspector",
  Macie: "macie",
  Shield: "shield",
  "Network Firewall": "network-firewall",
  Organizations: "organizations",

  // ---- DNS and discovery ------------------------------------------------
  "Route 53": "route53",
  "Route 53 Resolver": "route53-resolver",
  "Cloud Map": "cloud-map",

  // ---- Analytics --------------------------------------------------------
  Glue: "glue",
  Athena: "athena",
  EMR: "emr",
  QuickSight: "quick-suite",
  "Lake Formation": "lake-formation",

  // ---- Developer tooling -------------------------------------------------
  CodeBuild: "code-build",
  CodePipeline: "code-pipeline",
  CodeCommit: "code-commit",
  CodeDeploy: "code-deploy",
  CloudFormation: "cloud-formation",
  "Service Catalog": "service-catalog",
  AppConfig: "app-config",
};

/** Undefined for a service with no vendored icon; the caller draws a fallback. */
export function iconOfService(service: string): string | undefined {
  return ICON_BY_SERVICE[service];
}

/** Turns an unmapped prefix into something readable rather than "Other". */
function titleCasePrefix(prefix: string): string {
  return prefix.length <= 4
    ? prefix.toUpperCase()
    : prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

/**
 * The service a resource is grouped under.
 *
 * Non-AWS resources are grouped by their provider instead of being forced into
 * an AWS service they do not belong to — a `random_password` is not an AWS
 * service and pretending otherwise would be a worse answer than the honest one.
 */
export function serviceOfResource(
  resourceType: string,
  providerName: string,
): string {
  if (!resourceType.startsWith("aws_")) {
    return providerName || "Other";
  }

  const override = SERVICE_BY_TYPE[resourceType];
  if (override) return override;

  const prefix = resourceType.replace(/^aws_/, "").split("_")[0];
  if (!prefix) return "AWS";

  return SERVICE_BY_PREFIX[prefix] ?? titleCasePrefix(prefix);
}
