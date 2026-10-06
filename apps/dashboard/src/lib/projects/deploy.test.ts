import { describe, expect, it } from "vitest";
import { parse, type Scalar } from "yaml";

import {
  DEPLOY_PERMISSIONS_POLICY_ARN,
  GITHUB_OIDC_PROVIDER,
  KMS_KEY_OUTPUT_KEY,
  type PipelineContext,
  renderBackendFile,
  renderBootstrapTemplate,
  renderStateTemplate,
  STATE_BUCKET_OUTPUT_KEY,
} from "./deploy";

/**
 * The two CloudFormation templates, read as structure rather than as text.
 *
 * Parsed on purpose. Every assertion here could be a regex over the rendered string,
 * and every one of them would then pass on a template that YAML rejects — indentation
 * is load-bearing in these files and a broken one fails in somebody's AWS account, not
 * here. Parsing also means the tests describe the resources rather than the source.
 *
 * What they guard is the part with no local feedback loop at all: a wrong trust policy
 * or a missing retention rule cannot be noticed until a workflow fails minutes later,
 * or until something irreplaceable has already been deleted.
 */

/**
 * A value read out of a parsed template.
 *
 * Deliberately loose, and only here. A CloudFormation template is arbitrary JSON whose
 * shape differs per resource type, so typing it properly would mean keeping a second
 * copy of CloudFormation's schema in this repo — and the assertions below are about
 * three or four specific paths, not about the shape of the whole document.
 */
// biome-ignore lint/suspicious/noExplicitAny: see above; a parsed template is arbitrary JSON.
type CfnValue = any;

/**
 * CloudFormation's short-form intrinsics are valid CFN YAML and not valid YAML.
 *
 * Kept as `{ "Fn::Sub": … }`, which is the long form of the same thing, so a test can
 * assert on them where the value matters and ignore them where it does not.
 */
function parseTemplate(yaml: string): Record<string, CfnValue> {
  return parse(yaml, {
    customTags: [
      {
        tag: "!",
        collection: "map",
        default: false,
        resolve: (value: unknown) => value,
      },
      ...["Ref", "Sub", "GetAtt", "If", "Equals", "Join", "Select"].map(
        (fn) => ({
          tag: `!${fn}`,
          resolve: (value: unknown) => ({ [`Fn::${fn}`]: value }),
          identify: () => false,
        }),
      ),
    ],
    schema: "core",
    // The intrinsics arrive as scalars or sequences depending on the function.
    customTagsFallback: (tag: string) => ({ tag, resolve: (v: Scalar) => v }),
  } as never);
}

const CONTEXT: PipelineContext = {
  repoFullName: "t3bld/terrablox-mhp-infrastructure",
  branch: "main",
  rootFolder: ".",
  projectName: "terrablox-infrastructure",
  awsAccountId: "545283928770",
  awsRegion: "eu-central-1",
  awsRoleArn: "arn:aws:iam::545283928770:role/terrablox-infrastructure-deploy",
  stateBucket: "terrablox-tfstate-545283928770-terrablox-infrastructure",
  stateKmsKeyArn: null,
  stateKmsAlias: "alias/terrablox-infrastructure-tfstate",
};

