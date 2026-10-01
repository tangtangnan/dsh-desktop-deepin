/**
 * Reaps orphaned process trees a dead kernel leaves behind.
 *
 * The kernel launches MCP servers through `npm exec` chains (`npm exec X` →
 * `sh -c` → the real server). When the kernel dies without those chains being
 * collected — a crash, the market helper replacing the process — each chain is
 * re-parented to init and lives on forever: every shell restart previously
 * accumulated a fresh crop of `excel-mcp-server` processes nobody owned, even
 * though `KernelProcess.stop()` signals the whole process group on a planned
 * stop (the kernel's MCP children evidently escape that group).
 *
 * This module handles the unplanned cases by *attribution*, not guesswork:
 *
 * 1. The shell injects one marker environment variable into the kernel it
 *    spawns ({@link familyMarkerEnv}). The kernel passes its environment down
 *    to every MCP server it starts, so every process in the shell's family
 *    carries the marker — while a `dsh` the user started from a terminal does
 *    not. The marker must not start with `DSH_`: the kernel strips `DSH_*`
 *    variables before handing the environment to MCP children (verified on a
 *    live chain), so only a neutral name survives the whole tree.
 *    `ELECTRON_USER_DATA` is used because the value — the shell's userData
 *    directory — is stable across restarts, differs between OS users, and is
 *    already observed intact in MCP-server environments.
 * 2. After a kernel death (or at shell start, sweeping what a previous crash
 *    left), the reaper walks `/proc`, collects every process carrying the
 *    marker, and TERMs the trees that can no longer be attributed to a live
 *    kernel — escalating to SIGKILL after a grace period.
 *
 * One policy line is deliberate: a marked process whose command line looks
 * like a kernel (`--profile` + `--port`, the signature {@link module:kernel-runtime}
 * builds) is *never* reaped, even when nothing supervises it. Two shell
 * windows of the same user share one marker value, and the second window's
 * sweep must not kill the first window's kernel; an unsupervised replacement
 * kernel left by the market helper keeps serving its surface and stays a
 * manual cleanup. Only the orphaned *servants* — the MCP chains, the leaks
 * this module exists for — are collected.
 *
 * @module orphan-reaper
 */

/**
 * The environment variable that marks a process as belonging to a kernel this
 * shell spawned. Injected into the kernel's environment; inherited unchanged
 * by every MCP-server descendant.
 *
 * @type {string}
 */
export const MARKER_ENV = 'ELECTRON_USER_DATA'

/**
 * Linux userland jiffies-per-second. `_SC_CLK_TCK` is 100 on every real
 * distribution; `/proc/<pid>/stat` start times are counted in these units.
 *
 * @type {number}
 */
const CLK_TCK = 100

/**
 * The environment to merge into a kernel launch so the whole process family
 * becomes attributable to this shell.
 *
 * A value already present in the shell's own environment wins: the launcher
 * (`start-shell.sh`) sets `ELECTRON_USER_DATA` before starting Electron, so
 * keeping it means the marker matches what every process on this machine has
 * historically carried — and the injected value stays identical across
 * launch paths instead of depending on where `app.getPath('userData')`
 * happens to point.
 *
 * @param {NodeJS.ProcessEnv} parentEnv - the environment the shell itself runs in
 * @param {string} userDataPath - fallback: the shell's userData directory
 * @returns {Record<string, string>} entries to merge into the kernel env
 *   (empty when the parent already carries the marker)
 */
export function familyMarkerEnv(parentEnv, userDataPath) {
  const existing = parentEnv?.[MARKER_ENV]
  if (typeof existing === 'string' && existing !== '') return {}
  return { [MARKER_ENV]: userDataPath }
}

/**
 * The marker value a given shell environment implies — the same decision
 * {@link familyMarkerEnv} makes, read back out for the reaper's lookups.
 *
 * @param {NodeJS.ProcessEnv} parentEnv
 * @param {string} userDataPath
 * @returns {string}
 */
