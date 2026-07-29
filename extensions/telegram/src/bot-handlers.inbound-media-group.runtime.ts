// Telegram media-group buffering and mention-aware album dispatch.
import type { Message } from "grammy/types";
import {
  buildMentionRegexes,
  implicitMentionKindWhen,
  matchesMentionWithExplicit,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import type {
  OpenClawConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { danger, warn } from "openclaw/plugin-sdk/runtime-env";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { firstDefined, type NormalizedAllowFrom } from "./bot-access.js";
import { hasInboundMedia, isRecoverableMediaGroupError } from "./bot-handlers.media.js";
import type { TelegramHandlerMessageRuntime } from "./bot-handlers.message.runtime.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import type { TelegramAmbientTranscriptWatermark } from "./bot-message-context.types.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import type { TelegramSpooledReplayDeferredParticipant } from "./bot-processing-outcome.js";
import { MEDIA_GROUP_TIMEOUT_MS, type MediaGroupEntry } from "./bot-updates.js";
import { renderTelegramTextEntities } from "./bot/body-helpers.js";
import { resolveMedia } from "./bot/delivery.resolve-media.js";
import { getTelegramTextParts, hasBotMention, resolveTelegramPrimaryMedia } from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import { isTelegramForumServiceMessage } from "./forum-service-message.js";
import { resolveTelegramCommandIngressAuthorization } from "./ingress.js";
import type { TelegramMessageDispatchReplayClaim } from "./message-dispatch-dedupe.js";

type MediaAuthorization = {
  authorizationCfg: OpenClawConfig;
  chatId: number;
  isGroup: boolean;
  isForum: boolean;
  resolvedThreadId?: number;
  dmThreadId?: number;
  senderId: string;
  effectiveGroupAllow: NormalizedAllowFrom;
  effectiveDmAllow: NormalizedAllowFrom;
  groupConfig?: TelegramGroupConfig;
  topicConfig?: TelegramTopicConfig;
};

type TelegramMediaGroupInput = MediaAuthorization & {
  ctx: TelegramContext;
  msg: Message;
  storeAllowFrom: string[];
  promptContextMinTimestampMs?: number;
  promptContextAmbientWatermark?: TelegramAmbientTranscriptWatermark;
  dispatchDedupeClaims: TelegramMessageDispatchReplayClaim[];
};

type BufferedMediaGroupEntry = MediaGroupEntry &
  Omit<TelegramMediaGroupInput, "ctx" | "msg"> & {
    spooledReplayParticipants: TelegramSpooledReplayDeferredParticipant[];
  };

export function createTelegramInboundMediaGroupRuntime(
  params: Pick<
    RegisterTelegramHandlerParams,
    | "accountId"
    | "bot"
    | "opts"
    | "runtime"
    | "mediaMaxBytes"
    | "logger"
    | "resolveGroupActivation"
    | "resolveGroupRequireMention"
  >,
  messageRuntime: TelegramHandlerMessageRuntime,
) {
  const {
    accountId,
    bot,
    opts,
    runtime,
    mediaMaxBytes,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
  } = params;
  const {
    mediaRuntimeWithAbort,
    promptContextBoundaryOptions,
    latestPromptContextMinTimestampMs,
    latestPromptContextAmbientWatermark,
    mergeDispatchDedupeClaims,
    releaseDispatchDedupeClaims,
    buildFailedProcessingResult,
    settleSpooledReplayParticipants,
    createSpooledReplayParticipantForBufferedWork,
    spooledReplayOptions,
    resolveTelegramSessionState,
    buildSyntheticTextMessage,
    buildSyntheticContext,
    processMessageWithReplyChain,
  } = messageRuntime;
  const timeoutMs =
    typeof opts.testTimings?.mediaGroupFlushMs === "number" &&
    Number.isFinite(opts.testTimings.mediaGroupFlushMs)
      ? Math.max(10, Math.floor(opts.testTimings.mediaGroupFlushMs))
      : MEDIA_GROUP_TIMEOUT_MS;
  const buffer = new Map<string, BufferedMediaGroupEntry>();
  const queue = new KeyedAsyncQueue();

  const shouldSkipMediaDownloadForUnaddressedMentionGroup = async (
    authorization: MediaAuthorization & { ctx: TelegramContext; msg: Message },
  ): Promise<boolean> => {
    const { ctx, msg, chatId, isGroup, isForum, resolvedThreadId, dmThreadId, senderId } =
      authorization;
    const textParts = getTelegramTextParts(msg);
    const documentMime = msg.document?.mime_type?.split(";")[0]?.trim().toLowerCase();
    const mayNeedDownload =
      !textParts.text.trim() &&
      Boolean(msg.audio ?? msg.voice ?? documentMime?.startsWith("audio/"));
    // Media-less messages have nothing to skip-download. They must reach the
    // canonical mention gate (bot-message-context.body), which records group
    // history, fires ingest hooks, and settles an explicit skipped result;
    // consuming them here tombstones the ingress row without any trace.
    if (!isGroup || !hasInboundMedia(msg) || mayNeedDownload) {
      return false;
    }
    const sessionState = resolveTelegramSessionState({
      chatId,
      isGroup,
      isForum,
      resolvedThreadId,
      messageThreadId: resolvedThreadId ?? dmThreadId,
      senderId,
      runtimeCfg: authorization.authorizationCfg,
    });
    const activationOverride = resolveGroupActivation({
      chatId,
      messageThreadId: resolvedThreadId,
      sessionKey: sessionState.sessionKey,
      agentId: sessionState.agentId,
      cfg: authorization.authorizationCfg,
    });
    const requireMention = firstDefined(
      authorization.topicConfig?.requireMention,
      activationOverride,
      authorization.groupConfig?.requireMention,
      resolveGroupRequireMention(chatId, authorization.authorizationCfg),
    );
    if (!requireMention) {
      return false;
    }
    const botUsername = ctx.me?.username?.trim().toLowerCase();
    const mentionRegexes = buildMentionRegexes(
      authorization.authorizationCfg,
      sessionState.agentId,
    );
    const hasAnyMention = textParts.entities.some((entity) => entity.type === "mention");
    const explicitlyMentioned = botUsername ? hasBotMention(msg, botUsername) : false;
    const wasMentioned = matchesMentionWithExplicit({
      text: textParts.text,
      mentionRegexes,
      explicit: {
        hasAnyMention,
        isExplicitlyMentioned: explicitlyMentioned,
        canResolveExplicit: Boolean(botUsername),
      },
    });
    const replyToBotMessage = ctx.me?.id != null && msg.reply_to_message?.from?.id === ctx.me.id;
    const implicitMentionKinds = implicitMentionKindWhen(
      "reply_to_bot",
      replyToBotMessage && !isTelegramForumServiceMessage(msg.reply_to_message),
    );
    const hasControlCommandInMessage = hasControlCommand(
      textParts.text,
      authorization.authorizationCfg,
      { botUsername },
    );
    const commandGate = await resolveTelegramCommandIngressAuthorization({
      accountId,
      cfg: authorization.authorizationCfg,
      dmPolicy: "pairing",
      isGroup,
      chatId,
      resolvedThreadId,
      senderId,
      effectiveDmAllow: authorization.effectiveDmAllow,
      effectiveGroupAllow: authorization.effectiveGroupAllow,
      ownerAccess: { ownerList: [], senderIsOwner: false },
      eventKind: "message",
      allowTextCommands: true,
      hasControlCommand: hasControlCommandInMessage,
      modeWhenAccessGroupsOff: "allow",
      includeDmAllowForGroupCommands: false,
    });
    const decision = resolveInboundMentionDecision({
      facts: {
        canDetectMention: Boolean(botUsername) || mentionRegexes.length > 0,
        wasMentioned,
        hasAnyMention,
        implicitMentionKinds,
      },
      policy: {
        isGroup,
        requireMention: true,
        allowTextCommands: true,
        hasControlCommand: hasControlCommandInMessage,
        commandAuthorized: commandGate.authorized,
      },
    });
    if (decision.shouldSkip) {
      logger.info({ chatId, reason: "no-mention" }, "skipping group media before download");
      return true;
    }
    return false;
  };

  const processMediaGroup = async (entry: BufferedMediaGroupEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);
      const primary =
        entry.messages.find((item) => item.msg.caption || item.msg.text) ?? entry.messages[0];
      if (!primary) {
        releaseDispatchDedupeClaims(entry.dispatchDedupeClaims);
        settleSpooledReplayParticipants(entry.spooledReplayParticipants, { kind: "skipped" });
        return;
      }
      // Gate on original captions: album labels and rendered links must not
      // change anchored mentions or turn private link targets into mentions.
      let shouldSkipMediaGroup = true;
      for (const item of entry.messages) {
        if (!(await shouldSkipMediaDownloadForUnaddressedMentionGroup({ ...entry, ...item }))) {
          shouldSkipMediaGroup = false;
          break;
        }
      }
      if (shouldSkipMediaGroup) {
        releaseDispatchDedupeClaims(entry.dispatchDedupeClaims);
        settleSpooledReplayParticipants(entry.spooledReplayParticipants, { kind: "skipped" });
        return;
      }
      const albumCaptions = entry.messages.flatMap(({ msg }, index) => {
        const { text, entities } = getTelegramTextParts(msg);
        const caption = renderTelegramTextEntities(text, entities).trim();
        return caption ? [{ index, caption }] : [];
      });
      const primaryTextParts = getTelegramTextParts(primary.msg);
      const primaryText = primaryTextParts.text;
      const preservePrimaryControlCommand = hasControlCommand(primaryText, entry.authorizationCfg, {
        botUsername: primary.ctx.me?.username,
      });
      const primaryCommandLength = primaryText.match(/^\/\S+/u)?.[0].length;
      // Keep command parsing anchored at byte zero without dropping rich
      // entities that begin after or span the original command prefix.
      const primaryCommandCaption =
        preservePrimaryControlCommand && primaryCommandLength !== undefined
          ? `${primaryText.slice(0, primaryCommandLength)}${renderTelegramTextEntities(
              primaryText.slice(primaryCommandLength),
              primaryTextParts.entities.flatMap((entity) => {
                const start = Math.max(entity.offset, primaryCommandLength);
                const end = entity.offset + entity.length;
                return end > start
                  ? [
                      {
                        ...entity,
                        offset: start - primaryCommandLength,
                        length: end - start,
                      },
                    ]
                  : [];
              }),
            )}`
          : primaryText;
      // The primary is the first text-bearing item, so its control command
      // stays at byte zero even when earlier album items have no caption.
      // Single-caption turns remain byte-for-byte stable.
      const dispatchMessage =
        albumCaptions.length > 1
          ? buildSyntheticTextMessage({
              base: primary.msg,
              text: albumCaptions
                .map(({ index, caption }) =>
                  preservePrimaryControlCommand && entry.messages[index]?.msg === primary.msg
                    ? primaryCommandCaption
                    : `Media ${index + 1}: ${caption}`,
                )
                .join("\n"),
            })
          : primary.msg;
      const dispatchContext =
        dispatchMessage === primary.msg
          ? primary.ctx
          : buildSyntheticContext(primary.ctx, dispatchMessage);
      const botUsername = primary.ctx.me?.username?.trim().toLowerCase();
      const albumMentionRegexes =
        entry.isGroup && dispatchMessage !== primary.msg
          ? buildMentionRegexes(
              entry.authorizationCfg,
              resolveTelegramSessionState({
                chatId: entry.chatId,
                isGroup: entry.isGroup,
                isForum: entry.isForum,
                resolvedThreadId: entry.resolvedThreadId,
                messageThreadId: entry.resolvedThreadId ?? entry.dmThreadId,
                senderId: entry.senderId,
                runtimeCfg: entry.authorizationCfg,
              }).agentId,
            )
          : [];
      const preserveAlbumMention =
        entry.isGroup &&
        dispatchMessage !== primary.msg &&
        entry.messages.some(({ msg }) => {
          const { text, entities } = getTelegramTextParts(msg);
          return matchesMentionWithExplicit({
            text,
            mentionRegexes: albumMentionRegexes,
            explicit: {
              hasAnyMention: entities.some((entity) => entity.type === "mention"),
              isExplicitlyMentioned: botUsername ? hasBotMention(msg, botUsername) : false,
              canResolveExplicit: Boolean(botUsername),
            },
          });
        });
      const allMedia: TelegramMediaRef[] = [];
      const selection = new Map<string, "include" | "exclude">();
      let materializedCount = 0;
      let skippedCount = 0;
      for (const { ctx, msg } of entry.messages) {
        const sourceMessageId = String(msg.message_id);
        const nativeKind = resolveTelegramPrimaryMedia(msg)?.kind ?? "document";
        let media;
        try {
          media = await resolveMedia({ ctx, maxBytes: mediaMaxBytes, ...mediaRuntimeWithAbort });
        } catch (error) {
          if (
            mediaRuntimeWithAbort.abortSignal?.aborted &&
            entry.spooledReplayParticipants.length
          ) {
            throw error;
          }
          if (!isRecoverableMediaGroupError(error)) {
            throw error;
          }
          runtime.log?.(warn(`media group: skipping photo that failed to fetch: ${String(error)}`));
          allMedia.push({ kind: nativeKind, sourceMessageId });
          selection.set(sourceMessageId, "exclude");
          skippedCount++;
          continue;
        }
        if (media) {
          allMedia.push({
            path: media.path,
            contentType: media.contentType,
            kind: media.kind,
            stickerMetadata: media.stickerMetadata,
            sourceMessageId,
          });
          materializedCount++;
          selection.set(sourceMessageId, "include");
        } else {
          allMedia.push({ kind: nativeKind, sourceMessageId });
          selection.set(sourceMessageId, "exclude");
          skippedCount++;
        }
      }
      if (skippedCount > 0) {
        const verb = skippedCount === 1 ? "was" : "were";
        await withTelegramApiErrorLogging({
          operation: "sendMessage",
          runtime,
          fn: () =>
            bot.api.sendMessage(
              primary.msg.chat.id,
              `⚠️ Received ${materializedCount} of ${entry.messages.length} images — ${skippedCount} could not be fetched and ${verb} skipped.`,
              {
                reply_parameters: {
                  message_id: primary.msg.message_id,
                  allow_sending_without_reply: true,
                },
              },
            ),
        }).catch(() => {});
      }
      const result = await processMessageWithReplyChain({
        ctx: dispatchContext,
        msg: dispatchMessage,
        allMedia,
        promptContextMessageSelection: selection,
        storeAllowFrom: entry.storeAllowFrom,
        options: {
          // Rendered link targets can expose an @username that was not visible
          // in the original caption; preserve both true and false group facts.
          ...(entry.isGroup && dispatchMessage !== primary.msg
            ? { forceWasMentioned: preserveAlbumMention }
            : {}),
          ...promptContextBoundaryOptions(
            entry.promptContextMinTimestampMs,
            entry.promptContextAmbientWatermark,
          ),
          ...spooledReplayOptions(entry.spooledReplayParticipants),
        },
        dispatchDedupeClaims: entry.dispatchDedupeClaims,
        spooledReplayParticipants: entry.spooledReplayParticipants,
      });
      settleSpooledReplayParticipants(entry.spooledReplayParticipants, result);
    } catch (error) {
      releaseDispatchDedupeClaims(entry.dispatchDedupeClaims, error);
      settleSpooledReplayParticipants(
        entry.spooledReplayParticipants,
        buildFailedProcessingResult(error),
      );
      runtime.error?.(danger(`media group handler failed: ${String(error)}`));
    }
  };
  const queueEntry = (key: string, entry: BufferedMediaGroupEntry) =>
    void queue.enqueue(key, async () => {
      await processMediaGroup(entry).catch(() => undefined);
    });

  const handleMediaGroup = (input: TelegramMediaGroupInput): boolean => {
    const mediaGroupId = input.msg.media_group_id;
    if (!mediaGroupId) {
      return false;
    }
    const threadId = input.resolvedThreadId ?? input.dmThreadId;
    const key = `media:${input.chatId}:${threadId ?? "main"}:${mediaGroupId}`;
    const existing = buffer.get(key);
    const participant = createSpooledReplayParticipantForBufferedWork(
      `media-group:${key}:${input.msg.message_id}`,
    );
    if (existing) {
      if (participant) {
        existing.spooledReplayParticipants.push(participant);
      }
      clearTimeout(existing.timer);
      existing.messages.push({ msg: input.msg, ctx: input.ctx });
      existing.promptContextMinTimestampMs = latestPromptContextMinTimestampMs(
        existing.promptContextMinTimestampMs,
        input.promptContextMinTimestampMs,
      );
      existing.promptContextAmbientWatermark = latestPromptContextAmbientWatermark(
        existing.promptContextAmbientWatermark,
        input.promptContextAmbientWatermark,
      );
      existing.dispatchDedupeClaims = mergeDispatchDedupeClaims(
        existing.dispatchDedupeClaims,
        input.dispatchDedupeClaims,
      );
      existing.timer = setTimeout(() => {
        buffer.delete(key);
        queueEntry(key, existing);
      }, timeoutMs);
      return true;
    }
    const entry: BufferedMediaGroupEntry = {
      ...input,
      messages: [{ msg: input.msg, ctx: input.ctx }],
      spooledReplayParticipants: participant ? [participant] : [],
      ...promptContextBoundaryOptions(
        input.promptContextMinTimestampMs,
        input.promptContextAmbientWatermark,
      ),
      timer: setTimeout(() => {
        buffer.delete(key);
        queueEntry(key, entry);
      }, timeoutMs),
    };
    buffer.set(key, entry);
    return true;
  };

  return { handleMediaGroup, shouldSkipMediaDownloadForUnaddressedMentionGroup };
}
