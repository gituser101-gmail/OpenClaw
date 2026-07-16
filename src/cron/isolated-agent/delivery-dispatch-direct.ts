/** Direct outbound delivery path for isolated cron dispatch. */
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { resolveStorePath } from "../../config/sessions/inbound.runtime.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type {
  NormalizedOutboundPayload,
  OutboundDeliveryResult,
} from "../../infra/outbound/deliver.js";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForMirror,
} from "../../infra/outbound/payloads.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { isCronSessionKey } from "../../routing/session-key.js";
import {
  appendAdmittedDirectCronDeliveryTranscriptMirror,
  buildDirectCronTranscriptMirrorPayloads,
  type DirectCronTranscriptMirror,
  formatTargetCronDeliveryFailureAwarenessText,
  projectDeliveredDirectCronPayloadsForMirror,
  queueCronAwarenessSystemEvent,
  resolveCronAwarenessMainSessionKey,
  resolveCronAwarenessText,
  resolveDirectCronDeliverySessionKey,
  resolveDirectCronFallbackSourceIndex,
  resolveDirectCronSummaryFallbackText,
  resolveDirectCronTranscriptMirrorText,
  shouldAttachDirectCronFallbackText,
  isSameSessionKey,
  shouldQueueCronAwareness,
} from "./delivery-dispatch-awareness.js";
import {
  buildDirectCronDeliveryIdempotencyKey,
  DIRECT_CRON_DELIVERY_COMPLETION_RETENTION,
  isCompletedDirectCronDelivery,
  isStaleCronDelivery,
  logCronDeliveryError,
  logCronDeliveryErrorDeferred,
  logCronDeliveryWarn,
  maybeApplyTtsToCronPayloads,
  normalizeSilentReplyText,
  resolveCronDeliveryScheduledAtMs,
  resolveCronDeliveryStartDelayMs,
  retryTransientDirectCronDelivery,
  waitForCompletedDirectCronDelivery,
} from "./delivery-dispatch-policy.js";
import type {
  DispatchCronDeliveryParams,
  SuccessfulCronDeliveryTarget,
} from "./delivery-dispatch-types.js";
import type { RunCronAgentTurnResult } from "./run.types.js";
import type { CronRunSessionCleanupOutcome } from "./session-cleanup.js";

type DirectCronDeliveryState = {
  result: RunCronAgentTurnResult | null;
  delivered: boolean;
  deliveryAttempted: boolean;
  deliveryError?: string;
  directCronSessionCleanupAttempted: boolean;
  deferredDeletingSessionMirror?: DirectCronTranscriptMirror;
};