export function markerValueFor(parentEnv, userDataPath) {
  const existing = parentEnv?.[MARKER_ENV]
  return typeof existing === 'string' && existing !== '' ? existing : userDataPath
}

/**
 * @typedef {object} Member
 * @property {number} pid
 * @property {number} ppid
 * @property {string[]} [cmdline] - argument vector, when readable
 * @property {boolean} [young] - spawned too recently to be judged
 */

/**
 * @typedef {object} ReapPlan
 * @property {number[]} doomed - pids to signal, ascending
 * @property {number[]} protectedPids - pids attributable to a live kernel, ascending
 * @property {number[]} young - pids spared because they are too new to judge, ascending
 */

/**
 * Classifies marked processes into orphans to kill and members to spare.
 *
 * A member is protected exactly when the topmost marked process of its
 * ancestor chain is a live kernel: this shell's own kernel (`trustedPid`,
 * taken on the caller's word), or any member whose command line carries the
 * kernel signature. A member whose chain tops out at a process that is
 * neither — init after re-parenting, or a pid that no longer exists (the dead
 * kernel) — is an orphan. Young members are never doomed: the walk races a
 * possible concurrent spawn, and a process younger than a couple of seconds
 * cannot yet be an orphan worth killing.
 *
 * @param {Member[]} members - every process carrying the marker
 * @param {number | null} trustedPid - pid of this shell's kernel while it is
 *   known to be alive; null when reaping after a death or at startup
 * @returns {ReapPlan}
 */
export function buildReapPlan(members, trustedPid = null) {
  const byPid = new Map(members.map((member) => [member.pid, member]))
  const young = []
  const rootCache = new Map()

  /**
   * Topmost marked ancestor: the member whose parent is not itself marked
   * (the parent is init, or no longer exists — e.g. the dead kernel). The
   * `seen` set makes a corrupted /proc cycle terminate.
   *
   * @param {Member} start
   * @returns {Member}
   */
  const rootOf = (start) => {
    const cached = rootCache.get(start.pid)
    if (cached !== undefined) return cached
    const seen = []
    let current = start
    for (;;) {
      seen.push(current.pid)
      const parent = byPid.get(current.ppid)
      if (parent === undefined || seen.includes(parent.pid)) break
      current = parent
    }
    for (const pid of seen) rootCache.set(pid, current)
    return current
  }

  /**
   * A root is a live kernel when it is this shell's trusted kernel, or when
   * its command line carries the kernel signature. The signature check is
   * what keeps a second shell window's family safe.
   *
   * @param {Member} member
   * @returns {boolean}
   */
  const isLiveKernel = (member) => {
    if (member.pid === trustedPid) return true
    return looksLikeKernel(member.cmdline)
  }

  /** @type {number[]} */
  const doomed = []
  /** @type {number[]} */
  const protectedPids = []
  for (const member of members) {
    if (member.young === true) {
      young.push(member.pid)
    } else if (isLiveKernel(rootOf(member))) {
      protectedPids.push(member.pid)
    } else {
      doomed.push(member.pid)
    }
  }
  return {
    doomed: doomed.sort((a, b) => a - b),
    protectedPids: protectedPids.sort((a, b) => a - b),
    young: young.sort((a, b) => a - b),
  }
}

/**
 * Whether an argument vector matches the kernel signature
 * {@link module:kernel-runtime}~buildKernelArgs produces: `--profile web ...
 * --port N`. MCP servers and their `npm exec` wrappers never carry both
 * flags.
 *
 * @param {string[]} [cmdline]
 * @returns {boolean}
 */
export function looksLikeKernel(cmdline) {
  if (cmdline === undefined) return false
  return cmdline.includes('--profile') && cmdline.includes('--port')
}

