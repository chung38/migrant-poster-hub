// crawler/sea-news.js
// 東南亞各國華文媒體的「當地熱門／頭條」新聞（越南、菲律賓、泰國、印尼），每國 3 則，寫入 docs/sea-news.json
//
// 做法：
//   1. 讀各報首頁（或要聞頁），網站有「熱門／排行」區塊就優先採用，其次依首頁排列順序（＝編輯排的頭條）
//   2. 只取當地新聞：排除娛樂、體育、國際、中國新聞等分類，以及訃告、社團活動
//   3. 不重複：同一事件的多篇報導（例如領導人出訪系列）只留一則；各國之間也不重複；同一分類最多 2 則
//   4. 簡體一律轉繁體（opencc-js）；標題提到移工的會標「移工」
//   5. 遵守各網站 robots.txt；某站抓不到時沿用上次結果，主要報紙不足時用同國第二家補
//
// 用法：node crawler/sea-news.js            一般執行
//       node crawler/sea-news.js --debug    另外把每站抓到的候選寫到 data/debug/sea-*.json（調整規則用）

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { fetch, Agent } from 'undici';
import * as OpenCC from 'opencc-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'sea-news.json');
const RAW = path.join(ROOT, 'data', 'sea-raw.json');
const DEBUG = process.argv.includes('--debug');
const DEBUG_DIR = path.join(ROOT, 'data', 'debug');

const PER_COUNTRY = 3;    // 每國顯示幾則
const HEAD_DAYS = 3;      // 只取最近幾天的（知道日期時）
const PER_CATEGORY = 1;   // 先每個分類各挑 1 則讓頭條多樣，不夠再補
const DELAY = 900;
const UA = 'Mozilla/5.0 (compatible; MigrantPosterHub/1.0; +https://chung38.github.io/migrant-poster-hub/)';

// ---------- 各國媒體設定（要增減媒體改這裡；group 相同的是同一國的備用報紙） ----------
const SOURCES = [
  { id: 'vn', country: '越南', flag: '🇻🇳', name: '西貢解放日報（華文版）', home: 'https://cn.sggp.org.vn/',
    pages: ['https://cn.sggp.org.vn/'] },
  { id: 'vn2', group: 'vn', country: '越南', flag: '🇻🇳', name: '越通社（華文）', home: 'https://zh.vietnamplus.vn/',
    pages: ['https://zh.vietnamplus.vn/'] },
  { id: 'ph', country: '菲律賓', flag: '🇵🇭', name: '菲律賓商報', home: 'https://www.shangbao.com.ph/',
    pages: ['https://www.shangbao.com.ph/m/more/fgyw.html'] },   // 菲國要聞
  { id: 'th', country: '泰國', flag: '🇹🇭', name: 'TCN 泰國新聞', home: 'https://thaichinesenews.com/',
    pages: ['https://thaichinesenews.com/'],
    prefer: ['politics', 'society', 'finance'],   // 分類優先順序（網址裡的分類）
    article: /^https?:\/\/thaichinesenews\.com\/[a-z_]+\/\d+\/?$/,
    wordpress: 'https://thaichinesenews.com' },
  { id: 'id', country: '印尼', flag: '🇮🇩', name: '印尼商報', home: 'https://shangbaoindonesia.com/',
    pages: ['https://shangbaoindonesia.com/'],
    prefer: ['politics', 'hukum', 'society', 'kesra', 'economy', 'metropolitan'],
    useHot: false,   // 首頁的排行區塊是個股財經快訊，不當頭條
    article: /^https?:\/\/(?:www\.)?shangbaoindonesia\.com\/read\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+-\d+/ },
];

