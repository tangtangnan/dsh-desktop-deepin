import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_POLICY,
  decideRestart,
  exitsInWindow,
  nextRestartDelay,
  parseReadyUrl,
} from './restart-policy.js'

const {
  maxRestartsInWindow: MAX,
  restartWindowMs: WINDOW,
  baseDelayMs: BASE,
  maxDelayMs: CAP,
} = DEFAULT_POLICY

describe('parseReadyUrl', () => {
  it('extracts the URL from the kernel ready line', () => {
    const url = parseReadyUrl('dsh web: http://127.0.0.1:41235/?token=abc123_XYZ-9')
    assert.equal(url, 'http://127.0.0.1:41235/?token=abc123_XYZ-9')
  })

  it('extracts a bare URL with no token', () => {
    assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:41235/'), 'http://127.0.0.1:41235/')
  })

  it('returns null for lines that are not the ready line', () => {
    assert.equal(parseReadyUrl('kernel listening'), null)
    assert.equal(parseReadyUrl(''), null)
  })
})

describe('exitsInWindow', () => {
  it('drops exits older than the window', () => {
    const now = 1_000_000
    const recent = exitsInWindow([now - 1_000, now - WINDOW - 1], now, DEFAULT_POLICY)
    assert.deepEqual(recent, [now - 1_000])
  })

  it('keeps an exit exactly on the cutoff', () => {
    const now = 1_000_000
    const onCutoff = now - WINDOW
    assert.deepEqual(exitsInWindow([onCutoff], now, DEFAULT_POLICY), [onCutoff])
  })
})

describe('nextRestartDelay', () => {
  it('doubles the delay', () => {
    assert.equal(nextRestartDelay(BASE, DEFAULT_POLICY), 4_000)
  })

  it('caps at the maximum', () => {
    assert.equal(nextRestartDelay(CAP, DEFAULT_POLICY), CAP)
    assert.equal(nextRestartDelay(CAP * 10, DEFAULT_POLICY), CAP)
  })
})

describe('decideRestart', () => {
  it('restarts below the attempt cap', () => {
    const decision = decideRestart(1, BASE, DEFAULT_POLICY)
    assert.equal(decision.action, 'restart')
    assert.equal(decision.delay, 4_000)
  })

  it('gives up once the window is full', () => {
    const decision = decideRestart(MAX + 1, BASE, DEFAULT_POLICY)
    assert.equal(decision.action, 'gaveUp')
    assert.equal(decision.attempts, MAX + 1)
  })
})
