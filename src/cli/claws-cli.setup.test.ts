import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  listConfiguredMcpServers: vi.fn(),
}));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../config/mcp-config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/mcp-config.js")>("../config/mcp-config.js")),
  listConfiguredMcpServers: mocks.listConfiguredMcpServers,
}));

const { runClawsAddCommand } = await import("./claws-cli.runtime.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createRuntime() {
  const logs: string[] = [];
  const runtime = {
    log: vi.fn((value: unknown) => logs.push(String(value))),
    error: vi.fn(),
    writeJson: vi.fn((value: unknown, space = 2) =>
      logs.push(JSON.stringify(value, null, space > 0 ? space : undefined)),
    ),
    writeStdout: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  } as unknown as RuntimeEnv;
  return { logs, runtime };
}

async function runAdd(
  source: string,
  options: Parameters<typeof runClawsAddCommand>[1],
  runtime: RuntimeEnv,
): Promise<void> {
  try {
    await runClawsAddCommand(source, options, runtime);
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith("__exit__:"))) {
      throw error;
    }
  }
}

async function writeSetupPackage(): Promise<{
  root: string;
  workspace: string;
  answersPath: string;
}> {
  const root = tempDirs.make("openclaw-claws-cli-setup-package-");
  await mkdir(join(root, "setup"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "@acme/setup-agent",
      version: "2.0.0",
      openclaw: { claw: "openclaw.claw.json" },
    }),
    "utf8",
  );
  await writeFile(
    join(root, "openclaw.claw.json"),
    JSON.stringify({
      schemaVersion: 2,
      agent: { id: "setup-agent" },
      setup: {
        inputs: [{ id: "principal_name", label: "Your name", type: "string", required: true }],
      },
      personalization: {
        seeds: [{ source: "setup/USER.md.tmpl", destination: "USER.md" }],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(root, "setup", "USER.md.tmpl"),
    "Name: {{ input.principal_name }}\n",
    "utf8",
  );
  const answersPath = join(root, "answers.json");
  await writeFile(answersPath, JSON.stringify({ principal_name: "Avery" }), "utf8");
  return { root, workspace: join(root, "target-workspace"), answersPath };
}

describe("claws add setup answers", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.listConfiguredMcpServers.mockResolvedValue({
      ok: true,
      path: "config",
      config: {},
      mcpServers: {},
    });
  });

  it("binds a local answers document into a version 2 dry-run without echoing values", async () => {
    const { root, workspace, answersPath } = await writeSetupPackage();
    const { logs, runtime } = createRuntime();

    await runAdd(root, { dryRun: true, workspace, answers: answersPath, json: true }, runtime);

    const output = logs[0] ?? "{}";
    expect(JSON.parse(output)).toMatchObject({
      manifestSchemaVersion: 2,
      blockers: [{ code: "setup_mutation_unavailable" }],
      setup: {
        valid: true,
        providedInputIds: ["principal_name"],
        seeds: [
          {
            destination: "USER.md",
            blocked: false,
            digest: expect.stringMatching(/^sha256:/),
          },
        ],
      },
    });
    expect(output).not.toContain("Avery");
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("rejects answers for a schema version 1 Claw", async () => {
    const root = tempDirs.make("openclaw-claws-cli-v1-");
    const manifestPath = join(root, "openclaw.claw.json");
    const answersPath = join(root, "answers.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ schemaVersion: 1, agent: { id: "demo-agent" } }),
      "utf8",
    );
    await writeFile(answersPath, "{}", "utf8");
    const { logs, runtime } = createRuntime();

    await runAdd(manifestPath, { dryRun: true, answers: answersPath, json: true }, runtime);

    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({
      valid: false,
      diagnostics: [{ code: "setup_answers_unsupported", path: "$.answers" }],
    });
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
