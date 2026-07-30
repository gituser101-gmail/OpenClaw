import { listAgentEntries } from "../agents/agent-scope.js";
import { stableStringify } from "../agents/stable-stringify.js";
import { getRuntimeConfig } from "../config/config.js";
import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { readClawCronRefs, type PersistedClawCronRef } from "./cron.js";
import { digestClawAgentConfig } from "./lifecycle-config-removal.js";
import {
  ClawRemoveError,
  inspectClawWorkspaceFile,
  readAllClawWorkspaceFiles,
  synthesizeOrphanInstall,
  type ClawManagedFileStatus,
} from "./lifecycle-delete-support.js";
import {
  digestClawMcpServer,
  readClawMcpServerRefs,
  reconcileClawMcpServerRefs,
  type PersistedClawMcpServerRef,
} from "./mcp.js";
import {
  inspectClawPackage,
  type ClawPackageInspection,
  type PackageRemovalDeps,
} from "./package-remove.js";
import { preflightClawPackage } from "./packages.js";
import {
  readClawInstallRecords,
  readClawPackageRefs,
  type PersistedClawInstall,
  type PersistedClawPackageRef,
} from "./provenance.js";
import {
  readClawSetupPending,
  readClawSetupState,
  type PersistedClawSetupPending,
  type PersistedClawSetupState,
} from "./setup-state.js";
import {
  CLAW_OUTPUT_STABILITY,
  CLAW_SETUP_SCHEMA_VERSION,
  type ClawPackagePreflight,
} from "./types.js";
import { readClawWorkspaceFiles } from "./workspace.js";

const CLAW_STATUS_SCHEMA_VERSION = "openclaw.clawStatus.v1" as const;

type ClawMcpServerStatus = PersistedClawMcpServerRef & {
  state: "present" | "modified" | "missing" | "pending" | "failed";
};

export type ClawPackageStatus = ClawPackageInspection & {
  extensionCompatibility?: {
    state: "compatible" | "drifted" | "unavailable";
    detectedFormat?: NonNullable<ClawPackageInspection["extension"]>["detectedFormat"];
    mapped: string[];
    unavailable: string[];
    adapterIdentity?: string;
    message?: string;
  };
};

async function inspectClawPackageCompatibility(params: {
  install: PersistedClawInstall;
  packageRef: PersistedClawPackageRef;
  packageDeps?: PackageRemovalDeps;
  packagePreflight: ClawPackagePreflight;
}): Promise<ClawPackageStatus> {
  const inspected: ClawPackageStatus = await inspectClawPackage(
    params.install,
    params.packageRef,
    params.packageDeps,
  );
  if (!params.packageRef.extension || inspected.state !== "present") {
    return inspected;
  }
  const preflight = await params.packagePreflight(params.packageRef, params.install.workspace);
  if (!preflight.ok) {
    inspected.extensionCompatibility = {
      state: "unavailable",
      mapped: [],
      unavailable: [],
      message: preflight.message ?? "Canonical extension inspection is unavailable.",
    };
    return inspected;
  }
  const current = {
    detectedFormat: preflight.detectedFormat,
    mapped: preflight.mapped ?? [],
    unavailable: preflight.unavailable ?? [],
    adapterIdentity: preflight.adapterIdentity,
  };
  const recorded = {
    detectedFormat: params.packageRef.extension.detectedFormat,
    mapped: params.packageRef.extension.mapped,
    unavailable: params.packageRef.extension.unavailable,
    adapterIdentity: params.packageRef.extension.adapterIdentity,
  };
  inspected.extensionCompatibility = {
    state: stableStringify(current) === stableStringify(recorded) ? "compatible" : "drifted",
    ...(preflight.detectedFormat ? { detectedFormat: preflight.detectedFormat } : {}),
    mapped: current.mapped,
    unavailable: current.unavailable,
    ...(preflight.adapterIdentity ? { adapterIdentity: preflight.adapterIdentity } : {}),
  };
  return inspected;
}

