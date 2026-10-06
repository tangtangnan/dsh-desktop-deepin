/**
 * Multiple kernel homes: let one shell hold several `DSH_HOME` directories and
 * switch between them.
 *
 * The kernel itself has always supported this — it reads `DSH_HOME` from its
 * environment, so pointing it at a different directory is all a second "identity"
 * takes. What was missing was the shell: it resolved `kernel.homeSubdir` once at
 * startup into a `const dshHome` (see `main.js`), so a different home meant a
 * different shell process — and `requestSingleInstanceLock()` made sure there was
 * only ever one of those.
 *
 * This module supplies the missing layer:
 *
 *   - **A registry** of known homes, kept under the shell's own `userData`
 *     (`dsh-homes.json`) rather than inside any `DSH_HOME`. The registry must
 *     live outside the things it lists, or listing them would depend on having
 *     already chosen one.
 *   - **A resolution order** for which home to use, highest priority first:
 *     `--dsh-home` on the command line, then `DSH_HOME` in the shell's own
 *     environment, then the remembered `activeId`, then the built-in default
 *     derived from `config.json`.
 *   - **Pure predicates and selectors**, so the decisions can be tested without
 *     a filesystem, leaving the actual file writes to `main.js`.
 *
 * What it deliberately does *not* do is know how to restart the kernel. Switching
 * homes means telling the supervisor to stop, recomputing paths, and starting
 * again — that orchestration lives in `main.js`, which owns the supervisor.
 *
 * @module dsh-home-manager
 */

import { isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'

/**
 * File the registry is persisted to, relative to the shell's `userData`.
 *
 * Under `userData` on purpose: that directory is per-OS-user and is already the
 * shell's private scratch space, so two OS users never share a registry, and a
 * `DSH_HOME` can be deleted without taking the list down with it.
 *
 * @type {string}
 */
export const REGISTRY_FILE = 'dsh-homes.json'

/**
 * The id of the built-in home.
 *
 * Every install starts with one home — the `config.json`-derived default — and it
 * cannot be removed, because a registry with no entries has nothing to switch to
 * and no answer for "where does the kernel live on the next launch?".
 *
 * @type {string}
 */
export const DEFAULT_HOME_ID = 'default'

/**
 * The command-line flag that selects a home for this launch.
 *
 * It is read from Electron's own arguments, so `--dsh-home=<path>` on the
 * command line (or from a `.desktop` file) opens that profile directly — the
 * mechanism a second launcher shortcut would use.
 *
 * @type {string}
 */
export const CLI_FLAG = '--dsh-home'

/**
 * Expands a leading `~`, which every user writes and Node does not understand.
 *
 * `path.isAbsolute('~/.dsh')` is false, so without this the path was treated as
 * relative and joined onto `userData`, producing a literal directory named `~`
 * inside the shell's data folder. The kernel then started against an empty home
 * and appeared to ignore everything the user had configured.
 *
 * @param {string} path
 * @param {string} [home]
 * @returns {string}
 */
export function expandTilde(path, home = homedir()) {
  if (typeof path !== 'string' || path === '') return path
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

/**
 * Resolves `kernel.homeSubdir` to an absolute `DSH_HOME`.
 *
 * Three cases, matching what users actually write: an absolute path is used
 * as-is, `~` forms are expanded against their home directory, and anything else
 * is relative to the shell's `userData` so it stays private to this shell.
 *
 * @param {object} options
 * @param {string} options.homeSubdir - the configured value
 * @param {string} options.userData - `app.getPath('userData')`
 * @param {string} [options.home] - home directory used to expand `~`
 * @returns {string} an absolute path
 */
export function resolveSubdir({ homeSubdir, userData, home = homedir() }) {
  const raw = typeof homeSubdir === 'string' && homeSubdir !== '' ? homeSubdir : '.dsh'
  const expanded = expandTilde(raw, home)
  return isAbsolute(expanded) ? expanded : join(userData, expanded)
}

/**
 * Whether the character is safe to appear in a home id.
 *
 * Written against character codes rather than a regex: ids end up in filenames,
 * `--patch` values and log lines, and spelling the check out keeps the set of
 * rejected characters visible without relying on escape sequences surviving
 * every editor and tool between here and the reader.
 *
 * @param {string} character
 * @returns {boolean}
 */
function isSafeIdCharacter(character) {
  const code = character.charCodeAt(0)
  // Control characters (including NUL and DEL) and path separators: anything
  // that could break out of the place the id is put.
  if (code < 0x20 || code === 0x7f) return false
  if (character === '/' || character === '\\') return false
  return /^[A-Za-z0-9._-]$/.test(character)
}

/**
 * Whether a string is usable as a home id.
 *
 * Ids appear in filenames, `--patch` arguments and log lines, so anything that
 * could escape — a slash, a dot-segment, a control character — is refused rather
 * than sanitised. Silently renaming would let two distinct inputs collapse onto
 * one file.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidHomeId(id) {
  if (typeof id !== 'string') return false
  if (id === '' || id.length > 64) return false
  if (id === '.' || id === '..') return false
  for (const character of id) {
    if (!isSafeIdCharacter(character)) return false
  }
  return true
}

/**
 * Builds an empty-but-valid registry.
 *
 * @returns {{version: number, activeId: string, homes: Array<object>}}
 */
export function emptyRegistry() {
  return { version: 1, activeId: DEFAULT_HOME_ID, homes: [] }
}

/**
 * Whether `value` has the shape of a registry entry.
 *
 * Entries are validated one at a time rather than with a schema for the whole
 * document: a partially broken file should lose the broken row, not the whole
 * list of homes.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidEntry(value) {
  if (value === null || typeof value !== 'object') return false
  const entry = /** @type {any} */ (value)
  return (
    isValidHomeId(entry.id) &&
    typeof entry.path === 'string' &&
    entry.path !== '' &&
    isAbsolute(entry.path)
  )
}

/**
 * Coerces unknown input into a usable registry, dropping anything unusable.
 *
 * A missing or corrupted file must never prevent the shell from starting: worst
 * case the user gets back the single default home, which is exactly the state a
 * fresh install is in.
 *
 * @param {unknown} raw - parsed `dsh-homes.json`
 * @param {string} fallbackPath - absolute path for the built-in default home
 * @returns {{version: number, activeId: string, homes: Array<object>}}
 */
export function normalizeRegistry(raw, fallbackPath) {
  const fallback = {
    id: DEFAULT_HOME_ID,
    name: '默认',
    path: fallbackPath,
    builtin: true,
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...emptyRegistry(), homes: [fallback] }
  }

  const source = /** @type {any} */ (raw)
  const listed = Array.isArray(source.homes) ? source.homes : []
  /** @type {Array<object>} */
  const homes = []
  const seen = new Set()

  for (const candidate of listed) {
    if (!isValidEntry(candidate)) continue
    const entry = /** @type {any} */ (candidate)
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    homes.push({
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.id,
      path: entry.path,
      builtin: entry.id === DEFAULT_HOME_ID,
    })
  }

  // The built-in home always exists, even if the file predates the concept.
  if (!seen.has(DEFAULT_HOME_ID)) {
    homes.unshift(fallback)
  } else {
    const index = homes.findIndex((entry) => /** @type {any} */ (entry).id === DEFAULT_HOME_ID)
    homes[index] = { .../** @type {any} */ (homes[index]), builtin: true }
  }

  const activeId = isValidHomeId(source.activeId) && seen.has(source.activeId)
    ? source.activeId
    : DEFAULT_HOME_ID

  return { version: 1, activeId, homes }
}

