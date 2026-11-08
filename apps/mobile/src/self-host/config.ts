/**
 * Self-hosted fork: the account service that email sign-in uses on this phone.
 *
 * Scanning the desktop's QR code already carries the desktop's account service, so a phone paired
 * that way needs nothing here. Email sign-in needs an address:
 *   1. the one the user typed on the sign-in screen (kept in SecureStore), else
 *   2. `EXPO_PUBLIC_OPENBOT_API_URL`, baked into the build by `selfhost/ios/build-testflight.sh`.
 * With neither, email sign-in goes to a closed loopback port and fails at once. It never falls back
 * to api.openbot.run.
 */

import { parseMobileConnectUrl } from "@openbot/contracts/mobile-connect";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

const STORAGE_KEY = "openbot.selfhost.account-api.v1";
export const DISABLED_ACCOUNT_API_URL = "http://127.0.0.1:9";

/** HTTPS origin, or HTTP on a private network (the same rule as a Mobile Connect QR code). */
export function normalizeSelfHostApiUrl(value: string | null | undefined): string | null {
  if (!value || value.trim() === "") return null;
  return (
    parseMobileConnectUrl(`openbot://mobile-connect?api=${encodeURIComponent(value.trim())}&ticket=${"x".repeat(32)}`)
      ?.apiUrl ?? null
  );
}

export const BUNDLED_ACCOUNT_API_URL = normalizeSelfHostApiUrl(process.env.EXPO_PUBLIC_OPENBOT_API_URL);

function readStored(): string | null {
  try {
    return normalizeSelfHostApiUrl(SecureStore.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export const useSelfHostServer = create<{ override: string | null }>(() => ({ override: readStored() }));

/** The account service for email sign-in, or null when none is set. */
export function selfHostAccountApiUrl(): string | null {
  return useSelfHostServer.getState().override ?? BUNDLED_ACCOUNT_API_URL;
}

/** Saves the user's address. `null` returns to the address baked into the build. */
export async function saveSelfHostAccountApiUrl(value: string | null): Promise<void> {
  const normalized = value === null ? null : normalizeSelfHostApiUrl(value);
  if (value !== null && !normalized) throw new Error("invalid_url");
  if (normalized) await SecureStore.setItemAsync(STORAGE_KEY, normalized);
  else await SecureStore.deleteItemAsync(STORAGE_KEY);
  useSelfHostServer.setState({ override: normalized });
}

/** Checks that `apiUrl` answers like an OpenBot account service. */
export async function testSelfHostAccountApi(apiUrl: string): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await fetch(new URL("/.well-known/jwks.json", apiUrl).toString(), {
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return { ok: false, message: `HTTP ${response.status}` };
    const body = await response.json();
    const keys = isDynamicRecord(body) ? body.keys : undefined;
    if (!Array.isArray(keys) || keys.length === 0) return { ok: false, message: "no signing keys" };
    return { ok: true, message: "ok" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
