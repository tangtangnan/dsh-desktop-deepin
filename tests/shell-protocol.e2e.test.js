/**
 * End-to-end: spin up an in-process server that mimics the kernel's
 * authenticated web origin, then drive `makeHandler` against real `dsh-app://`
 * request objects and check the forwarded bodies.
 *
 * @module tests/shell-protocol.e2e
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeHandler, SCHEME } from '../src/shell-protocol.js'

/**
 * A tiny in-process server standing in for the kernel's web origin.
 * It requires the per-launch token as a `?token=` query parameter and returns
 * a JSON payload otherwise; it also serves a static route under `/static/`.
 *
 * @returns {Promise<{ origin: string, token: string, close: () => Promise<void> }>}
 */
async function startFakeKernel() {
  const TOKEN = 'e2e-token-' + Math.random().toString(36).slice(2)
  const server = createServer((req, res) => {
    const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
    const token = query.get('token')
    if (token !== TOKEN) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    if (req.url === '/static/hello.txt') {
      res.setHeader('content-type', 'text/plain')
      res.end('hello-from-kernel')
      return
    }
    // Echo the request back minus the token the forwarder attached, so the
    // test can assert on the path the kernel actually saw.
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    url.searchParams.delete('token')
    const echoed = url.pathname + (url.search ? url.search : '')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ token: TOKEN, path: echoed }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    origin,
    token: TOKEN,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

test('makeHandler forwards dsh-app://app/... to the kernel with the ?token= query parameter', async () => {
  const fake = await startFakeKernel()
  const dir = await mkdtemp(join(tmpdir(), 'dsh-protocol-e2e-'))
  try {
    const handler = makeHandler({
      rendererRoot: dir,
      kernelOriginOf: () => fake.origin,
      tokenOf: () => fake.token,
    })
    const response = await handler(new Request('dsh-app://app/api/status'))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.token, fake.token)
    assert.equal(body.path, '/api/status')
  } finally {
    await fake.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('makeHandler 401s when the kernel token does not match', async () => {
  const fake = await startFakeKernel()
  const dir = await mkdtemp(join(tmpdir(), 'dsh-protocol-e2e-'))
  try {
    const handler = makeHandler({
      rendererRoot: dir,
      kernelOriginOf: () => fake.origin,
      tokenOf: () => 'wrong-token',
    })
    const response = await handler(new Request('dsh-app://app/api/status'))
    assert.equal(response.status, 401)
  } finally {
    await fake.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('makeHandler follows the kernel 303 so the renderer gets the document, not an empty redirect', async () => {
  // Regression guard for the live black-window failure: the kernel redirects
  // its document requests, and a forwarding layer that passes the 303 through
  // hands the renderer an empty body, which renders as nothing at all.
  const TOKEN = 'e2e-redirect-' + Math.random().toString(36).slice(2)
  let hits = 0
  const server = createServer((req, res) => {
    hits += 1
    const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
    if (query.get('token') !== TOKEN) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    if (req.url?.startsWith('/app/index.html')) {
      res.setHeader('content-type', 'text/html')
      res.end('<html>index-after-redirect</html>')
      return
    }
    res.statusCode = 303
    res.setHeader('location', '/app/index.html')
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const dir = await mkdtemp(join(tmpdir(), 'dsh-protocol-e2e-'))
  try {
    const handler = makeHandler({
      rendererRoot: dir,
      kernelOriginOf: () => origin,
      tokenOf: () => TOKEN,
    })
    const response = await handler(new Request('dsh-app://app/'))
    assert.equal(response.status, 200, 'the redirect must be resolved inside the main process')
    assert.match(await response.text(), /index-after-redirect/)
    assert.ok(hits >= 2, 'the server must have seen both the redirect and its target')
  } finally {
    await new Promise((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('makeHandler replays a POST with its body so kernel API routes keep working', async () => {
  const TOKEN = 'e2e-post-' + Math.random().toString(36).slice(2)
  let seenMethod = null
  let seenBody = null
  const server = createServer((req, res) => {
    const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
    if (query.get('token') !== TOKEN) {
      res.statusCode = 401
      res.end('unauthorized')
      return
    }
    seenMethod = req.method
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      seenBody = Buffer.concat(chunks).toString('utf8')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const dir = await mkdtemp(join(tmpdir(), 'dsh-protocol-e2e-'))
  try {
    const handler = makeHandler({
      rendererRoot: dir,
      kernelOriginOf: () => origin,
      tokenOf: () => TOKEN,
    })
    const response = await handler(new Request('dsh-app://app/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"probe"}',
    }))
    assert.equal(response.status, 200)
    assert.equal(seenMethod, 'POST')
    assert.equal(seenBody, '{"name":"probe"}')
  } finally {
    await new Promise((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('makeHandler serves static shell documents alongside the kernel', async () => {
  const fake = await startFakeKernel()
  const dir = await mkdtemp(join(tmpdir(), 'dsh-protocol-e2e-'))
  try {
    await writeFile(join(dir, 'loading.html'), '<html>loading</html>', 'utf8')
    const handler = makeHandler({
      rendererRoot: dir,
      kernelOriginOf: () => fake.origin,
      tokenOf: () => fake.token,
    })
    const response = await handler(new Request('dsh-app://shell/loading.html'))
    assert.equal(response.status, 200)
    assert.equal(await response.text(), '<html>loading</html>')
    assert.match(response.headers.get('content-type') ?? '', /text\/html/)
  } finally {
    await fake.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('makeHandler 503s the kernel route before the origin is published', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-protocol-e2e-'))
  try {
    const state = { kernelOrigin: null }
    const handler = makeHandler({
      rendererRoot: dir,
      kernelOriginOf: () => state.kernelOrigin,
      tokenOf: () => 'tok',
    })
    const response = await handler(new Request('dsh-app://app/x'))
    assert.equal(response.status, 503)
    // Now publish the origin — the same handler picks it up without reinstall.
    state.kernelOrigin = 'http://127.0.0.1:1'
    assert.equal(state.kernelOrigin, 'http://127.0.0.1:1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the scheme constant is the one the renderer will fetch against', () => {
  assert.equal(SCHEME.shell, 'dsh-app')
})
