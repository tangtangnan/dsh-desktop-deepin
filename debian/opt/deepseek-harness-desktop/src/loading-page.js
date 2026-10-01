/**
 * The pages the shell shows before the kernel is answering, and when it never
 * gets there.
 *
 * Ported in spirit from the official dsh-desktop shell, which loads a built-in
 * loading page first and an error page on failure, instead of pointing the
 * window at a URL that may not be serving yet and letting the user look at
 * whatever the browser does with that.
 *
 * Both pages are handed to `loadURL` as `data:` URLs — they need nothing from
 * the network and nothing from the kernel, which is the point: they have to
 * work precisely when the kernel does not. The inline CSP forbids everything
 * but the styles, so a page shown in an error path cannot itself become one.
 *
 * @module loading-page
 */

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #1b1b1f; color: #e8e8ea;
    font: 15px/1.6 system-ui, -apple-system, "Segoe UI", "Noto Sans CJK SC", sans-serif; }
  main { width: min(560px, 88vw); padding: 32px; }
  .brand { letter-spacing: .18em; font-size: 12px; opacity: .55; margin-bottom: 18px; }
  h1 { font-size: 19px; margin: 0 0 10px; font-weight: 600; }
  p { margin: 0 0 14px; opacity: .8; }
  .stage { display: inline-flex; align-items: center; gap: 10px; opacity: .9; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #4c8dff;
    animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: .35; } 50% { opacity: 1; } }
  pre { max-height: 34vh; overflow: auto; padding: 12px 14px; border-radius: 8px;
    background: rgba(255,255,255,.06); font: 12px/1.55 ui-monospace, monospace;
    white-space: pre-wrap; word-break: break-word; margin: 0 0 16px; }
  .label { font-size: 12px; opacity: .55; margin: 18px 0 6px; }
  .elapsed { font-size: 12px; opacity: .45; margin-top: 10px; font-variant-numeric: tabular-nums; }
  .log { margin-top: 22px; width: min(760px, 82vw); height: 220px; overflow-y: auto;
    text-align: left; font: 11.5px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: rgba(127,127,127,.08); border: 1px solid rgba(127,127,127,.18);
    border-radius: 8px; padding: 10px 12px; opacity: .8; white-space: pre-wrap;
    word-break: break-all; scrollbar-width: thin; }
  .log:empty { display: none; }
  .log .l { opacity: .85; }
  .log .l.err { color: #e06c75; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  button { padding: 7px 14px; border-radius: 7px; border: 1px solid rgba(255,255,255,.18);
    background: rgba(255,255,255,.08); color: inherit; font: inherit; cursor: pointer; }
  button:hover { background: rgba(255,255,255,.14); }
  button.primary { background: #2f6fe4; border-color: #2f6fe4; }
  button[disabled] { opacity: .5; cursor: default; }
  .hint { font-size: 13px; opacity: .7; min-height: 1.4em; margin-top: 12px; }
`

/**
 * Escapes text destined for the page body.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Wraps an HTML fragment as a `data:` URL safe to hand to `loadURL`.
 *
 * @param {string} html
 * @returns {string}
 */
function asDataUrl(html) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

/**
 * The page shown while the kernel starts.
 *
 * @param {object} [options]
 * @param {'preparing' | 'launching' | 'waiting-for-ready' | 'retrying'} [options.stage]
 * @param {number} [options.retryDelayMs] - only meaningful for `retrying`
 * @param {number} [options.startedAt] - epoch millis the wait began, so the
 *   elapsed counter is continuous across page swaps
 * @returns {string} a `data:` URL
 */
export function loadingPageHtml({ stage = 'launching', retryDelayMs = 0, startedAt = 0 } = {}) {
  const text =
    stage === 'preparing'
      ? '正在准备启动…'
      : stage === 'waiting-for-ready'
        ? '正在等待内核就绪…'
        : stage === 'retrying'
          ? `内核退出，${Math.ceil(retryDelayMs / 1000)} 秒后重试…`
          : '正在启动内核…'

  // The elapsed counter, and the hook the shell uses to advance this page
  // through the stages *without reloading it*.
  //
  // Reloading is what made the stages invisible: each `loadURL` replaced the
  // document, so the counter restarted and the early stages were gone before
  // they could be read. `window.__dshStage(stage, retryDelayMs)` updates the
  // text in place, so one document lives for the whole startup and the
  // counter never resets.
  //
  // The script is inline and dependency-free because the page is a `data:` URL
  // under `default-src 'none'`.
  const since = Number.isFinite(startedAt) && startedAt > 0 ? startedAt : 0
  const script =
    `<script>(function(){var t0=${since || 'Date.now()'};` +
    `var el=document.getElementById('elapsed');var st=document.getElementById('stage-text');` +
    `function pad(n){return n<10?'0'+n:''+n}` +
    `function elapsed(){if(!el)return;var s=Math.floor((Date.now()-t0)/1000);` +
    `el.textContent=s<60?('已等待 '+s+' 秒'):('已等待 '+Math.floor(s/60)+' 分 '+pad(s%60)+' 秒')}` +
    `function setText(t){if(st)st.textContent=t}` +
    `window.__dshStage=function(stage,retryMs){` +
    `if(stage==='preparing')setText('正在准备启动…');` +
    `else if(stage==='waiting-for-ready')setText('正在等待内核就绪…');` +
    `else if(stage==='retrying')setText('内核退出，'+Math.ceil((retryMs||0)/1000)+' 秒后重试…');` +
    `else setText('正在启动内核…');elapsed()};` +
    `window.__dshLog=function(line,isErr){var box=document.getElementById('log');if(!box)return;` +
    `var d=document.createElement('div');d.className='l'+(isErr?' err':'');d.textContent=line;` +
    `box.appendChild(d);while(box.childNodes.length>400)box.removeChild(box.firstChild);` +
    `box.scrollTop=box.scrollHeight};` +
    `elapsed();setInterval(elapsed,1000)})()<\/script>`

  return asDataUrl(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <title>DeepSeek Harness Desktop</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
    <style>${STYLE}</style></head>
    <body><main>
      <div class="brand">DEEPSEEK HARNESS</div>
      <div class="stage"><span class="dot"></span><span id="stage-text">${escapeHtml(text)}</span></div>
      <div class="elapsed" id="elapsed"></div>
      <div class="log" id="log"></div>
      ${script}
    </main></body></html>`)
}

