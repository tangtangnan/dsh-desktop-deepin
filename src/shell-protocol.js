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
 * Authorisation tickets the kernel handed out, keyed by cookie name.
 *
 * @typedef {Map<string, string>} CookieJar
 */

/**
 * Request headers that describe a single hop and must never be replayed onto
 * the next one. RFC 9110 §7.6.1 connection-scoped names, plus the ones Node's
 * fetch refuses to let a caller set.
 *
 * @type {ReadonlySet<string>}
 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

/**
 * How many redirect hops a single forwarded request may follow.
 *
 * @type {number}
 */
const REDIRECT_LIMIT = 5

/**
 * Whether a status code is a redirect this layer should resolve itself.
 *
 * @param {number} status
 * @returns {boolean}
 */
function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

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
 * @property {(scheme: string, handler: (request: Request) => Promise<Response>) => void} handle
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
 * old `loadURL(tokenised(...))` path produced.
 *
 * The request is otherwise passed through verbatim: method, headers and body
 * all survive, because the kernel serves POST/PATCH API routes alongside plain
 * documents and a hard-coded `GET` silently broke them. Cookies included — the
 * kernel's authorisation ticket arrives as `Set-Cookie` and must be replayed.
 *
 * Redirects are resolved here rather than handed to the renderer, because the
 * kernel's entry handshake is a 303 whose ticket-bearing cookie has to survive
 * the hop. Passing the 303 through gave the renderer an empty body behind a
 * redirect status — a black window — and dropping the cookie turned the
 * handshake into an endless `303 → ./` (observed live: 80 such requests).
 *
 * @param {object} options
 * @param {string} options.url - the full request URL (`dsh-app://app/...`).
 * @param {string} options.origin - the kernel's origin (`http://127.0.0.1:<port>`).
 * @param {string | null} options.token - the kernel's per-launch token.
 * @param {Request} [options.request] - the original request, for method/headers/body.
 * @param {CookieJar} [options.jar] - tickets collected during redirect hops.
 * @returns {Promise<Response>}
 */
export async function forwardToKernel({ url, origin, token, request, jar }) {
  const parsed = new URL(url)
  if (parsed.hostname !== ROUTES.kernel) return new Response(null, { status: 404 })
  if (token === null || token === undefined || token === '') return new Response(null, { status: 503 })
  const target = new URL(`${origin.replace(/\/$/, '')}${parsed.pathname}${parsed.search}`)

  // The token belongs on the entry request only. Once a ticket is in hand the
  // cookie is the credential, and re-sending `?token=` makes the kernel treat
  // the request as a fresh unauthenticated visit — it answers `303 → ./` and
  // the chain never terminates (observed live: an endless 303 loop).
  const tickets = jar ?? new Map()
  if (tickets.size === 0) target.searchParams.set('token', token)

  // Forward the caller's method and headers. Hop-by-hop and the browser-managed
  // `Origin`/`Referer` are dropped: they describe the renderer-to-shell hop, not
  // the shell-to-kernel one, and replaying `Origin: dsh-app://app` upstream would
  // make the kernel's own origin check reject the request.
  //
  // `Cookie` is deliberately kept. The kernel answers the first document
  // request with `303 → ./` plus a `set-cookie` holding its authorisation
  // ticket; every later request must present it. Stripping cookies — or never
  // sending the ticket the shell collected — leaves the kernel answering
  // `303 → ./` forever, which is the black window reported live.
  const headers = new Headers()
  if (request !== undefined) {
    request.headers.forEach((value, name) => {
      const lower = name.toLowerCase()
      if (HOP_BY_HOP.has(lower) || lower === 'host' || lower === 'origin' ||
        lower === 'referer') return
      headers.set(name, value)
    })
  }
  // The shell holds the ticket on the renderer's behalf, so restore it here
  // before anything else touches `headers`.
  if (tickets.size > 0) {
    headers.set('cookie', [...tickets].map(([name, value]) => `${name}=${value}`).join('; '))
  }
  const method = request?.method ?? 'GET'
  const body = method === 'GET' || method === 'HEAD' ? undefined : request?.body
  // undici refuses to stream a request body unless `duplex` is declared; the
  // renderer hands us a ReadableStream, so this is required, not cosmetic.
  // `duplex` and iterable `Headers` belong to Node's undici rather than to the
  // DOM lib this file is otherwise typed against, hence the widened init type.
  /** @type {RequestInit & { duplex?: 'half' }} */
  const init = body === undefined
    ? { method, headers, redirect: 'manual' }
    : { method, headers, body, redirect: 'manual', duplex: 'half' }

  // Redirects are followed here rather than by fetch, for two reasons.
  //
  // Redirects are resolved here rather than handed to the renderer, because the
  // kernel's entry handshake is a 303 whose ticket-bearing cookie has to
  // survive the hop:
  //
  //   GET /?token=… → 303 Location: ./ + Set-Cookie: dsh-auth-…
  //   GET /         → 200 <the real document>
  //
  // Passing that 303 through hands the renderer an empty body behind a redirect
  // status — a black window — so the hop is resolved here and the ticket is
  // carried into `jar`, which outlives the request: `dsh-app://app/` is its own
  // origin with its own cookie store, so the shell has to hold the ticket on
  // the renderer's behalf or every follow-up asset comes back 401.
  let response = await fetch(target, init)
  // Cookies the kernel hands out mid-chain, replayed on the following hop.
  // The renderer would normally store these itself and re-request, but the
  // document has to arrive with the very response the navigation is waiting
  // for — so the handshake is carried to the end here.
  //
  // Keyed by cookie name, not appended: every 303 mints a *fresh* ticket for
  // the same name, and sending the stale one alongside (or instead of) the new
  // one leaves the kernel issuing 303s forever. A real cookie jar replaces on
  // write, so this does too.
  for (let hop = 0; hop < REDIRECT_LIMIT && isRedirect(response.status); hop += 1) {
    const location = response.headers.get('location')
    if (location === null) break
    const next = new URL(location, target)
    for (const raw of response.headers.getSetCookie()) {
      const pair = (raw.split(';', 1)[0] ?? '').trim()
      const eq = pair.indexOf('=')
      if (eq > 0) tickets.set(pair.slice(0, eq), pair.slice(eq + 1))
    }
    const hopHeaders = new Headers(headers)
    if (tickets.size > 0) {
      hopHeaders.set('cookie', [...tickets].map(([name, value]) => `${name}=${value}`).join('; '))
    }
    // 303 (and 301/302) turn the follow-up into a GET; 307/308 must preserve
    // the method and body.
    const preservesMethod = response.status === 307 || response.status === 308
    response = await fetch(next, preservesMethod
      ? { ...init, headers: hopHeaders }
      : { method: 'GET', headers: hopHeaders, redirect: 'manual' })
  }
  return new Response(response.body, { status: response.status, headers: response.headers })
}

