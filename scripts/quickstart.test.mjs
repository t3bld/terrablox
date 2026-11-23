import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";

const interactiveTest = test.skipIf(
  spawnSync("python3", ["-c", "import pty"]).status !== 0,
);

async function fixture(t, extraEnv = "") {
  const root = await mkdtemp(join(tmpdir(), "terrablox-quickstart-test-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "apps/dashboard"), { recursive: true });
  await mkdir(join(root, "bin"));
  await copyFile(
    resolve("scripts/quickstart.sh"),
    join(root, "scripts/quickstart.sh"),
  );
  await writeFile(join(root, ".env.example"), "");
  await writeFile(
    join(root, ".env"),
    `DATABASE_URL=postgresql://test
BETTER_AUTH_SECRET=existing-secret
GITHUB_CLIENT_ID=existing-client
GITHUB_CLIENT_SECRET=existing-secret
${extraEnv}`,
  );
  const mocks = {
    docker: `#!/bin/bash
echo "docker $*" >> "$MOCK_LOG"
case "$*" in
  *"ps -q postgres"*) echo container-id ;;
  inspect*) echo healthy ;;
esac
`,
    pnpm: `#!/bin/bash
echo "pnpm $*" >> "$MOCK_LOG"
if [ "$*" = "db:builtin:sync" ] && [ "\${FAIL_SYNC:-}" = 1 ]; then exit 1; fi
`,
    gh: `#!/bin/bash
echo "gh $*" >> "$MOCK_LOG"
echo test-github-token
`,
  };
  for (const [name, content] of Object.entries(mocks)) {
    const path = join(root, "bin", name);
    await writeFile(path, content);
    await chmod(path, 0o755);
  }
  const env = {
    ...process.env,
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    MOCK_LOG: join(root, "commands.log"),
    NO_COLOR: "1",
    TERRABLOX_SEED_GITHUB_TOKEN: "",
    GITHUB_TOKEN: "",
    GH_TOKEN: "",
  };
  return { root, env, log: () => readFile(env.MOCK_LOG, "utf8") };
}

function interactive(root, env, answers) {
  const command = join(root, "scripts/quickstart.sh");
  const driver = `
import json, os, pty, select, sys

answers = json.loads(sys.argv[2])
pid, fd = pty.fork()
if pid == 0:
    os.execvp("bash", ["bash", sys.argv[1], "--no-dev"])
output = ""
index = 0
while True:
    select.select([fd], [], [])
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    sys.stdout.buffer.write(chunk)
    sys.stdout.buffer.flush()
    output += chunk.decode("utf-8", "replace")
    if index < len(answers) and answers[index][0] in output:
        os.write(fd, (answers[index][1] + "\\n").encode())
        index += 1
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "python3",
      ["-c", driver, command, JSON.stringify(answers)],
      {
        cwd: root,
        env,
      },
    );
    let output = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Quickstart timed out:\n${output}`));
    }, 15000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolvePromise({ code, output });
    });
  });
}

test("non-interactive setup skips optional work", async (t) => {
  const { root, env, log } = await fixture(t);
  const result = spawnSync("bash", ["scripts/quickstart.sh", "--no-dev"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /skipped \(not an interactive terminal\)/);
  assert.doesNotMatch(await log(), /cost-service|db:builtin:sync/);
});

interactiveTest(
  "interactive setup configures cost service and imports the catalogue",
  async (t) => {
    const { root, env, log } = await fixture(t);
    const result = await interactive(root, env, [
      ["Set or change the GitHub App slug?", "y"],
      ["New GitHub App slug:", "my-app"],
      ["Configure and start the local Cost Service?", "y"],
      ["Infracost token:", "test-infracost-token"],
      ["Import the shared Terrablox module catalogue?", "y"],
    ]);
    assert.equal(result.code, 0, result.output);
    const config = await readFile(join(root, ".env"), "utf8");
    assert.match(config, /GITHUB_APP_SLUG=my-app/);
    assert.match(
      config,
      /INFRACOST_CLI_AUTHENTICATION_TOKEN=test-infracost-token/,
    );
    assert.match(config, /COST_SERVICE_TOKEN=[A-Za-z0-9_-]{43}/);
    assert.match(config, /COST_SERVICE_URL=http:\/\/127\.0\.0\.1:8090/);
    assert.doesNotMatch(config, /test-github-token/);
    assert.match(await log(), /up -d --build cost-service/);
    assert.match(await log(), /pnpm db:builtin:sync/);
  },
);

interactiveTest(
  "existing self-hosted pricing settings and custom URL are preserved",
  async (t) => {
    const token = "existing-service-token-123456789012345";
    const { root, env, log } = await fixture(
      t,
      `INFRACOST_CLI_PRICING_ENDPOINT=https://pricing.example.com
INFRACOST_CLI_PRICING_API_KEY=existing-key
COST_SERVICE_TOKEN=${token}
COST_SERVICE_URL=http://custom.example.com
`,
    );
    const result = await interactive(root, env, [
      ["Set or change the GitHub App slug?", "n"],
      ["Configure and start the local Cost Service?", "y"],
      ["Import the shared Terrablox module catalogue?", "n"],
    ]);
    assert.equal(result.code, 0, result.output);
    const config = await readFile(join(root, ".env"), "utf8");
    assert.match(config, new RegExp(`COST_SERVICE_TOKEN=${token}`));
    assert.match(config, /COST_SERVICE_URL=http:\/\/custom\.example\.com/);
    assert.match(result.output, /existing value was preserved/);
    assert.doesNotMatch(await log(), /db:builtin:sync/);
  },
);

interactiveTest("empty Infracost credentials skip service setup", async (t) => {
  const { root, env, log } = await fixture(t);
  const result = await interactive(root, env, [
    ["Set or change the GitHub App slug?", "n"],
    ["Configure and start the local Cost Service?", "y"],
    ["Infracost token:", ""],
    ["Import the shared Terrablox module catalogue?", "n"],
  ]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /No Infracost credentials configured/);
  assert.doesNotMatch(await log(), /cost-service|db:builtin:sync/);
});

interactiveTest(
  "a failed requested import makes quickstart fail",
  async (t) => {
    const { root, env } = await fixture(t);
    const result = await interactive(root, { ...env, FAIL_SYNC: "1" }, [
      ["Set or change the GitHub App slug?", "n"],
      ["Configure and start the local Cost Service?", "n"],
      ["Import the shared Terrablox module catalogue?", "y"],
    ]);
    assert.notEqual(result.code, 0, result.output);
  },
);
