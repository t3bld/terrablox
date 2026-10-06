import type { ArchitectureDiagramNode } from "@terrablox/graph";
import type {
  ArchitectureEdge,
  ArchitectureNode,
} from "@terrablox/terraform/architecture-graph";
import { layoutArchitecture } from "@terrablox/terraform/architecture-layout";

/**
 * The demo's architecture graphs, in the model the product's own diagram consumes.
 *
 * What is real here is everything after this file: {@link layoutArchitecture} is the
 * function the project page calls, and `ArchitectureDiagram` is the component it
 * renders — same boxes, same frames, same nesting rules, same icons. What is
 * authored is the model itself, because the real one is produced by parsing HCL and
 * resolving it against a module library, and a static site has neither.
 *
 * So the honest description is: a real renderer over a hand-written model. The page
 * says as much above the demo, and the shapes are copied from stacks the product
 * actually draws — a NAT gateway pinned to one zone, a database in a subnet with no
 * route out, a certificate with no subnet at all.
 *
 * `addresses` carries the Terraform addresses a box folds together, and the diagram
 * shows its length as a count. One entry means one resource, which is why the
 * arrays here are mostly single-element rather than empty: an empty one would render
 * a box claiming to represent nothing.
 *
 * In attachments the entries are placeholders — `iam-role-1`, `iam-role-2` — because
 * only their number reaches the screen, as "IAM role x3" on a badge. They are not
 * addresses anyone can look up, and nothing here pretends otherwise.
 */

/** Shorthand for a service tile. */
function service(
  id: string,
  label: string,
  icon: string,
  parentId?: string,
  extra: Partial<ArchitectureNode> = {},
): ArchitectureNode {
  return {
    id,
    type: "service",
    label,
    icon,
    addresses: [id],
    ...(parentId ? { parentId } : {}),
    ...extra,
  };
}

/** A VPC or subnet frame. Subnets take their public/private look from the icon. */
function frame(
  id: string,
  type: "vpc" | "subnet",
  label: string,
  options: {
    sublabel?: string;
    parentId?: string;
    public?: boolean;
  } = {},
): ArchitectureNode {
  return {
    id,
    type,
    label,
    addresses: [id],
    ...(options.sublabel ? { sublabel: options.sublabel } : {}),
    ...(options.parentId ? { parentId: options.parentId } : {}),
    ...(type === "subnet"
      ? { icon: options.public ? "subnet-public" : "subnet-private" }
      : {}),
  };
}

const edge = (source: string, target: string): ArchitectureEdge => ({
  id: `${source}->${target}`,
  source,
  target,
});

interface DemoGraph {
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
}

/**
 * Parents before children, which the diagram requires: React Flow paints in array
 * order, so a frame listed after its contents would cover them.
 */
