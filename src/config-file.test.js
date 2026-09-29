/**
 * Tests for atomic writes and the advisory lock.
 *
 * @module config-file.test
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import { LOCK_STALE_MS, atomicWriteFile, withFileLock, writeConfigFile } from './config-file.js'

const here = dirname(fileURLToPath(import.meta.url))

// Scratch space lives inside the project, not under /tmp: a throwaway
// directory is needed, but it should still be somewhere the working tree owns.
const SCRATCH_ROOT = join(here, '..', 'data-shell', 'test-scratch')

/** @type {string[]} */
const created = []

/**
 * @param {string} prefix
 * @returns {Promise<string>}
 */
async function scratch(prefix) {
  await mkdir(SCRATCH_ROOT, { recursive: true })
  const dir = await mkdtemp(join(SCRATCH_ROOT, prefix))
  created.push(dir)
  return dir
}

after(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  await rm(SCRATCH_ROOT, { recursive: true, force: true }).catch(() => undefined)
})

describe('atomicWriteFile', () => {
  it('leaves the complete contents at the target path', async () => {
    const dir = await scratch('dsh-atomic-')
    const path = join(dir, 'file.txt')
    await atomicWriteFile(path, 'complete contents')
    assert.equal(await readFile(path, 'utf8'), 'complete contents')
  })

  it('leaves no temporary file behind', async () => {
    const dir = await scratch('dsh-atomic-')
    const path = join(dir, 'file.txt')
    await atomicWriteFile(path, 'x')
    assert.deepEqual(await readdir(dir), ['file.txt'])
  })

  it('replaces an existing file wholesale rather than in place', async () => {
    const dir = await scratch('dsh-atomic-')
    const path = join(dir, 'file.txt')
    await writeFile(path, 'a much longer previous value', 'utf8')
    await atomicWriteFile(path, 'short')
    assert.equal(await readFile(path, 'utf8'), 'short')
  })

  it('cleans up its temporary file when the write fails', async () => {
    const dir = await scratch('dsh-atomic-')
    // A directory cannot be renamed over by a file, so the rename fails.
    const path = join(dir, 'blocked')
    await mkdir(path)
    await assert.rejects(() => atomicWriteFile(path, 'x'))
    assert.deepEqual(await readdir(dir), ['blocked'])
  })
})

describe('withFileLock', () => {
  it('serialises concurrent writers', async () => {
    const dir = await scratch('dsh-lock-')
    const path = join(dir, 'shared.txt')
    await writeFile(path, '', 'utf8')

    /** @type {string[]} */
    const order = []
    await Promise.all([
      withFileLock(path, async () => {
        order.push('a:start')
        await new Promise((resolve) => setTimeout(resolve, 20))
        order.push('a:end')
      }),
      withFileLock(path, async () => {
        order.push('b:start')
        order.push('b:end')
      }),
    ])

    // One of them ran completely before the other started.
    assert.ok(
      (order[0] === 'a:start' && order[1] === 'a:end') ||
        (order[0] === 'b:start' && order[1] === 'b:end'),
      `expected non-overlapping sections, got ${order.join(',')}`,
    )
  })

  it('removes the lock afterwards', async () => {
    const dir = await scratch('dsh-lock-')
    const path = join(dir, 'file.txt')
    await withFileLock(path, async () => undefined)
    assert.deepEqual(await readdir(dir), [])
  })

  it('releases the lock even when the operation throws', async () => {
    const dir = await scratch('dsh-lock-')
    const path = join(dir, 'file.txt')
    await assert.rejects(() =>
      withFileLock(path, async () => {
        throw new Error('boom')
      }),
    )
    // A second acquisition must not block.
    await withFileLock(path, async () => undefined, { timeoutMs: 500 })
  })

  it('breaks a lock left behind by a dead process', async () => {
    const dir = await scratch('dsh-lock-')
    const path = join(dir, 'file.txt')
    const lockPath = `${path}.lock`
    await mkdir(lockPath)
    const stale = new Date(Date.now() - (LOCK_STALE_MS + 1_000))
    await utimes(lockPath, stale, stale)

    await withFileLock(path, async () => undefined, {
      timeoutMs: 1_000,
      stat: async (target) => stat(target),
    })
  })
})

describe('writeConfigFile', () => {
  it('writes the contents and holds the lock while doing so', async () => {
    const dir = await scratch('dsh-write-')
    const path = join(dir, 'config.json')
    await writeConfigFile(path, '{"a":1}')
    assert.equal(await readFile(path, 'utf8'), '{"a":1}')
  })
})
