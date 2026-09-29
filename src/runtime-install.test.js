/**
 * Tests for runtime installation.
 *
 * No network and no filesystem: `fetch`, `exec`, and the home directory are all
 * injected.
 *
 * @module runtime-install.test
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { join } from 'node:path'
import {
  DEFAULT_ELECTRON_VERSION,
  DEFAULT_NODE_VERSION,
  archiveUrl,
  digestFromShasums,
  digestMatches,
  downloadTo,
  electronArchiveName,
  nodeArchiveName,
  runtimeDir,
} from './runtime-install.js'

/** @param {Buffer} bytes @returns {string} */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** @param {Record<string, string | Buffer>} routes */
function fetchOf(routes) {
  return async (/** @type {string} */ url) => {
    const body = routes[url]
    if (body === undefined) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    }
  }
}

describe('runtimeDir', () => {
  it('lives under the user home, not the checkout', () => {
    assert.equal(runtimeDir('/home/u'), join('/home/u', '.dsh-desktop', 'runtime'))
  })
})

describe('archiveUrl', () => {
  it('uses the China mirror first', () => {
    assert.match(archiveUrl('node', 'v24.19.0', 'node-v24.19.0-linux-x64.tar.gz'), /npmmirror\.com/)
  })

  it('builds the full path including the version directory', () => {
    const url = archiveUrl('electron', 'v33.3.0', 'electron-v33.3.0-linux-x64.zip')
    assert.ok(url.includes('/electron/v33.3.0/electron-v33.3.0-linux-x64.zip'))
  })

  it('can be pointed at the fallback mirror', () => {
    const second = archiveUrl('node', 'v24.19.0', 'x.tar.gz', 1)
    assert.ok(!second.includes('npmmirror'))
  })
})

describe('archive names', () => {
  it('names a Node tarball as nodejs.org does', () => {
    assert.equal(nodeArchiveName('v24.19.0', 'linux', 'x64'), 'node-v24.19.0-linux-x64.tar.gz')
  })

  it('names an Electron archive as GitHub releases do', () => {
    assert.equal(electronArchiveName('v33.3.0', 'linux', 'x64'), 'electron-v33.3.0-linux-x64.zip')
  })
})

describe('digestMatches', () => {
  it('accepts a correct digest, case-insensitively', () => {
    const bytes = Buffer.from('hello')
    assert.equal(digestMatches(bytes, sha256(bytes)), true)
    assert.equal(digestMatches(bytes, sha256(bytes).toUpperCase()), true)
  })

  it('rejects a wrong digest', () => {
    assert.equal(digestMatches(Buffer.from('hello'), 'a'.repeat(64)), false)
  })
})

describe('digestFromShasums', () => {
  const body = [
    'aaaa' + '0'.repeat(60) + '  node-v24.19.0-linux-x64.tar.gz',
    'bbbb' + '0'.repeat(60) + ' *node-v24.19.0-linux-arm64.tar.gz',
    '',
  ].join('\n')

  it('finds the line for the requested file', () => {
    assert.equal(digestFromShasums(body, 'node-v24.19.0-linux-x64.tar.gz'), 'aaaa' + '0'.repeat(60))
  })

  it('tolerates the asterisk binary-mode marker', () => {
    assert.equal(digestFromShasums(body, 'node-v24.19.0-linux-arm64.tar.gz'), 'bbbb' + '0'.repeat(60))
  })

  it('returns null when the file is not listed', () => {
    assert.equal(digestFromShasums(body, 'node-v99-linux-x64.tar.gz'), null)
  })
})

describe('downloadTo', () => {
  const fileName = 'node-v24.19.0-linux-x64.tar.gz'

  it('refuses a body whose checksum does not match', async () => {
    const url = archiveUrl('node', 'v24.19.0', fileName, 0)
    await assert.rejects(
      () =>
        downloadTo({
          kind: 'node',
          version: 'v24.19.0',
          fileName,
          destination: '/nowhere/x.tar.gz',
          expectedSha256: 'f'.repeat(64),
          fetchImpl: /** @type {any} */ (fetchOf({ [url]: 'payload' })),
        }),
      /could not download/,
    )
  })

  it('tries the next mirror after one fails', async () => {
    const good = archiveUrl('node', 'v24.19.0', fileName, 1)
    const body = 'payload'
    const seen = []
    await downloadTo({
      kind: 'node',
      version: 'v24.19.0',
      fileName,
      destination: '/nowhere/x.tar.gz',
      expectedSha256: sha256(Buffer.from(body)),
      fetchImpl: /** @type {any} */ (async (/** @type {string} */ url) => {
        seen.push(url)
        if (url === good) {
          const buffer = Buffer.from(body)
          return { ok: true, status: 200, arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) }
        }
        return { ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) }
      }),
    }).catch(() => undefined)
    assert.equal(seen.length, 2, 'both mirrors were attempted')
  })
})

describe('defaults', () => {
  it('pin versions that satisfy the kernel', () => {
    assert.match(DEFAULT_NODE_VERSION, /^v\d+\.\d+\.\d+$/)
    assert.match(DEFAULT_ELECTRON_VERSION, /^v\d+\.\d+\.\d+$/)
  })
})
