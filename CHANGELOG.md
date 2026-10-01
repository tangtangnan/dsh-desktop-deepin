# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Changed

- **Ports are now always assigned by the OS.** The shell used to prefer `19387`
  (the official default) and fall back to a free port when it was taken — but
  the readiness probe kept using the original origin, so it ended up checking
  *another* dsh instance's kernel. That kernel gates its web surface behind its
  own per-launch token, the probe carried a different one, every attempt came
  back 401, and startup failed with "the kernel did not start responding in
  time" while the real kernel was healthy on the port it had been given. An
  OS-assigned port makes the collision impossible.
- **The OS menu bar is kept instead of removed.** `Menu.setApplicationMenu(null)`
  in `createWindow` is replaced by a real menu built by `src/app-menu.js`:
  应用 / 文件 / 编辑 / 视图 / 窗口. The official shell documents that Linux keeps
  the application and Edit menus, so removing the bar contradicted the behaviour
  this shell mirrors. The first application-menu item opens Electron's native
  About panel (icon, product name, installed version).
- **DevTools toggles on F12 and Ctrl+Shift+I**, registered as hidden menu items,
  which is how the official shell exposes them in packaged builds.
- **The window appears before the kernel starts.** The old order was
  `await startKernel()` then `createWindow()`, so a cold start meant staring at
  nothing until the kernel was up. `createWindow` now returns a handle and the
  endpoint is injected later via `setKernel(origin, token)`; navigation policy,
  window-open classification and renderer recovery all read a closure, and
  refuse external navigation entirely until the origin is known.
- **The loading page advances in place.** Each stage change used to call
  `loadURL`, which rebuilt the document: the elapsed counter reset and the early
  stages flashed by unreadably. `src/loading-page.js` now exposes
  `window.__dshStage()` / `window.__dshLog()` and the main process updates the
  text. Its inline script also needed `script-src 'unsafe-inline'` in the page's
  CSP — without it the hooks were never defined and every update was silently
  dropped.
- **`kernel.homeSubdir` accepts `~`.** `path.isAbsolute('~/.dsh')` is `false`, so
  the value was treated as relative and joined onto `userData`, producing a
  literal directory named `~`. The kernel then started against an empty home and
  none of the user's plugins loaded.
- **`supervisor.readinessTimeoutMs` is actually read.** It was documented but
  never passed to `waitForReady`, so the hard-coded 90 s always won. Measured
  startup on this machine ranges 45–120+ s (plugins and MCP servers initialise
  serially), so the value is now 240 s and genuinely applied.
- **The packaging step no longer fetches the kernel or Node.** Both are obtained
  at run time by the user's machine instead, which is what keeps the deb near
  1 MB.

### Added

- `src/runtime-doctor.js` / `src/runtime-install.js` / `tools/doctor.js` —
  runtime discovery and acquisition. Detection tries the configured path, then
  `PATH`, then conventional locations. Missing pieces download from China
  mirrors first (`npmmirror.com`, `mirrors.huaweicloud.com`) into
  `~/.dsh-desktop/runtime`, with the Node archive checked against the published
  SHA-256, the destination written via a `.partial` rename, and the resolved
  paths written back to `config.json` (backed up first). Exposed as
  `npm run doctor` and `npm run doctor:install`.
- `tools/bootstrap.sh` — the same checks in **pure shell**, deliberately. Its job
  is to find Node and install it when absent, so it cannot itself require Node:
  that would be a bootstrap cycle. It uses only bash plus curl/wget and
  tar/unzip, all of which a Debian/UOS base system has. Modes: `check`,
  `install`, `run`.
- `src/app-menu.js` — the application menu, including the About panel.
- `src/safe-mode.js` — starts the kernel with the user's third-party bundles
  disabled and sets their patch layer aside (`cordis.patch.yml` →
  `cordis.patch.yml.bak-<UTC>`), following the official recovery mechanism.
  Deliberately **not persisted**: it is a recovery action, so a normal restart
  brings the plugins back. Reachable from the tray, the application menu and the
  in-page controls.
