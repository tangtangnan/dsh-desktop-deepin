# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

（暂无）

## [0.2.11] — 2026-10-02

### 新增

- **缺插件时弹出终端窗口可见补装**。此前「插件没装/装失败」用户完全看不见：
  运行时就绪时 `bootstrap.sh` 一见「全部就绪」就提前返回，首启根本不检查插件
  （升级用户的常态）；`postinst` 的输出又全部重定向进日志。现在 `start-shell.sh`
  启动前会检查推荐插件，缺了就在可见的终端窗口里补齐——沿用首启下载运行时那套
  「借终端重跑自己」的机制与防死循环标记，下载进度与报错都看得见；连终端模拟器
  都没有的极简系统则退回后台静默补齐，日志落 `~/.dsh-desktop/plugin-install.log`。
- **`install-plugins.sh check` 模式**：纯查询、零副作用（不会因为缺 pnpm 就触发
  下载），stdout 只输出缺失包名，供启动流程判断是否需要补装。
- **版本印记快路径**：补齐成功后写 `~/.dsh-desktop/.plugins-ok`（内容为壳版本），
  同一版本下启动时直接跳过插件查询，避免每次启动都拉起一次 pnpm。

### 修复

- **`corepack` 下载 pnpm 不再走国外源**：corepack 只认 `COREPACK_NPM_REGISTRY`
  （不认 `npm_config_registry`），且 `corepack enable` 只建 shim、真正的下载发生在
  首次调用 pnpm 时——真机上表现为「enable 之后长时间无输出」。现在显式把
  `COREPACK_NPM_REGISTRY` 指向国内镜像（覆盖后续所有 pnpm 调用），并在预热时
  提示「首次需下载 pnpm，通常 10~30 秒」。
- **插件安装进度可见**：每个插件显示 `[i/4]` 与本次耗时，结尾汇总总耗时。

## [0.2.10] — 2026-10-02

### 修复

- **推荐插件自动安装的最后一层障碍：目标机没有 pnpm**。`dsh plugin` 子命令底层
  调用 pnpm，PATH 上没有 pnpm 时 dsh 直接失败：
  `dsh: pnpm was not found; install pnpm and make it available on PATH.`
  用 nvm 装的 Node 默认不带 pnpm，因此 arm64 真机上四个插件全部安装失败
  （v0.2.7 的转义问题、v0.2.8 的语序问题修好后，这一层才暴露出来）。
  `tools/install-plugins.sh` 新增 `ensure_pnpm`，按「复用优先、零下载优先」的
  顺序保证 pnpm 可用：
  1. PATH 里已有 pnpm → 直接使用；
  2. 与 dsh（即 node）同目录，以及 `/usr/local/bin`、`~/.local/bin` 等常见位置
     → 命中即复用并把其目录加入 PATH（dsh 靠 PATH 找 pnpm）；
  3. Node 自带的 `corepack` → 就地 `corepack enable pnpm`（含 `$ndir/corepack`
     回退，应对 postinst 经 `runuser` 调用时 PATH 精简的情况）；
  4. 兜底：`npm install -g --prefix ~/.local pnpm`——用户级安装，不需要 root，
     不碰系统目录。
  四条路径都已实测（修改性分支用 `DSH_PLUGIN_DRYRUN=1` 干跑验证，不产生副作用）；
  全部失败时给出明确的手动安装指引，且不阻塞壳本身启动。

## [0.2.9] — 2026-10-02

### 修复

- **升级后推荐插件仍装不上（v0.2.8 遗留）**。v0.2.8 让失败报错可见后，真机输出
  定位出 `dsh plugin add` 的用法错误：
  1. 正确语序是 `dsh plugin --profile web add <pkg>`（`--profile` 跟在 `plugin`
     之后）；写成 `dsh --profile web plugin add` 会把 `plugin`/`add`/包名当成
     主服务参数，报 `too many arguments. Expected 0 arguments but got 3`；
  2. `dsh plugin add` 不认 `--registry` flag（报 `unknown option`），registry
     只能通过 `npm_config_registry` 环境变量传给底层 pnpm。
- 本机端到端实测：`npm_config_registry=… dsh plugin --profile <p> add
  dsh-pocket-relay` 成功（`+ dsh-pocket-relay ^1.0.2`，exit 0）。

## [0.2.8] — 2026-10-02

### 修复

- **postinst 插件补装段被 `\$` 转义写死**：该段写在 quoted heredoc（`<<'EOF'`）
  里却按 unquoted 习惯把 `$` 转义成 `\$`，quoted heredoc 原样保留 `\$`，导致
  `[ -x "\$PLUGINS_SCRIPT" ]` 恒假、整段静默跳过——v0.2.7「升级后插件没装」
  的直接原因。
