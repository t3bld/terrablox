import { App } from "@modelcontextprotocol/ext-apps";

/**
 * The stack review panel, as it runs inside the host's sandboxed iframe.
 *
 * Vanilla DOM rather than React, and the reason is where this code ends up: inlined into
 * one HTML document that a host fetches over `resources/read`. A framework would be most of
 * that document's weight in order to render three lists that never change shape. The
 * dashboard's components are not reusable here anyway — they are Tailwind classes resolved
 * against a build this iframe is not part of.
 *
 * Rendered from `structuredContent`, which the host pushes in after the tool returns. The
 * panel therefore starts empty and fills on `ontoolresult`; a spinner would be dishonest
 * about what it is waiting for, so it says so instead.
 */

interface Problem {
  kind: string;
  severity: "blocking" | "warning";
  confidence: "certain" | "unverifiable";
  where: string | null;
  message: string;
}

interface Call {
  name: string;
  module: string;
  resolved: {
    slug: string;
    title: string;
    version: string;
    repo: string;
  } | null;
  arguments: Record<string, string>;
}

interface CostBucket {
  key: string;
  label: string;
  hint: string;
  /**
   * `extra` rather than a flat field, because the grouping is shared with the marketing
   * site and that one carries a service name and icon here instead. The shared function
   * does not know what its callers attach, so it hands the payload through untouched.
   */
  resources: Array<{
    type: string;
    driver: string | null;
    extra: { from: string };
  }>;
}

interface Result {
  calls: Call[];
  problems: Problem[];
  costs: CostBucket[];
  terraform: string | null;
}

const root = document.getElementById("root");

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // `textContent`, never `innerHTML`. Every string here — module names, argument values,
  // problem messages — originates in a model's tool call, and the sandbox is not a reason
  // to hand it an injection point.
  if (text !== undefined) node.textContent = text;
  return node;
}

function section(title: string, count?: number): HTMLElement {
  const wrap = el("section", "card");
  const head = el("h2");
  head.append(el("span", undefined, title));
  if (count !== undefined) head.append(el("span", "pill", String(count)));
  wrap.append(head);
  return wrap;
}

function renderProblems(problems: Problem[]): HTMLElement {
  const blocking = problems.filter((p) => p.severity === "blocking").length;
  const wrap = section("Interface check", problems.length);

  if (problems.length === 0) {
    wrap.append(
      el(
        "p",
        "ok",
        "Nothing to report against the declared interfaces. Still not a substitute for terraform plan, which sees the providers and the whole configuration.",
      ),
    );
    return wrap;
  }

  wrap.append(
    el(
      "p",
      "muted",
      `${blocking} blocking, ${problems.length - blocking} to be aware of.`,
    ),
  );

  const list = el("ul", "problems");
  for (const problem of problems) {
    const item = el("li", problem.severity);
    const tags = el("div", "tags");
    tags.append(el("span", `tag ${problem.severity}`, problem.severity));
    if (problem.confidence === "unverifiable") {
      // Named in the UI as well as in the text, because this is the one finding a reader
      // should not act on blindly: the catalogue holds only part of that module.
      tags.append(el("span", "tag unverifiable", "unverifiable"));
    }
    tags.append(el("span", "tag kind", problem.kind));
    if (problem.where) tags.append(el("code", undefined, problem.where));
    item.append(tags);
    item.append(el("p", undefined, problem.message));
    list.append(item);
  }

  wrap.append(list);
  return wrap;
}

function renderCalls(calls: Call[]): HTMLElement {
  const wrap = section("Modules", calls.length);

  for (const call of calls) {
    const row = el("div", "row");
    const head = el("div", "row-head");
    head.append(el("code", "label", call.name));

    if (call.resolved) {
      head.append(el("span", "muted", call.resolved.title));
      head.append(el("span", "tag version", call.resolved.version));
    } else {
      head.append(el("span", "tag blocking", `unknown: ${call.module}`));
    }
    row.append(head);

    const args = Object.entries(call.arguments);
    if (args.length > 0) {
      const table = el("dl", "args");
      for (const [name, value] of args) {
        table.append(el("dt", undefined, name));
        table.append(el("dd", undefined, value));
      }
      row.append(table);
    } else {
      row.append(el("p", "muted", "No arguments set."));
    }

    wrap.append(row);
  }

  return wrap;
}

function renderCosts(costs: CostBucket[]): HTMLElement {
  const wrap = section("What it bills for");

  if (costs.length === 0) {
    wrap.append(el("p", "muted", "No classified resources in this stack."));
    return wrap;
  }

  wrap.append(
    el(
      "p",
      "muted",
      "No amounts: a module's interface does not carry a region, a size or a guess at traffic, so a figure here would be invented. What follows is the shape of the bill.",
    ),
  );

  for (const bucket of costs) {
    const group = el("div", `bucket ${bucket.key}`);
    const head = el("div", "row-head");
    head.append(el("strong", undefined, bucket.label));
    head.append(el("span", "pill", String(bucket.resources.length)));
    group.append(head);
    group.append(el("p", "muted", bucket.hint));

    const list = el("ul", "types");
    for (const resource of bucket.resources) {
      const item = el("li");
      item.append(el("code", undefined, resource.type));
      item.append(el("span", "muted", ` from ${resource.extra.from}`));
      if (resource.driver) item.append(el("span", "driver", resource.driver));
      list.append(item);
    }
    group.append(list);
    wrap.append(group);
  }

  return wrap;
}

function renderTerraform(terraform: string | null): HTMLElement {
  const wrap = section("Terraform");

  if (terraform === null) {
    wrap.append(
      el(
        "p",
        "muted",
        "Not rendered while blocking problems stand. Code that cannot plan is not worth reviewing.",
      ),
    );
    return wrap;
  }

  const pre = el("pre");
  pre.append(el("code", undefined, terraform));
  wrap.append(pre);

  const copy = el("button", "copy", "Copy") as HTMLButtonElement;
  copy.type = "button";
  copy.addEventListener("click", () => {
    void navigator.clipboard.writeText(terraform).then(
      () => {
        copy.textContent = "Copied";
        setTimeout(() => {
          copy.textContent = "Copy";
        }, 1500);
      },
      () => {
        // Clipboard access can be denied by the sandbox. Say so rather than looking
        // like the click did nothing.
        copy.textContent = "Copy blocked";
      },
    );
  });
  wrap.append(copy);

  return wrap;
}

function render(result: Result): void {
  if (!root) return;
  root.replaceChildren(
    renderProblems(result.problems),
    renderCalls(result.calls),
    renderCosts(result.costs),
    renderTerraform(result.terraform),
  );
}

const app = new App({ name: "terrablox-stack-review", version: "0.1.0" });

// `addEventListener` rather than the `ontoolresult` property, which the SDK deprecates in
// favour of this: it composes with other listeners instead of replacing them.
//
// Registered before `connect`, because the host may push the result the moment the
// connection opens and a handler attached afterwards would miss the only message that
// matters.
app.addEventListener("toolresult", (params) => {
  const structured = params.structuredContent as Result | undefined;
  if (structured) render(structured);
});

void app.connect().catch(() => {
  if (root) {
    root.replaceChildren(
      el(
        "p",
        "muted",
        "Could not reach the host. This panel is rendered by the MCP host and has nothing to show on its own.",
      ),
    );
  }
});
