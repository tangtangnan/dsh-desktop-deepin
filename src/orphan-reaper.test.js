/**
 * Tests for the orphan reaper: attribution of kernel-family processes via the
 * marker environment variable, classification of orphans, and the signal
 * policy (never a kernel, never the young).
 *
 * @module orphan-reaper.test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
/**
 * @typedef {import('./orphan-reaper.js').Member} Member
 * @typedef {import('./orphan-reaper.js').ProcIo} ProcIo
 */
import {
  MARKER_ENV,
  buildReapPlan,
  collectMarkedMembers,
  familyMarkerEnv,
  looksLikeKernel,
  markerValueFor,
  parseStat,
  reapOrphans,
} from './orphan-reaper.js'

const USER_DATA = '/home/wangke/.local/share/dsh-desktop/data-shell'
const KERNEL_SIG = ['node', '/usr/local/nodejs/bin/dsh', '--profile', 'web', '--port', '37207']

/**
 * Builds an environ buffer the way /proc exposes one: NUL-separated entries.
 *
 * @param {Record<string, string>} env
 * @returns {Buffer}
 */
function envBuf(env) {
  return Buffer.from(
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\0'),
    'utf8',
  )
}

/**
 * @param {string[]} parts
 * @returns {Buffer}
 */
function cmdlineBuf(parts) {
  return Buffer.from(parts.join('\0'), 'utf8')
}

/**
 * Builds a /proc/<pid>/stat body: comm containing spaces, then post-`)`
 * tokens (state at token 0, ppid at token 1, starttime at token 19).
 *
 * @param {number} pid
 * @param {number} ppid
 * @param {number} startTicks
 * @returns {string}
 */
function statFor(pid, ppid, startTicks) {
  const tokens = new Array(40).fill('0')
  tokens[0] = 'S'
  tokens[1] = String(ppid)
  tokens[19] = String(startTicks)
  return `${String(pid)} (some com mand) ${tokens.join(' ')}`
}

describe('familyMarkerEnv / markerValueFor', () => {
  it('injects the userData path when the parent carries no marker', () => {
    assert.deepEqual(familyMarkerEnv({}, USER_DATA), { [MARKER_ENV]: USER_DATA })
    assert.equal(markerValueFor({}, USER_DATA), USER_DATA)
  })

  it('keeps a launcher-provided value instead of overwriting it', () => {
    const parent = { [MARKER_ENV]: USER_DATA }
    assert.deepEqual(familyMarkerEnv(parent, '/somewhere/else'), {})
    assert.equal(markerValueFor(parent, '/somewhere/else'), USER_DATA)
  })

  it('treats an empty inherited value as absent', () => {
    assert.deepEqual(familyMarkerEnv({ [MARKER_ENV]: '' }, USER_DATA), {
      [MARKER_ENV]: USER_DATA,
    })
  })
})

describe('looksLikeKernel', () => {
  it('matches the buildKernelArgs signature', () => {
    assert.equal(looksLikeKernel(KERNEL_SIG), true)
  })

  it('rejects npm exec chains and servers without both flags', () => {
    assert.equal(looksLikeKernel(['npm', 'exec', '@zhiweixu/excel-mcp-server']), false)
    assert.equal(
      looksLikeKernel(['node', '/home/wangke/.npm/_npx/x/node_modules/.bin/excel-mcp-server']),
      false,
    )
    assert.equal(looksLikeKernel(undefined), false)
  })

  it('rejects a command line that only sets the port', () => {
    assert.equal(looksLikeKernel(['node', 'server.js', '--port', '8080']), false)
  })
})

describe('parseStat', () => {
  it('reads ppid and starttime after a comm field containing spaces', () => {
    // Fields after ')': state(3) ppid(4) ... starttime(22). Token k = field k+2.
    const tokens = new Array(50).fill(1)
    tokens[0] = 'S' // field 3, state
    tokens[1] = '1234' // field 4, ppid
    tokens[19] = '98765' // field 22, starttime
    const stat = `42 (some com mand) ${tokens.join(' ')}`
    assert.deepEqual(parseStat(stat), { ppid: 1234, startTimeTicks: 98765 })
  })

  it('returns null for a malformed line', () => {
    assert.equal(parseStat('no parens here'), null)
  })
})

