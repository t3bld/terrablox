# AWS architecture icons

809 SVGs used by the Architecture tab. Vendored rather than installed as a
dependency so the diagram keeps working offline and the exact asset set is
reviewable in the repository.

## Where they come from

`aws-icons@3.3.0` — https://github.com/MKAbuMattar/aws-icons (MIT, Mohammad Abu
Mattar). That package repackages the official *AWS Architecture Icons* asset
set published by Amazon Web Services.

## Licensing — unresolved, read before shipping

The npm package carries the MIT licence, but the underlying artwork is AWS's.
The repackager can license his own work; he cannot grant rights to Amazon's
trademarks. Use of the official icons is governed by the AWS Architecture Icons
terms and the AWS Trademark Guidelines, not by the MIT text above.

This matters for distribution to third parties. It has been raised with the
project owner and is **not settled**. Do not treat the MIT line as clearance.

- AWS Architecture Icons: https://aws.amazon.com/architecture/icons/
- AWS Trademark Guidelines: https://aws.amazon.com/trademark-guidelines/

## Naming

Two conventions live side by side, deliberately:

- **26 curated names** (`vpc.svg`, `cloudfront.svg`, `subnet-private.svg`) are
  short and hand-picked. `aws-architecture.ts` references these by name.
- **783 catalogue names** are derived mechanically from the AWS asset name
  (`AmazonKinesisDataStreams` -> `kinesis-data-streams`), so a new service can
  be wired up by adding a single table entry without hunting for a file.

Three names collided across source categories and carry a `-resource` suffix:
`management-console-resource`, `ec2-auto-scaling-resource`, `shield-resource`.

## Adding a service

Add a line to `ARCHITECTURE_MAP` in
`apps/dashboard/src/lib/terraform/aws-architecture.ts`. The icon is resolved
from the resource type's service prefix, so `icon` only needs to be set when
the automatic match is wrong or missing.
