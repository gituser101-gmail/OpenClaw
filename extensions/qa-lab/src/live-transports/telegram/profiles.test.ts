import { describe, expect, it } from "vitest";
import { listTelegramQaScenarios, resolveTelegramQaScenarioIds } from "./scenario-selection.js";

describe("Telegram QA profiles", () => {
  it.each(["mock-openai", "live-frontier"] as const)(
    "keeps the default %s command on flow scenarios",
    (providerMode) => {
      const scenarioIds = resolveTelegramQaScenarioIds({ providerMode });

      expect(scenarioIds).toContain("telegram-other-bot-command-gating");
      expect(scenarioIds).not.toContain("telegram-startup-getme-live");
      expect(() =>
        resolveTelegramQaScenarioIds({
          providerMode,
          scenarioIds: ["telegram-startup-getme-live"],
        }),
      ).toThrow("execution.kind=flow");
    },
  );

  it("derives provider-specific release membership from taxonomy", () => {
    const live = resolveTelegramQaScenarioIds({ providerMode: "live-frontier" });
    const mock = resolveTelegramQaScenarioIds({ providerMode: "mock-openai" });

    expect(live).not.toContain("telegram-long-final-reuses-preview");
    expect(mock).toContain("telegram-long-final-reuses-preview");
    expect(mock).toContain("telegram-assistant-transcript-role-boundary");
  });

  it("selects every taxonomy-owned executable Telegram scenario through all", () => {
    const scenarioIds = resolveTelegramQaScenarioIds({
      providerMode: "mock-openai",
      profile: "all",
    });

    expect(scenarioIds).toContain("channel-message-flows");
    expect(scenarioIds).toContain("native-command-session-target");
  });

  it("lets explicit scenarios override profile selection", () => {
    expect(
      resolveTelegramQaScenarioIds({
        profile: "release",
        providerMode: "live-frontier",
        scenarioIds: ["telegram-help-command"],
      }),
    ).toEqual(["telegram-help-command"]);
  });

  it("rejects unknown profiles and channel-ineligible explicit scenarios", () => {
    expect(() =>
      resolveTelegramQaScenarioIds({ providerMode: "live-frontier", profile: "transport" }),
    ).toThrow("QA run profile must be one of");
    expect(() =>
      resolveTelegramQaScenarioIds({
        providerMode: "live-frontier",
        scenarioIds: ["channel-chat-baseline"],
      }),
    ).toThrow("cannot run ineligible scenario(s)");
  });

  it("lists catalog-eligible scenarios with provider-specific release defaults", () => {
    const scenarios = listTelegramQaScenarios({ providerMode: "mock-openai" });
    const defaultIds = new Set(resolveTelegramQaScenarioIds({ providerMode: "mock-openai" }));

    expect(
      new Set(scenarios.filter(({ defaultEnabled }) => defaultEnabled).map(({ id }) => id)),
    ).toEqual(defaultIds);
    expect(
      scenarios.find(({ id }) => id === "telegram-long-final-reuses-preview")?.defaultEnabled,
    ).toBe(true);
    expect(
      scenarios.find(({ id }) => id === "telegram-long-final-three-chunks")?.defaultEnabled,
    ).toBe(true);
    expect(scenarios.map(({ id }) => id)).not.toContain("telegram-startup-getme-live");
  });
});
