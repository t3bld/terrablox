/**
 * What each Terraform resource does to an AWS bill — the structure of the cost,
 * never an amount.
 *
 * A module on its own cannot be priced, and pretending otherwise would be the
 * whole value of this view thrown away. The numbers that decide the bill are
 * inputs supplied at deploy time: `instance_type`, `desired_count`, whatever
 * `count` resolves to. The same `aws_ecs_service` is twenty euros a month or
 * twenty thousand. A figure shown here would be read as a promise, so this
 * table answers the question that *is* answerable from source alone: which
 * resources cost anything, and what the amount would depend on.
 *
 * Like `ARCHITECTURE_MAP` this is a curated table rather than a heuristic, and
 * for the same reason — the naming carries no signal. `aws_ecs_cluster` is
 * free while `aws_ecs_service` is not; `aws_nat_gateway` bills per hour while
 * the `aws_internet_gateway` beside it never bills at all. Nothing in those
 * names says so, and no AWS API answers it either: prices are published per
 * SKU, never per Terraform resource type.
 *
 * So the table has two tiers. `COST_DRIVER_MAP` is written by hand and holds
 * the types worth explaining. `FREE_RESOURCE_TYPES` below covers the long tail
 * of attachments, policies and associations, taken from the classification
 * Infracost maintains across the whole provider. A type in neither is reported
 * as unclassified rather than silently assumed free, because a wrong "no cost"
 * is the one error here that actually misleads.
 */

/**
 * How a resource reaches the bill.
 *
 * - `recurring` — charged for existing, whether or not anything uses it
 * - `usage` — charged per request, per GB, per invocation; nothing when idle
 * - `free` — no charge for the resource itself
 */
export type CostClass = "recurring" | "usage" | "free";

export interface CostDriverEntry {
  costClass: CostClass;
  /** What the amount scales with, in the terms AWS bills in. */
  driver?: string;
  /**
   * Input-name fragments that typically size this resource. Matched against the
   * module's own variables so the view can point at the knobs that matter
   * instead of listing every input.
   */
  sizedBy?: readonly string[];
}

