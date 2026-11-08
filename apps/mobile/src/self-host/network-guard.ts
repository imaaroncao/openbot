/**
 * Self-hosted fork: imported first by `src/app/_layout.tsx`.
 *
 * Refuses JavaScript requests (fetch and XMLHttpRequest) to the vendor's services, so an
 * analytics or update call that a future upstream merge adds cannot leave the phone. The user's
 * own account service and Signal are never on these hosts. Native over-the-air updates are off in
 * `app.config.js`.
 */

const BLOCKED_HOST_SUFFIXES = ["openbot.run", "openpanel.dev", "expo.dev", "exp.host"];
const BLOCKED_URL_PREFIXES = [
  "https://github.com/nightly-labs/",
  "https://api.github.com/repos/nightly-labs/",
  "https://raw.githubusercontent.com/nightly-labs/",
];

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
  if (!["https:", "http:", "wss:", "ws:"].includes(url.protocol)) return false;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => hostMatches(url.hostname, suffix))) return true;
  const href = url.toString();
  return BLOCKED_URL_PREFIXES.some((prefix) => href.startsWith(prefix));
}

function requestUrl(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof input === "object" && input !== null && "url" in input && typeof input.url === "string") {
    return input.url;
  }
  return "";
}

declare global {
  // eslint-disable-next-line no-var
  var __openbotSelfHostGuard: boolean | undefined;
}

if (!globalThis.__openbotSelfHostGuard) {
  globalThis.__openbotSelfHostGuard = true;

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === "function") {
    const guardedFetch: typeof fetch = (input, init) =>
      isBlockedVendorUrl(requestUrl(input))
        ? Promise.reject(new TypeError("Network request failed: blocked by the self-hosted build"))
        : originalFetch(input, init);
    globalThis.fetch = Object.assign(guardedFetch, originalFetch);
  }

  const xhr = globalThis.XMLHttpRequest?.prototype;
  if (xhr) {
    const originalOpen = xhr.open;
    // An unreachable address makes the request fail like a network error, through the normal path.
    xhr.open = function open(
      this: XMLHttpRequest,
      method: string,
      url: string,
      async?: boolean,
      user?: string | null,
      password?: string | null,
    ): void {
      const target = isBlockedVendorUrl(url) ? "http://127.0.0.1:9/blocked" : url;
      if (async === undefined) originalOpen.call(this, method, target);
      else originalOpen.call(this, method, target, async, user, password);
    };
  }
}