describe('buildReapPlan', () => {
  const kernel = { pid: 100, ppid: 1, cmdline: KERNEL_SIG }
  const npm = { pid: 200, ppid: 100, cmdline: ['npm', 'exec', 'excel-mcp-server'] }
  const sh = { pid: 201, ppid: 200, cmdline: ['sh', '-c', 'excel-mcp-server'] }
  const server = { pid: 202, ppid: 201, cmdline: ['node', 'excel-mcp-server'] }

  it('spares the whole tree of a live trusted kernel', () => {
    const plan = buildReapPlan([kernel, npm, sh, server], 100)
    assert.deepEqual(plan.doomed, [])
    assert.deepEqual(plan.protectedPids, [100, 200, 201, 202])
  })

  it('dooms a tree whose kernel is gone (chain tops at a vanished pid)', () => {
    // The dead kernel's pid is no longer a member: the chain re-parented.
    const orphanNpm = { pid: 200, ppid: 100, cmdline: npm.cmdline }
    const plan = buildReapPlan([orphanNpm, sh, server], null)
    assert.deepEqual(plan.doomed, [200, 201, 202])
    assert.deepEqual(plan.protectedPids, [])
  })

  it('spares a second shell window whose kernel is alive but untrusted', () => {
    const otherKernel = { pid: 300, ppid: 1, cmdline: KERNEL_SIG }
    const otherNpm = { pid: 301, ppid: 300, cmdline: npm.cmdline }
    const plan = buildReapPlan([kernel, otherKernel, otherNpm], 100)
    assert.deepEqual(plan.doomed, [])
    assert.deepEqual(plan.protectedPids, [100, 300, 301])
  })

  it('spares any member that itself looks like a kernel, even unsupervised', () => {
    // The market helper's replacement kernel: its parent is gone, but it must
    // survive the sweep — only the servants are collected.
    const replacement = { pid: 400, ppid: 1, cmdline: KERNEL_SIG }
    const plan = buildReapPlan([replacement], null)
    assert.deepEqual(plan.doomed, [])
    assert.deepEqual(plan.protectedPids, [400])
  })

  it('reaps an orphaned npm chain whose root is init', () => {
    const orphan = { pid: 500, ppid: 1, cmdline: ['npm', 'exec', 'excel-mcp-server'] }
    const child = { pid: 501, ppid: 500, cmdline: ['node', 'excel-mcp-server'] }
    const plan = buildReapPlan([orphan, child], null)
    assert.deepEqual(plan.doomed, [500, 501])
  })

  it('never dooms a young member, even inside an orphan chain', () => {
    const orphan = { pid: 500, ppid: 1, cmdline: ['npm', 'exec', 'excel'] }
    const newborn = { pid: 501, ppid: 500, young: true }
    const plan = buildReapPlan([orphan, newborn], null)
    assert.deepEqual(plan.doomed, [500])
    assert.deepEqual(plan.young, [501])
  })

  it('protects the trusted kernel even if its cmdline is unreadable', () => {
    const bare = { pid: 100, ppid: 1 }
    const child = { pid: 101, ppid: 100 }
    const plan = buildReapPlan([bare, child], 100)
    assert.deepEqual(plan.doomed, [])
    assert.deepEqual(plan.protectedPids, [100, 101])
  })

  it('tolerates a corrupted parent cycle without hanging', () => {
    const a = { pid: 600, ppid: 601, cmdline: ['a'] }
    const b = { pid: 601, ppid: 600, cmdline: ['b'] }
    const plan = buildReapPlan([a, b], null)
    // Neither tops out at a live kernel: both are doomed, and the call returns.
    assert.deepEqual(plan.doomed, [600, 601])
  })
})

describe('collectMarkedMembers', () => {
  /**
   * @param {object} options
   * @param {number[]} options.pids
   * @param {Record<string, Record<string, string>>} options.envs
   * @param {Record<string, string>} options.stats
   * @param {Record<string, string[]>} options.cmdlines
   * @param {number} [options.uptime]
   * @returns {import('./orphan-reaper.js').ProcIo}
   */
  function fakeIo({ pids, envs, stats, cmdlines, uptime = 1000 }) {
    return {
      readdir: async () => pids.map(String),
      readEnviron: async (pid) => envBuf(envs[String(pid)] ?? {}),
      readStat: async (pid) => stats[String(pid)] ?? '',
      readCmdline: async (pid) => cmdlineBuf(cmdlines[String(pid)] ?? []),
      readUptime: async () => uptime,
    }
  }

  it('collects only processes carrying the exact marker key AND value', async () => {
    // A different ELECTRON_USER_DATA value belongs to another OS user's shell
    // family: the entry must not match — that is the per-user isolation.
    const io = fakeIo({
      pids: [10, 11, 12, 13],
      envs: {
        10: { [MARKER_ENV]: USER_DATA, HOME: '/home/wangke' },
        11: { [MARKER_ENV]: '/other/user/.local/share/dsh-desktop/data-shell' },
        12: { HOME: '/home/wangke' },
        13: { [MARKER_ENV]: USER_DATA },
      },
      stats: {
        10: statFor(10, 1, 500000),
        11: statFor(11, 1, 500000),
        13: statFor(13, 1, 500000),
      },
      cmdlines: { 10: ['npm'], 11: ['npm'], 13: ['npm'] },
    })
    const members = await collectMarkedMembers({
      marker: USER_DATA,
      uptimeSeconds: 1000,
      youngMs: 2000,
      io,
    })
    assert.deepEqual(
      members.map((m) => m.pid).sort((a, b) => a - b),
      [10, 13],
    )
  })

  it('flags processes younger than youngMs as young', async () => {
    // starttime ticks such that age is 0.5s with CLK_TCK=100 and uptime 1000.
    const io = fakeIo({
      pids: [10],
      envs: { 10: { [MARKER_ENV]: USER_DATA } },
      stats: { 10: statFor(10, 1, 99950) },
      cmdlines: { 10: ['npm'] },
    })
    const members = await collectMarkedMembers({
      marker: USER_DATA,
      uptimeSeconds: 1000,
      youngMs: 2000,
      io,
    })
    assert.equal(/** @type {Member} */ (members[0]).young, true)
  })

  it('flags a member whose stat is unreadable as young, never old', async () => {
    const io = fakeIo({
      pids: [10],
      envs: { [Symbol.iterator]: undefined, 10: { [MARKER_ENV]: USER_DATA } },
      stats: {},
      cmdlines: { 10: ['npm'] },
    })
    const members = await collectMarkedMembers({
      marker: USER_DATA,
      uptimeSeconds: 1000,
      youngMs: 2000,
      io,
    })
    assert.equal(/** @type {Member} */ (members[0]).young, true)
    assert.equal(/** @type {Member} */ (members[0]).ppid, 0)
  })
})

