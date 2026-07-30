import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type { readClawStatus } from "./lifecycle-status.js";
import { buildClawSetupReconciliation } from "./setup-reconcile.js";
import { readClawSetupPending, readClawSetupState } from "./setup-state.js";
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
  stateOptions: OpenClawStateDatabaseOptions = {},
): Promise<{
  actions: ClawUpdateAction[];
  blockers: ClawUpdatePlan["blockers"];
  plan: ClawUpdatePlan["setup"];
}> {
  const currentSetup = readClawSetupState(record.install.agentId, stateOptions);
  const currentPending = readClawSetupPending(record.install.agentId, stateOptions);
  const reconciliation = await buildClawSetupReconciliation({
    currentManifestSchemaVersion: record.install.manifestSchemaVersion,
    currentSetup,
    currentPending,
    targetManifest: params.targetManifest,
    targetSource: params.targetSource,
    workspace: record.install.workspace,
    workspaceFiles: record.workspaceFiles,
    answers: params.answers,
  });
  const plan =
    params.targetManifest.schemaVersion === CLAW_SETUP_SCHEMA_VERSION || currentSetup
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
