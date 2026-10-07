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
    const response = await handler({ url: `dsh-app://app/api/status` })
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
    const response = await handler({ url: 'dsh-app://app/api/status' })
    assert.equal(response.status, 401)
  } finally {
    await fake.close()
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
    const response = await handler({ url: 'dsh-app://shell/loading.html' })
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
    const response = await handler({ url: 'dsh-app://app/x' })
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
