import { createHash } from "node:crypto";
import { closeSync } from "node:fs";
import { mkdir, realpath, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { listAgentEntries, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { openLocalAgentAvatarFile } from "../agents/identity-avatar-file.js";
import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readFileDescriptorBoundedSync } from "../infra/boundary-file-read.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import { AVATAR_MAX_BYTES, isAvatarDataUrl, isAvatarHttpUrl } from "../shared/avatar-policy.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { resolveUserPath } from "../utils.js";
import {
  assertPrivateAuthorValuesAbsent,
  buildClawExportAuthoring,
  buildGuidedManifestSetup,
  ClawExportAuthoringError,
  digestAuthoringContent,
  readClawExportAuthoringDocument,
  type ClawExportAuthoringResult,
} from "./export-authoring.js";
import { portableOpenClawProfile } from "./export-profile.js";
import { readClawStatus } from "./lifecycle-state.js";
import { buildClawAddPlan } from "./lifecycle.js";
import type { PackageRemovalDeps } from "./package-remove.js";
import { readClawManifestFile } from "./reader.js";
import { isPortableClawAvatar, portableClawPathKey } from "./schema-portability.js";
import { parseClawManifest, parseClawOpenClawProfile } from "./schema.js";
import { buildClawSetupPlan } from "./setup.js";
import { MAX_CLAW_MANIFEST_BYTES, MAX_MANAGED_WORKSPACE_BYTES } from "./source-limits.js";
import {
  CLAW_BOOTSTRAP_FILE_NAMES,
  CLAW_OUTPUT_STABILITY,
  CLAW_SCHEMA_VERSION,
  CLAW_SETUP_SCHEMA_VERSION,
  type ClawManifest,
  type ClawMcpServer,
  type ClawOpenClawProfile,
  type ClawPackagePreflight,
} from "./types.js";

export const CLAW_EXPORT_RESULT_SCHEMA_VERSION = "openclaw.clawExportResult.v1" as const;
const MAX_EXPORT_FILE_BYTES = 1024 * 1024;

type AgentConfig = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];
type ClawBootstrapFileName = (typeof CLAW_BOOTSTRAP_FILE_NAMES)[number];

function decodeUtf8(content: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
}

type ClawExportResult = {
  schemaVersion: typeof CLAW_EXPORT_RESULT_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  agentId: string;
  outputDirectory: string;
  manifest: ClawManifest;
  openClawProfile?: ClawOpenClawProfile;
  filesWritten: string[];
  authoring?: {
    inputs: Array<{ id: string; valuePolicy: "private" | "reusable-default" }>;
    seeds: Array<{
      source: string;
      destination: string;
      inputIds: string[];
      templateDigest: string;
      sampleDigest: string;
      sampleByteLength: number;
    }>;
    privateValuesChecked: number;
    cleanAddPlanIntegrity: string;
  };
};

export class ClawExportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawExportError";
  }
}

function portableAgent(agent: AgentConfig, avatar: string | undefined): ClawManifest["agent"] {
  const identity = {
    ...(agent.identity?.name ? { name: agent.identity.name } : {}),
    ...(agent.identity?.theme ? { theme: agent.identity.theme } : {}),
    ...(agent.identity?.emoji ? { emoji: agent.identity.emoji } : {}),
    ...(avatar ? { avatar } : {}),
  };
  return {
    id: agent.id,
    ...(agent.name ? { name: agent.name } : {}),
    ...(agent.description ? { description: agent.description } : {}),
    ...(Object.keys(identity).length > 0 ? { identity } : {}),
  };
}

function normalizedRelativePath(value: string): string {
  return value.split(sep).join("/");
}

function comparePortableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isClawBootstrapFileName(value: string): value is ClawBootstrapFileName {
  return (CLAW_BOOTSTRAP_FILE_NAMES as readonly string[]).includes(value);
}
function readPortableAvatar(params: {
  config: OpenClawConfig;
  agent: AgentConfig;
  workspace: string;
}): { source?: string; sidecar?: { path: string; content: Buffer } } {
  const source = params.agent.identity?.avatar?.trim();
  if (!source) {
    return {};
  }
  if (isAvatarHttpUrl(source)) {
    return {};
  }
  if (isAvatarDataUrl(source)) {
    return isPortableClawAvatar(source) ? { source } : {};
  }
  const opened = openLocalAgentAvatarFile({
    cfg: params.config,
    agentId: params.agent.id,
    source,
  });
  if (!opened.ok) {
    return {};
  }
  try {
    const content = readFileDescriptorBoundedSync(opened.file.fd, AVATAR_MAX_BYTES);
    const path = normalizedRelativePath(relative(params.workspace, opened.file.path));
    return { source: path, sidecar: { path, content } };
  } catch {
    return {};
  } finally {
    closeSync(opened.file.fd);
  }
}

function derivativePackageVersion(manifest: ClawManifest, contents: ExportContent[]): string {
  const hash = createHash("sha256").update(JSON.stringify(manifest));
  for (const file of contents.toSorted((left, right) =>
    comparePortableText(left.path, right.path),
  )) {
    hash.update(file.path).update("\0").update(file.content).update("\0");
  }
  return `0.0.0-export.${hash.digest("hex")}`;
}

type ExportContent = { path: string; content: Buffer };

function portableMcpServer(server: Record<string, unknown>): ClawMcpServer {
  const common = {
    ...(server.toolFilter && typeof server.toolFilter === "object"
      ? { toolFilter: server.toolFilter as ClawMcpServer["toolFilter"] }
      : {}),
    ...(typeof server.timeout === "number" ? { timeout: server.timeout } : {}),
    ...(typeof server.connectTimeout === "number" ? { connectTimeout: server.connectTimeout } : {}),
  };
  if (typeof server.url === "string") {
    if (server.transport !== "sse" && server.transport !== "streamable-http") {
      throw new Error("Managed remote MCP server has an unsupported transport.");
    }
    return {
      url: server.url,
      transport: server.transport,
      ...(server.auth === "oauth" ? { auth: "oauth" as const } : {}),
      ...common,
    };
  }
  if (typeof server.command !== "string") {
    throw new Error("Managed MCP server has neither a command nor a remote URL.");
  }
  return {
    command: server.command,
    ...(server.transport === "stdio" ? { transport: server.transport } : {}),
    ...(Array.isArray(server.args) ? { args: server.args as string[] } : {}),
    ...(server.env && typeof server.env === "object"
      ? { env: server.env as Record<string, string> }
      : {}),
    ...common,
  };
}

