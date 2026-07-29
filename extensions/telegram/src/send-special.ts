import type { RetryConfig } from "openclaw/plugin-sdk/retry-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { recordTelegramPollRegistryEntry } from "./poll-registry.js";
import {
  resolveTelegramApiContext,
  withTelegramApiContextLease,
  type TelegramApiContext,
  type TelegramApiOverride,
} from "./send-context.js";
import type { TelegramSendResult } from "./send-message-types.js";
import { finalizeTelegramOutbound, prepareTelegramOutbound } from "./send-outbound.js";
import { normalizePollInput, type OpenClawConfig, type PollInput } from "./send.runtime.js";

type TelegramSendPollParams = Parameters<TelegramApiContext["api"]["sendPoll"]>[3];

type TelegramStickerOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  gatewayClientScopes?: readonly string[];
  /** Message ID to reply to (for threading) */
  replyToMessageId?: number;
  /** Forum topic thread ID (for forum supergroups) */
  messageThreadId?: number;
};

/**
 * Send a sticker to a Telegram chat by file_id.
 * @param to - Chat ID or username (e.g., "123456789" or "@username")
 * @param fileId - Telegram file_id of the sticker to send
 * @param opts - Optional configuration
 */
export async function sendStickerTelegram(
  to: string,
  fileId: string,
  opts: TelegramStickerOpts,
): Promise<TelegramSendResult> {
  if (!fileId?.trim()) {
    throw new Error("Telegram sticker file_id is required");
  }

  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    sendStickerTelegramWithContext(to, fileId, opts, context),
  );
}

async function sendStickerTelegramWithContext(
  to: string,
  fileId: string,
  opts: TelegramStickerOpts,
  context: TelegramApiContext,
): Promise<TelegramSendResult> {
  const { api } = context;
  const prepared = await prepareTelegramOutbound({
    to,
    context,
    opts,
    thread: {
      messageThreadId: opts.messageThreadId,
      replyToMessageId: opts.replyToMessageId,
    },
    request: { kind: "nonIdempotent", useApiErrorLogging: false },
  });
  const stickerParams =
    Object.keys(prepared.threadParams).length > 0 ? prepared.threadParams : undefined;

  const result = await prepared.request(
    () => api.sendSticker(prepared.chatId, fileId.trim(), stickerParams),
    "sticker",
  );
  return finalizeTelegramOutbound({
    context,
    prepared,
    result,
    resultContext: "sticker send",
  });
}

type TelegramPollOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  gatewayClientScopes?: readonly string[];
  /** Message ID to reply to (for threading) */
  replyToMessageId?: number;
  /** Forum topic thread ID (for forum supergroups) */
  messageThreadId?: number;
  /** Send message silently (no notification). Defaults to false. */
  silent?: boolean;
  /** Whether votes are anonymous. Defaults to true (Telegram default). */
  isAnonymous?: boolean;
};

/**
 * Send a poll to a Telegram chat.
 * @param to - Chat ID or username (e.g., "123456789" or "@username")
 * @param poll - Poll input with question, options, maxSelections, and optional durationHours
 * @param opts - Optional configuration
 */
export async function sendPollTelegram(
  to: string,
  poll: PollInput,
  opts: TelegramPollOpts,
): Promise<{ messageId: string; chatId: string; pollId?: string }> {
  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(context, sendPollTelegramWithContext(to, poll, opts, context));
}

async function sendPollTelegramWithContext(
  to: string,
  poll: PollInput,
  opts: TelegramPollOpts,
  context: TelegramApiContext,
): Promise<{ messageId: string; chatId: string; pollId?: string }> {
  const { api } = context;
  const prepared = await prepareTelegramOutbound({
    to,
    context,
    opts,
    thread: {
      messageThreadId: opts.messageThreadId,
      replyToMessageId: opts.replyToMessageId,
    },
    request: { kind: "nonIdempotent" },
  });

  const normalizedPoll = normalizePollInput(poll, { maxOptions: 12 });

  const durationSeconds = normalizedPoll.durationSeconds;
  if (durationSeconds === undefined && normalizedPoll.durationHours !== undefined) {
    throw new Error(
      "Telegram poll durationHours is not supported. Use durationSeconds (5-600) instead.",
    );
  }
  if (durationSeconds !== undefined && (durationSeconds < 5 || durationSeconds > 600)) {
    throw new Error("Telegram poll durationSeconds must be between 5 and 600");
  }

  const pollParams: TelegramSendPollParams = {
    allows_multiple_answers: normalizedPoll.maxSelections > 1,
    is_anonymous: opts.isAnonymous ?? true,
    ...(durationSeconds !== undefined ? { open_period: durationSeconds } : {}),
    ...(Object.keys(prepared.threadParams).length > 0 ? prepared.threadParams : {}),
    ...(opts.silent === true ? { disable_notification: true } : {}),
  };

  const result = await prepared.request(
    () =>
      api.sendPoll(prepared.chatId, normalizedPoll.question, normalizedPoll.options, pollParams),
    "poll",
  );
  const finalized = await finalizeTelegramOutbound({
    context,
    prepared,
    result,
    resultContext: "poll send",
  });
  const pollId = result?.poll?.id;
  // Public poll answers omit chat/thread routing metadata. Record the origin at
  // the central send boundary so every caller gets the same inbound route.
  // This is best-effort because the poll already exists and retrying could duplicate it.
  if (pollId && opts.isAnonymous === false) {
    try {
      await recordTelegramPollRegistryEntry({
        accountId: context.account.accountId,
        pollId,
        chatId: finalized.chatId,
        messageThreadId: prepared.threadParams.message_thread_id,
        question: normalizedPoll.question,
        options: normalizedPoll.options,
      });
    } catch (err) {
      logVerbose(
        `telegram: failed to record poll registry entry for poll ${pollId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return {
    ...finalized,
    pollId,
  };
}
