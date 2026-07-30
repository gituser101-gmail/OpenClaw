import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";
import { MAX_CLAW_SETUP_ANSWER_BYTES } from "./source-limits.js";

export class ClawAnswersError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawAnswersError";
  }
}

async function readBoundedStdin(stdin: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.byteLength;
    if (byteLength > MAX_CLAW_SETUP_ANSWER_BYTES) {
      throw new ClawAnswersError(
        "setup_answers_too_large",
        `Claw answers exceed ${MAX_CLAW_SETUP_ANSWER_BYTES} bytes.`,
      );
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, byteLength);
}

async function readBoundedFile(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)).catch(
    (error: unknown) => {
      throw new ClawAnswersError(
        "setup_answers_read_failed",
        `Could not read Claw answers from ${JSON.stringify(path)}: ${(error as Error).message}`,
      );
    },
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile()) {
      throw new ClawAnswersError(
        "setup_answers_read_failed",
        `Claw answers path must be a regular file: ${JSON.stringify(path)}.`,
      );
    }
    if (stat.size > MAX_CLAW_SETUP_ANSWER_BYTES) {
      throw new ClawAnswersError(
        "setup_answers_too_large",
        `Claw answers exceed ${MAX_CLAW_SETUP_ANSWER_BYTES} bytes.`,
      );
    }
    return await readFileDescriptorBounded(file.fd, MAX_CLAW_SETUP_ANSWER_BYTES);
  } finally {
    await file.close();
  }
}

export async function readClawAnswersDocument(
  path: string,
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<Record<string, unknown>> {
  const raw = path === "-" ? await readBoundedStdin(stdin) : await readBoundedFile(path);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch (error) {
    throw new ClawAnswersError(
      "setup_answers_invalid",
      `Claw answers must contain valid UTF-8 JSON: ${(error as Error).message}`,
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ClawAnswersError("setup_answers_invalid", "Claw answers must be a JSON object.");
  }
  return value as Record<string, unknown>;
}
