/**
 * Tests for the multiple-kernel-home machinery.
 *
 * These cover the pure layer — the predicates, the resolution order, and the
 * registry transforms. The parts that touch the filesystem or restart a kernel
 * belong to integration tests; what matters here is that given the same inputs
 * the shell always picks the same home, and that nothing a user can hand it
 * (a missing file, a mangled entry, a path with a slash in it) gets through to
 * become a file somewhere it should not be.
 *
 * @module dsh-home-manager.test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CLI_FLAG,
  DEFAULT_HOME_ID,
  chooseHome,
  describeHomes,
  expandTilde,
  findHome,
  isValidEntry,
  isValidHomeId,
  normalizeRegistry,
  readCliHome,
  registryPath,
  removeHome,
  resolveSubdir,
  setActiveHome,
  upsertHome,
} from './dsh-home-manager.js'

/**
 * @param {Array<object>} homes
 * @returns {{version: number, activeId: string, homes: Array<object>}}
 */
function registry(homes) {
  return { version: 1, activeId: DEFAULT_HOME_ID, homes }
}

describe('expandTilde', () => {
  it('expands a bare tilde to the home directory', () => {
    assert.equal(expandTilde('~', '/home/u'), '/home/u')
  })

  it('expands a tilde-prefixed path', () => {
    assert.equal(expandTilde('~/.dsh', '/home/u'), '/home/u/.dsh')
  })

  it('leaves an absolute path alone', () => {
    assert.equal(expandTilde('/opt/dsh', '/home/u'), '/opt/dsh')
  })

  it('leaves a relative path alone, since relative means under userData', () => {
    assert.equal(expandTilde('kernel-home', '/home/u'), 'kernel-home')
  })
})

describe('resolveSubdir', () => {
  it('uses an absolute value as given', () => {
    assert.equal(
      resolveSubdir({ homeSubdir: '/srv/dsh', userData: '/data/shell' }),
      '/srv/dsh',
    )
  })

  it('expands ~ against the home directory', () => {
    assert.equal(
      resolveSubdir({ homeSubdir: '~/.dsh', userData: '/data/shell', home: '/home/u' }),
      '/home/u/.dsh',
    )
  })

  it('resolves a relative value under userData', () => {
    assert.equal(
      resolveSubdir({ homeSubdir: 'kernel-home', userData: '/data/shell' }),
      '/data/shell/kernel-home',
    )
  })

  // A `~` that reached Node untouched used to be joined onto userData verbatim,
  // creating a directory literally named `~` and starting the kernel against an
  // empty home. This is the regression guard for that.
  it('never produces a stray directory named ~', () => {
    const resolved = resolveSubdir({ homeSubdir: '~/.dsh', userData: '/data/shell', home: '/home/u' })
    assert.ok(!resolved.includes('~'))
  })
})

describe('isValidHomeId', () => {
  it('accepts ordinary identifiers', () => {
    for (const id of ['default', 'work', 'my-home', 'home_2', 'v1.0']) {
      assert.equal(isValidHomeId(id), true, id)
    }
  })

  it('rejects path separators, which would escape the registry file', () => {
    assert.equal(isValidHomeId('a/b'), false)
    assert.equal(isValidHomeId('..\\x'), false)
  })

  it('rejects dot segments', () => {
    assert.equal(isValidHomeId('.'), false)
    assert.equal(isValidHomeId('..'), false)
  })

  it('rejects control characters', () => {
    assert.equal(isValidHomeId('a\u0000b'), false)
    assert.equal(isValidHomeId('a\u007fb'), false)
  })

  it('rejects empty and overlong ids', () => {
    assert.equal(isValidHomeId(''), false)
    assert.equal(isValidHomeId('x'.repeat(65)), false)
  })

  it('rejects non-strings rather than coercing them', () => {
    assert.equal(isValidHomeId(null), false)
    assert.equal(isValidHomeId(7), false)
    assert.equal(isValidHomeId(['a']), false)
  })
})

describe('isValidEntry', () => {
  it('accepts a complete entry', () => {
    assert.equal(isValidEntry({ id: 'work', path: '/srv/dsh' }), true)
  })

  it('rejects a relative path, which would resolve against the wrong base later', () => {
    assert.equal(isValidEntry({ id: 'work', path: 'srv/dsh' }), false)
  })

  it('rejects an entry with no id', () => {
    assert.equal(isValidEntry({ path: '/srv/dsh' }), false)
  })
})

