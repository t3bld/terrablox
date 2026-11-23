/*
 * The deck's behaviour: navigation, step reveals, and the three slides that are
 * driven by data rather than by markup.
 *
 * No dependencies and no build step, so the folder can be opened from disk or
 * zipped and sent as it is.
 */

/**
 * The presenter's name is optional and appears on the title slide.
 */
const DECK = {
  /** Shown on the title slide, e.g. "Max Mustermann". */
  presenter: "",
};

const STAGE_WIDTH = 1600;
const STAGE_HEIGHT = 900;
const SVG_NS = "http://www.w3.org/2000/svg";

const stage = document.getElementById("stage");
const slides = [...document.querySelectorAll(".slide")];

/** How many reveals a slide has: declared, or the highest `data-step` in it. */
const stepCounts = slides.map((slide) => {
  if (slide.dataset.steps) return Number(slide.dataset.steps);
  const steps = [...slide.querySelectorAll("[data-step]")].map((element) =>
    Number(element.dataset.step),
  );
  return Math.max(0, ...steps);
});

let index = 0;
let step = 0;

/** Per-slide behaviour, keyed by the slide's `id`. */
const hooks = {};

// ---- Small helpers ---------------------------------------------------------

function svg(name, attributes = {}, text) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value);
  }
  if (text !== undefined) element.textContent = text;
  return element;
}

