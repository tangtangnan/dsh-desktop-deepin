/**
 * Tests for the Safe Mode overlay decisions.
 *
 * @module safe-mode.test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { join } from 'node:path'
import {
  PROTECTED_BUNDLES,
  backupName,
  backupPath,
  bundleNames,
  hasSafeModeTargets,
  isProtectedBundle,
  nextBackupPath,
  safeModeTargets,
  toDisablePatch,
} from './safe-mode.js'

const manifest = (/** @type {any[]} */ bundles) => ({ dsh: { profile: { bundles } } })

describe('bundleNames', () => {
  it('reads the bundle list', () => {
    assert.deepEqual(bundleNames(manifest(['a', 'b'])), ['a', 'b'])
  })

  it('returns nothing for a manifest without the field', () => {
    for (const input of [null, {}, { dsh: {} }, { dsh: { profile: {} } }, 'nope']) {
      assert.deepEqual(bundleNames(input), [])
    }
  })

  it('drops entries that are not strings', () => {
    assert.deepEqual(bundleNames(manifest(['a', 42, null, 'b'])), ['a', 'b'])
  })
})

describe('safeModeTargets', () => {
  it('disables everything the user added', () => {
    const targets = safeModeTargets(manifest(['@deepseek-ai/dsh-base', 'dshmarket', 'dsh-im']))
    assert.deepEqual(targets, ['dshmarket', 'dsh-im'])
  })

  it('never disables the kernel layers', () => {
    const targets = safeModeTargets(manifest([...PROTECTED_BUNDLES, 'third-party']))
    assert.deepEqual(targets, ['third-party'])
  })

  it('keeps the web app, without which there is no surface at all', () => {
    assert.ok(PROTECTED_BUNDLES.includes('@deepseek-ai/dsh-web-app'))
    assert.equal(isProtectedBundle('@deepseek-ai/dsh-web-app'), true)
  })

  it('has nothing to do for a clean profile', () => {
    assert.deepEqual(safeModeTargets(manifest([...PROTECTED_BUNDLES])), [])
    assert.equal(hasSafeModeTargets(manifest([...PROTECTED_BUNDLES])), false)
  })

  it('reports work to do when a third-party bundle is present', () => {
    assert.equal(hasSafeModeTargets(manifest(['dshmarket'])), true)
  })
})

describe('toDisablePatch', () => {
  it('addresses each bundle by id alone', () => {
    assert.deepEqual(toDisablePatch(['a', 'b']), [
      { id: 'a', disabled: true },
      { id: 'b', disabled: true },
    ])
  })

  it('produces an empty overlay for nothing', () => {
    assert.deepEqual(toDisablePatch([]), [])
  })
})

describe('backupName', () => {
  it('appends a timestamp that is safe in a filename', () => {
    const name = backupName('/p/cordis.patch.yml', new Date('2026-09-29T08:30:00.000Z'))
    assert.equal(name, 'cordis.patch.yml.bak-2026-09-29T08-30-00-000Z')
    assert.equal(name.includes(':'), false, 'Windows rejects colons')
  })

  it('disambiguates the same second with a sequence number', () => {
    const when = new Date('2026-09-29T08:30:00.000Z')
    assert.equal(backupName('/p/x.yml', when, 0), 'x.yml.bak-2026-09-29T08-30-00-000Z')
    assert.equal(backupName('/p/x.yml', when, 2), 'x.yml.bak-2026-09-29T08-30-00-000Z.2')
  })
})

describe('backupPath', () => {
  it('sits beside the original, so the rename stays on one filesystem', () => {
    const path = backupPath('/home/u/.dsh/profiles/web/cordis.patch.yml', new Date('2026-09-29T00:00:00Z'))
    assert.equal(path, join('/home/u/.dsh/profiles/web', 'cordis.patch.yml.bak-2026-09-29T00-00-00-000Z'))
  })
})

describe('nextBackupPath', () => {
  it('takes the first free name', () => {
    const path = nextBackupPath('/p/x.yml', () => false, new Date('2026-09-29T00:00:00Z'))
    assert.match(path, /x\.yml\.bak-/)
  })

  it('never overwrites an existing backup', () => {
    const taken = new Set(['/p/x.yml.bak-2026-09-29T00-00-00-000Z'])
    const path = nextBackupPath('/p/x.yml', (candidate) => taken.has(candidate), new Date('2026-09-29T00:00:00Z'))
    assert.equal(path, '/p/x.yml.bak-2026-09-29T00-00-00-000Z.1')
  })

  it('refuses to loop forever when every name is taken', () => {
    assert.throws(() => nextBackupPath('/p/x.yml', () => true), /too many backups/)
  })
})
