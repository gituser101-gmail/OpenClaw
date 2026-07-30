// Shared types for grouped OpenClaw Claw manifests and read-only add plans.
import type { ToolProfileId } from "../agents/tool-policy-shared.js";
import type { AgentConfig } from "../config/types.agents.js";

export const CLAW_SCHEMA_VERSION = 1 as const;
export const CLAW_SETUP_SCHEMA_VERSION = 2 as const;
export const CLAW_OPENCLAW_PROFILE_EXTENSIONS_SCHEMA_VERSION = 2 as const;
export const CLAW_ADD_PLAN_SCHEMA_VERSION = "openclaw.clawAddPlan.v1" as const;
export const CLAW_INSPECT_RESULT_SCHEMA_VERSION = "openclaw.clawInspect.v1" as const;
export const CLAW_OUTPUT_STABILITY = "experimental" as const;

type ClawDiagnosticLevel = "error" | "warning";

export type ClawDiagnostic = {
  level: ClawDiagnosticLevel;
  code: string;
  phase: "parse" | "schema" | "policy" | "plan" | "mutation";
  path: string;
  message: string;
};

type ClawAgent = {
  id: string;
  name?: string;
  description?: string;
  identity?: {
    name?: string;
    theme?: string;
    emoji?: string;
    avatar?: string;
  };
};

type ClawOpenClawAgentProfile = {
  groupChat?: {
    mentionPatterns?: string[];
  };
  sandbox?: {
    mode?: "off" | "non-main" | "all";
    scope?: "session" | "agent" | "shared";
    workspaceAccess?: "none" | "ro" | "rw";
  };
  tools?: {
    profile?: ToolProfileId;
    allow?: string[];
    alsoAllow?: string[];
    deny?: string[];
    fs?: {
      workspaceOnly?: true;
    };
  };
  memory?: {
    search?: {
      enabled?: boolean;
      rememberAcrossConversations?: boolean;
      sources?: Array<"memory" | "sessions">;
    };
  };
  heartbeat?: {
    every?: string;
    activeHours?: {
      start?: string;
      end?: string;
      timezone?: string;
    };
    lightContext?: boolean;
    isolatedSession?: boolean;
    timeoutSeconds?: number;
  };
  humanDelay?: {
    mode?: "off" | "natural" | "custom";
    minMs?: number;
    maxMs?: number;
  };
};

export type ClawExtensionFormat = "openclaw" | "claude" | "codex" | "cursor";

export type ClawOpenClawExtension = {
  id: string;
  kind: "plugin";
  format: ClawExtensionFormat;
  source: "clawhub";
  ref: string;
  version: string;
};

export type ClawOpenClawProfile =
  | {
      schemaVersion: 1;
      agent: ClawOpenClawAgentProfile;
    }
  | {
      schemaVersion: typeof CLAW_OPENCLAW_PROFILE_EXTENSIONS_SCHEMA_VERSION;
      agent: ClawOpenClawAgentProfile;
      extensions: ClawOpenClawExtension[];
    };

export const CLAW_BOOTSTRAP_FILE_NAMES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "TOOLS.md",
  "HEARTBEAT.md",
] as const;

type ClawBootstrapFileName = (typeof CLAW_BOOTSTRAP_FILE_NAMES)[number];

export type ClawWorkspaceFileRole =
  | "reference"
  | "schema"
  | "template"
  | "example"
  | "fixture"
  | "asset";

type ClawWorkspaceFile = {
  source: string;
  path: string;
  role?: ClawWorkspaceFileRole;
};

type ClawWorkspace = {
  bootstrapFiles: Partial<Record<ClawBootstrapFileName, { source: string }>>;
  files: ClawWorkspaceFile[];
};

type ClawSetupInputCommon = {
  id: string;
  label: string;
  description?: string;
  required?: boolean;
};

type ClawSetupStringInput = ClawSetupInputCommon & {
  type: "string";
  default?: string;
  minLength?: number;
  maxLength: number;
  format?: "timezone" | "language-tag";
};

