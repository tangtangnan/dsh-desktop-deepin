/**
 * Configurable key bindings and how a key press reaches the page.
 *
 * Two official behaviours are reproduced here.
 *
 * First, overrides live in `userData/keybindings.json`, deliberately separate
 * from `DSH_HOME`: they are a preference about the desktop surface, not about
 * the kernel, and the two are backed up and reset independently.
 *
 *   "快捷键覆盖保存在 `app.getPath('userData')/keybindings.json`，与 `DSH_HOME` 分离。"
 *
 * Second, delivery is platform-specific:
 *
 *   "Linux 通过 DOM 分发主文档快捷键，并将已接受的内嵌 frame 绑定转发给
 *    Client 解析器。"
 *
 * Windows and macOS intercept accepted bindings before the page sees them.
 * Linux does not get that interception, so the shell dispatches through the
 * DOM instead. The distinction matters: an editing keystroke that the shell
 * swallowed on Linux would break terminal input and IME composition.
 *
 * The validation and dispatch-planning rules are pure functions; only
 * {@link dispatchShortcut} touches a window.
 *
 * @module shortcuts
 */

/** Bindings the shell recognises. */
export const DEFAULT_BINDINGS = Object.freeze({
  'window.close': 'CmdOrCtrl+W',
  'window.reload': 'CmdOrCtrl+R',
  'window.toggleDevTools': 'CmdOrCtrl+Shift+I',
  'window.toggleFullScreen': 'F11',
})

/**
 * Accelerators that must never be rebindable: they belong to the platform or
 * to the accessibility stack, and stealing them makes the app unusable rather
 * than customised.
 *
 * @type {readonly string[]}
 */
export const RESERVED_ACCELERATORS = Object.freeze(['CmdOrCtrl+Q', 'Alt+F4', 'CmdOrCtrl+Alt+Del'])

/**
 * Validates one override map.
 *
 * Unknown commands and reserved accelerators are rejected rather than
 * accepted-and-ignored: a binding the user set and that silently does nothing
 * is worse than one that is refused with a reason.
 *
 * @param {unknown} input - raw JSON-parsed contents of `keybindings.json`
 * @param {object} [options]
 * @param {readonly string[]} [options.knownCommands] - commands that may be bound
 * @returns {{accepted: Record<string, string>, rejected: string[]}}
 */
export function validateBindings(input, { knownCommands = Object.keys(DEFAULT_BINDINGS) } = {}) {
  /** @type {Record<string, string>} */
  const accepted = {}
  /** @type {string[]} */
  const rejected = []

  if (typeof input !== 'object' || input === null) {
    return { accepted, rejected }
  }

  for (const [command, value] of Object.entries(/** @type {Record<string, unknown>} */ (input))) {
    if (!knownCommands.includes(command)) {
      rejected.push(`${command}: unknown command`)
      continue
    }
    if (typeof value !== 'string' || value.trim() === '') {
      rejected.push(`${command}: binding must be a non-empty string`)
      continue
    }
    const accelerator = value.trim()
    if (RESERVED_ACCELERATORS.some((reserved) => reserved.toLowerCase() === accelerator.toLowerCase())) {
      rejected.push(`${command}: ${accelerator} is reserved`)
      continue
    }
    accepted[command] = accelerator
  }

  return { accepted, rejected }
}

/**
 * Merges accepted overrides over the defaults.
 *
 * @param {Record<string, string>} overrides
 * @returns {Record<string, string>}
 */
export function resolveBindings(overrides) {
  return { ...DEFAULT_BINDINGS, ...overrides }
}

/**
 * How a binding should be delivered on this platform.
 *
 * `intercept` is the Windows/macOS path: the shell consumes the key before the
 * page sees it. `dom` is the Linux path: the shell lets the key through and
 * dispatches it into the document.
 *
 * @param {object} [options]
 * @param {string} [options.platform] - `process.platform`
 * @returns {'intercept' | 'dom'}
 */
export function shortcutDeliveryMode({ platform = process.platform } = {}) {
  return platform === 'linux' ? 'dom' : 'intercept'
}

/**
 * Builds the script that dispatches a shortcut into the page.
 *
 * Used on Linux, where the shell does not intercept the keystroke and instead
 * asks the document to handle it. The command is embedded as a JSON string so
 * a quote in it cannot break out of the script.
 *
 * @param {string} command
 * @returns {string}
 */
export function domDispatchScript(command) {
  const encoded = JSON.stringify(String(command))
  return `(function () {
  var command = ${encoded};
  var event = new CustomEvent('dsh:shortcut', { detail: { command: command }, bubbles: true });
  (document.activeElement || document.body || document).dispatchEvent(event);
  return true;
})()`
}

/**
 * Delivers a command to the window, using the platform's mode.
 *
 * @param {object} options
 * @param {string} options.command
 * @param {{ isDestroyed?: () => boolean }} options.webContents
 * @param {(script: string) => Promise<unknown>} options.execute
 * @param {'intercept' | 'dom'} [options.mode]
 * @returns {Promise<void>}
 */
export async function dispatchShortcut({ command, webContents, execute, mode }) {
  const delivery = mode ?? shortcutDeliveryMode()
  if (delivery !== 'dom') return
  if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) return
  await execute(domDispatchScript(command)).catch(() => undefined)
}
