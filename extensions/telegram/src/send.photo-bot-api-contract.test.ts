import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Bot } from "grammy";
import { describe, expect, it } from "vitest";
import { deliverReplies } from "./bot/delivery.js";
import { sendMessageTelegram } from "./send.js";
import type {
  TelegramIngressWorkerCommand,
  TelegramIngressWorkerMessage,
} from "./telegram-ingress-worker.js";
import { runTelegramIngressWorkerRuntime } from "./telegram-ingress-worker.runtime.js";

const PHOTO_LIMIT_BYTES = 10 * 1024 * 1024;
const BOT_TOKEN = "123456:telegram-photo-contract-proof";

type ObservedRequest = {
  method: string;
  contentType: string;
  bodyBytes: number;
  fields: Record<string, string>;
};

function readMultipartField(body: Buffer, name: string): string | undefined {
  const fieldStart = body.indexOf(`name="${name}"`);
  if (fieldStart < 0) {
    return undefined;
  }
  const valueStart = body.indexOf("\r\n\r\n", fieldStart);
  if (valueStart < 0) {
    return undefined;
  }
  const valueEnd = body.indexOf("\r\n--", valueStart + 4);
  if (valueEnd < 0) {
    return undefined;
  }
  return body.subarray(valueStart + 4, valueEnd).toString("utf8");
}

