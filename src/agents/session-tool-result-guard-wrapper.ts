/**
 * Session manager wrapper for tool-result transcript guards.
 *
 * Installs message-write hooks, input provenance handling, and pending tool-result flush behavior once per manager.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  applyInputProvenanceToUserMessage,
  type InputProvenance,
} from "../sessions/input-provenance.js";
import {
  attachRuntimeUserTurnTranscriptRecorder,
  takeRuntimeUserTurnTranscriptContext,
  takeRuntimeUserTurnTranscriptRecorder,
} from "../sessions/user-turn-transcript-runtime-context.js";
import {
  mergePreparedUserTurnMessageForRuntime,
  restorePreparedUserTurnOperationalMetaForRuntime,
  type PersistedUserTurnMessage,
  type UserTurnTranscriptRecorder,
} from "../sessions/user-turn-transcript.js";
import type { EmbeddedRunTrigger } from "./embedded-agent-runner/run/params.js";
import { resolveLiveToolResultMaxChars } from "./embedded-agent-runner/tool-result-truncation.js";
import { projectAgentHarnessTranscriptMessageForDisplay } from "./harness/transcript-visibility.js";
import type { AgentMessage } from "./runtime/index.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import type { SessionManager } from "./sessions/index.js";
import { redactTranscriptMessage } from "./transcript-redact.js";

type GuardedSessionManager = SessionManager & {
  /** Flush any synthetic tool results for pending tool calls. Idempotent. */
  flushPendingToolResults?: () => void;
  /** Clear pending tool calls without persisting synthetic tool results. Idempotent. */
  clearPendingToolResults?: () => void;
  /** Persist the next user message when an earlier canonical entry was removed. */
  clearNextUserMessagePersistenceSuppression?: () => void;
  /** Rebind per-attempt guard state when the same manager serves another attempt. */
  rebindSessionGuardState?: (opts: GuardSessionManagerOptions | undefined) => void;
};

type GuardSessionManagerOptions = {
  agentId?: string;
  sessionKey?: string;
  config?: OpenClawConfig;
  contextWindowTokens?: number;
  inputProvenance?: InputProvenance;
  allowSyntheticToolResults?: boolean;
  missingToolResultText?: string;
  allowedToolNames?: Iterable<string>;
  trigger?: EmbeddedRunTrigger;
  preparedUserTurnMessage?: PersistedUserTurnMessage;
  suppressNextUserMessagePersistence?: boolean;
  suppressTranscriptOnlyAssistantPersistence?: boolean;
  suppressAssistantErrorPersistence?: boolean;
  /** Finalization keeps core redaction but must not run plugin write hooks. */
  skipBeforeMessageWriteHooks?: boolean;
  onUserMessagePersisted?: (
    message: Extract<AgentMessage, { role: "user" }>,
    runtimeMessage: Extract<AgentMessage, { role: "user" }> | undefined,
  ) => void | Promise<void>;
  onUserMessagePersistenceSuppressed?: (
    message: Extract<AgentMessage, { role: "user" }>,
    runtimeMessage: Extract<AgentMessage, { role: "user" }> | undefined,
  ) => void | Promise<void>;
  onUserMessagePreparingForPersistence?: (
    message: Extract<AgentMessage, { role: "user" }>,
    recorder: UserTurnTranscriptRecorder | undefined,
    preparedMessage: PersistedUserTurnMessage | undefined,
  ) => void;
  onUserMessageBlocked?: (message: Extract<AgentMessage, { role: "user" }>) => void;
  onMessagePersisted?: (message: AgentMessage) => void | Promise<void>;
  withCompactionPersistence?: (
    append: () => string,
    validateAppend: (entryId: string, appendedText: string) => boolean,
  ) => string;
  onAssistantErrorMessagePersisted?: (
    message: Extract<AgentMessage, { role: "assistant" }>,
  ) => void | Promise<void>;
};

/**
 * Apply the tool-result guard to a SessionManager exactly once and expose
 * a flush method on the instance for easy teardown handling.
 *
 * Re-guarding an already-guarded manager rebinds the per-attempt guard state
 * (prepared user-turn message, persistence suppression, attempt callbacks,
 * synthetic tool-result policy, and tool-result size caps derived from the
 * attempt's context window) to the new options instead of silently keeping
 * the previous attempt's state. This matters for caller-owned managers that
 * are reused across run attempts (e.g. auth/model fallback retries);
 * persisted runs open a fresh manager per attempt and never take this path.
 */
