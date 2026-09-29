/**
 * Host half of the proof-of-concept pseudo Desktop Host plugin.
 *
 * This exists to answer one question: can a locally authored bundle — not
 * published to npm, not part of the official signed release — be mounted into
 * the kernel through the same `dsh.bundle.patch` + `insert` mechanism the
 * official `dsh-desktop-controls` uses?
 *
 * It registers no tools and opens no windows. The only thing it does is export
 * a pure function that picks a screen-capture command, following the same
 * "probe for an external helper and degrade" pattern the official package uses
 * for Linux fallbacks. The function is deliberately pure so the mount can be
 * verified without a running kernel.
 *
 * @module dsh-deepin-controls/host
 */

/** Linux screenshot helpers, most preferred first. */
const CAPTURE_FALLBACKS_LINUX = Object.freeze([
  { command: 'deepin-screen-recorder', args: (file) => ['--fullscreen', file] },
  { command: 'scrot', args: (file) => ['-o', file] },
  { command: 'gnome-screenshot', args: (file) => ['-f', file] },
  { command: 'spectacle', args: (file) => ['-b', '-n', '-o', file] },
  { command: 'import', args: (file) => ['-window', 'root', file] },
])

/**
 * Picks the capture command for a platform, or undefined when there is none.
 *
 * Pure and unit-testable, exactly as the official package's `captureCommand`
 * is.
 *
 * @param {string} platform - `process.platform`
 * @param {string} file - destination PNG path
 * @returns {{command: string, args: string[]} | undefined}
 */
export function captureCommand(platform, file) {
  if (platform === 'darwin') return { command: 'screencapture', args: ['-x', file] }
  if (platform !== 'linux') return undefined
  const fallback = CAPTURE_FALLBACKS_LINUX[0]
  return { command: fallback.command, args: fallback.args(file) }
}

/**
 * Which of the known Linux helpers is actually installed.
 *
 * The existence check is injected, so this is testable without a filesystem —
 * the same shape as `src/directory-picker.js` in the shell.
 *
 * @param {(command: string) => boolean} isAvailable
 * @returns {string | null} the command name, or null when none is present
 */
export function availableCaptureHelper(isAvailable) {
  for (const { command } of CAPTURE_FALLBACKS_LINUX) {
    if (isAvailable(command)) return command
  }
  return null
}

/** The plugin's mount identity, asserted by the mount check. */
export const BUNDLE_ID = 'deepin-controls'
