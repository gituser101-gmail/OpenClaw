// OpenCode doctor contract covers retired hy3-free free-tier recovery.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

function readPathForTest(root: unknown, path: readonly string[]): unknown {
  let current = root;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

describe("OpenCode doctor contract", () => {
  it("detects and migrates retired opencode/hy3-free agent refs without changing other settings", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "opencode/hy3-free",
            fallbacks: ["opencode/gpt-5.6-sol", "opencode/hy3-free@work"],
          },
          models: {
            "opencode/hy3-free": { alias: "old free hy3" },
            "opencode/gpt-5.6-sol": {},
          },
        },
        list: [
          { id: "main", model: "opencode/hy3-free" },
          { id: "other", model: { primary: "opencode/claude-opus-5" } },
        ],
      },
      models: {
        providers: {
          opencode: {
            baseUrl: "https://opencode.ai/zen/v1",
            models: [
              { id: "hy3-free", name: "stale free row" },
              { id: "laguna-s-2.1-free", name: "Laguna S 2.1 Free" },
              { id: "custom-row", name: "keep me" },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      legacyConfigRules.filter((rule) => rule.match(readPathForTest(config, rule.path))),
    ).toHaveLength(3);

    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.config).not.toBe(config);
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.config.agents?.defaults?.model).toEqual({
      primary: "opencode/laguna-s-2.1-free",
      fallbacks: ["opencode/gpt-5.6-sol", "opencode/laguna-s-2.1-free@work"],
    });
    expect(result.config.agents?.defaults?.models).toEqual({
      "opencode/laguna-s-2.1-free": { alias: "old free hy3" },
      "opencode/gpt-5.6-sol": {},
    });
    expect(result.config.agents?.list).toEqual([
      { id: "main", model: "opencode/laguna-s-2.1-free" },
      { id: "other", model: { primary: "opencode/claude-opus-5" } },
    ]);
    expect(result.config.models?.providers?.opencode?.models).toEqual([
      { id: "laguna-s-2.1-free", name: "Laguna S 2.1 Free" },
      { id: "custom-row", name: "keep me" },
    ]);
    expect(config.agents?.defaults?.model).toEqual({
      primary: "opencode/hy3-free",
      fallbacks: ["opencode/gpt-5.6-sol", "opencode/hy3-free@work"],
    });
    expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
      config: result.config,
      changes: [],
    });
  });

  it("keeps an existing replacement models map entry when both keys are present", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "opencode/hy3-free": { alias: "retired" },
            "opencode/laguna-s-2.1-free": { alias: "keep" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = normalizeCompatibilityConfig({ cfg: config });
    expect(result.config.agents?.defaults?.models).toEqual({
      "opencode/laguna-s-2.1-free": { alias: "keep" },
    });
    expect(result.changes.some((change) => change.includes("kept existing"))).toBe(true);
  });

  it("leaves active OpenCode free-tier selections unchanged", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "opencode/laguna-s-2.1-free" },
          models: {
            "opencode/ling-3.0-flash-free": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(normalizeCompatibilityConfig({ cfg: config })).toEqual({ config, changes: [] });
  });

  it("rewrites bare-string defaults, list maps, subagents, and modelPolicy allow lists", () => {
    const config = {
      agents: {
        defaults: {
          model: "opencode/hy3-free",
          subagents: { model: "opencode/hy3-free@team" },
          modelPolicy: { allow: ["opencode/hy3-free", "opencode/gpt-5.6-sol"] },
        },
        list: [
          {
            id: "worker",
            models: {
              "opencode/hy3-free": { alias: "old" },
            },
          },
        ],
      },
    } as unknown as OpenClawConfig;

    const result = normalizeCompatibilityConfig({ cfg: config });
    expect(result.config.agents?.defaults?.model).toBe("opencode/laguna-s-2.1-free");
    expect(result.config.agents?.defaults?.subagents).toEqual({
      model: "opencode/laguna-s-2.1-free@team",
    });
    expect(result.config.agents?.defaults?.modelPolicy).toEqual({
      allow: ["opencode/laguna-s-2.1-free", "opencode/gpt-5.6-sol"],
    });
    expect(result.config.agents?.list?.[0]).toEqual({
      id: "worker",
      models: {
        "opencode/laguna-s-2.1-free": { alias: "old" },
      },
    });
  });
});
