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
  const updates = getConfig().updates
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
