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

test('forwardToKernel resolves the kernel redirect itself instead of handing 303 to the renderer', async () => {
  // A pass-through forward used to return the kernel's 303 verbatim. The
  // renderer then received an empty body behind a redirect status, which
  // paints a black window — observed live, 80 such requests in one session.
  const realFetch = globalThis.fetch
  /** @type {URL[]} */
  const calls = []
  globalThis.fetch = async (input) => {
    calls.push(new URL(String(input)))
    if (calls.length === 1) {
      return new Response(null, {
        status: 303,
        headers: { location: './', 'set-cookie': 'dsh-auth-ticket=v1; Path=/; HttpOnly' },
      })
    }
    return new Response('<html>real page</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })
  }
  try {
    const response = await forwardToKernel({
      url: 'dsh-app://app/',
      origin: 'http://127.0.0.1:9',
      token: 'tok',
    })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /real page/)
    assert.equal(calls.length, 2, 'the redirect must be followed inside the main process')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('forwardToKernel drops the token once a ticket is held and sends the cookie instead', async () => {
  // Every 303 mints a *fresh* ticket for the same cookie name, and the kernel
  // treats a request that carries both `?token=` and no ticket as a fresh
  // unauthenticated visit — so re-sending the token on every hop answered 303
  // forever. The token belongs on the entry request only.
  const realFetch = globalThis.fetch
  /** @type {URL[]} */
  const calls = []
  globalThis.fetch = async (input) => {
    calls.push(new URL(String(input)))
    if (calls.length === 1) {
      return new Response(null, {
        status: 303,
        headers: { location: './', 'set-cookie': 'dsh-auth-ticket=v1; Path=/; HttpOnly' },
      })
    }
    return new Response('ok', { status: 200 })
  }
  /** @type {Map<string, string>} */
  const jar = new Map()
  try {
    const response = await forwardToKernel({
      url: 'dsh-app://app/',
      origin: 'http://127.0.0.1:9',
      token: 'tok',
      jar,
    })
    assert.equal(response.status, 200)
    assert.equal(calls.length, 2, 'the redirect must be followed inside the main process')
    assert.equal(calls[0]?.searchParams.get('token'), 'tok', 'the entry request carries the token')
    assert.equal(calls[1]?.searchParams.get('token'), null,
      'the follow-up must NOT re-send the token or the kernel loops forever')
    assert.equal(jar.get('dsh-auth-ticket'), 'v1', 'the ticket must be kept for later requests')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('forwardToKernel presents the held ticket instead of the token on later requests', async () => {
  const realFetch = globalThis.fetch
  /** @type {Array<{ url: URL, cookie: string | null }>} */
  const calls = []
  globalThis.fetch = async (input, options) => {
    calls.push({ url: new URL(String(input)), cookie: new Headers(options?.headers).get('cookie') })
    return new Response('ok', { status: 200 })
  }
  try {
    /** @type {Map<string, string>} */
    const jar = new Map([['dsh-auth-ticket', 'v1']])
    await forwardToKernel({
      url: 'dsh-app://app/api/status',
      origin: 'http://127.0.0.1:9',
      token: 'tok',
      jar,
    })
    assert.equal(calls[0]?.url.searchParams.get('token'), null,
      'with a ticket in hand the token is not needed')
    assert.equal(calls[0]?.cookie, 'dsh-auth-ticket=v1',
      'the shell holds the ticket on the renderer’s behalf and must send it')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('forwardToKernel replays the method, body and content headers of the original request', async () => {
  const realFetch = globalThis.fetch
  /** @type {{ init: RequestInit, target: unknown }[]} */
  const calls = []
  globalThis.fetch = async (input, options) => {
    calls.push({ init: options ?? {}, target: input })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const original = new Request('dsh-app://app/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    })
    await forwardToKernel({
      url: original.url,
      origin: 'http://127.0.0.1:9',
      token: 'tok',
      request: original,
    })
    assert.equal(calls.length, 1, 'fetch must be called')
    const call = calls[0]
    assert.equal(call?.init.method, 'POST', 'the kernel API serves POST routes; a hard-coded GET broke them')
    const sent = new Headers(call?.init.headers)
    assert.equal(sent.get('content-type'), 'application/json')
    // The token lives in the query string, never in a header.
    assert.equal(sent.get('authorization'), null)
    assert.equal(new URL(String(call?.target)).searchParams.get('token'), 'tok')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('forwardToKernel drops the renderer-side origin so the kernel origin check passes', async () => {
  const realFetch = globalThis.fetch
  /** @type {RequestInit[]} */
  const inits = []
  globalThis.fetch = async (_input, options) => {
    inits.push(options ?? {})
    return new Response('ok', { status: 200 })
  }
  try {
    const original = new Request('dsh-app://app/x', {
      headers: { origin: 'dsh-app://app', referer: 'dsh-app://app/', 'x-keep': 'yes' },
    })
    await forwardToKernel({
      url: original.url,
      origin: 'http://127.0.0.1:9',
      token: 'tok',
      request: original,
    })
    const sent = new Headers(inits[0]?.headers)
    assert.equal(sent.get('origin'), null, 'Origin describes the renderer hop, not the kernel hop')
    assert.equal(sent.get('referer'), null)
    assert.equal(sent.get('x-keep'), 'yes', 'application headers must survive')
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
    const response = await handler(new Request('dsh-app://app/something?x=1'))
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
    const response = await handler(new Request('dsh-app://shell/page.html'))
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
  const response = await handler(new Request('dsh-app://app/x'))
  assert.equal(response.status, 503)
})

test('makeHandler 404s unknown hostnames', async () => {
  const handler = makeHandler({
    rendererRoot: '/tmp/never',
    kernelOriginOf: () => 'http://127.0.0.1:9',
    tokenOf: () => 'tok',
  })
  const response = await handler(new Request('dsh-app://nope/x'))
  assert.equal(response.status, 404)
})

test('createShellProtocolState starts with a null origin and is mutable', () => {
  const state = createShellProtocolState()
  assert.equal(state.kernelOrigin, null)
  state.kernelOrigin = 'http://127.0.0.1:4321'
  assert.equal(state.kernelOrigin, 'http://127.0.0.1:4321')
})
