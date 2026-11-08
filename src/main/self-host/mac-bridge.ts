/**
 * Self-hosted fork: the Mac bridge. While the user turns it on (OpenBot menu), agents on the VPS can
 * use this Mac's Computer Use driver through their MCP tool `/data/mac-bridge/connect.sh`:
 *
 *   VPS agent -> 172.31.250.1:2222 on the VPS -> SSH tunnel opened from this Mac to the restricted
 *   VPS user -> 127.0.0.1:47777 here (the token first) -> `cua-driver mcp` of this app's driver
 *
 * The driver uses the screen permissions of this app, with its telemetry and update check off. The
 * bridge is off at each start and stops when OpenBot quits. `selfhost/mac-bridge/mac-bridge.sh
 * setup root@<VPS>` makes the key, the token and the VPS side once (~/.config/openbot/mac-bridge).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { app, Notification } from "electron";

const logger = createOpenBotLogger("mac-bridge");

const CONFIG_DIRECTORY = join(homedir(), ".config", "openbot", "mac-bridge");
const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = 47777;
/** The address on the VPS that the tunnel opens; the VPS firewall lets only the host container in. */
const REMOTE_ADDRESS = "172.31.250.1:2222";
const TOKEN_LINE_LIMIT = 512;
const TUNNEL_RETRY_MS = 5_000;

/** How to start `cua-driver mcp` for this app's running daemon, or null while it does not run. */
export type MacBridgeDriver = () => Pick<McpServerConfig, "command" | "args" | "env"> | null;

let driver: MacBridgeDriver | null = null;
let server: Server | null = null;
let tunnel: ChildProcess | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const connections = new Set<{ socket: Socket; child: ChildProcess | null }>();

/** `application-services.ts` hands over the Computer Use driver. */
export function registerMacBridgeDriver(value: MacBridgeDriver): void {
  driver = value;
}

/** True when `mac-bridge.sh setup` made the key, the token and the VPS address. */
export function macBridgeConfigured(): boolean {
  return (
    process.platform === "darwin" &&
    ["token", "id_ed25519", "vps"].every((file) => existsSync(join(CONFIG_DIRECTORY, file)))
  );
}

export function macBridgeRunning(): boolean {
  return server !== null;
}

function readConfig(file: string): string {
  return readFileSync(join(CONFIG_DIRECTORY, file), "utf8").trim();
}

function tokenMatches(expected: Buffer, line: string): boolean {
  const received = Buffer.from(line, "utf8");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** One agent connection: the token line, then the bytes of one `cua-driver mcp` process. */
function serve(socket: Socket, token: Buffer): void {
  const connection: { socket: Socket; child: ChildProcess | null } = { socket, child: null };
  connections.add(connection);
  const close = () => {
    connection.child?.kill();
    socket.destroy();
    connections.delete(connection);
  };
  socket.on("error", close);
  socket.on("close", close);
  socket.setTimeout(10_000, close);
  let received = Buffer.alloc(0);
  const readToken = (chunk: Buffer) => {
    received = Buffer.concat([received, chunk]);
    const newline = received.indexOf(10);
    if (newline === -1) {
      if (received.length > TOKEN_LINE_LIMIT) close();
      return;
    }
    socket.off("data", readToken);
    socket.pause();
    socket.setTimeout(0);
    if (!tokenMatches(token, received.subarray(0, newline).toString("utf8").trim())) {
      logger.warn("Refused a Mac bridge connection without the token.");
      return close();
    }
    const command = driver?.();
    if (!command) {
      logger.warn("An agent asked for this Mac, but the Computer Use driver is not running.");
      return close();
    }
    const environment = { ...process.env, ...Object.fromEntries(command.env.map(({ key, value }) => [key, value])) };
    const child = spawn(command.command, command.args, { env: environment, stdio: ["pipe", "pipe", "ignore"] });
    connection.child = child;
    child.on("exit", close);
    child.on("error", close);
    const rest = received.subarray(newline + 1);
    if (rest.length > 0) child.stdin?.write(rest);
    if (child.stdin) socket.pipe(child.stdin);
    child.stdout?.pipe(socket);
    socket.resume();
    logger.info("An agent on the VPS connected to this Mac.");
  };
  socket.on("data", readToken);
}

/** The reverse tunnel to the VPS. It opens again after a network change, until the bridge stops. */
function openTunnel(): void {
  if (!server) return;
  const vps = readConfig("vps");
  const child = spawn(
    "/usr/bin/ssh",
    [
      "-N",
      "-i",
      join(CONFIG_DIRECTORY, "id_ed25519"),
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${join(CONFIG_DIRECTORY, "known_hosts")}`,
      "-R",
      `${REMOTE_ADDRESS}:${LISTEN_HOST}:${LISTEN_PORT}`,
      vps,
    ],
    { stdio: "ignore" },
  );
  tunnel = child;
  child.on("exit", (code) => {
    if (tunnel !== child) return;
    tunnel = null;
    if (!server) return;
    logger.warn("The Mac bridge tunnel closed; it opens again.", { code });
    retryTimer = setTimeout(openTunnel, TUNNEL_RETRY_MS);
  });
}

export function startMacBridge(): void {
  if (server || !macBridgeConfigured()) return;
  const token = Buffer.from(readConfig("token"), "utf8");
  const listener = createServer((socket) => serve(socket, token));
  listener.on("error", (error) => {
    logger.error("The Mac bridge could not listen.", { message: error.message });
    stopMacBridge();
  });
  server = listener;
  listener.listen(LISTEN_PORT, LISTEN_HOST, () => {
    logger.info("The Mac bridge is on.");
    openTunnel();
  });
}

export function stopMacBridge(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  const listener = server;
  server = null;
  listener?.close();
  const child = tunnel;
  tunnel = null;
  child?.kill();
  for (const connection of connections) {
    connection.child?.kill();
    connection.socket.destroy();
  }
  connections.clear();
  if (listener) logger.info("The Mac bridge is off.");
}

/** The OpenBot menu switch: turns the bridge on or off and says so in a notification. */
export function setMacBridge(on: boolean): void {
  if (on) startMacBridge();
  else stopMacBridge();
  if (!Notification.isSupported()) return;
  new Notification(
    on
      ? { title: "Mac 桥接已开启", body: "VPS 上的 agent 现在可以操作这台 Mac。用完请在 OpenBot 菜单里关闭。" }
      : { title: "Mac 桥接已关闭", body: "VPS 上的 agent 不能再操作这台 Mac。" },
  ).show();
}

app.on("will-quit", stopMacBridge);
