# @terrablox/aws

Talks to a customer's AWS account with a session it is handed. Stores nothing.

Terrablox never holds AWS keys. A customer either creates a role in their own account that
trusts this app's principal, or signs in through IAM Identity Center; either way what comes
out is a set of credentials that lives for minutes. This package is everything done with
those credentials — assuming the role, running the bootstrap CloudFormation stacks, reading
the Terraform state out of S3 — and none of the deciding who may have them.

## Why the split is where it is

The hard part of extracting this was not the SDK. It was that `bootstrap.ts` and
`state-backend.ts` imported `credentials.ts`, and `credentials.ts` reads the database. So
every module that merely *used* a session depended on how one is stored.

They needed two things from it: the `ProjectAwsSession` type and `toClientCredentials`, a
three-line mapper. Both are pure. Moving them into `./session` cut the dependency
outright, and the rest followed.

What stayed in the app is the half that answers *whose hands*:

| Module | Why it stayed |
| --- | --- |
| `lib/aws/credentials.ts` | Decrypts a stored connection and picks the one that matches a project |
| `lib/aws/connection-service.ts` | The connections a user has, in the database |
| `lib/aws/project-connection.ts` | Which connection a project is pinned to |
| `lib/aws/sso-service.ts` | The device-flow login, and the tokens it persists |

Those keep their `server-only` marker. This package does not have one — see below.

## Layout

| Entry point | Holds |
| --- | --- |
| `./session` | `ProjectAwsSession`, `AwsSessionCredentials`, `toClientCredentials` |
| `./connection` | Assuming a customer's role, and the trust template they create it from |
| `./sso` | The IAM Identity Center device flow |
| `./bootstrap` | The two CloudFormation stacks, and the OIDC provider check |
| `./state-backend` | Reading Terraform state and its lock out of S3 |
| `./regions` | The region list, and what is a valid region |
| `./github-oidc` | `token.actions.githubusercontent.com`, and its ARN in an account |

`./github-oidc` looks too small to be its own entry point, and it is not. The CloudFormation
templates name that provider in a role's trust policy, and they are rendered by code the
deployment wizard imports — a client component. The IAM lookup that asks whether the
account already has the provider is in `./bootstrap`, which pulls the SDK. Putting the
constant beside the IAM code would ship the AWS SDK to the browser; leaving it in the app
would make this package import from it. A module with no imports at all is the way out.

## No `server-only`

Deliberately, although every current caller runs on a server. A session is a parameter, so
nothing here holds a secret, and the marker would make the package unusable from a CLI or
a GitHub Action.

There is one honest caveat. `resolveTerrabloxPrincipal` and `describeAppIdentity` in
`./connection` read *this deployment's own* AWS identity through the SDK's default
credential chain — environment, profile or instance metadata. Outside a server that chain
finds nothing and the call fails; it cannot leak anything, but it cannot work either.

## A note on the SDK

After this move the dashboard has no `@aws-sdk/*` dependency of its own. That is worth
keeping true: it is the cheapest possible check that the boundary is real, and the moment a
route reaches for a client directly it will need a dependency that says so.