export type ClawStatusRecord = {
  install: PersistedClawInstall;
  orphaned?: boolean;
  agentState: "present" | "modified" | "missing";
  workspaceFiles: ClawManagedFileStatus[];
  packages: ClawPackageStatus[];
  mcpServers: ClawMcpServerStatus[];
  cronJobs: PersistedClawCronRef[];
  setup?: PersistedClawSetupState;
  setupUpdate?: PersistedClawSetupPending;
};

type ClawStatusResult = {
  schemaVersion: typeof CLAW_STATUS_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  target?: string;
  records: ClawStatusRecord[];
  summary: {
    claws: number;
    partial: number;
    missingAgents: number;
    driftedFiles: number;
    packageRefs: number;
    missingPackages: number;
    driftedPackages: number;
    unavailableExtensions: number;
    incompletePackages: number;
    mcpServerRefs: number;
    driftedMcpServers: number;
    unresolvedMcpServerRefs: number;
    cronRefs: number;
    unresolvedCronRefs: number;
    personalizationSeeds: number;
    incompleteSetup: number;
  };
};

function inspectMcpServer(
  ref: PersistedClawMcpServerRef,
  configuredServers: Record<string, Record<string, unknown>>,
): ClawMcpServerStatus {
  if (ref.status === "pending" || ref.status === "failed") {
    return { ...ref, state: ref.status };
  }
  const server = configuredServers[ref.name];
  if (!server) {
    return { ...ref, state: "missing" };
  }
  return {
    ...ref,
    state: digestClawMcpServer(server) === ref.configDigest ? "present" : "modified",
  };
}

