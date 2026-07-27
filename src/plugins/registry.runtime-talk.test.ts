import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTalkSessionController } from "../talk/talk-session-controller.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";

function createRecord(id: string, options: { declareProcessWideActivity?: boolean } = {}) {
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
  return record;
}

describe("plugin Talk runtime scope", () => {
  it("requires a dedicated operator grant in addition to the manifest declaration", async () => {
    const registry = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createPluginRuntime(),
      activateGlobalSideEffects: false,
    });
    const observer = registry.createApi(
      createRecord("avatar", {
        declareProcessWideActivity: true,
      }),
      {
        config: {
          plugins: {
            entries: {
              avatar: { talk: { allowProcessWideActivityObservation: true } },
            },
          },
        },
      },
    );
    const selfDeclared = registry.createApi(
      createRecord("self-declared", { declareProcessWideActivity: true }),
      { config: {} as OpenClawConfig },
    );
    const grantedButUndeclared = registry.createApi(createRecord("undeclared"), {
      config: {
        plugins: {
          entries: {
            undeclared: { talk: { allowProcessWideActivityObservation: true } },
          },
        },
      },
    });
    const observed = vi.fn();

    expect(() => grantedButUndeclared.runtime.talk.onActivity(vi.fn())).toThrow(
      'Plugin "undeclared" must declare contracts.talkActivityObservation: ["process-wide"]',
    );
    expect(() => selfDeclared.runtime.talk.onActivity(vi.fn())).toThrow(
      "plugins.entries.self-declared.talk.allowProcessWideActivityObservation: true",
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
