// Drives the built server over stdio with a real MCP client, the way a host would.
//
// Compiling proves nothing about a protocol server: the interesting failures are a tool
// whose schema the client rejects, a resource that comes back with the wrong MIME type, or
// a handler that throws on the first real argument. So this speaks the actual protocol.
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/bin.js"],
});

const client = new Client({ name: "probe", version: "0.0.0" });
await client.connect(transport);

const out = (label, value) => console.log(`\n### ${label}\n${value}`);

const tools = await client.listTools();
out(
  "tools/list",
  tools.tools
    .map((tool) => {
      const ui = tool._meta?.["ui/resourceUri"] ?? tool._meta?.ui?.resourceUri;
      const keys = Object.keys(tool.inputSchema?.properties ?? {});
      return `  ${tool.name}  args=[${keys}]${ui ? `  ui=${ui}` : ""}`;
    })
    .join("\n"),
);

const resources = await client.listResources();
out(
  "resources/list",
  resources.resources
    .map((r) => `  ${r.uri}  ${r.mimeType ?? "(no mime)"}`)
    .join("\n") || "  (none)",
);

const text = (r) =>
  r.content?.map((c) => c.text ?? `[${c.type}]`).join("\n") ?? "";

const list = await client.callTool({
  name: "list_catalogue_modules",
  arguments: { query: "rds" },
});
out(
  "list_catalogue_modules query=rds",
  text(list).split("\n").slice(0, 8).join("\n"),
);

const describe = await client.callTool({
  name: "describe_catalogue_module",
  arguments: { module: "elb" },
});
out(
  "describe_catalogue_module elb",
  text(describe).split("\n").slice(0, 12).join("\n"),
);

const typo = await client.callTool({
  name: "describe_catalogue_module",
  arguments: { module: "vcp" },
});
out(
  `describe_catalogue_module vcp  (isError=${typo.isError})`,
  `  ${text(typo)}`,
);

// A stack with one of each mistake the checker claims to catch.
const bad = {
  calls: [
    { module: "vpc", name: "network", arguments: { name: "demo" } },
    {
      module: "elb",
      name: "lb",
      arguments: {
        vpc_id: "module.network.vpc_id",
        subnets: "module.network.public_subnets",
        nonexistent_arg: "true",
        health_check: '"not-a-map"',
      },
    },
    { module: "rds", name: "db", arguments: { subnet_ids: "module.nope.ids" } },
    { module: "vpc", name: "network", arguments: {} },
    { module: "totally-made-up", name: "ghost", arguments: {} },
  ],
};

const check = await client.callTool({
  name: "check_stack",
  arguments: { stack: bad },
});
out("check_stack (deliberately broken)", text(check));

const refused = await client.callTool({
  name: "render_terraform",
  arguments: { stack: bad },
});
out(
  `render_terraform on broken stack  isError=${refused.isError}`,
  `  ${text(refused).split("\n")[0]}`,
);

// A stack that should come back clean: acm needs nothing required.
const good = {
  calls: [
    { module: "acm", name: "cert", arguments: { domain_name: "example.com" } },
  ],
};
const ok = await client.callTool({
  name: "check_stack",
  arguments: { stack: good },
});
out("check_stack (clean)", text(ok));

const rendered = await client.callTool({
  name: "render_terraform",
  arguments: { stack: good },
});
out(`render_terraform  isError=${rendered.isError ?? false}`, text(rendered));

const review = await client.callTool({
  name: "review_stack",
  arguments: { stack: good },
});
const sc = review.structuredContent ?? {};
out(
  "review_stack structuredContent",
  `  keys=${Object.keys(sc)}\n  calls=${sc.calls?.length}  problems=${sc.problems?.length}  costBuckets=${sc.costs?.length}  terraform=${sc.terraform ? "present" : "null"}`,
);

const ui = await client.readResource({
  uri: "ui://terrablox/stack-review.html",
});
const doc = ui.contents[0];
out(
  "resources/read the panel",
  `  mimeType=${doc.mimeType}\n  bytes=${doc.text.length}\n  starts=${doc.text.slice(0, 40).replace(/\n/g, " ")}\n  hasInlineScript=${doc.text.includes('<script type="module">')}`,
);

await client.close();
