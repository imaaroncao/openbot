/**
 * Self-hosted fork: the text of the fork's own screens.
 *
 * It stays out of the upstream `@openbot/i18n` catalogs on purpose: those files change in almost
 * every upstream release, and a fork key in each of them would conflict at every merge. Chinese
 * when the phone's first language is Chinese, else English.
 */

import { phoneLanguages } from "@/shared/lib/phone-languages";

const zh = {
  badge: "服务器",
  badgeChange: "修改",
  badgeUnset: "未设置",
  badgeLabel: "更改账号服务器",
  title: "账号服务器",
  hint: "邮箱登录使用这个地址。扫描电脑端二维码登录时，会自动使用电脑端的服务器。",
  bundled: "内置默认",
  invalid: "请输入 https:// 开头的根地址，例如 https://api.example.com",
  ok: "连接成功",
  failed: "无法连接",
  reset: "恢复默认",
  test: "测试",
  cancel: "取消",
  save: "保存",
  placeholder: "https://api.example.com",
};

const en: typeof zh = {
  badge: "Server",
  badgeChange: "Change",
  badgeUnset: "not set",
  badgeLabel: "Change the account server",
  title: "Account server",
  hint: "Email sign-in uses this address. Signing in with the desktop QR code uses the desktop's server.",
  bundled: "Built-in default",
  invalid: "Enter an https:// root address, such as https://api.example.com",
  ok: "Connected",
  failed: "Cannot connect",
  reset: "Use default",
  test: "Test",
  cancel: "Cancel",
  save: "Save",
  placeholder: "https://api.example.com",
};

export type SelfHostMessages = typeof zh;

export function selfHostMessages(): SelfHostMessages {
  return phoneLanguages()[0]?.toLowerCase().startsWith("zh") ? zh : en;
}
