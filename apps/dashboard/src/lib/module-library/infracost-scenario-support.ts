import type {
  ModuleResourceDto,
  ModuleVariableDto,
} from "@/lib/module-library/types";

const EC2_MODULE_REPOSITORY =
  /github\.com\/terrablox\/terrablox-aws-ec2-instance(?:\.git)?(?:[/?#]|$)/i;
const REQUIRED_INPUTS = [
  "instance_type",
  "create_spot_instance",
  "monitoring",
  "create_eip",
  "tenancy",
  "root_block_device",
  "region",
] as const;

/** The exact module contract the generated Infracost scenario knows how to call. */
export function supportsEc2InfracostScenario(input: {
  sourceUrl: string | null | undefined;
  resources: Array<Pick<ModuleResourceDto, "kind" | "resourceType">>;
  variables: ModuleVariableDto[];
}): boolean {
  if (!input.sourceUrl || !EC2_MODULE_REPOSITORY.test(input.sourceUrl)) {
    return false;
  }
  if (
    !input.resources.some(
      (resource) =>
        resource.kind !== "data" && resource.resourceType === "aws_instance",
    )
  ) {
    return false;
  }

  const names = new Set(input.variables.map((variable) => variable.name));
  return REQUIRED_INPUTS.every((name) => names.has(name));
}
