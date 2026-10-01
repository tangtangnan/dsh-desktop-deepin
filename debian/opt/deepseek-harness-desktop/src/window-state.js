/**
 * Persisted geometry for the main window.
 *
 * A window that always opens at a fixed size ignores what the user chose last
 * time. Restoring it unconditionally is worse: the saved position can be on a
 * monitor that has since been unplugged, leaving the window somewhere the user
 * cannot see it — with no obvious way back.
 *
 * The rule is therefore: sizes are honoured (clamped to the window's
 * minimums), and a saved position is reused only when enough of the window
 * would still land on some connected display.
 *
 * Pure functions over plain data, so the rules can be tested without Electron.
 *
 * @module window-state
 */

/**
 * @typedef {object} WindowState
 * @property {number} width
 * @property {number} height
 * @property {number} [x]
 * @property {number} [y]
 * @property {boolean} [isMaximized]
 */

/**
 * @typedef {object} DisplayArea
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/** First-launch geometry. */
export const DEFAULT_WINDOW_WIDTH = 1280
export const DEFAULT_WINDOW_HEIGHT = 860

/** The window's own minimums, used to clamp a restored size. */
export const MIN_WINDOW_WIDTH = 800
export const MIN_WINDOW_HEIGHT = 600

/**
 * How much of the window must overlap a display for its saved position to be
 * trusted.
 *
 * Small enough that a window mostly dragged off-screen is still restored where
 * the user left it; large enough that a window stranded on a disconnected
 * monitor is not.
 *
 * @type {number}
 */
export const MIN_VISIBLE_PX = 100

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Overlap between a candidate rectangle and one display's work area.
 *
 * @param {{width: number, height: number, x: number, y: number}} rect
 * @param {DisplayArea} area
 * @returns {boolean}
 */
export function isVisibleOn(rect, area) {
  const overlapWidth = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x)
  const overlapHeight = Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y)
  return overlapWidth >= MIN_VISIBLE_PX && overlapHeight >= MIN_VISIBLE_PX
}

/**
 * Validates persisted geometry against the displays that are connected now.
 *
 * @param {unknown} input - raw JSON-parsed contents of `window-state.json`
 * @param {readonly DisplayArea[]} displays - work areas of connected displays
 * @returns {WindowState} a state safe to hand to `BrowserWindow`
 */
export function fitWindowState(input, displays) {
  if (typeof input !== 'object' || input === null) {
    return { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT }
  }

  const candidate = /** @type {Record<string, unknown>} */ (input)
  const width = isNumber(candidate.width)
    ? Math.max(Math.round(candidate.width), MIN_WINDOW_WIDTH)
    : DEFAULT_WINDOW_WIDTH
  const height = isNumber(candidate.height)
    ? Math.max(Math.round(candidate.height), MIN_WINDOW_HEIGHT)
    : DEFAULT_WINDOW_HEIGHT

  /** @type {WindowState} */
  const result = { width, height }

  const { x, y } = candidate
  if (isNumber(x) && isNumber(y)) {
    const position = { width, height, x: Math.round(x), y: Math.round(y) }
    if (displays.some((area) => isVisibleOn(position, area))) {
      result.x = position.x
      result.y = position.y
    }
  }

  if (candidate.isMaximized === true) result.isMaximized = true
  return result
}

/**
 * Extracts geometry from a window for persistence.
 *
 * A maximized window's bounds are the display's, not the user's preference, so
 * the restored size is read from `getNormalBounds()` — what the window returns
 * to when it is un-maximized.
 *
 * @param {object} window
 * @param {() => {width: number, height: number, x: number, y: number}} window.getNormalBounds
 * @param {() => boolean} window.isMaximized
 * @returns {WindowState}
 */
export function captureWindowState(window) {
  const bounds = window.getNormalBounds()
  return {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    isMaximized: window.isMaximized(),
  }
}