export const COST_DRIVER_MAP: Record<string, CostDriverEntry> = {
  // ---- Compute ----------------------------------------------------------
  aws_ec2_host: {
    costClass: "recurring",
    driver:
      "A dedicated host bills for the whole machine per hour, however few instances actually run on it.",
    sizedBy: ["instance_type", "instance_family"],
  },
  aws_spot_instance_request: {
    costClass: "recurring",
    driver: "Instance hours at the spot price, which moves with demand.",
    sizedBy: ["instance_type", "spot_price"],
  },
  aws_eks_fargate_profile: {
    costClass: "usage",
    driver: "vCPU and memory of whichever pods are scheduled onto Fargate.",
  },
  aws_elastic_beanstalk_environment: {
    costClass: "recurring",
    driver: "The instances and load balancer the environment provisions.",
    sizedBy: ["instance_type", "min_size", "max_size"],
  },
  aws_lightsail_instance: {
    costClass: "recurring",
    driver: "A flat monthly price per bundle size.",
    sizedBy: ["bundle_id"],
  },
  aws_mwaa_environment: {
    costClass: "recurring",
    driver:
      "An hourly charge per environment, plus worker hours and metadata storage.",
    sizedBy: ["environment_class", "min_workers", "max_workers"],
  },
  aws_instance: {
    costClass: "recurring",
    driver:
      "Instance hours, billed per second while running, plus EBS storage.",
    sizedBy: ["instance_type", "instance_count", "root_volume", "volume_size"],
  },
  aws_autoscaling_group: {
    costClass: "recurring",
    driver: "Instance hours for however many instances are in service.",
    sizedBy: ["min_size", "max_size", "desired_capacity", "instance_type"],
  },
  aws_ecs_service: {
    costClass: "recurring",
    driver:
      "On Fargate: vCPU and memory reserved per task, times the task count. On EC2: nothing beyond the instances behind it.",
    sizedBy: ["cpu", "memory", "desired_count", "task_count", "launch_type"],
  },
  aws_eks_cluster: {
    costClass: "recurring",
    driver: "A flat hourly charge per cluster, plus the nodes it runs.",
  },
  aws_eks_node_group: {
    costClass: "recurring",
    driver: "Instance hours for the nodes.",
    sizedBy: ["instance_types", "desired_size", "min_size", "max_size"],
  },
  aws_lambda_function: {
    costClass: "usage",
    driver:
      "Requests plus GB-seconds: memory multiplied by execution time. Nothing when it never runs.",
    sizedBy: ["memory_size", "timeout", "provisioned_concurrency"],
  },
  aws_batch_compute_environment: {
    costClass: "usage",
    driver: "Instance hours for jobs that actually run.",
  },
  aws_launch_template: { costClass: "free" },
  aws_ecs_cluster: {
    costClass: "free",
    driver: "The cluster is free; its tasks and instances are not.",
  },
  aws_ecs_task_definition: {
    costClass: "free",
    driver:
      "Free to hold, but its cpu and memory are what each task of the service is billed for.",
    sizedBy: ["cpu", "memory"],
  },
  aws_ecs_capacity_provider: { costClass: "free" },
  aws_appautoscaling_target: {
    costClass: "free",
    driver:
      "Free itself, and the single most useful number for the bill: the capacity bounds decide how many tasks or instances can ever run.",
    sizedBy: ["min_capacity", "max_capacity", "desired_count"],
  },
  aws_appautoscaling_policy: {
    costClass: "free",
    driver:
      "Free itself. Decides where between the minimum and maximum capacity the service actually sits, so it sets the bill within those bounds.",
    sizedBy: ["target_value", "cpu_target", "memory_target"],
  },
  aws_appautoscaling_scheduled_action: {
    costClass: "free",
    driver:
      "Free itself. Moves the capacity bounds on a schedule, e.g. scaling to zero outside office hours.",
  },
  aws_autoscaling_policy: {
    costClass: "free",
    driver:
      "Free itself. Decides how many instances of the group are in service, which is what gets billed.",
  },
  aws_autoscaling_schedule: {
    costClass: "free",
    driver: "Free itself. Changes the group's capacity on a schedule.",
  },
  aws_autoscaling_attachment: { costClass: "free" },

  // ---- Networking -------------------------------------------------------
  aws_ec2_client_vpn_endpoint: {
    costClass: "recurring",
    driver:
      "An hourly charge for every subnet association, plus an hourly charge per connected client.",
    sizedBy: ["subnet_ids", "availability_zones"],
  },
  aws_ec2_client_vpn_network_association: {
    costClass: "recurring",
    driver: "Each association adds an hourly charge for as long as it exists.",
  },
  aws_ec2_transit_gateway_peering_attachment: {
    costClass: "recurring",
    driver: "An hourly charge per attachment plus every GB crossing it.",
  },
  aws_ec2_traffic_mirror_session: {
    costClass: "recurring",
    driver: "An hourly charge for every network interface being mirrored.",
  },
  aws_dx_gateway_association: {
    costClass: "recurring",
    driver: "Billed per virtual interface on the Direct Connect link.",
  },
  aws_networkfirewall_firewall: {
    costClass: "recurring",
    driver:
      "An hourly charge per endpoint — one per subnet — plus every GB inspected.",
    sizedBy: ["subnet_mapping", "subnet_ids", "availability_zones"],
  },
  aws_globalaccelerator_endpoint_group: {
    costClass: "usage",
    driver: "A data transfer premium on every GB routed to the endpoints.",
  },
  aws_directory_service_directory: {
    costClass: "recurring",
    driver: "An hourly charge per directory, set by size and edition.",
    sizedBy: ["size", "edition", "type"],
  },
  aws_transfer_server: {
    costClass: "recurring",
    driver:
      "An hourly charge for every enabled protocol, plus data uploaded and downloaded.",
    sizedBy: ["protocols"],
  },
  aws_nat_gateway: {
    costClass: "recurring",
    driver:
      "An hourly charge per gateway plus every GB processed. One per availability zone multiplies both.",
    sizedBy: ["availability_zones", "azs", "single_nat_gateway"],
  },
  aws_eip: {
    costClass: "recurring",
    driver: "An hourly charge per address, whether or not it is attached.",
  },
  aws_vpc_endpoint: {
    costClass: "recurring",
    driver:
      "Interface endpoints bill per hour per availability zone plus data processed. Gateway endpoints for S3 and DynamoDB are free.",
    sizedBy: ["endpoint_type", "subnet_ids"],
  },
  aws_ec2_transit_gateway: {
    costClass: "recurring",
    driver: "An hourly charge per attachment plus data processed.",
  },
  aws_ec2_transit_gateway_vpc_attachment: {
    costClass: "recurring",
    driver: "An hourly charge per attachment.",
  },
  aws_vpn_connection: {
    costClass: "recurring",
    driver: "An hourly charge per connection plus data transfer.",
  },
  aws_dx_connection: {
    costClass: "recurring",
    driver: "Port hours plus data transfer out.",
  },
  aws_globalaccelerator_accelerator: {
    costClass: "recurring",
    driver: "A fixed hourly charge plus data transfer.",
  },
  aws_vpc: { costClass: "free" },
  aws_subnet: { costClass: "free" },
  aws_internet_gateway: { costClass: "free" },
  aws_egress_only_internet_gateway: { costClass: "free" },
  aws_vpn_gateway: { costClass: "free" },
  aws_route_table: { costClass: "free" },
  aws_route: { costClass: "free" },
  aws_route_table_association: { costClass: "free" },
  aws_main_route_table_association: { costClass: "free" },
  aws_security_group: { costClass: "free" },
  aws_default_security_group: { costClass: "free" },
  aws_security_group_rule: { costClass: "free" },
  aws_vpc_security_group_ingress_rule: { costClass: "free" },
  aws_vpc_security_group_egress_rule: { costClass: "free" },
  aws_network_acl: { costClass: "free" },
  aws_network_acl_rule: { costClass: "free" },
  aws_ec2_managed_prefix_list: { costClass: "free" },
  aws_vpc_endpoint_service: { costClass: "free" },

  // ---- Load balancing and edge ------------------------------------------
  aws_elb: {
    costClass: "recurring",
    driver: "An hourly charge per balancer plus every GB it processes.",
  },
  aws_cloudfront_function: {
    costClass: "usage",
    driver: "Per million invocations, and nothing while idle.",
  },
  aws_api_gateway_stage: {
    costClass: "recurring",
    driver:
      "Free unless caching is switched on, in which case the cache is billed per hour by its size.",
    sizedBy: ["cache_cluster_enabled", "cache_cluster_size"],
  },
  aws_waf_web_acl: {
    costClass: "recurring",
    driver:
      "A monthly charge per ACL and per rule, plus a charge per million requests inspected.",
  },
  aws_lb: {
    costClass: "recurring",
    driver:
      "An hourly charge per balancer plus capacity units, which track connections, new requests and bandwidth.",
  },
  aws_alb: {
    costClass: "recurring",
    driver:
      "An hourly charge per balancer plus capacity units, which track connections, new requests and bandwidth.",
  },
  aws_cloudfront_distribution: {
    costClass: "usage",
    driver: "Data transferred out to the internet plus requests served.",
  },
  aws_apigatewayv2_api: {
    costClass: "usage",
    driver: "Per million requests.",
  },
  aws_api_gateway_rest_api: {
    costClass: "usage",
    driver: "Per million requests, at a higher rate than HTTP APIs.",
  },
  aws_wafv2_web_acl: {
    costClass: "recurring",
    driver:
      "A monthly charge per web ACL and per rule, plus every million requests inspected.",
  },
  aws_lb_target_group: { costClass: "free" },
  aws_lb_listener: { costClass: "free" },
  aws_lb_listener_rule: { costClass: "free" },
  aws_lb_target_group_attachment: { costClass: "free" },
  aws_alb_listener: { costClass: "free" },
  aws_apigatewayv2_stage: { costClass: "free" },
  aws_apigatewayv2_route: { costClass: "free" },
  aws_apigatewayv2_integration: { costClass: "free" },
  aws_apigatewayv2_deployment: { costClass: "free" },
  aws_apigatewayv2_api_mapping: { costClass: "free" },
  aws_apigatewayv2_domain_name: { costClass: "free" },
  aws_cloudfront_origin_access_control: { costClass: "free" },
  aws_cloudfront_origin_access_identity: { costClass: "free" },
  aws_cloudfront_vpc_origin: { costClass: "free" },
  aws_wafv2_web_acl_association: { costClass: "free" },
  aws_wafv2_web_acl_logging_configuration: { costClass: "free" },

  // ---- Databases --------------------------------------------------------
  aws_docdb_cluster_instance: {
    costClass: "recurring",
    driver: "Instance hours per instance in the cluster.",
    sizedBy: ["instance_class", "instance_count"],
  },
  aws_docdb_cluster_snapshot: {
    costClass: "recurring",
    driver: "Per GB-month of snapshot storage beyond the cluster's own.",
  },
  aws_neptune_cluster: {
    costClass: "recurring",
    driver: "Storage and I/O for the cluster, plus its instances.",
  },
  aws_neptune_cluster_instance: {
    costClass: "recurring",
    driver: "Instance hours per instance in the cluster.",
    sizedBy: ["instance_class", "instance_count"],
  },
  aws_neptune_cluster_snapshot: {
    costClass: "recurring",
    driver: "Per GB-month of snapshot storage.",
  },
  aws_elasticsearch_domain: {
    costClass: "recurring",
    driver: "Node hours plus the EBS storage attached to each node.",
    sizedBy: ["instance_type", "instance_count", "volume_size"],
  },
  aws_dms_replication_instance: {
    costClass: "recurring",
    driver: "Instance hours plus the storage the replication instance holds.",
    sizedBy: ["replication_instance_class", "allocated_storage"],
  },
  aws_mq_broker: {
    costClass: "recurring",
    driver:
      "Broker instance hours plus storage. An active/standby deployment doubles the instance hours.",
    sizedBy: ["instance_type", "deployment_mode", "storage_type"],
  },
  aws_db_instance: {
    costClass: "recurring",
    driver:
      "Instance hours plus provisioned storage and backups. Multi-AZ doubles the instance charge.",
    sizedBy: [
      "instance_class",
      "allocated_storage",
      "multi_az",
      "backup_retention",
    ],
  },
  aws_rds_cluster: {
    costClass: "recurring",
    driver:
      "Storage and I/O for the cluster; the instances below it are charged separately. Serverless v2 bills per capacity unit hour instead.",
    sizedBy: ["engine_mode", "serverless", "min_capacity", "max_capacity"],
  },
  aws_rds_cluster_instance: {
    costClass: "recurring",
    driver: "Instance hours per writer and reader.",
    sizedBy: ["instance_class", "instance_count", "replica_count"],
  },
  aws_dynamodb_table: {
    costClass: "usage",
    driver:
      "On-demand: per million reads and writes plus stored GB. Provisioned: reserved capacity per hour whether used or not.",
    sizedBy: ["billing_mode", "read_capacity", "write_capacity"],
  },
  aws_elasticache_cluster: {
    costClass: "recurring",
    driver: "Node hours per cache node.",
    sizedBy: ["node_type", "num_cache_nodes"],
  },
  aws_elasticache_replication_group: {
    costClass: "recurring",
    driver: "Node hours across every node in the group.",
    sizedBy: ["node_type", "num_cache_clusters", "num_node_groups"],
  },
  aws_docdb_cluster: {
    costClass: "recurring",
    driver: "Instance hours plus storage and I/O.",
    sizedBy: ["instance_class", "instance_count"],
  },
  aws_opensearch_domain: {
    costClass: "recurring",
    driver: "Instance hours plus EBS storage per node.",
    sizedBy: ["instance_type", "instance_count", "volume_size"],
  },
  aws_redshift_cluster: {
    costClass: "recurring",
    driver: "Node hours per node.",
    sizedBy: ["node_type", "number_of_nodes"],
  },
  aws_msk_cluster: {
    costClass: "recurring",
    driver: "Broker hours plus provisioned storage.",
    sizedBy: ["instance_type", "number_of_broker_nodes", "volume_size"],
  },
  aws_db_subnet_group: { costClass: "free" },
  aws_db_parameter_group: { costClass: "free" },
  aws_rds_cluster_parameter_group: { costClass: "free" },
  aws_elasticache_subnet_group: { costClass: "free" },

  // ---- Storage ----------------------------------------------------------
  aws_ebs_snapshot: {
    costClass: "recurring",
    driver: "Per GB-month of snapshot storage.",
  },
  aws_ebs_snapshot_copy: {
    costClass: "recurring",
    driver: "Per GB-month of snapshot storage, plus the transfer of the copy.",
  },
  aws_fsx_windows_file_system: {
    costClass: "recurring",
    driver:
      "Provisioned capacity, throughput and backups, whether used or not.",
    sizedBy: ["storage_capacity", "throughput_capacity", "deployment_type"],
  },
  aws_fsx_openzfs_file_system: {
    costClass: "recurring",
    driver: "Provisioned capacity and throughput, whether used or not.",
    sizedBy: ["storage_capacity", "throughput_capacity", "deployment_type"],
  },
  aws_s3_bucket_inventory: {
    costClass: "usage",
    driver: "Per million objects listed in each report.",
  },
  aws_s3_bucket_analytics_configuration: {
    costClass: "usage",
    driver: "Per million objects monitored each month.",
  },
  aws_s3_bucket: {
    costClass: "usage",
    driver:
      "Stored GB per storage class, requests, and data transferred out. An empty bucket costs nothing.",
  },
  aws_ebs_volume: {
    costClass: "recurring",
    driver: "Provisioned GB per month, charged whether or not it is attached.",
    sizedBy: ["volume_size", "volume_type", "iops"],
  },
  aws_efs_file_system: {
    costClass: "usage",
    driver: "Stored GB per storage class, plus throughput if provisioned.",
    sizedBy: ["throughput_mode", "provisioned_throughput"],
  },
  aws_fsx_lustre_file_system: {
    costClass: "recurring",
    driver: "Provisioned capacity per GB month.",
    sizedBy: ["storage_capacity"],
  },
  aws_ecr_repository: {
    costClass: "usage",
    driver: "Stored GB of images plus data transferred out.",
  },
  aws_backup_vault: {
    costClass: "usage",
    driver: "Stored GB of recovery points.",
  },
  aws_s3_bucket_policy: { costClass: "free" },
  aws_s3_bucket_versioning: {
    costClass: "free",
    driver: "Free to enable, but every retained version is billed as storage.",
  },
  aws_s3_bucket_public_access_block: { costClass: "free" },
  aws_s3_bucket_server_side_encryption_configuration: { costClass: "free" },
  aws_s3_bucket_lifecycle_configuration: { costClass: "free" },

  // ---- Messaging and integration ----------------------------------------
  aws_cloudwatch_event_bus: {
    costClass: "usage",
    driver:
      "Per million custom or third-party events published. AWS service events are free.",
  },
  aws_sns_topic_subscription: {
    costClass: "usage",
    driver:
      "Per notification delivered, at a rate that depends on the protocol. SMS is far above the rest.",
    sizedBy: ["protocol"],
  },
  aws_kinesis_analytics_application: {
    costClass: "recurring",
    driver: "Per processing-unit hour for as long as the application runs.",
  },
  aws_kinesisanalyticsv2_application: {
    costClass: "recurring",
    driver:
      "Per processing-unit hour for as long as the application runs, plus running application storage.",
  },
  aws_kinesisanalyticsv2_application_snapshot: {
    costClass: "recurring",
    driver: "Per GB-month of running application storage.",
  },
  aws_glue_job: {
    costClass: "usage",
    driver: "Per DPU hour while the job runs, billed by the second.",
    sizedBy: ["worker_type", "number_of_workers", "max_capacity"],
  },
  aws_glue_crawler: {
    costClass: "usage",
    driver: "Per DPU hour while the crawler runs.",
  },
  aws_glue_catalog_database: {
    costClass: "usage",
    driver: "Per 100k objects stored and per million requests.",
  },
  aws_codebuild_project: {
    costClass: "usage",
    driver: "Per build minute at the rate of the chosen compute type.",
    sizedBy: ["compute_type", "build_timeout"],
  },
  aws_cloudformation_stack: {
    costClass: "usage",
    driver:
      "Per handler operation for third-party resource types. Native AWS types are free.",
  },
  aws_cloudformation_stack_set: {
    costClass: "usage",
    driver:
      "Per handler operation for third-party resource types. Native AWS types are free.",
  },
  aws_ssm_activation: {
    costClass: "recurring",
    driver:
      "Per on-premises instance registered under advanced-tier management.",
    sizedBy: ["registration_limit"],
  },
  aws_sqs_queue: {
    costClass: "usage",
    driver: "Per million requests, with a perpetual free tier.",
  },
  aws_sns_topic: {
    costClass: "usage",
    driver:
      "Per million publishes plus per delivery, which varies by protocol.",
  },
  aws_kinesis_stream: {
    costClass: "recurring",
    driver:
      "Shard hours in provisioned mode, charged continuously; on-demand bills per GB instead.",
    sizedBy: ["shard_count", "stream_mode"],
  },
  aws_kinesis_firehose_delivery_stream: {
    costClass: "usage",
    driver: "Per GB ingested.",
  },
  aws_sfn_state_machine: {
    costClass: "usage",
    driver:
      "Standard workflows bill per state transition; express workflows per request and duration.",
  },
  aws_cloudwatch_event_rule: {
    costClass: "free",
    driver: "AWS-source events are free; custom events bill per million.",
  },
  aws_lambda_permission: { costClass: "free" },
  aws_lambda_event_source_mapping: { costClass: "free" },

  // ---- Observability ----------------------------------------------------
  aws_config_configuration_recorder: {
    costClass: "usage",
    driver:
      "Per configuration item recorded. Chatty resources record often, so this scales with change, not with size.",
  },
  aws_config_config_rule: {
    costClass: "usage",
    driver: "Per rule evaluation.",
  },
  aws_config_organization_custom_rule: {
    costClass: "usage",
    driver: "Per rule evaluation, in every account the rule reaches.",
  },
  aws_config_organization_managed_rule: {
    costClass: "usage",
    driver: "Per rule evaluation, in every account the rule reaches.",
  },
  aws_cloudwatch_log_group: {
    costClass: "usage",
    driver:
      "Per GB ingested, then per GB stored for as long as retention keeps it. Retention set to never expire is the usual surprise.",
    sizedBy: ["retention_in_days", "log_retention"],
  },
  aws_flow_log: {
    costClass: "usage",
    driver:
      "Per GB of captured traffic. Logging all traffic on a busy VPC is expensive.",
    sizedBy: ["traffic_type", "flow_log_retention"],
  },
  aws_cloudtrail: {
    costClass: "usage",
    driver:
      "The first management-event trail is free; extra trails and data events bill per event, plus S3 storage.",
  },
  aws_cloudwatch_metric_alarm: {
    costClass: "recurring",
    driver: "A monthly charge per alarm.",
  },
  aws_cloudwatch_dashboard: {
    costClass: "recurring",
    driver: "A monthly charge per dashboard beyond the first three.",
  },
  aws_cloudwatch_log_resource_policy: { costClass: "free" },
  aws_cloudwatch_log_stream: { costClass: "free" },

  // ---- Security and identity --------------------------------------------
  aws_kms_external_key: {
    costClass: "recurring",
    driver: "A monthly charge per key, plus a charge per API request.",
  },
  aws_kms_key: {
    costClass: "recurring",
    driver: "A monthly charge per key plus API requests.",
  },
  aws_secretsmanager_secret: {
    costClass: "recurring",
    driver: "A monthly charge per secret plus API requests.",
  },
  aws_cognito_user_pool: {
    costClass: "usage",
    driver: "Per monthly active user, above a free tier.",
  },
  aws_acm_certificate: {
    costClass: "free",
    driver: "Public certificates are free; private CA certificates are not.",
  },
  aws_acmpca_certificate_authority: {
    costClass: "recurring",
    driver: "A monthly charge per authority plus per certificate issued.",
  },
  aws_ssm_parameter: {
    costClass: "free",
    driver: "Standard parameters are free; advanced parameters bill monthly.",
    sizedBy: ["tier"],
  },
  aws_iam_role: { costClass: "free" },
  aws_iam_role_policy: { costClass: "free" },
  aws_iam_policy: { costClass: "free" },
  aws_iam_role_policy_attachment: { costClass: "free" },
  aws_iam_instance_profile: { costClass: "free" },
  aws_iam_openid_connect_provider: { costClass: "free" },
  aws_kms_alias: { costClass: "free" },
  aws_secretsmanager_secret_version: { costClass: "free" },

  // ---- DNS --------------------------------------------------------------
  aws_route53_resolver_endpoint: {
    costClass: "recurring",
    driver:
      "An hourly charge per network interface — one per IP address — plus a charge per million queries.",
    sizedBy: ["ip_address", "ip_addresses"],
  },
  aws_route53_zone: {
    costClass: "recurring",
    driver: "A monthly charge per hosted zone plus queries answered.",
  },
  aws_route53_record: {
    costClass: "free",
    driver:
      "Records are free; the queries against them are billed by the zone.",
  },
  aws_route53_health_check: {
    costClass: "recurring",
    driver: "A monthly charge per health check.",
  },
  aws_acm_certificate_validation: { costClass: "free" },

  // ---- Not AWS at all ---------------------------------------------------
  // Listed so they are classified rather than reported as gaps.
  terraform_data: { costClass: "free" },
  null_resource: { costClass: "free" },
  random_bytes: { costClass: "free" },
  random_id: { costClass: "free" },
  random_string: { costClass: "free" },
  random_password: { costClass: "free" },
  random_pet: { costClass: "free" },
  random_uuid: { costClass: "free" },
  time_sleep: { costClass: "free" },
  local_file: { costClass: "free" },
  tls_private_key: { costClass: "free" },
};

