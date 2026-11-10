// crawler/policy.js
// 抓勞動力發展署「跨國勞動力權益維護資訊網－政策法令」最新公告，寫入 docs/policy.json。
// 網頁的「聘僱」分頁會依行業列出相關公告；比聘僱指南整理日期還新的公告，會在該行業頁面顯示提醒。
// 有新公告時寫入 data/changes.md，讓 GitHub Actions 開 Issue 通知。
//
// 用法：node crawler/policy.js

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { fetch, Agent } from 'undici';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'policy.json');
const CHANGES = path.join(ROOT, 'data', 'changes.md');
const DEBUG_DIR = path.join(ROOT, 'data', 'debug');
const BASE = 'https://fw.wda.gov.tw';
const LIST = `${BASE}/wda-employer/home/policy`;
const KEEP_MAX = 80;
const UA = 'Mozilla/5.0 (compatible; MigrantPosterHub/1.0)';
// 部分政府網站憑證鏈不完整，與主爬蟲相同做法
const insecure = new Agent({ connect: { rejectUnauthorized: false } });

const pad = (n) => String(n).padStart(2, '0');
function toDate(s) {
  let m = String(s).match(/(20\d{2})\s*[\/.\-年]\s*(\d{1,2})\s*[\/.\-月]\s*(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = String(s).match(/(1\d{2})\s*[\/.\-年]\s*(\d{1,2})\s*[\/.\-月]\s*(\d{1,2})/);
  if (m) return `${Number(m[1]) + 1911}-${pad(m[2])}-${pad(m[3])}`;
  return null;
}

async function get(url) {
  const opts = { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW' }, signal: AbortSignal.timeout(30000) };
  try { return await (await fetch(url, opts)).text(); }
  catch { return await (await fetch(url, { ...opts, dispatcher: insecure })).text(); }
}

function parseList(html) {
  const $ = cheerio.load(html);
  const seen = new Map();
  $('a[href*="/home/policy/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const id = (href.match(/\/home\/policy\/([0-9a-f]{32})/) || [])[1];
    if (!id) return;
    const title = ($(a).attr('title') || $(a).text()).replace(/\[?置頂\]?/g, '').replace(/\s+/g, ' ').trim();
    // 往上找含日期的那一列
    let row = $(a), date = null;
    for (let i = 0; i < 5 && row.length && !date; i++) { row = row.parent(); date = toDate(row.text()); }
    const cur = seen.get(id);
    if (!cur || (title.length > cur.title.length)) seen.set(id, { id, title: title || cur?.title || '', date: date || cur?.date || null, url: `${BASE}/wda-employer/home/policy/${id}` });
  });
  return [...seen.values()].filter((x) => x.title.length >= 6);
}

async function main() {
  let prev = { items: [] };
  try { prev = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch {}
  let html;
  try { html = await get(LIST); } catch (e) { console.log(`政策法令：讀取失敗 ${e.message}，保留舊資料`); return; }
  const found = parseList(html);
  if (!found.length) {
    console.log('政策法令：頁面上找不到公告，保留舊資料（頁面存到 data/debug/policy.html）');
    await fs.mkdir(DEBUG_DIR, { recursive: true });
    await fs.writeFile(path.join(DEBUG_DIR, 'policy.html'), html.slice(0, 60000));
    return;
  }
  const oldIds = new Set(prev.items.map((x) => x.id));
  const firstRun = !prev.items.length;
  const now = new Date().toISOString();
  const fresh = found.filter((x) => !oldIds.has(x.id)).map((x) => ({ ...x, seenAt: now }));
  const keep = prev.items.map((o) => ({ ...o, ...(found.find((x) => x.id === o.id) || {}) }));
  const items = [...fresh, ...keep]
    .sort((a, b) => (b.date || b.seenAt || '').localeCompare(a.date || a.seenAt || ''))
    .slice(0, KEEP_MAX);
  await fs.writeFile(OUT, JSON.stringify({ checkedAt: now, source: LIST, items }, null, 1) + '\n');
  console.log(`政策法令：頁面 ${found.length} 則，新增 ${fresh.length} 則，共保存 ${items.length} 則`);
  for (const x of fresh) console.log(`  + ${x.date}  ${x.title}`);

  if (fresh.length && !firstRun) {
    await fs.mkdir(path.dirname(CHANGES), { recursive: true });
    await fs.appendFile(CHANGES, `## 📢 勞動部政策法令有新公告\n請確認聘僱指南是否需要更新：\n\n${fresh.map((x) => `- ${x.date || ''} [${x.title}](${x.url})`).join('\n')}\n\n`);
  }
}

await main();