describe('normalizeRegistry', () => {
  it('returns a usable default when the file is absent', () => {
    const result = normalizeRegistry(null, '/home/u/.dsh')
    assert.deepEqual(result.homes, [
      { id: 'default', name: '默认', path: '/home/u/.dsh', builtin: true },
    ])
    assert.equal(result.activeId, DEFAULT_HOME_ID)
  })

  it('returns the default for a corrupted file rather than throwing', () => {
    for (const broken of [undefined, 42, 'nope', ['array']]) {
      const result = normalizeRegistry(broken, '/home/u/.dsh')
      assert.equal(result.activeId, DEFAULT_HOME_ID)
      assert.equal(result.homes.length, 1)
    }
  })

  // The built-in home is also the fallback for every "nothing chose" case, so it
  // is kept first rather than appended wherever the file happened to omit it.
  it('drops unusable rows but keeps usable ones', () => {
    const result = normalizeRegistry(
      {
        homes: [
          { id: 'work', path: '/srv/dsh' },
          { id: 'bad/id', path: '/srv/bad' },
          { id: 'relative', path: 'nope' },
          null,
        ],
      },
      '/home/u/.dsh',
    )
    const ids = result.homes.map((entry) => /** @type {any} */ (entry).id)
    assert.deepEqual(ids, ['default', 'work'])
  })

  it('rejects duplicate ids, keeping the first', () => {
    const result = normalizeRegistry(
      {
        homes: [
          { id: 'work', path: '/srv/one' },
          { id: 'work', path: '/srv/two' },
        ],
      },
      '/home/u/.dsh',
    )
    assert.equal(result.homes.length, 2)
    assert.equal(/** @type {any} */ (findHome(result, 'work')).path, '/srv/one')
  })

  // An activeId naming a row that was dropped would leave the next launch
  // silently using a home the user did not choose.
  it('falls back to the default when the active id no longer exists', () => {
    const result = normalizeRegistry(
      { activeId: 'gone', homes: [{ id: 'work', path: '/srv/dsh' }] },
      '/home/u/.dsh',
    )
    assert.equal(result.activeId, DEFAULT_HOME_ID)
  })

  it('keeps a valid active id', () => {
    const result = normalizeRegistry(
      { activeId: 'work', homes: [{ id: 'work', path: '/srv/dsh' }] },
      '/home/u/.dsh',
    )
    assert.equal(result.activeId, 'work')
  })

  it('always carries the built-in home', () => {
    const result = normalizeRegistry({ homes: [] }, '/home/u/.dsh')
    assert.equal(result.homes.length, 1)
    assert.equal(/** @type {any} */ (result.homes[0]).builtin, true)
  })
})

describe('readCliHome', () => {
  it('reads the joined form', () => {
    assert.equal(readCliHome(['electron', '--dsh-home=/srv/dsh']), '/srv/dsh')
  })

  it('reads the separated form', () => {
    assert.equal(readCliHome(['electron', '--dsh-home', '/srv/dsh']), '/srv/dsh')
  })

  it('ignores a trailing flag with no value', () => {
    assert.equal(readCliHome(['electron', '--dsh-home']), null)
  })

  // Consuming the next switch would break the launch in a way nobody would
  // trace back to this parser.
  it('does not consume the following switch as a path', () => {
    assert.equal(readCliHome(['electron', '--dsh-home', '--no-sandbox']), null)
  })

  it('returns null when the flag is absent', () => {
    assert.equal(readCliHome(['electron', '.']), null)
  })
})

describe('chooseHome', () => {
  const homes = [
    { id: 'default', name: '默认', path: '/home/u/.dsh', builtin: true },
    { id: 'work', name: '工作', path: '/srv/work', builtin: false },
  ]

  it('prefers the command line over everything', () => {
    const result = chooseHome({
      homes,
      activeId: 'work',
      defaultPath: '/home/u/.dsh',
      cliValue: '/tmp/other',
    })
    assert.equal(result.path, '/tmp/other')
    assert.equal(result.source, 'cli')
  })

  it('prefers the environment over the remembered choice', () => {
    const result = chooseHome({
      homes,
      activeId: 'work',
      defaultPath: '/home/u/.dsh',
      envValue: '/from/env',
    })
    assert.equal(result.path, '/from/env')
    assert.equal(result.source, 'env')
  })

  it('uses the remembered home when nothing else asks', () => {
    const result = chooseHome({
      homes,
      activeId: 'work',
      defaultPath: '/home/u/.dsh',
    })
    assert.equal(result.path, '/srv/work')
    assert.equal(result.source, 'registry')
  })

  it('falls back to the configured default', () => {
    const result = chooseHome({ homes, activeId: 'gone', defaultPath: '/home/u/.dsh' })
    assert.equal(result.path, '/home/u/.dsh')
    assert.equal(result.source, 'default')
  })

  // Pointing the shell at a directory nobody has registered is how a new home
  // gets created; falling back would make that impossible to do.
  it('honours an explicit path even when it names nothing known', () => {
    const result = chooseHome({
      homes,
      activeId: 'default',
      defaultPath: '/home/u/.dsh',
      cliValue: '~/brand-new',
      home: '/home/u',
    })
    assert.equal(result.path, '/home/u/brand-new')
    assert.equal(result.id, null)
  })
})