/**
 * The protocol handler that routes by hostname.
 *
 * @param {object} options
 * @param {string} options.rendererRoot - the shell's renderer document directory.
 * @param {() => (string | null)} options.kernelOriginOf - returns the kernel's origin, or null while unknown.
 * @param {() => (string | null)} options.tokenOf - returns the kernel's current token.
 * @returns {(request: Request) => Promise<Response>}
 */
export function makeHandler({ rendererRoot, kernelOriginOf, tokenOf }) {
  // The kernel authorises a browser session with a cookie handed out during the
  // entry handshake. `dsh-app://app/` is a separate origin with a separate
  // cookie store, so the renderer cannot hold that ticket — the shell keeps it
  // here for the lifetime of the handler and replays it on every request.
  /** @type {Map<string, string>} */
  const jar = new Map()
  return async (request) => {
    const parsed = new URL(request.url)
    if (parsed.hostname === ROUTES.shellDocs) {
      return serveShellDocument({ url: request.url, root: rendererRoot })
    }
    if (parsed.hostname === ROUTES.kernel) {
      const kernelOrigin = kernelOriginOf()
      if (kernelOrigin === null) return new Response(null, { status: 503 })
      return forwardToKernel({
        url: request.url,
        origin: kernelOrigin,
        token: tokenOf(),
        request: typeof request.method === 'string' ? request : undefined,
        jar,
      })
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
/**
 * Re-points a WebSocket URL at the kernel, carrying the per-launch token.
 *
 * The renderer lives under `dsh-app://app/`, and the kernel's frontend builds
 * its socket URL from the page's own host — so it dials `ws://app/…`, a host
 * that resolves nowhere. Chromium cannot dial `ws://` out of a custom-scheme
 * page at all, so the main process intercepts the attempt and re-points it at
 * the kernel's plain origin with the ticket attached.
 *
 * Two shapes are accepted, and only these two:
 *   - the kernel's own `127.0.0.1:<port>` host, when the frontend already
 *     addressed it directly;
 *   - `app`, the shell scheme's own hostname, which is what a page served from
 *     `dsh-app://app/` actually produces.
 *
 * Anything else is refused rather than silently redirected: this hook sits on
 * a request filter, and quietly aiming a third party's socket at the kernel
 * would be a far worse failure than the one it is fixing.
 *
 * @param {string} url - the attempted socket URL.
 * @param {object} options
 * @param {string | null} options.kernelOrigin - the kernel's origin.
 * @param {() => (string | null)} options.tokenOf - returns the kernel's token.
 * @returns {string} the rewritten URL, or `url` unchanged when there is no token.
 */
export function rewriteWebSocketUrl(url, { kernelOrigin, tokenOf }) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`refusing to re-point non-WebSocket URL ${url}`)
  }
  const kernelHost = kernelOrigin !== null && kernelOrigin !== undefined
    ? new URL(kernelOrigin).host
    : null
  const isKernelHost = kernelHost !== null && parsed.host === kernelHost
  const isShellHost = parsed.host === ROUTES.kernel
  if (!isKernelHost && !isShellHost) {
    throw new Error(`refusing to re-point WebSocket ${parsed.host} at kernel ${String(kernelHost)}`)
  }
  if (!isShellHost) return url
  const token = tokenOf()
  if (token === null || token === undefined || token === '') return url
  const rewritten = new URL(url)
  if (kernelHost !== null) rewritten.host = kernelHost
  rewritten.searchParams.set('token', token)
  return rewritten.toString()
}