- **安装失败不再吞报错**：失败时打印 dsh/pnpm 的真实输出（末 15 行），
  临时文件写 `~/.dsh-desktop/`（不用 /tmp）。正是这条让 v0.2.9 的根因得以定位。

## [0.2.7] — 2026-10-02

### 新增

- **默认插件自举安装**：新增 `tools/install-plugins.sh`，在运行时就绪后自动安装
  四个推荐插件（`@xmanrui/dsh-im`、`dsh-pocket-relay`、`dsh-mcp-panel`、
  `dshmarket`）。脚本幂等（已装的跳过）、单插件失败不阻塞；接入 bootstrap
  安装成功路径，postinst 在升级场景也独立补装一次（升级时运行时已就绪、
  bootstrap 会提前退出，故单独调用）。新装用户开箱即得四插件。

### 修复

- **升级不再覆盖全局配置**：deb 生成 `DEBIAN/conffiles` 声明
  `/opt/deepseek-harness-desktop/config.json`。
  此前升级包会无脑覆盖全局 config.json；声明后用户改过的配置保留，新版默认
  配置落为 `.dpkg-dist` 供参考（Debian 标准语义）。
- **postinst 安装目录笔误**：`INSTALL_DIR` 误写为 `/opt/dsh-desktop-deepin`
  （少 harness），导致 postinst 找不到 bootstrap.sh——「装完后台预下载运行时」
  自上线以来从未真正生效，提示的安装路径也是错的。修正为
  `/opt/deepseek-harness-desktop`，与 PKG_NAME 一致。
- **仓库卫生**：`debian/` 打包暂存副本曾被误提交进仓库（与真实源码形成两份
  漂移副本），已全部移出追踪；`.gitignore` 精确豁免源码级
  `debian/DEBIAN/postinst`（此前整目录忽略把它挡在库外，CI 打包一直走
  heredoc 兜底）。

## [0.2.6] — 2026-10-02

### 修复

- **老 dpkg 装不上新 deb（zstd 兼容）**：GitHub runner 镜像升级后，
  `dpkg-deb` 1.22+ 默认改用 zstd 压缩，Deepin 20 / arm64 真机（dpkg 1.19）
  报「对成员 control.tar.zst 使用了未知的压缩」。`build-deb.sh` 打包显式
  `-Zgzip`（所有 dpkg 版本的最小公约数，体积 110K→148K 可忽略）。
  v0.2.4/v0.2.5 的 deb 受影响，v0.2.6 起恢复。

## [0.2.5] — 2026-10-02

### Fixed

- **`tsc --noEmit` passes again — CI's red "Type check" step is addressable.**
  `src/permissions.js` carried four implicit-`any` parameters and `src/update.js`
  declared `updates` twice in the same function; under `strict` + `checkJs` both
  fail the type check, and since both files were already on `main`, every CI run
  went red regardless of the 253 green unit tests. The permission decision is now
  a typed module-level function, and the duplicated declaration is gone.
- **The kernel e2e job runs on ubuntu, the platform this shell actually ships.**
  The matrix previously listed `windows-latest` and `macos-latest` only — the one
  platform this Linux-only project publishes for had no end-to-end coverage, while
  two it explicitly does not target were tested on every push.
- **A permissions assertion guards every deb build against the EACCES
  regression.** Commit `d81cb11` fixed limited file modes (e.g. `0600`) leaking
  into the package and crashing Electron for non-root users once installed under
  `/opt`; nothing prevented a recurrence. `package-linux.yml` now unpacks the
  built deb's listing and fails the build if any file outside `DEBIAN/` lacks an
  other-user read bit (verified against both a healthy package and a deliberately
  broken one locally). Repository-side file modes are normalised as well.
- **Package metadata points at this repository, not the upstream baseline.**
  `homepage`, `repository.url`, `bugs.url` and `author` in `package.json` were
  inherited from `sleep2agi/DeepSeek-Harness-Desktop`, so a "report a problem"
  click would open someone else's issue tracker. They now name
  `westanke/dsh-desktop-deepin`. The dead electron-builder configuration
  (`win`/`nsis`, `mac`/`dmg`/`entitlements`, `AppImage`, `pack`, `dist:win`,
  `dist:mac`) is removed — this project ships Linux debs only — and
  `prepack:app` now runs the type check before packaging. `version` is aligned
  with the latest tag (v0.2.3).

### Added

- **The installer pre-downloads the runtimes in the background, under your own
  account.** `postinst` runs as root, but the runtimes belong in the installing
  user's `~/.dsh-desktop/runtime`, so it now resolves the real login user
  (`$SUDO_USER` → `loginctl` → the first real `/home` entry) and drops
  privileges with `runuser`/`su` before starting the download. The download is
  detached (`setsid` + `nohup`) so `apt install` returns immediately instead of
  appearing to hang for minutes on the 180 MB Electron — by the time the user
  clicks the launcher it is usually already there, which is the
  "works right after install" feel without shipping a 152 MB offline deb. Opt
  out with `DSH_NO_POSTINST_DOWNLOAD=1`. `bootstrap.sh install` now takes an
  atomic `mkdir` lock so a concurrent launch cannot race it on the same
  `.partial` file, and `start-shell.sh` waits on that lock (with visible
  progress) instead of downloading twice.