describe("Telegram photo limits over the actual Bot API transport", () => {
  it.each(["durable", "reply"] as const)(
    "delivers a polling reply as a document for an oversized %s photo",
    async (deliveryKind) => {
      const sourceImagePath = fileURLToPath(
        new URL("../../browser/chrome-extension/icons/icon32.png", import.meta.url),
      );
      const sourceImage = await readFile(sourceImagePath);
      const photo = Buffer.concat([
        sourceImage,
        Buffer.alloc(PHOTO_LIMIT_BYTES + 1 - sourceImage.byteLength),
      ]);
      const requests: ObservedRequest[] = [];
      let deliveredUpdate = false;

      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        let bodyBytes = 0;
        request.on("data", (chunk: Buffer) => {
          bodyBytes += chunk.byteLength;
          chunks.push(chunk);
        });
        request.on("end", () => {
          const method = request.url?.split("/").at(-1) ?? "";
          const body = Buffer.concat(chunks);
          const fields = Object.fromEntries(
            ["chat_id", "caption", "parse_mode", "message_thread_id", "disable_notification"]
              .map((name) => [name, readMultipartField(body, name)] as const)
              .filter((field): field is readonly [string, string] => field[1] !== undefined),
          );
          requests.push({
            method,
            contentType: request.headers["content-type"] ?? "",
            bodyBytes,
            fields,
          });
          response.setHeader("content-type", "application/json");
          if (method === "getUpdates") {
            const poll = JSON.parse(body.toString("utf8")) as {
              offset?: number;
            };
            const update =
              !deliveredUpdate && poll.offset === undefined
                ? [
                    {
                      update_id: 41,
                      message: {
                        message_id: 7,
                        date: 1,
                        chat: { id: -100123, type: "supergroup" },
                        message_thread_id: 77,
                        text: "Send the photo",
                      },
                    },
                  ]
                : [];
            deliveredUpdate ||= update.length > 0;
            response.end(JSON.stringify({ ok: true, result: update }));
            return;
          }
          if (method === "sendPhoto" && bodyBytes > PHOTO_LIMIT_BYTES) {
            response.statusCode = 400;
            response.end(
              JSON.stringify({
                ok: false,
                error_code: 400,
                description: "Bad Request: PHOTO_INVALID_DIMENSIONS or file is too big",
              }),
            );
            return;
          }
          if (method === "sendDocument") {
            response.end(
              JSON.stringify({
                ok: true,
                result: {
                  message_id: 42,
                  date: 1,
                  chat: { id: -100123, type: "supergroup" },
                  message_thread_id: 77,
                  document: { file_id: "photo-document", file_unique_id: "photo-proof" },
                },
              }),
            );
            return;
          }
          response.statusCode = 404;
          response.end(
            JSON.stringify({ ok: false, error_code: 404, description: `Unknown method ${method}` }),
          );
        });
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });

      const apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const cfg = { channels: { telegram: { botToken: BOT_TOKEN, apiRoot } } };
      const listeners = new Set<(message: TelegramIngressWorkerCommand) => void>();
      const workerMessages: TelegramIngressWorkerMessage[] = [];
      let resolveDelivery: ((messageId: string) => void) | undefined;
      let rejectDelivery: ((error: unknown) => void) | undefined;
      const delivery = new Promise<string>((resolve, reject) => {
        resolveDelivery = resolve;
        rejectDelivery = reject;
      });
      const sendCommand = (command: TelegramIngressWorkerCommand) => {
        for (const listener of listeners) {
          listener(command);
        }
      };

      const sendReply = async (): Promise<string> => {
        if (deliveryKind === "durable") {
          const result = await sendMessageTelegram("-100123:topic:77", "Photo **caption**", {
            cfg,
            mediaUrl: sourceImagePath,
            mediaLocalRoots: [dirname(sourceImagePath)],
            mediaReadFile: async () => photo,
            silent: true,
          });
          return result.messageId;
        }

        const result = await deliverReplies({
          replies: [{ text: "Photo **caption**", mediaUrl: "proof://large-photo.png" }],
          cfg,
          chatId: "-100123",
          token: BOT_TOKEN,
          runtime: {
            log: () => {},
            error: () => {},
            exit: (code) => {
              throw new Error(`Unexpected runtime exit ${code}`);
            },
          },
          bot: new Bot(BOT_TOKEN, { client: { apiRoot } }),
          mediaLoader: async () => ({
            buffer: photo,
            contentType: "image/png",
            fileName: "large-photo.png",
            kind: "image" as const,
          }),
          replyToMode: "off",
          thread: { id: 77, scope: "forum" },
          textLimit: 4_000,
          silent: true,
        });
        if (!result.delivered) {
          throw new Error("Telegram oversized photo reply was not delivered");
        }
        return "42";
      };

      const worker = runTelegramIngressWorkerRuntime({
        options: {
          token: BOT_TOKEN,
          accountId: "default",
          initialUpdateId: null,
          spoolDir: "/unused/telegram-photo-contract-proof",
          apiRoot,
          timeoutSeconds: 1,
        },
        port: {
          postMessage(message) {
            workerMessages.push(message);
            if (message.type !== "update") {
              return;
            }
            sendCommand({
              type: "spool-ack",
              requestId: message.requestId,
              result: { ok: true, updateId: 41 },
            });
            void sendReply().then(
              (messageId) => {
                resolveDelivery?.(messageId);
                sendCommand({ type: "stop" });
              },
              (error: unknown) => {
                rejectDelivery?.(error);
                sendCommand({ type: "stop" });
              },
            );
          },
          onMessage(listener) {
            listeners.add(listener);
          },
          close() {},
        },
        deps: { fetch: globalThis.fetch, closeTransport: async () => {} },
      });

      try {
        const [messageId] = await Promise.all([delivery, worker]);
        expect(messageId).toBe("42");
        expect(workerMessages).toContainEqual(
          expect.objectContaining({ type: "spooled", updateId: 41 }),
        );
        expect(requests.some((request) => request.method === "getUpdates")).toBe(true);
        expect(requests.some((request) => request.method === "sendPhoto")).toBe(false);
        const document = requests.find((request) => request.method === "sendDocument");
        expect(document?.contentType).toContain("multipart/form-data");
        expect(document?.bodyBytes).toBeGreaterThan(PHOTO_LIMIT_BYTES);
        expect(document?.fields).toEqual({
          chat_id: "-100123",
          caption: "Photo <b>caption</b>",
          parse_mode: "HTML",
          message_thread_id: "77",
          disable_notification: "true",
        });
      } finally {
        sendCommand({ type: "stop" });
        server.closeIdleConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
    30_000,
  );
});
