/**
 * Self-hosted fork: where this build finds its own account service and Signal.
 *
 * The upstream app already supports a self-hosted account service through the
 * `OPENBOT_AUTH_API_URL` and `OPENBOT_REMOTE_SIGNAL_URL` environment variables
 * (docs/self-hosting.md). This module fills those variables at startup, so the
 * rest of the upstream code keeps working unchanged and a merge from upstream
 * does not conflict with it.
 *
 * Order, first one wins:
 *   1. the environment variables themselves (an explicit start from a terminal),
 *   2. `<userData>/self-host.json`, written by the "Self-hosted server" window,
 *   3. `<resources>/self-host.json`, baked into the package at build time
 *      (`selfhost/desktop/build-dmg.sh` writes it from `selfhost/selfhost.env`).
 *
 * With none of them, the account service is a closed loopback port: sign-in
 * fails at once, the local workspace still works, and nothing goes to openbot.run.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";

export const SELF_HOST_CONFIG_FILE = "self-host.json";
/** A loopback port that nothing listens on: requests fail immediately, nothing leaves the computer. */
export const DISABLED_AUTH_API_URL = "http://127.0.0.1:9";

export interface SelfHostConfig {
  /** HTTPS origin of the account service (the auth-api Worker), such as `https://api.example.com`. */
  authApiUrl: string;
  /** `wss:` URL of Signal, such as `wss://signal.example.com/v1/signal`. Empty: not set. */
  signalUrl: string;
}

export type SelfHostConfigSource = "environment" | "user" | "bundled" | "none";

export interface ResolvedSelfHostConfig {
  config: SelfHostConfig | null;
  source: SelfHostConfigSource;
}

export function normalizeAuthApiUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const url = new URL(value.trim());
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    if (url.username !== "" || url.password !== "") return null;
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function normalizeSignalUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "wss:" || url.username !== "" || url.password !== "") return null;
    if (url.search !== "" || url.hash !== "") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The usual Signal address for an account service at `api.<domain>`: `wss://signal.<domain>/v1/signal`. */
export function suggestSignalUrl(authApiUrl: string): string {
  try {
    const { hostname } = new URL(authApiUrl);
    const domain = hostname.startsWith("api.") ? hostname.slice(4) : hostname;
    return `wss://signal.${domain}/v1/signal`;
  } catch {
    return "";
  }
}

export function parseSelfHostConfig(value: unknown): SelfHostConfig | null {
  if (!isDynamicRecord(value)) return null;
  const authApiUrl = normalizeAuthApiUrl(value.authApiUrl);
  const signalUrl = normalizeSignalUrl(value.signalUrl);
  if (!authApiUrl || !signalUrl) return null;
  return { authApiUrl, signalUrl };
}

function readConfigFile(path: string): SelfHostConfig | null {
  try {
    if (!existsSync(path)) return null;
    return parseSelfHostConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export function userConfigPath(userDataDirectory: string): string {
  return join(userDataDirectory, SELF_HOST_CONFIG_FILE);
}

export function bundledConfigPath(resourcesPath: string | undefined): string | null {
  return resourcesPath ? join(resourcesPath, SELF_HOST_CONFIG_FILE) : null;
}

export function resolveSelfHostConfig(options: {
  environment: NodeJS.ProcessEnv;
  userDataDirectory: string;
  resourcesPath: string | undefined;
}): ResolvedSelfHostConfig {
  const environmentApi = normalizeAuthApiUrl(options.environment.OPENBOT_AUTH_API_URL);
  if (environmentApi) {
    const signalUrl = normalizeSignalUrl(options.environment.OPENBOT_REMOTE_SIGNAL_URL);
    // Upstream lets OPENBOT_REMOTE_SIGNAL_URL stay unset; do not invent one.
    return { config: { authApiUrl: environmentApi, signalUrl: signalUrl ?? "" }, source: "environment" };
  }
  const user = readConfigFile(userConfigPath(options.userDataDirectory));
  if (user) return { config: user, source: "user" };
  const bundledPath = bundledConfigPath(options.resourcesPath);
  const bundled = bundledPath ? readConfigFile(bundledPath) : null;
  if (bundled) return { config: bundled, source: "bundled" };
  return { config: null, source: "none" };
}

export function readUserSelfHostConfig(userDataDirectory: string): SelfHostConfig | null {
  return readConfigFile(userConfigPath(userDataDirectory));
}

export function readBundledSelfHostConfig(resourcesPath: string | undefined): SelfHostConfig | null {
  const path = bundledConfigPath(resourcesPath);
  return path ? readConfigFile(path) : null;
}

/**
 * The user's own GitHub App for the built-in GitHub connection, from the bundled self-host.json
 * (`githubClientId`, `githubAppSlug`, written by selfhost/desktop/build-dmg.sh). It is not part of
 * the server choice in the menu: it is fixed when the app is built.
 */
export interface SelfHostGitHubApp {
  clientId: string;
  slug: string;
}

export function readBundledGitHubApp(resourcesPath: string | undefined): SelfHostGitHubApp | null {
  const path = bundledConfigPath(resourcesPath);
  try {
    if (!path || !existsSync(path)) return null;
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!isDynamicRecord(value)) return null;
    const { githubClientId: clientId, githubAppSlug: slug } = value;
    if (typeof clientId !== "string" || !/^[A-Za-z0-9.]+$/u.test(clientId)) return null;
    if (typeof slug !== "string" || !/^[a-z0-9-]+$/u.test(slug)) return null;
    return { clientId, slug };
  } catch {
    return null;
  }
}

/** Writes the user's choice atomically. `null` removes it, so the bundled default applies again. */
export function writeUserSelfHostConfig(userDataDirectory: string, config: SelfHostConfig | null): void {
  const path = userConfigPath(userDataDirectory);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config ?? {}, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