/**
 * Finds a home by id.
 *
 * @param {{homes: Array<object>}} registry
 * @param {string} id
 * @returns {object | null}
 */
export function findHome(registry, id) {
  return registry.homes.find((entry) => /** @type {any} */ (entry).id === id) ?? null
}

/**
 * The `DSH_HOME` this launch should use.
 *
 * The first source that yields anything wins, which is the usual precedence for
 * "the caller asked for something specific" over "what we did last time". The
 * command line leads because it is how a second shortcut, or a one-off debug
 * run, addresses a profile without disturbing the remembered choice.
 *
 * @param {object} options
 * @param {Array<object>} options.homes - registry entries
 * @param {string} options.activeId - the remembered choice
 * @param {string} options.defaultPath - the `config.json`-derived home
 * @param {string | null} [options.cliValue] - value of `--dsh-home`, if given
 * @param {string | undefined} [options.envValue] - `DSH_HOME` in the shell's environment
 * @param {string} [options.home] - home directory used to expand `~`
 * @returns {{path: string, id: string | null, source: string}}
 */
export function chooseHome({
  homes,
  activeId,
  defaultPath,
  cliValue,
  envValue,
  home = homedir(),
}) {
  // An explicit request is used even when it names nothing known: pointing the
  // shell at a directory nobody has registered yet is how a brand-new home gets
  // created, and silently falling back would make that impossible to do.
  //
  // A blank value is treated as absent rather than as a path — matching
  // `resolveDshHome` in `@deepseek-ai/dsh-home-paths`, which rejects
  // whitespace-only overrides for a concrete reason: an empty path resolves
  // against the *current working directory*, so `DSH_HOME="   "` would quietly
  // put the kernel home wherever the launcher happened to be started from.
  if (typeof cliValue === 'string' && cliValue.trim() !== '') {
    return { path: expandTilde(cliValue.trim(), home), id: null, source: 'cli' }
  }
  if (typeof envValue === 'string' && envValue.trim() !== '') {
    return { path: expandTilde(envValue.trim(), home), id: null, source: 'env' }
  }

  const active = homes.find((entry) => /** @type {any} */ (entry).id === activeId)
  if (active !== undefined) {
    return { path: /** @type {any} */ (active).path, id: activeId, source: 'registry' }
  }

  return { path: defaultPath, id: DEFAULT_HOME_ID, source: 'default' }
}

