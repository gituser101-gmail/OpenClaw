/** Dispatches isolated cron output to direct delivery, mirrors, and follow-up queues. */
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import {
  appendAdmittedDirectCronDeliveryTranscriptMirror,
  type DirectCronTranscriptMirror,
  queueCronMessageToolDeliveryAwareness,
} from "./delivery-dispatch-awareness.js";
import { deliverCronDirectAndCleanup } from "./delivery-dispatch-direct.js";
import {
  cleanupDirectCronSession,
  loadDeliverySubagentRegistryRuntime,
  logCronDeliveryWarn,
  normalizeSilentReplyText,
  resolveCronDeliveryBestEffort,
} from "./delivery-dispatch-policy.js";
import type {
  DispatchCronDeliveryParams,
  DispatchCronDeliveryState,
  SuccessfulCronDeliveryTarget,
} from "./delivery-dispatch-types.js";
import { pickSummaryFromOutput } from "./helpers.js";
import type { RunCronAgentTurnResult } from "./run.types.js";
import {
  cleanupCronRunSessionAfterRun,
  type CronRunSessionCleanupOutcome,
} from "./session-cleanup.js";
import { expectsSubagentFollowup, isLikelyInterimCronMessage } from "./subagent-followup-hints.js";

async function creditCronRequesterConsumedDescendants(params: {
  requesterSessionKey: string;
  runStartedAt: number;
  runIds: readonly string[];
  loadRuntime: () => Promise<{
    markDescendantCompletionConsumedByRequester(credit: {
      requesterSessionKey: string;
      runStartedAt: number;
      runIds: readonly string[];
    }): unknown;
  }>;
  logWarn: (message: string) => Promise<void>;
  jobId: string;
}): Promise<void> {
  const runIds = normalizeUniqueStringEntries(params.runIds);
  if (runIds.length === 0) {
    return;
  }
  try {
    const subagentRegistryRuntime = await params.loadRuntime();
    subagentRegistryRuntime.markDescendantCompletionConsumedByRequester({
      requesterSessionKey: params.requesterSessionKey,
      runStartedAt: params.runStartedAt,
      runIds,
    });
  } catch (err) {
    await params.logWarn(
      `[cron:${params.jobId}] failed to credit requester-consumed descendant completions (bestEffort): ${formatErrorMessage(err)}`,
    );
  }
}

const subagentFollowupRuntimeLoader = createLazyImportLoader(
  () => import("./subagent-followup.runtime.js"),
);
async function loadSubagentFollowupRuntime(): Promise<
  typeof import("./subagent-followup.runtime.js")
> {
  return await subagentFollowupRuntimeLoader.load();
}

