/**
 * Sandboxed preload — the only piece of shell-side code the renderer ever sees.
 *
 * Everything else in the window runs in the kernel-served web UI, which is
 * untrusted by design (see `window-policy.js`). The preload is locked down
 * (`sandbox: true`, `contextIsolation: true`, no `nodeIntegration`) and exposes
 * exactly two methods via `contextBridge`:
 *
 *   `notify(title, body)` — fire a desktop notification through the OS shell.
 *   `onShown(handler)`     — invoke `handler()` whenever the window is unhidden
 *                            from the tray, so the renderer can resume any work
 *                            it was pausing.
 *
 * That is the entire surface. A larger surface is the failure mode this preload
 * exists to prevent: every new export is another piece of the kernel's web UI
 * that can be addressed from a compromised renderer, which is precisely what
 * the upstream policy was written to forbid.
 *
 * Sandboxed preloads run in a V8 context that has no Node module loader:
 * neither `require` nor `import` from `'electron'` resolve, because no Node
 * runtime is present. Electron instead exposes the whitelisted APIs
 * (`contextBridge`, `ipcRenderer`, `webFrame`) as plain globals in the preload
 * scope, and this file uses them directly.
 *
 * The `.cjs` extension is what makes that work. `package.json` declares
 * `"type": "module"`, so a sibling `preload.js` would be handed to the ESM
 * loader — where Electron's injected globals are not in scope, and this file
 * dies on `ReferenceError: contextBridge is not defined`, leaving the renderer
 * with no bridge at all. `.cjs` forces the CommonJS path regardless.
 *
 * @module preload
 */

// The runtime names `contextBridge` and `ipcRenderer` exist as globals in the
// sandboxed preload scope; TypeScript has no declaration for them because the
// `electron` module typings assume `import { ... } from 'electron'`, which does
// not resolve here. The `@ts-ignore` comments let the cast below type-check
// without polluting the rest of the file with `any` types.
/** @type {import('electron').ContextBridge} */
// @ts-ignore — Electron global available at runtime in the preload context
const contextBridgeApi = /** @type {any} */ (contextBridge)
/** @type {import('electron').IpcRenderer} */
// @ts-ignore — Electron global available at runtime in the preload context
const ipcRendererApi = /** @type {any} */ (ipcRenderer)

if (!contextBridgeApi || !ipcRendererApi) {
  throw new Error('preload: Electron globals contextBridge/ipcRenderer are not available')
}

// Self-check: reaching this line proves Electron parsed and executed the file,
// which is otherwise indistinguishable from "Unable to load preload script" in
// DevTools. The main process reads it back to tell a parse failure from a
// successful load.
contextBridgeApi.exposeInMainWorld('__dshPreloadProbe', {
  loaded: true,
  hasContextBridge: contextBridgeApi !== undefined,
  hasIpcRenderer: ipcRendererApi !== undefined,
})
console.log('[dsh-shell] preload loaded; contextBridge =', typeof contextBridgeApi,
  'ipcRenderer =', typeof ipcRendererApi)
// Also hand the mark to the main process over IPC: the renderer console is not
// always visible (no terminal, DevTools closed), and the main process turns
// this into a crash report on disk.
ipcRendererApi.send('shell:preload-probe', {
  contextBridge: typeof contextBridgeApi,
  ipcRenderer: typeof ipcRendererApi,
})

contextBridgeApi.exposeInMainWorld('shell', Object.freeze({
  /**
   * Posts a desktop notification through the shell's `Notification` instance.
   *
   * Failures are swallowed: a renderer that is mid-unload, or a notification
   * daemon that is not running, should not propagate exceptions back into the
   * page that asked for them.
   *
   * @param {string} title
   * @param {string} body
   * @returns {void}
   */
  notify(title, body) {
    try {
      ipcRendererApi.send('shell:notify', { title: String(title), body: String(body) })
    } catch {
      // intentionally empty
    }
  },

  /**
   * Subscribes to the "window was just unhidden" event so the renderer can
   * resume polling or visual updates it had paused. Multiple subscribers are
   * allowed; the underlying listener is fanned out.
   *
   * @param {() => void} handler
   * @returns {() => void} unsubscribe
   */
  onShown(handler) {
    if (typeof handler !== 'function') return () => {}
    const listener = () => {
      try { handler() } catch { /* ignore renderer errors */ }
    }
    ipcRendererApi.on('shell:shown', listener)
    return () => ipcRendererApi.removeListener('shell:shown', listener)
  },

  /**
   * Reports whether the kernel's web UI currently looks busy.
   *
   * This is the only input the shell has for "would quitting interrupt
   * anything?". The official shell answers that by querying the Host over a
   * private channel this shell does not have; the DOM observation is an
   * approximation, and is treated as one.
   *
   * @param {boolean} busy
   * @returns {void}
   */
  setBusy(busy) {
    try {
      ipcRendererApi.send('shell:busy', busy === true)
    } catch {
      // intentionally empty
    }
  },

  /**
   * Asks the shell to run one of a fixed set of desktop actions.
   *
   * Only an action *name* crosses the bridge — never a channel, a path, or a
   * payload. The main process looks the name up in `DESKTOP_ACTIONS` and
   * refuses anything else, so a page cannot reach an IPC handler this preload
   * did not mean to expose.
   *
   * @param {string} action - e.g. 'restart-kernel'
   * @returns {void}
   */
  invoke(action) {
    try {
      ipcRendererApi.send('shell:invoke', String(action))
    } catch {
      // intentionally empty
    }
  },

  /**
   * Subscribes to the shell's state, so the in-page controls can show whether
   * the kernel is starting, ready or crashed — the same information the tray
   * status line shows.
   *
   * @param {(state: object) => void} handler
   * @returns {() => void} unsubscribe
   */
  onState(handler) {
    if (typeof handler !== 'function') return () => {}
    const listener = (/** @type {unknown} */ _event, /** @type {any} */ state) => {
      try { handler(state) } catch { /* ignore renderer errors */ }
    }
    ipcRendererApi.on('shell:state', listener)
    return () => ipcRendererApi.removeListener('shell:state', listener)
  },
}))