/**
 * Reads `--dsh-home` out of an argument vector.
 *
 * Both `--dsh-home=<path>` and `--dsh-home <path>` are accepted, and a trailing
 * bare flag with no value is ignored rather than consuming the next argument —
 * Electron passes its own switches through here, and eating one would break the
 * launch in a way nobody would trace back to this function.
 *
 * @param {readonly string[]} argv
 * @returns {string | null}
 */
export function readCliHome(argv) {
  if (!Array.isArray(argv)) return null
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (typeof argument !== 'string') continue
    if (argument.startsWith(`${CLI_FLAG}=`)) {
      const value = argument.slice(CLI_FLAG.length + 1)
      return value === '' ? null : value
    }
    if (argument === CLI_FLAG) {
      const next = argv[index + 1]
      if (typeof next === 'string' && next !== '' && !next.startsWith('-')) return next
      return null
    }
  }
  return null
}

/**
 * Adds or updates a home in the registry.
 *
 * The built-in home keeps its own path: it is derived from `config.json` on every
 * launch, so "editing" it would put two sources of truth for one setting in the
 * same file, and the next config edit would silently win.
 *
 * @param {{version: number, activeId: string, homes: Array<object>}} registry
 * @param {{id: string, name?: string, path: string}} entry
 * @returns {{version: number, activeId: string, homes: Array<object>}} a new registry
 */
export function upsertHome(registry, entry) {
  if (!isValidHomeId(entry.id)) throw new Error(`invalid home id: ${String(entry.id)}`)
  if (typeof entry.path !== 'string' || entry.path === '') {
    throw new Error('a home needs a path')
  }

  const index = registry.homes.findIndex((candidate) => /** @type {any} */ (candidate).id === entry.id)
  if (index >= 0 && /** @type {any} */ (registry.homes[index]).builtin) {
    return registry
  }

  const next = {
    id: entry.id,
    name: entry.name ?? entry.id,
    path: entry.path,
    builtin: false,
  }
  const homes = [...registry.homes]
  if (index >= 0) homes[index] = next
  else homes.push(next)

  return { ...registry, homes }
}

/**
 * Removes a home. The built-in one cannot be removed, and deleting the active
 * home falls back to it — a dangling `activeId` would leave the next launch with
 * nothing to resolve.
 *
 * @param {{version: number, activeId: string, homes: Array<object>}} registry
 * @param {string} id
 * @returns {{version: number, activeId: string, homes: Array<object>}}
 */
export function removeHome(registry, id) {
  const target = findHome(registry, id)
  if (target === null || /** @type {any} */ (target).builtin) return registry

  return {
    ...registry,
    homes: registry.homes.filter((entry) => /** @type {any} */ (entry).id !== id),
    activeId: registry.activeId === id ? DEFAULT_HOME_ID : registry.activeId,
  }
}

/**
 * Marks a home as the one to use next launch.
 *
 * Unknown ids are ignored rather than stored: persisting an id that resolves to
 * nothing turns into a silent fallback at the next launch, which is harder to
 * explain than simply not remembering the choice.
 *
 * @param {{version: number, activeId: string, homes: Array<object>}} registry
 * @param {string} id
 * @returns {{version: number, activeId: string, homes: Array<object>}}
 */
export function setActiveHome(registry, id) {
  if (findHome(registry, id) === null) return registry
  return { ...registry, activeId: id }
}

/**
 * Absolute path of the registry file.
 *
 * @param {string} userData - `app.getPath('userData')`
 * @returns {string}
 */
export function registryPath(userData) {
  return resolve(userData, REGISTRY_FILE)
}

/**
 * Menu-ready descriptions of the registry.
 *
 * Duplicated paths are flagged rather than de-duplicated: two entries pointing at
 * one directory are either a mistake or a deliberate alias, and silently keeping
 * only one of them would delete a row the user knows they added.
 *
 * @param {{homes: Array<object>, activeId: string}} registry
 * @returns {Array<{id: string, name: string, path: string, active: boolean, builtin: boolean, duplicateOf: string | null}>}
 */
export function describeHomes(registry) {
  /** @type {Map<string, string>} */
  const firstSeen = new Map()
  return registry.homes.map((entry) => {
    const record = /** @type {any} */ (entry)
    const owner = firstSeen.get(record.path) ?? null
    if (owner === null) firstSeen.set(record.path, record.id)
    return {
      id: record.id,
      name: record.name,
      path: record.path,
      active: record.id === registry.activeId,
      builtin: record.builtin === true,
      duplicateOf: owner,
    }
  })
}
