import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ClawOpenClawExtension, ClawOpenClawProfile } from "./types.js";

type AgentConfig = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];

export function portableOpenClawProfile(
  agent: AgentConfig,
  extensions: ClawOpenClawExtension[],
): ClawOpenClawProfile | undefined {
  const tools = {
    ...(agent.tools?.profile ? { profile: agent.tools.profile } : {}),
    ...(agent.tools?.allow?.length ? { allow: agent.tools.allow } : {}),
    ...(agent.tools?.alsoAllow?.length ? { alsoAllow: agent.tools.alsoAllow } : {}),
    ...(agent.tools?.deny?.length ? { deny: agent.tools.deny } : {}),
    ...(agent.tools?.fs?.workspaceOnly === true ? { fs: { workspaceOnly: true as const } } : {}),
  };
  const settings = {
    ...(agent.groupChat?.mentionPatterns?.length
      ? { groupChat: { mentionPatterns: agent.groupChat.mentionPatterns } }
      : {}),
    ...(agent.sandbox
      ? {
          sandbox: {
            ...(agent.sandbox.mode ? { mode: agent.sandbox.mode } : {}),
            ...(agent.sandbox.scope ? { scope: agent.sandbox.scope } : {}),
            ...(agent.sandbox.workspaceAccess
              ? { workspaceAccess: agent.sandbox.workspaceAccess }
              : {}),
          },
        }
      : {}),
    ...(Object.keys(tools).length > 0 ? { tools } : {}),
    ...(agent.memory?.search
      ? {
          memory: {
            search: {
              ...(agent.memory.search.enabled !== undefined
                ? { enabled: agent.memory.search.enabled }
                : {}),
              ...(agent.memory.search.rememberAcrossConversations !== undefined
                ? {
                    rememberAcrossConversations: agent.memory.search.rememberAcrossConversations,
                  }
                : {}),
              ...(agent.memory.search.sources?.length
                ? { sources: agent.memory.search.sources }
                : {}),
            },
          },
        }
      : {}),
    ...(agent.heartbeat
      ? {
          heartbeat: {
            ...(agent.heartbeat.every ? { every: agent.heartbeat.every } : {}),
            ...(agent.heartbeat.activeHours
              ? {
                  activeHours: {
                    ...(agent.heartbeat.activeHours.start
                      ? { start: agent.heartbeat.activeHours.start }
                      : {}),
                    ...(agent.heartbeat.activeHours.end
                      ? { end: agent.heartbeat.activeHours.end }
                      : {}),
                    ...(agent.heartbeat.activeHours.timezone
                      ? { timezone: agent.heartbeat.activeHours.timezone }
                      : {}),
                  },
                }
              : {}),
            ...(agent.heartbeat.lightContext !== undefined
              ? { lightContext: agent.heartbeat.lightContext }
              : {}),
            ...(agent.heartbeat.isolatedSession !== undefined
              ? { isolatedSession: agent.heartbeat.isolatedSession }
              : {}),
            ...(agent.heartbeat.timeoutSeconds !== undefined
              ? { timeoutSeconds: agent.heartbeat.timeoutSeconds }
              : {}),
          },
        }
      : {}),
    ...(agent.humanDelay
      ? {
          humanDelay: {
            ...(agent.humanDelay.mode ? { mode: agent.humanDelay.mode } : {}),
            ...(agent.humanDelay.minMs !== undefined ? { minMs: agent.humanDelay.minMs } : {}),
            ...(agent.humanDelay.maxMs !== undefined ? { maxMs: agent.humanDelay.maxMs } : {}),
          },
        }
      : {}),
  };
  return extensions.length > 0
    ? { schemaVersion: 2, agent: settings, extensions }
    : Object.keys(settings).length > 0
      ? { schemaVersion: 1, agent: settings }
      : undefined;
}
