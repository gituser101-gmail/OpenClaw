// OpenCode Zen doctor contract: repair retired free-tier model refs.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

type LegacyConfigRule = {
  path: string[];
  message: string;
  match: (value: unknown) => boolean;
};

const PROVIDER_ID = "opencode";
const RETIRED_MODEL_ID = "hy3-free";
const REPLACEMENT_MODEL_ID = "laguna-s-2.1-free";
const RETIRED_MODEL_REF = `${PROVIDER_ID}/${RETIRED_MODEL_ID}`;
const REPLACEMENT_MODEL_REF = `${PROVIDER_ID}/${REPLACEMENT_MODEL_ID}`;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeModelId(value: string): string {
  return value.trim().toLowerCase();
}

function splitModelRef(
  value: string,
): { provider: string; model: string; profile?: string } | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  // Drop trailing auth profile (`provider/model@profile`) before splitting.
  const at = trimmed.lastIndexOf("@");
  const withoutProfile = at >= 0 ? trimmed.slice(0, at) : trimmed;
  const profile = at >= 0 ? trimmed.slice(at + 1) : undefined;
  const slash = withoutProfile.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  const provider = withoutProfile.slice(0, slash).trim();
  const model = withoutProfile.slice(slash + 1).trim();
  if (!provider || !model) {
    return null;
  }
  return {
    provider,
    model,
    ...(profile ? { profile } : {}),
  };
}

function isRetiredModelRef(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const split = splitModelRef(value);
  if (!split) {
    return false;
  }
  return (
    normalizeModelId(split.provider) === PROVIDER_ID &&
    normalizeModelId(split.model) === RETIRED_MODEL_ID
  );
}

function rewriteRetiredModelRef(value: string): string | null {
  if (!isRetiredModelRef(value)) {
    return null;
  }
  const split = splitModelRef(value);
  if (!split) {
    return null;
  }
  return split.profile ? `${REPLACEMENT_MODEL_REF}@${split.profile}` : REPLACEMENT_MODEL_REF;
}

function catalogHasRetiredHy3Free(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((row) => {
      const id = asRecord(row)?.id;
      return typeof id === "string" && normalizeModelId(id) === RETIRED_MODEL_ID;
    })
  );
}

function modelsMapHasRetiredRef(value: unknown): boolean {
  const map = asRecord(value);
  if (!map) {
    return false;
  }
  return Object.keys(map).some((key) => isRetiredModelRef(key));
}

function agentDefaultModelHasRetiredRef(value: unknown): boolean {
  if (typeof value === "string") {
    return isRetiredModelRef(value);
  }
  const record = asRecord(value);
  if (!record) {
    return false;
  }
  if (typeof record.primary === "string" && isRetiredModelRef(record.primary)) {
    return true;
  }
  return (
    Array.isArray(record.fallbacks) && record.fallbacks.some((entry) => isRetiredModelRef(entry))
  );
}

function modelPolicyAllowHasRetiredRef(value: unknown): boolean {
  const allow = asRecord(value)?.allow;
  return Array.isArray(allow) && allow.some((entry) => isRetiredModelRef(entry));
}

function agentRecordHasRetiredRef(value: unknown): boolean {
  const agent = asRecord(value);
  if (!agent) {
    return false;
  }
  return (
    agentDefaultModelHasRetiredRef(agent.model) ||
    modelsMapHasRetiredRef(agent.models) ||
    modelPolicyAllowHasRetiredRef(agent.modelPolicy) ||
    agentDefaultModelHasRetiredRef(asRecord(agent.subagents)?.model)
  );
}

function agentListHasRetiredRef(value: unknown): boolean {
  return Array.isArray(value) && value.some((agent) => agentRecordHasRetiredRef(agent));
}

