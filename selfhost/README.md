# OpenBot 自托管版（个人使用）

这个分支在官方 [nightly-labs/openbot](https://github.com/nightly-labs/openbot) 之上做了三件事：

1. **去掉官方埋点上报**：产品分析（OpenPanel `analytics.openbot.run`）和错误上报在桌面主进程、桌面界面、手机端、账号服务里全部关闭。
2. **去掉官方请求**：不再连接 `api.openbot.run` / `signal.openbot.run`，不再从官方 GitHub Releases 自动更新，手机端不再检查 Expo OTA 更新。另外桌面端和手机端各有一道**网络拦截**，挡掉所有发往 `*.openbot.run`、OpenPanel、官方仓库 Releases、Expo 更新的请求。以后合并官方代码时即使新增了上报，也发不出去。
3. **改用你自己的服务器**：账号服务、Signal、TURN 都跑在你的 VPS 上（`selfhost/server`）。桌面端和手机端都可以填写服务器地址。

改动集中在少数几处，便于持续合并官方修复（见 [同步官方更新](#同步官方更新)）。

许可证仍是 PolyForm Noncommercial 1.0.0：只能非商业使用。

---

## 架构

```
 桌面端 (DMG)  ─┐                         VPS (docker compose)
 iPhone (TF)   ─┼── https://api.你的域名 ──▶ caddy ──▶ auth-api   账号/登录/主机注册 (workerd + SQLite)
 Linux 主机    ─┘── wss://signal.你的域名 ─▶ caddy ──▶ signal     WebRTC 信令
                    turn:signal.你的域名:3478 ──────▶ coturn     WebRTC 中继
```

聊天、文件、命令仍然只在运行 OpenBot 的电脑上，服务器只负责账号、会话和连接建立（和官方相同）。

## 一次性准备

```sh
cp selfhost/selfhost.env.example selfhost/selfhost.env   # 已为你生成，按需修改
```

`selfhost/selfhost.env` 里有：服务器地址、Apple Team ID、Developer ID 签名身份、App Store Connect API key、桌面端和 iOS 的 Bundle ID。git 不跟踪这个文件。

---

## 1. 部署服务器（VPS）

要求：Linux VPS（1 vCPU / 1 GB 内存即可），有公网 IPv4，并能用 SSH 登录。

**用 Oracle Cloud 永久免费实例**（可选）：自己注册好账号后（需要本人手机号和信用卡验证，只能本人操作）：

```sh
brew install oci-cli && oci setup config      # 在 Oracle 控制台 → 我的配置文件 → API 密钥 上传生成的公钥
selfhost/server/oracle/create-instance.sh --retry   # 创建 VCN、放行端口、开 2 核 12 GB ARM Ubuntu 实例
```

脚本会同时处理 Oracle Ubuntu 镜像自带的 iptables 拦截，并装好 Docker。免费 ARM 资源经常提示 "Out of capacity"，`--retry` 会每分钟换可用区重试。创建成功后把输出的 IP 填进 DNS 和 `.env`，部署时用 `ubuntu@<IP>`。

1. **DNS**：两条 A 记录指向 VPS 公网 IP，例如 `api.example.com` 和 `signal.example.com`。
2. **防火墙**：开放 `80/tcp`、`443/tcp`、`3478/tcp+udp`、`49160-49200/udp`。
3. **生成密钥**（在 Mac 上执行，只执行一次）：

   ```sh
   selfhost/server/scripts/init-secrets.sh
   ```

   然后编辑 `selfhost/server/.env` 顶部：域名、`TURN_PUBLIC_IP`、`ACME_EMAIL`，以及 **SMTP**（登录验证码通过邮件发送）。两种选择：

   - **Cloudflare Email Service**（域名在 Cloudflare 时推荐）：控制台 → Email → Email Sending 接入一个发信子域名（例如 `openbot.你的域名`），再创建一个有 "Email Sending: Edit" 权限的 API token。

     ```sh
     EMAIL_SMTP_HOST=smtp.mx.cloudflare.net
     EMAIL_SMTP_PORT=465
     EMAIL_SMTP_USERNAME=api_token          # 就是这几个字，不是邮箱
     EMAIL_SMTP_PASSWORD=<你的 API token>
     EMAIL_FROM=noreply@openbot.你的域名
     ```

     免费套餐只能发给已验证的收件地址（Email Routing → Destination addresses）；发给任意地址需要 Workers Paid。
   - **Gmail**：`smtp.gmail.com`、端口 465，密码用[应用专用密码](https://myaccount.google.com/apppasswords)。

   `.env` 只在你的 Mac 和 VPS 上（权限 600），git 不跟踪。部署后服务只依赖 VPS，Mac 关机不影响。

4. **部署**：

   ```sh
   selfhost/server/scripts/deploy.sh root@你的VPS --install-docker
   ```

   脚本会在 Mac 上编译账号服务（约 6 GB 内存，所以不在 VPS 上编译），把它和 Signal/TURN 的源码传到 VPS 的 `/opt/openbot-selfhost`，执行 `docker compose up -d --build`，最后检查 `https://api.你的域名/health/live`。

5. 把输出的两行填进 `selfhost/selfhost.env`：

   ```sh
   SELFHOST_AUTH_API_URL=https://api.example.com
   SELFHOST_SIGNAL_URL=wss://signal.example.com/v1/signal
   ```

**部署前（或每次合并官方代码后）先在本机跑一遍端到端测试**。用的是和 VPS 完全相同的 4 个容器，跑在本机 Docker 上：

```sh
brew install colima docker docker-compose && colima start --network-address   # 第一次
selfhost/server/scripts/local-e2e.sh          # 构建并启动，然后检查
selfhost/server/scripts/local-e2e.sh --down   # 停止
```

如果想用真实 App 在本机连这套服务器，可以这样启动：`LOCAL_TEST_IP=<colima 地址> LOCAL_TEST_SIGNAL_URL=wss://<colima 地址>/v1/signal`。这时 Caddy 会给这个 IP 签发证书，账号服务开在 `http://<colima 地址>:18787`。电脑端用 `NODE_EXTRA_CA_CERTS` 指向 `data-local-test/caddy/caddy/pki/authorities/local/root.crt`，模拟器用 `xcrun simctl keychain <udid> add-root-cert` 导入这个 CA。

它会检查三件事：Caddy 的 HTTPS 是否正常；登录、注册主机、签发票据是否正常；两端能否经 Signal 建立 WebRTC 连接，并分别在 P2P 直连和强制 TURN 中继下传输数据。本地测试使用 Caddy 自签证书，账号服务直接返回验证码；这两点只用于本地测试，VPS 上不会这样。

数据在 VPS 的 `/opt/openbot-selfhost/selfhost/server/data`（`auth-api/` 是 D1 SQLite 和 R2 文件，`caddy/` 是证书），重新部署时保留。

**可选：iPhone 推送**。在 developer.apple.com → Keys 创建 APNs key，把 Key ID 和 `.p8` 内容填进 `.env` 的 `APNS_KEY_ID`、`APNS_PRIVATE_KEY`，然后重新部署。

常用命令（在 VPS 上）：

```sh
cd /opt/openbot-selfhost/selfhost/server
docker compose --env-file .env ps
docker compose --env-file .env logs -f auth-api signal
```

### 可选：VPS 上的常驻 OpenBot 主机

让 VPS 本身也成为一台 OpenBot 主机：24 小时运行智能体、内置浏览器和 Computer Use（在容器内的虚拟显示器上），你从桌面端、手机端或远程桌面使用它。建议至少 2 核 / 8 GB 内存（例如 Hostinger KVM 2，Ubuntu 24.04 或更新版本）。

```sh
selfhost/server/scripts/build-linux-host.sh root@你的VPS              # 在 VPS 上构建 Linux 版和镜像（20-40 分钟）
selfhost/server/scripts/deploy-host.sh root@你的VPS 你的邮箱 "OpenBot VPS"   # 启动并登录
```

`build-linux-host.sh` 从 GitHub 上本 fork 的 `selfhost` 分支克隆代码，所以先推送你的改动。构建在 `ubuntu:24.04` 容器里进行，VPS 本身只需要 Docker；镜像使用官方的 `docker/Dockerfile` 和 `seccomp.json`（Electron 沙箱保持开启）。

`deploy-host.sh` 用 `SERVER_CLAIMS_ADMIN_TOKEN` 向你的账号服务申请一次性认领码，让主机直接以你的邮箱登录，不需要验证码。之后在桌面端和手机端用同一个邮箱登录，服务器列表里就有这台主机。数据在 Docker 卷 `openbot-host_openbot-data`。

```sh
cd /opt/openbot-host
docker compose exec openbot openbot status
docker compose logs -f openbot
```

---

## 2. 桌面端 DMG

```sh
selfhost/desktop/build-dmg.sh               # 签名 + 公证（你的 Developer ID）
selfhost/desktop/build-dmg.sh --no-notarize # 只签名
```

输出 `dist/OpenBot-<版本>-arm64.dmg`。`selfhost.env` 里的服务器地址会作为默认值写进包里（`Contents/Resources/self-host.json`）。

DMG 和 Linux 版构建时，GitHub Release 文件（Electron、electron-builder 工具、运行时、cua-driver）经 GitHub API 下载（`selfhost/scripts/github-release-proxy.sh`），因为 `github.com/…/releases/download` 有时会连续几小时返回 504。每个文件仍做校验。没有 `GITHUB_TOKEN` 时，API 限额是每小时 60 次，一次构建用不到 20 次。

**第一次打开**时，macOS 会提示"OpenBot 想要使用钥匙串中的 'OpenBot Safe Storage'"：输入 Mac 登录密码，选**始终允许**。这是因为应用的签名从官方换成了你的证书，你原来的数据和登录状态都会保留。

**在应用里改服务器**：菜单 **OpenBot → 自托管服务器…**，填写账号服务地址和 Signal 地址，点"测试连接"，再点"保存并重启"。切换到另一台服务器之前，先在应用里退出登录。

优先级：环境变量 `OPENBOT_AUTH_API_URL` / `OPENBOT_REMOTE_SIGNAL_URL` > 菜单里保存的值（`~/Library/Application Support/OpenBot/self-host.json`）> 打包内置默认。都没有时只能本机使用，不连接任何服务器。

自动更新已关闭（包里没有 `app-update.yml`）。更新方式：同步官方代码后重新打包。

---

## 3. iPhone → TestFlight

**一次性（手动，约 1 分钟）**：App Store Connect 的 API 不能创建 App，需要在网页上建一次：
[appstoreconnect.apple.com/apps](https://appstoreconnect.apple.com/apps) → **+** → **New App**

| 字段 | 值 |
| --- | --- |
| Platform | iOS |
| Name | 任意未被占用的名字，例如 `OpenBot Self-Hosted`（手机桌面上仍显示 `OpenBot`） |
| Bundle ID | `com.imaaroncao.openbot`（构建脚本已注册） |
| SKU | `com-imaaroncao-openbot` |

然后：

```sh
selfhost/ios/build-testflight.sh             # 预构建 → archive → 自动签名 → 上传 TestFlight
selfhost/ios/build-testflight.sh --no-upload # 只生成签名的 .ipa
node selfhost/ios/asc.mjs builds             # 查看 TestFlight 处理状态
```

签名是全自动的：Xcode 用 API key 注册 App Groups、推送等能力，并生成描述文件和分发证书。处理完成后，在 TestFlight 里把自己加入内部测试组即可安装。

**手机端连接服务器**：

- 扫描电脑端的连接二维码（设置 → 手机）：手机会自动使用电脑端的服务器。
- 或者邮箱登录：登录页底部显示"服务器：…· 修改"，可以改成你的账号服务地址。构建时 `SELFHOST_AUTH_API_URL` 是默认值。

---

## 同步官方更新

```sh
selfhost/scripts/sync-upstream.sh         # 合并 upstream/main（官方最新代码）
selfhost/scripts/sync-upstream.sh --tag   # 或者只合并最新的正式版本标签
```

脚本会：fetch 官方仓库 → 合并 → `bun install` → 运行 `selfhost/scripts/check-selfhost.sh`（检查本分支的每个改动点是否还在，并列出官方新增的官方域名引用）→ 运行桌面端类型检查。之后重新打包桌面端和 iOS；如果 `apps/auth-api`、`remote/` 或数据库迁移有变化，再执行一次 `deploy.sh <VPS> --rebuild-auth-api`。

合并有冲突时，保留所有标注 `Self-hosted fork` 的行。

### 本分支改动点

新增文件不会冲突。对官方文件的改动都只有一两行，带 `Self-hosted fork` 注释：

| 位置 | 作用 |
| --- | --- |
| `src/main/self-host/*`（新增） | 读取服务器配置、网络拦截、"自托管服务器"窗口 |
| `src/main/index.ts` 第一行 | 最先加载 `self-host/bootstrap` |
| `src/main/main-window.ts` | 菜单项"自托管服务器…" |
| `src/main/application-services.ts` | 关闭主进程分析/错误上报；不回退到 `api.openbot.run` |
| `src/main/provider-runtime-releases.ts` | provider 版本黑名单改从你的 fork 读取 |
| `src/renderer/src/analytics.ts`、`error-reports.ts` | 关闭界面分析/错误上报 |
| `packages/telemetry/src/self-host.ts`（新增）、`transport.ts` | 总开关 `vendorTelemetryEnabled = false`；上报通道变成空操作 |
| `packages/contracts/src/self-host-providers.ts`（新增）+ 5 处一行改动 | 移除 OpenCode：始终关闭、不下载不更新、新手引导/设置/手机端都不显示（要移除别的 provider，把 ID 加进这个列表） |
| `apps/mobile/src/self-host/*`（新增） | 手机端服务器配置、登录页服务器入口、网络拦截 |
| `apps/mobile/src/app/_layout.tsx` 第一行 | 最先加载网络拦截 |
| `apps/mobile/src/features/auth/api/mobile-auth.ts` | 邮箱登录用你的服务器 |
| `apps/mobile/src/features/analytics/*` | 关闭手机端分析/错误上报 |
| `apps/mobile/src/features/{push-notifications,share}/…` | App Group 跟随你的 Bundle ID |
| `apps/mobile/app.config.js` + `selfhost.config.js`（新增） | 你的 Bundle ID/Team，去掉关联域名、EAS 项目和 OTA |
| `selfhost/desktop/electron-builder.selfhost.yml`（新增） | 你的 appId，无更新源，无官方 provisioning profile |
| `selfhost/server/*`（新增） | VPS 服务端：Caddy + 账号服务 + Signal + TURN；常驻 Linux 主机 |
| `apps/auth-api/src/server/smtp-email-delivery.ts` | SMTP 用户名不再要求是邮箱（Cloudflare 用 `api_token`） |

---

## 已知限制

- **官方专属功能不可用**：托管服务器（hosted servers）、OpenBot GitHub App、Slack / Discord / Telegram 官方机器人、`openbot.run` 网站上的插件市场链接。这些需要只有官方才有的密钥。
- coturn 在 VPS 上的中继地址由 `deploy.sh` 自动设置（`relay-ip` = 出口网卡 IP，`external-ip` = 公网 IP/私网 IP），适用于 Oracle、AWS 这类 1:1 NAT 的云主机。
- **TURN 只开了 3478（UDP/TCP）**，没有开 5349 的 TLS。绝大多数网络够用；如果某个网络只放行 443，就连不上中继。
- **账号是独立的**：你服务器上的账号和 openbot.run 上的账号没有关系，需要重新登录。
- **Linux 无界面主机**：官方的 `install-server.sh` 和 Docker 镜像连接的是 openbot.run，不要用。用本分支的 `build-linux-host.sh` 和 `deploy-host.sh`（见 [VPS 上的常驻 OpenBot 主机](#可选vps-上的常驻-openbot-主机)）。
- 第三方服务的请求不受影响，由你自己选择使用：OpenAI、Anthropic 等模型服务商，npm、GitHub 上的 CLI 版本检查，Hugging Face 语音模型下载，内置浏览器访问的网页。
