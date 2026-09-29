# DeepSeek Harness Desktop · Deepin / UOS / Linux 版

[English](README.en.md) | 中文

面向 Deepin / UOS / Linux x86_64 的 DeepSeek Harness 桌面壳。把命令行 agent
运行时 `dsh` 包进一个 Electron 窗口：双击即用，不必开终端。

![Running on Deepin 25](docs/images/05-deepin-running.png)

> **状态**：可用。单测 184/184 通过，已在 Deepin 25 上真机验证（窗口加载、内核就绪、
> 托盘、菜单、桌面工具浮层）。内核是上游开发预览版，配置面仍在变化。

---

## 这个项目借了谁的力

本仓库是**站在三个项目肩膀上**的社区整合，不是原创。按实际借鉴关系列清楚：

| 项目 | 借鉴了什么 | 链接 |
|---|---|---|
| **deepseek-ai/deepseek-harness** | 内核 `dsh` 本体、Web UI、插件机制。所有 agent 能力（模型、工具、会话、权限）都来自它 | <https://github.com/deepseek-ai/deepseek-harness> |
| **sleep2agi/DeepSeek-Harness-Desktop** | 本仓库的**代码基线**。窗口安全策略、就绪探测、进程树回收、日志脱敏、打包流程都源自这份社区壳 | <https://github.com/sleep2agi/DeepSeek-Harness-Desktop> |
| **citrusli2026/dsh-desktop** | 官方桌面端的行为参照：菜单/托盘/安全模式/退出确认的**设计意图**来自它的实现，以及 UOS/Deepin 适配经验（Issue #73） | <https://github.com/citrusli2026/dsh-desktop> |
| **anywhere-labs/dsh-desktop** | Linux deb 打包工艺参照：其 PR #1120 实测出「`dpkg -i` 缺依赖失败，须用 `apt install ./x.deb`」，本 README 直接采用该结论 | <https://github.com/anywhere-labs/dsh-desktop> |

`deepseek-ai/deepseek-harness` 官方 `apps/desktop` 的实现细节也作为行为基准被对照，
但它**不发布 Linux 产物**，且其私有发布单元（见下）无法获取。

---

## 下载与安装