const GRAPHS: Record<string, DemoGraph> = {
  "container-app": {
    nodes: [
      frame("vpc", "vpc", "VPC", { sublabel: "10.0.0.0/16" }),
      frame("public", "subnet", "Public subnets", {
        sublabel: "3 zones",
        parentId: "vpc",
        public: true,
      }),
      service(
        "alb",
        "Application Load Balancer",
        "elastic-load-balancing",
        "public",
      ),
      service("nat", "NAT Gateway", "nat-gateway", "public", {
        zone: "eu-central-1a",
      }),
      frame("private", "subnet", "Private subnets", {
        sublabel: "3 zones",
        parentId: "vpc",
      }),
      service("ecs", "ECS Fargate service", "ecs", "private", {
        attachments: [
          {
            service: "IAM role",
            icon: "identityand-access-management",
            addresses: ["iam-role-1", "iam-role-2", "iam-role-3"],
          },
        ],
      }),
      frame("data", "subnet", "Isolated subnets", {
        sublabel: "3 zones",
        parentId: "vpc",
      }),
      service("rds", "RDS PostgreSQL", "rds", "data", {
        attachments: [
          {
            service: "Secret",
            icon: "secrets-manager",
            addresses: ["secret-1"],
          },
        ],
      }),
      service("redis", "ElastiCache", "elasticache", "data"),
      service("acm", "ACM certificate", "certificate-manager"),
      service("ecr", "ECR repository", "elastic-container-registry"),
    ],
    edges: [
      edge("acm", "alb"),
      edge("alb", "ecs"),
      edge("ecs", "rds"),
      edge("ecs", "redis"),
      edge("ecs", "nat"),
      edge("ecr", "ecs"),
    ],
  },

  "static-site": {
    // No VPC at all, and that is the point of including it: a static site has no
    // network of its own, and the diagram should not invent one to fill the frame.
    nodes: [
      service("cloudfront", "CloudFront distribution", "cloudfront"),
      service("bucket", "S3 bucket", "s3", undefined, {
        attachments: [
          { service: "Bucket policy", addresses: ["bucket-policy-1"] },
        ],
      }),
      service("acm", "ACM certificate", "certificate-manager"),
      service("route53", "Route 53 records", "route53"),
    ],
    edges: [
      edge("route53", "cloudfront"),
      edge("acm", "cloudfront"),
      edge("cloudfront", "bucket"),
    ],
  },

  "event-pipeline": {
    nodes: [
      service("event-bridge", "EventBridge bus", "event-bridge"),
      service("queue", "SQS queue", "sqs"),
      service("dlq", "Dead-letter queue", "sqs"),
      service("worker", "Lambda workers", "lambda", undefined, {
        attachments: [
          {
            service: "IAM role",
            icon: "identityand-access-management",
            addresses: ["iam-role-1", "iam-role-2"],
          },
        ],
      }),
      service("table", "DynamoDB table", "dynamodb"),
      service("key", "KMS key", "key-management-service"),
    ],
    edges: [
      edge("event-bridge", "queue"),
      edge("queue", "worker"),
      edge("queue", "dlq"),
      edge("worker", "table"),
      edge("key", "table"),
    ],
  },

  kubernetes: {
    nodes: [
      frame("vpc", "vpc", "VPC", { sublabel: "10.10.0.0/16" }),
      frame("public", "subnet", "Public subnets", {
        sublabel: "3 zones",
        parentId: "vpc",
        public: true,
      }),
      service("nat", "NAT Gateway", "nat-gateway", "public", {
        zone: "eu-central-1a",
      }),
      frame("private", "subnet", "Private subnets", {
        sublabel: "3 zones",
        parentId: "vpc",
      }),
      service("eks", "EKS cluster", "eks", "private", {
        sublabel: "private endpoint",
        attachments: [
          {
            service: "IAM role",
            icon: "identityand-access-management",
            addresses: ["iam-role-1", "iam-role-2", "iam-role-3", "iam-role-4"],
          },
        ],
      }),
      service("nodes", "Managed node group", "ec2", "private", {
        addresses: ["nodes", "nodes-launch-template"],
      }),
      service("ecr", "ECR repository", "elastic-container-registry"),
      service(
        "podIdentity",
        "Pod identity associations",
        "identityand-access-management",
      ),
    ],
    edges: [
      edge("eks", "nodes"),
      edge("nodes", "nat"),
      edge("ecr", "nodes"),
      edge("podIdentity", "eks"),
    ],
  },
};

/**
 * Lays a scenario's graph out and maps it to the diagram's own node type.
 *
 * The mapping is the project page's, kept deliberately identical — including the
 * detail that a subnet's public or private look is read off its icon rather than
 * from a separate field, which is the sort of thing that silently diverges the
 * moment two call sites decide it for themselves.
 */
export function diagramFor(scenarioId: string): {
  nodes: ArchitectureDiagramNode[];
  edges: { id: string; source: string; target: string }[];
} {
  const graph = GRAPHS[scenarioId] ?? GRAPHS["container-app"];
  if (!graph) return { nodes: [], edges: [] };

  const nodes = layoutArchitecture(graph.nodes, graph.edges).map((node) => ({
    id: node.id,
    frame:
      node.type === "vpc"
        ? ("vpc" as const)
        : node.type === "module"
          ? ("module" as const)
          : node.type === "subnet"
            ? node.icon === "subnet-public"
              ? ("subnet-public" as const)
              : ("subnet-private" as const)
            : null,
    label: node.label,
    sublabel: node.sublabel,
    icon: node.icon,
    count: node.addresses.length,
    zone: node.zone,
    attachments: node.attachments?.map((attachment) => ({
      service: attachment.service,
      icon: attachment.icon,
      count: attachment.addresses.length,
    })),
    parentId: node.parentId,
    position: node.position,
    width: node.width,
    height: node.height,
  }));

  return { nodes, edges: graph.edges };
}
