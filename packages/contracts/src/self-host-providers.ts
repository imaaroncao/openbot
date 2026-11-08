/**
 * Self-hosted fork: built-in providers that this build does not offer.
 *
 * The ids stay in AGENT_PROVIDERS, because released Team API adapters and saved agents name them.
 * A removed provider is always off (src/main/provider-use-settings-store.ts): it never starts, gets
 * no runtime download or update check, and its models are not offered. The setup, Settings and the
 * phone's server settings do not list it.
 */
import type { AgentProviderId } from "./agent-providers";

export const SELF_HOST_REMOVED_PROVIDERS: readonly AgentProviderId[] = ["opencode"];

export function isSelfHostRemovedProvider(provider: string): boolean {
  return SELF_HOST_REMOVED_PROVIDERS.some((removed) => removed === provider);
}