发布包在 [GitHub Releases](https://github.com/westanke/dsh-desktop-deepin/releases)。

| 格式 | 覆盖系统 | 说明 |
|---|---|---|
| `*.deb` | Debian / Ubuntu / **UOS / Deepin** / 麒麟 | 装到 `/opt`，注册启动器与图标 |
| `*.AppImage` | 任意 Linux x86_64 | 免安装，赋可执行权限直接跑 |

### 请用 apt 安装 deb，不要用 dpkg -i

`dpkg -i` 不解析依赖，缺库时直接失败。本包声明的运行时依赖：

```
libgtk-3-0  libnotify4  libnss3  libxss1  libxtst6
xdg-utils  libatspi2.0-0  libayatana-appindicator3-1
```

```sh
sudo apt install ./DeepSeek-Harness-Desktop-<版本>-amd64.deb
```

> 该结论来自 anywhere-labs PR #1120 的 Ubuntu 24.04 真机验证，非推测。

Deepin/UOS 上首次双击启动器可能询问「是否信任该应用」，确认即可。信任按用户记录，
所以「点了没反应」通常是这个询问，不是启动失败。

卸载：

```sh
sudo apt remove deepseek-harness-desktop
```

卸载**不会**动你的内核数据（`~/.dsh` 或 `$DSH_HOME`：会话、设置、凭据、插件），
只移除应用本体与 Electron 用户数据。

---

## 功能（按实际实现）

### 内核与进程

| 功能 | 实现位置 | 说明 |
|---|---|---|
| 内核启动与就绪判定 | `src/kernel-process.js` `src/readiness.js` | 必须拿到真实 HTTP 响应才算就绪；端口开着不算 |
| 崩溃自动重启 | `src/kernel-supervisor.js` `src/restart-policy.js` | 指数退避，10 分钟窗口内最多 5 次，超出则放弃并报错 |
| 进程组整体回收 | `src/kernel-process.js` | Unix 下子进程自任组长，退出时 `kill(-pid)` 连孙进程一起收 |
| 系统内核模式 | `src/main.js` `resolveKernelPaths` | 设 `DSH_KERNEL_BIN` 即可驱动系统已装的 `dsh`，用真 Node 跑 |
| 固定端口 | `src/main.js` `preferredPort` | 默认 `19387`（官方同款）；被占用则自动退回随机端口 |
| 崩溃报告 | `src/diagnostics.js` | 写 `userData/logs/crash-<UTC>-<来源>.log`，保留最新 10 份，输出限 64 KiB |

### 桌面集成

| 功能 | 实现位置 | 说明 |
|---|---|---|
| 应用菜单 | `src/app-menu.js` | 应用/文件/编辑/视图/窗口 五组；首项「关于」开原生面板 |
| DevTools 快捷键 | `src/app-menu.js` | F12 与 Ctrl+Shift+I，注册为隐藏菜单项，打包版同样有效 |
| 系统托盘 | `src/tray.js` | 显示/隐藏/重启内核/检查更新/安全模式/开机自启/退出，带实时状态行 |
| 关闭即隐藏 | `src/tray.js` `src/main.js` | 关窗只隐藏，内核与任务继续跑；退出走托盘或菜单 |
| 退出确认 | `src/exit-guard.js` | 退出前弹确认框，策略见 `kernel.exitPolicy` |
| 窗口几何记忆 | `src/window-state.js` | 记住尺寸位置；显示器拔掉后不会把窗口丢到屏幕外 |
| 托盘图标 | `assets/trayTemplate.png` | Linux 任务栏图标 |

### 网页内桌面工具

浮动面板 **桌面工具**，由插件
[`plugins/dsh-deepin-controls`](plugins/dsh-deepin-controls) 提供，通过内核的
`dsh.bundle.patch` 机制挂载（与官方桌面端挂自己控件的方式相同，不依赖其私有包）。

六项动作全部镜像托盘已有能力，页面未获得额外权限：

| 动作 | 需确认 |
|---|---|
| 重启内核 / 检查更新 / 开机自启 / 关于 / 隐藏窗口 | 否 |
| 退出 | **是** |

安全性：页面只能传**动作名**，主进程在 `src/desktop-commands.js` 的白名单里查，
其余一律拒绝；回推给页面的状态经脱敏，只含 `phase`/`busy`/`launchAtLogin`/`safeMode`。

### 安全模式

插件崩到内核起不来时，壳自己也进不去、无法卸载插件——死锁。安全模式是这个死锁的出口：

- 停用**全部第三方 bundle**（`@deepseek-ai/dsh-base`、`dsh-web-app` 受保护，否则没界面）
- 用户 patch 层**备份改名**而非改写：`cordis.patch.yml` → `cordis.patch.yml.bak-<UTC>`
- **不持久化**：恢复动作不是偏好，下次正常启动插件自动回来

三个入口都能触发：托盘菜单、应用菜单、网页浮层。实现见 `src/safe-mode.js`。

### 安全策略

| 项 | 实现 | 说明 |
|---|---|---|
| 导航白名单 | `src/window-policy.js` | 仅精确 origin 可导航；外链限 http/https 交系统浏览器 |
| 渲染进程权限全拒 | `src/permissions.js` | 摄像头/麦克风/通知/剪贴板一律拒绝 |
| 沙箱与隔离 | `src/window-policy.js` | `contextIsolation` + 无 Node 集成 |
| 日志脱敏 | `src/log-redact.js` | 进缓冲区即脱敏，超限丢弃并计数 |
| 配置原子写 | `src/config-file.js` | 临时文件 + rename，加文件锁（陈旧锁可破） |
| 渲染崩溃自愈 | `src/main.js` | 60 秒内最多 3 次 reload，超出显示错误页 |

---

## 配置

所有可调项集中在 [`config.json`](config.json)，改它不用动代码。常用项：

| 键 | 取值 | 说明 |
|---|---|---|
| `launcher.systemDsh` | 路径 | 系统 `dsh` 可执行文件 |
| `launcher.userDataDir` | 路径 | 壳的 userData，日志落这里 |
| `kernel.homeSubdir` | 路径 | `DSH_HOME`，相对则拼在 userData 下 |
| `kernel.profile` | `web` 等 | 启动 profile |
| `kernel.directoryPicker` | `auto`/`browse`/`native` | `auto` 时：Linux 有 zenity 或 kdialog 用原生对话框，都没有则降级浏览模式 |
| `kernel.exitPolicy` | `ask-always`/`ask-if-busy`/`never` | 退出确认策略，默认最保守 |
| `supervisor.*` | 数值 | 重启窗口、次数、退避、就绪超时 |
| `tray.rechargeUrl` | URL | 托盘充值入口（默认不显示） |

---

## 环境要求

**跑打包版**：无额外要求，内核与 Node 运行时都在包里。

**开发**：Node.js ≥ 22.15.0（内核用了 `zlib.createZstdDecompress`）。

**系统内核模式**：需要本机已装 `dsh`，设 `DSH_KERNEL_BIN` 指向它。此模式下不下载
bundled 内核，内核版本就是你装的那个。

---

## 开发

```sh
npm install              # 壳依赖（Electron、builder、类型）
npm test                 # 单元测试，184 个，不联网、不需要 Electron
npm run typecheck        # tsc --noEmit
npm run kernel:install   # 按 upstream.lock.json 下载并校验内核
npm start                # 启动
```

### 打包

打包**不是自动的**——GitHub Actions 只是执行器，得由 workflow 驱动。本仓库有三个：

| workflow | 触发 | 作用 |
|---|---|---|
| `.github/workflows/ci.yml` | push main / PR | 三平台跑测试 + scan-leaks |
| `.github/workflows/release.yml` | 打 `v*` tag | 三平台打包发布 |
| `.github/workflows/package-linux.yml` | 打 `v*` tag / 手动 | **deb + AppImage 打包并挂到 release** |

手动触发打包（或在 Actions 页面点 Run workflow）：

```sh
gh workflow run package-linux.yml --repo westanke/dsh-desktop-deepin
```

本地打包：

```sh
npm ci && npm test && npm run kernel:install
npx electron-builder --linux deb --linux AppImage --publish never
```

产物在 `release/`。

### 模块布局

不依赖 Electron 的纯决策模块（可直接单测）：

| 模块 | 决定什么 |
|---|---|
| `src/window-policy.js` | 窗口能导航到哪、什么能交给系统 |
| `src/readiness.js` | 内核何时算真就绪 |
| `src/restart-policy.js` | 死掉的内核是否再给一次机会 |
| `src/directory-picker.js` | 本平台能否信任原生目录对话框 |
| `src/app-menu.js` | 应用菜单结构 |
| `src/shortcuts.js` | 接受哪些键位、按键如何投递 |
| `src/window-state.js` | 记住的窗口几何能否复用 |
| `src/exit-guard.js` | 退出前是否要问 |
| `src/safe-mode.js` | 安全模式该停用哪些 bundle |
| `src/diagnostics.js` | 崩溃报告写哪、留几份 |
| `src/config-file.js` | 配置如何写才不撕裂 |
| `src/desktop-commands.js` | 网页能请求哪些桌面动作 |

其余模块（`main.js`、`tray.js`、`kernel-*.js`、`preload.js`、`dom-observer.js`、
`loading-page.js`、`update.js`、`log-redact.js`、`node-runtime.js`、`shell-patch.js`）
负责 Electron 与进程 IO。

---

## 与官方桌面端的差异（诚实说明）

官方 `deepseek-ai/deepseek-harness` 的 `apps/desktop` 明确写着「Linux 不是受支持的
Desktop 发布目标」。其部分能力**无法获取**，因为它们不是公开包，而是与签名产物绑定的
私有发布单元：

- 私有 Desktop Host 包（带 `desktop` 的包名在 npm 上 404）
- `dsh-app://app` 打包 Web 入口、`desktop-runtime.json` 签名校验
- 内置 Python / Node / pnpm 三件套分发
- 官方 COS 更新源、Windows EV 签名与 macOS 公证
- 平台账号登录（PKCE）

**能复刻的已做**：官方 README 点名 Linux 的三处（目录选择器降级、快捷键 DOM 分发、
保留应用菜单与 Edit 菜单）加通用项（关于面板、DevTools 快捷键、默认端口 19387、
权限全拒、窗口几何、崩溃日志、退出确认）。

**只能近似的**：退出前「是否有任务在跑」的查询。官方通过私有 IPC 问 Host，本壳没有
这条通道，因此改为可配置策略（默认每次都问）。

**一处刻意的架构差异**：官方用 `ELECTRON_RUN_AS_NODE=1` + `--expose-internals` 把
Electron 当 Node 跑内核（目标是不依赖系统 Node）；本壳用真 Node。后者已真机验证，
更稳，故保留。

---

## 独立性

代码全部依据公开来源编写，依赖均为公开包。不含私有产品代码、组织专属品牌、
认证客户端、私有端点、更新源、凭据或遥测。`npm run scan:leaks` 在 CI 中对此做强制检查。

本项目与 DeepSeek 无隶属或背书关系。

## 许可证

本仓库代码 MIT，见 [LICENSE](LICENSE)。随包分发上游 `@deepseek-ai/dsh` 内核（同为 MIT）。
第三方组件保留各自许可证，归属声明见 [NOTICE](NOTICE)。
