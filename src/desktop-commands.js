/**
 * The commands the in-page desktop controls are allowed to ask the shell for.
 *
 * The renderer is the kernel's web UI — untrusted by design. The preload is
 * deliberately narrow, so this module exists to state, in one place, exactly
 * which shell actions a page may request. Anything not listed here is refused
 * rather than forwarded: the alternative is a generic "invoke anything" bridge,
 * which is precisely what the shell's preload was written to prevent.
 *
 * Each command maps to a tray action the user can already reach, so the page
 * gains no capability the tray did not already have.
 *
 * @module desktop-commands
 */

/**
 * The actions a page may request.
 *
 * @typedef {'restart-kernel'
 *   | 'check-updates'
 *   | 'toggle-launch-at-login'
 *   | 'show-about'
 *   | 'quit'
 *   | 'hide-window'} DesktopAction
 */

/**
 * The accepted actions, with whether each needs confirmation before running.
 *
 * `quit` is destructive — it stops the kernel and any task in flight — so the
 * shell asks first rather than obeying a click in a page.
 *
 * @type {Readonly<Record<DesktopAction, {confirm: boolean}>>}
 */
export const DESKTOP_ACTIONS = Object.freeze({
  'restart-kernel': { confirm: false },
  'check-updates': { confirm: false },
  'toggle-launch-at-login': { confirm: false },
  'show-about': { confirm: false },
  'hide-window': { confirm: false },
  quit: { confirm: true },
})

/**
 * Whether an action may be requested.
 *
 * @param {unknown} action
 * @returns {action is DesktopAction}
 */
export function isDesktopAction(action) {
  return typeof action === 'string' && Object.hasOwn(DESKTOP_ACTIONS, action)
}

/**
 * Whether running an action needs a confirmation step first.
 *
 * @param {DesktopAction} action
 * @returns {boolean}
 */
export function needsConfirmation(action) {
  return DESKTOP_ACTIONS[action]?.confirm === true
}

/**
 * The state the page is told about, so the controls can render it.
 *
 * `busy` is the shell's approximation of "a turn is in flight", taken from the
 * DOM observer rather than from the kernel's own task list — see
 * `src/exit-guard.js` for why the real answer is not available to this shell.
 *
 * @typedef {object} DesktopState
 * @property {'starting' | 'ready' | 'crashed'} phase
 * @property {'launching' | 'waiting-for-ready' | 'retrying'} [stage]
 * @property {number} [attempts]
 * @property {number} [retryDelayMs]
 * @property {boolean} busy
 * @property {boolean} launchAtLogin
 */

/**
 * Reduces the shell's own state to what the page is allowed to see.
 *
 * Nothing here carries a path, a token, or a log line: the page is not a
 * trusted surface and does not need any of those to draw a status line.
 *
 * @param {object} options
 * @param {{phase: string, stage?: string, attempts?: number, retryDelayMs?: number} | null} [options.kernelState]
 * @param {boolean} [options.busy]
 * @param {boolean} [options.launchAtLogin]
 * @returns {DesktopState}
 */
export function toDesktopState({ kernelState = null, busy = false, launchAtLogin = false } = {}) {
  const phase =
    kernelState?.phase === 'ready' || kernelState?.phase === 'crashed'
      ? kernelState.phase
      : 'starting'
  /** @type {DesktopState} */
  const state = { phase, busy, launchAtLogin }
  const stage = kernelState?.stage
  if (stage === 'launching' || stage === 'waiting-for-ready' || stage === 'retrying') {
    state.stage = stage
  }
  if (kernelState?.attempts !== undefined) state.attempts = kernelState.attempts
  if (kernelState?.retryDelayMs !== undefined) state.retryDelayMs = kernelState.retryDelayMs
  return state
}
