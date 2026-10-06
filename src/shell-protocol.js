/**
 * Minimal private-protocol handling for the shell.
 *
 * A thin layer over Electron's `protocol` module: it registers a `dsh-app`
 * scheme with the privileges that make it behave like a standard, secure
 * origin, then routes requests by hostname —
 *
 *   dsh-app://shell/... -> the shell's own static documents (renderer dir)
 *   dsh-app://app/...   -> forwarded to the kernel's authenticated origin
 *
 * The kernel is addressed through the shell's existing `http://127.0.0.1`
 * endpoint plus its per-launch token, so the two stay decoupled: the scheme
 * is a front door for the renderer, not a replacement for the kernel.
 *
 * @module shell-protocol
 */

/**
 * The custom scheme this shell registers.
 *
 * @type {Readonly<{shell: string}>}
 */
export const SCHEME = Object.freeze({ shell: 'dsh-app' })

/**
 * Hostnames the protocol handler routes on, mirroring the official shell.
 *
 * @type {Readonly<{shellDocs: string, kernel: string}>}
 */
export const ROUTES = Object.freeze({ shellDocs: 'shell', kernel: 'app' })

/**
 * Which privileges the scheme must carry to be usable as a standard origin.
 *
 * @type {Readonly<object>}
 */
export const PRIVILEGES = Object.freeze({
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
  stream: true,
  codeCache: true,
})

/**
 * A minimal view of the Electron `protocol` module this module talks to.
 *
 * @typedef {object} ProtocolModule
 * @property {(list: { scheme: string, privileges: Record<string, boolean> }[]) => void} registerSchemesAsPrivileged
 * @property {(scheme: string, handler: (request: { url: string }) => Promise<Response>) => void} handle
 */

/**
 * Registers the scheme as privileged.
 *
 * Must be called before any window is created and before `app.whenReady`.
 *
 * @param {ProtocolModule} protocol - Electron's `protocol` module.
 * @returns {void}
 */
export function registerShellScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME.shell,
    privileges: { ...PRIVILEGES },
  }])
}

/**
 * Serves a shell-owned static document from a directory on disk.
 *
 * Mirrors the official shell's `serveWebDocument`: reads a file under `root`,
 * with a path-traversal guard, and returns a Web `Response`.
 *
 * @param {object} options
 * @param {string} options.url - the full request URL (`dsh-app://shell/...`).
 * @param {string} options.root - the static document directory to serve from.
 * @returns {Promise<Response>}
 */
export async function serveShellDocument({ url, root }) {
  const { readFile } = await import('node:fs/promises')
  const { extname, resolve, sep } = await import('node:path')
  const parsed = new URL(url)
  /** @type {Readonly<Record<string, string>>} */
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  }
  const pathname = parsed.pathname === '/' ? '/index.html' : parsed.pathname
  let target
  let body
  try {
    target = resolve(root, '.' + pathname)
    const directory = resolve(root)
    if (!target.startsWith(directory + sep)) return new Response(null, { status: 403 })
    body = await readFile(target)
  } catch (error) {
    /** @type {unknown} */
    const err = error
    const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined
    if (code === 'ENOENT') return new Response(null, { status: 404 })
    if (code === 'EACCES' || code === 'EPERM') return new Response(null, { status: 403 })
    throw error
  }
  return new Response(body, {
    headers: { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' },
  })
}

/**
 * Forwards a request to the kernel's authenticated origin.
 *
 * Strips the original `host`/`origin`/`cookie` headers, injects the kernel's
 * token as an `Authorization` header (the kernel gates its web surface behind
 * its per-launch token), and withholds hop-by-hop response headers.
 *
 * @param {object} options
 * @param {string} options.url - the full request URL (`dsh-app://app/...`).
 * @param {string} options.origin - the kernel's origin (`http://127.0.0.1:<port>`).
 * @param {string | null} options.token - the kernel's per-launch token.
 * @returns {Promise<Response>}
 */
export async function forwardToKernel({ url, origin, token }) {
  const parsed = new URL(url)
  if (parsed.hostname !== ROUTES.kernel) return new Response(null, { status: 404 })
  if (token === null || token === undefined || token === '') return new Response(null, { status: 503 })
  const target = new URL(`${origin.replace(/\/$/, '')}${parsed.pathname}${parsed.search}`)
  const headers = new Headers()
  headers.set('authorization', `Bearer ${token}`)
  const response = await fetch(target, { method: 'GET', headers, redirect: 'manual' })
  const outgoing = new Headers(response.headers)
  for (const name of ['set-cookie', 'content-encoding', 'content-length',
    'transfer-encoding', 'connection', 'keep-alive']) outgoing.delete(name)
  return new Response(response.body, { status: response.status, headers: outgoing })
}

/**
 * The protocol handler that routes by hostname.
 *
 * @param {object} options
 * @param {string} options.rendererRoot - the shell's renderer document directory.
 * @param {() => (string | null)} options.kernelOriginOf - returns the kernel's origin, or null while unknown.
 * @param {() => (string | null)} options.tokenOf - returns the kernel's current token.
 * @returns {(request: { url: string }) => Promise<Response>}
 */
export function makeHandler({ rendererRoot, kernelOriginOf, tokenOf }) {
  return async (request) => {
    const parsed = new URL(request.url)
    if (parsed.hostname === ROUTES.shellDocs) {
      return serveShellDocument({ url: request.url, root: rendererRoot })
    }
    if (parsed.hostname === ROUTES.kernel) {
      const kernelOrigin = kernelOriginOf()
      if (kernelOrigin === null) return new Response(null, { status: 503 })
      return forwardToKernel({ url: request.url, origin: kernelOrigin, token: tokenOf() })
    }
    return new Response(null, { status: 404 })
  }
}

/**
 * Installs the handler on Electron's protocol module.
 *
 * @param {ProtocolModule} protocol - Electron's `protocol` module.
 * @param {object} options - see {@link makeHandler}.
 * @param {string} options.rendererRoot
 * @param {() => (string | null)} options.kernelOriginOf
 * @param {() => (string | null)} options.tokenOf
 * @returns {void}
 */
export function installShellProtocol(protocol, options) {
  protocol.handle(SCHEME.shell, makeHandler(options))
}

/**
 * A state bag the main process mutates as the kernel endpoint comes and goes.
 *
 * The handler closes over this so it picks up the live origin without being
 * reinstalled.
 *
 * @returns {{kernelOrigin: string | null}}
 */
export function createShellProtocolState() {
  return { kernelOrigin: null }
}
