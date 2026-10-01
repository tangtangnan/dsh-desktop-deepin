#!/usr/bin/env node
/**
 * Linux 竞品预警：盯 anywhere-labs/dsh-desktop 的 release 资产。
 *
 * 背景：anywhere-labs（29.7k★ 头部壳）此前零 Linux 产物，2026-10-01 起在
 * -next 预览线挂出 amd64 deb。一旦它发布「非 next 后缀」的稳定 Linux deb
 * （或 arm64），本项目的窗口优势即告失效——需要触发差异化加深预案
 * （玲珑包格式立项、UOS 商店上架加速）。
 *
 * 用法（可挂 crontab，如每日 9:00）：
 *   node tools/watch-competitor.js            # 非稳定 Linux 资产：exit 0（静默）
 *   node tools/watch-competitor.js --strict   # 发现稳定 Linux 资产：exit 1（供 cron 邮件）
 *
 * @module tools/watch-competitor
 */
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'anywhere-labs/dsh-desktop'
const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '.watch-competitor-state.json')
const API = `https://api.github.com/repos/${REPO}/releases?per_page=10`

/** Linux 稳定判据：deb/AppImage/tar.gz 资产、tag 不含 next/beta/rc/alpha。 */
/**
 * @param {Array<{tag_name?: string, assets?: Array<{name: string, size: number, updated_at: string}>}>} releases
 * @returns {Array<{tag: string, asset: string, size: number, updated: string}>}
 */
function stableLinuxAssets(releases) {
  const hits = []
  for (const release of releases) {
    const tag = release.tag_name ?? ''
    if (/next|beta|rc|alpha/i.test(tag)) continue
    for (const asset of release.assets ?? []) {
      if (/\.deb$|\.AppImage$|\.tar\.gz$/i.test(asset.name)) {
        hits.push({ tag, asset: asset.name, size: asset.size, updated: asset.updated_at })
      }
    }
  }
  return hits
}

async function main() {
  const strict = process.argv.includes('--strict')
  const response = await fetch(API, { headers: { 'User-Agent': 'dsh-desktop-deepin-watch' } })
  if (!response.ok) {
    console.error(`watch-competitor: GitHub API ${response.status}`)
    process.exit(2)
  }
  const releases = await response.json()
  const hits = stableLinuxAssets(releases)
  const previous = existsSync(STATE_FILE)
    ? JSON.parse(await readFile(STATE_FILE, 'utf8'))
    : { seen: [] }

  const fresh = hits.filter((h) => !previous.seen.includes(h.asset))
  await writeFile(STATE_FILE, JSON.stringify({ seen: hits.map((h) => h.asset), checkedAt: new Date().toISOString() }, null, 2))

  if (hits.length === 0) {
    console.log(`watch-competitor: ${REPO} 尚无稳定 Linux 产物（预览线不计）。`)
    process.exit(0)
  }
  console.log(`watch-competitor: ⚠ ${REPO} 出现稳定 Linux 资产：`)
  for (const h of hits) console.log(`  ${h.tag} → ${h.asset} (${(h.size / 1024 / 1024).toFixed(1)} MB)`)
  if (fresh.length > 0) {
    console.log(`  其中新出现：${fresh.map((f) => f.asset).join(', ')}`)
    console.log('  → 建议触发差异化预案：玲珑包立项 / UOS 商店加速 / Deepin 深度适配文档化')
    if (strict) process.exit(1)
  }
}

main().catch((error) => {
  console.error('watch-competitor failed:', error.message)
  process.exit(2)
})
