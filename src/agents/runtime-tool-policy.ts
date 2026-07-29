import type { RuntimeToolPolicy } from "../config/sessions/runtime-tool-policy.types.js";
/**
 * Runtime logic for the per-spawn `sessions_spawn` tool policy.
 *
 * The type lives in `src/config/sessions/runtime-tool-policy.types.ts` so the
 * config/persistence layer has no reverse dependency on the agent runtime.
 *
 * Security invariants:
 * - `"none"` means ZERO callable model tools. It converts to a deny-all
 *   sandbox policy, never to an empty allow list (empty allow = allow-all in
 *   the existing matcher).
 * - Corrupted/unparseable persisted data fails closed (→ `"none"`), never to
 *   `undefined`.
 * - Normalization always returns fresh arrays.
 */
import type { SandboxToolPolicy } from "./sandbox/types.js";
import { normalizeToolName } from "./tool-policy.js";

/** Sentinel deny pattern that matches every tool name. */
const DENY_ALL = "*";

/**
 * Normalize a raw (possibly untrusted/persisted) policy value.
 *
 * - Trims, drops blanks, deduplicates entries.
 * - `{}` / `{ deny: [] }` / `{ allow: ["*"], deny: [] }` → `undefined` (no restriction).
 * - `{ allow: [] }` → `"none"`.
 * - `{ deny: ["*"] }` → `"none"`.
 * - Corrupted/non-string data → `"none"` (fail closed).
 */
export function normalizeRuntimeToolPolicy(input: unknown): RuntimeToolPolicy | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  if (input === "none") {
    return "none";
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    // Corrupted persisted shape — fail closed.
    return "none";
  }

  // Reject unknown keys in persisted data — a typo or schema drift must not
  // silently become unrestricted. Fail closed to "none".
  const rawKeys = Object.keys(input);
  const knownKeys = new Set(["allow", "deny"]);
  if (rawKeys.some((k) => !knownKeys.has(k))) {
    return "none";
  }

  const raw = input as { allow?: unknown; deny?: unknown };
  const allow = cleanToolList(raw.allow);
  const deny = cleanToolList(raw.deny);

  // Corrupted entries (non-string elements) → fail closed.
  if (allow === null || deny === null) {
    return "none";
  }

  // deny: ["*"] → "none"
  if (deny.includes(DENY_ALL)) {
    return "none";
  }
  // allow: [] (explicit empty, after cleaning) → "none"
  if (raw.allow !== undefined && allow.length === 0) {
    return "none";
  }
  // No effective restriction.
  if (allow.length === 0 && deny.length === 0) {
    return undefined;
  }
  // allow: ["*"] with no deny → no restriction
  if (allow.includes(DENY_ALL) && deny.length === 0) {
    return undefined;
  }

  const result: { allow?: string[]; deny?: string[] } = {};
  if (allow.length > 0) {
    result.allow = allow;
  }
  if (deny.length > 0) {
    result.deny = deny;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Convert a `RuntimeToolPolicy` to a `SandboxToolPolicy` for the tool pipeline.
 *
 * - `undefined` → `undefined` (no policy layer).
 * - `"none"` → `{ deny: ["*"] }` — the deny-all sentinel. We do NOT use
 *   `{ allow: [] }` because the existing matcher treats empty allow as
 *   "allow everything not denied".
 * - `{ allow, deny }` → passed through.
 */
export function runtimeToolPolicyToSandboxPolicy(
  policy: RuntimeToolPolicy | undefined,
): SandboxToolPolicy | undefined {
  if (policy === undefined) {
    return undefined;
  }
  if (policy === "none") {
    return { deny: [DENY_ALL] };
  }
  return {
    ...(policy.allow ? { allow: [...policy.allow] } : {}),
    ...(policy.deny ? { deny: [...policy.deny] } : {}),
  };
}

/** Whether a runtime tool policy imposes any restriction. */
export function isRuntimeToolPolicyActive(policy: RuntimeToolPolicy | undefined): boolean {
  return policy !== undefined;
}

/**
 * Structural equality after normalization. Use this for immutable-guard
 * checks instead of raw JSON.stringify on unsorted input.
 */
export function runtimeToolPolicyEqual(
  a: RuntimeToolPolicy | undefined,
  b: RuntimeToolPolicy | undefined,
): boolean {
  const na = normalizeRuntimeToolPolicy(a);
  const nb = normalizeRuntimeToolPolicy(b);
  if (na === nb) {
    return true;
  }
  if (na === undefined || nb === undefined) {
    return false;
  }
  if (na === "none" || nb === "none") {
    return na === nb;
  }
  return listsEqual(na.allow, nb.allow) && listsEqual(na.deny, nb.deny);
}

function listsEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === undefined && b === undefined) {
    return true;
  }
  if (a === undefined || b === undefined) {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  const sa = [...a].toSorted();
  const sb = [...b].toSorted();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Clean a raw tool list: validate strings, trim, drop blanks, dedupe.
 * Returns a new array. If the input is `undefined`, returns `[]`.
 * If the input contains non-string entries, returns `null` (corrupted → fail closed).
 */
function cleanToolList(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return null;
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      return null;
    }
    const trimmed = entry.trim();
    if (trimmed === "") {
      continue;
    }
    const normalized = normalizeToolName(trimmed);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}
