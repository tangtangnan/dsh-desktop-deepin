/**
 * Tests for the exit-confirmation policy.
 *
 * @module exit-guard.test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { HOST_QUERY_TIMEOUT_MS, exitConfirmCopy, shouldConfirmExit } from './exit-guard.js'

describe('shouldConfirmExit', () => {
  it('always asks under ask-always, busy or not', () => {
    assert.equal(shouldConfirmExit({ policy: 'ask-always', busy: false }), true)
    assert.equal(shouldConfirmExit({ policy: 'ask-always', busy: true }), true)
  })

  it('never asks under never', () => {
    assert.equal(shouldConfirmExit({ policy: 'never', busy: true }), false)
    assert.equal(shouldConfirmExit({ policy: 'never', busy: false }), false)
  })

  it('asks only when busy under ask-if-busy', () => {
    assert.equal(shouldConfirmExit({ policy: 'ask-if-busy', busy: true }), true)
    assert.equal(shouldConfirmExit({ policy: 'ask-if-busy', busy: false }), false)
  })

  it('defaults to not busy, so an unset observation does not nag', () => {
    assert.equal(shouldConfirmExit({ policy: 'ask-if-busy' }), false)
  })

  it('asks by default, the safe choice when the answer is unknowable', () => {
    // An unknown policy must not silently quit: fall through to asking.
    assert.equal(shouldConfirmExit({ policy: /** @type {any} */ ('nonsense') }), true)
  })
})

describe('exitConfirmCopy', () => {
  it('names interrupting running tasks', () => {
    const copy = exitConfirmCopy({ busy: true })
    assert.match(copy.message, /正在运行的任务将会中断/)
  })

  it('mentions both risks when nothing specific is known', () => {
    const copy = exitConfirmCopy({ busy: false })
    assert.match(copy.message, /定时任务/)
    assert.match(copy.message, /正在运行的任务/)
  })

  it('always uses the product-name title', () => {
    assert.match(exitConfirmCopy().title, /DeepSeek Harness/)
  })
})

describe('HOST_QUERY_TIMEOUT_MS', () => {
  it('matches the two-second deadline the official shell uses', () => {
    assert.equal(HOST_QUERY_TIMEOUT_MS, 2_000)
  })
})
