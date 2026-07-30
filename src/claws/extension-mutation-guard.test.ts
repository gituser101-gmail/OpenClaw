import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { applyClawAddPlan, ClawAddMutationError } from "./add.js";
import { buildClawAddPlan } from "./lifecycle.js";
import type { ClawManifestV2, ClawOpenClawProfileV2, ClawSourceIdentity } from "./types.js";
import { applyClawUpdatePlan, ClawUpdateMutationError } from "./update-apply.js";
import type { ClawUpdatePlan } from "./update-plan.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const manifest: ClawManifestV2 = {
  schemaVersion: 2,
  agent: { id: "application" },
  workspace: { bootstrapFiles: {}, files: [] },
  packages: [],
  mcpServers: {},
  cronJobs: [],
  setup: { inputs: [] },
  personalization: { seeds: [] },
};

const profile: ClawOpenClawProfileV2 = {
  schemaVersion: 2,
  agent: {},
  extensions: [
    {
      id: "tools",
      kind: "plugin",
      format: "claude",
      source: "clawhub",
      ref: "@acme/tools",
      version: "1.0.0",
    },
  ],
};

function source(root: string): ClawSourceIdentity {
  return {
    kind: "development",
    name: "local:application",
    version: "0.0.0-development",
    packageRoot: root,
    manifestPath: join(root, "CLAW.md"),
    integrityKind: "development-snapshot",
    integrity: "sha256:application",
    byteLength: 1,
  };
}

describe("Claw extension mutation guard", () => {
  it("keeps extension add mutation disabled after successful preview", async () => {
    const root = tempDirs.make("openclaw-claw-extension-add-");
    const plan = await buildClawAddPlan({
      manifest,
      openClawProfile: profile,
      source: source(root),
      context: {
        workspace: join(root, "workspace"),
        packagePreflight: async () => ({
          ok: true,
          action: "install",
          detectedFormat: "claude",
          mapped: ["skills"],
          unavailable: [],
          adapterIdentity: "openclaw/test",
        }),
      },
    });
    expect(plan.blockers).toEqual([]);

    await expect(
      applyClawAddPlan(plan, { consentPlanIntegrity: plan.planIntegrity }),
    ).rejects.toMatchObject<Partial<ClawAddMutationError>>({
      code: "extension_mutation_unavailable",
    });
  });

  it("keeps extension update mutation disabled before state access", async () => {
    const plan: ClawUpdatePlan = {
      schemaVersion: "openclaw.clawUpdatePlan.v1",
      stability: "experimental",
      dryRun: true,
      mutationAllowed: false,
      planIntegrity: "sha256:extension-update",
      found: true,
      agentId: "application",
      currentClaw: { name: "local:application", version: "1.0.0", integrity: "sha256:old" },
      targetClaw: { name: "local:application", version: "2.0.0", integrity: "sha256:new" },
      summary: {
        totalActions: 0,
        added: 0,
        changed: 0,
        removed: 0,
        released: 0,
        unchanged: 0,
        manual: 0,
        blocked: 0,
        capabilityChanges: 0,
        capabilityEscalations: 0,
      },
      actions: [],
      capabilityChanges: [],
      blockers: [],
      diagnostics: [],
    };

    await expect(
      applyClawUpdatePlan(
        plan,
        { targetManifest: manifest, targetOpenClawProfile: profile, targetSource: source("/tmp") },
        { config: {}, sourceMcpServers: {}, consentPlanIntegrity: plan.planIntegrity },
      ),
    ).rejects.toMatchObject<Partial<ClawUpdateMutationError>>({
      code: "extension_mutation_unavailable",
    });
  });
});
