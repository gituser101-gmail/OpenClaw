import type { ClawDiagnostic } from "./types.js";

export const CLAW_SETUP_ADD_MUTATION_UNAVAILABLE_MESSAGE =
  "Schema version 2 Claws are preview-only until personalization state and seed handoff are available.";

export const CLAW_SETUP_UPDATE_MUTATION_UNAVAILABLE_MESSAGE =
  "Schema version 2 Claw updates are preview-only until personalization state and seed handoff are available.";

export function clawSetupAddMutationUnavailableDiagnostic(): ClawDiagnostic {
  return {
    level: "error",
    code: "setup_mutation_unavailable",
    phase: "plan",
    path: "$.schemaVersion",
    message: CLAW_SETUP_ADD_MUTATION_UNAVAILABLE_MESSAGE,
  };
}

export function clawSetupUpdateMutationUnavailableDiagnostic(): ClawDiagnostic {
  return {
    level: "error",
    code: "setup_mutation_unavailable",
    phase: "plan",
    path: "$.schemaVersion",
    message: CLAW_SETUP_UPDATE_MUTATION_UNAVAILABLE_MESSAGE,
  };
}
