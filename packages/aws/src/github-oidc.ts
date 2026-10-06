/**
 * How AWS knows GitHub Actions.
 *
 * Two consumers that must not meet. The CloudFormation templates name this provider in
 * the role's trust policy, and they are rendered by code the deployment wizard imports —
 * a client component. The IAM check that asks whether the account already has the
 * provider is in `./bootstrap`, which pulls the AWS SDK.
 *
 * So the constant lives in a module of its own with no imports at all. Put it beside the
 * IAM code and the wizard ships the SDK to the browser; leave it in the app and the
 * package has to reach back into it.
 */

/** The issuer AWS federates to. Also the provider's name in an IAM ARN. */
export const GITHUB_OIDC_PROVIDER = "token.actions.githubusercontent.com";

/**
 * The provider's ARN in one account.
 *
 * IAM allows exactly one per URL per account, which is why this needs no discriminator
 * beyond the account id — and why deleting the stack that created it breaks every other
 * project in the same account. The templates set `DeletionPolicy: Retain` for that
 * reason.
 */
export function githubOidcProviderArn(
  accountId: string,
  partition = "aws",
): string {
  return `arn:${partition}:iam::${accountId}:oidc-provider/${GITHUB_OIDC_PROVIDER}`;
}
