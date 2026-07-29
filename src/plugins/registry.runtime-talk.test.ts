import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTalkSessionController } from "../talk/talk-session-controller.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";

function createRecord(id: string) {
  return createPluginRecord({
    id,
    source: `/plugins/${id}/index.js`,
    origin: "global",
    enabled: true,
    configSchema: false,
  });
}

describe("plugin Talk runtime", () => {
  it("exposes anonymous Talk activity", async () => {
    const registry = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createPluginRuntime(),
      activateGlobalSideEffects: false,
    });
    const config = {} as OpenClawConfig;
    const observer = registry.createApi(createRecord("avatar"), { config });
    const observed = vi.fn();

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