function defaultsHasRetiredRef(value: unknown): boolean {
  const defaults = asRecord(value);
  if (!defaults) {
    return false;
  }
  return (
    agentDefaultModelHasRetiredRef(defaults.model) ||
    modelsMapHasRetiredRef(defaults.models) ||
    modelPolicyAllowHasRetiredRef(defaults.modelPolicy) ||
    agentDefaultModelHasRetiredRef(asRecord(defaults.subagents)?.model)
  );
}

export const legacyConfigRules: LegacyConfigRule[] = [
  {
    path: ["agents", "defaults"],
    message: `agents.defaults uses retired ${RETIRED_MODEL_REF}; run "openclaw doctor --fix" to use ${REPLACEMENT_MODEL_REF}.`,
    match: defaultsHasRetiredRef,
  },
  {
    path: ["agents", "list"],
    message: `agents.list[] uses retired ${RETIRED_MODEL_REF}; run "openclaw doctor --fix" to use ${REPLACEMENT_MODEL_REF}.`,
    match: agentListHasRetiredRef,
  },
  {
    path: ["models", "providers", "opencode", "models"],
    message: `models.providers.opencode.models contains retired ${RETIRED_MODEL_ID}; run "openclaw doctor --fix" to remove it.`,
    match: catalogHasRetiredHy3Free,
  },
];

function rewriteDefaultModelShape(
  model: unknown,
  pathLabel: string,
  changes: string[],
): { model: unknown; changed: boolean } {
  if (typeof model === "string") {
    const rewritten = rewriteRetiredModelRef(model);
    if (!rewritten) {
      return { model, changed: false };
    }
    changes.push(
      `Updated ${pathLabel} from ${JSON.stringify(model)} to ${JSON.stringify(rewritten)}.`,
    );
    return { model: rewritten, changed: true };
  }

  const record = asRecord(model);
  if (!record) {
    return { model, changed: false };
  }

  let changed = false;
  const next: Record<string, unknown> = { ...record };

  if (typeof record.primary === "string") {
    const rewritten = rewriteRetiredModelRef(record.primary);
    if (rewritten) {
      changes.push(
        `Updated ${pathLabel}.primary from ${JSON.stringify(record.primary)} to ${JSON.stringify(rewritten)}.`,
      );
      next.primary = rewritten;
      changed = true;
    }
  }

  if (Array.isArray(record.fallbacks)) {
    let fallbackChanged = false;
    const nextFallbacks = record.fallbacks.map((entry) => {
      if (typeof entry !== "string") {
        return entry;
      }
      const rewritten = rewriteRetiredModelRef(entry);
      if (!rewritten) {
        return entry;
      }
      fallbackChanged = true;
      changes.push(
        `Updated ${pathLabel}.fallbacks entry from ${JSON.stringify(entry)} to ${JSON.stringify(rewritten)}.`,
      );
      return rewritten;
    });
    if (fallbackChanged) {
      next.fallbacks = nextFallbacks;
      changed = true;
    }
  }

  return { model: changed ? next : model, changed };
}

