/**
 * Tests for the desktop-action allowlist and the state the page is told.
 *
 * @module desktop-commands.test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DESKTOP_ACTIONS,
  isDesktopAction,
  needsConfirmation,
  toDesktopState,
} from './desktop-commands.js'

describe('isDesktopAction', () => {
  it('accepts every declared action', () => {
    for (const action of Object.keys(DESKTOP_ACTIONS)) {
      assert.equal(isDesktopAction(action), true, String(action))
    }
  })

  it('refuses anything else', () => {
    for (const action of ['', 'quit-all', 'shell:notify', 'openExternal', null, 42, {}]) {
      assert.equal(isDesktopAction(action), false, `expected ${String(action)} refused`)
    }
  })

  it('refuses inherited object properties', () => {
    // Object.hasOwn, not `in`: otherwise a page could send "toString".
    assert.equal(isDesktopAction('toString'), false)
    assert.equal(isDesktopAction('constructor'), false)
  })
})

describe('needsConfirmation', () => {
  it('requires confirmation for quit, which stops the kernel', () => {
    assert.equal(needsConfirmation('quit'), true)
  })

  it('does not nag for the harmless actions', () => {
    const harmless = ['restart-kernel', 'check-updates', 'show-about', 'hide-window', 'toggle-safe-mode']
    for (const action of harmless) {
      assert.equal(needsConfirmation(/** @type {any} */ (action)), false, action)
    }
  })
})

describe('toDesktopState', () => {
  it('reports a ready kernel', () => {
    const state = toDesktopState({ kernelState: { phase: 'ready' } })
    assert.equal(state.phase, 'ready')
    assert.equal(state.busy, false)
  })

  it('reports a crashed kernel', () => {
    assert.equal(toDesktopState({ kernelState: { phase: 'crashed', attempts: 6 } }).phase, 'crashed')
  })

  it('collapses anything unknown to starting', () => {
    for (const phase of [undefined, 'nonsense', '']) {
      assert.equal(toDesktopState({ kernelState: /** @type {any} */ ({ phase }) }).phase, 'starting')
    }
  })

  it('handles no kernel state at all', () => {
    assert.deepEqual(toDesktopState(), { phase: 'starting', busy: false, launchAtLogin: false, safeMode: false })
  })

  it('passes through the retry delay the status line needs', () => {
    const state = toDesktopState({
      kernelState: { phase: 'starting', stage: 'retrying', retryDelayMs: 4000 },
    })
    assert.equal(state.stage, 'retrying')
    assert.equal(state.retryDelayMs, 4000)
  })

  it('never leaks a URL or a log line, even if one is on the state', () => {
    const state = toDesktopState({
      kernelState: /** @type {any} */ ({
        phase: 'ready',
        url: 'http://127.0.0.1:19387/?token=secret',
        logText: 'a secret line',
      }),
    })
    assert.deepEqual(Object.keys(state).sort(), ['busy', 'launchAtLogin', 'phase', 'safeMode'])
    assert.equal(JSON.stringify(state).includes('secret'), false)
  })
})
