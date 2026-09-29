/**
 * Atomic file writes backed by an advisory lock.
 *
 * The official shell has the same two primitives in its `config-file.ts`
 * (`atomicWriteFile`, `withFileLock`) and uses them for everything it writes
 * into the home or profile: a profile manifest, a patch overlay, a preferences
 * file. This shell writes two such files today (`shell.patch.yml` and the
 * profile manifest in `ensureShippedPlugins`) and used to write both with a
 * plain `writeFile`, which is not atomic: a crash or a full disk mid-write
 * leaves a truncated file where a complete one used to be, and the next launch
 * reads that.
 *
 * Atomicity is achieved by writing to a sibling temporary file and renaming it
 * over the target. `rename` is atomic within a filesystem, so a reader either
 * sees the old contents or the new ones, never a prefix of the new ones.
 *
 * The lock is advisory: it only coordinates writers that both call this
 * function. It is a `<target>.lock` directory created with `mkdir`, which is
 * atomic on every platform this shell targets — unlike `O_EXCL` file creation,
 * which behaves differently across network filesystems. A stale lock left by a
 * killed process is broken after a timeout, because a crash should not
 * permanently wedge configuration writes.
 *
 * @module config-file
 */

import { mkdir, rename, rm, stat as fsStat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * How long a lock may be held before it is considered stale.
 *
 * Every write this shell performs is a few kilobytes, so a genuinely held lock
 * lasts milliseconds. A minute is generous enough to never break a real
 * writer and short enough that a crashed process does not block writes for
 * long.
 *
 * @type {number}
 */
export const LOCK_STALE_MS = 60_000

/**
 * How often to retry while another process holds the lock.
 *
 * @type {number}
 */
const LOCK_RETRY_MS = 25

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  // Deliberately *not* unref'd. An unref'd timer does not keep the event loop
  // alive, so a caller waiting for a lock could have the process decide there
  // is nothing left to do and exit with the wait still pending — which is
  // exactly what happened under CI, where the timing differs from a developer
  // machine. Waiting for a lock is real work, not a background nicety.
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Writes `contents` to `path` atomically.
 *
 * @param {string} path - absolute path of the file to write
 * @param {string} contents
 * @returns {Promise<void>}
 */
export async function atomicWriteFile(path, contents) {
  // The temporary file must share the target's filesystem, or `rename` is not
  // atomic — hence a sibling rather than something under the OS temp
  // directory. The pid keeps two concurrent writers from choosing the same
  // name.
  const temporary = `${path}.${process.pid}.tmp`
  try {
    await writeFile(temporary, contents, 'utf8')
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Runs `operation` while holding an advisory lock on `path`.
 *
 * Concurrent writers using this function are serialised, so two launches
 * cannot interleave their writes into one file. A lock left by a dead process
 * is broken once it is older than `LOCK_STALE_MS`.
 *
 * @template T
 * @param {string} path - the file being written; the lock is a sibling of it
 * @param {() => Promise<T>} operation
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - how long to wait for the lock
 * @param {() => number} [options.now]
 * @param {(path: string) => Promise<{ mtimeMs: number }>} [options.stat]
 * @returns {Promise<T>}
 */
export async function withFileLock(
  path,
  operation,
  { timeoutMs = 5_000, now = () => Date.now(), stat = fsStat } = {},
) {
  const lockPath = `${path}.lock`
  const deadline = now() + timeoutMs

  for (;;) {
    try {
      await mkdir(lockPath)
    } catch (error) {
      // Someone else holds it. If it is old enough to be a leftover from a
      // process that died holding it, remove it and try again immediately.
      const stale = await isStale(lockPath, now, stat)
      if (!stale) {
        if (now() >= deadline) {
          throw new Error(`timed out waiting for the lock on ${path}`)
        }
        await delay(LOCK_RETRY_MS)
        continue
      }
      await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
      continue
    }

    try {
      return await operation()
    } finally {
      await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

/**
 * Whether a lock directory is old enough to have been abandoned.
 *
 * @param {string} lockPath
 * @param {() => number} now
 * @param {(path: string) => Promise<{ mtimeMs: number }>} [stat]
 * @returns {Promise<boolean>}
 */
async function isStale(lockPath, now, stat) {
  try {
    const info = await stat(lockPath)
    return now() - info.mtimeMs > LOCK_STALE_MS
  } catch {
    // The lock vanished between the failed mkdir and this check: treat it as
    // free rather than stale, so the caller retries immediately.
    return false
  }
}

/**
 * Writes a file atomically while holding its lock.
 *
 * This is what callers almost always want: it serialises concurrent writers
 * *and* makes each write atomic.
 *
 * @param {string} path
 * @param {string} contents
 * @returns {Promise<void>}
 */
export async function writeConfigFile(path, contents) {
  await withFileLock(path, async () => {
    await atomicWriteFile(path, contents)
  })
}
