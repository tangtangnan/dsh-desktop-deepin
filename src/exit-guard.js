/**
 * Whether quitting needs to interrupt anything, and whether to ask first.
 *
 * The official shell asks the Host — over a private IPC channel — what quitting
 * would interrupt: running agents (including sub-agents and turns awaiting
 * approval), queued messages, and background tasks. If the answer is "nothing",
 * it quits without a dialog. Otherwise it asks.
 *
 *   "两项都没有时直接退出，不弹框。否则弹出一个没有父窗口的原生消息框"
 *   "查询失败或 Host 超过两秒截止时间未答复，按运行中任务处理。"
 *
 * This shell has no private IPC channel to the kernel: the kernel is a child
 * process started from npm, and the channel the official shell uses belongs to
 * its private Desktop Host package. So the question "is anything running?"
 * cannot be answered exactly.
 *
 * Rather than pretend otherwise, the decision is a declared policy with three
 * settings, and the default is the safe one. The honest difference from
 * upstream is documented, not papered over.
 *
 * @module exit-guard
 */

/**
 * The supported policies.
 *
 * - `ask-always` — always confirm before quitting (the default, and the safe
 *   choice given the question cannot be answered exactly).
 * - `ask-if-busy` — confirm only when the shell's own observer last saw the
 *   kernel busy. This is an approximation: it is driven by DOM observation,
 *   not by the kernel's own task list.
 * - `never` — quit immediately, matching the official behaviour only in the
 *   case where nothing is running.
 *
 * @typedef {'ask-always' | 'ask-if-busy' | 'never'} ExitPolicy
 */

/**
 * How long the official shell waits for the Host's answer before treating the
 * query as failed. Retained as documentation of the behaviour being
 * approximated, even though this shell does not make the query.
 *
 * @type {number}
 */
export const HOST_QUERY_TIMEOUT_MS = 2_000

/**
 * Whether quitting should prompt first.
 *
 * @param {object} options
 * @param {ExitPolicy} options.policy
 * @param {boolean} [options.busy] - whether the kernel looked busy
 * @returns {boolean}
 */
export function shouldConfirmExit({ policy, busy = false }) {
  if (policy === 'never') return false
  if (policy === 'ask-if-busy') return busy
  // Everything else — `ask-always`, and any value that is not a recognised
  // policy — asks. An unrecognised setting must not silently quit.
  return true
}

/**
 * The confirmation text for what quitting would interrupt.
 *
 * The official shell has three variants — running tasks, scheduled reminders,
 * or both. This shell can only distinguish "the kernel looked busy", so it
 * uses the running-tasks wording, which is the case it can actually detect.
 *
 * @param {object} [options]
 * @param {boolean} [options.busy]
 * @returns {{title: string, message: string}}
 */
export function exitConfirmCopy({ busy = false } = {}) {
  return {
    title: '退出 DeepSeek Harness？',
    message: busy
      ? '正在运行的任务将会中断。'
      : '应用关闭期间定时任务不会运行，正在运行的任务将会中断。',
  }
}
