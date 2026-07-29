/**
 * Resolved group/channel policy for ClickClack inbound gating.
 *
 * Pure helper – no side effects, no runtime imports.
 */

export type ClickClackGroupPolicy = {
  requireMention: boolean;
  mentionPatterns: string[];
};

export type ClickClackAccountGroupPolicyParams = {
  requireMention?: boolean;
  mentionPatterns?: string[];
  groups?: Record<string, { requireMention?: boolean; mentionPatterns?: string[] }>;
};

/**
 * Resolves the effective group policy for a ClickClack channel.
 *
 * Lookup order:
 *  1. Exact channel ID in `groups`
 *  2. Wildcard `'*'` entry in `groups`
 *  3. Account-level `requireMention` / `mentionPatterns`
 *  4. Backward-compatible default: { requireMention: false, mentionPatterns: [] }
 */
export function resolveClickClackGroupPolicy(params: {
  account: ClickClackAccountGroupPolicyParams;
  channelId?: string;
}): ClickClackGroupPolicy {
  const { account, channelId } = params;
  const accountPolicy: ClickClackGroupPolicy = {
    requireMention: account.requireMention === true,
    mentionPatterns: account.mentionPatterns ?? [],
  };
  const wildcard = account.groups?.["*"];
  const channelKey = channelId?.trim();
  const exact = channelKey
    ? Object.entries(account.groups ?? {}).find(([key]) => key.trim() === channelKey)?.[1]
    : undefined;
  const override = exact ?? wildcard;

  // Channel rules are partial overrides. This lets a channel replace only its
  // mention patterns while inheriting the account-level gate, or vice versa.
  return {
    requireMention: override?.requireMention ?? accountPolicy.requireMention,
    mentionPatterns: override?.mentionPatterns ?? accountPolicy.mentionPatterns,
  };
}
