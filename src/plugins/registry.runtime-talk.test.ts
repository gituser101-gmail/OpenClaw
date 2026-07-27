import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTalkSessionController } from "../talk/talk-session-controller.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";

function createRecord(id: string, observeProcessWideActivity: boolean) {
  return createPluginRecord({
    id,
    source: `/plugins/${id}/index.js`,
    origin: "global",
    enabled: true,
    configSchema: false,
    ...(observeProcessWideActivity
      ? { contracts: { talkActivityObservation: ["process-wide"] } }
      : {}),
  });
}

describe("plugin Talk runtime scope", () => {
  it("blocks an unrelated plugin without the process-wide observation entitlement", async () => {
    const registry = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createPluginRuntime(),
      activateGlobalSideEffects: false,
    });
    const config = {} as OpenClawConfig;
    const observer = registry.createApi(createRecord("avatar", true), { config });
    const unrelated = registry.createApi(createRecord("unrelated", false), { config });
    const observed = vi.fn();

    expect(() => unrelated.runtime.talk.onActivity(vi.fn())).toThrow(
      'Plugin "unrelated" must declare contracts.talkActivityObservation: ["process-wide"]',
    );

    const stop = observer.runtime.talk.onActivity(observed);
    const talk = createTalkSessionController({
      sessionId: "private-session",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
    });
    talk.emit({ type: "session.ready", payload: {} });

    await vi.waitFor(() => expect(observed).toHaveBeenCalled());
    stop();
  });
});
