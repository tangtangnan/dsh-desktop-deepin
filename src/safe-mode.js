/**
 * Safe Mode: start the kernel without the user's third-party bundles.
 *
 * The official shell offers this from its fatal-error recovery dialog, and the
 * README describes it as disabling third-party bundles and backing up the
 * profile's patch layer:
 *
 *   "它禁用第三方 bundle，并将 profile 的 `cordis.patch.yml` 重命名为
 *    `cordis.patch.yml.bak-<timestamp>`"
 *   — apps/desktop/README.zh.md
 *
 * Why it matters: a plugin that crashes the kernel at load time leaves a shell
 * that cannot start, and a shell that cannot start cannot be told to remove the
 * plugin. Safe Mode breaks that deadlock by starting the kernel with the
 * user's bundles switched off, so the plugin manager is reachable again and the
 * offending bundle can be disabled or updated from inside the UI.
 *
 * The mechanism is a `--patch` overlay of `{ id, disabled: true }` rows, which
 * is the same disable mechanism `src/shell-patch.js` already emits. Nothing
 * upstream is edited: the user's own patch layer is set aside, not rewritten.
 *
 * The decisions here are pure; the file operations live in `main.js`.
 *
 * @module safe-mode
 */

import { basename, dirname, join } from 'node:path'

/**
 * Bundles that must never be disabled by Safe Mode.
 *
 * These are the kernel's own layers — disabling them would leave a kernel with
 * no web surface at all, which is a worse failure than the one being recovered
 * from.
 *
 * @type {readonly string[]}
 */
export const PROTECTED_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
])

/**
 * Bundle names, from a profile manifest.
 *
 * @param {unknown} manifest - parsed `profiles/<name>/package.json`
 * @returns {string[]}
 */
export function bundleNames(manifest) {
  const bundles = /** @type {any} */ (manifest)?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return []
  return bundles.filter((name) => typeof name === 'string')
}

/**
 * The bundles Safe Mode should switch off: everything the user added, and
 * nothing the kernel needs to boot.
 *
 * @param {unknown} manifest - parsed `profiles/<name>/package.json`
 * @returns {string[]}
 */
export function safeModeTargets(manifest) {
  return bundleNames(manifest).filter((name) => !PROTECTED_BUNDLES.includes(name))
}

/**
 * Whether there is anything Safe Mode would actually switch off.
 *
 * A profile with no third-party bundles has nothing to recover from, and
 * starting in Safe Mode anyway would only look like something happened.
 *
 * @param {unknown} manifest
 * @returns {boolean}
 */
export function hasSafeModeTargets(manifest) {
  return safeModeTargets(manifest).length > 0
}

/**
 * Builds the disable overlay for the given bundle names.
 *
 * `id` alone is enough to address a row; a `name` would turn the entry into a
 * guard that must match, and this overlay deliberately does not care which
 * implementation is behind the id.
 *
 * @param {readonly string[]} names
 * @returns {Array<{id: string, disabled: boolean}>}
 */
export function toDisablePatch(names) {
  return names.map((id) => ({ id, disabled: true }))
}

/**
 * The name to move a patch file aside to.
 *
 * A timestamped suffix keeps each attempt distinct, and a sequence number is
 * appended when the same second already produced a backup — two rapid
 * recoveries must not overwrite each other's backup.
 *
 * @param {string} path - the patch file being set aside
 * @param {Date} [when]
 * @param {number} [sequence]
 * @returns {string}
 */
export function backupName(path, when = new Date(), sequence = 0) {
  const stamp = when.toISOString().replace(/[:.]/g, '-')
  const suffix = sequence > 0 ? `.${sequence}` : ''
  return `${basename(path)}.bak-${stamp}${suffix}`
}

/**
 * Where a backup of `path` goes: beside the original, so it stays on the same
 * filesystem and the rename is atomic.
 *
 * @param {string} path
 * @param {Date} [when]
 * @param {number} [sequence]
 * @returns {string}
 */
export function backupPath(path, when, sequence) {
  return join(dirname(path), backupName(path, when, sequence))
}

/**
 * Picks an unused backup path, so an existing backup is never overwritten.
 *
 * @param {string} path
 * @param {(candidate: string) => boolean} exists
 * @param {Date} [when]
 * @returns {string}
 */
export function nextBackupPath(path, exists, when = new Date()) {
  for (let sequence = 0; sequence < 100; sequence += 1) {
    const candidate = backupPath(path, when, sequence)
    if (!exists(candidate)) return candidate
  }
  // A hundred backups in one second is not a recovery, it is a loop.
  throw new Error(`too many backups of ${path}`)
}

/**
 * Whether a bundle name is one Safe Mode must leave alone.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isProtectedBundle(name) {
  return PROTECTED_BUNDLES.includes(name)
}
