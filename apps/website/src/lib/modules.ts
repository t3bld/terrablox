/**
 * The built-in module catalogue, as a snapshot.
 *
 * A snapshot rather than a live read, because there is nothing live to read from
 * here: the catalogue is discovered at seed time from every `terrablox-aws-*`
 * repository in the org, and it lands in the dashboard's database — which a static
 * site has no connection to, by design. So the choice is between a number nobody
 * maintains and real names that go slightly stale, and real names win: a visitor
 * scanning for `rds-aurora` or `eks` learns something a count cannot tell them.
 *
 * Regenerate against a seeded instance with:
 *
 *   docker exec terrablox-postgres psql -U terrablox -d terrablox -qtAF'|' -c "
 *     SELECT DISTINCT ON (slug) slug, version FROM (
 *       SELECT regexp_replace(split_part(regexp_replace(url,'^https://github.com/[^/]+/',''), '.git', 1), '^terrablox-aws-', '') AS slug,
 *              split_part(url, '?ref=', 2) AS version
 *       FROM terraform_modules
 *       WHERE user_id IS NULL AND url IS NOT NULL AND is_submodule = false
 *     ) t WHERE version <> 'master' AND slug <> '' ORDER BY slug, version DESC;"
 *
 * Versions are the pinned tags the library actually resolves, which is the part
 * worth showing: a catalogue without versions is a list of names, and the pin is
 * what makes it reproducible.
 */
export interface CatalogueModule {
  name: string;
  version: string;
}

/**
 * `as const` so the names become literal types.
 *
 * That is what makes {@link ModuleName} worth having: the demo scenarios name
 * modules, and a typo in one of them should be a build error rather than a chip on
 * the landing page advertising a module the library does not contain.
 */
export const CATALOGUE = [
  { name: "acm", version: "v6.3.0" },
  { name: "alb", version: "v10.5.0" },
  { name: "apigateway", version: "v6.1.0" },
  { name: "app-runner", version: "v1.2.2" },
  { name: "appconfig", version: "v2.0.2" },
  { name: "appsync", version: "v4.1.0" },
  { name: "autoscaling", version: "v9.3.0" },
  { name: "batch", version: "v3.1.0" },
  { name: "cloudfront", version: "v6.7.0" },
  { name: "cloudwatch", version: "v5.7.2" },
  { name: "datadog-forwarders", version: "v7.2.0" },
  { name: "dms", version: "v2.6.1" },
  { name: "dynamodb-table", version: "v5.5.1" },
  { name: "ec2-instance", version: "v6.4.0" },
  { name: "ecr", version: "v3.2.0" },
  { name: "ecs", version: "v7.6.0" },
  { name: "efs", version: "v2.2.0" },
  { name: "eks", version: "v21.25.0" },
  { name: "eks-pod-identity", version: "v2.8.2" },
  { name: "elasticache", version: "v1.11.1" },
  { name: "elb", version: "v4.0.2" },
  { name: "emr", version: "v3.3.0" },
  { name: "eventbridge", version: "v4.3.2" },
  { name: "fsx", version: "v1.3.2" },
  { name: "global-accelerator", version: "v3.0.1" },
  { name: "grafana", version: "v2.3.2" },
  { name: "iam", version: "v6.8.0" },
  { name: "kms", version: "v4.2.1" },
  { name: "lambda", version: "v8.8.1" },
  { name: "memory-db", version: "v3.2.0" },
  { name: "msk-kafka-cluster", version: "v3.3.1" },
  { name: "network-firewall", version: "v2.3.0" },
  { name: "opensearch", version: "v2.11.0" },
  { name: "prometheus", version: "v4.3.1" },
  { name: "rds", version: "v7.2.1" },
  { name: "rds-aurora", version: "v10.3.1" },
  { name: "rds-proxy", version: "v4.4.1" },
  { name: "redshift", version: "v7.1.1" },
  { name: "route53", version: "v6.5.1" },
  { name: "s3-bucket", version: "v5.15.4" },
  { name: "secrets-manager", version: "v2.1.0" },
  { name: "security-group", version: "v6.0.0" },
  { name: "sns", version: "v7.1.1" },
  { name: "sqs", version: "v5.2.2" },
  { name: "ssm-parameter", version: "v2.1.2" },
  { name: "step-functions", version: "v5.1.1" },
  { name: "transit-gateway", version: "v3.3.1" },
  { name: "vpc", version: "v6.6.1" },
  { name: "vpn-gateway", version: "v4.0.0" },
  { name: "waf", version: "v2.1.0" },
] as const satisfies readonly CatalogueModule[];

/** Every name in the catalogue, as a union. */
export type ModuleName = (typeof CATALOGUE)[number]["name"];

/**
 * The pinned version a name resolves to.
 *
 * Total by construction: the argument type only admits names that are in the
 * array, so there is no missing case to handle.
 */
export function versionOf(name: ModuleName): string {
  return CATALOGUE.find((entry) => entry.name === name)?.version ?? "";
}
