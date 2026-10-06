# @terrablox/terraform

Reads, evaluates and edits Terraform configurations.

This is the part of Terrablox that understands HCL. It takes the analysed contents of a
Terraform module — resources, variables, outputs, references — and answers the questions
the product is built on: what does this module actually deploy, what would break if a
block were removed, what will this cost, and where does an edit have to go.

## Why it is a package

Every module here is a pure function of its arguments. There is no database client, no
framework, no filesystem and no network — which is what makes it the one part of the
codebase that can be tested exhaustively, and the one part that is useful outside the
dashboard. A CLI, a GitHub Action or an editor extension can depend on this without
pulling in Next.js or Prisma.

The boundary is not a convention here, it is checkable: `packages/*` has no path alias to
the app, in `tsconfig` or in the test runner, so an import that reached back into the
dashboard would fail rather than quietly work.

## What is *not* here

Three modules stayed in the app on purpose, because they are adapters rather than logic:

| Module | Why it stayed |
| --- | --- |
| `analyze.ts` | Runs the HCL parser, which is server-only |
| `persist.ts` | Writes analysis results through Prisma |
| `module-architecture-service.ts` | Loads a module out of the database |

Each of them calls into this package. The direction is one-way: nothing here knows they
exist.

## Layout

| Entry point | Answers |
| --- | --- |
| `./types` | The shapes everything else here speaks in |
| `./evaluate` | What an expression resolves to, given a set of inputs |
| `./type-check` | Whether a value fits the type a variable declares |
| `./hcl-edit` | Where an edit goes in a file, and what it looks like afterwards |
| `./references` | Which block refers to which, and through which local |
| `./architecture-graph` | The nested diagram a configuration describes |
| `./architecture-layout` | Where the boxes of that diagram sit |
| `./aws-architecture` | Which AWS service a resource type belongs to |
| `./aws-services`, `./aws-icon-manifest` | Naming and iconography for those services |
| `./aws-cost-drivers` | Which resources bill for merely existing |
| `./delete-scope` | Everything that would have to go with a block |
| `./module-link`, `./resource-label` | Names and links a reader recognises |
| `./output-type` | The type an output has, inferred from its expression |
| `./versions` | Ordering and comparison of module versions |

| `./registry` | Terraform Registry addresses, parsed and rendered |

Every module has an entry point, and none is internal-only. Two of them nearly were:
`references` and `registry` are used by the modules above far more than from outside, and
the first cut of this package left them unexported — until `analyze.ts` and `persist.ts`,
the adapters that stayed in the app, failed to compile. Worth recording, because "only
used internally" is a claim that is easy to make and cheap to check.
