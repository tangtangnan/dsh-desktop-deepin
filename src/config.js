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
 * @module config
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const CONFIG_PATH = join(here, '..', 'config.json')
export const APP_ROOT = join(here, '..')

const DEFAULTS = {
  launcher: {
    electron: '',
    systemDsh: '',
    nodeBinDir: '',
    userDataDir: 'data-shell',
    telemetryMode: 'DISABLED',
  },
  kernel: {
    homeSubdir: 'kernel-home',
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

/** @type {typeof DEFAULTS | null} */
let loaded = null

/**
 * Loads and caches the merged configuration.
 *
 * @returns {typeof DEFAULTS}
 */
export function getConfig() {
  if (loaded !== null) return loaded
  let user = {}
  if (existsSync(CONFIG_PATH)) {
    try {
      user = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    } catch (error) {
      console.warn(`config.json could not be parsed, using defaults: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  loaded = /** @type {typeof DEFAULTS} */ (mergeSection(DEFAULTS, user))
  return loaded
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
