import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildClawExportAuthoring, readClawExportAuthoringDocument } from "./export-authoring.js";
import { MAX_CLAW_SETUP_SEEDS, MAX_CLAW_SETUP_TEMPLATE_BYTES } from "./source-limits.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function readDocument(root: string, value: unknown) {
  const path = join(root, "author-setup.json");
  await writeFile(path, JSON.stringify(value), "utf8");
  return await readClawExportAuthoringDocument(path);
}

function stringInput(params: {
  id: string;
  valuePolicy: "private" | "reusable-default";
  default?: string;
  sample?: string;
}) {
  return {
    definition: {
      id: params.id,
      label: params.id,
      type: "string",
      ...(params.default === undefined ? {} : { default: params.default }),
    },
    valuePolicy: params.valuePolicy,
    ...(params.sample === undefined ? {} : { sample: params.sample }),
  };
}

describe("Claw guided export authoring", () => {
  it.each([
    {
      name: "private defaults",
      input: stringInput({
        id: "owner_name",
        valuePolicy: "private",
        default: "private value",
        sample: "sample",
      }),
    },
    {
      name: "missing sample answers",
      input: stringInput({ id: "owner_name", valuePolicy: "private" }),
    },
    {
      name: "unconfirmed reusable defaults",
      input: stringInput({
        id: "timezone",
        valuePolicy: "reusable-default",
        sample: "America/Los_Angeles",
      }),
    },
  ])("rejects $name", async ({ input }) => {
    const root = tempDirs.make("openclaw-claw-export-authoring-invalid-");

    await expect(
      readDocument(root, {
        schemaVersion: 1,
        inputs: [input],
        files: [
          {
            source: "USER.md",
            destination: "USER.md",
            replacements: [{ literal: "value", occurrence: 1, input: "owner_name" }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "author_setup_invalid" });
  });

  it("selects an exact one-based literal occurrence deterministically", async () => {
    const root = tempDirs.make("openclaw-claw-export-authoring-occurrence-");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "USER.md"), "First: shared\nSecond: shared\n", "utf8");
    const document = await readDocument(root, {
      schemaVersion: 1,
      inputs: [
        stringInput({
          id: "label",
          valuePolicy: "reusable-default",
          default: "shared",
          sample: "shared",
        }),
      ],
      files: [
        {
          source: "USER.md",
          destination: "USER.md",
          replacements: [{ literal: "shared", occurrence: 2, input: "label" }],
        },
      ],
    });

    const result = await buildClawExportAuthoring({
      document,
      workspace,
      managedWorkspacePaths: new Set(),
    });

    expect(result.templates[0]?.content.toString("utf8")).toBe(
      "First: shared\nSecond: {{ input.label }}\n",
    );
  });

  it("rejects credential paths and overlapping replacement selections", async () => {
    const root = tempDirs.make("openclaw-claw-export-authoring-paths-");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, ".env"), "TOKEN=value\n", "utf8");
    const credentialDocument = await readDocument(root, {
      schemaVersion: 1,
      inputs: [stringInput({ id: "token", valuePolicy: "private", sample: "sample" })],
      files: [
        {
          source: ".env",
          destination: "USER.md",
          replacements: [{ literal: "value", occurrence: 1, input: "token" }],
        },
      ],
    });
    await expect(
      buildClawExportAuthoring({
        document: credentialDocument,
        workspace,
        managedWorkspacePaths: new Set(),
      }),
    ).rejects.toMatchObject({ code: "author_setup_path_ineligible" });

    await writeFile(join(workspace, "USER.md"), "shared\n", "utf8");
    const overlappingDocument = await readDocument(root, {
      schemaVersion: 1,
      inputs: [
        stringInput({ id: "first", valuePolicy: "private", sample: "first" }),
        stringInput({ id: "second", valuePolicy: "private", sample: "second" }),
      ],
      files: [
        {
          source: "USER.md",
          destination: "USER.md",
          replacements: [
            { literal: "shared", occurrence: 1, input: "first" },
            { literal: "shared", occurrence: 1, input: "second" },
          ],
        },
      ],
    });
    await expect(
      buildClawExportAuthoring({
        document: overlappingDocument,
        workspace,
        managedWorkspacePaths: new Set(),
      }),
    ).rejects.toMatchObject({ code: "author_setup_replacements_overlap" });
  });

  it("bounds generated template count and aggregate bytes", async () => {
    const root = tempDirs.make("openclaw-claw-export-authoring-limits-");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const input = stringInput({ id: "label", valuePolicy: "private", sample: "sample" });
    const file = (index: number) => ({
      source: "USER.md",
      destination: `USER-${index}.md`,
      replacements: [{ literal: "value", occurrence: 1, input: "label" }],
    });

    await expect(
      readDocument(root, {
        schemaVersion: 1,
        inputs: [input],
        files: Array.from({ length: MAX_CLAW_SETUP_SEEDS + 1 }, (_, index) => file(index)),
      }),
    ).rejects.toMatchObject({ code: "author_setup_invalid" });

    await writeFile(
      join(workspace, "USER.md"),
      `${"x".repeat(MAX_CLAW_SETUP_TEMPLATE_BYTES - 5)}value`,
      "utf8",
    );
    const document = await readDocument(root, {
      schemaVersion: 1,
      inputs: [input],
      files: Array.from({ length: 5 }, (_, index) => file(index)),
    });
    await expect(
      buildClawExportAuthoring({ document, workspace, managedWorkspacePaths: new Set() }),
    ).rejects.toMatchObject({ code: "author_setup_templates_too_large" });
  });
});
