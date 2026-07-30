import type { readClawStatus } from "./lifecycle-status.js";
import { buildClawSetupReconciliation } from "./setup-reconcile.js";
import { CLAW_SETUP_SCHEMA_VERSION, type ClawManifest, type ClawSourceIdentity } from "./types.js";
import type { ClawUpdateAction, ClawUpdatePlan } from "./update-plan-types.js";

type ClawStatusRecord = Awaited<ReturnType<typeof readClawStatus>>["records"][number];

export async function buildClawUpdateSetupPlan(
  record: ClawStatusRecord,
  params: {
    targetManifest: ClawManifest;
    targetSource: ClawSourceIdentity;
    answers?: unknown;
  },
): Promise<{
  actions: ClawUpdateAction[];
  blockers: ClawUpdatePlan["blockers"];
  plan: ClawUpdatePlan["setup"];
}> {
  const reconciliation = await buildClawSetupReconciliation({
    currentManifestSchemaVersion: record.install.manifestSchemaVersion,
    currentSetup: record.setup,
    currentPending: record.setupUpdate,
    targetManifest: params.targetManifest,
    targetSource: params.targetSource,
    workspace: record.install.workspace,
    workspaceFiles: record.workspaceFiles,
    answers: params.answers,
  });
  const plan =
    params.targetManifest.schemaVersion === CLAW_SETUP_SCHEMA_VERSION || record.setup
      ? {
          currentSchemaDigest: reconciliation.currentSchemaDigest,
          targetSchemaDigest: reconciliation.targetSchemaDigest,
          answerDigest: reconciliation.answerDigest,
          createdSeeds: reconciliation.createdSeeds,
          regeneratedSeeds: reconciliation.regeneratedSeeds,
          preservedSeeds: reconciliation.preservedSeeds,
          releasedSeeds: reconciliation.releasedSeeds,
        }
      : undefined;
  return { actions: reconciliation.actions, blockers: reconciliation.blockers, plan };
}
