# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **The OS menu bar is kept instead of removed.** `Menu.setApplicationMenu(null)`
  in `createWindow` is replaced by a real menu built by `src/app-menu.js`:
  应用 / 文件 / 编辑 / 视图 / 窗口. The official shell documents that Linux keeps
  the application and Edit menus, so removing the bar contradicted the behaviour
  this shell mirrors. The first application-menu item opens Electron's native
  About panel (icon, product name, installed version).
- **DevTools toggles on F12 and Ctrl+Shift+I**, registered as hidden menu items,
  which is how the official shell exposes them in packaged builds.

### Added

- `src/directory-picker.js` — decides whether the native folder dialog can be
  used. The official shell falls back to browse mode when Linux has neither
  `zenity` nor `kdialog`, since Electron's native dialog shells out to one of
  them and silently does nothing without it. The probe is a pure function; the
  result feeds `buildShellPatch({ useBrowseDirectoryPicker })`.
- `kernel.directoryPicker` in `config.json` (`auto` / `browse` / `native`) pins
  the choice for debugging.
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
- The kernel now prefers port `19387`, the official default, falling back to a
  free port when it is taken.
- Window geometry is remembered across launches, and every write of a shell
  configuration file is atomic and lock-protected.

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
