/**
 * Tests for crash-report naming, rendering and retention.
 *
 * @module diagnostics.test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { join } from 'node:path'
import {
  MAX_CRASH_REPORTS,
  MAX_OUTPUT_CHARS,
  crashLogDirectory,
  crashReportName,
  crashReportsToPrune,
  renderCrashReport,
} from './diagnostics.js'

describe('crashLogDirectory', () => {
  it('uses a logs directory under userData on Linux and Windows', () => {
    for (const platform of ['linux', 'win32']) {
      assert.equal(
        crashLogDirectory({ userData: '/home/u/.config/app', platform }),
        join('/home/u/.config/app', 'logs'),
        platform,
      )
    }
  })

  it('uses the system log directory on macOS', () => {
    assert.equal(
      crashLogDirectory({ userData: '/Users/u/Library/Application Support/app', platform: 'darwin' }),
      join('/Users/u/Library/Application Support/app', 'Logs'),
    )
  })
})

describe('crashReportName', () => {
  it('names the report with a UTC timestamp and the source', () => {
    const name = crashReportName('host', new Date('2026-09-29T08:30:00.000Z'))
    assert.equal(name, 'crash-2026-09-29T08-30-00-000Z-host.log')
  })

  it('produces a filename Windows accepts — no colons', () => {
    const name = crashReportName('renderer')
    assert.equal(name.includes(':'), false)
  })

  it('sorts chronologically, so pruning needs no parsing', () => {
    const older = crashReportName('host', new Date('2026-01-01T00:00:00.000Z'))
    const newer = crashReportName('host', new Date('2026-12-31T00:00:00.000Z'))
    assert.ok(older < newer)
  })
})

describe('renderCrashReport', () => {
  it('records the facts the official shell records', () => {
    const body = renderCrashReport({
      source: 'host',
      appVersion: '0.1.2',
      kernelVersion: '0.1.7-alpha.2',
      ready: true,
      message: 'kernel exited',
      output: 'line one',
      when: new Date('2026-09-29T00:00:00.000Z'),
    })
    assert.match(body, /source:\s+host/)
    assert.match(body, /app:\s+0\.1\.2/)
    assert.match(body, /kernel:\s+0\.1\.7-alpha\.2/)
    assert.match(body, /ready:\s+true/)
    assert.match(body, /kernel exited/)
    assert.match(body, /line one/)
  })

  it('bounds the captured output, keeping the most recent part', () => {
    const body = renderCrashReport({
      source: 'host',
      appVersion: '0.1.2',
      output: 'a'.repeat(MAX_OUTPUT_CHARS + 500),
    })
    assert.match(body, /\[truncated: 500 earlier characters dropped\]/)
  })

  it('leaves short output untouched', () => {
    const body = renderCrashReport({ source: 'main', appVersion: '0.1.2', output: 'small' })
    assert.equal(body.includes('truncated'), false)
    assert.match(body, /small/)
  })
})

describe('crashReportsToPrune', () => {
  it('keeps nothing when there is nothing to prune', () => {
    assert.deepEqual(crashReportsToPrune([]), [])
    assert.deepEqual(crashReportsToPrune(['crash-a.log', 'crash-b.log']), [])
  })

  it('deletes the oldest once the cap is exceeded', () => {
    const names = Array.from({ length: MAX_CRASH_REPORTS + 3 }, (_unused, index) =>
      `crash-${String(index).padStart(4, '0')}.log`,
    )
    const prune = crashReportsToPrune(names)
    assert.equal(prune.length, 3)
    assert.deepEqual(prune, names.slice(0, 3))
  })

  it('leaves exactly the cap behind', () => {
    const names = Array.from({ length: MAX_CRASH_REPORTS + 5 }, (_unused, index) =>
      `crash-${String(index).padStart(4, '0')}.log`,
    )
    const remaining = names.filter((name) => !crashReportsToPrune(names).includes(name))
    assert.equal(remaining.length, MAX_CRASH_REPORTS)
  })
})