- **Downloads are checksum-verified on both install paths.** The shell-side
  installer (`src/runtime-install.js`) verified Node but trusted the HTTPS
  origin for Electron, the largest and therefore most attractive component;
  it now fetches the Electron release's `SHASUMS256.txt` (both China mirrors
  sync it) and refuses a substituted archive, degrading to origin-only
  integrity — loudly — when a mirror serves no manifest. The pure-shell
  bootstrap (`tools/bootstrap.sh`) verified nothing for either runtime; it now
  runs the same manifest check for Node and Electron (verified live: a clean
  download passes, a single flipped byte is rejected).
- **Orphan reaper: dead kernels no longer leak their MCP servers.** The kernel
  launches MCP servers through `npm exec` chains, and when a kernel died
  without a planned stop (a crash, or the market helper swapping the process),
  every chain was re-parented to init and lived on forever — repeated restarts
  accumulated a fresh crop of `excel-mcp-server` processes nobody owned. The
  shell now injects an attribution marker (`ELECTRON_USER_DATA`, chosen
  because the kernel strips `DSH_*` variables before handing its environment
  to MCP children) into the kernel it spawns; the whole process family carries
  it. After an unexpected exit, when restarts are exhausted, on user-initiated
  restarts and at shutdown, the shell walks `/proc` and TERMs every marked
  tree that can no longer reach a live kernel — escalating to SIGKILL after a
  grace period. Processes that look like a kernel (`--profile` + `--port` on
  their command line) are never reaped, so a second shell window's kernel and
  an unsupervised replacement kernel survive the sweep; processes younger than
  two seconds are always spared. The new `src/orphan-reaper.js` is covered by
  24 unit tests, and the sweep was verified against real orphaned chains on a
  live system.

## [0.2.3] — 2026-10-01

### 新增

- **首启进度可见化。** 在缺运行时且无终端的机器上，`start-shell.sh` 会转开
  `deepin-terminal`（依次降级 `x-terminal-emulator` → gnome-terminal → konsole →
  xfce4-terminal）重跑自身：检测、镜像测速、下载、配置回填全程可见，不再是对着
  静默等待。`DSH_BOOTSTRAP_IN_TTY=1` 防止转开循环。
- **权限白名单。** 渲染进程放行麦克风（audio-only 的 `media`）、通知、剪贴板
  读取/写入；摄像头与其余权限仍然默认拒绝。
- **`bootstrap.sh` 首要搜索 `/opt`**（含玲珑布局 `/opt/apps/*/files`），并覆盖
  nvm/fnm/volta/asdf/n/pnpm/yarn/snap/brew——机器上已有的运行时直接复用，不下载。

### 修复

- **时区兜底。** `/etc/timezone` 为 `Asia/Beijing`、`PRC` 等 Chromium 不认的名字时，
  开窗前映射为 `Asia/Shanghai`。
- **Gitee 同步容忍跨境 TLS 抖动**：带重试与超时；同步失败只告警，不再拖红发布流水线。

## [0.2.1] — 2026-10-01

### 新增

- **arm64 deb。** 打包流水线从同一份源码产出 `amd64` 与 `arm64` 两个 deb（deb 只含
  壳代码，运行时首启按架构下载），并发布到 GitHub 与 Gitee 两侧 Release。
- **deb 版本号取自 tag**，终结早期「tag 是 v0.1.7、文件名却是 0.1.2」的错位。
- **多用户配置分层。** `/opt` 下的发行配置只读、全局共享；每用户覆盖份在
  `~/.config/dsh-desktop/config.json`，按键合并（DEFAULTS < 发行份 < 用户份）。
  自举检测到的运行时路径只写用户份，不碰全局份。

### 修复

- **限制性文件权限不再打断安装后的应用**：打包前对构建树 `chmod -R a+rX`，普通用户
  能真正读到 `/opt/.../src`（此前的 EACCES 崩溃）。
- **首次安装崩溃**：用户配置尚不存在时回写路径触发 `set -u` 未绑定变量。

## [0.1.7] — 2026-09-30

### 变更

- **deb 改用 `dpkg-deb` 直接构建，只装约 100KB 的壳代码**——Electron、Node 与内核
  首次启动时从国内镜像按需下载（先测速，按网络实况排镜像顺序）。内核经
  `upstream.lock.json` 钉在 `@deepseek-ai/dsh` 0.2.0-rc.2（sha512 校验）。
