import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const PORT = Number(process.env.PORT || 8090);
const BINARY = process.env.INFRACOST_BINARY || "/opt/infracost/infracost";
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 300;
const PROCESS_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_CONCURRENT_SCANS = 2;
let activeScans = 0;

const serviceToken = process.env.COST_SERVICE_TOKEN?.trim() || "";
if (serviceToken.length < 32) {
  throw new Error(
    "COST_SERVICE_TOKEN must be at least 32 characters. Generate one with: openssl rand -base64 32",
  );
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function currencyOf(value) {
  const normalized = value?.trim().toUpperCase();
  return normalized && /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

function configuredCurrency() {
  return currencyOf(process.env.INFRACOST_CLI_CURRENCY) ?? "EUR";
}

function configured() {
  const hosted = Boolean(
    process.env.INFRACOST_CLI_AUTHENTICATION_TOKEN?.trim() ||
      process.env.INFRACOST_API_KEY?.trim(),
  );
  const selfHosted = Boolean(
    process.env.INFRACOST_CLI_PRICING_ENDPOINT?.trim() &&
      process.env.INFRACOST_CLI_PRICING_API_KEY?.trim(),
  );
  return hosted || selfHosted;
}

function authorized(request) {
  const header = request.headers.authorization || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!supplied) return false;
  const a = Buffer.from(serviceToken);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function bodyOf(request) {
  const declared = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw Object.assign(new Error("Scan request is too large."), {
      status: 413,
    });
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error("Scan request is too large."), {
        status: 413,
      });
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Scan request is not valid JSON."), {
      status: 400,
    });
  }
}

function scanInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("Invalid scan request."), { status: 400 });
  }
  const files = Array.isArray(value.files) ? value.files : [];
  if (files.length === 0 || files.length > MAX_FILES) {
    throw Object.assign(
      new Error(`A scan needs between 1 and ${MAX_FILES} source files.`),
      { status: 400 },
    );
  }

  const parsed = files.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.path !== "string" ||
      typeof entry.content !== "string"
    ) {
      throw Object.assign(
        new Error("Every source file needs a path and content."),
        {
          status: 400,
        },
      );
    }
    const path = entry.path.replaceAll("\\", "/").replace(/^\/+/, "");
    if (!path || path.split("/").some((part) => part === "..")) {
      throw Object.assign(new Error("A source file path is invalid."), {
        status: 400,
      });
    }
    return { path, content: entry.content };
  });

  return {
    files: parsed,
    githubToken: typeof value.githubToken === "string" ? value.githubToken : "",
    currency: currencyOf(value.currency) ?? configuredCurrency(),
  };
}

function redact(value, secret) {
  return [secret, encodeURIComponent(secret)].reduce(
    (text, candidate) =>
      candidate ? text.replaceAll(candidate, "[redacted]") : text,
    value,
  );
}

function runInfracost(root, input, signal) {
  const selfHosted = Boolean(
    process.env.INFRACOST_CLI_PRICING_ENDPOINT?.trim() &&
      process.env.INFRACOST_CLI_PRICING_API_KEY?.trim(),
  );
  const hostedToken =
    process.env.INFRACOST_CLI_AUTHENTICATION_TOKEN?.trim() ||
    process.env.INFRACOST_API_KEY?.trim() ||
    "";
  const env = {
    ...process.env,
    NO_COLOR: "1",
    INFRACOST_CLI_CURRENCY: input.currency,
    INFRACOST_CLI_LOG_LEVEL: "error",
    INFRACOST_CLI_PLUGIN_AUTO_UPDATE: "false",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.https://x-access-token:${encodeURIComponent(input.githubToken)}@github.com/.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/",
  };
  delete env.INFRACOST_API_KEY;
  delete env.INFRACOST_PRICING_API_ENDPOINT;

  if (selfHosted) {
    delete env.INFRACOST_CLI_AUTHENTICATION_TOKEN;
  } else {
    env.INFRACOST_CLI_AUTHENTICATION_TOKEN = hostedToken;
  }

  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      BINARY,
      ["scan", "--currency", input.currency, "--json", root],
      {
        detached: true,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const killGroup = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    };
    let aborted = false;
    const abort = () => {
      aborted = true;
      killGroup();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, PROCESS_TIMEOUT_MS);

    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) killGroup();
      else target.push(chunk);
    };

    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      rejectRun(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      killGroup();
      if (aborted) {
        rejectRun(
          Object.assign(new Error("The cost scan was cancelled."), {
            status: 499,
          }),
        );
        return;
      }
      if (timedOut) {
        rejectRun(
          Object.assign(new Error("The cost scan timed out."), { status: 504 }),
        );
        return;
      }
      if (bytes > MAX_OUTPUT_BYTES) {
        rejectRun(
          Object.assign(new Error("The cost scan output was too large."), {
            status: 502,
          }),
        );
        return;
      }
      resolveRun({
        stdout: redact(
          Buffer.concat(stdout).toString("utf8"),
          input.githubToken,
        ),
        stderr: redact(
          Buffer.concat(stderr).toString("utf8"),
          input.githubToken,
        ),
        code: code ?? 1,
      });
    });
  });
}

async function scan(request, response) {
  if (!authorized(request)) {
    json(response, 401, { error: "Unauthorized" });
    return;
  }
  if (!configured()) {
    json(response, 503, { error: "Infracost credentials are not configured." });
    return;
  }
  if (activeScans >= MAX_CONCURRENT_SCANS) {
    json(response, 429, { error: "The cost service is already busy." });
    return;
  }

  activeScans += 1;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortClosedResponse = () => {
    if (!response.writableEnded) controller.abort();
  };
  request.once("aborted", abort);
  response.once("close", abortClosedResponse);
  let directory;
  try {
    const input = scanInput(await bodyOf(request));
    directory = await mkdtemp(join(tmpdir(), "terrablox-cost-service-"));

    for (const file of input.files) {
      const path = resolve(directory, file.path);
      if (relative(directory, path).startsWith("..")) continue;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content, "utf8");
    }

    json(
      response,
      200,
      await runInfracost(directory, input, controller.signal),
    );
  } catch (error) {
    if (!response.writableEnded && !response.destroyed) {
      json(response, Number(error?.status) || 500, {
        error: error instanceof Error ? error.message : "The cost scan failed.",
      });
    }
  } finally {
    request.removeListener("aborted", abort);
    response.removeListener("close", abortClosedResponse);
    activeScans -= 1;
    if (directory) {
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://cost-service");
  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, {
      ok: true,
      configured: configured(),
      version: "2.18.3",
      currency: configuredCurrency(),
      activeScans,
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/scan") {
    void scan(request, response);
    return;
  }
  json(response, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`terrablox-cost-service: listening on 0.0.0.0:${PORT}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
