import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import { portableClawPathKey, isSafeClawRelativePath } from "./schema-portability.js";
import { clawSetupInputSchema } from "./setup-schema.js";
import {
  MAX_CLAW_EXPORT_AUTHORING_BYTES,
  MAX_CLAW_SETUP_RENDERED_BYTES,
  MAX_CLAW_SETUP_SEEDS,
  MAX_CLAW_SETUP_TEMPLATE_BYTES,
} from "./source-limits.js";
import type { ClawManifestV2, ClawSetupInput } from "./types.js";

const nonEmptyString = z.string().min(1);
const portablePath = nonEmptyString.refine(isSafeClawRelativePath, {
  message: "Path must be package-relative and must not contain traversal segments.",
});
const authoringInputSchema = z
  .object({
    definition: clawSetupInputSchema,
    valuePolicy: z.enum(["private", "reusable-default"]),
    sample: z
      .unknown()
      .refine(
        (value) => value !== undefined,
        "Every authoring input must declare a sample answer.",
      ),
  })
  .strict()
  .superRefine((input, ctx) => {
    const hasDefault = input.definition.default !== undefined;
    if (input.valuePolicy === "private" && hasDefault) {
      ctx.addIssue({
        code: "custom",
        path: ["definition", "default"],
        message: "Private author values cannot become package defaults.",
      });
    }
    if (input.valuePolicy === "reusable-default" && !hasDefault) {
      ctx.addIssue({
        code: "custom",
        path: ["definition", "default"],
        message: "A reusable-default input must declare the reviewed package default.",
      });
    }
  });
const authoringReplacementSchema = z
  .object({
    literal: nonEmptyString,
    occurrence: z.number().int().positive(),
    input: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  })
  .strict();
const authoringFileSchema = z
  .object({
    source: portablePath,
    destination: portablePath,
    replacements: z.array(authoringReplacementSchema).min(1),
  })
  .strict();
const authoringDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    inputs: z.array(authoringInputSchema).min(1),
    files: z.array(authoringFileSchema).min(1).max(MAX_CLAW_SETUP_SEEDS),
  })
  .strict();

export type ClawExportAuthoringDocument = z.infer<typeof authoringDocumentSchema>;

export type ClawExportAuthoringResult = {
  inputs: ClawSetupInput[];
  samples: Record<string, unknown>;
  templates: Array<{
    source: string;
    destination: string;
    content: Buffer;
    inputIds: string[];
  }>;
  privateLiterals: string[];
  inputReview: Array<{ id: string; valuePolicy: "private" | "reusable-default" }>;
};

export class ClawExportAuthoringError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawExportAuthoringError";
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "$"}: ${issue.message}`)
    .join("; ");
}

export async function readClawExportAuthoringDocument(
  path: string,
): Promise<ClawExportAuthoringDocument> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)).catch(
    (error: unknown) => {
      throw new ClawExportAuthoringError(
        "author_setup_read_failed",
        `Could not read Claw export authoring document: ${(error as Error).message}`,
      );
    },
  );
  let raw: Buffer;
  try {
    const stat = await file.stat();
    if (!stat.isFile()) {
      throw new ClawExportAuthoringError(
        "author_setup_read_failed",
        "Claw export authoring document must be a regular file.",
      );
    }
    if (stat.size > MAX_CLAW_EXPORT_AUTHORING_BYTES) {
      throw new ClawExportAuthoringError(
        "author_setup_too_large",
        `Claw export authoring document exceeds ${MAX_CLAW_EXPORT_AUTHORING_BYTES} bytes.`,
      );
    }
    raw = await readFileDescriptorBounded(file.fd, MAX_CLAW_EXPORT_AUTHORING_BYTES);
  } finally {
    await file.close();
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch (error) {
    throw new ClawExportAuthoringError(
      "author_setup_invalid",
      `Claw export authoring document must contain valid UTF-8 JSON: ${(error as Error).message}`,
    );
  }
  const parsed = authoringDocumentSchema.safeParse(value);
  if (!parsed.success) {
    throw new ClawExportAuthoringError(
      "author_setup_invalid",
      `Invalid Claw export authoring document: ${formatZodError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function isIneligibleAuthoringPath(path: string): boolean {
  const parts = path.replaceAll("\\", "/").toLowerCase().split("/");
  const name = parts.at(-1) ?? "";
  return (
    parts.includes(".git") ||
    parts.includes(".openclaw") ||
    parts.includes("credentials") ||
    name === "bootstrap.md" ||
    name === "openclaw.json" ||
    name === "auth-profiles.json" ||
    name === "credentials.json" ||
    name === "secrets.json" ||
    name === ".env" ||
    name.startsWith(".env.")
  );
}

function occurrenceOffsets(content: string, literal: string): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  while (cursor <= content.length - literal.length) {
    const offset = content.indexOf(literal, cursor);
    if (offset < 0) {
      break;
    }
    offsets.push(offset);
    cursor = offset + literal.length;
  }
  return offsets;
}

