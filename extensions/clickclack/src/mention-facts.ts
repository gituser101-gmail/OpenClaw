/**
 * Detects whether a ClickClack group message contains a direct mention of the
 * current account.
 *
 * Pure helper – no side effects, no runtime imports.
 */

export type ClickClackMentionFacts = {
  canDetectMention: boolean;
  wasMentioned: boolean;
  hasAnyMention?: boolean;
};

/**
 * Builds mention facts for a ClickClack message.
 *
 * Rules:
 * - DMs always have canDetectMention: false, wasMentioned: false
 *   (DMs bypass mention gating).
 * - Group messages: canDetectMention: true when body text is available.
 * - Checks the message body against configured mention patterns.
 * - If botUserId is provided and the message body contains the native
 *   ClickClack user mention syntax (<@user_id>), treat it as a mention.
 * - Plain display names do not count unless explicitly configured as a pattern.
 */
export function resolveClickClackMentionFacts(params: {
  isDirect: boolean;
  body?: string;
  mentionPatterns: string[];
  botUserId?: string;
}): ClickClackMentionFacts {
  const { isDirect, body, mentionPatterns, botUserId } = params;

  if (isDirect) {
    return {
      canDetectMention: false,
      wasMentioned: false,
    };
  }

  if (!body) {
    return {
      canDetectMention: true,
      wasMentioned: false,
      hasAnyMention: false,
    };
  }

  // Check native ClickClack mention syntax: <@user_id>
  const nativeMentionPattern = botUserId ? new RegExp(`<@${escapeRegex(botUserId)}>`, "i") : null;
  const hasNativeMention = nativeMentionPattern?.test(body) ?? false;

  // Check configured mention patterns
  const hasConfiguredMention = mentionPatterns.some((pattern) => {
    try {
      const re = new RegExp(pattern, "i");
      return re.test(body);
    } catch {
      // Invalid regex pattern – ignore per spec
      return false;
    }
  });

  const wasMentioned = hasNativeMention || hasConfiguredMention;

  return {
    canDetectMention: true,
    wasMentioned,
    hasAnyMention: wasMentioned,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