type ClawSetupMultilineInput = ClawSetupInputCommon & {
  type: "multiline";
  default?: string;
  minLength?: number;
  maxLength: number;
};

type ClawSetupIntegerInput = ClawSetupInputCommon & {
  type: "integer";
  default?: number;
  minimum?: number;
  maximum?: number;
};

type ClawSetupBooleanInput = ClawSetupInputCommon & {
  type: "boolean";
  default?: boolean;
};

export type ClawSetupChoiceOption = {
  value: string;
  label: string;
};

type ClawSetupChoiceInput = ClawSetupInputCommon & {
  type: "choice";
  default?: string;
  options: ClawSetupChoiceOption[];
};

type ClawSetupMultiChoiceInput = ClawSetupInputCommon & {
  type: "multiChoice";
  default?: string[];
  options: ClawSetupChoiceOption[];
  minItems?: number;
  maxItems?: number;
};

export type ClawSetupInput =
  | ClawSetupStringInput
  | ClawSetupMultilineInput
  | ClawSetupIntegerInput
  | ClawSetupBooleanInput
  | ClawSetupChoiceInput
  | ClawSetupMultiChoiceInput;

export type ClawPersonalizationSeed = {
  source: string;
  destination: string;
};

export type ClawPackage = {
  kind: "skill" | "plugin";
  source: "clawhub";
  ref: string;
  version: string;
};

export type ClawAppliedExtension = {
  id: string;
  format: ClawExtensionFormat;
  detectedFormat: ClawExtensionFormat;
  mapped: string[];
  unavailable: string[];
  adapterIdentity: string;
};

export type ResolvedClawPackage = ClawPackage & {
  integrity: string;
  extension?: ClawAppliedExtension;
};

export type ClawPackagePreflightResult = {
  ok: boolean;
  action?: "install" | "reuse";
  integrity?: string;
  installId?: string;
  warning?: string;
  installedVersion?: string;
  code?: string;
  message?: string;
  requirements?: ClawLocalPrerequisite[];
  detectedFormat?: ClawExtensionFormat;
  mapped?: string[];
  unavailable?: string[];
  adapterIdentity?: string;
};

export type ClawPackagePreflight = (
  pkg: ClawPackage,
  workspace: string,
) => Promise<ClawPackagePreflightResult>;

type ClawMcpServerCommon = {
  toolFilter?: {
    include?: string[];
    exclude?: string[];
  };
  timeout?: number;
  connectTimeout?: number;
};

type ClawStdioMcpServer = ClawMcpServerCommon & {
  command: string;
  transport?: "stdio";
  args?: string[];
  env?: Record<string, string>;
};

type ClawRemoteMcpServer = ClawMcpServerCommon & {
  url: string;
  transport: "sse" | "streamable-http";
  auth?: "oauth";
};

export type ClawMcpServer = ClawStdioMcpServer | ClawRemoteMcpServer;

export type ClawCronJob = {
  id: string;
  name?: string;
  schedule: {
    cron: string;
    timezone: string;
  };
  session: "main" | "isolated";
  message: string;
  delivery?: {
    mode: "none" | "announce";
    channel?: "last";
  };
};

type ClawManifestBase = {
  agent: ClawAgent;
  metadata?: Record<string, string>;
  workspace: ClawWorkspace;
  packages: ClawPackage[];
  mcpServers: Record<string, ClawMcpServer>;
  cronJobs: ClawCronJob[];
};

export type ClawManifestV1 = ClawManifestBase & {
  schemaVersion: typeof CLAW_SCHEMA_VERSION;
};

export type ClawManifestV2 = Omit<ClawManifestBase, "packages"> & {
  schemaVersion: typeof CLAW_SETUP_SCHEMA_VERSION;
  packages: Array<ClawPackage & { kind: "skill" }>;
  setup: { inputs: ClawSetupInput[] };
  personalization: { seeds: ClawPersonalizationSeed[] };
};

export type ClawManifest = ClawManifestV1 | ClawManifestV2;

