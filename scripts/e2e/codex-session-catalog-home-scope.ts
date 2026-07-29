/**
 * Live proof for the Codex session catalog's omitted homeScope behavior.
 *
 * Required environment:
 * - OPENCLAW_CODEX_CATALOG_PROOF_HEAD: exact git HEAD to bind
 * - OPENCLAW_CODEX_CATALOG_PROOF_ROOT: new retained artifact directory
 * - OPENCLAW_CODEX_CATALOG_PROOF_AUTH_FILE: source for disposable isolated auth copies
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { CodexAppServerClient } from "../../extensions/codex/src/app-server/client.js";
import type { CodexThreadStartResponse } from "../../extensions/codex/src/app-server/protocol.js";

const repoRoot = process.cwd();
const expectedHead = process.env.OPENCLAW_CODEX_CATALOG_PROOF_HEAD?.trim();
const runRoot = process.env.OPENCLAW_CODEX_CATALOG_PROOF_ROOT?.trim();
const nativeAuthFile =
  process.env.OPENCLAW_CODEX_CATALOG_PROOF_AUTH_FILE?.trim() ||
  path.join(process.env.HOME ?? "", ".codex", "auth.json");
assert(expectedHead, "OPENCLAW_CODEX_CATALOG_PROOF_HEAD is required");
assert(runRoot, "OPENCLAW_CODEX_CATALOG_PROOF_ROOT is required");

const codexBin = path.join(repoRoot, "node_modules", ".bin", "codex");
const isolatedHome = path.join(runRoot, "home");
const stateDir = path.join(runRoot, "state");
const configPath = path.join(stateDir, "openclaw.json");
const workspace = path.join(runRoot, "workspace");
const userCodexHome = path.join(isolatedHome, ".codex");
const agentCodexHome = path.join(stateDir, "agents", "main", "agent", "codex-home");
const gatewayLog = path.join(runRoot, "gateway.log");
const token = randomBytes(24).toString("hex");

type JsonRecord = Record<string, unknown>;
type NativeSeeder = {
  client: CodexAppServerClient;
  close: () => Promise<void>;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function runCommand(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
    }, options.timeoutMs ?? 30_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited ${code}: ${stderr.slice(-1_000)}`));
      }
    });
  });
}

async function startNativeSeeder(codexHome: string): Promise<NativeSeeder> {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.access(nativeAuthFile);
  const authFile = path.join(codexHome, "auth.json");
  await fs.copyFile(nativeAuthFile, authFile, fsSync.constants.COPYFILE_EXCL);
  let client: CodexAppServerClient | undefined;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      await client?.closeAndWait({ exitTimeoutMs: 5_000, forceKillDelayMs: 1_000 });
    } finally {
      await fs.rm(authFile, { force: true });
    }
  };
  try {
    await fs.chmod(authFile, 0o600);
    client = CodexAppServerClient.start({
      command: codexBin,
      args: ["app-server"],
      commandSource: "config",
      transport: "stdio",
      homeScope: "user",
      env: {
        HOME: isolatedHome,
        CODEX_HOME: codexHome,
        OPENCLAW_QA_PARENT_PID: String(process.pid),
      },
    });
    await client.initialize();
    return { client, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function seedNativeThread(seeder: NativeSeeder, codexHome: string): Promise<string> {
  const response = await seeder.client.request<CodexThreadStartResponse>(
    "thread/start",
    {
      cwd: workspace,
      approvalPolicy: "never",
      ephemeral: false,
      sandbox: "read-only",
      threadSource: "user",
    },
    { timeoutMs: 30_000 },
  );
  assert(response.thread.id, "thread/start returned no thread id");
  const turn = await seeder.client.request(
    "turn/start",
    {
      threadId: response.thread.id,
      input: [{ type: "text", text: "Reply exactly OK." }],
      effort: "low",
    },
    { timeoutMs: 30_000 },
  );
  let materialized = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const listed = await seeder.client.request(
      "thread/list",
      {
        archived: false,
        limit: 100,
        modelProviders: [],
        sortKey: "recency_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode"],
      },
      { timeoutMs: 30_000 },
    );
    materialized = listed.data.some((thread) => thread.id === response.thread.id);
    if (materialized) {
      break;
    }
    await delay(100);
  }
  assert(materialized, "native sentinel turn did not materialize");
  try {
    await seeder.client.request(
      "turn/interrupt",
      { threadId: response.thread.id, turnId: turn.turn.id },
      { timeoutMs: 30_000 },
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("no active turn to interrupt")) {
      throw error;
    }
  }
  await seeder.client.request(
    "thread/name/set",
    { threadId: response.thread.id, name: `home-scope-proof-${path.basename(codexHome)}` },
    { timeoutMs: 30_000 },
  );
  return response.thread.id;
}

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object");
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function gatewayConfig(port: number, allowWriteControls: boolean): JsonRecord {
  return {
    agents: { defaults: { workspace } },
    gateway: {
      mode: "local",
      port,
      bind: "loopback",
      auth: { mode: "token", token },
      controlUi: { enabled: false },
      reload: { mode: "hybrid" },
    },
    plugins: {
      enabled: true,
      allow: ["codex"],
      entries: {
        codex: {
          enabled: true,
          config: {
            sessionCatalog: { enabled: true },
            supervision: { enabled: true, allowWriteControls },
            appServer: { command: codexBin },
          },
        },
      },
    },
  };
}

async function writeConfig(config: JsonRecord): Promise<void> {
  const candidate = `${configPath}.next`;
  await fs.writeFile(candidate, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(candidate, configPath);
}

async function gatewayCall(
  port: number,
  gatewayEnv: NodeJS.ProcessEnv,
  method: string,
  params: JsonRecord = {},
): Promise<unknown> {
  const result = await runCommand(
    process.execPath,
    [
      "scripts/run-node.mjs",
      "gateway",
      "call",
      method,
      "--params",
      JSON.stringify(params),
      "--url",
      `ws://127.0.0.1:${port}`,
      "--token",
      token,
      "--json",
      "--timeout",
      "30000",
    ],
    { env: gatewayEnv, timeoutMs: 40_000 },
  );
  return JSON.parse(result.stdout) as unknown;
}

function catalogThreadIds(value: unknown): Set<string> {
  assert(isRecord(value) && Array.isArray(value.catalogs), "invalid catalog response");
  const catalog = value.catalogs.find(
    (entry) => isRecord(entry) && entry.id === "codex" && Array.isArray(entry.hosts),
  );
  assert(isRecord(catalog) && Array.isArray(catalog.hosts), "Codex catalog missing");
  const ids = new Set<string>();
  for (const host of catalog.hosts) {
    if (!isRecord(host) || !Array.isArray(host.sessions)) {
      continue;
    }
    for (const session of host.sessions) {
      if (isRecord(session) && typeof session.threadId === "string") {
        ids.add(session.threadId);
      }
    }
  }
  return ids;
}

function runtimeReloaded(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.config)) {
    return false;
  }
  const plugins = value.config.plugins;
  if (!isRecord(plugins) || !isRecord(plugins.entries)) {
    return false;
  }
  const codex = plugins.entries.codex;
  if (!isRecord(codex) || !isRecord(codex.config) || !isRecord(codex.config.supervision)) {
    return false;
  }
  return codex.config.supervision.allowWriteControls === true;
}

async function waitForGateway(
  gateway: ChildProcess,
  port: number,
  gatewayEnv: NodeJS.ProcessEnv,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    assert(gateway.exitCode === null, "Gateway exited before readiness");
    try {
      await gatewayCall(port, gatewayEnv, "health");
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error("Gateway readiness timed out");
}

async function waitForReload(port: number, gatewayEnv: NodeJS.ProcessEnv): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if (runtimeReloaded(await gatewayCall(port, gatewayEnv, "config.get"))) {
        return;
      }
    } catch {
      // Reload may briefly restart a connection owner.
    }
    await delay(250);
  }
  throw new Error("Gateway config reload timed out");
}

async function stopGateway(gateway: ChildProcess): Promise<void> {
  if (gateway.exitCode !== null) {
    return;
  }
  gateway.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => {
      gateway.once("exit", () => resolve());
    }),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        gateway.kill("SIGKILL");
        resolve();
      }, 5_000);
    }),
  ]);
}

await fs.mkdir(runRoot, { recursive: false });
await Promise.all([
  fs.mkdir(stateDir, { recursive: true }),
  fs.mkdir(workspace, { recursive: true }),
  fs.mkdir(isolatedHome, { recursive: true }),
]);

const head = (await runCommand("git", ["rev-parse", "HEAD"])).stdout.trim();
assert.equal(head, expectedHead, "proof HEAD mismatch");
const worktreeStatus = (
  await runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"])
).stdout.trim();
assert.equal(worktreeStatus, "", "proof requires a clean exact-HEAD worktree and index");
assert.equal((await runCommand(codexBin, ["--version"])).stdout.trim(), "codex-cli 0.146.0");

let userSeeder: NativeSeeder | undefined;
let agentSeeder: NativeSeeder | undefined;
let gateway: ChildProcess | undefined;
try {
  userSeeder = await startNativeSeeder(userCodexHome);
  agentSeeder = await startNativeSeeder(agentCodexHome);
  const userThreadId = await seedNativeThread(userSeeder, userCodexHome);
  const agentThreadId = await seedNativeThread(agentSeeder, agentCodexHome);
  assert.notEqual(userThreadId, agentThreadId);
  await agentSeeder.close();

  const port = await reservePort();
  await writeConfig(gatewayConfig(port, false));
  const gatewayEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: isolatedHome,
    OPENCLAW_HOME: isolatedHome,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_GATEWAY_TOKEN: token,
    OPENCLAW_QA_PARENT_PID: String(process.pid),
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
  };
  delete gatewayEnv.CODEX_HOME;

  const logFd = fsSync.openSync(gatewayLog, "a", 0o600);
  gateway = spawn(
    process.execPath,
    [
      "scripts/run-node.mjs",
      "gateway",
      "run",
      "--port",
      String(port),
      "--bind",
      "loopback",
      "--allow-unconfigured",
    ],
    {
      cwd: repoRoot,
      env: gatewayEnv,
      detached: false,
      stdio: ["ignore", logFd, logFd],
    },
  );
  fsSync.closeSync(logFd);

  await waitForGateway(gateway, port, gatewayEnv);
  const initialIds = catalogThreadIds(
    await gatewayCall(port, gatewayEnv, "sessions.catalog.list", {
      catalogId: "codex",
      limitPerHost: 100,
    }),
  );
  assert(initialIds.has(userThreadId), "native user-home sentinel missing before reload");
  assert(!initialIds.has(agentThreadId), "agent-home sentinel leaked before reload");

  const reloadedUserThreadId = await seedNativeThread(userSeeder, userCodexHome);
  const cachedIds = catalogThreadIds(
    await gatewayCall(port, gatewayEnv, "sessions.catalog.list", {
      catalogId: "codex",
      limitPerHost: 100,
    }),
  );
  assert(
    !cachedIds.has(reloadedUserThreadId),
    "new user-home sentinel bypassed the pre-reload catalog cache",
  );

  await writeConfig(gatewayConfig(port, true));
  await waitForReload(port, gatewayEnv);
  const reloadedIds = catalogThreadIds(
    await gatewayCall(port, gatewayEnv, "sessions.catalog.list", {
      catalogId: "codex",
      limitPerHost: 100,
    }),
  );
  assert(reloadedIds.has(userThreadId), "native user-home sentinel missing after reload");
  assert(reloadedIds.has(reloadedUserThreadId), "new user-home sentinel missing after reload");
  assert(!reloadedIds.has(agentThreadId), "agent-home sentinel leaked after reload");

  const fingerprint = (value: string) =>
    createHash("sha256").update(`isolated-proof:${value}`).digest("hex").slice(0, 16);
  process.stdout.write(
    `${JSON.stringify(
      {
        exact_head: head,
        test_runner: "none",
        gateway_registration: "real",
        plugin_schema_validation: "real",
        config_reload: "accepted",
        catalog_rpc: "sessions.catalog.list",
        user_sentinel_fingerprint: fingerprint(userThreadId),
        reload_user_sentinel_fingerprint: fingerprint(reloadedUserThreadId),
        agent_sentinel_fingerprint: fingerprint(agentThreadId),
        initial_user_sentinel_visible: true,
        initial_agent_sentinel_visible: false,
        pre_reload_cached_new_user_sentinel_visible: false,
        reloaded_user_sentinel_visible: true,
        reloaded_new_user_sentinel_visible: true,
        reloaded_agent_sentinel_visible: false,
        verdict: "PASS",
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (gateway) {
    await stopGateway(gateway);
  }
  await Promise.allSettled([userSeeder?.close(), agentSeeder?.close()]);
  await fs.rm(configPath, { force: true });
  const log = await fs.readFile(gatewayLog, "utf8").catch(() => "");
  if (log.includes(token)) {
    await fs.writeFile(gatewayLog, log.replaceAll(token, "[redacted]"), { mode: 0o600 });
  }
}
