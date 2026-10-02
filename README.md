# DeepSeek Harness Desktop · Deepin / UOS / Linux 版

<p align="center">
  <a href="https://github.com/westanke/dsh-desktop-deepin/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/westanke/dsh-desktop-deepin/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/westanke/dsh-desktop-deepin/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/westanke/dsh-desktop-deepin?include_prereleases"></a>
  <a href="https://gitee.com/westanke/dsh-desktop-deepin/releases"><img alt="Gitee" src="https://img.shields.io/badge/Gitee-%E5%90%8C%E6%AD%A5-orange"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-Linux%20%7C%20Deepin%20%7C%20UOS-blueviolet">
  <img alt="tests" src="https://img.shields.io/badge/tests-257%20passing-brightgreen">
  <img alt="typecheck" src="https://img.shields.io/badge/tsc--noEmit-0%20errors-success">
</p>

**English (short).** A community Electron desktop shell for the [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) agent runtime, built for Deepin / UOS / Linux. It ships a ~106 KB deb (amd64 + arm64) that bootstraps Electron/Node/kernel on first run from China mirrors; an offline variant with everything bundled can be built locally for air-gapped machines. Linux is not an afterthought here: timezone quirks, `apt` dependency handling, multi-user config layering, kernel process-group management and orphaned MCP-server reaping are all first-class, and 257 unit tests plus a real-kernel e2e keep it that way.

面向 Deepin / UOS / Linux 的 DeepSeek Harness 桌面壳。把命令行 agent 运行时
`dsh` 包进一个 Electron 窗口：双击即用，不必开终端。

> **状态**：可用。单测 257/257 通过、`tsc --noEmit` 零错误、内核 e2e 5/5，已在
> Deepin 25 上真机验证（窗口加载、内核就绪、托盘、菜单）。内核是上游开发预览版，
> 配置面仍在变化。

---

## 下载与安装

