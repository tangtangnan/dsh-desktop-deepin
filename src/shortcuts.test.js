/**
 * Tests for key-binding validation and delivery mode.
 *
 * @module shortcuts.test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_BINDINGS,
  RESERVED_ACCELERATORS,
  dispatchShortcut,
  domDispatchScript,
  resolveBindings,
  shortcutDeliveryMode,
  validateBindings,
} from './shortcuts.js'

describe('validateBindings', () => {
  it('accepts a known command with a binding', () => {
    const { accepted, rejected } = validateBindings({ 'window.reload': 'CmdOrCtrl+Shift+R' })
    assert.deepEqual(accepted, { 'window.reload': 'CmdOrCtrl+Shift+R' })
    assert.deepEqual(rejected, [])
  })

  it('rejects an unknown command rather than silently ignoring it', () => {
    const { accepted, rejected } = validateBindings({ 'window.explode': 'CmdOrCtrl+E' })
    assert.deepEqual(accepted, {})
    assert.equal(rejected.length, 1)
    assert.match(rejected[0], /unknown command/)
  })

  it('rejects a reserved accelerator', () => {
    const { accepted, rejected } = validateBindings({ 'window.reload': 'CmdOrCtrl+Q' })
    assert.deepEqual(accepted, {})
    assert.match(rejected[0], /reserved/)
  })

  it('rejects reserved accelerators case-insensitively', () => {
    const { accepted } = validateBindings({ 'window.reload': 'cmdorctrl+q' })
    assert.deepEqual(accepted, {})
  })

  it('rejects a non-string or empty binding', () => {
    for (const value of [42, '', '   ', null]) {
      const { accepted } = validateBindings({ 'window.reload': value })
      assert.deepEqual(accepted, {}, `expected ${String(value)} to be rejected`)
    }
  })

  it('trims surrounding whitespace', () => {
    const { accepted } = validateBindings({ 'window.reload': '  F5  ' })
    assert.deepEqual(accepted, { 'window.reload': 'F5' })
  })

  it('returns nothing for malformed input', () => {
    for (const input of [null, 'nope', 42, []]) {
      const { accepted, rejected } = validateBindings(input)
      assert.deepEqual(accepted, {})
      assert.deepEqual(rejected, [])
    }
  })

  it('keeps every reserved accelerator out of the defaults', () => {
    for (const binding of Object.values(DEFAULT_BINDINGS)) {
      assert.equal(
        RESERVED_ACCELERATORS.includes(binding),
        false,
        `${binding} should not be reserved`,
      )
    }
  })
})

describe('resolveBindings', () => {
  it('starts from the defaults', () => {
    assert.deepEqual(resolveBindings({}), { ...DEFAULT_BINDINGS })
  })

  it('lets an override win', () => {
    const resolved = resolveBindings({ 'window.reload': 'F5' })
    assert.equal(resolved['window.reload'], 'F5')
    assert.equal(resolved['window.close'], DEFAULT_BINDINGS['window.close'])
  })
})

describe('shortcutDeliveryMode', () => {
  it('dispatches through the DOM on Linux', () => {
    assert.equal(shortcutDeliveryMode({ platform: 'linux' }), 'dom')
  })

  it('intercepts before the page elsewhere', () => {
    for (const platform of ['win32', 'darwin']) {
      assert.equal(shortcutDeliveryMode({ platform }), 'intercept')
    }
  })
})

describe('domDispatchScript', () => {
  it('dispatches a named event carrying the command', () => {
    const script = domDispatchScript('window.reload')
    assert.match(script, /dsh:shortcut/)
    assert.match(script, /window\.reload/)
  })

  it('cannot be broken out of by a quote in the command', () => {
    const script = domDispatchScript('evil"}; alert(1); //')
    // The command is embedded as JSON, so the quote is escaped rather than
    // terminating the string literal.
    assert.match(script, /evil\\"/)
  })
})

describe('dispatchShortcut', () => {
  it('dispatches into the page on Linux', async () => {
    /** @type {string[]} */
    const seen = []
    await dispatchShortcut({
      command: 'window.reload',
      webContents: { isDestroyed: () => false },
      execute: async (script) => seen.push(script),
      mode: 'dom',
    })
    assert.equal(seen.length, 1)
    assert.match(seen[0], /window\.reload/)
  })

  it('does nothing when the page is gone', async () => {
    /** @type {string[]} */
    const seen = []
    await dispatchShortcut({
      command: 'window.reload',
      webContents: { isDestroyed: () => true },
      execute: async (script) => seen.push(script),
      mode: 'dom',
    })
    assert.equal(seen.length, 0)
  })

  it('does nothing in intercept mode — the platform handles it', async () => {
    /** @type {string[]} */
    const seen = []
    await dispatchShortcut({
      command: 'window.reload',
      webContents: { isDestroyed: () => false },
      execute: async (script) => seen.push(script),
      mode: 'intercept',
    })
    assert.equal(seen.length, 0)
  })
})
