import type { ChannelMessageUnknownSendContext } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Imessage tests cover unknown-send reconciliation for durable delivery (#115328).
import { describe, expect, it, vi } from "vitest";
import { reconcileIMessageUnknownSend } from "./send.js";

const IMESSAGE_TEST_CFG = {
  channels: {
    imessage: {
      accounts: {
        default: {},
      },
    },
  },
} as unknown as OpenClawConfig;

function createCtx(overrides?: Partial<ChannelMessageUnknownSendContext>) {
  return {
    cfg: IMESSAGE_TEST_CFG,
    queueId: "queue-1",
    channel: "imessage",
    to: "chat_id:42",
    enqueuedAt: 1_000_000,
    retryCount: 0,
    payloads: [{ text: "hello from the grid" }],
    ...overrides,
  } satisfies ChannelMessageUnknownSendContext;
}

describe("reconcileIMessageUnknownSend", () => {
  it("acks the delivery as sent when chat.db yields a matching guid", async () => {
    const resolveSentMessageGuidImpl = vi.fn(async () => "p:0/guid-1");
    const result = await reconcileIMessageUnknownSend(createCtx(), {
      resolveSentMessageGuidImpl,
    });
    expect(result?.status).toBe("sent");
    if (result?.status === "sent") {
      expect(result.messageId).toBe("p:0/guid-1");
      expect(result.receipt).toBeDefined();
    }
    expect(resolveSentMessageGuidImpl).toHaveBeenCalledWith({
      dbPath: expect.anything(),
      target: expect.objectContaining({ kind: "chat_id", chatId: 42 }),
      text: "hello from the grid",
      sentAfterMs: 1_000_000 - 60_000,
    });
  });

  it("prefers platformSendStartedAt over enqueuedAt for the lookup window", async () => {
    const resolveSentMessageGuidImpl = vi.fn(async () => "p:0/guid-2");
    await reconcileIMessageUnknownSend(createCtx({ platformSendStartedAt: 2_000_000 }), {
      resolveSentMessageGuidImpl,
    });
    expect(resolveSentMessageGuidImpl).toHaveBeenCalledWith(
      expect.objectContaining({ sentAfterMs: 2_000_000 - 60_000 }),
    );
  });

  it("stays fail-closed as retryable unresolved when no matching row exists", async () => {
    const resolveSentMessageGuidImpl = vi.fn(async () => null);
    const result = await reconcileIMessageUnknownSend(createCtx(), {
      resolveSentMessageGuidImpl,
    });
    expect(result).toEqual({
      status: "unresolved",
      error: expect.stringContaining("no matching is_from_me iMessage row"),
      retryable: true,
    });
  });

  it("requires every payload in the batch to match before acking", async () => {
    const resolveSentMessageGuidImpl = vi.fn(async (params: { text: string }) =>
      params.text === "first" ? "p:0/guid-first" : null,
    );
    const result = await reconcileIMessageUnknownSend(
      createCtx({ payloads: [{ text: "first" }, { text: "second" }] }),
      { resolveSentMessageGuidImpl },
    );
    expect(result?.status).toBe("unresolved");
  });

  it("acks multi-payload batches when every payload matches", async () => {
    const resolveSentMessageGuidImpl = vi.fn(
      async (params: { text: string }) => `p:0/guid-${params.text}`,
    );
    const result = await reconcileIMessageUnknownSend(
      createCtx({ payloads: [{ text: "first" }, { text: "second" }] }),
      { resolveSentMessageGuidImpl },
    );
    expect(result?.status).toBe("sent");
    if (result?.status === "sent") {
      expect(result.messageId).toBe("p:0/guid-second");
    }
  });

  it("returns null for media-bearing payloads (not provable via text lookup)", async () => {
    const resolveSentMessageGuidImpl = vi.fn(async () => "p:0/guid-1");
    const result = await reconcileIMessageUnknownSend(
      createCtx({ payloads: [{ text: "caption", mediaUrl: "https://example.com/x.png" }] }),
      { resolveSentMessageGuidImpl },
    );
    expect(result).toBeNull();
    expect(resolveSentMessageGuidImpl).not.toHaveBeenCalled();
  });

  it("reports unresolved when chat.db is unavailable (remote cliPath wrapper)", async () => {
    const result = await reconcileIMessageUnknownSend(
      createCtx({
        cfg: {
          channels: {
            imessage: {
              accounts: {
                default: { cliPath: "/opt/remote-imsg-ssh" },
              },
            },
          },
        } as unknown as OpenClawConfig,
      }),
    );
    expect(result).toEqual({
      status: "unresolved",
      error: expect.stringContaining("requires a readable chat.db"),
      retryable: true,
    });
  });
});
