// crawler/laws.js
// 從「全國法規資料庫」自動更新移工相關法規，寫入 docs/laws.json：
//   1. items：移工相關法規清單與最新修正日期（逐一掃描勞動部法規代碼，依標題篩選，法規改名或新增不用改程式）
//   2. chapters：聘僱指南各行業對應的「法條原文」（依 docs/guides.json 的 src 設定，整章擷取）
//      每天比對條文內容，有變動就記下 changedAt，網頁會提醒「法條已修正」，並寫入 data/changes.md 讓 GitHub 開 Issue 通知。
//
// 用法：node crawler/laws.js

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { fetch } from 'undici';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'laws.json');
const GUIDES = path.join(ROOT, 'docs', 'guides.json');
const CHANGES = path.join(ROOT, 'data', 'changes.md');
const DEBUG_DIR = path.join(ROOT, 'data', 'debug');
const UA = 'Mozilla/5.0 (compatible; MigrantPosterHub/1.0)';

// 要掃描的法規代碼範圍
const RANGES = [
  { prefix: 'N009', from: 1, to: 99 },  // 就業服務類
  { prefix: 'N003', from: 1, to: 60 },  // 勞動條件類（勞基法、最低工資法等）
];
// 標題符合這些字才收錄
const KEEP = /外國人|外國技術人力|移工|就業服務法|就業安定|轉換雇主|私立就業服務機構|勞動基準法$|最低工資法|聘僱/;
const SKIP = /大陸地區|香港|澳門|專業人才|身心障礙|獎勵|補助|津貼|補習班|演藝|個人資料/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const roc = (y, m, d) => `${Number(y) + 1911}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const clean = (s) => String(s || '').replace(/[ \t　 ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();

async function getHtml(pcode) {
  const url = `https://law.moj.gov.tw/LawClass/LawAll.aspx?PCode=${pcode}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) return null;
  return { url, html: await res.text() };
}

function readLaw(pcode, url, html) {
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ');
  let title = ($('#hlLawName').text() || (text.match(/法規名稱[：:]\s*(.+?)\s+(?:EN\s+)?(?:修正日期|公布日期|發布日期|公發布日|制定日期|廢止日期)/) || [])[1] || $('title').text().split(/[-|－]/)[0]).trim();
  if (!title || /查無|錯誤|Error/i.test(title)) return null;
  // 已廢止：標題前面有「廢」、或有廢止日期、或類別是廢止法規
  if (/^廢\s/.test(title) || /廢止日期[：:]|廢止法規\s*＞/.test(text)) return null;
  title = title.replace(/（[\d.]+(?:制定|修正)）$/, '').trim();
  const m = text.match(/修正日期[：:]\s*民國\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日/) || text.match(/(?:公布日期|發布日期|公發布日|制定日期)[：:]\s*民國\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日/);
  return { pcode, title, amended: m ? roc(m[1], m[2], m[3]) : null, url };
}

// ---------- 條文擷取 ----------
// 把法規全文拆成「標題（章、節）」與「條文」的序列
const HEAD_RE = /^第\s*[一二三四五六七八九十百零]+\s*(章|節)(?:\s*之\s*[一二三四五六七八九十]+)?\s*(.*)$/;
const ART_RE = /^第\s*(\d+(?:\s*-\s*\d+)?)\s*條$/;

function splitLaw(html) {
  const $ = cheerio.load(html);
  const out = [];
  // 方法一：依網頁結構（條文 div.row > .col-no / .col-data；章節標題是 .row 以外、文字為「第 N 章 名稱」的元素）
  const box = $('.law-reg-content').first();
  if (box.length) {
    box.find('*').each((_, el) => {
      const $el = $(el);
      if ($el.hasClass('row') && $el.find('.col-no').length) {
        const no = clean($el.find('.col-no').first().text());
        const m = no.match(/第\s*(\d+(?:\s*-\s*\d+)?)\s*條/);
        if (!m) return;
        const lines = $el.find('.col-data [class^="line-"], .col-data [class*=" line-"]').map((_, l) => clean($(l).text())).get().filter(Boolean);
        out.push({ type: 'art', no: m[1].replace(/\s/g, ''), text: lines.length ? lines.join('\n') : clean($el.find('.col-data').text()) });
        return;
      }
      if ($el.closest('.row').length) return;
      if ($el.children().length && !$el.children().toArray().every((c) => /^(?:a|span|b|strong|font)$/i.test(c.tagName))) return;
      const h = clean($el.text()).replace(/\n/g, ' ');
      if (h.length > 60) return;
      const m = h.match(HEAD_RE);
      if (m && m[2] && out.at(-1)?.name !== m[2].trim()) out.push({ type: m[1], name: m[2].trim() });
    });
  }
  if (out.some((x) => x.type === 'art')) return out;
  return splitText(html);
}

// 方法二：網頁結構改了的備案——從純文字依「第 N 章／第 N 條」切開
function splitText(html) {
  const $ = cheerio.load(html);
  $('script,style,noscript').remove();
  $('br').replaceWith('\n');
  $('div,p,li,tr,h1,h2,h3,h4,h5,a').each((_, el) => { $(el).append('\n'); });
  const lines = $('body').text().split('\n').map(clean).filter(Boolean);
  const res = [];
  let cur = null;
  for (const line of lines) {
    const h = line.match(HEAD_RE);
    const a = line.match(ART_RE);
    if (h && h[2] && h[2].length <= 40) { cur = null; res.push({ type: h[1], name: h[2].trim() }); continue; }
    if (a) { cur = { type: 'art', no: a[1].replace(/\s/g, ''), text: '' }; res.push(cur); continue; }
    if (cur && line.length < 2000 && !/^(?:回首頁|友善列印|列印時間|English|Top)/.test(line)) cur.text += (cur.text ? '\n' : '') + line;
  }
  return res;
}

