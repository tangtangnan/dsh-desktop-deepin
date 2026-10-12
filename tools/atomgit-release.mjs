#!/usr/bin/env node
/**
 * Publishes the release for the current tag and uploads the built debs.
 *
 * Runs inside the AtomGit Actions runner, where the platform injects ATOMGIT_TOKEN and
 * the ATOMGIT_* context variables. The logic lives here rather than in the workflow YAML
 * so both architectures share one upload path, and so it can be exercised locally with an
 * explicit token (see --help in the repo docs) instead of only being debuggable on CI.
 *
 * The GitHub workflow uses softprops/action-gh-release; AtomGit has no equivalent action,
 * so this talks to the same REST API the platform exposes (v5 releases + OBS presigned
 * upload URL). Kept dependency-free: only Node built-ins plus the global fetch.
 *
 * @module tools/atomgit-release
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const token = process.env.ATOMGIT_TOKEN
const apiBase = (process.env.ATOMGIT_API_URL || 'https://api.atomgit.com').replace(/\/+$/, '')
const repo = process.env.ATOMGIT_REPOSITORY
const ref = process.env.ATOMGIT_REF_NAME || process.env.ATOMGIT_REF || ''
const releaseDir = resolve(process.env.RELEASE_DIR || 'release')
const releaseBody =
  process.env.RELEASE_BODY || 'Linux deb（amd64 + arm64）。由 AtomGit Actions 自动构建并发布。'

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`✖ ${message}`)
  process.exit(1)
}

if (!token) fail('ATOMGIT_TOKEN 未设置（该脚本预期只在 AtomGit Actions Runner 中运行）')
if (!repo) fail('ATOMGIT_REPOSITORY 未设置')
if (!/^v/.test(ref)) fail(`仅 tag（v*）触发发布，当前 ref=${ref || '(空)'}`)

const tag = ref
const api = `${apiBase}/api/v5/repos/${repo}`

/**
 * Calls the AtomGit REST API with the runner token.
 *
 * @param {string} path
 * @param {{ method?: string, json?: unknown }} [options]
 * @returns {Promise<{ ok: boolean, status: number, parsed: any, text: string }>}
 */
async function request(path, { method = 'GET', json } = {}) {
  /** @type {Record<string, string>} */
  const headers = { Authorization: `Bearer ${token}` }
  /** @type {RequestInit} */
  const init = { method, headers }
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(json)
  }

  const res = await fetch(`${api}${path}`, init)
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
 * Creates the release for the tag, or refreshes its notes when it already exists.
 *
 * @returns {Promise<void>}
 */
async function ensureRelease() {
  const existing = await request(`/releases/tags/${encodeURIComponent(tag)}`)
  if (existing.ok && existing.parsed && existing.parsed.tag_name) {
    console.log(`Release ${tag} 已存在，更新描述`)
    const updated = await request(`/releases/${encodeURIComponent(tag)}`, {
      method: 'PATCH',
      json: { name: tag, body: releaseBody },
    })
    if (!updated.ok) {
      console.warn(`⚠ 更新 release 描述失败 HTTP ${updated.status}，继续上传附件`)
    }
    return
  }

  console.log(`创建 Release ${tag}`)
  const created = await request('/releases', {
    method: 'POST',
    json: { tag_name: tag, name: tag, body: releaseBody },
  })
  if (!created.ok) fail(`创建 release 失败 HTTP ${created.status}: ${created.text.slice(0, 300)}`)
}

/**
 * Uploads one file to the release through the platform's presigned OBS URL.
 *
 * @param {string} file
 * @returns {Promise<void>}
 */
async function upload(file) {
  const name = basename(file)
  const upload = await request(
    `/releases/${encodeURIComponent(tag)}/upload_url?file_name=${encodeURIComponent(name)}`,
  )
  if (!upload.ok || !upload.parsed || !upload.parsed.url) {
    fail(`获取 ${name} 的上传地址失败 HTTP ${upload.status}: ${upload.text.slice(0, 200)}`)
  }

  const headers = { ...(upload.parsed.headers || {}) }
  if (!headers['Content-Type']) headers['Content-Type'] = 'application/octet-stream'

  const res = await fetch(upload.parsed.url, {
    method: 'PUT',
    headers,
    body: readFileSync(file),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    fail(`上传 ${name} 失败 HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  console.log(`✔ 已上传 ${name}`)
}

await ensureRelease()

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

for (const file of debs) {
  const size = (statSync(file).size / 1024 / 1024).toFixed(2)
  console.log(`准备上传 ${basename(file)}（${size} MB）`)
}

for (const file of debs) await upload(file)

const server = (process.env.ATOMGIT_SERVER_URL || 'https://atomgit.com').replace(/\/+$/, '')
console.log(`✅ Release 发布完成：${server}/${repo}/releases/tag/${tag}`)