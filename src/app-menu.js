/**
 * The application menu template.
 *
 * The official shell keeps the OS menu bar. Two lines of its README define what
 * this module has to produce:
 *
 *   "应用菜单第一项「关于 DeepSeek Harness」打开 Electron 原生关于面板"
 *   "Linux 保留应用菜单和 Edit 菜单。"
 *   — apps/desktop/README.zh.md
 *
 * This shell used to call `Menu.setApplicationMenu(null)`, which removed the bar
 * entirely. On Linux that was the one place where it contradicted the behaviour
 * it is meant to mirror: the official shell keeps both the application menu and
 * the Edit menu there.
 *
 * The template is a pure function returning `MenuItemConstructorOptions`, so the
 * structure can be asserted without Electron. Building the real menu is left to
 * `main.js`, which owns the actions.
 *
 * Menu text follows the shell's language, which for this build is Chinese.
 *
 * @module app-menu
 */

/**
 * One menu entry. Typed loosely enough for a template: Electron's own
 * `MenuItemConstructorOptions` is a union whose discriminants (`type`, `role`)
 * are string literals, and inferring them from object literals widens them to
 * `string` and fails the assignment.
 *
 * @typedef {Record<string, unknown>} MenuEntry
 */

/**
 * @typedef {object} AppMenuEnvironment
 * @property {string} platform - `process.platform`
 * @property {string} appName - product name, used in the application menu label
 * @property {boolean} [safeMode] - whether Safe Mode is currently on
 */

/**
 * @typedef {object} AppMenuActions
 * @property {() => void} showAbout
 * @property {() => void} quit
 * @property {() => void} closeWindow
 * @property {() => void} reload
 * @property {() => void} toggleDevTools
 * @property {() => void} checkForUpdates
 * @property {() => void} toggleSafeMode
 */

/**
 * Builds the application menu template.
 *
 * The DevTools entry is registered hidden: the official shell exposes F12 and
 * Ctrl+Shift+I "through hidden application menu items" so the shortcut works in
 * packaged builds without advertising the entry.
 *
 * @param {AppMenuEnvironment} environment
 * @param {AppMenuActions} actions
 * @returns {import('electron').MenuItemConstructorOptions[]}
 */
export function buildAppMenuTemplate({ platform, appName, safeMode = false }, actions) {
  const isMac = platform === 'darwin'

  /** The application menu: About first, then updates, then quit. */
  const applicationMenu = /** @type {MenuEntry} */ ({
    label: appName,
    submenu: [
      { label: `关于 ${appName}`, click: actions.showAbout },
      { type: 'separator' },
      { label: '检查更新…', click: actions.checkForUpdates },
      {
        label: safeMode ? '退出安全模式并重启' : '以安全模式重启（停用第三方插件）',
        click: actions.toggleSafeMode,
      },
      { type: 'separator' },
      // macOS-only window and service roles; other platforms have no business
      // pretending to hide other applications.
      ...(isMac
        ? [
            { role: 'services', label: '服务', submenu: [] },
            { type: 'separator' },
            { role: 'hide', label: `隐藏 ${appName}` },
            { role: 'hideOthers', label: '隐藏其他' },
            { role: 'unhide', label: '显示全部' },
            { type: 'separator' },
          ]
        : []),
      {
        label: `退出 ${appName}`,
        accelerator: isMac ? 'Cmd+Q' : 'CmdOrCtrl+Q',
        click: actions.quit,
      },
    ],
  })
  const fileMenu = /** @type {MenuEntry} */ ({
    label: '文件',
    submenu: [{ label: '关闭窗口', accelerator: 'CmdOrCtrl+W', click: actions.closeWindow }],
  })
  // Kept on every platform — the official shell keeps the Edit menu on Linux.
  const editMenu = /** @type {MenuEntry} */ ({
    label: '编辑',
    submenu: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { type: 'separator' },
      { role: 'selectAll', label: '全选' },
    ],
  })
  const viewMenu = /** @type {MenuEntry} */ ({
    label: '视图',
    submenu: [
      { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: actions.reload },
      {
        label: '切换开发者工具',
        accelerator: 'CmdOrCtrl+Shift+I',
        visible: false,
        click: actions.toggleDevTools,
      },
      { label: '开发者工具', accelerator: 'F12', visible: false, click: actions.toggleDevTools },
      { type: 'separator' },
      { role: 'resetZoom', label: '实际大小' },
      { role: 'zoomIn', label: '放大' },
      { role: 'zoomOut', label: '缩小' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '切换全屏' },
    ],
  })
  const windowMenu = /** @type {MenuEntry} */ ({
    label: '窗口',
    submenu: [
      { role: 'minimize', label: '最小化' },
      { role: 'zoom', label: '缩放' },
      { type: 'separator' },
      { role: 'close', label: '关闭' },
    ],
  })
  return [applicationMenu, fileMenu, editMenu, viewMenu, windowMenu]
}