/**
 * @typedef {object} ProcIo
 * @property {(p: string) => Promise<string[]>} readdir
 * @property {(pid: number) => Promise<Buffer>} readEnviron
 * @property {(pid: number) => Promise<string>} readStat
 * @property {(pid: number) => Promise<Buffer>} readCmdline
 * @property {() => Promise<number>} readUptime - /proc/uptime in seconds
 */

/** Default /proc access; every method re-imports lazily so tests can inject. */
/** @type {ProcIo} */
const procIo = {
  readdir: (path) => import('node:fs/promises').then((fs) => fs.readdir(path)),
  readEnviron: (pid) =>
    import('node:fs/promises').then((fs) => fs.readFile(`/proc/${String(pid)}/environ`)),
  readStat: (pid) =>
    import('node:fs/promises').then((fs) => fs.readFile(`/proc/${String(pid)}/stat`, 'utf8')),
  readCmdline: (pid) =>
    import('node:fs/promises').then((fs) => fs.readFile(`/proc/${String(pid)}/cmdline`)),
  readUptime: () =>
    import('node:fs/promises')
      .then((fs) => fs.readFile('/proc/uptime', 'utf8'))
      .then((raw) => Number(raw.trim().split(/\s+/)[0])),
}

/**
 * Walks /proc and collects every process carrying the marker.
 *
 * Entries that vanish mid-walk, or belong to another user (EACCES), are
 * skipped silently — a snapshot does not have to be complete, it only has to
 * never invent a member.
 *
 * @param {object} options
 * @param {string} options.marker - the marker *value* to look for
 * @param {number} options.uptimeSeconds - /proc/uptime at walk start, for the
 *   young-process guard
 * @param {number} options.youngMs - processes younger than this are flagged
 *   young and never killed
 * @param {ProcIo} [options.io] - injectable /proc access, for tests
 * @returns {Promise<Member[]>}
 */
export async function collectMarkedMembers({ marker, uptimeSeconds, youngMs, io = procIo }) {
  /** @type {Member[]} */
  const members = []
  /** @type {string[]} */
  let entries = []
  try {
    entries = await io.readdir('/proc')
  } catch {
    return members
  }
  for (const entry of entries) {
    const pid = Number(entry)
    if (!Number.isInteger(pid) || pid <= 0) continue
    let envBuf
    try {
      envBuf = await io.readEnviron(pid)
    } catch {
      continue
    }
    if (!hasMarker(envBuf, marker)) continue
    /** @type {Member} */
    const member = { pid, ppid: 0 }
    try {
      const parsed = parseStat(await io.readStat(pid))
      if (parsed === null) {
        // Unparseable stat: no ppid and no age. Judge by chain alone, but
        // never kill a process whose age could not be established while a
        // spawn may be in flight.
        member.young = true
      } else {
        member.ppid = parsed.ppid
        const ageMs = (uptimeSeconds - parsed.startTimeTicks / CLK_TCK) * 1000
        if (ageMs < youngMs) member.young = true
      }
    } catch {
      member.ppid = 0
      member.young = true
    }
    try {
      const cmdBuf = await io.readCmdline(pid)
      member.cmdline = cmdBuf.toString('utf8').split('\0').filter((part) => part !== '')
    } catch {
      // Command line is optional; only the live-kernel check uses it.
    }
    members.push(member)
  }
  return members
}

/**
 * Whether a raw /proc/<pid>/environ buffer carries the exact marker entry.
 *
 * @param {Buffer} envBuf
 * @param {string} marker
 * @returns {boolean}
 */
function hasMarker(envBuf, marker) {
  const expected = `${MARKER_ENV}=${marker}`
  for (const entry of envBuf.toString('utf8').split('\0')) {
    if (entry === expected) return true
  }
  return false
}

/**
 * Parses the fields /proc/<pid>/stat exposes beyond the comm field. `comm`
 * may contain spaces and parentheses, so everything up to the *last* `)` is
 * skipped; after it, token k corresponds to stat field k+2 (state = field 3
 * is token 0).
 *
 * @param {string} stat
 * @returns {{ppid: number, startTimeTicks: number} | null}
 */
