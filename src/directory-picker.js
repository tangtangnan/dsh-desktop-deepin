/**
 * Whether the native directory dialog can actually be used.
 *
 * The official shell documents this exact fallback:
 *
 *   "Linux 缺少 zenity 或 kdialog 时，自动选择使用浏览模式，不使用 Electron 对话框。"
 *   — apps/desktop/README.zh.md
 *
 * Electron's native folder dialog on Linux is not self-contained: it shells out
 * to `zenity` (GTK) or `kdialog` (Qt). A desktop that ships neither — a minimal
 * install, or one that dropped both — gets a dialog that silently does nothing,
 * which is worse than a fallback, because the user cannot tell the difference
 * between "no dialog appeared" and "I cancelled it".
 *
 * The decision is a pure function so it can be tested without Electron and
 * without a filesystem: the caller passes the PATH entries and the existence
 * check.
 *
 * @module directory-picker
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The external helpers Electron's native folder dialog depends on, in the
 * order they are looked up.
 *
 * @type {readonly string[]}
 */
export const LINUX_PICKER_HELPERS = Object.freeze(['zenity', 'kdialog'])

/**
 * Splits a `PATH` value into candidate directories, dropping empty entries.
 *
 * @param {string} [pathValue]
 * @returns {string[]}
 */
export function splitPathEntries(pathValue) {
  return (pathValue ?? '').split(':').filter((entry) => entry !== '')
}

/**
 * Whether the native folder dialog is usable.
 *
 * Windows and macOS need no external helper, so the answer there is always yes.
 * Linux needs one of {@link LINUX_PICKER_HELPERS} to be present on `PATH`.
 *
 * @param {object} [options]
 * @param {string} [options.platform] - `process.platform`
 * @param {string[]} [options.pathEntries] - directories to search
 * @param {(path: string) => boolean} [options.exists] - injectable existence check
 * @returns {boolean}
 */
export function detectNativeDirectoryPicker({
  platform = process.platform,
  pathEntries = [],
  exists = existsSync,
} = {}) {
  if (platform !== 'linux') return true
  return LINUX_PICKER_HELPERS.some((helper) =>
    pathEntries.some((entry) => exists(join(entry, helper))),
  )
}

/**
 * Whether the shell should force the browse-mode directory picker.
 *
 * `mode` lets the decision be pinned for debugging: `'browse'` always uses the
 * non-native picker, `'native'` always trusts the native dialog, and `'auto'`
 * (the default, and what the official shell describes) follows the platform.
 *
 * @param {object} [options]
 * @param {string} [options.platform] - `process.platform`
 * @param {string} [options.pathValue] - a `PATH` value, split internally
 * @param {'auto' | 'browse' | 'native'} [options.mode]
 * @param {(path: string) => boolean} [options.exists] - injectable existence check
 * @returns {boolean} true when the browse-mode picker should be used
 */
export function shouldUseBrowsePicker({
  platform = process.platform,
  pathValue = process.env.PATH ?? '',
  mode = 'auto',
  exists = existsSync,
} = {}) {
  if (mode === 'browse') return true
  if (mode === 'native') return false
  return !detectNativeDirectoryPicker({
    platform,
    pathEntries: splitPathEntries(pathValue),
    exists,
  })
}
