/**
 * Tests for the application menu template.
 *
 * The template is plain data, so these assert the structure the official shell
 * describes without constructing an Electron menu.
 *
 * @module app-menu.test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildAppMenuTemplate } from './app-menu.js'

const APP_NAME = 'DeepSeek Harness'

/** @type {import('./app-menu.js').AppMenuActions} */
const noopActions = {
  showAbout: () => {},
  quit: () => {},
  closeWindow: () => {},
  reload: () => {},
  toggleDevTools: () => {},
  checkForUpdates: () => {},
}

/**
 * @param {string} platform
 * @returns {import('./app-menu.js').AppMenuEnvironment}
 */
const env = (platform) => ({ platform, appName: APP_NAME })

/**
 * @param {string} platform
 * @param {string} label
 * @returns {any}
 */
function menu(platform, label) {
  const found = buildAppMenuTemplate(env(platform), noopActions).find(
    (item) => item.label === label,
  )
  assert.ok(found !== undefined, `expected a "${label}" menu on ${platform}`)
  return found
}

describe('buildAppMenuTemplate', () => {
  it('puts About first in the application menu, as the official shell does', () => {
    const template = buildAppMenuTemplate(env('linux'), noopActions)
    const first = /** @type {any} */ (template[0])
    assert.equal(first.label, APP_NAME)
    const firstItem = /** @type {any[]} */ (first.submenu)[0]
    assert.equal(firstItem.label, `关于 ${APP_NAME}`)
  })

  it('keeps the application menu on Linux', () => {
    assert.equal(menu('linux', APP_NAME).label, APP_NAME)
  })

  it('keeps the Edit menu on Linux', () => {
    const edit = menu('linux', '编辑')
    const roles = /** @type {any[]} */ (edit.submenu)
      .filter((item) => item.role !== undefined)
      .map((item) => item.role)
    assert.ok(roles.includes('undo'))
    assert.ok(roles.includes('redo'))
    assert.ok(roles.includes('cut'))
    assert.ok(roles.includes('copy'))
    assert.ok(roles.includes('paste'))
    assert.ok(roles.includes('selectAll'))
  })

  it('keeps a File menu with a close-window entry', () => {
    const file = menu('linux', '文件')
    const labels = /** @type {any[]} */ (file.submenu).map((item) => item.label)
    assert.ok(labels.includes('关闭窗口'))
  })

  it('registers DevTools as a hidden item with both accelerators', () => {
    const view = menu('linux', '视图')
    const devTools = /** @type {any[]} */ (view.submenu).filter(
      (item) => item.click === noopActions.toggleDevTools,
    )
    assert.equal(devTools.length, 2)
    for (const item of devTools) {
      assert.equal(item.visible, false, 'DevTools entries stay out of the menu')
      assert.ok(item.accelerator !== undefined)
    }
    const accelerators = devTools.map((item) => item.accelerator).sort()
    assert.deepEqual(accelerators, ['CmdOrCtrl+Shift+I', 'F12'])
  })

  it('wires every action the caller passed in', () => {
    const template = buildAppMenuTemplate(env('linux'), noopActions)
    const flat = template.flatMap((item) => /** @type {any[]} */ (item.submenu ?? []))
    for (const action of Object.values(noopActions)) {
      assert.ok(
        flat.some((item) => item.click === action),
        'every provided action should be reachable from the menu',
      )
    }
  })

  it('adds macOS-only hide entries without breaking the other platforms', () => {
    const mac = menu('darwin', APP_NAME)
    const macRoles = /** @type {any[]} */ (mac.submenu).map((item) => item.role)
    assert.ok(macRoles.includes('hide'))
    assert.ok(macRoles.includes('hideOthers'))
    assert.ok(macRoles.includes('unhide'))

    const linux = menu('linux', APP_NAME)
    const linuxRoles = /** @type {any[]} */ (linux.submenu)
      .filter((item) => item.role !== undefined)
      .map((item) => item.role)
    assert.deepEqual(linuxRoles, [], 'Linux has no business hiding other apps')
  })
})
