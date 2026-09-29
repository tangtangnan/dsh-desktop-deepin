/**
 * Tests for the directory-picker fallback decision.
 *
 * No Electron, no real filesystem: the existence check is injected.
 *
 * @module directory-picker.test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { join } from 'node:path'
import {
  LINUX_PICKER_HELPERS,
  detectNativeDirectoryPicker,
  shouldUseBrowsePicker,
  splitPathEntries,
} from './directory-picker.js'

/** @param {string[]} present @returns {(path: string) => boolean} */
const existsOnly = (present) => (path) => present.includes(path)

describe('splitPathEntries', () => {
  it('drops empty entries produced by a leading or trailing colon', () => {
    assert.deepEqual(splitPathEntries('/usr/bin:/bin'), ['/usr/bin', '/bin'])
    assert.deepEqual(splitPathEntries(':/usr/bin:'), ['/usr/bin'])
  })

  it('returns nothing for an empty PATH', () => {
    assert.deepEqual(splitPathEntries(''), [])
    assert.deepEqual(splitPathEntries(undefined), [])
  })
})

describe('detectNativeDirectoryPicker', () => {
  it('finds zenity on PATH', () => {
    const ok = detectNativeDirectoryPicker({
      platform: 'linux',
      pathEntries: ['/usr/bin'],
      exists: existsOnly([join('/usr/bin', 'zenity')]),
    })
    assert.equal(ok, true)
  })

  it('accepts kdialog when zenity is absent', () => {
    const ok = detectNativeDirectoryPicker({
      platform: 'linux',
      pathEntries: ['/usr/bin'],
      exists: existsOnly([join('/usr/bin', 'kdialog')]),
    })
    assert.equal(ok, true)
  })

  it('reports unusable when Linux has neither helper', () => {
    const ok = detectNativeDirectoryPicker({
      platform: 'linux',
      pathEntries: ['/usr/bin', '/bin'],
      exists: existsOnly([]),
    })
    assert.equal(ok, false)
  })

  it('never consults the helpers on Windows or macOS', () => {
    for (const platform of ['win32', 'darwin']) {
      const ok = detectNativeDirectoryPicker({
        platform,
        pathEntries: [],
        exists: existsOnly([]),
      })
      assert.equal(ok, true, `${platform} should not need an external helper`)
    }
  })

  it('looks for both helpers the shell documents', () => {
    assert.deepEqual([...LINUX_PICKER_HELPERS], ['zenity', 'kdialog'])
  })
})

describe('shouldUseBrowsePicker', () => {
  it('keeps the native dialog when Linux has zenity', () => {
    const browse = shouldUseBrowsePicker({
      platform: 'linux',
      pathValue: '/usr/bin:/bin',
      exists: existsOnly([join('/usr/bin', 'zenity')]),
    })
    assert.equal(browse, false)
  })

  it('falls back to browse mode when Linux has neither helper', () => {
    const browse = shouldUseBrowsePicker({
      platform: 'linux',
      pathValue: '/usr/bin:/bin',
      exists: existsOnly([]),
    })
    assert.equal(browse, true)
  })

  it('keeps the native dialog off Linux regardless of the helpers', () => {
    for (const platform of ['win32', 'darwin']) {
      const browse = shouldUseBrowsePicker({
        platform,
        pathValue: '',
        exists: existsOnly([]),
      })
      assert.equal(browse, false, `${platform} should keep the native dialog`)
    }
  })

  it('honours an explicit browse override', () => {
    const browse = shouldUseBrowsePicker({
      platform: 'linux',
      pathValue: '/usr/bin',
      mode: 'browse',
      exists: existsOnly([join('/usr/bin', 'zenity')]),
    })
    assert.equal(browse, true)
  })

  it('honours an explicit native override even without a helper', () => {
    const browse = shouldUseBrowsePicker({
      platform: 'linux',
      pathValue: '/usr/bin',
      mode: 'native',
      exists: existsOnly([]),
    })
    assert.equal(browse, false)
  })
})