function html(name, className, text) {
  const element = document.createElement(name);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// ---- Navigation ------------------------------------------------------------

function applyStep(slide, value) {
  slide.dataset.currentStep = String(value);
  for (const element of slide.querySelectorAll("[data-step]")) {
    element.classList.toggle("is-shown", Number(element.dataset.step) <= value);
  }
  hooks[slide.id]?.step?.(value);
}

function show(nextIndex, nextStep = 0) {
  const target = Math.min(Math.max(nextIndex, 0), slides.length - 1);
  const previous = slides[index];
  const changed = target !== index || !previous.classList.contains("is-active");

  index = target;
  step = Math.min(Math.max(nextStep, 0), stepCounts[index]);

  if (changed) {
    hooks[previous.id]?.leave?.();
    for (const [position, slide] of slides.entries()) {
      const active = position === index;
      slide.classList.toggle("is-active", active);
      slide.inert = !active;
    }
  }

  applyStep(slides[index], step);
  if (changed) hooks[slides[index].id]?.enter?.();

  const hash = step > 0 ? `#${index + 1}.${step}` : `#${index + 1}`;
  if (location.hash !== hash) history.replaceState(null, "", hash);

  const total = stepCounts.reduce((sum, count) => sum + count + 1, 0);
  const done =
    stepCounts.slice(0, index).reduce((sum, count) => sum + count + 1, 0) +
    step +
    1;
  document.getElementById("thread").style.width = `${(done / total) * 100}%`;
  document.getElementById("count").textContent =
    `${index + 1} / ${slides.length}`;

  renderNotes();
  markOverview();
}

function next() {
  if (step < stepCounts[index]) show(index, step + 1);
  else if (index < slides.length - 1) show(index + 1, 0);
}

function back() {
  if (step > 0) show(index, step - 1);
  else if (index > 0) show(index - 1, stepCounts[index - 1]);
}

function fromHash() {
  const [slideNumber, stepNumber] = location.hash.slice(1).split(".");
  show((Number(slideNumber) || 1) - 1, Number(stepNumber) || 0);
}

function fitStage() {
  const scale = Math.min(
    window.innerWidth / STAGE_WIDTH,
    window.innerHeight / STAGE_HEIGHT,
  );
  stage.style.setProperty("--scale", String(scale));
}

// ---- Notes and overview ----------------------------------------------------

const notesPanel = document.getElementById("notes");
const overview = document.getElementById("overview");
const overviewList = document.getElementById("overview-list");

/**
 * The notes are the script. Paragraphs marked `data-at` are spoken after that
 * many clicks, so the ones for the current step are lit and the rest are dimmed.
 */
function renderNotes() {
  if (notesPanel.hidden) return;
  const paragraphs = [...slides[index].querySelectorAll(".notes p")].map(
    (paragraph) => paragraph.cloneNode(true),
  );
  let previous = "0";
  for (const paragraph of paragraphs) {
    const at = paragraph.dataset.at;
    if (at === undefined) continue;
    paragraph.classList.toggle("is-now", Number(at) === step);
    // Only the first paragraph of a step follows a click.
    paragraph.classList.toggle("after-click", at !== previous);
    previous = at;
  }
  const body = html("div", "notes-body");
  body.append(...paragraphs);
  notesPanel.replaceChildren(
    html("strong", "", `Skript · ${index + 1} / ${slides.length}`),
    body,
  );
  // Like a teleprompter: the current paragraph at the top, what follows below it.
  const current = body.querySelector(".is-now");
  body.classList.toggle("is-stepped", Boolean(current));
  body.scrollTop = current ? current.offsetTop - paragraphs[0].offsetTop : 0;
}

function buildOverview() {
  let act = null;
  for (const [position, slide] of slides.entries()) {
    if (slide.dataset.act !== act) {
      act = slide.dataset.act;
      overviewList.append(html("li", "is-act", act));
    }
    const button = html("button");
    button.type = "button";
    button.dataset.go = String(position);
    button.append(
      html("i", "", String(position + 1).padStart(2, "0")),
      slide.dataset.title ?? "",
    );
    button.addEventListener("click", () => {
      overview.hidden = true;
      show(position, 0);
    });
    const item = html("li");
    item.append(button);
    overviewList.append(item);
  }
}

function markOverview() {
  for (const button of overviewList.querySelectorAll("button")) {
    button.setAttribute(
      "aria-current",
      String(Number(button.dataset.go) === index),
    );
  }
}

function toggleOverview() {
  overview.hidden = !overview.hidden;
  if (!overview.hidden) {
    overviewList.querySelector('[aria-current="true"]')?.focus();
  }
}

// ---- Presenter details -----------------------------------------------------

function applyConfig() {
  for (const element of document.querySelectorAll("[data-config]")) {
    const value = DECK[element.dataset.config]?.trim();
    if (!value) continue;
    element.textContent = value;
  }
}

// ---- Slide 8: the catalogue ------------------------------------------------

const CATALOGUE = [
  ["acm", "Certificate Manager"],
  ["alb", "Application Load Balancer"],
  ["apigateway", "API Gateway"],
  ["app-runner", "App Runner"],
  ["appconfig", "AppConfig"],
  ["appsync", "AppSync"],
  ["autoscaling", "EC2 Auto Scaling"],
  ["batch", "Batch"],
  ["cloudfront", "CloudFront"],
  ["cloudwatch", "CloudWatch"],
  ["datadog-forwarders", "Datadog Forwarders"],
  ["dms", "DMS"],
  ["dynamodb-table", "DynamoDB"],
  ["ec2-instance", "EC2"],
  ["ecr", "ECR"],
  ["ecs", "ECS"],
  ["efs", "EFS"],
  ["eks", "EKS"],
  ["eks-pod-identity", "EKS Pod Identity"],
  ["elasticache", "ElastiCache"],
  ["elb", "Classic Load Balancer"],
  ["emr", "EMR"],
  ["eventbridge", "EventBridge"],
  ["fsx", "FSx"],
  ["global-accelerator", "Global Accelerator"],
  ["grafana", "Managed Grafana"],
  ["iam", "IAM"],
  ["kms", "KMS"],
  ["lambda", "Lambda"],
  ["memory-db", "MemoryDB"],
  ["msk-kafka-cluster", "MSK"],
  ["network-firewall", "Network Firewall"],
  ["opensearch", "OpenSearch Service"],
  ["prometheus", "Managed Prometheus"],
  ["rds", "RDS"],
  ["rds-aurora", "Aurora"],
  ["rds-proxy", "RDS Proxy"],
  ["redshift", "Redshift"],
  ["route53", "Route 53"],
  ["s3-bucket", "S3"],
  ["secrets-manager", "Secrets Manager"],
  ["security-group", "Security Group"],
  ["sns", "SNS"],
  ["sqs", "SQS"],
  ["ssm-parameter", "SSM Parameter Store"],
  ["step-functions", "Step Functions"],
  ["transit-gateway", "Transit Gateway"],
  ["vpc", "VPC"],
  ["vpn-gateway", "VPN Gateway"],
  ["waf", "WAF"],
];

function setupWall() {
  const wall = document.getElementById("wall");
  for (const [position, [slug, name]] of CATALOGUE.entries()) {
    const tile = html("div", "tile");
    tile.style.setProperty("--i", String(position));
    const image = html("img");
    image.src = `assets/icons/${slug}.png`;
    image.alt = name;
    tile.append(image, html("span", "", name));
    wall.append(tile);
  }
}

// ---- Slide 9: the graph being built ----------------------------------------

/**
 * A small, complete example: five modules, five wires, one refused call.
 */
const GRAPH_NODES = {
  vpc: { x: 50, y: 36, w: 160, kind: "VPC", icon: "vpc" },
  web_sg: {
    x: 10,
    y: 216,
    w: 160,
    kind: "Security Group",
    icon: "security-group",
  },
  app_server: { x: 190, y: 400, w: 160, kind: "EC2", icon: "ec2-instance" },
  app_secrets: {
    x: 366,
    y: 36,
    w: 170,
    kind: "Secrets Manager",
    icon: "secrets-manager",
  },
  secrets_read_policy: {
    x: 334,
    y: 216,
    w: 226,
    kind: "IAM Policy",
    icon: "iam",
  },
};

const GRAPH_EDGES = {
  "vpc>web_sg": {
    d: "M90,96 L90,216",
    label: "vpc_id",
    at: [100, 162, "start"],
  },
  "web_sg>app_server": {
    d: "M90,276 C90,345 225,335 225,400",
    label: "vpc_security_group_ids",
    at: [198, 374, "end"],
  },
  "vpc>app_server": {
    d: "M190,96 C190,270 258,250 258,400",
    label: "subnet_id",
    at: [214, 180, "start"],
  },
  "app_secrets>secrets_read_policy": {
    d: "M450,96 L450,216",
    label: "policy",
    at: [460, 162, "start"],
  },
  "secrets_read_policy>app_server": {
    d: "M450,276 C450,345 318,335 318,400",
    label: "iam_role_policies",
    at: [346, 374, "start"],
  },
};

/** One entry per reveal. `m` is how many graph mutations an operation queued. */
const GRAPH_STEPS = [
  {
    ops: [
      {
        kind: "read",
        code: 'read_app_file("docker-compose.yml")',
        text: "Next.js-App mit PostgreSQL. Ein Container-Host genügt.",
      },
    ],
  },
  {
    ops: [
      {
        kind: "decide",
        code: 'record_decision("Wo die App läuft")',
        text: "Gewählt: EC2 mit Docker Compose. Verworfen: ECS Fargate – zu viele Fixkosten für einen PoC.",
      },
    ],
  },
  {
    nodes: ["vpc"],
    ops: [
      {
        code: 'add_module("vpc")',
        text: "Aus der Library, gepinnt auf v6.6.1.",
        m: 1,
      },
    ],
  },
  {
    nodes: ["web_sg"],
    edges: ["vpc>web_sg"],
    ops: [
      { code: 'add_module("security-group", "web_sg")', m: 1 },
      {
        code: 'auto_connect("web_sg")',
        text: "vpc_id hat genau eine passende Quelle.",
        m: 1,
      },
    ],
  },
  {
    nodes: ["app_server"],
    ghost: true,
    ops: [
      { code: 'add_module("ec2-instance", "app_server")', m: 1 },
      {
        kind: "refused",
        code: "connect(web_sg.sg_id → app_server)",
        text: "Abgelehnt: web_sg hat keinen Output „sg_id“. Gemeint ist security_group_id.",
      },
    ],
  },
  {
    edges: ["web_sg>app_server", "vpc>app_server"],
    ops: [
      {
        code: "connect(web_sg.security_group_id → …)",
        text: "Korrigiert im selben Turn, nicht erst bei terraform plan.",
        m: 1,
      },
      {
        code: 'edit_module("app_server", subnet_id)',
        text: "module.vpc.public_subnets[0]",
        m: 1,
      },
    ],
  },
  {
    nodes: ["app_secrets", "secrets_read_policy"],
    edges: [
      "app_secrets>secrets_read_policy",
      "secrets_read_policy>app_server",
    ],
    ops: [
      {
        code: "add_module × 2 · edit_module · connect",
        text: "Secrets Manager und eine Leseberechtigung für die Instanz.",
        m: 4,
      },
    ],
  },
  {
    ops: [
      {
        kind: "read",
        code: "review_project()",
        text: "0 Pflicht-Inputs offen · 0 unbekannte Argumente · 0 Typfehler",
      },
    ],
  },
  {
    final: true,
    ops: [
      {
        kind: "done",
        code: "commit → pipeline",
        text: "Erst jetzt erreicht etwas das Repository. fmt, init, validate: success.",
      },
    ],
  },
];

/** The Terraform a set of nodes and edges renders to, as lines with a flag. */
function renderTerraform(nodes, edges, fresh) {
  const lines = [];
  const block = (name, source, args = []) => {
    if (!nodes.has(name)) return;
    if (lines.length > 0) lines.push({ text: "" });
    const isNew = fresh.has(name);
    lines.push({
      isNew,
      text: `<span class="kw">module</span> <span class="s">"${name}"</span> {`,
    });
    lines.push({
      isNew,
      text: `  source = <span class="s">"…/${source}"</span>`,
    });
    for (const [edge, ...rows] of args) {
      if (!edges.has(edge)) continue;
      for (const row of rows) {
        lines.push({ isNew: isNew || fresh.has(edge), text: row });
      }
    }
    lines.push({ isNew, text: "}" });
  };
  const ref = (text) => `<span class="r">${text}</span>`;

  block("vpc", "vpc?ref=v6.6.1");
  block("web_sg", "security-group?ref=v6.0.0", [
    ["vpc>web_sg", `  vpc_id = ${ref("module.vpc.vpc_id")}`],
  ]);
  block("app_server", "ec2-instance?ref=v6.4.0", [
    ["vpc>app_server", `  subnet_id = ${ref("module.vpc.public_subnets[0]")}`],
    [
      "web_sg>app_server",
      "  vpc_security_group_ids = [",
      `    ${ref("module.web_sg.security_group_id")}`,
      "  ]",
    ],
    [
      "secrets_read_policy>app_server",
      "  iam_role_policies = {",
      `    read = ${ref("module.secrets_read_policy.arn")}`,
      "  }",
    ],
  ]);
  block("app_secrets", "secrets-manager?ref=v2.1.0");
  block("secrets_read_policy", "iam//modules/iam-policy?ref=v6.8.0", [
    [
      "app_secrets>secrets_read_policy",
      "  policy = jsonencode({",
      `    …, Resource = ${ref("module.app_secrets.secret_arn")}`,
      "  })",
    ],
  ]);

  return lines.length > 0
    ? lines
    : [
        {
          text: '<span class="c"># noch leer – der Graph hat keine Module</span>',
        },
      ];
}

function setupLiveGraph() {
  const slide = document.getElementById("live");
  const part = (name) => slide.querySelector(`[data-live="${name}"]`);
  const canvas = part("svg");
  const nodeElements = {};
  const edgeElements = {};

  for (const [name, edge] of Object.entries(GRAPH_EDGES)) {
    const group = svg("g", { class: "ge" });
    const [x, y, anchor] = edge.at;
    const start = edge.d.match(/^M([\d.]+),([\d.]+)/);
    const end = edge.d.match(/([\d.]+),([\d.]+)$/);
    group.append(
      svg("path", { d: edge.d, pathLength: "1" }),
      svg("circle", { cx: start[1], cy: start[2], r: "3.5" }),
      svg("circle", { cx: end[1], cy: end[2], r: "3.5" }),
      svg("text", { x, y, "text-anchor": anchor }, edge.label),
    );
    canvas.append(group);
    edgeElements[name] = group;
  }

  const ghost = svg("g", { class: "ge ghost" });
  ghost.append(
    svg("path", { d: GRAPH_EDGES["web_sg>app_server"].d, pathLength: "1" }),
    svg("rect", { x: "34", y: "316", width: "186", height: "28", rx: "8" }),
    svg(
      "text",
      { x: "127", y: "335", "text-anchor": "middle" },
      "✕ Output sg_id fehlt",
    ),
  );
  canvas.append(ghost);

  for (const [name, node] of Object.entries(GRAPH_NODES)) {
    const group = svg("g", { class: "gnode" });
    const icon = svg("image", {
      href: `assets/icons/${node.icon}.png`,
      x: node.x + 12,
      y: node.y + 14,
      width: "32",
      height: "32",
    });
    group.append(
      svg("rect", {
        x: node.x,
        y: node.y,
        width: node.w,
        height: "60",
        rx: "10",
      }),
      icon,
      svg("text", { class: "t", x: node.x + 54, y: node.y + 27 }, name),
      svg("text", { class: "k", x: node.x + 54, y: node.y + 45 }, node.kind),
    );
    canvas.append(group);
    nodeElements[name] = group;
  }

  const mutationTotal = GRAPH_STEPS.flatMap((entry) => entry.ops).reduce(
    (sum, op) => sum + (op.m ?? 0),
    0,
  );
  let timer = null;

  function stop() {
    clearInterval(timer);
    timer = null;
    part("play").textContent = "▶ Abspielen";
  }

  function render(current) {
    const nodes = new Set();
    const edges = new Set();
    let mutations = 0;
    const log = [];

    for (const [position, entry] of GRAPH_STEPS.entries()) {
      if (position > current) break;
      for (const name of entry.nodes ?? []) nodes.add(name);
      for (const name of entry.edges ?? []) edges.add(name);
      for (const op of entry.ops) {
        mutations += op.m ?? 0;
        const row = html("div", `op ${op.kind ?? ""}`);
        row.classList.toggle("is-new", position === current);
        row.append(html("code", "", op.code));
        if (op.text) row.append(html("p", "", op.text));
        log.push(row);
      }
    }

    const now = GRAPH_STEPS[current];
    const fresh = new Set([...(now.nodes ?? []), ...(now.edges ?? [])]);

    for (const [name, element] of Object.entries(nodeElements)) {
      element.classList.toggle("is-on", nodes.has(name));
      element.classList.toggle("is-fresh", fresh.has(name));
    }
    for (const [name, element] of Object.entries(edgeElements)) {
      element.classList.toggle("is-on", edges.has(name));
      element.classList.toggle("is-fresh", fresh.has(name));
    }
    ghost.classList.toggle("is-on", Boolean(now.ghost));

    part("log").replaceChildren(...log);
    part("empty").style.opacity = nodes.size === 0 ? "1" : "0";
    part("step").textContent = `${current} / ${GRAPH_STEPS.length - 1}`;
    part("size").textContent =
      `${nodes.size} Module · ${edges.size} ${edges.size === 1 ? "Kante" : "Kanten"}`;
    part("mut").textContent =
      `${mutations} ${mutations === 1 ? "Mutation" : "Mutationen"}`;
    part("rail").style.width = `${(mutations / mutationTotal) * 100}%`;
    part("ist").classList.toggle("is-on", !now.final);
    part("soll").classList.toggle("is-data", Boolean(now.final));
    part("verdict").classList.toggle("is-on", Boolean(now.final));
    part("tf").innerHTML = renderTerraform(nodes, edges, fresh)
      .map(
        (line) =>
          `<span class="l${line.isNew ? " new" : ""}">${line.text}</span>`,
      )
      .join("");

    if (now.final) stop();
  }

  part("play").addEventListener("click", () => {
    if (timer) return stop();
    if (step >= GRAPH_STEPS.length - 1) show(index, 0);
    part("play").textContent = "❚❚ Pause";
    timer = setInterval(next, 1700);
  });
  part("reset").addEventListener("click", () => {
    stop();
    show(index, 0);
  });

  hooks.live = { step: render, leave: stop };
}

// ---- Slide 10: one recorded turn --------------------------------------------

function setupRecord() {
  const slide = document.getElementById("record");
  const parts = [...slide.querySelectorAll("[data-k]")];
  hooks.record = {
    step(current) {
      for (const element of parts) {
        element.classList.toggle(
          "is-hot",
          current > 0 && element.dataset.k === String(current),
        );
      }
    },
  };
}

// ---- Slide 11: the dataset filling up ---------------------------------------

function setupFlywheel() {
  const grid = document.getElementById("dataset");
  const cells = Array.from({ length: 48 }, () => html("i"));
  grid.append(...cells);
  let timer = null;
  let filled = 0;

  const fill = (count) => {
    filled = count;
    for (const [position, cell] of cells.entries()) {
      cell.classList.toggle("is-on", position < filled);
    }
  };

  hooks.flywheel = {
    enter() {
      fill(0);
      timer = setInterval(() => {
        if (filled >= cells.length) return clearInterval(timer);
        fill(filled + 1);
      }, 420);
    },
    leave() {
      clearInterval(timer);
    },
    print() {
      fill(30);
    },
  };
}

// ---- Wiring -----------------------------------------------------------------

const NEXT_KEYS = new Set(["ArrowRight", "PageDown", " ", "Enter"]);
const BACK_KEYS = new Set(["ArrowLeft", "PageUp", "Backspace"]);

document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const onControl = event.target.closest?.("button, a");
  const key = event.key;

  if (key === "Escape") {
    if (!overview.hidden) overview.hidden = true;
    else if (!notesPanel.hidden) notesPanel.hidden = true;
    return;
  }
  if (key === "o" || key === "O") return toggleOverview();
  if (!overview.hidden) return;

  if (NEXT_KEYS.has(key)) {
    if (onControl && (key === " " || key === "Enter")) return;
    event.preventDefault();
    next();
  } else if (BACK_KEYS.has(key)) {
    event.preventDefault();
    back();
  } else if (key === "ArrowDown") {
    event.preventDefault();
    show(index + 1, 0);
  } else if (key === "ArrowUp") {
    event.preventDefault();
    show(index - 1, 0);
  } else if (key === "Home") {
    show(0, 0);
  } else if (key === "End") {
    show(slides.length - 1, 0);
  } else if (key === "n" || key === "N") {
    notesPanel.hidden = !notesPanel.hidden;
    renderNotes();
  } else if (key === "f" || key === "F") {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  }
});

