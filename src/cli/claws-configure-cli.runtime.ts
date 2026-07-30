import { ClawAnswersError, readClawAnswersDocument } from "../claws/answers.js";
import {
  applyClawConfigurePlan,
  buildClawConfigurePlan,
  CLAW_CONFIGURE_PLAN_SCHEMA_VERSION,
  CLAW_CONFIGURE_RESULT_SCHEMA_VERSION,
  ClawConfigureError,
} from "../claws/configure.js";
import { assertExperimentalClawsEnabled } from "../claws/experimental.js";
import { readClawStatus } from "../claws/lifecycle-status.js";
import { readClawManifestFile } from "../claws/reader.js";
import { CLAW_OUTPUT_STABILITY } from "../claws/types.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import type { ClawsConfigureOptions } from "./claws-cli.js";

export async function runClawsConfigureCommand(
  target: string,
  opts: ClawsConfigureOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  if (!opts.dryRun && (!opts.yes || !opts.planIntegrity)) {
    runtime.error(
      "Claw configure requires explicit consent; use --dry-run or --yes with --plan-integrity.",
    );
    runtime.exit(1);
    return;
  }
  const listedMcpServers = await listConfiguredMcpServers();
  if (!listedMcpServers.ok) {
    runtime.error(listedMcpServers.error);
    runtime.exit(1);
    return;
  }
  const status = await readClawStatus(target, {
    config: listedMcpServers.config,
    sourceMcpServers: listedMcpServers.mcpServers,
  });
  if (status.records.length !== 1) {
    runtime.error(
      status.records.length === 0
        ? `No installed Claw matches ${JSON.stringify(target)}.`
        : `Claw name ${JSON.stringify(target)} matches multiple agents; use an agent id.`,
    );
    runtime.exit(1);
    return;
  }
  const recorded = status.records[0]!.install.claw;
  const source = recorded.kind === "package" ? recorded.packageRoot : recorded.manifestPath;
  const loaded = await readClawManifestFile(source);
  if (!loaded.ok) {
    runtime.error(
      `The recorded Claw source is unavailable; configure requires the exact installed package.`,
    );
    runtime.exit(1);
    return;
  }
  let answers: Record<string, unknown> | undefined;
  if (opts.answers) {
    try {
      answers = await readClawAnswersDocument(opts.answers);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (opts.json) {
        writeRuntimeJson(runtime, {
          schemaVersion: CLAW_CONFIGURE_PLAN_SCHEMA_VERSION,
          stability: CLAW_OUTPUT_STABILITY,
          error: {
            code: error instanceof ClawAnswersError ? error.code : "setup_answers_read_failed",
            message,
          },
        });
      } else {
        runtime.error(message);
      }
      runtime.exit(1);
      return;
    }
  }
  const params = {
    target,
    manifest: loaded.manifest,
    source: loaded.source,
    config: listedMcpServers.config,
    sourceMcpServers: listedMcpServers.mcpServers,
    answers,
    regenerateSeeds: opts.regenerate,
  };
  const plan = await buildClawConfigurePlan(params);
  if (opts.dryRun || plan.blockers.length > 0 || plan.actions.some((action) => action.blocked)) {
    if (opts.json) {
      writeRuntimeJson(runtime, plan);
    } else {
      runtime.log(`Experimental Claw configure plan: ${plan.actions.length} actions`);
      runtime.log(`Plan integrity: ${plan.planIntegrity}`);
      for (const action of plan.actions) {
        runtime.log(`  ${action.id}: ${action.action}`);
      }
      for (const blocker of plan.blockers) {
        runtime.error(`${blocker.code}: ${blocker.message}`);
      }
    }
    if (plan.blockers.length > 0 || plan.actions.some((action) => action.blocked)) {
      runtime.exit(1);
    }
    return;
  }
  try {
    const result = await applyClawConfigurePlan(
      plan,
      {
        manifest: loaded.manifest,
        source: loaded.source,
        config: listedMcpServers.config,
        sourceMcpServers: listedMcpServers.mcpServers,
        answers,
        regenerateSeeds: opts.regenerate,
      },
      { consentPlanIntegrity: opts.planIntegrity },
    );
    if (opts.json) {
      writeRuntimeJson(runtime, result);
    } else {
      runtime.log(`Configured Claw agent: ${result.agentId}`);
      runtime.log(`Applied personalization effects: ${result.appliedActions.length}`);
    }
  } catch (error) {
    const code = error instanceof ClawConfigureError ? error.code : "configure_failed";
    const message = error instanceof Error ? error.message : String(error);
    if (opts.json) {
      writeRuntimeJson(runtime, {
        schemaVersion: CLAW_CONFIGURE_RESULT_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        status: code === "configure_partial" ? "partial" : "failed",
        error: { code, message },
      });
    } else {
      runtime.error(message);
    }
    runtime.exit(1);
  }
}
