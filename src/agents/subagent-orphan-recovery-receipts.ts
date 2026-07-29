import type { SessionEntry } from "../config/sessions.js";
import { patchSessionEntry } from "../config/sessions/session-accessor.js";
import { markSubagentRecoveryAttempt } from "./subagent-recovery-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type RunIdentity = Pick<SubagentRunRecord, "runId" | "generation"> & {
  interruptedAt: number | undefined;
};

export type OrphanRecoveryReceipt = {
  idempotencyKey: string;
  marker: Pick<SessionEntry, "sessionId" | "updatedAt">;
  source: RunIdentity;
  accepted?: RunIdentity;
  attempt: number;
  state: "preparing" | "inflight" | "accepted";
};

// Accepted receipts survive marker-write failure and Gateway replacement. A
// later recovery must prove a newer interrupted generation before redispatch.
const receipts = new Map<string, OrphanRecoveryReceipt>();

function identity(run: SubagentRunRecord): RunIdentity {
  return {
    runId: run.runId,
    generation: run.generation,
    interruptedAt: run.execution?.interruptedAt,
  };
}

function hasNewerInterruption(run: SubagentRunRecord, receipt: OrphanRecoveryReceipt): boolean {
  const interruptedAt = run.execution?.interruptedAt;
  if (interruptedAt === undefined) {
    return false;
  }
  const sameGeneration = [receipt.source, receipt.accepted].find(
    (item) => item && item.runId === run.runId && item.generation === run.generation,
  );
  if (sameGeneration) {
    return interruptedAt !== sameGeneration.interruptedAt;
  }
  const generations = [receipt.source.generation, receipt.accepted?.generation].filter(
    (value): value is number => value !== undefined,
  );
  if (run.generation !== undefined && generations.length > 0) {
    return run.generation > Math.max(...generations);
  }
  const interruptions = [receipt.source.interruptedAt, receipt.accepted?.interruptedAt].filter(
    (value): value is number => value !== undefined,
  );
  return interruptions.length > 0 && interruptedAt > Math.max(...interruptions);
}

export function getOrphanRecoveryReceipt(childSessionKey: string) {
  return receipts.get(childSessionKey);
}

export function createOrphanRecoveryReceipt(params: {
  childSessionKey: string;
  entry: SessionEntry;
  run: SubagentRunRecord;
  attempt: number;
}): OrphanRecoveryReceipt {
  const source = identity(params.run);
  const receipt: OrphanRecoveryReceipt = {
    // A retry of the same interrupted generation must hit Gateway dedupe even
    // when the first RPC timed out after acceptance.
    idempotencyKey: [
      "subagent-recovery",
      source.runId,
      source.generation ?? "legacy",
      source.interruptedAt ?? "unknown",
    ].join(":"),
    marker: { sessionId: params.entry.sessionId, updatedAt: params.entry.updatedAt },
    source,
    attempt: params.attempt,
    state: "preparing",
  };
  receipts.set(params.childSessionKey, receipt);
  return receipt;
}

export function orphanRecoveryReceiptBlocksRun(params: {
  receipt: OrphanRecoveryReceipt;
  run: SubagentRunRecord;
}): boolean {
  // Once Gateway admission is in flight, replacing the owner could dispatch
  // both generations before either caller observes the RPC result.
  if (params.receipt.state === "inflight") {
    return true;
  }
  if (hasNewerInterruption(params.run, params.receipt)) {
    return false;
  }
  return true;
}

function matchesOrphanRecoveryReceiptMarker(
  entry: SessionEntry,
  receipt: OrphanRecoveryReceipt,
): boolean {
  return (
    entry.abortedLastRun === true &&
    entry.sessionId === receipt.marker.sessionId &&
    entry.updatedAt === receipt.marker.updatedAt
  );
}

function matchesOrphanRecoveryReceiptSource(
  run: SubagentRunRecord,
  receipt: OrphanRecoveryReceipt,
): boolean {
  return (
    run.runId === receipt.source.runId &&
    run.generation === receipt.source.generation &&
    run.execution?.interruptedAt === receipt.source.interruptedAt
  );
}

export function beginOrphanRecoveryReceiptDispatch(params: {
  childSessionKey: string;
  entry: SessionEntry;
  run: SubagentRunRecord;
  receipt: OrphanRecoveryReceipt;
}): boolean {
  if (
    receipts.get(params.childSessionKey) !== params.receipt ||
    params.receipt.state !== "preparing" ||
    !matchesOrphanRecoveryReceiptMarker(params.entry, params.receipt) ||
    !matchesOrphanRecoveryReceiptSource(params.run, params.receipt)
  ) {
    return false;
  }
  params.receipt.state = "inflight";
  return true;
}

export function markOrphanRecoveryReceiptAccepted(params: {
  childSessionKey: string;
  receipt: OrphanRecoveryReceipt;
  runId: string;
  run?: SubagentRunRecord;
}): boolean {
  if (
    receipts.get(params.childSessionKey) !== params.receipt ||
    params.receipt.state !== "inflight"
  ) {
    return false;
  }
  const { receipt, runId, run } = params;
  receipt.accepted = run
    ? identity(run)
    : { runId, generation: undefined, interruptedAt: undefined };
  receipt.state = "accepted";
  return true;
}

export function releaseOrphanRecoveryReceipt(
  childSessionKey: string,
  receipt: OrphanRecoveryReceipt,
): void {
  if (receipts.get(childSessionKey) === receipt) {
    receipts.delete(childSessionKey);
  }
}

export function pruneAcceptedOrphanRecoveryReceipts(
  activeRuns: Map<string, SubagentRunRecord>,
): void {
  const activeChildren = new Set([...activeRuns.values()].map((run) => run.childSessionKey));
  for (const [childSessionKey, receipt] of receipts) {
    if (receipt.state === "accepted" && !activeChildren.has(childSessionKey)) {
      receipts.delete(childSessionKey);
    }
  }
}

export async function settleAcceptedOrphanRecoveryReceipt(params: {
  childSessionKey: string;
  storePath: string;
  receipt: OrphanRecoveryReceipt;
}): Promise<void> {
  let matched = false;
  await patchSessionEntry(
    { storePath: params.storePath, sessionKey: params.childSessionKey },
    (current) => {
      // The accepted dispatch only owns the exact abort marker it observed.
      if (
        receipts.get(params.childSessionKey) !== params.receipt ||
        params.receipt.state !== "accepted" ||
        !matchesOrphanRecoveryReceiptMarker(current, params.receipt)
      ) {
        return null;
      }
      matched = true;
      current.abortedLastRun = false;
      markSubagentRecoveryAttempt({
        entry: current,
        now: Date.now(),
        runId: params.receipt.source.runId,
        attempt: params.receipt.attempt,
      });
      current.updatedAt = Date.now();
      return current;
    },
    { replaceEntry: true, skipMaintenance: true },
  );
  if (matched) {
    releaseOrphanRecoveryReceipt(params.childSessionKey, params.receipt);
  }
}

export function resetSubagentOrphanRecoveryReceiptsForTest(): void {
  receipts.clear();
}