export function guardSessionManager(
  sessionManager: SessionManager,
  opts?: GuardSessionManagerOptions,
): GuardedSessionManager {
  if (typeof (sessionManager as GuardedSessionManager).flushPendingToolResults === "function") {
    (sessionManager as GuardedSessionManager).rebindSessionGuardState?.(opts);
    return sessionManager as GuardedSessionManager;
  }

  const hookRunner = getGlobalHookRunner();
  let activeOpts = opts;
  let pendingPreparedUserTurnMessage = opts?.preparedUserTurnMessage;
  let queuedUserTurnTranscriptRecorder: UserTurnTranscriptRecorder | undefined;
  const runtimeUserMessageByPersistedMessage = new WeakMap<
    AgentMessage,
    Extract<AgentMessage, { role: "user" }>
  >();
  const beforeMessageWrite = (event: { message: AgentMessage }) => {
    const runtimeUserMessage = runtimeUserMessageByPersistedMessage.get(event.message);
    let message = event.message;
    let changed = false;
    if (!activeOpts?.skipBeforeMessageWriteHooks && hookRunner?.hasHooks("before_message_write")) {
      const result = hookRunner.runBeforeMessageWrite(event, {
        agentId: activeOpts?.agentId,
        sessionKey: activeOpts?.sessionKey,
      });
      if (result?.block) {
        runtimeUserMessageByPersistedMessage.delete(event.message);
        queuedUserTurnTranscriptRecorder?.markBlocked();
        queuedUserTurnTranscriptRecorder = undefined;
        return result;
      }
      if (result?.message) {
        message = restorePreparedUserTurnOperationalMetaForRuntime({
          runtimeMessage: result.message,
          ...(event.message.role === "user" ? { preparedMessage: event.message } : {}),
        });
        changed = true;
      }
    }
    const redacted = redactTranscriptMessage(message, activeOpts?.config);
    if (redacted !== message) {
      message = redacted;
      changed = true;
    }
    const projectedMessage = projectAgentHarnessTranscriptMessageForDisplay({
      hidden: activeOpts?.trigger === "memory",
      message,
    });
    if (projectedMessage !== message) {
      message = projectedMessage;
      changed = true;
    }
    if (message.role !== "user" && queuedUserTurnTranscriptRecorder) {
      queuedUserTurnTranscriptRecorder.markBlocked();
      queuedUserTurnTranscriptRecorder = undefined;
    }
    if (message.role === "user" && queuedUserTurnTranscriptRecorder) {
      message = attachRuntimeUserTurnTranscriptRecorder(message, queuedUserTurnTranscriptRecorder);
      queuedUserTurnTranscriptRecorder = undefined;
    }
    if (runtimeUserMessage && message.role === "user") {
      runtimeUserMessageByPersistedMessage.set(message, runtimeUserMessage);
    }
    return changed ? { message } : undefined;
  };

  const transform = hookRunner?.hasHooks("tool_result_persist")
    ? (
        message: AgentMessage,
        meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
      ) => {
        const out = hookRunner.runToolResultPersist(
          {
            toolName: meta.toolName,
            toolCallId: meta.toolCallId,
            message,
            isSynthetic: meta.isSynthetic,
          },
          {
            agentId: activeOpts?.agentId,
            sessionKey: activeOpts?.sessionKey,
            toolName: meta.toolName,
            toolCallId: meta.toolCallId,
          },
        );
        return out?.message ?? message;
      }
    : undefined;

  const guardOptionsToInnerOptions = (
    source: GuardSessionManagerOptions | undefined,
  ): NonNullable<Parameters<typeof installSessionToolResultGuard>[1]> => ({
    sessionKey: source?.sessionKey,
    agentId: source?.agentId,
    transformMessageForPersistence: (message) => {
      queuedUserTurnTranscriptRecorder = undefined;
      const withProvenance = applyInputProvenanceToUserMessage(
        message,
        activeOpts?.inputProvenance,
      );
      const runtimeContext = takeRuntimeUserTurnTranscriptContext(message);
      const prepared = runtimeContext?.message ?? pendingPreparedUserTurnMessage;
      if (message.role === "user") {
        activeOpts?.onUserMessagePreparingForPersistence?.(
          message,
          runtimeContext?.recorder,
          prepared,
        );
      }
      const merged = mergePreparedUserTurnMessageForRuntime({
        runtimeMessage: withProvenance,
        ...(prepared ? { preparedMessage: prepared } : {}),
      });
      if (merged !== withProvenance) {
        if (runtimeContext) {
          queuedUserTurnTranscriptRecorder = runtimeContext.recorder;
        } else {
          pendingPreparedUserTurnMessage = undefined;
        }
      }
      if (message.role === "user" && merged.role === "user") {
        // Persistence callbacks may be re-entrant. Correlate through the exact
        // transformed object instead of a mutable latest-message slot.
        runtimeUserMessageByPersistedMessage.set(merged, message);
      }
      return merged;
    },
    transformToolResultForPersistence: transform,
    allowSyntheticToolResults: source?.allowSyntheticToolResults,
    missingToolResultText: source?.missingToolResultText,
    allowedToolNames: source?.allowedToolNames,
    beforeMessageWriteHook: beforeMessageWrite,
    redactLoggingConfig: source?.config?.logging,
    maxToolResultChars:
      typeof source?.contextWindowTokens === "number"
        ? resolveLiveToolResultMaxChars({
            contextWindowTokens: source.contextWindowTokens,
          })
        : undefined,
    suppressNextUserMessagePersistence: source?.suppressNextUserMessagePersistence,
    suppressTranscriptOnlyAssistantPersistence: source?.suppressTranscriptOnlyAssistantPersistence,
    suppressAssistantErrorPersistence: source?.suppressAssistantErrorPersistence,
    onMessagePersisted: source?.onMessagePersisted,
    withCompactionPersistence: source?.withCompactionPersistence,
    onUserMessagePersisted: async (message) => {
      const runtimeMessage = runtimeUserMessageByPersistedMessage.get(message);
      runtimeUserMessageByPersistedMessage.delete(message);
      const recorder = takeRuntimeUserTurnTranscriptRecorder(message);
      recorder?.markRuntimePersisted(message);
      await activeOpts?.onUserMessagePersisted?.(message, runtimeMessage);
    },
    onUserMessagePersistenceSuppressed: async (message) => {
      const runtimeMessage = runtimeUserMessageByPersistedMessage.get(message);
      runtimeUserMessageByPersistedMessage.delete(message);
      await activeOpts?.onUserMessagePersistenceSuppressed?.(message, runtimeMessage);
    },
    onUserMessageBlocked: source?.onUserMessageBlocked,
    onAssistantErrorMessagePersisted: source?.onAssistantErrorMessagePersisted,
  });

  // The inner guard reads callbacks and attempt-scoped options (synthetic
  // tool-result policy, redaction config, tool-result size caps) from this
  // object at call time, so rebinding can swap them in place.
  const innerGuardOptions = guardOptionsToInnerOptions(opts);
  const guard = installSessionToolResultGuard(sessionManager, innerGuardOptions);
  const rebindSessionGuardState = (nextOpts: GuardSessionManagerOptions | undefined) => {
    activeOpts = nextOpts;
    pendingPreparedUserTurnMessage = nextOpts?.preparedUserTurnMessage;
    queuedUserTurnTranscriptRecorder = undefined;
    // Swap the inner guard's options in place so call-time reads (callbacks,
    // synthetic tool-result policy, redaction config, size caps derived from
    // the attempt's context window) pick up the new attempt's values.
    Object.assign(innerGuardOptions, guardOptionsToInnerOptions(nextOpts));
    guard.setNextUserMessagePersistenceSuppression(
      nextOpts?.suppressNextUserMessagePersistence === true,
    );
  };
  (sessionManager as GuardedSessionManager).flushPendingToolResults = guard.flushPendingToolResults;
  (sessionManager as GuardedSessionManager).clearPendingToolResults = guard.clearPendingToolResults;
  (sessionManager as GuardedSessionManager).clearNextUserMessagePersistenceSuppression =
    guard.clearNextUserMessagePersistenceSuppression;
  (sessionManager as GuardedSessionManager).rebindSessionGuardState = rebindSessionGuardState;
  return sessionManager as GuardedSessionManager;
}