describe('reapOrphans', () => {
  it('is a no-op on windows', async () => {
    const result = await reapOrphans({ marker: USER_DATA, platform: 'win32' })
    assert.equal(result.skipped, 'windows')
    assert.deepEqual(result.doomed, [])
  })

  it('skips cleanly when no marked processes exist', async () => {
    /** @type {any} */
    const io = {
      readdir: async () => ['1', '2', '3'],
      readEnviron: async () => envBuf({ HOME: '/home/wangke' }),
      readStat: async () => '1 (init) S 0 0 0 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0',
      readCmdline: async () => cmdlineBuf(['init']),
      readUptime: async () => 1000,
    }
    const result = await reapOrphans({ marker: USER_DATA, io, platform: 'linux' })
    assert.equal(result.skipped, 'no-marked-processes')
  })

  it('kills an orphan chain and reports a clean sweep', async () => {
    // A fully self-contained fake process world: the mock owns every probe for
    // the fake pids and must never fall through to the real process table,
    // where these numbers may belong to unrelated live processes.
    /** @type {Set<number>} */
    const alive = new Set([500, 501])
    /** @type {ProcIo} */
    const io = {
      readdir: async () => [...alive].map(String),
      readEnviron: async (pid) => {
        if (!alive.has(pid)) throw new Error('ENOENT')
        return envBuf({ [MARKER_ENV]: USER_DATA })
      },
      readStat: async (pid) => statFor(pid, 1, 1000),
      readCmdline: async () => cmdlineBuf(['npm', 'exec', 'excel']),
      readUptime: async () => 1000,
    }
    const originalKill = process.kill
    /** @type {typeof process.kill} */
    const fakeKill = (pid, signal) => {
      if (!alive.has(pid)) {
        /** @type {any} */
        const error = new Error('ESRCH')
        error.code = 'ESRCH'
        throw error
      }
      if (signal === 'SIGTERM' || signal === 'SIGKILL') alive.delete(pid)
      return true
    }
    process.kill = fakeKill
    try {
      const result = await reapOrphans({ marker: USER_DATA, io, graceMs: 100 })
      assert.deepEqual(result.doomed.sort((a, b) => a - b), [500, 501])
      assert.deepEqual(result.killed, [])
      assert.deepEqual(result.survived, [])
      assert.equal(result.skipped, null)
    } finally {
      process.kill = originalKill
    }
  })

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    /** @type {Set<number>} */
    const alive = new Set([600])
    /** @type {ProcIo} */
    const io = {
      readdir: async () => [...alive].map(String),
      readEnviron: async (pid) => {
        if (!alive.has(pid)) throw new Error('ENOENT')
        return envBuf({ [MARKER_ENV]: USER_DATA })
      },
      readStat: async (pid) => statFor(pid, 1, 1000),
      readCmdline: async () => cmdlineBuf(['node', 'excel-mcp-server']),
      readUptime: async () => 1000,
    }
    const originalKill = process.kill
    /** @type {typeof process.kill} */
    const fakeKill = (pid, signal) => {
      if (!alive.has(pid)) {
        /** @type {any} */
        const error = new Error('ESRCH')
        error.code = 'ESRCH'
        throw error
      }
      // A stubborn server: SIGTERM does nothing, SIGKILL lands.
      if (signal === 'SIGKILL') alive.delete(pid)
      return true
    }
    process.kill = fakeKill
    try {
      const result = await reapOrphans({ marker: USER_DATA, io, graceMs: 100 })
      assert.deepEqual(result.doomed, [600])
      assert.deepEqual(result.killed, [600])
      assert.deepEqual(result.survived, [])
    } finally {
      process.kill = originalKill
    }
  })

  it('returns the error report instead of throwing when the walk explodes', async () => {
    // readdir failures are already downgraded to an empty member list inside
    // collectMarkedMembers; the error path guards everything around it.
    /** @type {any} */
    const io = {
      readdir: async () => ['10'],
      readEnviron: async () => envBuf({}),
      readStat: async () => '',
      readCmdline: async () => cmdlineBuf([]),
      readUptime: async () => {
        throw new Error('EIO')
      },
    }
    const result = await reapOrphans({ marker: USER_DATA, io })
    assert.equal(result.skipped, 'error')
  })
})
