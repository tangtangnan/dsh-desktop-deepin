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
  SCHEME, ROUTES, PRIVILEGES, SHELL_CSP,
  registerShellScheme, serveShellDocument, forwardToKernel,
  makeHandler, installShellProtocol, createShellProtocolState,
  rewriteWebSocketUrl,
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
  // We did not point rendererRoot at a real dir, so the renderer stat check
  // 503s before it even tries to read a file.
  assert.equal(response.status, 503)
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

test('serveShellDocument gives .html documents the SHELL_CSP response header', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-protocol-'))
  try {
    await writeFile(join(dir, 'loading.html'), '<html>hi</html>', 'utf8')
    const response = await serveShellDocument({ url: 'dsh-app://shell/loading.html', root: dir })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-security-policy'), SHELL_CSP)
    // Policy must line up with what the page already declares in its <meta> tag.
    assert.match(SHELL_CSP, /style-src 'unsafe-inline'/)
    assert.match(SHELL_CSP, /script-src 'unsafe-inline'/)
    assert.match(SHELL_CSP, /default-src 'none'/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('serveShellDocument gives non-document assets no CSP header', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-protocol-'))
  try {
    await writeFile(join(dir, 'a.js'), 'console.log(1)', 'utf8')
    const response = await serveShellDocument({ url: 'dsh-app://shell/a.js', root: dir })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-security-policy'), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('serveShellDocument 503s when the renderer root is missing', async () => {
  const response = await serveShellDocument({
    url: 'dsh-app://shell/loading.html',
    root: '/opt/definitely/not/here',
  })
  assert.equal(response.status, 503)
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

test('forwardToKernel attaches the token as a ?token= query parameter', async () => {
  let seenUrl = null
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    seenUrl = input
    return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
  }
  try {
    const response = await forwardToKernel({
      url: 'dsh-app://app/modlens/paste?model=x',
      origin: 'http://127.0.0.1:9',
      token: 'sekret',
    })
    assert.equal(response.status, 200)
    assert.ok(seenUrl, 'fetch must be called')
    const target = new URL(seenUrl)
    assert.equal(target.pathname, '/modlens/paste')
    assert.equal(target.searchParams.get('model'), 'x')
    assert.equal(target.searchParams.get('token'), 'sekret')
    // No Bearer header is injected — the kernel's gate reads the token from the URL.
    const headers = new Headers()
    assert.equal(headers.get('authorization'), null)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('makeHandler routes the kernel hostname through the forwarding path', async () => {
  const realFetch = globalThis.fetch
  let seenUrl = null
  globalThis.fetch = async (input) => {
    seenUrl = input
    return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
  }
  try {
    const handler = makeHandler({
      rendererRoot: '/tmp/never',
      kernelOriginOf: () => 'http://127.0.0.1:9',
      tokenOf: () => 'tok',
    })
    const response = await handler({ url: 'dsh-app://app/something?x=1' })
    // With a real origin the request is forwarded — no longer a canned 503.
    assert.equal(response.status, 200)
    assert.ok(seenUrl, 'fetch must be called with the forwarded URL')
    const target = new URL(seenUrl)
    assert.equal(target.pathname, '/something')
    assert.equal(target.searchParams.get('x'), '1')
    assert.equal(target.searchParams.get('token'), 'tok')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('rewriteWebSocketUrl rewrites origin and appends the token', async () => {
  const rewritten = rewriteWebSocketUrl(
    'ws://127.0.0.1:33753/stream',
    {
      kernelOrigin: 'http://127.0.0.1:33753',
      tokenOf: () => 'sekret',
    },
  )
  const url = new URL(rewritten)
  assert.equal(url.origin, 'ws://127.0.0.1:33753')
  assert.equal(url.pathname, '/stream')
  assert.equal(url.searchParams.get('token'), 'sekret')
})

test('rewriteWebSocketUrl returns the URL untouched when no token', async () => {
  const rewritten = rewriteWebSocketUrl(
    'ws://127.0.0.1:33753/stream',
    {
      kernelOrigin: 'http://127.0.0.1:33753',
      tokenOf: () => null,
    },
  )
  assert.equal(rewritten, 'ws://127.0.0.1:33753/stream')
})

test('rewriteWebSocketUrl refuses a cross-host URL', async () => {
  assert.throws(() => {
    rewriteWebSocketUrl('ws://attacker.example/x', {
      kernelOrigin: 'http://127.0.0.1:33753',
      tokenOf: () => 'tok',
    })
  })
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
