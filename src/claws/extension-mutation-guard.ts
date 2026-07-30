import type { ClawOpenClawProfile } from "./types.js";

export const CLAW_EXTENSION_MUTATION_UNAVAILABLE_MESSAGE =
  "OpenClaw profile extensions are preview-only until canonical extension lifecycle support is available.";

export function hasClawProfileExtensions(profile: ClawOpenClawProfile | undefined): boolean {
  return profile?.schemaVersion === 2 && profile.extensions.length > 0;
}
