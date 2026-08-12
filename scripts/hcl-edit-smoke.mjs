import {
  appendBlock,
  findBlock,
  listBlockAttributes,
  listBlocks,
  removeBlock,
  removeBlockAttribute,
  renameBlockLabel,
  renderModuleBlock,
  setBlockAttribute,
  uniqueBlockLabel,
} from "../apps/dashboard/src/lib/terraform/hcl-edit.ts";

let failures = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) {
    failures++;
    console.log(`FAIL ${name}\n--- actual ---\n${actual}\n--- expected ---\n${expected}\n`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const source = `# header comment
terraform {
  required_version = ">= 1.5"
}

module "vpc" {
  source = "git::https://github.com/acme/vpc.git?ref=1.0.0"

  cidr = "10.0.0.0/16"
  tags = {
    Name = "\${local.prefix}-vpc"
  }
}

module "app" {
  source    = "git::https://github.com/acme/app.git?ref=2.0.0"
  vpc_id    = module.vpc.id
  user_data = <<-EOT
    echo "}"
  EOT
}
`;

const blocks = listBlocks(source);
check("block count", blocks.length, 3);
check("block types", blocks.map((b) => `${b.type}:${b.labels.join(",")}`).join("|"), "terraform:|module:vpc|module:app");

const app = findBlock(source, "module", "app");
check(
  "attributes of app",
  listBlockAttributes(source, app).map((a) => a.name).join(","),
  "source,vpc_id,user_data",
);

const vpc = findBlock(source, "module", "vpc");
check(
  "nested block not read as attribute",
  listBlockAttributes(source, vpc).map((a) => a.name).join(","),
  "source,cidr,tags",
);

check(
  "set existing attribute",
  setBlockAttribute(source, { type: "module", label: "app", name: "vpc_id", value: "module.vpc.vpc_id" }).includes("vpc_id    = module.vpc.vpc_id"),
  true,
);

const withNew = setBlockAttribute(source, { type: "module", label: "vpc", name: "azs", value: '["a"]' });
check("insert new attribute", /\n  azs = \["a"\]\n\}/.test(withNew), true);

const removedAttr = removeBlockAttribute(source, { type: "module", label: "app", name: "vpc_id" });
check("remove attribute", removedAttr.includes("vpc_id"), false);
check("remove attribute keeps heredoc", removedAttr.includes('echo "}"'), true);

const removed = removeBlock(source, "module", "vpc");
check("remove block drops vpc", removed.includes('module "vpc"'), false);
check("remove block keeps app", removed.includes('module "app"'), true);
check("remove block keeps terraform", removed.includes("required_version"), true);

check(
  "render module block",
  renderModuleBlock({ name: "alb", source: "git::https://x/y.git?ref=1" }),
  'module "alb" {\n  source = "git::https://x/y.git?ref=1"\n}\n',
);

check(
  "append block",
  appendBlock('module "a" {\n}\n', 'module "b" {\n}\n'),
  'module "a" {\n}\n\nmodule "b" {\n}\n',
);

check("unique label", uniqueBlockLabel(["vpc", "vpc_2"], "vpc"), "vpc_3");
check("unique label sanitises", uniqueBlockLabel([], "AWS VPC!"), "aws_vpc");

const renamed = renameBlockLabel(source, "module", "vpc", "network");
check("rename block", renamed.includes('module "network" {'), true);
check("rename leaves references", renamed.includes("module.vpc.id"), true);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