- 移除 Windows/macOS 打包流水线：本项目只发 Linux deb。

## [0.1.3] — 2026-09-29

### 新增

- **加载页 + 内核实时日志**——窗口先于内核出现，流式展示内核日志（已脱敏）、
  原地推进各阶段，就绪后再停留 `splashMinMs` 供阅读。
- **安全模式**：不加载第三方 bundle、用户 patch 层挪开备份（不持久化）——插件把
  内核在加载期搞崩时，壳仍进得去、有路可退。
- **端口由 OS 分配。** 内核端口每次启动由系统挑选；就绪探测不会再错审占着旧固定
  端口的别人家内核。
- **保留应用菜单栏**（应用/文件/编辑/视图/窗口）、F12 / Ctrl+Shift+I 开 DevTools、
  `kernel.homeSubdir` 支持 `~`、`supervisor.readinessTimeoutMs` 真正从配置读取。

## [0.1.2] — 2026-08-14

### Added

- **macOS desktop build.** The shell now ships a checksum-verified Node runtime for
  Apple Silicon and Intel (`darwin-arm64`, `darwin-x64`), packages a `.dmg` and a `.zip`,
  and runs the same readiness / window-policy / process-tree shutdown path as Windows.
- Unix kernel processes are spawned as their own process-group leader, so quitting the
  app actually tears down the tools the kernel started rather than leaving them orphaned.
- A Dock- or Finder-launched Mac app prepends Homebrew's usual `PATH` locations, so
  `git` (and the rest of a developer toolchain) is visible to the kernel.

### Changed

- `npm run dist` builds for the current platform. `dist:win` and `dist:mac` select one
  explicitly. CI and the release workflow now cover `macos-latest` as well as Windows.

### Known limitations

- Packaged Mac builds are ad-hoc signed, not notarized. Gatekeeper will warn on a
  downloaded `.dmg`.

## [0.1.1] — 2026-08-14

### Changed

- The packaged application is **180 MB smaller** — 674 MB installed down to 494 MB — with
  no change to what it can do.

  An npm tree is published for developers, and everything in it ships to every user. The
  removed files are the ones a running application never opens: debug symbols (52.8 MB),
  source maps (36.8 MB), the TypeScript the JavaScript was built from (35.0 MB),
  documentation (5.8 MB), and prebuilt native binaries for platforms this build does not
  target (~26 MB). Chromium's locale files account for the remaining 45.6 MB; the two the
  application can actually display are kept.

  Licences and notices are kept in every spelling — redistributing MIT-licensed code
  without its licence text is a violation, and they are small. The end-to-end test runs
  against the pruned kernel, so a size win that broke startup would fail the build.

  Kernel startup also got faster, from ~41 s to ~17 s, with 20,041 fewer files to walk.

## [0.1.0] — 2026-08-13

First preview. Windows is built and verified end to end; macOS and Linux are untested.

### Added

- Launches the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) kernel
  (`@deepseek-ai/dsh` 0.1.0-rc.6) as a child process on a free loopback port and shows its
  web UI in a desktop window.
- Bundles the kernel and the Node runtime it is published against, so a packaged build has
  no external requirements. Both are pinned in `upstream.lock.json`; the kernel is checked
  against its npm integrity hash and Node against the SHA-256 published in that release's
  `SHASUMS256.txt`, with each artefact asked to confirm its own version afterwards.
- Waits for a real HTTP response from the launch being waited on before showing a window,
  and reports an unexpected kernel exit with its captured output rather than leaving a
  window pointed at a process that is gone.
- Confines the window to the kernel's exact origin, restricts external links to
  `http`/`https`, refuses `webview` attachment, and attaches no preload bridge.
- Gives the kernel a private `DSH_HOME`, drops inherited `DSH_*` variables, and sets
  telemetry to disabled explicitly.
- Captures kernel output into a bounded buffer, redacted on entry, with the count of
  dropped lines kept visible.
- `tools/scan-leaks.js`, run in CI, fails the build on credentials, private registries, or
  internal address ranges in the working tree or in history.

### Known limitations

- The kernel's native workspace picker crashes on Windows in this upstream preview.
  `buildShellPatch({ useBrowseDirectoryPicker: true })` selects the non-native
  implementation; it is not enabled by default yet.
- Log redaction matches by shape and cannot be complete.
- Installers are unsigned, so Windows SmartScreen will warn on first run.

[0.1.2]: https://github.com/sleep2agi/DeepSeek-Harness-Desktop/releases/tag/v0.1.2
[0.1.1]: https://github.com/sleep2agi/DeepSeek-Harness-Desktop/releases/tag/v0.1.1
[0.1.0]: https://github.com/sleep2agi/DeepSeek-Harness-Desktop/releases/tag/v0.1.0