describe("renderBootstrapTemplate", () => {
  const template = parseTemplate(renderBootstrapTemplate(CONTEXT));
  const resources = template.Resources;
  const trust =
    resources.DeployRole.Properties.AssumeRolePolicyDocument.Statement[0];
  const conditions = trust.Condition;

  it("parses as YAML at all", () => {
    expect(template.AWSTemplateFormatVersion).toBe("2010-09-09");
    expect(Object.keys(resources)).toEqual([
      "GithubOidcProvider",
      "DeployRole",
    ]);
  });

  describe("the identity provider, which the whole account shares", () => {
    it("is retained, so deleting this project cannot break the others", () => {
      // IAM allows one provider per URL per account, and it belongs to whichever
      // project's stack created it first. Without this, deleting that stack removed
      // the provider and every other role in the account stopped being assumable —
      // with nothing about those roles having changed.
      expect(resources.GithubOidcProvider.DeletionPolicy).toBe("Retain");
      expect(resources.GithubOidcProvider.UpdateReplacePolicy).toBe("Retain");
    });

    it("is created only when the account has none", () => {
      expect(resources.GithubOidcProvider.Condition).toBe("WithOidcProvider");
      expect(template.Conditions.WithOidcProvider).toBeDefined();
    });

    it("accepts the audience the trust policy then demands", () => {
      // The two halves have to agree. A provider registered for another audience
      // reports itself as present, so nothing recreates it, and no deploy can assume
      // the role.
      expect(resources.GithubOidcProvider.Properties.ClientIdList).toEqual([
        "sts.amazonaws.com",
      ]);
      expect(conditions.StringEquals[`${GITHUB_OIDC_PROVIDER}:aud`]).toBe(
        "sts.amazonaws.com",
      );
    });
  });

  describe("the trust policy", () => {
    it("admits the ref a manually started run presents", () => {
      // `workflow_dispatch` on the deployment branch yields exactly this subject.
      expect(conditions.StringLike[`${GITHUB_OIDC_PROVIDER}:sub`]).toContain(
        "repo:t3bld/terrablox-mhp-infrastructure:ref:refs/heads/main",
      );
    });

    it("admits the environment, so an approval gate keeps working", () => {
      // A job with `environment:` gets a different subject entirely; without this,
      // turning approvals on would break every apply.
      expect(conditions.StringLike[`${GITHUB_OIDC_PROVIDER}:sub`]).toContain(
        "repo:t3bld/terrablox-mhp-infrastructure:environment:production",
      );
    });

    it("admits nothing else — no wildcard over refs, no pull requests", () => {
      // A fork's pull request must never reach a role with these permissions.
      const subs: string[] =
        conditions.StringLike[`${GITHUB_OIDC_PROVIDER}:sub`];
      expect(subs).toHaveLength(2);
      for (const sub of subs) {
        expect(sub.startsWith("repo:t3bld/terrablox-mhp-infrastructure:")).toBe(
          true,
        );
        expect(sub).not.toContain("*");
        expect(sub).not.toContain("pull_request");
      }
    });

    it("names one action and one federated principal", () => {
      expect(trust.Action).toBe("sts:AssumeRoleWithWebIdentity");
      expect(trust.Effect).toBe("Allow");
      expect(trust.Principal.Federated).toBeDefined();
    });
  });

  describe("what the role may do", () => {
    it("takes its permissions from a parameter, so they can be narrowed", () => {
      expect(template.Parameters.PermissionsPolicyArn.Default).toBe(
        DEPLOY_PERMISSIONS_POLICY_ARN,
      );
    });

    it("scopes state access to this project's own key in the bucket", () => {
      const statements =
        resources.DeployRole.Properties.Policies[0].PolicyDocument.Statement;
      const objects = statements.find((s: CfnValue) =>
        String(JSON.stringify(s.Action)).includes("s3:PutObject"),
      );
      expect(JSON.stringify(objects.Resource)).toContain(CONTEXT.stateBucket);
      expect(JSON.stringify(objects.Resource)).toContain("terraform.tfstate");
    });

    it("expires a session in an hour", () => {
      expect(resources.DeployRole.Properties.MaxSessionDuration).toBe(3600);
    });
  });

  it("omits the state policy entirely when there is no bucket yet", () => {
    // A policy naming an empty ARN is invalid, and the role is still worth creating
    // first — the state stack has not necessarily run.
    const early = parseTemplate(
      renderBootstrapTemplate({ ...CONTEXT, stateBucket: null }),
    );
    expect(early.Resources.DeployRole.Properties.Policies).toBeUndefined();
  });
});

