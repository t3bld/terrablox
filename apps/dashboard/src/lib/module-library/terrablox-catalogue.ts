/**
 * What the Terrablox catalogue calls its modules.
 *
 * Shared by the library sync (dashboard and CLI) and the website snapshot, so
 * the library and the marketing page never disagree about a module's name.
 * Pure data; no I/O.
 */

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

/** `terrablox-aws-rds-aurora` -> `rds-aurora`. */
export function serviceSlug(repoName: string, prefix: string): string {
  return (
    repoName.startsWith(prefix) ? repoName.slice(prefix.length) : repoName
  ).trim();
}

/**
 * The name shown in the library: the AWS service the module creates.
 *
 * A repository added upstream before {@link SERVICE_NAMES} learns about it falls
 * back to a title-cased slug — readable enough to ship, obviously not hand-written,
 * and reported at the end of a sync so it gets a real name.
 */
export function terrabloxDisplayName(repoName: string, prefix: string): string {
  const slug = serviceSlug(repoName, prefix);
  const known = SERVICE_NAMES[slug];
  if (known) return known;

  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
