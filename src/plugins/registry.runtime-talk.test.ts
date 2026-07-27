import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTalkSessionController } from "../talk/talk-session-controller.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";

function createRecord(
  id: string,
  options: { declareProcessWideActivity?: boolean; explicitlyEnabled?: boolean } = {},
) {
  const record = createPluginRecord({
    id,
    source: `/plugins/${id}/index.js`,
    origin: "global",
    enabled: true,
    configSchema: false,
    ...(options.declareProcessWideActivity
      ? { contracts: { talkActivityObservation: ["process-wide"] } }
      : {}),
  });
  record.explicitlyEnabled = options.explicitlyEnabled ?? false;
  return record;
}

describe("plugin Talk runtime scope", () => {
  it("requires trusted operator approval in addition to the manifest declaration", async () => {
    const registry = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createPluginRuntime(),
      activateGlobalSideEffects: false,
    });
    const config = {} as OpenClawConfig;
    const observer = registry.createApi(
      createRecord("avatar", {
        declareProcessWideActivity: true,
        explicitlyEnabled: true,
      }),
      { config },
    );
    const selfDeclared = registry.createApi(
      createRecord("self-declared", { declareProcessWideActivity: true }),
      { config },
    );
    const unrelated = registry.createApi(createRecord("unrelated"), { config });
    const observed = vi.fn();

    expect(() => unrelated.runtime.talk.onActivity(vi.fn())).toThrow(
      'Plugin "unrelated" must declare contracts.talkActivityObservation: ["process-wide"]',
    );
    expect(() => selfDeclared.runtime.talk.onActivity(vi.fn())).toThrow(
      'Plugin "self-declared" must be explicitly enabled by the operator',
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