function templatePath(index: number): string {
  return `setup/seed-${String(index + 1).padStart(3, "0")}.tmpl`;
}

export async function buildClawExportAuthoring(params: {
  document: ClawExportAuthoringDocument;
  workspace: string;
  managedWorkspacePaths: ReadonlySet<string>;
}): Promise<ClawExportAuthoringResult> {
  const inputs = new Map<string, (typeof params.document.inputs)[number]>();
  for (const entry of params.document.inputs) {
    if (inputs.has(entry.definition.id)) {
      throw new ClawExportAuthoringError(
        "author_setup_duplicate_input",
        `Setup input ${JSON.stringify(entry.definition.id)} is declared more than once.`,
      );
    }
    inputs.set(entry.definition.id, entry);
  }

  const destinations = new Set<string>();
  const referencedInputs = new Set<string>();
  const privateLiterals = new Set<string>();
  const workspace = await fsSafeRoot(params.workspace, {
    hardlinks: "reject",
    symlinks: "reject",
  });
  const templates: ClawExportAuthoringResult["templates"] = [];
  let templateBytes = 0;
  for (const [fileIndex, file] of params.document.files.entries()) {
    const sourceKey = portableClawPathKey(file.source);
    const destinationKey = portableClawPathKey(file.destination);
    if (isIneligibleAuthoringPath(file.source) || isIneligibleAuthoringPath(file.destination)) {
      throw new ClawExportAuthoringError(
        "author_setup_path_ineligible",
        `Authoring source and destination must not be bootstrap, owner configuration, or credential paths: ${JSON.stringify(file.source)} -> ${JSON.stringify(file.destination)}.`,
      );
    }
    if (params.managedWorkspacePaths.has(sourceKey)) {
      throw new ClawExportAuthoringError(
        "author_setup_source_managed",
        `Authoring source ${JSON.stringify(file.source)} is already managed by the Claw; select a user-owned workspace file.`,
      );
    }
    if (destinations.has(destinationKey)) {
      throw new ClawExportAuthoringError(
        "author_setup_destination_duplicate",
        `Personalization destination ${JSON.stringify(file.destination)} is declared more than once.`,
      );
    }
    destinations.add(destinationKey);
    const read = await workspace
      .read(file.source, {
        hardlinks: "reject",
        maxBytes: MAX_CLAW_SETUP_TEMPLATE_BYTES,
        nonBlockingRead: true,
        symlinks: "reject",
      })
      .catch(() => {
        throw new ClawExportAuthoringError(
          "author_setup_source_invalid",
          `Authoring source ${JSON.stringify(file.source)} must be a bounded regular file inside the agent workspace.`,
        );
      });
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(read.buffer);
    } catch {
      throw new ClawExportAuthoringError(
        "author_setup_source_invalid_utf8",
        `Authoring source ${JSON.stringify(file.source)} must contain valid UTF-8.`,
      );
    }
    const spans = file.replacements.map((replacement, replacementIndex) => {
      const input = inputs.get(replacement.input);
      if (!input) {
        throw new ClawExportAuthoringError(
          "author_setup_input_unknown",
          `Replacement ${fileIndex + 1}.${replacementIndex + 1} references undeclared input ${JSON.stringify(replacement.input)}.`,
        );
      }
      const offsets = occurrenceOffsets(content, replacement.literal);
      const start = offsets[replacement.occurrence - 1];
      if (start === undefined) {
        throw new ClawExportAuthoringError(
          "author_setup_literal_missing",
          `Authoring source ${JSON.stringify(file.source)} does not contain occurrence ${replacement.occurrence} of the selected literal.`,
        );
      }
      referencedInputs.add(replacement.input);
      if (input.valuePolicy === "private") {
        privateLiterals.add(replacement.literal);
      }
      return {
        start,
        end: start + replacement.literal.length,
        inputId: replacement.input,
      };
    });
    spans.sort((left, right) => left.start - right.start || left.end - right.end);
    for (let index = 1; index < spans.length; index += 1) {
      if (spans[index]!.start < spans[index - 1]!.end) {
        throw new ClawExportAuthoringError(
          "author_setup_replacements_overlap",
          `Selected replacements overlap in ${JSON.stringify(file.source)}.`,
        );
      }
    }
    let cursor = 0;
    let rendered = "";
    for (const span of spans) {
      rendered += content.slice(cursor, span.start);
      rendered += `{{ input.${span.inputId} }}`;
      cursor = span.end;
    }
    rendered += content.slice(cursor);
    const templateContent = Buffer.from(rendered, "utf8");
    templateBytes += templateContent.byteLength;
    if (templateBytes > MAX_CLAW_SETUP_RENDERED_BYTES) {
      throw new ClawExportAuthoringError(
        "author_setup_templates_too_large",
        `Generated setup templates exceed ${MAX_CLAW_SETUP_RENDERED_BYTES} aggregate bytes.`,
      );
    }
    templates.push({
      source: templatePath(fileIndex),
      destination: file.destination,
      content: templateContent,
      inputIds: [...new Set(spans.map((span) => span.inputId))],
    });
  }
  const unused = [...inputs.keys()].filter((id) => !referencedInputs.has(id));
  if (unused.length > 0) {
    throw new ClawExportAuthoringError(
      "author_setup_input_unused",
      `Every authoring input must be used by a selected replacement: ${unused.join(", ")}.`,
    );
  }
  return {
    inputs: params.document.inputs.map((entry) => entry.definition as ClawSetupInput),
    samples: Object.fromEntries(
      params.document.inputs.map((entry) => [entry.definition.id, entry.sample]),
    ),
    templates,
    privateLiterals: [...privateLiterals],
    inputReview: params.document.inputs.map((entry) => ({
      id: entry.definition.id,
      valuePolicy: entry.valuePolicy,
    })),
  };
}

export function assertPrivateAuthorValuesAbsent(params: {
  privateLiterals: readonly string[];
  files: ReadonlyArray<{ path: string; content: Buffer }>;
}): void {
  for (const literal of params.privateLiterals) {
    const bytes = Buffer.from(literal, "utf8");
    const leaked = params.files.find((file) => file.content.includes(bytes));
    if (leaked) {
      throw new ClawExportAuthoringError(
        "author_setup_private_value_leaked",
        `A value marked private remains in generated package file ${JSON.stringify(leaked.path)}. Select every occurrence or remove the value before export.`,
      );
    }
  }
}

export function buildGuidedManifestSetup(
  result: ClawExportAuthoringResult,
): Pick<ClawManifestV2, "setup" | "personalization"> {
  return {
    setup: { inputs: result.inputs },
    personalization: {
      seeds: result.templates.map((template) => ({
        source: template.source,
        destination: template.destination,
      })),
    },
  };
}

export function digestAuthoringContent(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
