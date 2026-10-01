/**
 * Restart policy for a kernel that dies after it was launched.
 *
 * Ported (in spirit, not in code) from the official dsh-desktop shell's
 * `src/main/restart-policy.ts`, which supervises its kernel with a bounded
 * exponential backoff instead of letting a dead kernel leave the window
 * showing a page nobody can reach.
 *
 * The shape of the policy:
 *
 *   - a restart is scheduled with a delay that doubles each time, capped;
 *   - exits are counted inside a rolling window, not forever — a kernel that
 *     crashed three times last hour and never since is healthy now, and
 *     should not be treated as one that is thrashing;
 *   - once the window is full, the shell gives up and surfaces a `crashed`
 *     state rather than restarting into the same failure forever.
 *
 * @module restart-policy
 */

/**
 * The kernel prints its web URL exactly once when it is up. This is the whole
 * readiness signal the official shell uses, and it is the same line this shell
 * reads its per-launch token from.
 *
 * @type {RegExp}
 */
export const READY_LINE = /^dsh web: (http:\/\/127\.0\.0\.1:\d+(?:[/?][^\s)]*)?)/

/**
 * The policy bounds. These are the built-in defaults; the live values come
 * from `config.json` and are passed into {@link decideRestart} / {@link
 * exitsInWindow} so a configuration change does not require a code edit.
 *
 * @typedef {object} RestartPolicyConfig
 * @property {number} maxRestartsInWindow
 * @property {number} restartWindowMs
 * @property {number} baseDelayMs
 * @property {number} maxDelayMs
 */

/** @type {RestartPolicyConfig} */
export const DEFAULT_POLICY = {
  maxRestartsInWindow: 5,
  restartWindowMs: 10 * 60_000,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
}

/**
 * Extracts the web URL from a line of kernel output.
 *
 * @param {string} line
 * @returns {string | null} the URL, or null when the line is not the ready line
 */
export function parseReadyUrl(line) {
  return READY_LINE.exec(line)?.[1] ?? null
}

/**
 * Keeps only the exits that happened inside the rolling window.
 *
 * @param {number[]} exitTimes - epoch millis of past exits, oldest first
 * @param {number} now - epoch millis
 * @param {RestartPolicyConfig} [policy]
 * @returns {number[]} the exits that still count
 */
export function exitsInWindow(exitTimes, now, policy = DEFAULT_POLICY) {
  const cutoff = now - policy.restartWindowMs
  return exitTimes.filter((time) => time >= cutoff)
}

/**
 * The delay for the next attempt: doubled, and never above the cap.
 *
 * @param {number} currentDelay
 * @param {RestartPolicyConfig} [policy]
 * @returns {number}
 */
export function nextRestartDelay(currentDelay, policy = DEFAULT_POLICY) {
  return Math.min(currentDelay * 2, policy.maxDelayMs)
}

/**
 * Whether another restart is allowed, and how long to wait before it.
 *
 * @param {number} attempts - exits counted in the current window
 * @param {number} currentDelay - the delay used last time
 * @param {RestartPolicyConfig} [policy]
 * @returns {{action: 'restart', delay: number} | {action: 'gaveUp', attempts: number}}
 */
export function decideRestart(attempts, currentDelay, policy = DEFAULT_POLICY) {
  if (attempts > policy.maxRestartsInWindow) return { action: 'gaveUp', attempts }
  return { action: 'restart', delay: nextRestartDelay(currentDelay, policy) }
}
