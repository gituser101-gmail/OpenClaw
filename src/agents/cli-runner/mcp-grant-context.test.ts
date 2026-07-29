import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildCliMcpGrantContext } from "./mcp-grant-context.js";
import type { RunCliAgentParams } from "./types.js";

function buildContext(inputProvenance?: RunCliAgentParams["inputProvenance"]) {
  return buildCliMcpGrantContext({
    run: {
      sessionId: "session-1",
      sessionKey: "agent:worker:main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      prompt: "test",
      provider: "native-cli",
      timeoutMs: 1_000,
      runId: "run-1",
      senderIsOwner: true,
      inputProvenance,
    },
    config: {} as OpenClawConfig,
    requireExplicitMessageTarget: false,
    agentId: "worker",
    modelProvider: "native-cli",
    modelId: "test-model",
  });
}

describe("buildCliMcpGrantContext sessions_send A2A guard", () => {
  it("marks sessions_send target turns for loopback tool filtering", () => {
    expect(
      buildContext({
        kind: "inter_session",
        sourceSessionKey: "agent:main:main",
        sourceTool: "sessions_send",
      }).interAgentSendTurn,
    ).toBe(true);
  });

  it("does not mark requester delivery-failure recovery turns", () => {
    expect(
      buildContext({
        kind: "inter_session",
        sourceSessionKey: "agent:worker:main",
        sourceTool: "sessions_send_delivery_failure",
      }).interAgentSendTurn,
    ).toBeUndefined();
  });
});