/**
 * The page shown when the kernel will not start, carrying the log tail so the
 * failure is visible without hunting for a file.
 *
 * @param {object} options
 * @param {number} [options.attempts] - restart attempts made
 * @param {string} [options.logTail] - recent kernel output
 * @returns {string} a `data:` URL
 */
export function errorPageHtml({ attempts = 0, logTail = '' } = {}) {
  const body =
    attempts > 0
      ? `内核连续退出 ${attempts} 次，已停止自动重启。`
      : '内核启动失败，未能就绪。'

  return asDataUrl(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <title>DeepSeek Harness Desktop — 启动失败</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
    <style>${STYLE}</style></head>
    <body><main>
      <div class="brand">DEEPSEEK HARNESS</div>
      <h1>内核没能起来</h1>
      <p>${escapeHtml(body)}</p>
      <div class="label">内核输出（尾部）</div>
      <pre>${escapeHtml(logTail)}</pre>
      <div class="actions">
        <button class="primary" type="button" onclick="retry()">重试</button>
        <button type="button" onclick="quit()">退出</button>
      </div>
      <p class="hint" id="hint"></p>
      <script>
        function retry() {
          var hint = document.getElementById('hint');
          var button = document.querySelector('button');
          button.disabled = true;
          hint.textContent = '正在重试…';
          var bridge = window.dshShell && window.dshShell.retryKernel;
          if (!bridge) { hint.textContent = '重试不可用，请手动重启应用。'; return; }
          Promise.resolve(bridge())
            .then(function (ok) {
              if (ok !== true) {
                button.disabled = false;
                hint.textContent = '重试未成功，请查看日志或重启应用。';
              }
            })
            .catch(function () {
              button.disabled = false;
              hint.textContent = '重试出错，请查看日志。';
            });
        }
        function quit() {
          var bridge = window.dshShell && window.dshShell.quit;
          if (bridge) bridge();
        }
      </script>
    </main></body></html>`)
}
