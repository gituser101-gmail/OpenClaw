import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  beginClawSetupUpdate,
  beginClawSetupState,
  markClawSetupUpdatePartial,
  markClawSetupUpdateSeedComplete,
  markClawSetupSeedComplete,
  markClawSetupStatePartial,
  readClawSetupState,
  type PersistedClawSetupState,
  type ClawSetupTargetState,
  type PersistedClawSetupPending,
} from "./setup-state.js";
import type { ClawSetupMaterialization } from "./setup.js";
import { MAX_CLAW_SETUP_RENDERED_SEED_BYTES } from "./source-limits.js";
import type { ClawAddPlan } from "./types.js";
import type { ClawUpdatePlan } from "./update-plan-types.js";

export class ClawPersonalizationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly completedDestinations: string[],
  ) {
    super(message);
    this.name = "ClawPersonalizationError";
  }
}

export async function createClawUpdatePersonalizationSeeds(
  plan: Pick<ClawUpdatePlan, "agentId" | "actions" | "setup">,
  workspacePath: string,
  materialization: ClawSetupMaterialization,
  targetState: ClawSetupTargetState,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): Promise<PersistedClawSetupPending> {
  const actions = new Map(
    plan.actions
      .filter(
        (action) =>
          action.kind === "personalizationSeed" &&
          (action.action === "add" || action.action === "change"),
      )
      .map((action) => [action.id, action] as const),
  );
  if (
    plan.setup?.targetSchemaDigest !== materialization.schemaDigest ||
    actions.size !== materialization.seeds.length
  ) {
    throw new ClawPersonalizationError(
      "setup_changed",
      "Claw personalization update changed after planning.",
      [],
    );
  }

  const initialPending = beginClawSetupUpdate(plan.agentId, targetState, options);
  if (materialization.seeds.length === 0) {
    return initialPending;
  }
  const completedDestinations: string[] = [];
  try {
    const workspaceRoot = await realpath(resolve(workspacePath));
    const workspace = await fsSafeRoot(workspaceRoot, {
      hardlinks: "reject",
      symlinks: "reject",
    });
    for (const seed of materialization.seeds) {
      const action = actions.get(seed.destination);
      if (
        !action ||
        action.blocked ||
        action.desiredDigest !== seed.digest ||
        digest(seed.content) !== seed.digest
      ) {
        throw new ClawPersonalizationError(
          "setup_changed",
          `Personalization seed ${JSON.stringify(seed.destination)} changed after planning.`,
          completedDestinations,
        );
      }
      const pending = beginClawSetupUpdate(plan.agentId, targetState, options);
      const recorded = pending.seeds.find(
        (candidate) => candidate.destination === seed.destination,
      );
      if (!recorded || recorded.renderedDigest !== seed.digest) {
        throw new ClawPersonalizationError(
          "setup_changed",
          `Personalization seed ${JSON.stringify(seed.destination)} changed pending state.`,
          completedDestinations,
        );
      }
      if (await workspace.exists(seed.destination)) {
        const current = await workspace.read(seed.destination, {
          hardlinks: "reject",
          maxBytes: MAX_CLAW_SETUP_RENDERED_SEED_BYTES,
          symlinks: "reject",
        });
        const currentDigest = digest(current.buffer);
        if (action.action === "change" && currentDigest === action.currentDigest) {
          await workspace.write(seed.destination, seed.content, { mkdir: true, overwrite: true });
        } else if (currentDigest !== seed.digest) {
          throw new ClawPersonalizationError(
            "setup_seed_collision",
            `Personalization destination ${JSON.stringify(seed.destination)} already exists.`,
            completedDestinations,
          );
        }
      } else {
        if (recorded.status === "complete" || action.action === "change") {
          throw new ClawPersonalizationError(
            "setup_seed_missing",
            `Completed personalization seed ${JSON.stringify(seed.destination)} is missing.`,
            completedDestinations,
          );
        }
        await workspace.write(seed.destination, seed.content, { mkdir: true, overwrite: false });
      }
      markClawSetupUpdateSeedComplete(plan.agentId, seed.destination, options);
      completedDestinations.push(seed.destination);
    }
    return beginClawSetupUpdate(plan.agentId, targetState, options);
  } catch (error) {
    markClawSetupUpdatePartial(plan.agentId, options);
    if (error instanceof ClawPersonalizationError) {
      throw error;
    }
    throw new ClawPersonalizationError(
      "setup_seed_failed",
      error instanceof Error ? error.message : String(error),
      completedDestinations,
    );
  }
}

