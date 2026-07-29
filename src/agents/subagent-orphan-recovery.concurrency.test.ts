import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import {
  recoverOrphanedSubagentSessions as recoverOrphanedSubagentSessionsWithRuntime,
  resetSubagentOrphanRecoveryReceiptsForTest,
} from "./subagent-orphan-recovery.js";
import * as subagentRegistrySteerRuntime from "./subagent-registry-steer-runtime.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const dispatchAgent = vi.fn(async (_payload: Record<string, unknown>) => ({
  runId: "test-run-id",
}));
const readSessionMessages = vi.fn(async () => [] as unknown[]);
const gatewayRuntime: GatewayRecoveryRuntime = {
  dispatchAgent: dispatchAgent as GatewayRecoveryRuntime["dispatchAgent"],
  waitForAgent: vi.fn(),
  sendRecoveryNotice: vi.fn(),
};

const sessionMocks = vi.hoisted(() => {
  type MockSessionEntry = Record<string, unknown>;
  type MockSessionStore = Record<string, MockSessionEntry>;
  const loadSessionStore = vi.fn((_storePath?: string): MockSessionStore => ({}));
  return {
    loadSessionStore,
    resolveAgentIdFromSessionKey: vi.fn(() => "main"),
    resolveStorePath: vi.fn(() => "/tmp/test-sessions.json"),
    loadSessionEntry: vi.fn(
      (scope: { sessionKey: string }) => loadSessionStore()[scope.sessionKey],
    ),
    patchSessionEntry: vi.fn(
      async (
        scope: { sessionKey: string },
        update: (
          entry: MockSessionEntry,
        ) =>
          | MockSessionEntry
          | Partial<MockSessionEntry>
          | null
          | Promise<MockSessionEntry | Partial<MockSessionEntry> | null>,
        options: { replaceEntry?: boolean } = {},
      ) => {
        const store = loadSessionStore();
        const current = store[scope.sessionKey];
        if (!current) {
          return null;
        }
        const patch = await update({ ...current });
        if (!patch) {
          return current;
        }
        const next = options.replaceEntry ? patch : { ...current, ...patch };
        store[scope.sessionKey] = next;
        return next;
      },
    ),
  };
});

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({ session: { store: undefined } })),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: sessionMocks.loadSessionStore,
  resolveAgentIdFromSessionKey: sessionMocks.resolveAgentIdFromSessionKey,
  resolveStorePath: sessionMocks.resolveStorePath,
}));

vi.mock("../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: sessionMocks.loadSessionEntry,
  patchSessionEntry: sessionMocks.patchSessionEntry,
}));

vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: vi.fn(async () => ({ delivered: true, path: "direct" })),
  isInternalAnnounceRequesterSession: vi.fn(() => false),
  loadRequesterSessionEntry: vi.fn(() => ({ entry: {} })),
}));

vi.mock("./subagent-announce-origin.js", () => ({
  resolveAnnounceOrigin: vi.fn((entry, requesterOrigin) => requesterOrigin),
}));

vi.mock("./subagent-registry-steer-runtime.js", () => ({
  replaceSubagentRunAfterSteer: vi.fn(() => true),
  finalizeInterruptedSubagentRun: vi.fn(async () => 1),
  reserveSwarmCollectorLaunch: vi.fn(() => true),
}));

function recoverOrphanedSubagentSessions(
  params: Omit<
    Parameters<typeof recoverOrphanedSubagentSessionsWithRuntime>[0],
    "gatewayRuntime" | "readSessionMessages"
  >,
) {
  return recoverOrphanedSubagentSessionsWithRuntime({
    ...params,
    gatewayRuntime,
    readSessionMessages,
  });
}

function createInterruptedRun(
  generation = 1,
  interruptedAt = 1_000,
  runId = `run-${generation}`,
): SubagentRunRecord {
  return {
    runId,
    childSessionKey: "agent:main:subagent:test-session-1",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "restart-safe recovery",
    cleanup: "keep",
    createdAt: 500,
    startedAt: 600,
    generation,
    execution: { status: "interrupted", interruptedAt },
  };
}

function createActiveRuns(...runs: SubagentRunRecord[]) {
  return new Map(runs.map((run) => [run.runId, run] satisfies [string, SubagentRunRecord]));
}