let touchStart = null;
document.addEventListener(
  "touchstart",
  (event) => {
    touchStart = event.changedTouches[0].clientX;
  },
  { passive: true },
);
document.addEventListener(
  "touchend",
  (event) => {
    if (touchStart === null) return;
    const distance = event.changedTouches[0].clientX - touchStart;
    touchStart = null;
    if (Math.abs(distance) < 50) return;
    if (distance < 0) next();
    else back();
  },
  { passive: true },
);

document.getElementById("next").addEventListener("click", next);
document.getElementById("prev").addEventListener("click", back);
overview.addEventListener("click", (event) => {
  if (event.target === overview) overview.hidden = true;
});

window.addEventListener("resize", fitStage);
window.addEventListener("hashchange", fromHash);

// A printed deck has no steps to click through, so every slide is shown as it
// looks once all of its reveals have run.
window.addEventListener("beforeprint", () => {
  for (const [position, slide] of slides.entries()) {
    const printed = slide.dataset.printStep;
    applyStep(slide, printed ? Number(printed) : stepCounts[position]);
    hooks[slide.id]?.print?.();
  }
});
window.addEventListener("afterprint", () => {
  for (const slide of slides) applyStep(slide, 0);
  show(index, step);
});

applyConfig();
setupLiveGraph();
setupWall();
setupRecord();
setupFlywheel();
buildOverview();
fitStage();
for (const slide of slides) applyStep(slide, 0);
fromHash();
