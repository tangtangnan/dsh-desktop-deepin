import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildConfig, resetConfigCache, getConfig, isInstalledLaunch } from './config.js'

test('buildConfig: defaults win when nothing is provided', () => {
  const cfg = buildConfig()
  assert.equal(cfg.launcher.userDataDir, '~/.local/share/dsh-desktop/data-shell')
  assert.equal(cfg.kernel.homeSubdir, '~/.dsh')
  assert.equal(cfg.updates.owner, 'citrusli2026')
})

test('buildConfig: shipped overrides defaults', () => {
  const cfg = buildConfig({ kernel: { homeSubdir: '/data/shared/.dsh' } })
  assert.equal(cfg.kernel.homeSubdir, '/data/shared/.dsh')
  // untouched sections keep their defaults
  assert.equal(cfg.kernel.profile, 'web')
})

test('buildConfig: user overrides shipped (multi-user layering)', () => {
  const cfg = buildConfig(
    { kernel: { homeSubdir: '/data/shared/.dsh' }, launcher: { electron: '/opt/electron' } },
    { kernel: { homeSubdir: '/home/alice/.dsh' } },
  )
  // user file wins over the shipped global file
  assert.equal(cfg.kernel.homeSubdir, '/home/alice/.dsh')
  // keys only in shipped remain
  assert.equal(cfg.launcher.electron, '/opt/electron')
})

test('buildConfig: user only, partial keys keep defaults', () => {
  const cfg = buildConfig({}, { tray: { showBalance: true } })
  assert.equal(cfg.tray.showBalance, true)
  assert.equal(cfg.tray.summonAccelerator, 'CommandOrControl+Shift+Space')
})

test('getConfig reads shipped + user files and caches', async () => {
  // buildConfig is the pure core; getConfig layers the real DEFAULTS under it.
  // We exercise buildConfig through getConfig indirectly by resetting cache and
  // ensuring the returned shape is stable across calls.
  resetConfigCache()
  const a = getConfig()
  const b = getConfig()
  assert.equal(a, b, 'getConfig must return the cached object')
  assert.equal(typeof a.launcher.userDataDir, 'string')
})

test('isInstalledLaunch: true when the launcher exported its marker', () => {
  const saved = process.env.ELECTRON_USER_DATA
  try {
    process.env.ELECTRON_USER_DATA = '/home/alice/.local/share/dsh-desktop/data-shell'
    assert.equal(isInstalledLaunch(), true)
  } finally {
    restoreEnv('ELECTRON_USER_DATA', saved)
  }
})

test('isInstalledLaunch: false for a source run (npm start -> electron .)', () => {
  const saved = process.env.ELECTRON_USER_DATA
  try {
    delete process.env.ELECTRON_USER_DATA
    assert.equal(isInstalledLaunch(), false)
  } finally {
    restoreEnv('ELECTRON_USER_DATA', saved)
  }
})

test('isInstalledLaunch: empty marker counts as not installed', () => {
  const saved = process.env.ELECTRON_USER_DATA
  try {
    process.env.ELECTRON_USER_DATA = ''
    assert.equal(isInstalledLaunch(), false)
  } finally {
    restoreEnv('ELECTRON_USER_DATA', saved)
  }
})

/**
 * Restores an environment variable to its previous value, deleting it again if
 * it was not set. Keeps these tests from leaking into whatever runs after them.
 *
 * @param {string} key
 * @param {string | undefined} value
 * @returns {void}
 */
function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
