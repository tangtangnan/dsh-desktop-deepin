/**
 * Unit tests for the shell protocol module.
 *
 * @module shell-protocol.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SCHEME, ROUTES, PRIVILEGES,
  registerShellScheme, serveShellDocument, forwardToKernel,
  makeHandler, installShellProtocol, createShellProtocolState,
} from './shell-protocol.js'

test('scheme and route constants are frozen and as documented', () => {
  assert.equal(SCHEME.shell, 'dsh-app')
  assert.equal(ROUTES.shellDocs, 'shell')
  assert.equal(ROUTES.kernel, 'app')
  // Frozen: assigning should throw
  assert.throws(() => {
    /** @type {any} */ (SCHEME).shell = 'x'
  }, TypeError)
  assert.throws(() => {
    /** @type {any} */ (ROUTES).kernel = 'y'
  }, TypeError)
})

/** @type {Array<{ scheme: string, privileges: Record<string, boolean> }[]>} */
const registrations = []

/**
 * A fake Electron `protocol` module that records scheme registrations.
 * @type {{ registerSchemesAsPrivileged: (list: { scheme: string, privileges: Record<string, boolean> }[]) => void }}
 */
const fakeProtocol = {
  registerSchemesAsPrivileged: (list) => { registrations.push(list) },
}

test('registerShellScheme registers the privileged scheme', () => {
  registerShellScheme(/** @type {any} */ (fakeProtocol))
  assert.equal(registrations.length, 1)
  const entryList = registrations[0]
  assert.ok(entryList, 'a registration list should exist')
  const entry = entryList[0]
  assert.ok(entry, 'a registration entry should exist')
  assert.equal(entry.scheme, 'dsh-app')
  for (const key of Object.keys(PRIVILEGES)) {
    assert.equal(entry.privileges[key], true, `privilege ${key}`)
  }
})

/** @type {{ scheme?: string, fn?: (req: { url: string }) => Promise<Response> }} */
let handlerState = {}

/**
 * A fake Electron `protocol` module that records the `handle` call.
 * @type {{ handle: (scheme: string, fn: (req: { url: string }) => Promise<Response>) => Promise<void> }}
 */
const fakeHandler = {
  handle: async (scheme, fn) => { handlerState = { scheme, fn } },
}

test('installShellProtocol calls protocol.handle with a routing handler', async () => {
  installShellProtocol(/** @type {any} */ (fakeHandler), {
    rendererRoot: '/tmp/never',
    kernelOriginOf: () => null,
    tokenOf: () => 'tok',
  })
  assert.equal(handlerState.scheme, 'dsh-app')
  const fn = handlerState.fn
  assert.ok(fn, 'a handler should be registered')
  const response = await fn({ url: 'dsh-app://shell/x.html' })
  // We did not point rendererRoot at a real dir, so expect a 404, not a crash.
  assert.equal(response.status, 404)
})

test('serveShellDocument serves a static file under root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-protocol-'))
  try {
    await writeFile(join(dir, 'index.html'), '<html>hi</html>', 'utf8')
    const response = await serveShellDocument({ url: 'dsh-app://shell/', root: dir })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.equal(text, '<html>hi</html>')
    assert.match(response.headers.get('content-type') ?? '', /text\/html/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('serveShellDocument rejects path traversal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-protocol-'))
  try {
    const outside = await mkdtemp(join(tmpdir(), 'dsh-protocol-out-'))
    try {
      await writeFile(join(outside, 'secret.txt'), 'nope', 'utf8')
      const response = await serveShellDocument({
        url: 'dsh-app://shell/../secret.txt',
        root: dir,
      })
      // Traversal is caught either by 403 (guard) or by resolving outside root and 404.
      assert.ok(response.status === 403 || response.status === 404, `status ${response.status}`)
      assert.notEqual(await response.text(), 'nope')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('serveShellDocument 404s for a missing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-protocol-'))
  try {
    const response = await serveShellDocument({ url: 'dsh-app://shell/none.html', root: dir })
    assert.equal(response.status, 404)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('forwardToKernel 404s for non-app hostnames', async () => {
  const response = await forwardToKernel({
    url: 'dsh-app://shell/x.html',
    origin: 'http://127.0.0.1:9',
    token: 'tok',
  })
  assert.equal(response.status, 404)
})

test('forwardToKernel 503s without a token', async () => {
  const response = await forwardToKernel({
    url: 'dsh-app://app/x',
    origin: 'http://127.0.0.1:9',
    token: null,
  })
  assert.equal(response.status, 503)
})

test('makeHandler routes shell docs to the renderer root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-protocol-'))
  try {
    await writeFile(join(dir, 'page.html'), '<b>ok</b>', 'utf8')
    const handler = makeHandler({
      rendererRoot: dir,
      kernelOriginOf: () => 'http://127.0.0.1:9',
      tokenOf: () => null,
    })
    const response = await handler({ url: 'dsh-app://shell/page.html' })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), '<b>ok</b>')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('makeHandler 503s the kernel route when the origin is unknown', async () => {
  const handler = makeHandler({
    rendererRoot: '/tmp/never',
    kernelOriginOf: () => null,
    tokenOf: () => null,
  })
  const response = await handler({ url: 'dsh-app://app/x' })
  assert.equal(response.status, 503)
})

test('makeHandler 404s unknown hostnames', async () => {
  const handler = makeHandler({
    rendererRoot: '/tmp/never',
    kernelOriginOf: () => 'http://127.0.0.1:9',
    tokenOf: () => 'tok',
  })
  const response = await handler({ url: 'dsh-app://nope/x' })
  assert.equal(response.status, 404)
})

test('createShellProtocolState starts with a null origin and is mutable', () => {
  const state = createShellProtocolState()
  assert.equal(state.kernelOrigin, null)
  state.kernelOrigin = 'http://127.0.0.1:4321'
  assert.equal(state.kernelOrigin, 'http://127.0.0.1:4321')
})