// 不算「當地新聞」的分類（看網址）與標題
const SKIP_CATEGORY = /entertainment|sports?|olahraga|hiburan|luar-negeri|internasional|international|world|china|tiongkok|zhongguo|lifestyle|gaya-hidup|horoscope|community|komunitas|ads?|advert/i;
const SKIP_TITLE = /訃|逝世|設靈|殯儀|出殯|星座|運程|賀詞|恭賀|廣告|招聘|同鄉會|宗親會|校友會|聯誼會|總會訊|會訊|本會|華教中心|^\(|^（|中新社|中新網|新華社|編者按|社論|評論|專欄|副刊|圖片新聞|^【影片】|^視頻/;
// 熱門／排行區塊（class、id 或區塊標題）
const HOT_ATTR = /hot|popular|most[-_]?(read|view)|rank|trend|top[-_]?(news|read)/i;
const HOT_HEAD = /熱門|热门|排行|熱點|热点|最多人|人氣|人气|熱讀|热读/;
const MIGRANT = /移工|外勞|外籍勞工|移民工人|海外勞工|勞務輸出|勞務出口|菲勞|菲傭|印傭|越勞|泰勞|OFW|看護工|幫傭|仲介費|非法勞工|黑工/i;

// ---------- 工具 ----------
const toTw = OpenCC.Converter({ from: 'cn', to: 'tw' });
const tw = (s) => toTw(String(s || '')).replace(/臺灣/g, '台灣').replace(/臺北/g, '台北');
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const insecure = new Agent({ connect: { rejectUnauthorized: false } });
const now = Date.now();
const pad = (n) => String(n).padStart(2, '0');

async function get(url, accept = 'text/html') {
  const opts = { headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'zh-TW,zh;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(25000) };
  let res;
  try { res = await fetch(url, opts); }
  catch { res = await fetch(url, { ...opts, dispatcher: insecure }); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// robots.txt：只看 User-agent: * 的 Disallow / Allow
const robotsCache = new Map();
async function allowed(url) {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    let rules = [];
    try {
      const txt = await get(`${u.origin}/robots.txt`, 'text/plain');
      let mine = false;
      for (const raw of txt.split(/\r?\n/)) {
        const line = raw.replace(/#.*/, '').trim();
        const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
        if (!m) continue;
        const k = m[1].toLowerCase(), v = m[2].trim();
        if (k === 'user-agent') mine = v === '*';
        else if (mine && (k === 'disallow' || k === 'allow') && v) rules.push({ allow: k === 'allow', path: v });
      }
    } catch { rules = []; }
    robotsCache.set(u.origin, rules);
  }
  const p = u.pathname + u.search;
  const hit = robotsCache.get(u.origin)
    .filter((r) => new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')).test(p))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return !hit || hit.allow;
}

function dateFrom(s) {
  if (!s) return null;
  let m = String(s).match(/(20\d{2})[\/.\-年](\d{1,2})[\/.\-月](\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = String(s).match(/(20\d{2})\/(\d{1,2})-(\d{1,2})\//);       // 菲律賓商報 /2026/11-12/
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  return null;
}
const ageDays = (d) => (d ? (now - new Date(d + 'T12:00:00+08:00').getTime()) / 864e5 : 0);

// 網址裡的分類（印尼商報 /read/日期/economy-123、TCN /finance/123/、菲律賓商報 /fgyw/...）
function categoryOf(url) {
  const p = new URL(url).pathname;
  return (p.match(/\/read\/\d{4}\/\d{2}\/\d{2}\/([a-z-]+?)-\d+/) || p.match(/^\/([a-z_-]+)\/\d/) || [])[1] || '';
}

function isArticle(src, url, text) {
  if (src.article) return src.article.test(url);
  const u = new URL(url);
  if (u.host !== new URL(src.home).host) return false;
  if (!/[一-鿿]/.test(text) || text.length < 8) return false;
  return /\d{5,}|\.s?html?$/.test(u.pathname) && !/\/(tag|tags|category|author|page|search|video)s?\//i.test(u.pathname);
}

// 從頁面取出文章連結（保留頁面順序），並標記是否在「熱門／排行」區塊
function extractLinks(src, html, base) {
  const $ = cheerio.load(html);
  const out = new Map();
  $('a[href]').each((i, a) => {
    let href;
    try { href = new URL($(a).attr('href'), base).href.replace(/#.*$/, ''); } catch { return; }
    const head = clean($(a).find('h1,h2,h3,h4,h5,.title,[class*="title"]').first().text());
    const text = clean($(a).attr('title') || head || $(a).text()).replace(/^(?:0?[1-9]|10)(?=[^\d])\s*/, '');
    if (!isArticle(src, href, text) || text.length < 6 || text.length > 70) return;
    let hot = false;
    let el = $(a);
    for (let k = 0; k < 7 && el.length && !hot; k++) {
      el = el.parent();
      const attr = `${el.attr('class') || ''} ${el.attr('id') || ''}`;
      if (HOT_ATTR.test(attr)) hot = true;
      else if (k >= 1 && HOT_HEAD.test(clean(el.children('h1,h2,h3,h4,h5,.title,[class*="title"],[class*="head"]').first().text()).slice(0, 20))) hot = true;
    }
    const cur = out.get(href);
    if (!cur) out.set(href, { url: href, title: text, order: i, hot, date: dateFrom(href) || dateFrom($(a).closest('li,article,div').first().text().slice(0, 300)) });
    else { if (text.length > cur.title.length && text.length <= 70) cur.title = text; cur.hot ||= hot; }
  });
  return [...out.values()];
}

// WordPress：用 REST 取得最新文章的乾淨標題與日期（首頁卡片的連結文字常混雜分類與摘要）
async function wordpressTitles(src, log) {
  const map = new Map();
  try {
    const url = `${src.wordpress}/wp-json/wp/v2/posts?orderby=date&per_page=60&_fields=date,link,title`;
    if (!(await allowed(url))) return map;
    const arr = JSON.parse(await get(url, 'application/json'));
    for (const p of arr) map.set(p.link, { title: clean(cheerio.load(p.title?.rendered || '').text()), date: (p.date || '').slice(0, 10) });
    log.push(`wp 標題 ${map.size}`);
  } catch (e) { log.push(`wp ✘ ${e.message}`); }
  return map;
}

// 兩個標題是否講同一件事：相鄰兩字重疊比例高，或共用很多字詞（例如同一位領導人出訪的系列報導）
const grams = (t) => { const x = t.replace(/[\s\p{P}\p{S}]/gu, ''); const st = new Set(); for (let i = 0; i < x.length - 1; i++) st.add(x.slice(i, i + 2)); return st; };
function similar(a, b) {
  const A = grams(a), B = grams(b);
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return n / Math.max(1, Math.min(A.size, B.size)) >= 0.35 || n >= 6;
}

function headSkip(title, cat, date) {
  if (title.length < 6 || title.length > 60) return '長度';
  if (SKIP_TITLE.test(title)) return '非新聞';
  if (cat && SKIP_CATEGORY.test(cat)) return '非當地';
  if (date && ageDays(date) > HEAD_DAYS) return '過舊';
  return '';
}

async function crawlSource(src) {
  const log = [];
  const links = [];
  const wp = src.wordpress ? await wordpressTitles(src, log) : new Map();
  for (const [pi, url] of src.pages.entries()) {
    if (!(await allowed(url))) { log.push(`robots 不允許 ${url}`); continue; }
    try {
      const got = extractLinks(src, await get(url), url);
      links.push(...got.map((x) => ({ ...x, order: x.order + pi * 100000 })));
      log.push(`${url} → ${got.length} 篇（熱門區塊 ${got.filter((x) => x.hot).length}）`);
    } catch (e) { log.push(`${url} ✘ ${e.message}`); }
    await sleep(DELAY);
  }
  const cands = links.map((l) => {
    const w = wp.get(l.url) || wp.get(l.url.replace(/\/?$/, '/'));
    const title = tw(w?.title || l.title);
    const date = l.date || w?.date || null;
    const cat = categoryOf(l.url);
    return { url: l.url, title, date, cat, hot: l.hot, order: l.order, why: headSkip(title, cat, date) };
  });
  // 排序：設定的分類優先順序 → 熱門區塊 → 頁面順序（＝網站編輯排的頭條）
  const useHot = src.useHot !== false;
  const pref = (x) => { const i = (src.prefer || []).findIndex((c) => x.cat.startsWith(c)); return i < 0 ? 99 : i; };
  const ok = cands.filter((x) => !x.why).map((x) => ({ ...x, hot: useHot && x.hot }))
    .sort((a, b) => (pref(a) - pref(b)) || (b.hot - a.hot) || (a.order - b.order));
  if (DEBUG) {
    await fs.mkdir(DEBUG_DIR, { recursive: true });
    await fs.writeFile(path.join(DEBUG_DIR, `sea-${src.id}.json`), JSON.stringify({ log, cands: cands.slice(0, 80).map((x) => `${x.hot ? '🔥' : '  '} ${x.why || 'OK'} ${x.date || '-'} [${x.cat}] ${x.title}`) }, null, 1));
  }
  return { list: ok.map(({ url, title, date, cat, hot }) => ({ url, title, date, cat, hot, source: src.name, migrant: MIGRANT.test(title) || undefined })), log, total: links.length };
}

// 從候選挑 n 則：同事件只留一則、同分類最多 PER_CATEGORY 則、不和其他國家已選的重複
function pick(list, n, taken) {
  const out = [], perCat = {};
  for (const pass of [true, false]) {
    for (const x of list) {
      if (out.length >= n) break;
      if (out.includes(x) || [...out, ...taken].some((y) => y.url === x.url || similar(y.title, x.title))) continue;
      if (pass && x.cat && (perCat[x.cat] || 0) >= PER_CATEGORY) continue;
      out.push(x); perCat[x.cat] = (perCat[x.cat] || 0) + 1;
    }
  }
  return out;
}

async function main() {
  let raw = {};
  try { raw = JSON.parse(await fs.readFile(RAW, 'utf8')); } catch {}
  raw.lists ||= {};
  const groups = new Map();
  for (const src of SOURCES) {
    let res;
    try { res = await crawlSource(src); }
    catch (e) { res = { list: [], log: [`✘ ${e.message}`], total: 0 }; }
    // 這次沒抓到時沿用上次的（避免網站暫時連不上就空白）
    if (res.list.length) raw.lists[src.id] = { at: new Date(now).toISOString(), list: res.list.slice(0, 30) };
    const list = raw.lists[src.id]?.list || [];
    const gid = src.group || src.id;
    if (!groups.has(gid)) groups.set(gid, { primary: src, lists: [] });
    groups.get(gid).lists.push(list);
    console.log(`${src.flag} ${src.country} ${src.name}：頁面 ${res.total} 篇，可用 ${res.list.length}${res.list.length ? '' : '（沿用上次）'}`);
    for (const l of res.log) console.log(`    ${l.slice(0, 300)}`);
  }
  const result = { updatedAt: new Date(now).toISOString(), mode: 'headline', countries: [] };
  const taken = [];
  for (const [gid, g] of groups) {
    const src = g.primary;
    // 主要報紙優先，不足再用同國第二家
    let items = [];
    for (const list of g.lists) items = [...items, ...pick(list, PER_COUNTRY - items.length, [...taken, ...items])];
    taken.push(...items);
    result.countries.push({ id: gid, country: src.country, flag: src.flag, source: src.name, home: src.home,
      items: items.map(({ url, title, date, source, hot, migrant }) => ({ kind: 'headline', url, title, date, source, hot: hot || undefined, migrant })) });
    console.log(`${src.flag} ${src.country} 精選：`);
    for (const x of items) console.log(`    ${x.hot ? '🔥' : '◇'} ${x.date || '----'} ${x.title}【${x.source}】`);
  }
  delete raw.sources; delete raw.headlines;   // 舊版（移工新聞模式）的資料
  await fs.mkdir(path.dirname(RAW), { recursive: true });
  await fs.writeFile(RAW, JSON.stringify(raw, null, 1) + '\n');
  await fs.writeFile(OUT, JSON.stringify(result, null, 1) + '\n');
}

await main();
