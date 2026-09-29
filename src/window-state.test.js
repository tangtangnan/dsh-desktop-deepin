/**
 * Tests for persisted window geometry.
 *
 * @module window-state.test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  MIN_VISIBLE_PX,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  captureWindowState,
  fitWindowState,
  isVisibleOn,
} from './window-state.js'

/** @type {import('./window-state.js').DisplayArea} */
const display = { x: 0, y: 0, width: 1920, height: 1080 }

describe('isVisibleOn', () => {
  it('accepts a window fully on the display', () => {
    assert.equal(isVisibleOn({ x: 100, y: 100, width: 800, height: 600 }, display), true)
  })

  it('accepts a window dragged mostly off, as long as enough remains', () => {
    assert.equal(
      isVisibleOn({ x: 1920 - MIN_VISIBLE_PX, y: 100, width: 800, height: 600 }, display),
      true,
    )
  })

  it('rejects a window that would be stranded off-screen', () => {
    assert.equal(isVisibleOn({ x: 5000, y: 5000, width: 800, height: 600 }, display), false)
  })

  it('rejects a window with only a sliver visible', () => {
    assert.equal(isVisibleOn({ x: 1920 - 10, y: 100, width: 800, height: 600 }, display), false)
  })
})

describe('fitWindowState', () => {
  it('falls back to the defaults for malformed input', () => {
    for (const input of [null, undefined, 'nonsense', 42]) {
      assert.deepEqual(fitWindowState(input, [display]), {
        width: DEFAULT_WINDOW_WIDTH,
        height: DEFAULT_WINDOW_HEIGHT,
      })
    }
  })

  it('restores a saved size', () => {
    assert.deepEqual(fitWindowState({ width: 1400, height: 900 }, [display]), {
      width: 1400,
      height: 900,
    })
  })

  it('clamps a saved size up to the window minimums', () => {
    const state = fitWindowState({ width: 10, height: 10 }, [display])
    assert.equal(state.width, MIN_WINDOW_WIDTH)
    assert.equal(state.height, MIN_WINDOW_HEIGHT)
  })

  it('rounds fractional sizes', () => {
    const state = fitWindowState({ width: 1400.6, height: 900.2 }, [display])
    assert.equal(state.width, 1401)
    assert.equal(state.height, 900)
  })

  it('reuses a position that is still on a display', () => {
    const state = fitWindowState({ width: 800, height: 600, x: 200, y: 150 }, [display])
    assert.equal(state.x, 200)
    assert.equal(state.y, 150)
  })

  it('drops a position left behind on an unplugged monitor', () => {
    const state = fitWindowState({ width: 800, height: 600, x: 4000, y: 0 }, [display])
    assert.equal(state.x, undefined)
    assert.equal(state.y, undefined)
    assert.equal(state.width, 800)
  })

  it('checks every connected display, not just the first', () => {
    const second = { x: 1920, y: 0, width: 1920, height: 1080 }
    const state = fitWindowState({ width: 800, height: 600, x: 2000, y: 100 }, [display, second])
    assert.equal(state.x, 2000)
  })

  it('preserves the maximized flag', () => {
    const state = fitWindowState({ width: 800, height: 600, isMaximized: true }, [display])
    assert.equal(state.isMaximized, true)
  })

  it('ignores a maximized flag that is not literally true', () => {
    const state = fitWindowState({ width: 800, height: 600, isMaximized: 'yes' }, [display])
    assert.equal(state.isMaximized, undefined)
  })

  it('ignores a position given without both coordinates', () => {
    const state = fitWindowState({ width: 800, height: 600, x: 100 }, [display])
    assert.equal(state.x, undefined)
  })
})

describe('captureWindowState', () => {
  it('captures the normal bounds, not the maximized ones', () => {
    const window = {
      getNormalBounds: () => ({ width: 1000, height: 700, x: 40, y: 60 }),
      isMaximized: () => true,
    }
    assert.deepEqual(captureWindowState(window), {
      width: 1000,
      height: 700,
      x: 40,
      y: 60,
      isMaximized: true,
    })
  })

  it('round-trips through fitWindowState', () => {
    const window = {
      getNormalBounds: () => ({ width: 1200, height: 800, x: 10, y: 20 }),
      isMaximized: () => false,
    }
    const captured = captureWindowState(window)
    const restored = fitWindowState(captured, [display])
    assert.deepEqual(restored, { width: 1200, height: 800, x: 10, y: 20 })
  })
})
