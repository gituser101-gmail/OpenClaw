import { describe, expect, it } from "vitest";
import type { ClawManifestV2, ClawSourceIdentity } from "./types.js";
import { applyClawUpdatePlan, ClawUpdateMutationError } from "./update-apply.js";
import type { ClawUpdatePlan } from "./update-plan.js";

const manifest: ClawManifestV2 = {
  schemaVersion: 2,
  agent: { id: "executive-assistant" },
  workspace: { bootstrapFiles: {}, files: [] },
  packages: [],
  mcpServers: {},
  cronJobs: [],
  setup: { inputs: [] },
  personalization: { seeds: [] },
};

const source: ClawSourceIdentity = {
  kind: "development",
  name: "local:assistant",
  version: "0.0.0-development",
  packageRoot: "/tmp/assistant",
  manifestPath: "/tmp/assistant/openclaw.claw.json",
  integrityKind: "development-snapshot",
  integrity: "sha256:new",
  byteLength: 1,
};

const updatePlan: ClawUpdatePlan = {
  schemaVersion: "openclaw.clawUpdatePlan.v1",
  stability: "experimental",
  dryRun: true,
  mutationAllowed: false,
  planIntegrity: "sha256:setup-update",
  found: true,
  agentId: "executive-assistant",
  currentClaw: { name: "local:assistant", version: "1.0.0", integrity: "sha256:old" },
  targetClaw: { name: "local:assistant", version: "2.0.0", integrity: "sha256:new" },
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

describe("Claw setup update guard", () => {
  it("keeps version 2 update mutation disabled", async () => {
    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config: {},
          sourceMcpServers: {},
          consentPlanIntegrity: updatePlan.planIntegrity,
        },
      ),
    ).rejects.toMatchObject<Partial<ClawUpdateMutationError>>({
      code: "setup_mutation_unavailable",
    });
  });
});
