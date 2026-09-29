/**
 * The renderer's permission boundary.
 *
 * The window loads a full web UI served by the kernel. That UI is not shell
 * code — it is whatever the kernel and its plugins render — so it should not
 * be able to ask the OS for a camera, a microphone, the clipboard, or
 * notifications just because it is running inside an Electron window.
 *
 * Electron answers permission requests optimistically unless told otherwise:
 * without a handler, `setPermissionRequestHandler` is unset and Chromium shows
 * its own prompt. Denying everything is the right default for this shell,
 * because nothing the shell itself needs is gated on a web permission.
 *
 * @module permissions
 */

/**
 * Denies every web permission.
 *
 * Both handlers are set, because they cover different moments: the check
 * handler answers synchronous `navigator.permissions.query` style lookups, and
 * the request handler answers an actual request from the page.
 *
 * @param {import('electron').Session} session
 * @returns {void}
 */
export function denyUnexpectedPermissions(session) {
  session.setPermissionCheckHandler(() => false)
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
}
