import { describe, expect, it } from "vitest";
import {
  githubRepoUrl,
  iamRoleConsoleUrl,
  kmsKeyConsoleUrl,
  s3BucketConsoleUrl,
} from "./console-links";

describe("console links", () => {
  it("opens the repository on its branch", () => {
    expect(githubRepoUrl("porsche-code/terrablox-test", "main")).toBe(
      "https://github.com/porsche-code/terrablox-test/tree/main",
    );
    expect(githubRepoUrl("o/r", "feature/x y")).toBe(
      "https://github.com/o/r/tree/feature/x%20y",
    );
    expect(githubRepoUrl("not a repo", "main")).toBeNull();
  });

  it("opens the role by name, also when it has a path", () => {
    expect(
      iamRoleConsoleUrl("arn:aws:iam::827063196867:role/terrablox-test-deploy"),
    ).toBe(
      "https://console.aws.amazon.com/iam/home#/roles/details/terrablox-test-deploy",
    );
    expect(iamRoleConsoleUrl("arn:aws:iam::1:role/ci/deployer")).toBe(
      "https://console.aws.amazon.com/iam/home#/roles/details/deployer",
    );
    expect(iamRoleConsoleUrl("arn:aws:iam::1:user/someone")).toBeNull();
    expect(iamRoleConsoleUrl(null)).toBeNull();
  });

  it("opens the bucket's objects in its region", () => {
    expect(
      s3BucketConsoleUrl(
        "terrablox-test-tfstate-827063196867-p5snzd",
        "eu-central-1",
      ),
    ).toBe(
      "https://s3.console.aws.amazon.com/s3/buckets/terrablox-test-tfstate-827063196867-p5snzd?region=eu-central-1&tab=objects",
    );
    expect(s3BucketConsoleUrl("Bad_Name", "eu-central-1")).toBeNull();
  });

  it("opens the key in the region its ARN names", () => {
    expect(
      kmsKeyConsoleUrl(
        "arn:aws:kms:eu-central-1:827063196867:key/50b20bcf-7467-4a6e-956f-3565eef22c64",
      ),
    ).toBe(
      "https://eu-central-1.console.aws.amazon.com/kms/home?region=eu-central-1#/kms/keys/50b20bcf-7467-4a6e-956f-3565eef22c64",
    );
    expect(kmsKeyConsoleUrl("arn:aws:kms:eu-central-1:1:alias/x")).toBeNull();
  });
});
