/**
 * Central configuration for the shell.
 *
 * Every value that someone might want to change — paths, the kernel home
 * sub-directory, restart backoff, the tray shortcut, the update feed — lives in
 * `config.json` at the project root. This module loads it once, merges it over
 * built-in defaults (so a missing key never crashes the shell), and resolves
 * relative paths against the project root.
 *
 * The launcher (`start-shell.sh`) reads the same file, so the shell and its
 * starter never drift apart.
 *
 * ── Multi-user (Deepin / UOS) ────────────────────────────────────────────
 * On a machine where several OS users can launch the shell, the file shipped
 * next to the shell (e.g. `/opt/deepseek-harness-desktop/config.json`) is
 * GLOBAL and must stay read-only: if two users edited it they would clobber
 * each other, and on most installs only root can write under `/opt` anyway. So
 * every per-user tweak is layered on top from `~/.config/dsh-desktop/config.json`
 * (USER_CONFIG_PATH), which the shell itself also writes on first run. The
 * merge order is DEFAULTS < shipped < user, so the user file wins.
 *
 * @module config
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { writeConfigFile } from './config-file.js'

const here = dirname(fileURLToPath(import.meta.url))
export const APP_ROOT = join(here, '..')

/** Shipped, read-only default config living next to the shell (e.g. /opt/.../config.json). */
export const CONFIG_PATH = join(APP_ROOT, 'config.json')

/** Per-user override config. Always user-writable; the shell writes here on first run. */
export const USER_CONFIG_DIR = join(homedir(), '.config', 'dsh-desktop')
export const USER_CONFIG_PATH = join(USER_CONFIG_DIR, 'config.json')

/**
 * Whether this shell was started by the installed launcher rather than from a
 * source checkout.
 *
 * `app.isPackaged` cannot answer that here: the deb runs a bare
 * `electron .` over `/opt/deepseek-harness-desktop` (see `start-shell.sh`),
 * so Electron's `process.defaultApp` stays true and `app.isPackaged` stays
 * false in the very build users install. Anything gated on it — notably the
 * "Check for updates" dialog — therefore shows its development message in
 * production.
 *
 * The launcher exports `ELECTRON_USER_DATA` before exec'ing Electron
 * (`start-shell.sh`), and `orphan-reaper.js` already treats that variable as
 * the marker for a kernel this shell spawned. A source run
 * (`npm start` -> `electron .`) never sets it, which makes it an exact
 * stand-in for "installed".
 *
 * @returns {boolean} true when launched by the installed launcher.
 */
export function isInstalledLaunch() {
  return process.env.ELECTRON_USER_DATA !== undefined && process.env.ELECTRON_USER_DATA !== ''
}

const DEFAULTS = {
  launcher: {
    electron: '',
    systemDsh: '',
    nodeBinDir: '',
    userDataDir: '~/.local/share/dsh-desktop/data-shell',
    telemetryMode: 'DISABLED',
  },
  kernel: {
    homeSubdir: '~/.dsh',
    profile: 'web',
    noOpen: true,
    // 'auto' mirrors the official shell: use the native folder dialog, unless
    // Linux has neither zenity nor kdialog, in which case browse mode is used.
    // 'browse' and 'native' pin the choice for debugging.
    directoryPicker: 'auto',
    // How to behave when quitting might interrupt work. The official shell asks
    // its Host over a private channel; this shell has no such channel, so the
    // policy is declared rather than derived. 'ask-always' is the safe default.
    exitPolicy: 'ask-always',
  },
  supervisor: {
    maxRestartsInWindow: 5,
    restartWindowMs: 600_000,
    baseDelayMs: 2_000,
    maxDelayMs: 30_000,
    readinessTimeoutMs: 90_000,
  },
  renderer: {
    maxRecoveries: 3,
    recoveryWindowMs: 60_000,
  },
  // How long the loading page stays up after the kernel is ready, in ms, so
  // its log pane can actually be read. 0 disables the floor.
  splashMinMs: 3_000,
  tray: {
    summonAccelerator: 'CommandOrControl+Shift+Space',
    showBalance: false,
    rechargeUrl: 'https://platform.deepseek.com/top_up',
  },
  updates: {
    enabled: true,
    provider: 'github',
    owner: 'citrusli2026',
    repo: 'dsh-desktop',
    autoDownload: false,
  },
}

/**
 * Shallow-merges one object over another, section by section, so a user config
 * that only sets a few keys keeps the rest of the defaults.
 *
 * @param {Record<string, any>} base
 * @param {Record<string, any>} override
 * @returns {Record<string, any>}
 */
function mergeSection(base, override) {
  const out = { ...base }
  for (const key of Object.keys(override ?? {})) {
    if (typeof override[key] === 'object' && override[key] !== null && !Array.isArray(override[key])) {
      out[key] = mergeSection(base[key] ?? {}, override[key])
    } else {
      out[key] = override[key]
    }
  }
  return out
}

/**
 * Pure config builder: DEFAULTS < shipped < user. Exported so tests can drive it
 * without touching real filesystem paths.
 *
 * @param {Record<string, any>} [shipped]
 * @param {Record<string, any>} [user]
 * @returns {typeof DEFAULTS}
 */
export function buildConfig(shipped = {}, user = {}) {
  return /** @type {typeof DEFAULTS} */ (mergeSection(mergeSection(DEFAULTS, shipped), user))
}

/**
 * Reads and JSON-parses a config file, returning `{}` if it is absent or broken
 * (a broken user file must never crash the shell — it just gets ignored).
 *
 * @param {string} path
 * @returns {Record<string, any>}
 */
function loadJson(path) {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    console.warn(`config file could not be parsed, ignoring (${path}): ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

/** @type {ReturnType<typeof buildConfig> | null} */
let loaded = null

/** Test helper: drop the cached config so the next getConfig() re-reads files. */
export function resetConfigCache() {
  loaded = null
}

/**
 * Loads and caches the merged configuration (shipped + per-user override).
 *
 * @returns {ReturnType<typeof buildConfig>}
 */
export function getConfig() {
  if (loaded !== null) return loaded
  loaded = buildConfig(loadJson(CONFIG_PATH), loadJson(USER_CONFIG_PATH))
  return loaded
}

/**
 * Writes the merged per-user config to USER_CONFIG_PATH atomically, creating the
 * parent directory if needed. Used by the shell if it ever needs to persist a
 * user-level override (first-run path resolution is done by the shell scripts).
 *
 * @param {string} contents - JSON string to write
 * @returns {Promise<void>}
 */
export async function writeUserConfig(contents) {
  await mkdir(USER_CONFIG_DIR, { recursive: true })
  await writeConfigFile(USER_CONFIG_PATH, contents)
}

/**
 * Resolves a possibly-relative path against the project root.
 *
 * @param {string} path
 * @returns {string}
 */
export function resolveConfigPath(path) {
  if (isAbsolute(path)) return path
  return resolve(APP_ROOT, path)
}
