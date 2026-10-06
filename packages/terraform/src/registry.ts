import type { TerraformProvider, TerraformResourceKind } from "./types";

/**
 * Builds Terraform Registry documentation links for providers and resources.
 *
 * Note: the registry is a single-page app and answers 200 for unknown paths,
 * so a generated link cannot be validated by fetching it. Links are therefore
 * best-effort -- correct for every provider that follows the standard layout,
 * which covers the official ones.
 */

const DEFAULT_REGISTRY_HOST = "registry.terraform.io";

/** Terraform's implicit namespace when `source` is omitted. */
const DEFAULT_NAMESPACE = "hashicorp";

interface ProviderAddress {
  host: string;
  namespace: string;
  type: string;
}

/**
 * Resolves the registry address of a provider.
 *
 * `source` may be `aws`, `hashicorp/aws` or `example.com/team/aws`; when it is
 * missing entirely Terraform assumes the provider is a HashiCorp one.
 */
function parseProviderAddress(
  localName: string,
  source: string | null,
): ProviderAddress {
  const raw = source?.trim();

  if (!raw) {
    return {
      host: DEFAULT_REGISTRY_HOST,
      namespace: DEFAULT_NAMESPACE,
      type: localName,
    };
  }

  const parts = raw.split("/").filter(Boolean);

  if (parts.length >= 3) {
    const [host, namespace, type] = parts;
    if (host && namespace && type) return { host, namespace, type };
  }

  if (parts.length === 2) {
    const [namespace, type] = parts;
    if (namespace && type) {
      return { host: DEFAULT_REGISTRY_HOST, namespace, type };
    }
  }

  return {
    host: DEFAULT_REGISTRY_HOST,
    namespace: DEFAULT_NAMESPACE,
    type: parts[0] ?? localName,
  };
}

/**
 * Only the public registry serves documentation at a predictable path. For a
 * private registry we would be inventing URLs, so we return nothing instead.
 */
function isDocumentedHost(host: string): boolean {
  return host === DEFAULT_REGISTRY_HOST;
}

/**
 * Declared versions are constraints (`~> 5.0`), not concrete versions, and a
 * constraint is not a valid path segment. `latest` is the honest choice.
 */
function versionSegment(): string {
  return "latest";
}

export function providerDocsUrl(provider: TerraformProvider): string | null {
  const address = parseProviderAddress(provider.name, provider.source);
  if (!isDocumentedHost(address.host)) return null;

  return `https://${address.host}/providers/${address.namespace}/${address.type}/${versionSegment()}/docs`;
}

/**
 * Strips the provider prefix from a resource type: within the provider's own
 * documentation `aws_s3_bucket` is published as `s3_bucket`.
 */
function resourceSlug(resourceType: string, providerType: string): string {
  const prefix = `${providerType}_`;
  return resourceType.startsWith(prefix)
    ? resourceType.slice(prefix.length)
    : resourceType;
}

export function resourceDocsUrl(params: {
  resourceType: string;
  kind: TerraformResourceKind;
  provider: TerraformProvider | undefined;
  /** Local provider name derived from the resource type prefix. */
  providerLocalName: string;
}): string | null {
  const address = parseProviderAddress(
    params.providerLocalName,
    params.provider?.source ?? null,
  );
  if (!isDocumentedHost(address.host)) return null;

  const slug = resourceSlug(params.resourceType, params.providerLocalName);
  if (!slug) return null;

  const section = params.kind === "data" ? "data-sources" : "resources";

  return `https://${address.host}/providers/${address.namespace}/${address.type}/${versionSegment()}/docs/${section}/${slug}`;
}

/**
 * Registry page for a module call that resolves to the public registry.
 * Local and Git sources have no registry page.
 */
export function moduleRegistryUrl(source: string | null): string | null {
  if (!source) return null;

  const parts = source.trim().split("/").filter(Boolean);

  // `<namespace>/<name>/<provider>`
  if (parts.length === 3) {
    const [namespace, name, provider] = parts;
    if (namespace && name && provider) {
      return `https://${DEFAULT_REGISTRY_HOST}/modules/${namespace}/${name}/${provider}/latest`;
    }
  }

  // `<host>/<namespace>/<name>/<provider>`
  if (parts.length === 4) {
    const [host, namespace, name, provider] = parts;
    if (host && namespace && name && provider && isDocumentedHost(host)) {
      return `https://${host}/modules/${namespace}/${name}/${provider}/latest`;
    }
  }

  return null;
}