describe("renderStateTemplate", () => {
  const template = parseTemplate(renderStateTemplate(CONTEXT));
  const resources = template.Resources;

  it("retains everything that holds the record of what Terraform built", () => {
    // Deleting state does not delete the infrastructure it tracks, it only makes
    // Terraform forget about it — and a deleted key makes every stored version
    // unreadable for good.
    for (const name of ["StateKey", "StateBucket"]) {
      expect(resources[name]?.DeletionPolicy, name).toBe("Retain");
      expect(resources[name]?.UpdateReplacePolicy, name).toBe("Retain");
    }
  });

  it("creates no lock table, because the bucket does the locking now", () => {
    // Terraform 1.11 deprecated the DynamoDB table in favour of a conditional write
    // in the bucket. The `state_lock_table` column outlives it deliberately: it
    // records the table an older project already has sitting in its account.
    expect(
      Object.values(resources).some(
        (r: CfnValue) => r?.Type === "AWS::DynamoDB::Table",
      ),
    ).toBe(false);
  });

  it("reports only what the backend needs to be written", () => {
    expect(Object.keys(template.Outputs).sort()).toEqual(
      [KMS_KEY_OUTPUT_KEY, STATE_BUCKET_OUTPUT_KEY].sort(),
    );
  });

  it("keeps versions, because every apply overwrites the state", () => {
    expect(
      resources.StateBucket.Properties.VersioningConfiguration.Status,
    ).toBe("Enabled");
  });

  it("blocks public access on a bucket that holds passwords in clear text", () => {
    expect(
      resources.StateBucket.Properties.PublicAccessBlockConfiguration,
    ).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
  });

  it("refuses plaintext transport and unencrypted writes", () => {
    const sids =
      resources.StateBucketPolicy.Properties.PolicyDocument.Statement.map(
        (s: CfnValue) => s.Sid,
      );
    expect(sids).toContain("DenyInsecureTransport");
    expect(sids).toContain("DenyUnencryptedWrites");
  });

  it("keeps the account able to manage its own key", () => {
    // KMS does not fall back to IAM for the key policy, so locking out the root is
    // permanent and unrecoverable.
    const sids = resources.StateKey.Properties.KeyPolicy.Statement.map(
      (s: CfnValue) => s.Sid,
    );
    expect(sids).toContain("AllowAccountAdministration");
    expect(sids).toContain("AllowDeployRole");
  });

  it("uses the alias the project pinned, not one derived from its name", () => {
    // A derived alias moves when the project is renamed, and CloudFormation then
    // creates a second one while the first still points at the key.
    expect(resources.StateKeyAlias.Properties.AliasName).toBe(
      CONTEXT.stateKmsAlias,
    );
  });

  it("refuses to render without a bucket name rather than inventing one", () => {
    expect(() =>
      renderStateTemplate({ ...CONTEXT, stateBucket: null }),
    ).toThrow();
  });
});

describe("renderBackendFile", () => {
  it("locks, so two applies cannot write the state at once", () => {
    // The one line whose absence is invisible until two runs overlap and the loser's
    // resources become invisible to Terraform.
    expect(renderBackendFile(CONTEXT)).toContain("use_lockfile   = true");
  });

  it("encrypts through the project's own key once there is one", () => {
    const withKey = renderBackendFile({
      ...CONTEXT,
      stateKmsKeyArn: "arn:aws:kms:eu-central-1:545283928770:key/abc",
    });
    expect(withKey).toContain("encrypt        = true");
    expect(withKey).toContain("kms_key_id");
  });

  it("names the key explicitly rather than relying on the bucket default", () => {
    // The bucket default only applies to objects S3 encrypts itself, so a backend
    // falling back to SSE-S3 would look identical here and be a different guarantee.
    expect(renderBackendFile(CONTEXT)).toContain(
      `bucket         = "${CONTEXT.stateBucket}"`,
    );
    expect(renderBackendFile(CONTEXT)).toContain("key            =");
  });

  it("renders nothing without a bucket, rather than a backend pointing nowhere", () => {
    expect(renderBackendFile({ ...CONTEXT, stateBucket: null })).toBe("");
  });
});
