/**
 * Browser half of the desktop controls: a small floating panel that mirrors the
 * tray's actions inside the page.
 *
 * Why plain DOM and not React: this bundle is loaded by the kernel's module
 * loader alongside the web app, and pulling React in would couple it to
 * whatever version the app happens to have resolved. A panel of five buttons
 * does not need a framework, and a bundle that cannot fail to resolve is worth
 * more here than one that is pleasant to write.
 *
 * Every action goes through `window.shell.invoke(name)`, which the preload
 * restricts to a fixed set — the page never touches IPC directly.
 *
 * @module dsh-deepin-controls/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-deepin-controls',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    if (window.__DSH_DEEPIN_CONTROLS__ === true) return exports
    window.__DSH_DEEPIN_CONTROLS__ = true

    var CSS =
      '[data-dsh-deepin-controls]{position:fixed;top:88px;right:16px;z-index:1200;' +
      'font-family:inherit;font-size:13px;color:#1f232b;user-select:none}' +
      '[data-dsh-deepin-controls] [data-trigger]{display:inline-flex;align-items:center;' +
      'gap:6px;min-height:32px;padding:0 11px;border:1px solid rgba(31,35,43,.14);' +
      'border-radius:999px;background:#fff;box-shadow:0 4px 16px rgba(31,35,43,.12);' +
      'cursor:pointer;pointer-events:auto}' +
      '[data-dsh-deepin-controls] [data-panel]{display:none;flex-direction:column;' +
      'min-width:196px;margin-top:6px;padding:6px;border:1px solid rgba(31,35,43,.12);' +
      'border-radius:12px;background:#fff;box-shadow:0 10px 30px rgba(31,35,43,.16);' +
      'pointer-events:auto}' +
      '[data-dsh-deepin-controls][data-open=true] [data-panel]{display:flex}' +
      '[data-dsh-deepin-controls] [data-item]{all:unset;display:flex;justify-content:' +
      'space-between;gap:12px;padding:7px 10px;border-radius:8px;cursor:pointer;' +
      'font:inherit;color:inherit}' +
      '[data-dsh-deepin-controls] [data-item]:hover{background:#f2f4f8}' +
      '[data-dsh-deepin-controls] [data-status]{padding:6px 10px 8px;color:#6d7380;' +
      'font-size:12px;border-top:1px solid rgba(31,35,43,.08);margin-top:4px}'

    var ACTIONS = [
      { action: 'restart-kernel', label: '重启内核' },
      { action: 'check-updates', label: '检查更新…' },
      { action: 'toggle-launch-at-login', label: '开机自启', toggle: true },
      { action: 'show-about', label: '关于' },
      { action: 'hide-window', label: '隐藏窗口' },
      { action: 'quit', label: '退出', danger: true },
    ]

    var PHASE_TEXT = {
      ready: '内核运行中',
      crashed: '恢复已暂停',
      starting: '内核启动中…',
    }

    function statusText(state) {
      if (state === undefined || state === null) return '状态未知'
      var text = PHASE_TEXT[state.phase] || '内核启动中…'
      if (state.phase === 'starting' && state.stage === 'retrying') {
        text = Math.ceil((state.retryDelayMs || 0) / 1000) + ' 秒后重试…'
      }
      if (state.busy === true) text += ' · 有任务在进行'
      return text
    }

    function mount() {
      if (document.body === null) {
        setTimeout(mount, 200)
        return
      }

      var style = document.createElement('style')
      style.textContent = CSS
      document.head.appendChild(style)

      var root = document.createElement('div')
      root.setAttribute('data-dsh-deepin-controls', '')
      root.setAttribute('data-open', 'false')

      var trigger = document.createElement('button')
      trigger.setAttribute('data-trigger', '')
      trigger.textContent = '桌面工具'
      trigger.addEventListener('click', function (event) {
        event.stopPropagation()
        var open = root.getAttribute('data-open') === 'true'
        root.setAttribute('data-open', open ? 'false' : 'true')
      })

      var panel = document.createElement('div')
      panel.setAttribute('data-panel', '')

      var status = document.createElement('div')
      status.setAttribute('data-status', '')
      status.textContent = statusText(undefined)

      ACTIONS.forEach(function (entry) {
        var item = document.createElement('button')
        item.setAttribute('data-item', '')
        item.setAttribute('data-action', entry.action)
        var label = document.createElement('span')
        label.textContent = entry.label
        item.appendChild(label)
        if (entry.toggle === true) {
          var flag = document.createElement('span')
          flag.setAttribute('data-flag', '')
          flag.textContent = '—'
          item.appendChild(flag)
        }
        if (entry.danger === true) item.style.color = '#c0392b'
        item.addEventListener('click', function (event) {
          event.stopPropagation()
          if (typeof window.shell === 'object' && typeof window.shell.invoke === 'function') {
            window.shell.invoke(entry.action)
          }
          root.setAttribute('data-open', 'false')
        })
        panel.appendChild(item)
      })

      panel.appendChild(status)
      root.appendChild(trigger)
      root.appendChild(panel)
      document.body.appendChild(root)

      // Click anywhere else closes the panel.
      document.addEventListener('click', function () {
        root.setAttribute('data-open', 'false')
      })

      if (typeof window.shell === 'object' && typeof window.shell.onState === 'function') {
        window.shell.onState(function (state) {
          status.textContent = statusText(state)
          var flag = panel.querySelector('[data-action="toggle-launch-at-login"] [data-flag]')
          if (flag !== null) flag.textContent = state.launchAtLogin === true ? '开' : '关'
        })
      }

      exports.root = root
    }

    mount()
    exports.marker = 'dsh-deepin-controls-loaded'
  },
})
