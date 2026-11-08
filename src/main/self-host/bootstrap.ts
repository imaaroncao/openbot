/**
 * Self-hosted fork: imported FIRST by `src/main/index.ts`, before any module that reads
 * `OPENBOT_AUTH_API_URL` or `OPENBOT_REMOTE_SIGNAL_URL`, so the upstream self-hosting support picks
 * up the user's server, and the vendor network guard is in place before the first request.
 *
 * This file has side effects on purpose. It only reads files and sets environment variables; it
 * does not touch `session.defaultSession` before the app is ready.
 */

import { resolve } from "node:path";
import { app } from "electron";
import { DISABLED_AUTH_API_URL, resolveSelfHostConfig } from "./config";
import { installVendorNetworkGuard } from "./network-guard";

function userDataDirectory(): string {
  // `--user-data-dir` moves the profile later in `index.ts`; read the same switch here.
  const fromCommandLine = app.commandLine.getSwitchValue("user-data-dir").trim();
  return fromCommandLine ? resolve(fromCommandLine) : app.getPath("userData");
}

const resolved = resolveSelfHostConfig({
  environment: process.env,
  userDataDirectory: userDataDirectory(),
  resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
});

if (resolved.config) {
  process.env.OPENBOT_AUTH_API_URL = resolved.config.authApiUrl;
  if (resolved.config.signalUrl) process.env.OPENBOT_REMOTE_SIGNAL_URL = resolved.config.signalUrl;
} else if (app.isPackaged) {
  // No server yet: keep the app local. Without this, upstream falls back to https://api.openbot.run.
  process.env.OPENBOT_AUTH_API_URL = DISABLED_AUTH_API_URL;
  delete process.env.OPENBOT_REMOTE_SIGNAL_URL;
}

const ownOrigins: string[] = [];
for (const value of [process.env.OPENBOT_AUTH_API_URL, process.env.OPENBOT_REMOTE_SIGNAL_URL]) {
  try {
    if (value) ownOrigins.push(new URL(value).origin);
  } catch {
    // An invalid value is reported by the upstream validation that reads it.
  }
}
installVendorNetworkGuard(ownOrigins);

export const selfHostConfigSource = resolved.source;
