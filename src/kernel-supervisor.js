/**
 * Supervises the kernel across restarts.
 *
 * Ported in spirit from the official dsh-desktop shell, whose kernel is a
 * supervised process rather than a one-shot spawn: when it dies after the
 * window is up, the window would otherwise stay open on a page nobody serves.
 *
 * `KernelProcess` deliberately stays a single launch — its tests depend on
 * that. This layer owns the *sequence* of launches: it counts exits in a
 * rolling window, asks {@link module:restart-policy} whether another attempt is
 * allowed, waits the backoff, and starts a fresh `KernelProcess` with the
 * arguments it was given. It also restarts the token state, because each
 * launch issues a new one.
 *
 * @module kernel-supervisor
 */

import { KernelProcess } from './kernel-process.js'
import {
  DEFAULT_POLICY,
  decideRestart,
  exitsInWindow,
} from './restart-policy.js'
import { getConfig } from './config.js'

/**
 * @typedef {'launching' | 'waiting-for-ready' | 'ready' | 'retrying' | 'crashed'} KernelPhase
 *
 * @typedef {object} KernelState
 * @property {'starting' | 'ready' | 'crashed'} phase
 * @property {'launching' | 'waiting-for-ready' | 'retrying'} [stage]
 * @property {number} [attempts]
 * @property {number} [retryDelayMs]
 * @property {string} [url]
 */

export class KernelSupervisor {
  /** @type {() => {nodePath: string, args: string[], env: Record<string,string>, cwd: string}} */
  #launchSpec
  /** @type {(state: KernelState) => void} */
  #onState
  /** @type {number[]} */
  #exitTimes = []
  /** @type {number} */
  #restartDelay
  /** @type {NodeJS.Timeout | null} */
  #restartTimer = null
  #stopping = false
  /** @type {KernelProcess | null} */
  #current = null
  /** @type {Array<(info: {code: number|null, signal: string|null}) => void>} */
  #gaveUpListeners = []
  /** @type {import('./restart-policy.js').RestartPolicyConfig} */
  #policy

  /**
   * @param {object} options
   * @param {() => {nodePath: string, args: string[], env: Record<string,string>, cwd: string}} options.launchSpec -
   *   returns a fresh launch description; called again on every restart
   * @param {(state: KernelState) => void} [options.onState] - notified on every
   *   phase/stage change, which is what the tray and the loading page read
   * @param {import('./restart-policy.js').RestartPolicyConfig} [options.policy] -
   *   restart bounds; defaults to config.json's `supervisor` section
   */
  constructor({ launchSpec, onState = () => undefined, policy } = {}) {
    this.#launchSpec = launchSpec
    this.#onState = onState
    const svc = getConfig().supervisor
    this.#policy = policy ?? {
      maxRestartsInWindow: svc.maxRestartsInWindow,
      restartWindowMs: svc.restartWindowMs,
      baseDelayMs: svc.baseDelayMs,
      maxDelayMs: svc.maxDelayMs,
    }
    this.#restartDelay = this.#policy.baseDelayMs
  }

  /** @returns {KernelProcess | null} the process of the current launch */
  get current() {
    return this.#current
  }

  /**
   * Registers a listener for the point where the supervisor stops retrying.
   *
   * This is the "the kernel will not come back by itself" signal, and the only
   * honest place to tell the user what happened.
   *
   * @param {(info: {code: number|null, signal: string|null}) => void} listener
   * @returns {void}
   */
  onGaveUp(listener) {
    this.#gaveUpListeners.push(listener)
  }

  /**
   * Starts a launch and supervises it.
   *
   * @returns {Promise<KernelProcess>} the first process, already spawned
   */
  async start() {
    return this.#spawn()
  }

  /** @returns {Promise<KernelProcess>} */
  async #spawn() {
    this.#onState({ phase: 'starting', stage: 'launching' })
    const spec = await this.#launchSpec()
    const process_ = new KernelProcess()
    this.#current = process_
    process_.start(spec)
    this.#onState({ phase: 'starting', stage: 'waiting-for-ready' })

    process_.onUnexpectedExit((info) => {
      if (this.#stopping) return
      this.#scheduleRestart(info)
    })

    return process_
  }

  /**
   * @param {{code: number|null, signal: string|null}} info
   * @returns {void}
   */
  #scheduleRestart(info) {
    this.#exitTimes.push(Date.now())
    this.#exitTimes = exitsInWindow(this.#exitTimes, Date.now(), this.#policy)
    const attempts = this.#exitTimes.length
    const decision = decideRestart(attempts, this.#restartDelay, this.#policy)

    if (decision.action === 'gaveUp') {
      this.#onState({ phase: 'crashed', attempts: decision.attempts })
      for (const listener of this.#gaveUpListeners) listener(info)
      return
    }

    this.#restartDelay = decision.delay
    this.#onState({
      phase: 'starting',
      stage: 'retrying',
      attempts,
      retryDelayMs: decision.delay,
    })

    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null
      void this.#spawn()
    }, decision.delay)
    // A pending restart must never hold the process open if the user asks to
    // quit while waiting.
    this.#restartTimer.unref?.()
  }

  /**
   * Stops supervising and stops the current process, if any.
   *
   * After this the supervisor will not restart again, which is what makes an
   * explicit quit different from a crash.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    this.#stopping = true
    if (this.#restartTimer !== null) {
      clearTimeout(this.#restartTimer)
      this.#restartTimer = null
    }
    const current = this.#current
    this.#current = null
    if (current !== null) await current.stop()
  }

  /** Marks the current launch as ready, resetting the backoff. */
  markReady(url) {
    this.#restartDelay = this.#policy.baseDelayMs
    this.#onState({ phase: 'ready', url })
  }

  /**
   * User-initiated restart: stop the current kernel (this is not treated as a
   * crash, so it does not count against the backoff window) and start a fresh
   * launch immediately. Returns the new process.
   *
   * @returns {Promise<KernelProcess>}
   */
  async restart() {
    const current = this.#current
    this.#current = null
    if (current !== null) await current.stop()
    return this.#spawn()
  }
}
