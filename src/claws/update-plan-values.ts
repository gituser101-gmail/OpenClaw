import { createHash } from "node:crypto";
import { stableStringify } from "../agents/stable-stringify.js";
import type { ClawDiagnostic } from "./types.js";

export function digestClawUpdateValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

export function clawUpdateDiagnostic(code: string, path: string, message: string): ClawDiagnostic {
  return { level: "error", code, phase: "plan", path, message };
}

export function isManualClawUpdateState(state: string): boolean {
  return state === "modified" || state === "unsafe" || state === "pending" || state === "failed";
}