/**
 * Types Infracost publishes as free, minus the ones above that carry an
 * explanation worth reading.
 *
 * This exists so that the long tail — attachments, policies, associations,
 * parameter groups — resolves without every one of them being written out by
 * hand. Infracost is the closest thing to an authority here: AWS publishes
 * prices per SKU, never per Terraform resource type, so nothing upstream can
 * answer "does this block bill". Infracost maintains that judgement across the
 * whole provider, and this project already relies on it for project costs.
 *
 * Entries in `COST_DRIVER_MAP` win, so a considered classification is never
 * overridden by this list.
 *
 * @see https://www.infracost.io/docs/supported_resources/aws/
 */
const FREE_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "aws_accessanalyzer_analyzer",
  "aws_accessanalyzer_archive_rule",
  "aws_acmpca_permission",
  "aws_acmpca_policy",
  "aws_account_alternate_contact",
  "aws_alb_listener_certificate",
  "aws_alb_listener_rule",
  "aws_alb_target_group",
  "aws_alb_target_group_attachment",
  "aws_ami_launch_permission",
  "aws_amplify_backend_environment",
  "aws_amplify_branch",
  "aws_amplify_domain_association",
  "aws_amplify_webhook",
  "aws_api_gateway_account",
  "aws_api_gateway_api_key",
  "aws_api_gateway_authorizer",
  "aws_api_gateway_base_path_mapping",
  "aws_api_gateway_client_certificate",
  "aws_api_gateway_deployment",
  "aws_api_gateway_documentation_part",
  "aws_api_gateway_documentation_version",
  "aws_api_gateway_domain_name",
  "aws_api_gateway_gateway_response",
  "aws_api_gateway_integration",
  "aws_api_gateway_integration_response",
  "aws_api_gateway_method",
  "aws_api_gateway_method_response",
  "aws_api_gateway_method_settings",
  "aws_api_gateway_model",
  "aws_api_gateway_request_validator",
  "aws_api_gateway_resource",
  "aws_api_gateway_response",
  "aws_api_gateway_rest_api_policy",
  "aws_api_gateway_usage_plan",
  "aws_api_gateway_usage_plan_key",
  "aws_api_gateway_vpc_link",
  "aws_apigatewayv2_authorizer",
  "aws_apigatewayv2_integration_response",
  "aws_apigatewayv2_model",
  "aws_apigatewayv2_route_response",
  "aws_apigatewayv2_vpc_link",
  "aws_app_cookie_stickiness_policy",
  "aws_appconfig_extension",
  "aws_appconfig_extension_association",
  "aws_appconfig_hosted_configuration_version",
  "aws_appflow_connector_profile",
  "aws_appintegrations_event_integration",
  "aws_appmesh_gateway_route",
  "aws_appmesh_mesh",
  "aws_appmesh_route",
  "aws_appmesh_virtual_gateway",
  "aws_appmesh_virtual_node",
  "aws_appmesh_virtual_router",
  "aws_appmesh_virtual_service",
  "aws_autoscaling_group_tag",
  "aws_autoscaling_lifecycle_hook",
  "aws_autoscaling_notification",
  "aws_backup_global_settings",
  "aws_backup_plan",
  "aws_backup_region_settings",
  "aws_backup_selection",
  "aws_backup_vault_notifications",
  "aws_backup_vault_policy",
  "aws_cloudformation_stack_set_instance",
  "aws_cloudformation_type",
  "aws_cloudfront_public_key",
  "aws_cloudwatch_event_permission",
  "aws_cloudwatch_event_target",
  "aws_cloudwatch_log_destination",
  "aws_cloudwatch_log_destination_policy",
  "aws_cloudwatch_log_metric_filter",
  "aws_cloudwatch_log_subscription_filter",
  "aws_codebuild_report_group",
  "aws_codebuild_source_credential",
  "aws_codebuild_webhook",
  "aws_config_aggregate_authorization",
  "aws_config_configuration_aggregator",
  "aws_config_configuration_recorder_status",
  "aws_config_delivery_channel",
  "aws_config_remediation_configuration",
  "aws_customer_gateway",
  "aws_db_instance_role_association",
  "aws_db_option_group",
  "aws_default_network_acl",
  "aws_default_route_table",
  "aws_default_subnet",
  "aws_default_vpc",
  "aws_default_vpc_dhcp_options",
  "aws_dms_replication_subnet_group",
  "aws_dms_replication_task",
  "aws_docdb_cluster_parameter_group",
  "aws_docdb_subnet_group",
  "aws_dx_bgp_peer",
  "aws_dx_gateway",
  "aws_dx_gateway_association_proposal",
  "aws_dx_hosted_private_virtual_interface",
  "aws_dx_hosted_private_virtual_interface_accepter",
  "aws_dx_hosted_public_virtual_interface",
  "aws_dx_hosted_public_virtual_interface_accepter",
  "aws_dx_hosted_transit_virtual_interface",
  "aws_dx_hosted_transit_virtual_interface_accepter",
  "aws_dx_lag",
  "aws_dx_private_virtual_interface",
  "aws_dx_public_virtual_interface",
  "aws_dx_transit_virtual_interface",
  "aws_dynamodb_table_item",
  "aws_ebs_default_kms_key",
  "aws_ebs_encryption_by_default",
  "aws_ec2_client_vpn_authorization_rule",
  "aws_ec2_client_vpn_route",
  "aws_ec2_tag",
  "aws_ec2_traffic_mirror_filter",
  "aws_ec2_traffic_mirror_filter_rule",
  "aws_ec2_traffic_mirror_target",
  "aws_ec2_transit_gateway_peering_attachment_accepter",
  "aws_ec2_transit_gateway_route",
  "aws_ec2_transit_gateway_route_table",
  "aws_ec2_transit_gateway_route_table_association",
  "aws_ec2_transit_gateway_route_table_propagation",
  "aws_ec2_transit_gateway_vpc_attachment_accepter",
  "aws_ecr_lifecycle_policy",
  "aws_ecr_repository_policy",
  "aws_ecs_account_setting_default",
  "aws_efs_access_point",
  "aws_efs_file_system_policy",
  "aws_efs_mount_target",
  "aws_eip_association",
  "aws_eks_addon",
  "aws_eks_identity_provider_config",
  "aws_elastic_beanstalk_application",
  "aws_elasticache_parameter_group",
  "aws_elasticache_security_group",
  "aws_elasticache_user",
  "aws_elasticache_user_group",
  "aws_elasticache_user_group_association",
  "aws_elasticsearch_domain_policy",
  "aws_elb_attachment",
  "aws_glue_catalog_table",
  "aws_glue_classifier",
  "aws_glue_connection",
  "aws_glue_data_catalog_encryption_settings",
  "aws_glue_partition",
  "aws_glue_partition_index",
  "aws_glue_registry",
  "aws_glue_resource_policy",
  "aws_glue_schema",
  "aws_glue_security_configuration",
  "aws_glue_trigger",
  "aws_glue_user_defined_function",
  "aws_glue_workflow",
  "aws_iam_access_key",
  "aws_iam_account_alias",
  "aws_iam_account_password_policy",
  "aws_iam_group",
  "aws_iam_group_membership",
  "aws_iam_group_policy",
  "aws_iam_group_policy_attachment",
  "aws_iam_policy_attachment",
  "aws_iam_saml_provider",
  "aws_iam_server_certificate",
  "aws_iam_service_linked_role",
  "aws_iam_user",
  "aws_iam_user_group_membership",
  "aws_iam_user_login_profile",
  "aws_iam_user_policy",
  "aws_iam_user_policy_attachment",
  "aws_iam_user_ssh_key",
  "aws_iot_policy",
  "aws_key_pair",
  "aws_kms_ciphertext",
  "aws_kms_grant",
  "aws_lambda_alias",
  "aws_lambda_code_signing_config",
  "aws_lambda_function_event_invoke_config",
  "aws_lambda_layer_version",
  "aws_lambda_layer_version_permission",
  "aws_launch_configuration",
  "aws_lb_cookie_stickiness_policy",
  "aws_lb_listener_certificate",
  "aws_lb_ssl_negotiation_policy",
  "aws_lightsail_domain",
  "aws_lightsail_key_pair",
  "aws_lightsail_static_ip",
  "aws_lightsail_static_ip_attachment",
  "aws_load_balancer_backend_server_policy",
  "aws_load_balancer_listener_policy",
  "aws_load_balancer_policy",
  "aws_mq_configuration",
  "aws_msk_configuration",
  "aws_neptune_cluster_parameter_group",
  "aws_neptune_event_subscription",
  "aws_neptune_parameter_group",
  "aws_neptune_subnet_group",
  "aws_network_interface",
  "aws_network_interface_attachment",
  "aws_network_interface_sg_attachment",
  "aws_networkfirewall_firewall_policy",
  "aws_networkfirewall_logging_configuration",
  "aws_networkfirewall_rule_group",
  "aws_placement_group",
  "aws_ram_principal_association",
  "aws_ram_resource_association",
  "aws_ram_resource_share",
  "aws_ram_resource_share_accepter",
  "aws_rds_cluster_endpoint",
  "aws_resourcegroups_group",
  "aws_route53_resolver_dnssec_config",
  "aws_route53_resolver_query_log_config",
  "aws_route53_resolver_query_log_config_association",
  "aws_route53_resolver_rule",
  "aws_route53_resolver_rule_association",
  "aws_route53_zone_association",
  "aws_s3_access_point",
  "aws_s3_account_public_access_block",
  "aws_s3_bucket_acl",
  "aws_s3_bucket_cors_configuration",
  "aws_s3_bucket_intelligent_tiering_configuration",
  "aws_s3_bucket_logging",
  "aws_s3_bucket_metric",
  "aws_s3_bucket_notification",
  "aws_s3_bucket_object",
  "aws_s3_bucket_object_lock_configuration",
  "aws_s3_bucket_ownership_controls",
  "aws_s3_bucket_replication_configuration",
  "aws_s3_bucket_website_configuration",
  "aws_secretsmanager_secret_policy",
  "aws_secretsmanager_secret_rotation",
  "aws_service_discovery_service",
  "aws_ses_domain_dkim",
  "aws_ses_domain_identity",
  "aws_sns_platform_application",
  "aws_sns_sms_preferences",
  "aws_sns_topic_policy",
  "aws_sqs_queue_policy",
  "aws_ssm_association",
  "aws_ssm_maintenance_window",
  "aws_ssm_maintenance_window_target",
  "aws_ssm_maintenance_window_task",
  "aws_ssm_patch_baseline",
  "aws_ssm_patch_group",
  "aws_ssm_resource_data_sync",
  "aws_transfer_access",
  "aws_transfer_ssh_key",
  "aws_transfer_user",
  "aws_volume_attachment",
  "aws_vpc_dhcp_options",
  "aws_vpc_dhcp_options_association",
  "aws_vpc_endpoint_connection_notification",
  "aws_vpc_endpoint_route_table_association",
  "aws_vpc_endpoint_service_allowed_principal",
  "aws_vpc_endpoint_subnet_association",
  "aws_vpc_ipv4_cidr_block_association",
  "aws_vpc_peering_connection",
  "aws_vpc_peering_connection_accepter",
  "aws_vpc_peering_connection_options",
  "aws_vpn_connection_route",
  "aws_vpn_gateway_attachment",
  "aws_vpn_gateway_route_propagation",
  "aws_waf_byte_match_set",
  "aws_waf_geo_match_set",
  "aws_waf_ipset",
  "aws_waf_rate_based_rule",
  "aws_waf_regex_match_set",
  "aws_waf_regex_pattern_set",
  "aws_waf_rule",
  "aws_waf_rule_group",
  "aws_waf_size_constraint_set",
  "aws_waf_sql_injection_match_set",
  "aws_waf_xss_match_set",
  "aws_wafv2_ip_set",
  "aws_wafv2_regex_pattern_set",
  "aws_wafv2_rule_group",
]);

const FREE_ENTRY: CostDriverEntry = { costClass: "free" };

/** `null` means "not in the table", which is reported rather than assumed free. */
export function resolveCostDriver(
  resourceType: string,
): CostDriverEntry | null {
  const curated = COST_DRIVER_MAP[resourceType];
  if (curated) return curated;
  return FREE_RESOURCE_TYPES.has(resourceType) ? FREE_ENTRY : null;
}

export const COST_CLASS_LABELS: Record<CostClass, string> = {
  recurring: "Charged while it exists",
  usage: "Charged by usage",
  free: "No charge",
};

export const COST_CLASS_HINTS: Record<CostClass, string> = {
  recurring:
    "These set the floor of the bill. They accrue from the moment they are created, even if nothing uses them.",
  usage:
    "These stay near zero until there is traffic, and are the hardest to predict from source alone.",
  free: "These carry no charge of their own, though some of them govern resources that do.",
};
