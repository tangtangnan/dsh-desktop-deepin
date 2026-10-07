/**
 * Private-protocol handling for the shell, with a dual channel to the kernel.
 *
 * A thin layer over Electron's `protocol` module: it registers a `dsh-app`
 * scheme with the privileges that make it behave like a standard, secure
 * origin, then routes requests by hostname —
 *
 *   dsh-app://shell/... -> the shell's own static documents (renderer dir)
 *   dsh-app://app/...   -> forwarded to the kernel's authenticated origin
 *
 * The renderer loads the kernel's web UI through the `app` hostname, so every
 * request the UI issues resolves against the scheme and is proxied back to the
 * kernel's plain `http://127.0.0.1` endpoint with the per-launch token
 * attached as a `?token=` query parameter. The kernel only exposes a
 * WebSocket surface over `ws://`, and Chromium cannot open that from a custom
 * scheme page; `rewriteWebSocketUrl` therefore rewrites each outgoing
 * WebSocket URL with the kernel origin and token so the dial goes out to the
 * real `ws://` endpoint directly.
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
 * Content-Security-Policy served with the shell's own documents.
 *
 * Mirrors the `<meta http-equiv>` in `renderer/loading.html` and
 * `renderer/error.html` as a real response header: Electron's security warning
 * reads headers, not meta tags. The pages are fully self-contained (inline
 * style and inline script, no network), so nothing is loaded from anywhere.
 *
 * @type {string}
 */
export const SHELL_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"

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
  const { readFile, stat } = await import('node:fs/promises')
  const { extname, resolve, sep } = await import('node:path')
  const parsed = new URL(url)

  // If the renderer directory itself does not exist (e.g. a hand-picked
  // install layout where `renderer/` was not copied), the route cannot serve
  // anything; return 503 instead of an unhandled ENOENT crash.
  try {
    await stat(root)
  } catch {
    return new Response(null, { status: 503, statusText: 'renderer directory missing' })
  }

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
  const headers = new Headers({
    'content-type': MIME[extname(target)] ?? 'application/octet-stream',
  })
  // A real CSP response header, not just the page's <meta http-equiv>. Electron's
  // security warning inspects response headers, so without this the loading and
  // error pages trip "This renderer process has no Content-Security-Policy"
  // even though their markup declares the same policy. Only shell-owned
  // documents get it — forwarded kernel responses keep the kernel's own headers.
  if (extname(target) === '.html') {
    headers.set('content-security-policy', SHELL_CSP)
  }
  return new Response(body, { headers })
}

/**
 * Forwards a request to the kernel's authenticated origin.
 *
 * Rebuilds the request against the kernel's plain origin (no token embedded in
 * the URL the renderer asked for), then attaches the kernel's per-launch token
 * as a `?token=` query parameter. The kernel's web gate reads the token from
 * the URL — it does not inspect an `Authorization` header — so the forwarded
 * request must carry the credential in the query string, exactly the shape the
 * old `loadURL(tokenised(...))` path produced. Hop-by-hop response headers are
 * withheld so the kernel's keep-alive bookkeeping does not leak into the
 * renderer-facing response.
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
  target.searchParams.set('token', token)
  const response = await fetch(target, { method: 'GET', redirect: 'manual' })
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

/**
 * Rewrites a WebSocket URL issued by a page living in the `dsh-app` shell
 * domain so it can be served by the kernel over a real `ws://` connection.
 *
 * Chromium cannot open a `ws://` connection from a page whose URL is a custom
 * scheme, and the kernel's streaming surface only authenticates via the
 * per-launch token in the URL query string (not an `Authorization` header).
 * The main process therefore intercepts `ws://127.0.0.1/*` requests and
 * rewrites each one with this helper before Chromium dials out: the host is
 * kept verbatim (it is already the kernel's), the kernel origin is attached
 * for diagnostics, and the token is appended as a query parameter.
 *
 * @param {string} url - the original WebSocket URL the page asked for.
 * @param {object} options
 * @param {string | null} options.kernelOrigin - the kernel's plain origin (`http://127.0.0.1:<port>`).
 * @param {() => (string | null)} options.tokenOf - returns the kernel's current token, or null while unknown.
 * @returns {string} the rewritten WebSocket URL, or the input unchanged when no token is available.
 * @throws {Error} when the URL's host differs from the kernel origin's host —
 *   a cross-host WebSocket must not be silently re-pointed at the kernel.
 */
export function rewriteWebSocketUrl(url, { kernelOrigin, tokenOf }) {
  const parsed = new URL(url)
  const host = kernelOrigin !== null ? new URL(kernelOrigin).host : null
  if (host !== null && parsed.host !== host) {
    throw new Error(`refusing to re-point WebSocket ${parsed.host} at kernel ${host}`)
  }
  const token = tokenOf()
  if (token === null || token === undefined || token === '') return url
  const rewritten = new URL(url)
  rewritten.searchParams.set('token', token)
  return rewritten.toString()
}