function digest(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function containedRelativePath(root: string, path: string): string | undefined {
  const child = relative(root, path);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    return undefined;
  }
  return child.replaceAll(sep, "/");
}

export async function createClawPersonalizationSeeds(
  plan: ClawAddPlan,
  materialization: ClawSetupMaterialization,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): Promise<PersistedClawSetupState> {
  if (
    plan.setup?.schemaDigest !== materialization.schemaDigest ||
    plan.setup.answerDigest !== materialization.answerDigest ||
    !plan.setup.valid
  ) {
    throw new ClawPersonalizationError(
      "setup_changed",
      "Claw setup answers or schema changed after planning.",
      [],
    );
  }

  const actions = new Map(
    plan.actions
      .filter((action) => action.sourceKind === "personalizationSeed")
      .map((action) => [action.id, action] as const),
  );
  if (actions.size !== materialization.seeds.length) {
    throw new ClawPersonalizationError(
      "setup_changed",
      "Claw personalization effects changed after planning.",
      [],
    );
  }

  beginClawSetupState(plan, materialization, options);
  const completedDestinations: string[] = [];
  try {
    const workspaceRoot = await realpath(resolve(plan.agent.workspace));
    const workspace = await fsSafeRoot(workspaceRoot, {
      hardlinks: "reject",
      symlinks: "reject",
    });
    for (const seed of materialization.seeds) {
      const action = actions.get(seed.destination);
      const targetRelative = action
        ? containedRelativePath(workspaceRoot, resolve(action.target))
        : undefined;
      if (
        !action ||
        action.blocked ||
        targetRelative !== seed.destination ||
        action.digest !== seed.digest ||
        digest(seed.content) !== seed.digest
      ) {
        throw new ClawPersonalizationError(
          "setup_changed",
          `Personalization seed ${JSON.stringify(seed.destination)} changed after planning.`,
          completedDestinations,
        );
      }

      const state = readClawSetupState(plan.agent.finalId, options);
      const recorded = state?.seeds.find((candidate) => candidate.destination === seed.destination);
      if (!recorded || recorded.renderedDigest !== seed.digest) {
        throw new ClawPersonalizationError(
          "setup_changed",
          `Personalization seed ${JSON.stringify(seed.destination)} changed ownership state.`,
          completedDestinations,
        );
      }

      if (await workspace.exists(seed.destination)) {
        const current = await workspace.read(seed.destination, {
          hardlinks: "reject",
          maxBytes: MAX_CLAW_SETUP_RENDERED_SEED_BYTES,
          symlinks: "reject",
        });
        const currentDigest = digest(current.buffer);
        if (currentDigest !== seed.digest) {
          throw new ClawPersonalizationError(
            "setup_seed_collision",
            `Personalization destination ${JSON.stringify(seed.destination)} already exists.`,
            completedDestinations,
          );
        }
      } else {
        if (recorded.status === "complete") {
          throw new ClawPersonalizationError(
            "setup_seed_missing",
            `Completed personalization seed ${JSON.stringify(seed.destination)} is missing.`,
            completedDestinations,
          );
        }
        await workspace.write(seed.destination, seed.content, { mkdir: true, overwrite: false });
      }
      markClawSetupSeedComplete(plan.agent.finalId, seed.destination, options);
      completedDestinations.push(seed.destination);
    }
    const state = readClawSetupState(plan.agent.finalId, options);
    if (!state) {
      throw new Error("Claw setup state disappeared after seed creation.");
    }
    return state;
  } catch (error) {
    markClawSetupStatePartial(plan.agent.finalId, options);
    if (error instanceof ClawPersonalizationError) {
      throw error;
    }
    throw new ClawPersonalizationError(
      "setup_seed_failed",
      error instanceof Error ? error.message : String(error),
      completedDestinations,
    );
  }
}