export {
  cleanupDirectCronSession,
  queueCronMessageToolDeliveryAwareness,
  resolveCronDeliveryBestEffort,
};
/** Dispatches cron run output through verified message-tool or direct delivery paths. */
export async function dispatchCronDelivery(
  params: DispatchCronDeliveryParams,
): Promise<DispatchCronDeliveryState> {
  const sourceDeliverySatisfied = params.sourceDeliveryOutcome.satisfiesSourceDelivery;
  const verifiedMessageToolDelivery = params.sourceDeliveryOutcome.verifiedMessageToolDelivery;
  let summary = params.summary;
  let outputText = params.outputText;
  let synthesizedText = params.synthesizedText;
  let deliveryPayloads = params.deliveryPayloads;

  let delivered = verifiedMessageToolDelivery;
  let deliveryAttempted = verifiedMessageToolDelivery;
  let deliveryError: string | undefined;
  let directCronSessionCleanupAttempted = false;
  let deferredDeletingSessionMirror: DirectCronTranscriptMirror | undefined;
  const buildDeliveryState = (result?: RunCronAgentTurnResult): DispatchCronDeliveryState => ({
    ...(result ? { result } : {}),
    delivered,
    deliveryAttempted,
    ...(deliveryError ? { deliveryError } : {}),
    cronRunSessionCleanupAttempted: directCronSessionCleanupAttempted,
    summary,
    outputText,
    synthesizedText,
    deliveryPayloads,
  });
  const formatDeliveryTargetError = (error: string) =>
    params.sourceDeliveryOutcome.unverifiedMessageToolDelivery
      ? `${error}; the agent used the message tool, but OpenClaw could not verify that message matched the cron delivery target`
      : error;
  const failDeliveryTarget = (error: string) =>
    params.withRunSession({
      status: "error",
      error: formatDeliveryTargetError(error),
      errorKind: "delivery-target",
      summary,
      outputText,
      deliveryAttempted,
      ...params.telemetry,
    });
  const cleanupDirectCronSessionIfNeeded = async (): Promise<CronRunSessionCleanupOutcome> => {
    if (directCronSessionCleanupAttempted) {
      return "not-requested";
    }
    const cleanupOutcome = await cleanupCronRunSessionAfterRun({
      job: params.job,
      agentSessionKey: params.agentSessionKey,
      sessionId: params.sessionId,
      lifecycleRevision: params.lifecycleRevision,
      sessionUpdatedAt: params.sessionUpdatedAt,
      beforeDelete: params.beforeSessionDelete,
      reason: "cron-delete-after-run-fallback",
    });
    if (cleanupOutcome !== "not-requested") {
      directCronSessionCleanupAttempted = true;
    }
    const survivingMirror = deferredDeletingSessionMirror;
    deferredDeletingSessionMirror = undefined;
    if (cleanupOutcome !== "not-requested" && cleanupOutcome !== "deleted" && survivingMirror) {
      await appendAdmittedDirectCronDeliveryTranscriptMirror({
        job: params.job,
        mirror: survivingMirror,
        abortSignal: params.abortSignal,
      });
    }
    return cleanupOutcome;
  };
  const finishSilentReplyDelivery = async (): Promise<RunCronAgentTurnResult> => {
    deliveryAttempted = true;
    await cleanupDirectCronSessionIfNeeded();
    return params.withRunSession({
      status: "ok",
      summary,
      outputText,
      delivered: false,
      deliveryAttempted: true,
      ...params.telemetry,
    });
  };
  const creditRequesterConsumedDescendants = async (runIds: readonly string[]): Promise<void> => {
    await creditCronRequesterConsumedDescendants({
      requesterSessionKey: params.runSessionKey,
      runStartedAt: params.runStartedAt,
      runIds,
      loadRuntime: loadDeliverySubagentRegistryRuntime,
      logWarn: logCronDeliveryWarn,
      jobId: params.job.id,
    });
  };

  const deliverViaDirect = async (
    delivery: SuccessfulCronDeliveryTarget,
    options?: { retryTransient?: boolean },
  ): Promise<RunCronAgentTurnResult | null> => {
    const state = await deliverCronDirectAndCleanup({
      params,
      delivery,
      deliveryPayloads,
      outputText,
      summary,
      synthesizedText,
      deliveryAttempted,
      deliveryBestEffort: params.deliveryBestEffort,
      directCronSessionCleanupAttempted,
      delivered,
      deferredDeletingSessionMirror,
      options,
      setDeferredDeletingSessionMirror: (mirror) => {
        deferredDeletingSessionMirror = mirror;
      },
      cleanupDirectCronSessionIfNeeded,
    });
    delivered = state.delivered;
    deliveryAttempted = state.deliveryAttempted;
    deliveryError = state.deliveryError;
    directCronSessionCleanupAttempted = state.directCronSessionCleanupAttempted;
    deferredDeletingSessionMirror = state.deferredDeletingSessionMirror;
    return state.result;
  };

  const deliverViaDirectAndCleanup = async (
    delivery: SuccessfulCronDeliveryTarget,
    options: { retryTransient?: boolean } = { retryTransient: true },
  ): Promise<RunCronAgentTurnResult | null> => await deliverViaDirect(delivery, options);

  const finalizeTextDelivery = async (
    delivery: SuccessfulCronDeliveryTarget,
  ): Promise<RunCronAgentTurnResult | null> => {
    if (!synthesizedText) {
      return null;
    }
    const initialSynthesizedText = synthesizedText.trim();
    const expectedSubagentFollowup = expectsSubagentFollowup(initialSynthesizedText);
    const subagentRegistryRuntime = await loadDeliverySubagentRegistryRuntime();
    const subagentFollowupSessionKey = params.runSessionKey;
    let activeSubagentRuns = subagentRegistryRuntime.countActiveDescendantRuns(
      subagentFollowupSessionKey,
    );
    const shouldCheckCompletedDescendants =
      activeSubagentRuns === 0 && isLikelyInterimCronMessage(initialSynthesizedText);
    const needsSubagentFollowupRuntime =
      shouldCheckCompletedDescendants || activeSubagentRuns > 0 || expectedSubagentFollowup;
    const subagentFollowupRuntime = needsSubagentFollowupRuntime
      ? await loadSubagentFollowupRuntime()
      : undefined;
    // Also check for already-completed descendants. If the subagent finished
    // before delivery-dispatch runs, activeSubagentRuns is 0 and
    // expectedSubagentFollowup may be false (e.g. cron said "on it" which
    // doesn't match the narrow hint list). We still need to use the
    // descendant's output instead of the interim cron text.
    const completedDescendantReply = shouldCheckCompletedDescendants
      ? await subagentFollowupRuntime?.readDescendantSubagentFallbackReply({
          sessionKey: subagentFollowupSessionKey,
          runStartedAt: params.runStartedAt,
        })
      : undefined;
    const hadDescendants = activeSubagentRuns > 0 || Boolean(completedDescendantReply);
    if (!params.deliveryBestEffort && (activeSubagentRuns > 0 || expectedSubagentFollowup)) {
      let finalReply = await subagentFollowupRuntime?.waitForDescendantSubagentSummary({
        sessionKey: subagentFollowupSessionKey,
        initialReply: initialSynthesizedText,
        timeoutMs: params.timeoutMs,
        observedActiveDescendants: activeSubagentRuns > 0 || expectedSubagentFollowup,
      });
      activeSubagentRuns = subagentRegistryRuntime.countActiveDescendantRuns(
        subagentFollowupSessionKey,
      );
      if (!finalReply && activeSubagentRuns === 0) {
        const fallbackReply = await subagentFollowupRuntime?.readDescendantSubagentFallbackReply({
          sessionKey: subagentFollowupSessionKey,
          runStartedAt: params.runStartedAt,
        });
        if (fallbackReply) {
          finalReply = fallbackReply.text;
          await creditRequesterConsumedDescendants(fallbackReply.consumedRunIds);
        }
      }
      if (finalReply && activeSubagentRuns === 0) {
        outputText = finalReply;
        summary = pickSummaryFromOutput(finalReply) ?? summary;
        synthesizedText = finalReply;
        deliveryPayloads = [{ text: finalReply }];
      }
    } else if (completedDescendantReply) {
      // Descendants already finished before we got here. Use their output
      // directly instead of the cron agent's interim text.
      outputText = completedDescendantReply.text;
      summary = pickSummaryFromOutput(completedDescendantReply.text) ?? summary;
      synthesizedText = completedDescendantReply.text;
      deliveryPayloads = [{ text: completedDescendantReply.text }];
      await creditRequesterConsumedDescendants(completedDescendantReply.consumedRunIds);
    }
    if (!params.deliveryBestEffort && activeSubagentRuns > 0) {
      // Parent orchestration is still in progress; avoid announcing a partial
      // update to the main requester. Mark deliveryAttempted so the timer does
      // not fire a redundant enqueueSystemEvent fallback (double-announce bug).
      deliveryAttempted = true;
      return params.withRunSession({
        status: "ok",
        summary,
        outputText,
        deliveryAttempted,
        ...params.telemetry,
      });
    }
    if (
      hadDescendants &&
      synthesizedText.trim() === initialSynthesizedText &&
      isLikelyInterimCronMessage(initialSynthesizedText) &&
      !isSilentReplyText(initialSynthesizedText, SILENT_REPLY_TOKEN)
    ) {
      // Descendants existed but no post-orchestration synthesis arrived AND
      // no descendant fallback reply was available. Suppress stale parent
      // text like "on it, pulling everything together". Mark deliveryAttempted
      // so the timer does not fire a redundant enqueueSystemEvent fallback.
      deliveryAttempted = true;
      return params.withRunSession({
        status: "ok",
        summary,
        outputText,
        deliveryAttempted,
        ...params.telemetry,
      });
    }
    const normalizedSynthesizedText = normalizeSilentReplyText(synthesizedText);
    if (
      normalizedSynthesizedText.text === undefined ||
      normalizedSynthesizedText.strippedTrailingSilentToken
    ) {
      return await finishSilentReplyDelivery();
    }
    synthesizedText = normalizedSynthesizedText.text;
    outputText = synthesizedText;
    if (params.isAborted()) {
      return params.withRunSession({
        status: "error",
        error: params.abortReason(),
        deliveryAttempted,
        ...params.telemetry,
      });
    }
    return await deliverViaDirectAndCleanup(delivery, { retryTransient: true });
  };

  if (params.deliveryRequested && !params.skipHeartbeatDelivery && !sourceDeliverySatisfied) {
    if (!params.resolvedDelivery.ok) {
      // The target could not be resolved (e.g. a keyless implicit cron whose
      // inherited shared-bucket target was refused). We never send here, so a
      // deleteAfterRun cron must still retire its session/transcript before
      // returning — otherwise the one-shot session leaks. Safe no-op for
      // non-deleteAfterRun / non-cron sessions (see cleanupDirectCronSession).
      await cleanupDirectCronSessionIfNeeded();
      if (!params.deliveryBestEffort) {
        return buildDeliveryState(failDeliveryTarget(params.resolvedDelivery.error.message));
      }
      delivered = false;
      deliveryError = params.resolvedDelivery.error.message;
      await logCronDeliveryWarn(`[cron:${params.job.id}] ${params.resolvedDelivery.error.message}`);
      return buildDeliveryState(
        params.withRunSession({
          status: "ok",
          summary,
          outputText,
          delivered,
          deliveryError,
          deliveryAttempted,
          ...params.telemetry,
        }),
      );
    }

    // Finalize descendant/subagent output first for text-only cron runs, then
    // send through the real outbound adapter so delivered=true always reflects
    // an actual channel send instead of internal announce routing.
    const useDirectDelivery =
      params.deliveryPayloadHasStructuredContent || params.resolvedDelivery.threadId != null;
    if (useDirectDelivery) {
      const directResult = await deliverViaDirectAndCleanup(params.resolvedDelivery);
      if (directResult) {
        return buildDeliveryState(directResult);
      }
    } else {
      const finalizedTextResult = await finalizeTextDelivery(params.resolvedDelivery);
      if (finalizedTextResult) {
        return buildDeliveryState(finalizedTextResult);
      }
    }
  }

  return buildDeliveryState();
}