function rewriteModelsMap(
  models: Record<string, unknown>,
  pathLabel: string,
  changes: string[],
): { models: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const next: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(models)) {
    const rewrittenKey = rewriteRetiredModelRef(key);
    if (!rewrittenKey) {
      next[key] = value;
      continue;
    }
    changed = true;
    if (Object.hasOwn(models, rewrittenKey) || Object.hasOwn(next, rewrittenKey)) {
      changes.push(
        `Removed retired ${pathLabel} key ${JSON.stringify(key)}; kept existing ${JSON.stringify(rewrittenKey)}.`,
      );
      continue;
    }
    next[rewrittenKey] = value;
    changes.push(
      `Renamed ${pathLabel} key from ${JSON.stringify(key)} to ${JSON.stringify(rewrittenKey)}.`,
    );
  }

  return { models: changed ? next : models, changed };
}

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  let next = cfg;
  const changes: string[] = [];

  const cloneOnce = () => {
    if (next === cfg) {
      next = structuredClone(cfg);
    }
  };

  const rewriteAgentRecord = (
    agentValue: unknown,
    pathLabel: string,
  ): Record<string, unknown> | null => {
    const agent = asRecord(agentValue);
    if (!agent || !agentRecordHasRetiredRef(agent)) {
      return null;
    }
    const nextAgent: Record<string, unknown> = { ...agent };
    const rewrittenModel = rewriteDefaultModelShape(agent.model, `${pathLabel}.model`, changes);
    if (rewrittenModel.changed) {
      nextAgent.model = rewrittenModel.model;
    }
    if (modelsMapHasRetiredRef(agent.models)) {
      nextAgent.models = rewriteModelsMap(
        asRecord(agent.models) ?? {},
        `${pathLabel}.models`,
        changes,
      ).models;
    }
    const policy = asRecord(agent.modelPolicy);
    if (policy && Array.isArray(policy.allow)) {
      let policyChanged = false;
      const nextAllow = policy.allow.map((entry) => {
        if (typeof entry !== "string") {
          return entry;
        }
        const rewritten = rewriteRetiredModelRef(entry);
        if (!rewritten) {
          return entry;
        }
        policyChanged = true;
        changes.push(
          `Updated ${pathLabel}.modelPolicy.allow entry from ${JSON.stringify(entry)} to ${JSON.stringify(rewritten)}.`,
        );
        return rewritten;
      });
      if (policyChanged) {
        nextAgent.modelPolicy = { ...policy, allow: nextAllow };
      }
    }
    const subagents = asRecord(agent.subagents);
    if (subagents) {
      const rewrittenSub = rewriteDefaultModelShape(
        subagents.model,
        `${pathLabel}.subagents.model`,
        changes,
      );
      if (rewrittenSub.changed) {
        nextAgent.subagents = { ...subagents, model: rewrittenSub.model };
      }
    }
    return nextAgent;
  };

  if (defaultsHasRetiredRef(cfg.agents?.defaults)) {
    cloneOnce();
    const agents = asRecord(next.agents) ?? {};
    const rewrittenDefaults = rewriteAgentRecord(agents.defaults, "agents.defaults");
    if (rewrittenDefaults) {
      agents.defaults = rewrittenDefaults;
      (next as Record<string, unknown>).agents = agents;
    }
  }

  if (Array.isArray(cfg.agents?.list) && agentListHasRetiredRef(cfg.agents.list)) {
    cloneOnce();
    const agents = asRecord(next.agents) ?? {};
    const list = Array.isArray(agents.list) ? [...agents.list] : [];
    for (let index = 0; index < list.length; index += 1) {
      const rewritten = rewriteAgentRecord(list[index], `agents.list[${index}]`);
      if (rewritten) {
        list[index] = rewritten;
      }
    }
    agents.list = list;
    (next as Record<string, unknown>).agents = agents;
  }

  const catalogModels = cfg.models?.providers?.opencode?.models;
  if (catalogHasRetiredHy3Free(catalogModels)) {
    cloneOnce();
    const modelsRoot = asRecord(next.models) ?? {};
    const providers = asRecord(modelsRoot.providers) ?? {};
    const provider = asRecord(providers.opencode);
    const models = provider?.models;
    if (provider && Array.isArray(models)) {
      const retained = models.filter((row) => {
        const id = asRecord(row)?.id;
        return !(typeof id === "string" && normalizeModelId(id) === RETIRED_MODEL_ID);
      });
      const removed = models.length - retained.length;
      provider.models = retained;
      providers.opencode = provider;
      modelsRoot.providers = providers;
      (next as Record<string, unknown>).models = modelsRoot;
      changes.push(
        `Removed ${removed} retired ${RETIRED_MODEL_ID} row${removed === 1 ? "" : "s"} from models.providers.opencode.models.`,
      );
    }
  }

  return { config: next, changes };
}
