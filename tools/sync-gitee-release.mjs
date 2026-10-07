#!/usr/bin/env node
/**
 * Mirrors the built debs from the AtomGit run to the Gitee release.
 *
 * Why this lives on the AtomGit side rather than on GitHub: the GitHub runner sits
 * outside China, so reaching gitee.com is the flaky part of the old sync job (SSL
 * handshake failures, long timeouts). AtomGit's runners are domestic, so the same
 * upload becomes an ordinary request. See .gitcode/workflows/package-linux.yml.
 *
 * Kept dependency-free (Node built-ins + global fetch + FormData/Blob) so it can be
 * exercised locally with an explicit token instead of only on CI.
 *
 * Required env:
 *   GITEE_TOKEN       - Gitee personal access token (projects scope). When absent the
 *                       script exits 0 with a warning, matching the old best-effort
 *                       behaviour: a missing token must not fail the release job.
 *   ATOMGIT_REF_NAME  - the tag being released (v*), injected by the AtomGit runner.
 * Optional env:
 *   GITEE_REPOSITORY  - owner/repo on Gitee, default westanke/dsh-desktop-deepin
 *   RELEASE_DIR       - directory holding the debs, default ./release
 *
 * @module tools/sync-gitee-release
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const token = process.env.GITEE_TOKEN
const repository = process.env.GITEE_REPOSITORY || 'westanke/dsh-desktop-deepin'
const ref = process.env.ATOMGIT_REF_NAME || process.env.ATOMGIT_REF || ''
const releaseDir = resolve(process.env.RELEASE_DIR || 'release')
const apiBase = (process.env.GITEE_API_URL || 'https://gitee.com/api/v5').replace(/\/+$/, '')

const releaseBody =
  process.env.RELEASE_BODY ||
  'Linux deb（amd64 + arm64）。与 AtomGit Release 同源，由 AtomGit Actions 自动同步。'

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`✖ ${message}`)
  process.exit(1)
}

/** @param {string} message */
function warn(message) {
  console.warn(`⚠ ${message}`)
}

// 未配置令牌时优雅跳过：Gitee 同步是「尽力而为」，不该让发布任务变红。
// 与 GitHub 侧旧 sync-gitee-release 的语义保持一致。
if (!token) {
  warn('未配置 GITEE_TOKEN，跳过 Gitee 同步（AtomGit Release 不受影响）')
  process.exit(0)
}
if (!/^v/.test(ref)) fail(`仅 tag（v*）触发同步，当前 ref=${ref || '(空)'}`)

const tag = ref
const api = `${apiBase}/repos/${repository}`

/**
 * Calls the Gitee REST API. Gitee authenticates via the access_token query parameter.
 *
 * @param {string} path
 * @param {{ method?: string, json?: unknown, form?: FormData }} [options]
 * @returns {Promise<{ ok: boolean, status: number, parsed: any, text: string }>}
 */
async function request(path, { method = 'GET', json, form } = {}) {
  const separator = path.includes('?') ? '&' : '?'
  const url = `${api}${path}${separator}access_token=${encodeURIComponent(token)}`
  /** @type {RequestInit} */
  const init = { method }
  if (json !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(json)
  } else if (form !== undefined) {
    // Let fetch set the multipart boundary itself; Gitee rejects a hand-built one.
    init.body = form
  }

  const res = await fetch(url, init)
  const text = await res.text()
  let parsed = null
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = null
  }
  return { ok: res.ok, status: res.status, parsed, text }
}

/**
 * Finds the release for the tag, creating it when Gitee does not have one yet.
 *
 * @returns {Promise<string>} the release id
 */
async function ensureRelease() {
  const existing = await request(`/releases/tags/${encodeURIComponent(tag)}`)
  if (existing.ok && existing.parsed && existing.parsed.id) {
    console.log(`Gitee release ${tag} 已存在（id=${existing.parsed.id}）`)
    return String(existing.parsed.id)
  }

  console.log(`在 Gitee 创建 release ${tag}`)
  const created = await request('/releases', {
    method: 'POST',
    json: {
      tag_name: tag,
      name: tag,
      body: releaseBody,
      target_commitish: process.env.GITEE_TARGET_COMMITISH || 'main',
    },
  })
  if (!created.ok || !created.parsed || !created.parsed.id) {
    fail(`创建 Gitee release 失败 HTTP ${created.status}: ${created.text.slice(0, 300)}`)
  }
  return String(created.parsed.id)
}

/**
 * Lists the file names already attached to the release, so reruns stay idempotent.
 *
 * @param {string} releaseId
 * @returns {Promise<Set<string>>}
 */
async function existingAssets(releaseId) {
  const res = await request(`/releases/${releaseId}`)
  const names = new Set()
  for (const asset of (res.ok && res.parsed && res.parsed.assets) || []) {
    const name = asset && (asset.name || asset.file_name)
    if (name) names.add(name)
  }
  return names
}

/**
 * Uploads one deb as a multipart attachment.
 *
 * @param {string} releaseId
 * @param {string} file
 * @returns {Promise<boolean>} whether the upload succeeded
 */
async function upload(releaseId, file) {
  const name = basename(file)
  const form = new FormData()
  form.append('file', new Blob([readFileSync(file)]), name)

  const res = await request(`/releases/${releaseId}/attach_files`, { method: 'POST', form })
  if (!res.ok) {
    warn(`上传 ${name} 失败 HTTP ${res.status}: ${res.text.slice(0, 200)}`)
    return false
  }
  console.log(`✔ 已上传 ${name}`)
  return true
}

const releaseId = await ensureRelease()
const already = await existingAssets(releaseId)

/** @type {string[]} */
let debs
try {
  debs = readdirSync(releaseDir)
    .filter((entry) => entry.endsWith('.deb'))
    .sort()
    .map((entry) => join(releaseDir, entry))
} catch {
  fail(`找不到产物目录 ${releaseDir}`)
}
if (debs.length === 0) fail(`产物目录 ${releaseDir} 下没有 .deb 文件`)

let uploaded = 0
let failed = 0
let skipped = 0
for (const file of debs) {
  const name = basename(file)
  if (already.has(name)) {
    console.log(`↷ 跳过 ${name}（Gitee 上已存在同名附件）`)
    skipped += 1
    continue
  }
  const size = (statSync(file).size / 1024 / 1024).toFixed(2)
  console.log(`上传 ${name}（${size} MB）`)
  if (await upload(releaseId, file)) uploaded += 1
  else failed += 1
}

console.log(`Gitee 同步结果：新上传 ${uploaded}，跳过 ${skipped}，失败 ${failed}`)

if (failed > 0) {
  // AtomGit Release 已经发布成功，不该让整个 job 变红误导人；但「Gitee 没收到包」
  // 这件事必须有信号，否则只能靠人想起来去看。与旧实现的 ::warning:: 同义。
  warn(`${failed} 个 deb 未上传到 Gitee，AtomGit Release 不受影响，可稍后手动补传`)
}

console.log(`✅ Gitee Release：https://gitee.com/${repository}/releases/tag/${tag}`)
