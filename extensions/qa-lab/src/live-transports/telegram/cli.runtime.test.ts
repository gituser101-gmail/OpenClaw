import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  listTelegramQaScenarios,
  printLiveTransportQaArtifacts,
  resolveTelegramQaScenarioIds,
  runQaFlowSuiteFromRuntime,
} = vi.hoisted(() => ({
  listTelegramQaScenarios: vi.fn(),
  printLiveTransportQaArtifacts: vi.fn(),
  resolveTelegramQaScenarioIds: vi.fn(),
  runQaFlowSuiteFromRuntime: vi.fn(),
}));

vi.mock("../../suite-launch.runtime.js", () => ({ runQaFlowSuiteFromRuntime }));
vi.mock("../shared/live-artifacts.js", () => ({ printLiveTransportQaArtifacts }));
vi.mock("./scenario-selection.js", () => ({
  listTelegramQaScenarios,
  resolveTelegramQaScenarioIds,
}));

import { runQaTelegramCommand, runQaTelegramSuite } from "./cli.runtime.js";

const SUT_COMMAND_ENV = "OPENCLAW_QA_TELEGRAM_SUT_OPENCLAW_COMMAND";

describe("Telegram QA CLI runtime selection", () => {
  const originalSutCommand = process.env[SUT_COMMAND_ENV];

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env[SUT_COMMAND_ENV];
    listTelegramQaScenarios.mockReturnValue([]);
    resolveTelegramQaScenarioIds.mockReturnValue(["telegram-help-command"]);
    runQaFlowSuiteFromRuntime.mockResolvedValue({
      reportPath: "/tmp/telegram-report.md",
      summaryPath: "/tmp/telegram-summary.json",
    });
  });

  afterAll(() => {
    if (originalSutCommand === undefined) {
      delete process.env[SUT_COMMAND_ENV];
    } else {
      process.env[SUT_COMMAND_ENV] = originalSutCommand;
    }
  });

  it("lists scenarios against the exact requested model", async () => {
    await runQaTelegramSuite({
      listScenarios: true,
      primaryModel: "openai/custom-list-model",
      providerMode: "live-frontier",
    });

    expect(listTelegramQaScenarios).toHaveBeenCalledWith({
      primaryModel: "openai/custom-list-model",
      providerMode: "live-frontier",
    });
  });

  it("selects scenarios against the exact requested model before suite startup", async () => {
    await runQaTelegramCommand({
      allowFailures: true,
      primaryModel: "openai/custom-selection-model",
      providerMode: "live-frontier",
    });

    expect(resolveTelegramQaScenarioIds).toHaveBeenCalledWith({
      profile: undefined,
      primaryModel: "openai/custom-selection-model",
      providerMode: "live-frontier",
      scenarioIds: undefined,
    });
    expect(runQaFlowSuiteFromRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ primaryModel: "openai/custom-selection-model" }),
    );
  });
});