// 依設定取出某一章（可再指定節）的條文
function pickChapter(seq, chapter, section) {
  const norm = (s) => s.replace(/\s/g, '');
  const arts = [];
  let inCh = false, inSec = !section;
  for (const x of seq) {
    if (x.type === '章') { inCh = norm(x.name) === norm(chapter) || norm(x.name).replace(/[（(].*$/, '') === norm(chapter); inSec = !section; continue; }
    if (x.type === '節') { if (section) inSec = inCh && norm(x.name) === norm(section); continue; }
    if (x.type === 'art' && inCh && inSec) arts.push({ no: x.no, text: x.text });
  }
  return arts;
}

async function main() {
  const guides = JSON.parse(await fs.readFile(GUIDES, 'utf8'));
  let prev = {};
  try { prev = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch {}
  const needed = new Set(guides.industries.flatMap((g) => (g.src || []).map((s) => s.pcode)));
  const htmlOf = {};

  const items = [];
  let ok = 0, fail = 0;
  for (const r of RANGES) {
    for (let i = r.from; i <= r.to; i++) {
      const pcode = `${r.prefix}${String(i).padStart(4, '0')}`;
      try {
        const page = await getHtml(pcode);
        ok++;
        const law = page && readLaw(pcode, page.url, page.html);
        if (law && KEEP.test(law.title) && !SKIP.test(law.title)) items.push(law);
        if (page && needed.has(pcode)) htmlOf[pcode] = page.html;
      } catch {
        fail++;
      }
      await sleep(800);
    }
  }
  if (!items.length) {
    console.log(`法規：沒有抓到資料（成功 ${ok}、失敗 ${fail}），保留舊資料`);
    return;
  }
  items.sort((a, b) => (b.amended || '').localeCompare(a.amended || ''));

  // 各行業的法條原文
  const changes = [];
  const chapters = {};
  const seqOf = {};
  for (const g of guides.industries) {
    const parts = [];
    for (const s of g.src || []) {
      const html = htmlOf[s.pcode];
      if (!html) continue;
      seqOf[s.pcode] ||= splitLaw(html);
      let arts = pickChapter(seqOf[s.pcode], s.chapter, s.section);
      if (!arts.length) arts = pickChapter(splitText(html), s.chapter, s.section);
      const law = items.find((l) => l.pcode === s.pcode);
      if (!arts.length) {
        console.log(`  ⚠ ${g.name}：找不到「${s.chapter}${s.section ? '／' + s.section : ''}」（${s.pcode}）`);
        await fs.mkdir(DEBUG_DIR, { recursive: true });
        const heads = seqOf[s.pcode].filter((x) => x.type !== 'art').map((x) => `${x.type} ${x.name}`).join('\n');
        const at = html.indexOf(s.chapter);
        const raw = at >= 0 ? html.slice(Math.max(0, at - 1500), at + 1500) : html.slice(html.indexOf('law-reg-content'), html.indexOf('law-reg-content') + 3000);
        await fs.writeFile(path.join(DEBUG_DIR, `${s.pcode}-${g.id}.txt`), `找不到：${s.chapter} ${s.section || ''}\n\n偵測到的章節：\n${heads}\n\n原始 HTML 片段：\n${raw}`);
        continue;
      }
      parts.push({ pcode: s.pcode, law: law?.title || '', amended: law?.amended || null, url: `https://law.moj.gov.tw/LawClass/LawAll.aspx?PCode=${s.pcode}`, heading: s.section ? `${s.chapter}・${s.section}` : s.chapter, articles: arts });
    }
    // 某部法規這次沒抓到時沿用舊資料，避免網頁上的法條消失
    const old = prev.chapters?.[g.id];
    if (!parts.length) { if (old) chapters[g.id] = old; continue; }
    const hash = sha(JSON.stringify(parts.map((p) => p.articles)));
    let changedAt = old?.changedAt || null;
    if (old?.hash && old.hash !== hash) {
      changedAt = today();
      const before = new Map((old.parts || []).flatMap((p) => p.articles.map((a) => [`${p.pcode}#${a.no}`, a.text])));
      const diff = parts.flatMap((p) => p.articles.filter((a) => before.get(`${p.pcode}#${a.no}`) !== a.text).map((a) => `- ${p.law} 第 ${a.no} 條${before.has(`${p.pcode}#${a.no}`) ? '（內容修改）' : '（新增）'}`));
      changes.push(`### ${g.icon} ${g.name}\n${diff.join('\n') || '- 條文有刪除或順序調整'}`);
    }
    chapters[g.id] = { hash, changedAt, parts };
  }

  await fs.writeFile(OUT, JSON.stringify({ checkedAt: new Date().toISOString(), items, chapters }, null, 1) + '\n');
  console.log(`法規：收錄 ${items.length} 部（讀取成功 ${ok}、失敗 ${fail}）`);
  for (const l of items) console.log(`  ${l.amended}  ${l.title}  (${l.pcode})`);
  for (const [id, c] of Object.entries(chapters)) console.log(`  條文 ${id}：${c.parts.map((p) => `${p.heading} ${p.articles.length} 條`).join('、')}${c.changedAt ? `（${c.changedAt} 變動）` : ''}`);

  if (changes.length) {
    await fs.mkdir(path.dirname(CHANGES), { recursive: true });
    await fs.appendFile(CHANGES, `## 📜 法條有修正\n聘僱指南的重點整理可能需要跟著更新：\n\n${changes.join('\n\n')}\n\n`);
    console.log(`  ⚠ 有 ${changes.length} 個行業的法條變動，已寫入 data/changes.md`);
  }
}

await main();