export async function exportClawAgent(
  agentId: string,
  outputDirectory: string,
  options: OpenClawStateDatabaseOptions & {
    config: OpenClawConfig;
    packageDeps?: PackageRemovalDeps;
    packagePreflight?: ClawPackagePreflight;
    sourceMcpServers?: Record<string, Record<string, unknown>>;
    authorSetupPath?: string;
  },
): Promise<ClawExportResult> {
  const status = await readClawStatus(agentId, options);
  const record = status.records.find((candidate) => candidate.install.agentId === agentId);
  if (!record) {
    throw new ClawExportError(
      "claw_not_found",
      `No installed Claw agent matches ${JSON.stringify(agentId)}.`,
    );
  }
  if (record.install.status !== "complete") {
    throw new ClawExportError(
      "install_incomplete",
      `Installed Claw agent ${JSON.stringify(agentId)} is in ${JSON.stringify(record.install.status)} state; finish or repair it before export.`,
    );
  }
  const agent = listAgentEntries(options.config).find((candidate) => candidate.id === agentId);
  if (!agent) {
    throw new ClawExportError(
      "agent_missing",
      `Installed Claw agent ${JSON.stringify(agentId)} is missing from config.`,
    );
  }
  const currentWorkspace = await realpath(
    resolve(resolveAgentWorkspaceDir(options.config, agentId)),
  ).catch(() => resolve(resolveAgentWorkspaceDir(options.config, agentId)));
  if (currentWorkspace !== record.install.workspace) {
    throw new ClawExportError(
      "workspace_changed",
      `Agent ${JSON.stringify(agentId)} now resolves to workspace ${JSON.stringify(currentWorkspace)} instead of its recorded Claw workspace ${JSON.stringify(record.install.workspace)}.`,
    );
  }
  if (record.agentState !== "present") {
    throw new ClawExportError(
      "agent_drifted",
      `Agent ${JSON.stringify(agentId)} no longer matches its recorded Claw configuration.`,
    );
  }
  const driftedFiles = record.workspaceFiles.filter((file) => file.state !== "unchanged");
  if (driftedFiles.length > 0) {
    throw new ClawExportError(
      "workspace_files_drifted",
      `Cannot export drifted managed files: ${driftedFiles.map((file) => `${file.path} (${file.state})`).join(", ")}.`,
    );
  }
  const driftedPackages = record.packages.filter(
    (pkg) =>
      pkg.state !== "present" ||
      (pkg.extensionCompatibility !== undefined &&
        pkg.extensionCompatibility.state !== "compatible"),
  );
  if (driftedPackages.length > 0) {
    throw new ClawExportError(
      "packages_drifted",
      `Cannot export drifted packages: ${driftedPackages.map((pkg) => `${pkg.kind}:${pkg.ref}@${pkg.version} (${pkg.extensionCompatibility?.state ?? pkg.state})`).join(", ")}.`,
    );
  }
  const unresolvedCronJobs = record.cronJobs.filter(
    (cron) => cron.status !== "complete" || !cron.schedulerJobId,
  );
  const unavailableMcpServers = record.mcpServers.filter((server) => server.state !== "present");
  if (unavailableMcpServers.length > 0) {
    throw new ClawExportError(
      "mcp_servers_unavailable",
      `Cannot export MCP servers with unresolved ownership or drift: ${unavailableMcpServers
        .map((server) => server.name)
        .join(", ")}.`,
    );
  }
  if (unresolvedCronJobs.length > 0) {
    throw new ClawExportError(
      "cron_jobs_unavailable",
      `Cannot export cron declarations with unresolved ownership: ${unresolvedCronJobs
        .map((cron) => cron.manifestId)
        .join(", ")}.`,
    );
  }

  const workspace = await fsSafeRoot(record.install.workspace, {
    hardlinks: "reject",
    maxBytes: MAX_EXPORT_FILE_BYTES,
    symlinks: "reject",
  });
  const allContents: ExportContent[] = await Promise.all(
    record.workspaceFiles.map(async (file) => ({
      path: normalizedRelativePath(file.path),
      content: await workspace.readBytes(file.path, { maxBytes: MAX_EXPORT_FILE_BYTES }),
    })),
  );
  let authoring: ClawExportAuthoringResult | undefined;
  if (options.authorSetupPath) {
    try {
      const document = await readClawExportAuthoringDocument(
        resolve(resolveUserPath(options.authorSetupPath)),
      );
      authoring = await buildClawExportAuthoring({
        document,
        workspace: record.install.workspace,
        managedWorkspacePaths: new Set(
          record.workspaceFiles.map((file) => portableClawPathKey(file.path)),
        ),
      });
    } catch (error) {
      if (error instanceof ClawExportAuthoringError) {
        throw new ClawExportError(error.code, error.message);
      }
      throw error;
    }
  }
  const soul = allContents.find((file) => file.path === "SOUL.md");
  const decodedSoul = soul ? decodeUtf8(soul.content) : undefined;
  let clawMarkdownBody =
    soul && decodedSoul !== undefined && decodedSoul.trim().length > 0 ? soul.content : undefined;
  const contents = allContents.filter((file) => file !== soul || !clawMarkdownBody);
  const avatar = readPortableAvatar({
    config: options.config,
    agent,
    workspace: record.install.workspace,
  });
  const managedPaths = new Set(contents.map((file) => file.path));
  if (avatar.sidecar && !managedPaths.has(avatar.sidecar.path)) {
    contents.push(avatar.sidecar);
  }
  const bootstrapFiles: ClawManifest["workspace"]["bootstrapFiles"] = {};
  const files: ClawManifest["workspace"]["files"] = [];
  for (const file of contents) {
    const source = `workspace/${file.path}`;
    if (isClawBootstrapFileName(file.path)) {
      bootstrapFiles[file.path] = { source };
    } else {
      const role = record.workspaceFiles.find((managed) => managed.path === file.path)?.role;
      files.push({ source, path: file.path, ...(role ? { role } : {}) });
    }
  }
  const configuredMcpServers = normalizeConfiguredMcpServers(
    options.sourceMcpServers ?? options.config.mcp?.servers,
  );
  const extensions = record.packages
    .filter((pkg) => pkg.extension)
    .map((pkg) => ({
      id: pkg.extension!.id,
      kind: "plugin" as const,
      format: pkg.extension!.format,
      source: pkg.source,
      ref: pkg.ref,
      version: pkg.version,
    }))
    .toSorted((left, right) => comparePortableText(left.id, right.id));
  const openClawProfile = portableOpenClawProfile(agent, extensions);
  const openClawProfilePath = "profiles/openclaw.yml";
  const openClawProfileRaw = openClawProfile
    ? Buffer.from(stringifyYaml(openClawProfile))
    : undefined;
  const portablePackages = record.packages
    .filter((pkg) => !pkg.extension)
    .map((pkg) => ({
      kind: pkg.kind,
      source: pkg.source,
      ref: pkg.ref,
      version: pkg.version,
    }))
    .toSorted((left, right) => {
      const leftIdentity = `${left.kind}:${left.ref}:${left.version}`;
      const rightIdentity = `${right.kind}:${right.ref}:${right.version}`;
      return comparePortableText(leftIdentity, rightIdentity);
    });
  const usesManifestV2 =
    authoring !== undefined ||
    extensions.length > 0 ||
    files.some((file) => file.role !== undefined);
  const portableSkills = portablePackages.filter(
    (pkg): pkg is typeof pkg & { kind: "skill" } => pkg.kind === "skill",
  );
  if (usesManifestV2 && portableSkills.length !== portablePackages.length) {
    throw new ClawExportError(
      "legacy_plugin_not_relocated",
      "Schema version 2 export requires plugin dependencies to have extension provenance.",
    );
  }
  const manifestCommon = {
    agent: portableAgent(agent, avatar.source),
    ...(openClawProfile ? { metadata: { "openclaw.config": openClawProfilePath } } : {}),
    workspace: { bootstrapFiles, files },
    mcpServers: Object.fromEntries(
      record.mcpServers.map((ref) => [
        ref.name,
        portableMcpServer(configuredMcpServers[ref.name]!),
      ]),
    ),
    cronJobs: record.cronJobs
      .map((cron) => cron.job)
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  };
  const manifest: ClawManifest = authoring
    ? {
        schemaVersion: CLAW_SETUP_SCHEMA_VERSION,
        ...manifestCommon,
        packages: portableSkills,
        ...buildGuidedManifestSetup(authoring),
      }
    : usesManifestV2
      ? {
          schemaVersion: CLAW_SETUP_SCHEMA_VERSION,
          ...manifestCommon,
          packages: portableSkills,
          setup: { inputs: [] },
          personalization: { seeds: [] },
        }
      : { schemaVersion: CLAW_SCHEMA_VERSION, ...manifestCommon, packages: portablePackages };
  const serializeClawMarkdown = (body: Buffer | undefined) =>
    Buffer.concat([Buffer.from(`---\n${stringifyYaml(manifest)}---\n`), ...(body ? [body] : [])]);
  let clawMarkdownRaw = serializeClawMarkdown(clawMarkdownBody);
  if (clawMarkdownBody && clawMarkdownRaw.byteLength > MAX_CLAW_MANIFEST_BYTES) {
    clawMarkdownBody = undefined;
    contents.push(soul!);
    bootstrapFiles["SOUL.md"] = { source: "workspace/SOUL.md" };
    clawMarkdownRaw = serializeClawMarkdown(undefined);
  }
  if (clawMarkdownRaw.byteLength > MAX_CLAW_MANIFEST_BYTES) {
    throw new ClawExportError(
      "claw_manifest_oversized",
      `Exported CLAW.md exceeds ${MAX_CLAW_MANIFEST_BYTES} bytes.`,
    );
  }
  const aggregateBytes =
    contents.reduce((total, file) => total + file.content.byteLength, 0) +
    (clawMarkdownBody?.byteLength ?? 0);
  if (aggregateBytes > MAX_MANAGED_WORKSPACE_BYTES) {
    throw new ClawExportError(
      "workspace_files_oversized",
      `Exported workspace content exceeds ${MAX_MANAGED_WORKSPACE_BYTES} aggregate bytes.`,
    );
  }
  const parsed = parseClawManifest(manifest);
  if (!parsed.ok) {
    throw new ClawExportError(
      "export_manifest_invalid",
      parsed.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
    );
  }
  if (openClawProfile) {
    const parsedProfile = parseClawOpenClawProfile(openClawProfile);
    if (!parsedProfile.ok) {
      throw new ClawExportError(
        "export_openclaw_profile_invalid",
        parsedProfile.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
      );
    }
  }
  const authoringContents: ExportContent[] =
    authoring?.templates.map((template) => ({
      path: template.source,
      content: template.content,
    })) ?? [];
  const target = resolve(resolveUserPath(outputDirectory));
  await mkdir(dirname(target), { recursive: true });
  try {
    await mkdir(target);
  } catch (error) {
    throw new ClawExportError(
      "output_collision",
      `Export directory ${JSON.stringify(target)} must not already exist: ${(error as Error).message}`,
    );
  }
  const filesWritten: string[] = [];
  try {
    const output = await fsSafeRoot(target, {
      hardlinks: "reject",
      maxBytes: MAX_EXPORT_FILE_BYTES,
      symlinks: "reject",
    });
    for (const file of contents) {
      const path = `workspace/${file.path}`;
      await output.write(path, file.content, { mkdir: true, overwrite: false });
      filesWritten.push(path);
    }
    if (openClawProfileRaw) {
      await output.write(openClawProfilePath, openClawProfileRaw, {
        mkdir: true,
        overwrite: false,
      });
      filesWritten.push(openClawProfilePath);
    }
    for (const file of authoringContents) {
      await output.write(file.path, file.content, { mkdir: true, overwrite: false });
      filesWritten.push(file.path);
    }
    const packageJson = {
      name: `openclaw-claw-${record.install.agentId}`,
      version: derivativePackageVersion(manifest, [
        ...contents,
        ...authoringContents,
        ...(clawMarkdownBody ? [{ path: "CLAW.md#body", content: clawMarkdownBody }] : []),
        ...(openClawProfileRaw ? [{ path: openClawProfilePath, content: openClawProfileRaw }] : []),
      ]),
      type: "module",
      openclaw: { claw: "CLAW.md" },
    };
    const packageJsonRaw = Buffer.from(`${JSON.stringify(packageJson, null, 2)}\n`);
    if (authoring) {
      try {
        assertPrivateAuthorValuesAbsent({
          privateLiterals: authoring.privateLiterals,
          files: [
            ...contents.map((file) => ({ path: `workspace/${file.path}`, content: file.content })),
            ...authoringContents,
            ...(openClawProfileRaw
              ? [{ path: openClawProfilePath, content: openClawProfileRaw }]
              : []),
            { path: "CLAW.md", content: clawMarkdownRaw },
            { path: "package.json", content: packageJsonRaw },
          ],
        });
      } catch (error) {
        if (error instanceof ClawExportAuthoringError) {
          throw new ClawExportError(error.code, error.message);
        }
        throw error;
      }
    }
    await output.write("package.json", packageJsonRaw, {
      overwrite: false,
    });
    filesWritten.push("package.json");
    await output.write("CLAW.md", clawMarkdownRaw, { overwrite: false });
    filesWritten.push("CLAW.md");
  } catch (error) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof ClawExportError) {
      throw error;
    }
    throw new ClawExportError(
      "export_write_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
  let authoringReview: ClawExportResult["authoring"];
  if (authoring) {
    try {
      const read = await readClawManifestFile(target);
      if (!read.ok) {
        throw new ClawExportError(
          "author_setup_package_invalid",
          read.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
        );
      }
      const plan = await buildClawAddPlan({
        manifest: read.manifest,
        ...(read.clawMarkdownBody ? { clawMarkdownBody: read.clawMarkdownBody } : {}),
        ...(read.openClawProfile ? { openClawProfile: read.openClawProfile } : {}),
        source: read.source,
        answers: authoring.samples,
        context: {
          workspace: resolve(target, ".openclaw-clean-preview"),
          packagePreflight: async (pkg) => {
            const installed = record.packages.find(
              (candidate) =>
                candidate.kind === pkg.kind &&
                candidate.source === pkg.source &&
                candidate.ref === pkg.ref &&
                candidate.version === pkg.version,
            );
            return installed
              ? {
                  ok: true,
                  action: "install",
                  integrity: installed.integrity,
                  ...(installed.extension
                    ? {
                        installId: installed.extension.id,
                        detectedFormat: installed.extension.detectedFormat,
                        mapped: installed.extension.mapped,
                        unavailable: installed.extension.unavailable,
                        adapterIdentity: installed.extension.adapterIdentity,
                      }
                    : {}),
                }
              : {
                  ok: false,
                  code: "author_setup_package_unavailable",
                  message: `Exported package ${pkg.kind}:${pkg.ref}@${pkg.version} is unavailable for clean preview.`,
                };
          },
        },
      });
      if (plan.blockers.length > 0 || !plan.setup?.valid) {
        throw new ClawExportError(
          "author_setup_preview_blocked",
          [...plan.blockers, ...(plan.setup?.diagnostics ?? [])]
            .map((diagnostic) => diagnostic.message)
            .join("; "),
        );
      }
      if (read.manifest.schemaVersion !== CLAW_SETUP_SCHEMA_VERSION) {
        throw new ClawExportError(
          "author_setup_package_invalid",
          "Guided export did not produce a schema version 2 package.",
        );
      }
      const setupMaterialization = await buildClawSetupPlan({
        manifest: read.manifest,
        packageRoot: read.source.packageRoot,
        answers: authoring.samples,
      });
      if (!setupMaterialization.materialization) {
        throw new ClawExportError(
          "author_setup_preview_incomplete",
          "Clean-state preview did not produce canonical sample renderings.",
        );
      }
      authoringReview = {
        inputs: authoring.inputReview,
        seeds: authoring.templates.map((template) => {
          const seed = plan.setup!.seeds.find(
            (candidate) => candidate.destination === template.destination,
          );
          const rendered = setupMaterialization.materialization!.seeds.find(
            (candidate) => candidate.destination === template.destination,
          );
          if (!seed?.digest || seed.renderedByteLength === undefined || !rendered) {
            throw new ClawExportError(
              "author_setup_preview_incomplete",
              `Clean-state preview did not render ${JSON.stringify(template.destination)}.`,
            );
          }
          return {
            source: template.source,
            destination: template.destination,
            inputIds: template.inputIds,
            templateDigest: digestAuthoringContent(template.content),
            sampleDigest: seed.digest,
            sampleByteLength: seed.renderedByteLength,
          };
        }),
        privateValuesChecked: authoring.privateLiterals.length,
        cleanAddPlanIntegrity: plan.planIntegrity,
      };
    } catch (error) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
  return {
    schemaVersion: CLAW_EXPORT_RESULT_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    agentId,
    outputDirectory: target,
    manifest,
    ...(openClawProfile ? { openClawProfile } : {}),
    filesWritten,
    ...(authoringReview ? { authoring: authoringReview } : {}),
  };
}
