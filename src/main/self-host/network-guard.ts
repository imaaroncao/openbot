/**
 * Self-hosted fork: a last line of defense against requests to the vendor's services.
 *
 * The analytics and update code paths are switched off where they start, but upstream keeps adding
 * features. This guard makes sure a merged upstream change cannot reach the vendor anyway: every
 * Electron session (the app window, the embedded browser, `net.fetch`, electron-updater) and the
 * main process `fetch` refuse requests to the hosts below. The user's own server is never blocked.
 */

import { app, type Session, session } from "electron";

/** Every host that ends with one of these is the vendor's (`openbot.run`, `api.openbot.run`, ...). */
const BLOCKED_HOST_SUFFIXES = ["openbot.run", "openpanel.dev"];
/** Vendor resources on shared hosts: releases, update feeds and remote lists of the upstream repo. */
const BLOCKED_URL_PREFIXES = [
  "https://github.com/nightly-labs/",
  "https://api.github.com/repos/nightly-labs/",
  "https://raw.githubusercontent.com/nightly-labs/",
  "https://objects.githubusercontent.com/github-production-release-asset-", // release downloads
  "https://u.expo.dev/",
  "https://exp.host/",
];
/** Release asset downloads are only blocked when they belong to the upstream repository. */
const RELEASE_ASSET_HINT = "nightly-labs";

let allowedOrigins = new Set<string>();
let installed = false;

function hostMatches(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

export function isBlockedVendorUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "wss:" && url.protocol !== "ws:") {
    return false;
  }
  if (allowedOrigins.has(url.origin)) return false;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => hostMatches(url.hostname, suffix))) return true;
  const href = url.toString();
  return BLOCKED_URL_PREFIXES.some((prefix) => {
    if (!href.startsWith(prefix)) return false;
    if (prefix.startsWith("https://objects.githubusercontent.com/")) return href.includes(RELEASE_ASSET_HINT);
    return true;
  });
}

function guardSession(target: Session): void {
  target.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    if (isBlockedVendorUrl(details.url)) {
      callback({ cancel: true });
      return;
    }
    callback({});
  });
}

function guardFetch(): void {
  const original = globalThis.fetch;
  if (typeof original !== "function") return;
  const guarded = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (isBlockedVendorUrl(href)) {
      return Promise.reject(new TypeError("fetch failed: blocked by the self-hosted build"));
    }
    return original(input, init);
  };
  // Keep the static members (such as `preconnect`) of the original function.
  globalThis.fetch = Object.assign(guarded, original);
}

/**
 * Installs the guard. `ownOrigins` are the origins of the user's own account service and Signal,
 * which stay reachable even when they happen to match a rule above.
 */
export function installVendorNetworkGuard(ownOrigins: readonly string[]): void {
  allowedOrigins = new Set(ownOrigins);
  if (installed) return;
  installed = true;
  guardFetch();
  // `webRequest` needs a ready app; every session made later gets the guard as it is created.
  app.on("session-created", guardSession);
  void app.whenReady().then(() => guardSession(session.defaultSession));
}
