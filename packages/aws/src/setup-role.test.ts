import { describe, expect, it } from "vitest";
import { setupRoleName, setupRolePolicy } from "./setup-role";

describe("setupRoleName", () => {
  it("names one role per permission set", () => {
    expect(setupRoleName("IAM-Admin")).toBe("terrablox-setup-iam-admin");
    expect(setupRoleName("PowerUser")).toBe("terrablox-setup-poweruser");
  });

  it("stays inside IAM's 64-character limit without a trailing dash", () => {
    const name = setupRoleName(`${"a".repeat(47)}-${"b".repeat(30)}`);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.endsWith("-")).toBe(false);
  });
});

describe("setupRolePolicy", () => {
  const policy = JSON.parse(setupRolePolicy("123456789012"));
  const statement = (sid: string) =>
    policy.Statement.find((entry: { Sid: string }) => entry.Sid === sid);

  it("limits stacks to the two bootstrap stacks of a project", () => {
    expect(statement("BootstrapStacks").Resource).toEqual([
      "arn:aws:cloudformation:*:123456789012:stack/*-bootstrap/*",
      "arn:aws:cloudformation:*:123456789012:stack/*-state/*",
    ]);
  });

  it("limits role changes to deploy roles, so it cannot edit itself", () => {
    expect(statement("DeployRoles").Resource).toBe(
      "arn:aws:iam::123456789012:role/*-deploy",
    );
  });

  it("limits S3 to state buckets", () => {
    expect(statement("StateBuckets").Resource).toEqual([
      "arn:aws:s3:::*-tfstate-*",
      "arn:aws:s3:::*-tfstate-*/*",
    ]);
  });
});
