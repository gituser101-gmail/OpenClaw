import { describe, expect, it, vi } from "vitest";
import { watchTalkActivity } from "./activity.js";
import { createTalkSessionController } from "./talk-session-controller.js";

function createTalk(sessionId: string) {
  return createTalkSessionController({
    sessionId,
    mode: "realtime",
    transport: "gateway-relay",
    brain: "agent-consult",
  });
}

describe("Talk activity", () => {
  it("publishes anonymous lifecycle and speech activity", async () => {
    const events: Array<Record<string, unknown>> = [];
    const stop = watchTalkActivity((event) => {
      events.push(event);
    });
    const talk = createTalk("private-session-id");

    talk.emit({ type: "session.ready", payload: {} });
    const { turnId } = talk.startOutputAudio();
    talk.emit({ type: "output.audio.delta", turnId, payload: { transcript: "private" } });
    talk.finishOutputAudio({ turnId });
    talk.emit({ type: "session.closed", payload: {}, final: true });

    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("ended"));
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "state",
      "state",
      "speech",
      "state",
      "ended",
    ]);
    expect(new Set(events.map((event) => event.activityId)).size).toBe(1);
    expect(JSON.stringify(events)).not.toContain("private-session-id");
    expect(JSON.stringify(events)).not.toContain("private");
    stop();
  });

  it("stops publishing after unsubscribe and isolates watcher failures", async () => {
    const failing = watchTalkActivity(() => {
      throw new Error("plugin failure");
    });
    const listener = vi.fn();
    const stop = watchTalkActivity(listener);
    const talk = createTalk("activity-unsubscribe-test");

    expect(() => talk.emit({ type: "session.ready", payload: {} })).not.toThrow();
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    stop();
    failing();
    listener.mockClear();
    talk.emit({ type: "session.closed", payload: {}, final: true });
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it("preserves speaking across overlapping work and ends fatal errors", async () => {
    const events: Array<Record<string, unknown>> = [];
    const stop = watchTalkActivity((event) => {
      events.push(event);
    });
    const talk = createTalk("activity-reducer-test");

    talk.emit({ type: "session.started", payload: {} });
    talk.emit({ type: "session.ready", payload: {} });
    const { turnId } = talk.startTurn();
    talk.emit({ type: "input.audio.committed", turnId, payload: {}, final: true });
    talk.startOutputAudio({ turnId });
    talk.emit({ type: "tool.progress", turnId, payload: {} });
    talk.finishOutputAudio({ turnId });
    talk.emit({ type: "session.error", payload: {}, final: true });
    talk.emit({ type: "session.started", payload: {} });

    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === "started")).toHaveLength(2);
    });
    expect(events.filter((event) => event.type === "state").map((event) => event.state)).toEqual([
      "idle",
      "listening",
      "thinking",
      "speaking",
      "listening",
      "error",
      "idle",
    ]);
    expect(events.filter((event) => event.type === "ended")).toHaveLength(1);
    const activityIds = events
      .filter((event) => event.type === "started")
      .map((event) => event.activityId);
    expect(new Set(activityIds).size).toBe(2);
    stop();
  });

  it("returns to idle after cancelled capture and infers speaking from audio", async () => {
    const events: Array<Record<string, unknown>> = [];
    const stop = watchTalkActivity((event) => {
      events.push(event);
    });
    const talk = createTalk("activity-capture-test");

    talk.emit({ type: "session.started", payload: {} });
    talk.emit({ type: "capture.started", captureId: "capture-1", payload: {} });
    talk.emit({ type: "capture.cancelled", captureId: "capture-1", payload: {}, final: true });
    const { turnId } = talk.startTurn();
    talk.emit({ type: "output.audio.delta", turnId, payload: {} });

    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("speech"));
    expect(events.filter((event) => event.type === "state").map((event) => event.state)).toEqual([
      "idle",
      "listening",
      "idle",
      "listening",
      "speaking",
    ]);
    expect(events.slice(-2).map((event) => event.type)).toEqual(["state", "speech"]);
    stop();
  });
});
