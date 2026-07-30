import type { PluginBundleFormat } from "./manifest-types.js";

export function isBundleCapabilitySupported(
  format: PluginBundleFormat,
  capability: string,
): boolean {
  if (capability === "skills" || capability === "mcpServers" || capability === "settings") {
    return true;
  }
  if (
    (capability === "commands" ||
      capability === "agents" ||
      capability === "outputStyles" ||
      capability === "lspServers") &&
    (format === "claude" || format === "cursor")
  ) {
    return true;
  }
  return capability === "hooks" && (format === "codex" || format === "claude");
}
