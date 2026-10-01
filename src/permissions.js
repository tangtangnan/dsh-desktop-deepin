/**
 * The renderer's permission boundary.
 *
 * The window loads a full web UI served by the kernel. That UI is not shell
 * code — it is whatever the kernel and its plugins render — so arbitrary web
 * permissions must still be denied by default. The kernel itself, however,
 * ships voice input (microphone), notifications and clipboard integration, so
 * those three are explicitly allowed: denying them would break real kernel
 * features, while the page is still our trusted kernel UI, not an arbitrary
 * website.
 *
 * Electron answers permission requests optimistically unless told otherwise:
 * without a handler, `setPermissionRequestHandler` is unset and Chromium shows
 * its own prompt. We gate on an allowlist instead so the surface stays small.
 *
 * @module permissions
 */

/** Permissions the kernel UI is allowed to use. */
const ALLOWED = new Set([
  'media', // 麦克风（getUserMedia audio；请求里带 video 的会被下面的校验拒绝）
  'notifications',
  'clipboard-read',
  'clipboard-sanitized-write',
])

/**
 * Allow kernel-needed permissions, deny the rest.
 *
 * Both handlers are set, because they cover different moments: the check
 * handler answers synchronous `navigator.permissions.query` style lookups, and
 * the request handler answers an actual request from the page.
 *
 * For `media` we re-inspect the request: audio-only passes (microphone),
 * anything asking for a camera is denied — the allowlist is for the
 * microphone, not the webcam.
 *
 * @param {import('electron').Session} session
 * @returns {void}
 */
export function denyUnexpectedPermissions(session) {
  const allow = (permission, requestingOrigin, details) => {
    if (permission !== 'media') return ALLOWED.has(permission)
    const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : []
    // 没带 mediaTypes 的 media 请求按音频对待（内核语音输入走的是 audio）。
    return mediaTypes.length === 0 || mediaTypes.every((t) => t === 'audio')
  }
  session.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) =>
    allow(permission, requestingOrigin, details))
  session.setPermissionRequestHandler((_webContents, permission, callback, details) =>
    callback(allow(permission, _webContents?.getURL?.() ?? '', details)))
}