export async function deliverCronDirectAndCleanup(params: {
  params: DispatchCronDeliveryParams;
  delivery: SuccessfulCronDeliveryTarget;
  deliveryPayloads: ReplyPayload[];
  outputText?: string;
  summary?: string;
  synthesizedText?: string;
  delivered: boolean;
  deliveryAttempted: boolean;
  deliveryBestEffort: boolean;
  directCronSessionCleanupAttempted: boolean;
  deferredDeletingSessionMirror?: DirectCronTranscriptMirror;
  options?: { retryTransient?: boolean };
  setDeferredDeletingSessionMirror: (mirror: DirectCronTranscriptMirror | undefined) => void;
  cleanupDirectCronSessionIfNeeded: () => Promise<CronRunSessionCleanupOutcome>;
}): Promise<DirectCronDeliveryState> {
  const outer = params.params;
  let delivered = params.delivered;
  let deliveryAttempted = params.deliveryAttempted;
  let deliveryError: string | undefined;
  let directCronSessionCleanupAttempted = params.directCronSessionCleanupAttempted;
  let deferredDeletingSessionMirror = params.deferredDeletingSessionMirror;
  let returnedState: DirectCronDeliveryState | undefined;

  const cleanupDirectCronSessionIfNeeded = async () => {
    const cleanupOutcome = await params.cleanupDirectCronSessionIfNeeded();
    if (cleanupOutcome !== "not-requested") {
      directCronSessionCleanupAttempted = true;
    }
    deferredDeletingSessionMirror = undefined;
    if (returnedState) {
      returnedState.directCronSessionCleanupAttempted = directCronSessionCleanupAttempted;
      delete returnedState.deferredDeletingSessionMirror;
    }
    return cleanupOutcome;
  };
  const finish = (result: RunCronAgentTurnResult | null): DirectCronDeliveryState => {
    returnedState = {
      result,
      delivered,
      deliveryAttempted,
      ...(deliveryError ? { deliveryError } : {}),
      directCronSessionCleanupAttempted,
      ...(deferredDeletingSessionMirror ? { deferredDeletingSessionMirror } : {}),
    };
    return returnedState;
  };

  const deliveryIdempotencyKey = buildDirectCronDeliveryIdempotencyKey({
    jobId: outer.job.id,
    runStartedAt: outer.runStartedAt,
    delivery: params.delivery,
  });
  let completedDelivery = false;
  try {
    completedDelivery = isCompletedDirectCronDelivery(deliveryIdempotencyKey);
  } catch (err) {
    if (!params.deliveryBestEffort) {
      throw err;
    }
    await logCronDeliveryWarn(
      `[cron:${outer.job.id}] durable delivery receipt unavailable; continuing best-effort delivery: ${formatErrorMessage(err)}`,
    );
  }
  if (completedDelivery) {
    delivered = true;
    deliveryAttempted = true;
    await cleanupDirectCronSessionIfNeeded();
    return finish(null);
  }
  const {
    buildOutboundSessionContext,
    createOutboundSendDeps,
    resolveAgentOutboundIdentity,
    sendDurableMessageBatch,
  } = await import("./delivery-outbound.runtime.js");
  const identity = resolveAgentOutboundIdentity(outer.cfgWithAgentDefaults, outer.agentId);
  try {
    const summaryFallbackText = resolveDirectCronSummaryFallbackText({
      outputText: params.outputText,
      summary: params.summary,
      synthesizedText: params.synthesizedText,
    });
    const normalizedSummaryFallback = summaryFallbackText
      ? normalizeSilentReplyText(summaryFallbackText)
      : undefined;
    const normalizedSummaryFallbackText =
      normalizedSummaryFallback?.strippedTrailingSilentToken === true
        ? undefined
        : normalizedSummaryFallback?.text;
    const normalizeDirectPayload = (payload: ReplyPayload): ReplyPayload => {
      const normalized = payload.text ? normalizeSilentReplyText(payload.text) : undefined;
      return normalized
        ? {
            ...payload,
            text: normalized.strippedTrailingSilentToken ? undefined : normalized.text,
          }
        : payload;
    };
    const normalizedDeliveryPayloads = params.deliveryPayloads
      .map(normalizeDirectPayload)
      .filter((payload) => hasReplyPayloadContent(payload, { trimText: true }));
    const existingFallbackSourceIndex = resolveDirectCronFallbackSourceIndex(
      normalizedDeliveryPayloads,
      normalizedSummaryFallbackText,
    );
    const needsFallbackSource =
      Boolean(normalizedSummaryFallbackText) &&
      normalizedDeliveryPayloads.some(shouldAttachDirectCronFallbackText) &&
      existingFallbackSourceIndex === undefined;
    const fallbackSourceIndex = needsFallbackSource ? 0 : existingFallbackSourceIndex;
    const directPayloads = needsFallbackSource
      ? [{ text: normalizedSummaryFallbackText }, ...normalizedDeliveryPayloads]
      : normalizedDeliveryPayloads;
    let normalizedPayloads: ReplyPayload[] = [];
    for (const payload of directPayloads) {
      normalizedPayloads.push(
        shouldAttachDirectCronFallbackText(payload) && normalizedSummaryFallbackText
          ? {
              ...payload,
              fallbackText: {
                text: normalizedSummaryFallbackText,
                ...(fallbackSourceIndex !== undefined
                  ? { replacesPayloadIndex: fallbackSourceIndex }
                  : {}),
              },
            }
          : payload,
      );
    }
    if (normalizedPayloads.length === 0 && normalizedSummaryFallbackText) {
      normalizedPayloads = [{ text: normalizedSummaryFallbackText }];
    }
    if (normalizedPayloads.length === 0) {
      deliveryAttempted = true;
      await cleanupDirectCronSessionIfNeeded();
      return finish(
        outer.withRunSession({
          status: "ok",
          summary: params.summary,
          outputText: params.outputText,
          delivered: false,
          deliveryAttempted: true,
          ...outer.telemetry,
        }),
      );
    }
    if (outer.isAborted()) {
      return finish(
        outer.withRunSession({
          status: "error",
          error: outer.abortReason(),
          deliveryAttempted,
          ...outer.telemetry,
        }),
      );
    }
    if (
      outer.deliveryRequested &&
      isStaleCronDelivery({ job: outer.job, runStartedAt: outer.runStartedAt })
    ) {
      deliveryAttempted = true;
      const nowMs = Date.now();
      const scheduledAtMs = resolveCronDeliveryScheduledAtMs({
        job: outer.job,
        runStartedAt: outer.runStartedAt,
      });
      const startDelayMs = resolveCronDeliveryStartDelayMs({
        job: outer.job,
        runStartedAt: outer.runStartedAt,
      });
      await logCronDeliveryWarn(
        `[cron:${outer.job.id}] skipping stale delivery scheduled at ${new Date(scheduledAtMs).toISOString()}, started ${Math.round(startDelayMs / 60_000)}m late, current age ${Math.round((nowMs - scheduledAtMs) / 60_000)}m`,
      );
      return finish(
        outer.withRunSession({
          status: "ok",
          summary: params.summary,
          outputText: params.outputText,
          deliveryAttempted,
          delivered: false,
          ...outer.telemetry,
        }),
      );
    }
    const payloadsForDelivery = (
      await maybeApplyTtsToCronPayloads({
        cfg: outer.cfgWithAgentDefaults,
        payloads: normalizedPayloads,
        delivery: params.delivery,
        agentId: outer.agentId,
        ttsAuto: outer.ttsAuto,
      })
    ).filter((p) => hasReplyPayloadContent(p, { trimText: true }));
    if (payloadsForDelivery.length === 0) {
      deliveryAttempted = true;
      await cleanupDirectCronSessionIfNeeded();
      return finish(
        outer.withRunSession({
          status: "ok",
          summary: params.summary,
          outputText: params.outputText,
          delivered: false,
          deliveryAttempted: true,
          ...outer.telemetry,
        }),
      );
    }
    deliveryAttempted = true;
    const deliverySessionKey = await resolveDirectCronDeliverySessionKey({
      cfg: outer.cfgWithAgentDefaults,
      job: outer.job,
      agentId: outer.agentId,
      agentSessionKey: outer.agentSessionKey,
      delivery: params.delivery,
    });
    const deliverySession = buildOutboundSessionContext({
      cfg: outer.cfgWithAgentDefaults,
      agentId: outer.agentId,
      sessionKey: deliverySessionKey,
    });
    const awarenessMainSessionKey = resolveCronAwarenessMainSessionKey({
      cfg: outer.cfgWithAgentDefaults,
      agentId: outer.agentId,
    });
    const mirrorTargetsAwarenessMainSession = isSameSessionKey(
      deliverySessionKey,
      awarenessMainSessionKey,
    );
    const mirrorTargetsDeletingRunSession =
      outer.job.deleteAfterRun === true &&
      isCronSessionKey(outer.agentSessionKey) &&
      isSameSessionKey(deliverySessionKey, outer.agentSessionKey);

    let hadPartialFailure = false;
    let completedByConcurrentDelivery = false;
    let payloadMayHaveReachedRecipientBeforeFailure = false;
    const attemptedPayloadsForMirror: NormalizedOutboundPayload[] = [];
    const onError = params.deliveryBestEffort
      ? (err: unknown, _payload: unknown) => {
          hadPartialFailure = true;
          deliveryError ??= formatErrorMessage(err);
          logCronDeliveryErrorDeferred(
            `[cron:${outer.job.id}] delivery payload failed (bestEffort): ${formatErrorMessage(err)}`,
          );
        }
      : undefined;
    const runDelivery = async () => {
      attemptedPayloadsForMirror.length = 0;
      const send = await sendDurableMessageBatch({
        cfg: outer.cfgWithAgentDefaults,
        channel: params.delivery.channel,
        to: params.delivery.to,
        accountId: params.delivery.accountId,
        threadId: params.delivery.threadId,
        payloads: payloadsForDelivery,
        session: deliverySession,
        identity,
        bestEffort: params.deliveryBestEffort,
        durability: params.deliveryBestEffort ? "best_effort" : "required",
        deliveryIntentId: deliveryIdempotencyKey,
        reusePendingDeliveryIntent: true,
        completionRetention: DIRECT_CRON_DELIVERY_COMPLETION_RETENTION,
        deps: createOutboundSendDeps(outer.deps),
        signal: outer.abortSignal,
        onError,
        onPayload: (payload) => {
          attemptedPayloadsForMirror.push(payload);
        },
      });
      payloadMayHaveReachedRecipientBeforeFailure ||=
        send.payloadOutcomes?.some(
          (outcome) =>
            outcome.status === "sent" ||
            (outcome.status === "failed" && outcome.sentBeforeError) ||
            (outcome.status === "suppressed" && outcome.reason === "adapter_returned_no_identity"),
        ) ?? false;
      if (
        send.status === "failed" &&
        (await waitForCompletedDirectCronDelivery({
          id: deliveryIdempotencyKey,
          signal: outer.abortSignal,
        }))
      ) {
        completedByConcurrentDelivery = true;
        return [];
      }
      if (send.status === "failed") {
        throw send.error;
      }
      if (send.status === "partial_failed") {
        payloadMayHaveReachedRecipientBeforeFailure = true;
        if (!params.deliveryBestEffort) {
          throw send.error;
        }
        hadPartialFailure = true;
        deliveryError ??= formatErrorMessage(send.error);
      }
      return send.status === "sent" || send.status === "partial_failed" ? send.results : [];
    };
    let deliveryResults: OutboundDeliveryResult[];
    try {
      deliveryResults = params.options?.retryTransient
        ? await retryTransientDirectCronDelivery({
            jobId: outer.job.id,
            signal: outer.abortSignal,
            run: runDelivery,
            shouldRetryError: () => !payloadMayHaveReachedRecipientBeforeFailure,
          })
        : await runDelivery();
    } catch (err) {
      const failureAwarenessText = formatTargetCronDeliveryFailureAwarenessText({
        job: outer.job,
        channel: params.delivery.channel,
        to: params.delivery.to,
        threadId: stringifyRouteThreadId(params.delivery.threadId),
        error: err,
        partialDelivered: payloadMayHaveReachedRecipientBeforeFailure,
      });
      await queueCronAwarenessSystemEvent({
        cfg: outer.cfgWithAgentDefaults,
        jobId: outer.job.id,
        agentId: outer.agentId,
        deliveryIdempotencyKey: `${deliveryIdempotencyKey}:failure`,
        queueMainSession: false,
        targetSessionKey: deliverySessionKey,
        text: failureAwarenessText,
        targetText: failureAwarenessText,
      });
      throw err;
    }
    if (completedByConcurrentDelivery) {
      delivered = true;
      return finish(null);
    }
    delivered = deliveryResults.length > 0 && !hadPartialFailure;
    const deliveryAwarenessText = resolveCronAwarenessText({
      outputText: params.outputText,
      synthesizedText: params.synthesizedText,
      deliveryPayloads: payloadsForDelivery,
      outboundPayloads: attemptedPayloadsForMirror,
    });
    const shouldQueueAwarenessForDelivery = shouldQueueCronAwareness({
      job: outer.job,
      delivery: params.delivery,
      deliveryBestEffort: params.deliveryBestEffort,
    });
    const awarenessText = shouldQueueAwarenessForDelivery ? deliveryAwarenessText : undefined;
    const deliveryWillReachAwarenessMainSession =
      mirrorTargetsAwarenessMainSession &&
      shouldQueueAwarenessForDelivery &&
      Boolean(awarenessText);
    const mirrorWouldBypassIsolatedAwarenessPolicy =
      mirrorTargetsAwarenessMainSession &&
      outer.job.sessionTarget === "isolated" &&
      params.delivery.mode !== "explicit";
    if (
      delivered &&
      !deliveryWillReachAwarenessMainSession &&
      !mirrorWouldBypassIsolatedAwarenessPolicy
    ) {
      const mirrorProjection =
        attemptedPayloadsForMirror.length > 0
          ? projectDeliveredDirectCronPayloadsForMirror(attemptedPayloadsForMirror)
          : projectOutboundPayloadPlanForMirror(
              createOutboundPayloadPlan(
                buildDirectCronTranscriptMirrorPayloads(payloadsForDelivery),
                {
                  cfg: outer.cfgWithAgentDefaults,
                  sessionKey: deliverySessionKey,
                  surface: params.delivery.channel,
                },
              ),
            );
      const mirrorText = resolveDirectCronTranscriptMirrorText(mirrorProjection);
      const transcriptMirror = {
        sessionKey: deliverySessionKey,
        agentId: outer.agentId,
        ...(mirrorTargetsDeletingRunSession
          ? {
              expectedSessionId: outer.sessionId,
              expectedLifecycleRevision: outer.lifecycleRevision,
            }
          : {}),
        text: mirrorText,
        mediaUrls: undefined,
        storePath: resolveStorePath(outer.cfgWithAgentDefaults.session?.store, {
          agentId: outer.agentId,
        }),
        idempotencyKey: deliveryIdempotencyKey,
        config: outer.cfgWithAgentDefaults,
      };
      if (mirrorTargetsDeletingRunSession) {
        deferredDeletingSessionMirror = transcriptMirror;
        params.setDeferredDeletingSessionMirror(transcriptMirror);
      } else {
        await appendAdmittedDirectCronDeliveryTranscriptMirror({
          job: outer.job,
          mirror: transcriptMirror,
          abortSignal: outer.abortSignal,
        });
      }
    }
    if (
      delivered &&
      !params.deliveryBestEffort &&
      deliveryAwarenessText &&
      (shouldQueueAwarenessForDelivery ||
        !isSameSessionKey(deliverySessionKey, awarenessMainSessionKey))
    ) {
      await queueCronAwarenessSystemEvent({
        cfg: outer.cfgWithAgentDefaults,
        jobId: outer.job.id,
        agentId: outer.agentId,
        deliveryIdempotencyKey,
        queueMainSession: shouldQueueAwarenessForDelivery,
        text: deliveryAwarenessText,
        targetSessionKey: deliverySessionKey,
      });
    }
    return finish(null);
  } catch (err) {
    if (!params.deliveryBestEffort) {
      return finish(
        outer.withRunSession({
          status: "error",
          summary: params.summary,
          outputText: params.outputText,
          error: String(err),
          deliveryAttempted,
          ...outer.telemetry,
        }),
      );
    }
    await logCronDeliveryError(
      `[cron:${outer.job.id}] delivery failed (bestEffort): ${formatErrorMessage(err)}`,
    );
    deliveryError = formatErrorMessage(err);
    return finish(null);
  } finally {
    await cleanupDirectCronSessionIfNeeded();
  }
}