export type ClawSourceIdentity = {
  kind: "package" | "development";
  name: string;
  version: string;
  packageRoot: string;
  manifestPath: string;
  integrityKind: "artifact" | "development-snapshot";
  integrity: string;
  byteLength: number;
};

export type ClawWorkspaceSourceSnapshot = {
  sourcePath: string;
  realPath: string;
  byteLength: number;
  digest: string;
};

export type ClawSetupTemplateSnapshot = ClawWorkspaceSourceSnapshot & {
  inputIds: string[];
};

type ClawSourceSnapshot = {
  workspaceSources: ClawWorkspaceSourceSnapshot[];
  setupTemplates: ClawSetupTemplateSnapshot[];
};

export type ClawReadResult =
  | {
      ok: true;
      manifest: ClawManifest;
      clawMarkdownBody?: Buffer;
      openClawProfile?: ClawOpenClawProfile;
      source: ClawSourceIdentity;
      snapshot: ClawSourceSnapshot;
      diagnostics: ClawDiagnostic[];
    }
  | {
      ok: false;
      diagnostics: ClawDiagnostic[];
    };

export type ClawAddPlanAction = {
  kind: "agent" | "workspace" | "workspaceFile" | "package" | "mcpServer" | "cronJob";
  id: string;
  action: "create" | "write" | "install" | "configure" | "schedule";
  target: string;
  source?: string;
  sourceKind?: "clawMarkdownBody" | "personalizationSeed";
  digest?: string;
  details?: Record<string, unknown>;
  blocked: boolean;
  reason?: string;
};

export type ClawSetupPlan = {
  schemaDigest: string;
  answerDigest: string;
  valid: boolean;
  inputs: ClawSetupInput[];
  providedInputIds: string[];
  defaultedInputIds: string[];
  missingOptionalInputIds: string[];
  seeds: Array<{
    source: string;
    destination: string;
    inputIds: string[];
    renderedByteLength?: number;
    digest?: string;
    blocked: boolean;
  }>;
  diagnostics: ClawDiagnostic[];
};

export type ClawExtensionPlan = ClawOpenClawExtension & {
  detectedFormat?: ClawExtensionFormat;
  integrity?: string;
  installId?: string;
  ownerAction?: "install" | "reuse";
  mapped: string[];
  unavailable: string[];
  adapterIdentity?: string;
  blocked: boolean;
};

export type ClawAddCapabilityChange = {
  kind: "agent" | "package" | "mcpServer" | "cronJob";
  id: string;
  path: string;
  action: "create" | "install" | "configure" | "schedule";
  classification: "escalation";
  requiresDistinctConsent: true;
  reason: string;
  effect: Record<string, unknown>;
  digest: string;
};

export type ClawLocalPrerequisite =
  | { kind: "environment"; mcpServer: string; name: string }
  | { kind: "oauth"; mcpServer: string }
  | {
      kind: "plugin-setup";
      plugin: string;
      provider: string;
      envVars: string[];
      authMethods: string[];
    };

export type ClawAddPlan = {
  schemaVersion: typeof CLAW_ADD_PLAN_SCHEMA_VERSION;
  manifestSchemaVersion: ClawManifest["schemaVersion"];
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: true;
  mutationAllowed: false;
  planIntegrity: string;
  claw: ClawSourceIdentity;
  agent: {
    requestedId: string;
    finalId: string;
    workspace: string;
    config: AgentConfig & { workspace: string };
  };
  summary: {
    totalActions: number;
    agentActions: number;
    workspaceActions: number;
    packageActions: number;
    mcpServerActions: number;
    cronJobActions: number;
    blockedActions: number;
    capabilityEscalations: number;
  };
  actions: ClawAddPlanAction[];
  capabilityChanges: ClawAddCapabilityChange[];
  readiness: {
    ready: boolean;
    requirements: ClawLocalPrerequisite[];
  };
  extensions: ClawExtensionPlan[];
  setup?: ClawSetupPlan;
  blockers: ClawDiagnostic[];
  diagnostics: ClawDiagnostic[];
};