export async function readClawStatus(
  target?: string,
  options: OpenClawStateDatabaseOptions & {
    config?: OpenClawConfig;
    sourceMcpServers?: Record<string, Record<string, unknown>>;
    listMcpServers?: typeof listConfiguredMcpServers;
    packageDeps?: PackageRemovalDeps;
    packagePreflight?: ClawPackagePreflight;
  } = {},
): Promise<ClawStatusResult> {
  const config = options.config ?? getRuntimeConfig();
  const listedMcp = options.sourceMcpServers
    ? undefined
    : options.listMcpServers
      ? await options.listMcpServers()
      : options.config
        ? undefined
        : await listConfiguredMcpServers();
  if (listedMcp && !listedMcp.ok) {
    throw new ClawRemoveError("mcp_config_unavailable", listedMcp.error);
  }
  const sourceConfig = listedMcp?.ok ? listedMcp.config : config;
  const configuredMcpServers = normalizeConfiguredMcpServers(
    options.sourceMcpServers ?? sourceConfig.mcp?.servers,
  );
  const allInstalls = readClawInstallRecords(options);
  const installAgentIds = new Set(allInstalls.map((install) => install.agentId));
  const allPackageRefs = readClawPackageRefs(options);
  const allWorkspaceFiles = readAllClawWorkspaceFiles(options);
  const orphanAgentIds = new Set<string>();
  for (const packageRef of allPackageRefs) {
    if (!installAgentIds.has(packageRef.agentId)) {
      orphanAgentIds.add(packageRef.agentId);
    }
  }
  for (const file of allWorkspaceFiles) {
    if (!installAgentIds.has(file.agentId)) {
      orphanAgentIds.add(file.agentId);
    }
  }
  const orphanInstalls = [...orphanAgentIds].map((agentId) => {
    const packageRef = allPackageRefs.find((candidate) => candidate.agentId === agentId);
    const file = allWorkspaceFiles.find((candidate) => candidate.agentId === agentId);
    return synthesizeOrphanInstall({
      agentId,
      clawName: packageRef?.clawName,
      workspace: file?.workspace,
      updatedAtMs: Math.max(packageRef?.updatedAtMs ?? 0, file?.updatedAtMs ?? 0),
    });
  });
  const installs = [...allInstalls, ...orphanInstalls].filter(
    (install) => !target || install.agentId === target || install.claw.name === target,
  );
  const records: ClawStatusRecord[] = [];
  const packagePreflight = options.packagePreflight ?? preflightClawPackage;
  for (const install of installs) {
    const agent = listAgentEntries(config).find((candidate) => candidate.id === install.agentId);
    const packageRefs = allPackageRefs.filter(
      (packageRef) => packageRef.agentId === install.agentId,
    );
    const workspaceFiles = installAgentIds.has(install.agentId)
      ? readClawWorkspaceFiles(install.agentId, options)
      : allWorkspaceFiles.filter((file) => file.agentId === install.agentId);
    const setup = readClawSetupState(install.agentId, options);
    const setupUpdate = readClawSetupPending(install.agentId, options);
    records.push({
      install,
      ...(installAgentIds.has(install.agentId) ? {} : { orphaned: true }),
      agentState: !agent
        ? "missing"
        : digestClawAgentConfig(agent) === install.agentConfigDigest
          ? "present"
          : "modified",
      workspaceFiles: await Promise.all(workspaceFiles.map(inspectClawWorkspaceFile)),
      packages: await Promise.all(
        packageRefs.map(
          async (packageRef) =>
            await inspectClawPackageCompatibility({
              install,
              packageRef,
              packageDeps: options.packageDeps,
              packagePreflight,
            }),
        ),
      ),
      mcpServers: (options.readOnly
        ? readClawMcpServerRefs(install.agentId, options)
        : reconcileClawMcpServerRefs(install.agentId, configuredMcpServers, options)
      ).map((ref) => inspectMcpServer(ref, configuredMcpServers)),
      cronJobs: readClawCronRefs(install.agentId, options),
      ...(setup ? { setup } : {}),
      ...(setupUpdate ? { setupUpdate } : {}),
    });
  }
  return {
    schemaVersion: CLAW_STATUS_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    ...(target ? { target } : {}),
    records,
    summary: {
      claws: records.length,
      partial: records.filter(
        (record) =>
          record.install.status !== "complete" ||
          (record.setup !== undefined && record.setup.status !== "complete") ||
          record.setupUpdate !== undefined,
      ).length,
      missingAgents: records.filter((record) => record.agentState === "missing").length,
      driftedFiles: records
        .flatMap((record) => record.workspaceFiles)
        .filter((file) => file.state !== "unchanged").length,
      packageRefs: records.flatMap((record) => record.packages).length,
      missingPackages: records
        .flatMap((record) => record.packages)
        .filter((pkg) => pkg.state === "missing").length,
      driftedPackages: records
        .flatMap((record) => record.packages)
        .filter(
          (pkg) =>
            pkg.state === "modified" ||
            pkg.state === "ambiguous" ||
            pkg.extensionCompatibility?.state === "drifted",
        ).length,
      unavailableExtensions: records
        .flatMap((record) => record.packages)
        .filter((pkg) => pkg.extensionCompatibility?.state === "unavailable").length,
      incompletePackages: records
        .flatMap((record) => record.packages)
        .filter((pkg) => pkg.state === "incomplete").length,
      mcpServerRefs: records.flatMap((record) => record.mcpServers).length,
      driftedMcpServers: records
        .flatMap((record) => record.mcpServers)
        .filter((server) => server.state === "modified" || server.state === "missing").length,
      unresolvedMcpServerRefs: records
        .flatMap((record) => record.mcpServers)
        .filter((server) => server.state === "pending" || server.state === "failed").length,
      cronRefs: records.flatMap((record) => record.cronJobs).length,
      unresolvedCronRefs: records
        .flatMap((record) => record.cronJobs)
        .filter((cron) => cron.status !== "complete" || !cron.schedulerJobId).length,
      personalizationSeeds: records.flatMap((record) => {
        const destinations = new Set([
          ...(record.setup?.seeds.map((seed) => seed.destination) ?? []),
          ...(record.setupUpdate?.seeds.map((seed) => seed.destination) ?? []),
        ]);
        return [...destinations];
      }).length,
      incompleteSetup: records.filter(
        (record) =>
          (record.install.manifestSchemaVersion === CLAW_SETUP_SCHEMA_VERSION && !record.setup) ||
          (record.setup !== undefined && record.setup.status !== "complete") ||
          record.setupUpdate !== undefined,
      ).length,
    },
  };
}