发布包在 [GitHub Releases](https://github.com/westanke/dsh-desktop-deepin/releases)
与 [Gitee Releases](https://gitee.com/westanke/dsh-desktop-deepin/releases)（国内网络推荐 Gitee）。

| 格式 | 覆盖系统 | 说明 |
|---|---|---|
| `*.deb`（amd64 / arm64） | Debian / Ubuntu / **UOS / Deepin** / 麒麟 | 在线版，约 106 KB；装到 `/opt`，注册启动器与图标，首启下载运行时 |
| `*-offline-*.deb`（自建） | 同上 | **不在 release 提供**。有内网/离线机需求时自己打：见下文「离线双通道」 |

### 安装包只有约 1 MB——因为运行时按需获取

**这一点必须在安装前知道：首次启动会下载 Electron（约 180 MB），需要等几分钟。**

这个 deb 里**只有壳的代码**，不含 Electron、Node 与 dsh 内核。原因很直接：

| 组件 | 单独体积 | 为什么不打包 |
|---|---|---|
| Electron 运行时 | 约 364 MB | **包体积的主要来源**，占了原本 250 MB 安装包的绝大部分 |
| Node 运行时 | 约 25 MB | 你机器上多半已经有了，内核可以直接用系统的 |
| dsh 内核 | 约 30 MB | 同上；而且内核升级频繁，打进包会很快过时 |

把这三样打进去，安装包会从 **1 MB 膨胀到 250 MB 以上**，而其中 90% 的内容对
「已经装过 dsh 的机器」是重复的。所以本包采取按需获取：

```sh
# 装完后首次启动前，先跑一次自检（会告诉你要不要下载）
bash /opt/deepseek-harness-desktop/tools/bootstrap.sh check

# 缺什么就下什么，国内镜像优先
bash /opt/deepseek-harness-desktop/tools/bootstrap.sh install
```

安装器（deb 的 postinst）也会在装完后自动跑一次检测，并在缺失时明确提示你执行上面的命令。

**下载耗时预期**（取决于网络）：

| 缺什么 | 下载量 | 大致耗时 |
|---|---|---|
| 只缺 Node | 约 25 MB | 十几秒 |
| 只缺 dsh 内核 | 约 30 MB | 几十秒 |
| **只缺 Electron** | **约 180 MB** | **几分钟** ← 最常见的情况 |
| 三者都缺 | 约 235 MB | 几分钟 |

下载**只发生一次**。全部就绪后会把解析出的绝对路径写回
`config.json`（备份为 `config.json.bak-bootstrap`），之后每次启动都是零检测、秒开。

下载内容与来源（写入 `~/.dsh-desktop/runtime/`，不碰系统目录、不需要 root）：

| 组件 | 国内源 |
|---|---|
| Node | `npmmirror.com/mirrors/node`，备用 `mirrors.huaweicloud.com/nodejs` |
| Electron | `npmmirror.com/mirrors/electron`，备用 `mirrors.huaweicloud.com/electron` |
| dsh 内核 | `registry.npmmirror.com`（npm 全局安装） |

> 为什么优先国内源：上游 `nodejs.org`、GitHub Releases 与 `registry.npmjs.org` 在大陆
> 网络下经常超时或极慢，而上述镜像是同步的完整副本。脚本会在主源失败时自动切备用源。

**想避开首次下载？** 如果你的机器上已经有 Electron ≥ 33、Node ≥ 22.15 和任意可用的
`dsh`，`bootstrap.sh check` 会全部识别为已就绪，**不会有任何下载**。检测顺序是
`config.json` 指定路径 → `PATH` → 常见安装位置，命中即复用。

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

### 装完就会在后台预下载，不用干等

`apt install` 结束后，安装脚本会以**你自己的账号**（不是 root）在后台自动开始
下载运行时 —— 所以绝大多数情况下，等你双击启动器时它已经就绪，跟「装完即用」
没区别，而包还是只有 106 KB。

- 下载在后台跑，`apt install` 立即返回，不会卡住安装进度
- 日志：`~/.dsh-desktop/bootstrap-postinst.log`
- 不想装时就下载（比如批量部署、离线机）：
  `sudo DSH_NO_POSTINST_DOWNLOAD=1 apt install ./xxx.deb`
- 若你双击时它还没下完，启动器会显示等待进度并排队，不会重复下载

Deepin/UOS 上首次双击启动器可能询问「是否信任该应用」，确认即可。信任按用户记录，
所以「点了没反应」通常是这个询问，不是启动失败。

卸载：

```sh
sudo apt remove deepseek-harness-desktop
```

卸载**不会**动你的内核数据（`~/.dsh` 或 `$DSH_HOME`：会话、设置、凭据、插件），
也不会删 `~/.dsh-desktop/runtime/`（已下载的运行时留着，重装后可直接复用）。
如要彻底清理，手动删该目录即可。

---

## 推荐插件（默认随运行时自动安装）

以下四个社区插件由 `tools/install-plugins.sh` 在**运行时就绪后自动安装**
（升级 deb 时 postinst 也会补装缺失的；已装的跳过、不覆盖你的版本）。
不想要某个？`dsh plugin --profile web remove <包名>` 即可——注意升级后会
被自动补回（查重只认「在不在」）。

| 插件 | 干什么 | 链接 |
|---|---|---|
| **dsh-im** | 把微信、飞书、企业微信、钉钉、QQ、Telegram、WhatsApp、Slack、Discord、Matrix 等 IM 接入 DSH——在聊天软件里直接使唤你的 agent | [xmanrui/dsh-im](https://github.com/xmanrui/dsh-im) |
| **dsh-pocket-relay** | 把 DSH 装进口袋：局域网扫码直连，或经自建 relay 中继随时随地远程访问（设备级认证、多机共存与热备、实时同屏） | [kinderao/dsh-pocket-relay](https://github.com/kinderao/dsh-pocket-relay) |
| **dsh-mcp-panel** | MCP 管理控制台：`/mcp` 命令查看 MCP 服务器健康状态、诊断连接问题 | [PerryLink/dsh-mcp-panel](https://github.com/PerryLink/dsh-mcp-panel) |
| **dshmarket** | 内置可视化插件市场：浏览、搜索、一键安装社区插件 | [dsh-market/dsh-market](https://github.com/dsh-market/dsh-market) |

手动补装 / 强制重装：

```sh
bash /opt/deepseek-harness-desktop/tools/install-plugins.sh          # 补缺的
bash /opt/deepseek-harness-desktop/tools/install-plugins.sh force    # 全部重装
```

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
| 桌面通知 | `src/tray.js` `src/dom-observer.js` | agent 完成当前任务时发系统通知 |
| 运行时自检 | `tools/bootstrap.sh` `src/runtime-doctor.js` | 检测 Electron/Node/dsh 是否就绪，缺了可从国内源自动下载 |

### 启动过程可见

窗口**先出现**，内核在后面启动，全程显示进度——不必对着空白干等：

```
正在准备启动…            ← 窗口一出现就能看到
正在启动内核…
正在等待内核就绪…

已等待 13 秒              ← 逐秒跳动，跨页面切换连续计数

dsh-pocket: auto-restore check        ← 内核实时输出
[info]: [ 'client ready' ]
[MCP-Server-Chart] ... tool handlers set up
12306 MCP Server running on stdio
dsh: skipping profile bundle "xxx"    ← 哪个插件没加载，看得见
```

实现：`src/loading-page.js` 暴露 `window.__dshStage()` 与 `window.__dshLog()`，主进程
**原地改文本**而不是换页（换页会重建文档、计时归零、中间态一闪而过）。
内核输出经脱敏后按 120ms 批推送。

### 端口与内核模式

- **端口由系统分配**，不固定。官方壳固定 19387，本壳曾经也这样——但那会导致：端口被
  别的 dsh 实例占用时，壳换了端口却仍去探测 19387，探到的是**别人的内核**（token 对不上，
  永远 401，最后报「内核未响应」而真正的内核活得好好的）。改成系统分配后从根上消除了撞车。
- **系统内核模式**：`launcher.systemDsh` 指向本机 `dsh`，壳用它作为内核，不下载 bundled 版本。
- **`~` 展开**：`kernel.homeSubdir` 支持 `~/.dsh` 写法（Node 不认 `~` 是绝对路径，必须显式展开）。

### 安全模式

插件崩到内核起不来时，壳自己也进不去、无法卸载插件——死锁。安全模式是这个死锁的出口：

- 停用**全部第三方 bundle**（`@deepseek-ai/dsh-base`、`dsh-web-app` 受保护，否则没界面）
- 用户 patch 层**备份改名**而非改写：`cordis.patch.yml` → `cordis.patch.yml.bak-<UTC>`
- **不持久化**：恢复动作不是偏好，下次正常启动插件自动回来

托盘菜单与应用菜单两个入口都能触发。实现见 `src/safe-mode.js`。

### 安全策略

| 项 | 实现 | 说明 |
|---|---|---|
| 导航白名单 | `src/window-policy.js` | 仅精确 origin 可导航；外链限 http/https 交系统浏览器 |
| 渲染进程权限白名单 | `src/permissions.js` | 仅放行内核需要的麦克风（纯音频）、通知、剪贴板；摄像头等一律拒绝 |
| 沙箱与隔离 | `src/window-policy.js` | `contextIsolation` + 无 Node 集成 |
| 日志脱敏 | `src/log-redact.js` | 进缓冲区即脱敏，超限丢弃并计数 |
| 配置原子写 | `src/config-file.js` | 临时文件 + rename，加文件锁（陈旧锁可破） |
| 渲染崩溃自愈 | `src/main.js` | 60 秒内最多 3 次 reload，超出显示错误页 |

---

## 配置

所有可调项集中在 `config.json`，改它不用动代码。每个键旁边都有 `_comment_*`
中文说明，这里列出常用项：

**配置文件有两份，改「生效的那份」**（`start-shell.sh` 启动横幅里也会打印当前
用的是哪份）：

| 位置 | 权限 | 何时用 |
|---|---|---|
| `/opt/deepseek-harness-desktop/config.json` | root 只读 | **全局默认**，deb 安装自带，所有人共用 |
| `~/.config/dsh-desktop/config.json` | 用户可写 | **每用户覆盖份**，优先生效 |

规则：读取顺序是**用户覆盖份 → 全局份**，键级合并（用户份有该键就用用户份的）。
多用户机器上**不要改全局份**（普通用户也改不动），把要改的键写进自己的覆盖份即可；
首次启动壳会自动创建覆盖份并把检测到的运行时路径写进去。改完重启壳生效。

### `launcher` —— 怎么把壳拉起来

| 键 | 取值 | 说明 |
|---|---|---|
| `electron` | 路径 | Electron 可执行文件。系统内核模式下它就是壳的运行环境，必填 |
| `systemDsh` | 路径 | 系统 `dsh`。Shell 把它作为 `DSH_KERNEL_BIN` 传给内核，即「系统内核模式」 |
| `nodeBinDir` | 目录 | 系统 node 所在目录，会被加进 `PATH` 供内核使用 |
| `userDataDir` | 路径 | 壳的 Electron userData 目录，日志也落这里。相对路径以壳根目录为基准 |
| `telemetryMode` | `DISABLED` 等 | 传给环境变量 `DSH_TELEMETRY_MODE` |

> `electron` / `systemDsh` / `nodeBinDir` 三项**可以由 `bootstrap.sh install` 自动写入**，
> 不用手工填。装完 deb 跑一次自检即可。

### `kernel` —— 内核怎么起、数据放哪

| 键 | 取值 | 说明 |
|---|---|---|
| `homeSubdir` | 路径 | `DSH_HOME` 的位置。**支持 `~` 展开**（`~/.dsh` → `/home/你/.dsh`）；相对路径则拼在 `userDataDir` 下 |
| `profile` | `web` 等 | 启动 profile |
| `noOpen` | `true`/`false` | `true` 表示不让 dsh 自己开浏览器，由壳加载页面 |
| `directoryPicker` | `auto`/`browse`/`native` | `auto` 时：Linux 上有 zenity 或 kdialog 就用原生对话框，两者都没有则自动降级为浏览模式 |
| `exitPolicy` | `ask-always`/`ask-if-busy`/`never` | 退出确认策略。默认 `ask-always` 最保守（本壳无法像官方那样精确查询 Host 任务，故取保守档） |

> `homeSubdir` 的 `~` 展开是必须的：Node 的 `path.isAbsolute('~/.dsh')` 返回 **false**，
> 不展开就会被当成相对路径拼到 `data-shell/` 下，生成一个名字字面叫 `~` 的空目录，
> 内核会在错误的 home 里启动、看不到你的任何插件。

### `supervisor` —— 内核守护

| 键 | 默认 | 说明 |
|---|---|---|
| `maxRestartsInWindow` | `5` | 滚动窗口内最多重试次数，超出则放弃并报错 |
| `restartWindowMs` | `600000` | 重试计数的滚动窗口（10 分钟） |
| `baseDelayMs` | `2000` | 首次重试延迟，之后每次翻倍 |
| `maxDelayMs` | `30000` | 重试延迟上限 |
| `readinessTimeoutMs` | `240000` | 单次启动等待内核打出 `dsh web:` 行的超时。**实测本机内核启动耗时在 45~120 秒间波动**（插件与 MCP 服务器串行初始化），原 90 秒不够，故放宽到 240 秒 |

### `renderer` / `tray` / 其他

| 键 | 说明 |
|---|---|
| `renderer.maxRecoveries` / `recoveryWindowMs` | 渲染进程崩溃后自动 reload 的次数与窗口（默认 3 次 / 60 秒） |
| `splashMinMs` | 启动页最短展示时长（默认 3000ms）。内核就绪后至少再停这么久，让你看清启动日志；`0` 表示就绪即切走 |
| `tray.summonAccelerator` | 全局快捷键，一键召唤/隐藏窗口（默认 `CommandOrControl+Shift+Space`） |
| `tray.showBalance` / `rechargeUrl` | 是否显示充值入口及其地址 |
| `updates.*` | 自动更新源（仅打包版生效） |

---

## 环境要求

**只支持 Linux**（Deepin / UOS / Debian 系）。**Windows 与 macOS 不做安装包**——
本仓库不发布这两个平台的任何产物，也别提 issue 要。

**跑打包版**：本身无强制要求——缺失的运行时会被自动检测并下载（见上方「下载与安装」）。
但为了避免首次启动的大下载，机器上最好已有：

| 组件 | 最低版本 | 说明 |
|---|---|---|
| Electron | ≥ 33 | 壳的运行环境。没有会下载约 180 MB |
| Node | ≥ 22.15 | 内核用了 `zlib.createZstdDecompress`，更早的版本起不来 |
| dsh 内核 | 任意可运行版本 | 不锁版本，用你已装的 |

**开发**：Node.js ≥ 22.15.0。

**系统内核模式**（当前默认）：需要本机已装 `dsh`，`launcher.systemDsh` 指向它。
此模式下不下载 bundled 内核，内核版本就是你装的那个。

### 自检命令

```sh
# 只检测，报告缺什么（exit=1 表示有缺失，可用于脚本判断）
npm run doctor
bash tools/bootstrap.sh check

# 缺什么下什么，国内源优先，并把解析出的路径写回 config.json
npm run doctor:install
bash tools/bootstrap.sh install
```

`bootstrap.sh` 是**纯 shell** 写的，只依赖 bash + curl/wget + tar/unzip——这几样在
Debian/UOS 基础系统里必定存在。这是刻意的：它的职责是「检查 Node 在不在并把它装上」，
如果它自己需要 Node 才能运行，Node 缺失时它根本启动不了，就成了自举死循环。

---

## 开发

```sh
npm install              # 壳依赖与类型
npm test                 # 单元测试 257 个，不联网、不需要 Electron
npm run typecheck        # tsc --noEmit
npm run doctor           # 运行时自检：Electron / Node / dsh 就绪情况
npm start                # 启动
```

### 打包

打包由 GitHub Actions 自动完成：打 `v*` tag 即产出 amd64 / arm64 两个 deb
并挂到 GitHub Release，同时同步到 Gitee Release。本仓库有两个 workflow：

| workflow | 触发 | 作用 |
|---|---|---|
| `.github/workflows/ci.yml` | push main / PR | 三平台跑测试 + scan-leaks |
| `.github/workflows/package-linux.yml` | 打 `v*` tag / 手动 | **deb（amd64 + arm64）打包挂 release，并同步 Gitee** |

手动触发打包（或在 Actions 页面点 Run workflow）：

```sh
gh workflow run package-linux.yml --repo westanke/dsh-desktop-deepin
```

本地打包（用 dpkg-deb 手工打，不走 electron-builder）：

```sh
bash tools/build-deb.sh amd64   # 或 arm64；第二个参数可指定版本号
```

产物在 `release/`。**本地打包不会下载内核、Node 或 Electron**——这三样由最终用户
运行时按需获取（见「下载与安装」），deb 里只有约 1 MB 的壳代码。

**离线双通道（自建，不在 release 提供）**：给无法稳定访问网络的机器打全自带包——

```sh
# 1. 先把两个官方运行时压缩包放到 release/（npmmirror 或官方源均可）
curl -L -o release/node-v24.19.0-linux-x64.tar.gz \
  https://npmmirror.com/mirrors/node/v24.19.0/node-v24.19.0-linux-x64.tar.gz
curl -L -o release/electron-v33.3.0-linux-x64.zip \
  https://npmmirror.com/mirrors/electron/v33.3.0/electron-v33.3.0-linux-x64.zip

# 2. 加 --offline 打包，产物名带 -offline 后缀（约 150MB）
bash tools/build-deb.sh amd64 <版本> --offline
```

offline 包内嵌官方压缩包与对应的 `SHASUMS256.txt`：`bootstrap.sh` 检测到缺运行时
时**优先解包内置的**（校验通过后免下载直接就位），内置缺失或校验失败才回退在线
下载——一份代码，在线/离线两种产物。

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
| `src/runtime-doctor.js` | Electron/Node/dsh 在不在、版本够不够 |
| `src/runtime-install.js` | 缺的东西从哪下、怎么校验 |

其余模块（`main.js`、`tray.js`、`kernel-*.js`、`preload.js`、`dom-observer.js`、
`loading-page.js`、`update.js`、`log-redact.js`、`node-runtime.js`、`shell-patch.js`）
负责 Electron 与进程 IO。

**纯 shell 例外**：`tools/bootstrap.sh` 刻意不用 Node 写。它负责「检查 Node 在不在并把它装上」，
如果它自己依赖 Node，Node 缺失时就启动不了——自举死循环。所以只用
bash + curl/wget + tar/unzip，这三样在 Debian/UOS 基础系统里必定存在。

---

## 这个项目借了谁的力

本仓库是**站在几个项目肩膀上**的社区整合，不是原创。按实际借鉴关系列清楚：

| 项目 | 借鉴了什么 | 链接 |
|---|---|---|
| **deepseek-ai/deepseek-harness** | 内核 `dsh` 本体、Web UI、插件机制。所有 agent 能力（模型、工具、会话、权限）都来自它 | <https://github.com/deepseek-ai/deepseek-harness> |
| **sleep2agi/DeepSeek-Harness-Desktop** | 本仓库的**代码基线**。窗口安全策略、就绪探测、进程树回收、日志脱敏、打包流程都源自这份社区壳 | <https://github.com/sleep2agi/DeepSeek-Harness-Desktop> |
| **citrusli2026/dsh-desktop** | 官方桌面端的行为参照：菜单/托盘/安全模式/退出确认的**设计意图**来自它的实现，以及 UOS/Deepin 适配经验（Issue #73） | <https://github.com/citrusli2026/dsh-desktop> |
| **anywhere-labs/dsh-desktop** | Linux deb 打包工艺参照：其 PR #1120 实测出「`dpkg -i` 缺依赖失败，须用 `apt install ./x.deb`」，本 README 直接采用该结论 | <https://github.com/anywhere-labs/dsh-desktop> |

`deepseek-ai/deepseek-harness` 官方 `apps/desktop` 的实现细节也作为行为基准被对照，
但它**不发布 Linux 产物**，且其私有发布单元（见下）无法获取。

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
