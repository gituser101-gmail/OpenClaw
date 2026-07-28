/**
 * CLI loopback grant-context tests for the fallback delegation gate.
 */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildCliMcpGrantContext } from "./mcp-grant-context.js";
import type { RunCliAgentParams } from "./types.js";

function buildContext(run: Partial<RunCliAgentParams>) {
  return buildCliMcpGrantContext({
    run: {
      provider: "gemini",
      timeoutMs: 60_000,
      sessionKey: "agent:main:direct:test",
      workspaceDir: "/workspace",
      ...run,
    } as RunCliAgentParams,
    config: {} as OpenClawConfig,
    requireExplicitMessageTarget: false,
    agentId: "main",
    modelProvider: "google",
    modelId: "gemini-3.1-pro-preview",
  });
}

describe("buildCliMcpGrantContext delegationCapability", () => {
  it("stamps a report-only capability into the minted grant", () => {
    expect(buildContext({ delegationCapability: "report_only" })).toMatchObject({
      delegationCapability: "report_only",
    });
  });

  it("leaves the grant shape untouched for ordinary runs", () => {
    // Primary attempts must produce byte-identical grant contexts, so the key
    // is absent rather than explicitly "full".
    expect(buildContext({})).not.toHaveProperty("delegationCapability");
    expect(buildContext({ delegationCapability: "full" })).toMatchObject({
      delegationCapability: "full",
    });
  });
});