function mockSingleAbortedSession() {
  const store = {
    "agent:main:subagent:test-session-1": {
      sessionId: "session-abc",
      updatedAt: 1_000,
      abortedLastRun: true,
    },
  };
  sessionMocks.loadSessionStore.mockReturnValue(store);
  return store;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

describe("subagent orphan recovery concurrency", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetGatewayWorkAdmission();
    resetSubagentOrphanRecoveryReceiptsForTest();
    dispatchAgent.mockReset();
    dispatchAgent.mockResolvedValue({ runId: "test-run-id" });
    readSessionMessages.mockReset();
    readSessionMessages.mockResolvedValue([]);
    vi.mocked(subagentRegistrySteerRuntime.replaceSubagentRunAfterSteer)
      .mockReset()
      .mockReturnValue(true);
    vi.mocked(subagentRegistrySteerRuntime.reserveSwarmCollectorLaunch)
      .mockReset()
      .mockReturnValue(true);
  });

  afterEach(() => {
    resetSubagentOrphanRecoveryReceiptsForTest();
    resetGatewayWorkAdmission();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the accepted generation fenced across Gateway replacement", async () => {
    mockSingleAbortedSession();
    const activeRuns = createActiveRuns(createInterruptedRun());
    vi.mocked(subagentRegistrySteerRuntime.replaceSubagentRunAfterSteer).mockImplementation(
      ({ previousRunId, nextRunId }) => {
        const previous = activeRuns.get(previousRunId);
        if (!previous) {
          return false;
        }
        activeRuns.delete(previousRunId);
        activeRuns.set(nextRunId, {
          ...previous,
          runId: nextRunId,
          generation: (previous.generation ?? 0) + 1,
          execution: { status: "running", startedAt: 2_000 },
        });
        return true;
      },
    );
    vi.mocked(sessionAccessor.patchSessionEntry)
      .mockRejectedValueOnce(new Error("write failed"))
      .mockRejectedValueOnce(new Error("write still failed"));
    dispatchAgent.mockResolvedValueOnce({ runId: "accepted-run" });
    await recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });

    const replacementDispatch = vi.fn(async (_payload: unknown) => ({
      runId: "replacement-run",
    }));
    const replacementRuntime: GatewayRecoveryRuntime = {
      dispatchAgent: replacementDispatch as GatewayRecoveryRuntime["dispatchAgent"],
      waitForAgent: vi.fn(),
      sendRecoveryNotice: vi.fn(),
    };
    const sameGeneration = await recoverOrphanedSubagentSessionsWithRuntime({
      gatewayRuntime: replacementRuntime,
      getActiveRuns: () => activeRuns,
      readSessionMessages,
    });
    expect(sameGeneration).toMatchObject({ recovered: 0, failed: 1, skipped: 1 });
    expect(replacementDispatch).not.toHaveBeenCalled();

    const accepted = activeRuns.get("accepted-run");
    if (!accepted) {
      throw new Error("accepted recovery run was not registered");
    }
    accepted.execution = { status: "interrupted", interruptedAt: 3_000 };
    const newerGeneration = await recoverOrphanedSubagentSessionsWithRuntime({
      gatewayRuntime: replacementRuntime,
      getActiveRuns: () => activeRuns,
      readSessionMessages,
    });

    expect(newerGeneration).toMatchObject({ recovered: 1, failed: 0, skipped: 0 });
    expect(replacementDispatch).toHaveBeenCalledOnce();
    expect(
      requireRecord(replacementDispatch.mock.calls[0]?.[0], "replacement dispatch").idempotencyKey,
    ).not.toBe(requireRecord(dispatchAgent.mock.calls[0]?.[0], "initial dispatch").idempotencyKey);
  });

  it.each([
    ["same generation", false],
    ["newer interruption", true],
  ])("coordinates an in-flight transcript claim for the %s", async (_label, newer) => {
    mockSingleAbortedSession();
    const activeRuns = createActiveRuns(createInterruptedRun());
    let releaseTranscript: (() => void) | undefined;
    readSessionMessages.mockImplementationOnce(
      async () =>
        await new Promise<unknown[]>((resolve) => {
          releaseTranscript = () => resolve([]);
        }),
    );

    const staleScan = recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });
    await vi.waitFor(() => expect(readSessionMessages).toHaveBeenCalledOnce());
    if (newer) {
      activeRuns.set("run-2", createInterruptedRun(2, 2_000));
      // The superseded transcript owner must stand down even when the newer
      // dispatch cannot clear its abort marker.
      vi.mocked(sessionAccessor.patchSessionEntry).mockRejectedValueOnce(
        new Error("marker write failed"),
      );
    }

    const overlap = await recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });
    releaseTranscript?.();
    const staleResult = await staleScan;

    expect(newer ? overlap.recovered : overlap.skipped).toBe(1);
    expect(newer ? staleResult.skipped : staleResult.recovered).toBe(1);
    expect(dispatchAgent).toHaveBeenCalledOnce();
  });

  it("blocks a newer generation while Gateway admission is in flight", async () => {
    const store = mockSingleAbortedSession();
    const activeRuns = createActiveRuns(createInterruptedRun());
    let resolveDispatch: ((value: { runId: string }) => void) | undefined;
    dispatchAgent.mockImplementationOnce(
      async () =>
        await new Promise<{ runId: string }>((resolve) => {
          resolveDispatch = resolve;
        }),
    );

    const first = recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });
    await vi.waitFor(() => expect(dispatchAgent).toHaveBeenCalledOnce());
    activeRuns.set("run-2", createInterruptedRun(2, 2_000));
    store["agent:main:subagent:test-session-1"].updatedAt = 2_000;
    const overlap = await recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });

    expect(overlap).toMatchObject({ recovered: 0, failed: 0, skipped: 2 });
    expect(dispatchAgent).toHaveBeenCalledOnce();
    resolveDispatch?.({ runId: "accepted-run" });
    await expect(first).resolves.toMatchObject({ recovered: 1, failed: 0 });
    expect(store["agent:main:subagent:test-session-1"].abortedLastRun).toBe(true);

    const newer = await recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });
    expect(newer).toMatchObject({ recovered: 1, failed: 0, skipped: 1 });
    expect(dispatchAgent).toHaveBeenCalledTimes(2);
    expect(store["agent:main:subagent:test-session-1"].abortedLastRun).toBe(false);
  });

  it("does not let a superseded accepted receipt settle a newer generation", async () => {
    const store = mockSingleAbortedSession();
    const activeRuns = createActiveRuns(createInterruptedRun());
    const patchSessionEntry = vi.mocked(sessionAccessor.patchSessionEntry);
    const patchImplementation = patchSessionEntry.getMockImplementation();
    if (!patchImplementation) {
      throw new Error("patchSessionEntry mock implementation missing");
    }
    let releaseFirstSettlement: (() => void) | undefined;
    let markFirstSettlementStarted: (() => void) | undefined;
    const firstSettlementStarted = new Promise<void>((resolve) => {
      markFirstSettlementStarted = resolve;
    });
    patchSessionEntry.mockImplementationOnce(
      async (...args: Parameters<typeof sessionAccessor.patchSessionEntry>) => {
        markFirstSettlementStarted?.();
        await new Promise<void>((resolve) => {
          releaseFirstSettlement = resolve;
        });
        return await patchImplementation(...args);
      },
    );
    let resolveNewerDispatch: ((value: { runId: string }) => void) | undefined;
    dispatchAgent.mockResolvedValueOnce({ runId: "accepted-run-1" }).mockImplementationOnce(
      async () =>
        await new Promise<{ runId: string }>((resolve) => {
          resolveNewerDispatch = resolve;
        }),
    );

    const first = recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });
    await firstSettlementStarted;
    const originalRun = activeRuns.get("run-1");
    if (!originalRun) {
      throw new Error("original interrupted run missing");
    }
    // Retain both generations and visit the newer owner first.
    activeRuns.clear();
    activeRuns.set("run-2", createInterruptedRun(2, 2_000));
    activeRuns.set("run-1", originalRun);
    const newer = recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });
    await vi.waitFor(() => expect(dispatchAgent).toHaveBeenCalledTimes(2));

    releaseFirstSettlement?.();
    await expect(first).resolves.toMatchObject({ recovered: 1, failed: 0 });
    expect(store["agent:main:subagent:test-session-1"].abortedLastRun).toBe(true);
    resolveNewerDispatch?.({ runId: "accepted-run-2" });
    await expect(newer).resolves.toMatchObject({ recovered: 1, failed: 0, skipped: 1 });
    expect(store["agent:main:subagent:test-session-1"].abortedLastRun).toBe(false);
  });
});
