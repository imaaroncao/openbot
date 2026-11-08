/**
 * Self-hosted fork: a small window to set the account service and Signal of this build.
 *
 * It is a sandboxed page with no preload and no Node access. The page talks to the main process by
 * navigating to `openbot-selfhost://<action>?...`, which `will-navigate` intercepts, so it needs no
 * new IPC channel and no change to the upstream preload bundle.
 */

import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { app, BrowserWindow, dialog } from "electron";
import {
  normalizeAuthApiUrl,
  normalizeSignalUrl,
  readBundledSelfHostConfig,
  readUserSelfHostConfig,
  suggestSignalUrl,
  writeUserSelfHostConfig,
} from "./config";

const ACTION_PROTOCOL = "openbot-selfhost:";
let openWindow: BrowserWindow | null = null;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);
}

function page(values: { authApiUrl: string; signalUrl: string; bundled: string; active: string }): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>自托管服务器</title>
<style>
  :root { color-scheme: light dark; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { margin: 0; padding: 20px 22px; }
  h1 { font-size: 15px; margin: 0 0 6px; }
  p.hint { margin: 0 0 14px; opacity: .7; line-height: 1.45; }
  label { display: block; font-weight: 600; margin: 12px 0 4px; }
  input { box-sizing: border-box; width: 100%; padding: 7px 9px; border-radius: 6px; border: 1px solid #8886; font: inherit; background: transparent; }
  small { display: block; opacity: .6; margin-top: 3px; }
  .row { display: flex; gap: 8px; margin-top: 18px; }
  button { padding: 6px 14px; border-radius: 6px; border: 1px solid #8886; background: transparent; font: inherit; cursor: pointer; }
  button.primary { background: #6960f1; border-color: #6960f1; color: white; }
  #status { margin-top: 12px; min-height: 18px; white-space: pre-wrap; }
  .ok { color: #2e9d5b; } .bad { color: #d2453d; }
  code { font: 12px ui-monospace, Menlo, monospace; }
</style></head><body>
<h1>自托管服务器</h1>
<p class="hint">这个版本不连接 openbot.run。填写你自己 VPS 上的账号服务和 Signal 地址，保存后重启生效。<br>
切换到另一台服务器之前，请先在应用里退出登录。</p>
<label for="api">账号服务地址（Account API）</label>
<input id="api" placeholder="https://api.example.com" value="${escapeHtml(values.authApiUrl)}">
<small>HTTPS 根地址，不带路径。</small>
<label for="signal">Signal 地址</label>
<input id="signal" placeholder="wss://signal.example.com/v1/signal" value="${escapeHtml(values.signalUrl)}">
<small>必须和服务端 <code>REMOTE_SIGNAL_URL</code> 完全一致。</small>
<p class="hint" style="margin-top:14px">当前生效：<code>${escapeHtml(values.active)}</code><br>打包内置默认：<code>${escapeHtml(values.bundled)}</code></p>
<div class="row">
  <button id="test">测试连接</button>
  <button id="reset">恢复内置默认</button>
  <span style="flex:1"></span>
  <button id="save" class="primary">保存并重启</button>
</div>
<div id="status"></div>
<script>
  const api = document.getElementById("api");
  const signal = document.getElementById("signal");
  const go = (action) => {
    const query = new URLSearchParams({ api: api.value.trim(), signal: signal.value.trim() });
    location.href = "openbot-selfhost://" + action + "?" + query.toString();
  };
  api.addEventListener("change", () => {
    if (signal.value.trim() !== "") return;
    try {
      const host = new URL(api.value.trim()).hostname;
      signal.value = "wss://signal." + (host.startsWith("api.") ? host.slice(4) : host) + "/v1/signal";
    } catch {}
  });
  document.getElementById("test").onclick = () => go("test");
  document.getElementById("save").onclick = () => go("save");
  document.getElementById("reset").onclick = () => go("reset");
  window.showStatus = (text, ok) => {
    const status = document.getElementById("status");
    status.textContent = text;
    status.className = ok ? "ok" : "bad";
  };
</script>
</body></html>`;
}

async function testServer(authApiUrl: string): Promise<{ ok: boolean; text: string }> {
  try {
    const health = await fetch(`${authApiUrl}/health/live`, { signal: AbortSignal.timeout(8_000) });
    await health.body?.cancel();
    if (!health.ok) return { ok: false, text: `账号服务返回 HTTP ${health.status}` };
    const jwks = await fetch(`${authApiUrl}/.well-known/jwks.json`, { signal: AbortSignal.timeout(8_000) });
    const body = jwks.ok ? await jwks.json() : null;
    const keys = isDynamicRecord(body) ? body.keys : undefined;
    if (!Array.isArray(keys) || keys.length === 0) {
      return { ok: false, text: "账号服务可以访问，但 /.well-known/jwks.json 没有返回签名公钥。" };
    }
    return { ok: true, text: `连接成功：账号服务在线，公钥 ${keys.length} 个。` };
  } catch (error) {
    return { ok: false, text: `无法连接账号服务：${error instanceof Error ? error.message : String(error)}` };
  }
}

function showStatus(window: BrowserWindow, text: string, ok: boolean): void {
  void window.webContents.executeJavaScript(`window.showStatus(${JSON.stringify(text)}, ${ok ? "true" : "false"})`);
}

async function relaunchAfterChange(window: BrowserWindow, message: string): Promise<void> {
  const { response } = await dialog.showMessageBox(window, {
    type: "info",
    message,
    detail: "新的服务器地址在重启后生效。",
    buttons: ["立即重启", "稍后"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    app.relaunch();
    app.quit();
  } else {
    window.close();
  }
}

async function handleAction(window: BrowserWindow, target: URL): Promise<void> {
  const action = target.hostname;
  const authApiUrl = normalizeAuthApiUrl(target.searchParams.get("api"));
  const signalUrl = normalizeSignalUrl(target.searchParams.get("signal"));
  const userData = app.getPath("userData");
  if (action === "reset") {
    writeUserSelfHostConfig(userData, null);
    await relaunchAfterChange(window, "已恢复为打包时内置的服务器地址。");
    return;
  }
  if (!authApiUrl) {
    showStatus(window, "账号服务地址必须是 https:// 开头的根地址，例如 https://api.example.com", false);
    return;
  }
  if (action === "test") {
    showStatus(window, "正在测试…", true);
    const result = await testServer(authApiUrl);
    showStatus(window, result.text, result.ok);
    return;
  }
  if (action === "save") {
    if (!signalUrl) {
      showStatus(window, "Signal 地址必须是 wss:// 开头，例如 wss://signal.example.com/v1/signal", false);
      return;
    }
    writeUserSelfHostConfig(userData, { authApiUrl, signalUrl });
    await relaunchAfterChange(window, "服务器地址已保存。");
  }
}

export function openSelfHostServerWindow(parent: BrowserWindow | null): void {
  if (openWindow && !openWindow.isDestroyed()) {
    openWindow.focus();
    return;
  }
  const userData = app.getPath("userData");
  const user = readUserSelfHostConfig(userData);
  const bundled = readBundledSelfHostConfig(app.isPackaged ? process.resourcesPath : undefined);
  const activeApi = process.env.OPENBOT_AUTH_API_URL ?? "";
  const values = {
    authApiUrl: user?.authApiUrl ?? bundled?.authApiUrl ?? "",
    signalUrl: user?.signalUrl ?? bundled?.signalUrl ?? "",
    bundled: bundled ? `${bundled.authApiUrl} · ${bundled.signalUrl}` : "（无）",
    active: activeApi.startsWith("http://127.0.0.1:9") ? "未配置（仅本机使用）" : activeApi || "（无）",
  };
  if (!values.signalUrl && values.authApiUrl) values.signalUrl = suggestSignalUrl(values.authApiUrl);

  const window = new BrowserWindow({
    width: 560,
    height: 470,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "自托管服务器",
    ...(parent && !parent.isDestroyed() ? { parent } : {}),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true },
  });
  openWindow = window;
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return;
    }
    if (target.protocol !== ACTION_PROTOCOL) return;
    void handleAction(window, target).catch((error) =>
      showStatus(window, error instanceof Error ? error.message : String(error), false),
    );
  });
  window.on("closed", () => {
    if (openWindow === window) openWindow = null;
  });
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page(values))}`);
}
