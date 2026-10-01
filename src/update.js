/**
 * Auto-update wiring for the packaged shell.
 *
 * Modeled on the official dsh-desktop shell, which ships `electron-updater`
 * and points it at the project's GitHub releases (citrusli2026/dsh-desktop).
 * In a source/dev run there is no installer to update, so `checkForUpdates`
 * reports that instead of failing — the tray item must always have a handler.
 *
 * The updater itself is an optional dependency: this module imports it lazily so
 * a build without `electron-updater` installed still launches, and only the
 * "Check for updates" action degrades to a clear message.
 *
 * @module update
 */

import { app, dialog } from 'electron'
import { getConfig } from './config.js'

/**
 * Checks for a newer release and notifies the user.
 *
 * @returns {Promise<void>}
 */
export async function checkForUpdatesAndNotify() {
  if (!app.isPackaged) {
    await dialog.showMessageBox({
      type: 'info',
      title: 'Check for updates',
      message: 'Updates are only checked in a packaged build.',
    })
    return
  }

  const updates = getConfig().updates
  // 本壳的 Linux 发版形态是 deb，升级走 `sudo apt install ./新.deb` 重装；
  // electron-updater 那条链路（指向官方壳的 GitHub Releases）对本壳不适用，
  // config.json 的 updates.enabled 默认 false。关着时菜单点「检查更新」给出
  // 明确指引而不是去查一个别人的仓库。
  if (!updates.enabled) {
    await dialog.showMessageBox({
      type: 'info',
      title: 'Check for updates',
      message: `当前版本 v${app.getVersion()}。\n\n本壳以 deb 形式发布，不使用自动更新；升级请下载新版 deb 后执行：\n  sudo apt install ./DeepSeek-Harness-Desktop-<版本>-amd64.deb\n\n（下载地址见 README 的「下载与安装」章节。）`,
      buttons: ['好的'],
    })
    return
  }

  let autoUpdater
  try {
    ;({ autoUpdater } = await import('electron-updater'))
  } catch {
    await dialog.showErrorBox(
      'Auto-update unavailable',
      'The updater module is not installed in this build. Reinstall the packaged app to enable updates.',
    )
    return
  }

  // The published release feed. Mirrors the official shell's provider config,
  // but every value is read from config.json so the feed can be retargeted
  // without touching code.
  autoUpdater.autoDownload = Boolean(updates.autoDownload)
  // `provider` comes from config.json, so it is a plain string; electron-updater
  // types it as a union. The cast is the boundary where configuration meets
  // the library's contract.
  autoUpdater.setFeedURL({
    provider: /** @type {import('builder-util-runtime').PublishProvider} */ (updates.provider),
    owner: updates.owner,
    repo: updates.repo,
  })

  try {
    const result = await autoUpdater.checkForUpdatesAndNotify()
    if (result?.updateInfo === undefined) {
      await dialog.showMessageBox({
        type: 'info',
        title: 'Up to date',
        message: `You are running v${app.getVersion()}.`,
      })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await dialog.showErrorBox('Update check failed', message)
  }
}