- `src/desktop-commands.js` — the allowlist of desktop actions the in-page
  controls may request, plus the state pushed back to the page. A page sends an
  action *name* only; anything not on the list is refused.
- `plugins/dsh-deepin-controls` — a floating 桌面工具 panel inside the web UI
  mirroring the tray's actions, mounted through the kernel's
  `dsh.bundle.patch` mechanism.
- `src/directory-picker.js` — decides whether the native folder dialog can be
  used. The official shell falls back to browse mode when Linux has neither
  `zenity` nor `kdialog`, since Electron's native dialog shells out to one of
  them and silently does nothing without it. The probe is a pure function; the
  result feeds `buildShellPatch({ useBrowseDirectoryPicker })`.
- `src/config-file.js` — `atomicWriteFile` (write a sibling temp file, rename
  over the target) and `withFileLock` (an advisory `<target>.lock` directory,
  broken when stale). Two files this shell writes used to be written with a
  plain `writeFile`, which is not atomic.
- `src/diagnostics.js` — crash reports. The official shell writes them to the
  platform log directory — `logs` under `userData` on Linux and Windows —
  named `crash-<UTC>-<source>.log`, keeping the most recent ten. Replaces the
  unbounded `kernel-exit.log` and `startup-error.log`.
- `src/permissions.js` — denies every web permission. Without a handler
  Chromium prompts for camera, microphone and notifications on behalf of a page
  that is the kernel's web UI, not shell code.
- `src/window-state.js` — remembers the window's size and position under
  `userData`, and reuses a saved position only when enough of the window would
  still land on a connected display. A monitor unplugged since the last launch
  no longer strands the window off-screen.
- `src/shortcuts.js` — key bindings. Overrides live in
  `userData/keybindings.json`, separate from `DSH_HOME`. Linux dispatches
  through the DOM rather than intercepting the keystroke before the page sees
  it, which is what the official shell documents and what keeps editing and IME
  input working.
- `src/exit-guard.js` — whether quitting should prompt first, as a declared
  policy (`ask-always` / `ask-if-busy` / `never`). **Differs from upstream by
  necessity**: the official shell asks its Host what quitting would interrupt
  over a private IPC channel belonging to its private Desktop Host package.
  This shell has no such channel, so it cannot know exactly, and defaults to
  always asking instead of pretending otherwise.
- `kernel.directoryPicker` (`auto` / `browse` / `native`) and
  `kernel.exitPolicy` (`ask-always` / `ask-if-busy` / `never`) in `config.json`.
- `splashMinMs` — a floor on how long the loading page stays up after the kernel
  is ready, so its log pane can actually be read (`0` disables it).
- Window geometry is remembered across launches, and every write of a shell
  configuration file is atomic and lock-protected.

### Fixed

- **`KernelSupervisor` methods were called on a `KernelProcess`.** The tray's
  "restart kernel" item did nothing: `restartKernel` assigned the process
  returned by `restart()` back into the `kernel` variable, so the next restart
  called `restart()` on an object that has no such method, and the throw was
  swallowed by a bare `catch`. `restart()` and `markReady()` live on the
  supervisor; `isRunning()`, `webToken()` and `args` live on the process.
- **The restart probe did not carry the launch token**, so in system-kernel mode
  every probe after a restart came back 401 and the window sat on "waiting for
  the kernel" forever. The restart path now uses the same probe as the first
  launch.
- **`tray.notify` did not exist.** The completion notification threw into the
  preload's `try/catch` every time, so the feature was silently dead. Implemented
  with a tray balloon and an Electron `Notification` fallback.
- **`kernel.logText()` was called on the supervisor**, which has no such method;
  it lives on the process (`kernel.current`). A startup failure raised a second
  error while reporting the first.
- **`globalShortcut` was referenced without being loaded.** `tray.js` reaches
  Electron through `loadElectron()` on purpose (so its pure parts stay testable
  under plain Node); that one call site used the bare global, so the summon
  shortcut never registered.
- `src/loading-page.js` and `src/error-page` CSP now both allow their inline
  scripts.
- Type checking is clean across the whole repository, which is how the five bugs
  above were found: they had all been dismissed as pre-existing noise.

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