describe('upsertHome', () => {
  it('adds a new home', () => {
    const result = upsertHome(normalizeRegistry(null, '/home/u/.dsh'), {
      id: 'work',
      name: '工作',
      path: '/srv/work',
    })
    assert.equal(result.homes.length, 2)
    assert.equal(/** @type {any} */ (findHome(result, 'work')).path, '/srv/work')
  })

  it('updates an existing home in place', () => {
    const base = upsertHome(normalizeRegistry(null, '/home/u/.dsh'), {
      id: 'work',
      path: '/srv/one',
    })
    const result = upsertHome(base, { id: 'work', path: '/srv/two' })
    assert.equal(result.homes.length, 2)
    assert.equal(/** @type {any} */ (findHome(result, 'work')).path, '/srv/two')
  })

  // The default home's path is derived from config.json on every launch, so
  // letting the registry win would create two sources of truth for one setting.
  it('refuses to retarget the built-in home', () => {
    const base = normalizeRegistry(null, '/home/u/.dsh')
    const result = upsertHome(base, { id: DEFAULT_HOME_ID, path: '/srv/elsewhere' })
    assert.equal(result, base)
  })

  it('rejects an unusable id', () => {
    assert.throws(() => upsertHome(registry([]), { id: 'a/b', path: '/srv/x' }))
  })

  it('rejects an empty path', () => {
    assert.throws(() => upsertHome(registry([]), { id: 'work', path: '' }))
  })

  it('defaults the display name to the id', () => {
    const result = upsertHome(registry([]), { id: 'work', path: '/srv/work' })
    assert.equal(/** @type {any} */ (findHome(result, 'work')).name, 'work')
  })
})

describe('removeHome', () => {
  it('removes a listed home', () => {
    const base = upsertHome(normalizeRegistry(null, '/home/u/.dsh'), {
      id: 'work',
      path: '/srv/work',
    })
    const result = removeHome(base, 'work')
    assert.equal(findHome(result, 'work'), null)
  })

  it('never removes the built-in home', () => {
    const base = normalizeRegistry(null, '/home/u/.dsh')
    assert.equal(removeHome(base, DEFAULT_HOME_ID), base)
  })

  // Otherwise the next launch would carry an activeId resolving to nothing and
  // silently start somewhere else.
  it('falls back to the default when removing the active home', () => {
    const base = setActiveHome(
      upsertHome(normalizeRegistry(null, '/home/u/.dsh'), { id: 'work', path: '/srv/work' }),
      'work',
    )
    const result = removeHome(base, 'work')
    assert.equal(result.activeId, DEFAULT_HOME_ID)
  })

  it('is a no-op for an unknown id', () => {
    const base = normalizeRegistry(null, '/home/u/.dsh')
    assert.deepEqual(removeHome(base, 'nope'), base)
  })
})

describe('setActiveHome', () => {
  it('records a known id', () => {
    const base = upsertHome(normalizeRegistry(null, '/home/u/.dsh'), {
      id: 'work',
      path: '/srv/work',
    })
    assert.equal(setActiveHome(base, 'work').activeId, 'work')
  })

  // Persisting an id that resolves to nothing becomes a silent fallback at the
  // next launch, which is harder to explain than not remembering the choice.
  it('ignores an unknown id rather than storing a dangling one', () => {
    const base = normalizeRegistry(null, '/home/u/.dsh')
    assert.equal(setActiveHome(base, 'nope'), base)
  })
})

describe('describeHomes', () => {
  it('marks the active home and the built-in one', () => {
    const base = setActiveHome(
      upsertHome(normalizeRegistry(null, '/home/u/.dsh'), { id: 'work', path: '/srv/work' }),
      'work',
    )
    const rows = describeHomes(base)
    assert.equal(rows.find((row) => row.id === 'work')?.active, true)
    assert.equal(rows.find((row) => row.id === DEFAULT_HOME_ID)?.builtin, true)
  })

  // Silently keeping one of two identical rows would delete an entry the user
  // believes they added, so the later one carries the flag instead.
  it('flags two entries pointing at one directory instead of dropping either', () => {
    const base = upsertHome(
      upsertHome(normalizeRegistry(null, '/home/u/.dsh'), { id: 'alias', path: '/srv/work' }),
      { id: 'work', path: '/srv/work' },
    )
    const rows = describeHomes(base)
    // `alias` was registered first, so `work` is the one reported as the
    // duplicate — whichever row came second, never both, never neither.
    assert.equal(rows.find((row) => row.id === 'work')?.duplicateOf, 'alias')
    assert.equal(rows.find((row) => row.id === 'alias')?.duplicateOf, null)
  })
})

describe('registryPath', () => {
  it('lives under userData, never inside a DSH_HOME', () => {
    assert.equal(registryPath('/data/shell'), '/data/shell/dsh-homes.json')
  })
})

describe('CLI_FLAG', () => {
  it('is the flag readCliHome looks for', () => {
    assert.equal(CLI_FLAG, '--dsh-home')
    assert.equal(readCliHome([`${CLI_FLAG}=/srv/x`]), '/srv/x')
  })
})