export function parseStat(stat) {
  const close = stat.lastIndexOf(')')
  if (close < 0) return null
  const tokens = stat.slice(close + 1).trim().split(/\s+/)
  const ppid = Number(tokens[1])
  const startTimeTicks = Number(tokens[19])
  if (!Number.isInteger(ppid) || !Number.isInteger(startTimeTicks)) return null
  return { ppid, startTimeTicks }
}

/**
 * Finds and kills the orphaned trees of dead kernels.
 *
 * Best-effort by construction: every failure path returns a report instead of
 * throwing, so a reaper hiccup can never worsen the crash it is cleaning up
 * after.
 *
 * @param {object} [options]
 * @param {string} options.marker - the marker value this shell injects
 * @param {number | null} [options.kernelPid] - pid of this shell's kernel while
 *   it is alive; null when reaping after a death or at startup
 * @param {number} [options.youngMs]
 * @param {number} [options.graceMs] - how long to wait after SIGTERM before
 *   escalating to SIGKILL
 * @param {(message: string) => void} [options.log]
 * @param {string} [options.platform] - overridable for tests; the reaper is a
 *   no-op on Windows, where `taskkill /T` already walks the tree by pid
 * @param {ProcIo} [options.io] - injectable /proc access, for tests
 * @returns {Promise<{doomed: number[], killed: number[], survived: number[], skipped: string | null}>}
 */
export async function reapOrphans({
  marker,
  kernelPid = null,
  youngMs = 2_000,
  graceMs = 2_000,
  log = () => undefined,
  platform = process.platform,
  io = procIo,
} = /** @type {any} */ ({})) {
  if (platform === 'win32') {
    return { doomed: [], killed: [], survived: [], skipped: 'windows' }
  }
  try {
    const uptimeSeconds = await io.readUptime()
    const members = await collectMarkedMembers({ marker, uptimeSeconds, youngMs, io })
    if (members.length === 0) {
      return { doomed: [], killed: [], survived: [], skipped: 'no-marked-processes' }
    }

    const plan = buildReapPlan(members, kernelPid !== null && pidAlive(kernelPid) ? kernelPid : null)
    if (plan.doomed.length === 0) {
      return { doomed: [], killed: [], survived: [], skipped: null }
    }

    log(`reaping ${String(plan.doomed.length)} orphaned process(es): ${plan.doomed.join(', ')}`)
    for (const pid of plan.doomed) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // Gone already, or not ours — either way nothing to reap.
      }
    }

    const survivors = await waitWhileAlive(plan.doomed, graceMs)
    /** @type {number[]} */
    let killed = []
    if (survivors.length > 0) {
      log(`SIGTERM ignored by ${survivors.join(', ')}, escalating to SIGKILL`)
      for (const pid of survivors) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
      await waitWhileAlive(survivors, 500)
      killed = survivors.filter((pid) => !pidAlive(pid))
    }
    const survived = survivors.filter((pid) => pidAlive(pid))
    if (survivors.length === 0) {
      log(`all ${String(plan.doomed.length)} orphaned process(es) exited cleanly`)
    }
    return { doomed: plan.doomed, killed, survived, skipped: null }
  } catch (error) {
    log(`reap failed: ${error instanceof Error ? error.message : String(error)}`)
    return { doomed: [], killed: [], survived: [], skipped: 'error' }
  }
}

/**
 * @param {number[]} pids
 * @param {number} timeoutMs
 * @returns {Promise<number[]>} the pids still alive when the wait ended
 */
async function waitWhileAlive(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let remaining = pids.filter((pid) => pidAlive(pid))
  while (remaining.length > 0 && Date.now() < deadline) {
    await delay(Math.min(100, deadline - Date.now()))
    remaining = remaining.filter((pid) => pidAlive(pid))
  }
  return remaining
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // Do not hold the event loop open purely to wait out a timeout.
    timer.unref?.()
  })
}
