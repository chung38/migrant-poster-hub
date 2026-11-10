// crawler/sea-news.js
// 抓東南亞各國華文媒體的「移工」相關新聞（越南、菲律賓、泰國、印尼），每國挑出最重要的幾則，寫入 docs/sea-news.json
//
// 做法：
//   1. 讀各媒體的列表頁（首頁、各分類、WordPress 的 RSS 與站內搜尋），收集文章標題與連結
//   2. 簡體一律轉成繁體（opencc-js），用移工關鍵字打分數；標題分數夠高的再打開內文確認日期與內容
//   3. 累積保存最近 DAYS 天（data/sea-raw.json），每國依「相關程度 × 新鮮度」取前 PER_COUNTRY 則
//   4. 遵守各網站 robots.txt；某站沒抓到時改用 Google 新聞的 site: 搜尋補上
//
// 用法：node crawler/sea-news.js            一般執行
//       node crawler/sea-news.js --debug    另外把每站抓到的連結樣本寫到 data/debug/sea-*.json（調整規則用）

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

const DAYS = 180;         // 保存與挑選的時間範圍（移工新聞不是天天有，放寬到半年，排序時越新越前面）
const HALF_LIFE = 30;     // 新鮮度：每 30 天分數減半
const PER_COUNTRY = 3;    // 每國顯示幾則
const MIN_SCORE = 5;      // 至少幾分才算「移工新聞」（標題本身要有移工字眼，或內文大量提到）
const MAX_DETAIL = 25;    // 每站每次最多打開幾篇內文
const DELAY = 900;
const UA = 'Mozilla/5.0 (compatible; MigrantPosterHub/1.0; +https://chung38.github.io/migrant-poster-hub/)';

// ---------- 各國媒體設定（要增減媒體改這裡） ----------
const SOURCES = [
  {
    id: 'vn', country: '越南', flag: '🇻🇳', name: '西貢解放日報（華文版）', home: 'https://cn.sggp.org.vn/',
    lists: ['https://cn.sggp.org.vn/'],
    discover: /時政|时政|法律|經濟|经济|国际|國際|社會|社会|華人|华人|時事|时事/, // 從首頁選單自動找分類頁
    search: ['https://cn.sggp.org.vn/search/?q={q}', 'https://cn.sggp.org.vn/tim-kiem/?q={q}'],
    searchWords: ['劳务', '劳工', '务工'],
    // 主要網站相關報導不足時，用 Google 新聞補同國其他華文媒體
    extra: [{ host: 'zh.vietnamplus.vn', name: '越通社（華文）' }, { host: 'cn.nhandan.vn', name: '人民報（華文）' }],
  },
  // 同國的第二家媒體：主要網站相關報導不夠時補上（group 相同的會合併成一國）
  {
    id: 'vn2', group: 'vn', country: '越南', flag: '🇻🇳', name: '越通社（華文）', home: 'https://zh.vietnamplus.vn/',
    lists: ['https://zh.vietnamplus.vn/'],
    discover: /社会|社會|经济|經濟|时政|時政|越南/,
  },
  {
    id: 'ph', country: '菲律賓', flag: '🇵🇭', name: '菲律賓商報', home: 'https://www.shangbao.com.ph/',
    lists: ['https://www.shangbao.com.ph/m/more/fgyw.html', 'https://www.shangbao.com.ph/fgyw/', 'https://www.shangbao.com.ph/'],
    discover: /菲國要聞|菲国要闻|要聞|要闻|社會|社会|時事|时事/,
    extra: [{ host: 'worldnews.net.ph', name: '菲律賓世界日報' }],
  },
  {
    id: 'ph2', group: 'ph', country: '菲律賓', flag: '🇵🇭', name: '菲律賓世界日報', home: 'https://www.worldnews.net.ph/',
    lists: ['https://www.worldnews.net.ph/'],
    discover: /菲律賓|菲律濱|菲國|要聞|要闻|社會|社会|僑社/,
  },
  {
    id: 'th', country: '泰國', flag: '🇹🇭', name: 'TCN 泰國新聞', home: 'https://thaichinesenews.com/',
    lists: ['https://thaichinesenews.com/', 'https://thaichinesenews.com/category/society/', 'https://thaichinesenews.com/category/politics/', 'https://thaichinesenews.com/category/breaking/'],
    article: /^https?:\/\/thaichinesenews\.com\/[a-z_]+\/\d+\/?$/,
    wordpress: 'https://thaichinesenews.com',
    searchWords: ['外勞', '移工', '勞工', '外籍', '勞動部'],
    extra: [{ host: 'udnbkk.com', name: '泰國世界日報' }, { host: 'singsianyerpao.com', name: '星暹日報' }],
  },
  {
    id: 'th2', group: 'th', country: '泰國', flag: '🇹🇭', name: '泰國世界日報', home: 'https://www.udnbkk.com/',
    lists: ['https://www.udnbkk.com/'],
    discover: /泰國|泰国|社會|社会|要聞|要闻|新聞|新闻/,
  },
  {
    id: 'id', country: '印尼', flag: '🇮🇩', name: '印尼商報', home: 'https://shangbaoindonesia.com/',
    lists: ['https://shangbaoindonesia.com/', 'https://shangbaoindonesia.com/society', 'https://shangbaoindonesia.com/kesra', 'https://shangbaoindonesia.com/political', 'https://shangbaoindonesia.com/hukum', 'https://shangbaoindonesia.com/economy', 'https://shangbaoindonesia.com/asean'],
    article: /^https?:\/\/(?:www\.)?shangbaoindonesia\.com\/read\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+-\d+/,
    search: ['https://shangbaoindonesia.com/search?q={q}'],
    searchWords: ['移民工人', '劳工', '外劳'],
    extra: [{ host: 'guojiribao.com', name: '國際日報' }, { host: 'qiandaoribao.com', name: '千島日報' }],
  },
];

// ---------- 關鍵字與分數（標題、內文都先轉成繁體再比對） ----------
const STRONG = /移工|外勞|外籍勞工|外籍工人|外國工人|外國勞工|移民工人|移徙工人|移住勞工|海外勞工|海外務工|出國務工|出國勞務|勞務輸出|勞務出口|勞動輸出|輸出勞工|出國工作|赴台工作|赴臺工作|菲勞|菲傭|印傭|越勞|泰勞|印勞|OFW|海外菲律賓勞工|海外菲人|技能實習生|女傭|幫傭|看護工|家務助理|勞務人員|勞務派遣|仲介費|非法勞工|非法務工|非法打工|黑工|外籍員工|跨國勞工|移工部長|移工部|移民工人保護|(?:緬甸|柬埔寨|寮國|越南|印尼|菲律賓|泰國)籍?(?:勞工|工人|移工|員工)/i;
const MEDIUM = /勞工|務工|勞務|工人|就業|打工|僱主|雇主|人力仲介|仲介|簽證|遣返|匯款|勞動部|勞動、榮軍|人口販運|詐騙園區|保護|權益/;
const DEST = /台灣|臺灣|台北|日本|韓國|南韓|以色列|中東|沙烏地|沙特|卡達|阿聯|科威特|香港|澳門|馬來西亞|新加坡|汶萊|歐洲|德國|澳洲|美國|加拿大/;
const TAIWAN = /台灣|臺灣|台北|台中|高雄|桃園|台南/;
const NOISE = /股|匯率|指數|球賽|足球|演唱會|颱風路徑|天氣/;

function score(title, body = '') {
  let s = 0;
  const t = title;
  const strong = t.match(new RegExp(STRONG, 'gi')) || [];
  s += Math.min(strong.length, 2) * 4;
  if (MEDIUM.test(t)) s += 2;
  if (DEST.test(t) && (strong.length || MEDIUM.test(t))) s += 1;
  if (TAIWAN.test(t)) s += 2;
  if (NOISE.test(t) && !strong.length) s -= 3;
  if (body) {
    const bs = (body.match(new RegExp(STRONG, 'gi')) || []).length;
    s += Math.min(bs, 5);                         // 內文提到越多次越相關
    if (TAIWAN.test(body) && bs) s += 1;
  }
  return s;
}

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
    .filter((r) => { const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')); return re.test(p); })
    .sort((a, b) => b.path.length - a.path.length)[0];
  return !hit || hit.allow;
}

function dateFrom(s) {
  if (!s) return null;
  let m = String(s).match(/(20\d{2})[\/.\-年](\d{1,2})[\/.\-月](\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = String(s).match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](20\d{2})/);   // 11/10/2026（日/月/年）
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return null;
}
const ageDays = (d) => (d ? (now - new Date(d + 'T12:00:00+08:00').getTime()) / 864e5 : 9);

// 判斷是不是文章連結：有設定就用設定的格式，否則用通則（同網域、路徑含長數字或 .html、標題夠長）
function isArticle(src, url, text) {
  if (src.article) return src.article.test(url);
  const u = new URL(url);
  if (u.host !== new URL(src.home).host) return false;
  if (!/[一-鿿]/.test(text) || text.length < 8) return false;
  return /\d{5,}|\.html?$/.test(u.pathname) && !/\/(tag|tags|category|author|page|search|video)s?\//i.test(u.pathname);
}

function extractLinks(src, html, base) {
  const $ = cheerio.load(html);
  const out = new Map();
  const nav = new Map();
  const pages = new Set();
  $('a[href]').each((_, a) => {
    let href;
    try { href = new URL($(a).attr('href'), base).href.replace(/#.*$/, ''); } catch { return; }
    const head = clean($(a).find('h1,h2,h3,h4,h5,.title,[class*="title"]').first().text());
    const text = clean($(a).attr('title') || head || $(a).text());
    if (isArticle(src, href, text) && text.length >= 6 && text.length <= 70) {
      const cur = out.get(href);
      if (!cur || text.length > cur.title.length) out.set(href, { url: href, title: text, date: dateFrom(href) || dateFrom($(a).closest('li,article,div').first().text().slice(0, 300)) });
    } else if (src.discover && text.length <= 8 && src.discover.test(text) && new URL(href).host === new URL(src.home).host) {
      nav.set(href, text);
    } else if (/^(?:2|下一?[页頁]|下[页頁]|next|›|»|>)$/i.test(text) && new URL(href).host === new URL(src.home).host && href !== base) {
      pages.add(href);
    }
  });
  return { links: [...out.values()], nav: [...nav.keys()], pages: [...pages].slice(0, 1) };
}

// WordPress：RSS 與站內 REST 搜尋（可找到較舊的相關文章）
async function wordpressLinks(src, log) {
  const res = [];
  try {
    const xml = await get(`${src.wordpress}/feed/`, 'application/rss+xml');
    const $ = cheerio.load(xml, { xmlMode: true });
    $('item').each((_, it) => res.push({ url: $(it).find('link').text().trim(), title: clean($(it).find('title').text()), date: dateFrom(new Date($(it).find('pubDate').text()).toISOString()), desc: clean(cheerio.load($(it).find('description').text()).text()).slice(0, 300) }));
    log.push(`feed ok ${res.length}`);
  } catch (e) { log.push(`feed ✘ ${e.message}`); }
  for (const w of ['', ...(src.searchWords || [])]) {
    const url = `${src.wordpress}/wp-json/wp/v2/posts?${w ? `search=${encodeURIComponent(w)}&` : ''}orderby=date&per_page=${w ? 30 : 100}&_fields=date,link,title,excerpt`;
    try {
      if (!(await allowed(url))) { log.push(`robots 不允許 ${url}`); break; }
      const arr = JSON.parse(await get(url, 'application/json'));
      for (const p of arr) res.push({ url: p.link, title: clean(cheerio.load(p.title?.rendered || '').text()), date: (p.date || '').slice(0, 10), desc: clean(cheerio.load(p.excerpt?.rendered || '').text()).slice(0, 300), hint: !!w });
      log.push(`wp ${w || '最新'} ${arr.length}`);
    } catch (e) { log.push(`wp ${w || '最新'} ✘ ${e.message}`); break; }
    await sleep(DELAY);
  }
  return res;
}

// 打開內文：取日期、摘要、內文文字
async function readArticle(url) {
  const html = await get(url);
  const $ = cheerio.load(html);
  const meta = (k) => $(`meta[property="${k}"]`).attr('content') || $(`meta[name="${k}"]`).attr('content') || '';
  const date = dateFrom(meta('article:published_time') || meta('pubdate') || meta('publishdate') || $('time[datetime]').attr('datetime') || '')
    || dateFrom(url) || dateFrom($('body').text().replace(/\s+/g, ' ').slice(0, 4000));
  $('script,style,nav,header,footer,aside').remove();
  const body = clean($('article').text() || $('.content, .post-content, .entry-content, .article-content, .detail, #content').first().text() || $('body').text()).slice(0, 6000);
  const desc = clean(meta('og:description') || meta('description')).slice(0, 300);
  const title = clean(meta('og:title') || $('h1').first().text());
  return { date, body, desc, title };
}

// Google 新聞 site: 搜尋（主要網站的補充，以及同國其他華文媒體）
async function googleSite(host, name, log) {
  const q = `site:${host} (勞工 OR 移工 OR 外勞 OR 菲勞 OR 劳工 OR 劳务 OR 务工 OR 外劳 OR 移民工人) when:${DAYS}d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  try {
    const $ = cheerio.load(await get(url, 'application/rss+xml'), { xmlMode: true });
    const res = [];
    $('item').each((_, it) => {
      const src = clean($(it).find('source').text()) || name;
      const title = clean($(it).find('title').text()).replace(new RegExp(`\\s+[-–]\\s+${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '').replace(/\s+[-–]\s+[^-–]{1,20}$/, '');
      res.push({ url: $(it).find('link').text().trim(), title, date: dateFrom(new Date($(it).find('pubDate').text()).toISOString()), via: 'google', source: name });
    });
    log.push(`google site:${host} ${res.length}`);
    return res;
  } catch (e) { log.push(`google site:${host} ✘ ${e.message}`); return []; }
}

async function crawlSource(src, oldItems) {
  const log = [];
  const found = new Map();
  const norm = (u) => { try { const x = new URL(u); [...x.searchParams.keys()].filter((k) => /^utm_|^fbclid$/.test(k)).forEach((k) => x.searchParams.delete(k)); return x.href; } catch { return u; } };
  const add = (x, hint = false) => { if (!x.url || !x.title) return; x.url = norm(x.url); if (!found.has(x.url)) found.set(x.url, { ...x, hint }); else if (hint) found.get(x.url).hint = true; };
  const lists = [...src.lists];
  const visited = new Set();
  const isPage = new Set();
  let wpOk = false;
  if (src.wordpress) { const wp = await wordpressLinks(src, log); wp.forEach((x) => add(x, x.hint)); wpOk = wp.length > 0; }
  for (let i = 0; i < lists.length && i < 20 && !wpOk; i++) {
    const url = lists[i];
    if (visited.has(url)) continue;
    visited.add(url);
    if (!(await allowed(url))) { log.push(`robots 不允許 ${url}`); continue; }
    try {
      const html = await get(url);
      const { links, nav, pages } = extractLinks(src, html, url);
      if (DEBUG && i === 1) { const $d = cheerio.load(html); log.push('頁尾連結：' + $d('a[href]').toArray().slice(-40).map((a) => `${clean($d(a).text()).slice(0, 12)}=${$d(a).attr('href')}`).join(' ')); }
      links.forEach((x) => add(x));
      log.push(`${url} → ${links.length} 篇${nav.length ? `，選單 ${nav.length}` : ''}${pages.length ? `，下一頁 ${pages[0]}` : ''}`);
      if (i === 0) for (const n of nav.slice(0, 8)) if (!lists.includes(n)) lists.push(n);
      // 每個列表再往下翻一頁（只翻一層）
      if (!isPage.has(url)) for (const pg of pages) if (!lists.includes(pg)) { lists.push(pg); isPage.add(pg); }
    } catch (e) { log.push(`${url} ✘ ${e.message}`); }
    await sleep(DELAY);
  }
  for (const tpl of src.search || []) {
    for (const w of src.searchWords || []) {
      const url = tpl.replace('{q}', encodeURIComponent(w));
      if (!(await allowed(url))) { log.push(`robots 不允許 ${url}`); break; }
      try {
        const { links } = extractLinks(src, await get(url), url);
        links.forEach((x) => add(x, true));
        log.push(`search ${w} → ${links.length}`);
        if (!links.length) break;
      } catch (e) { log.push(`search ${url} ✘ ${e.message}`); break; }
      await sleep(DELAY);
    }
  }
  for (const g of [{ host: new URL(src.home).host.replace(/^www\./, ''), name: src.name }, ...(src.extra || [])]) {
    (await googleSite(g.host, g.name, log)).forEach((x) => add(x, true));
    await sleep(DELAY);
  }

  // 轉繁體、打分數
  const cands = [...found.values()].map((x) => ({ ...x, title: tw(x.title), desc: tw(x.desc || '') }))
    .map((x) => ({ ...x, s0: score(x.title, x.desc) }));
  const oldByUrl = new Map(oldItems.map((x) => [x.url, x]));
  // 標題就很相關、或標題普通但有台灣／勞工字眼的，打開內文確認
  const toRead = cands.filter((x) => (x.s0 >= 2 || x.hint) && !oldByUrl.has(x.url) && x.via !== 'google' && (!x.date || ageDays(x.date) <= DAYS))
    .sort((a, b) => b.s0 - a.s0 || (b.date || '').localeCompare(a.date || '')).slice(0, MAX_DETAIL);
  const read = new Map();
  for (const x of toRead) {
    if (!(await allowed(x.url))) continue;
    try { const a = await readArticle(x.url); read.set(x.url, { ...a, body: tw(a.body), desc: tw(a.desc) }); }
    catch (e) { log.push(`內文 ✘ ${x.url} ${e.message}`); }
    await sleep(DELAY);
  }
  const items = [];
  for (const x of cands) {
    const old = oldByUrl.get(x.url);
    const r = read.get(x.url);
    const date = x.date || r?.date || old?.date || null;
    const desc = x.desc || r?.desc || old?.desc || '';
    // 內文加分另外存起來，之後重算分數不必再打開內文
    const bonus = r ? score(x.title, (r.body || '') + ' ' + desc) - score(x.title, desc) : (old?.bonus || 0);
    const s = score(x.title, desc) + bonus;
    // Google 搜尋來的（打不開內文）：只要標題有移工字眼就收
    const strongTitle = new RegExp(STRONG.source, 'i').test(x.title);
    const ok = x.title.length <= 80 && (x.via === 'google' ? strongTitle : (strongTitle && s >= MIN_SCORE) || (MEDIUM.test(x.title) && s >= 10));
    if (ok && (!date || ageDays(date) <= DAYS)) items.push({ url: x.url, title: x.title, date, desc: desc.slice(0, 160), score: s, bonus, via: x.via || 'site', source: x.source || src.name, firstSeen: old?.firstSeen || new Date(now).toISOString() });
  }
  if (DEBUG) {
    await fs.mkdir(DEBUG_DIR, { recursive: true });
    await fs.writeFile(path.join(DEBUG_DIR, `sea-${src.id}.json`), JSON.stringify({ log, total: found.size, sample: cands.slice(0, 30).map((x) => `${x.s0} ${x.date || '-'} ${x.title} | ${x.url}`), hints: cands.filter((x) => x.hint || x.s0 >= 2).map((x) => `${x.s0}${read.has(x.url) ? '+' + (score(x.title, read.get(x.url).body) - x.s0) : ''} ${x.via || ''} ${x.date || '-'} ${x.title}`).slice(0, 120), matched: items.map((x) => `${x.score} ${x.date} ${x.title}`) }, null, 1));
  }
  return { items, log, total: found.size };
}

// 同一則新聞不同網址（標題幾乎一樣）只留一則
function dedupe(items) {
  const out = [];
  for (const x of items) {
    const k = x.title.replace(/[\s\p{P}]/gu, '').slice(0, 18);
    if (!out.some((y) => y.title.replace(/[\s\p{P}]/gu, '').slice(0, 18) === k)) out.push(x);
  }
  return out;
}

async function main() {
  let raw = { sources: {} };
  try { raw = JSON.parse(await fs.readFile(RAW, 'utf8')); } catch {}
  const result = { updatedAt: new Date(now).toISOString(), days: DAYS, countries: [] };
  const groups = new Map();
  for (const src of SOURCES) {
    const old = (raw.sources[src.id] || []).filter((x) => ageDays(x.date || x.firstSeen?.slice(0, 10)) <= DAYS);
    let res;
    try { res = await crawlSource(src, old); }
    catch (e) { res = { items: [], log: [`✘ ${e.message}`], total: 0 }; }
    // 新抓到的與累積的合併
    const map = new Map(old.map((x) => [x.url, x]));
    for (const x of res.items) map.set(x.url, { ...map.get(x.url), ...x });
    const all = [...map.values()].map((x) => ({ ...x, source: x.source || src.name })).sort((a, b) => b.score - a.score);
    raw.sources[src.id] = all;
    const gid = src.group || src.id;
    if (!groups.has(gid)) groups.set(gid, { primary: src, items: [] });
    groups.get(gid).items.push(...all);
    console.log(`${src.flag} ${src.country} ${src.name}：列表 ${res.total} 篇，相關 ${res.items.length}，累積 ${all.length}`);
    for (const l of res.log) console.log(`    ${l.slice(0, 300)}`);
  }
  for (const [gid, g] of groups) {
    const src = g.primary;
    // 重要度：相關分數 × 新鮮度（每 HALF_LIFE 天減半），主要網站略加權
    const rank = (x) => x.score * (x.source === src.name ? 1.3 : 1) * Math.pow(0.5, ageDays(x.date || x.firstSeen?.slice(0, 10)) / HALF_LIFE);
    const top = dedupe([...g.items].sort((a, b) => rank(b) - rank(a))).slice(0, PER_COUNTRY);
    result.countries.push({ id: gid, country: src.country, flag: src.flag, source: src.name, home: src.home,
      items: top.map(({ url, title, date, desc, source }) => ({ url, title, date, desc, source })) });
    console.log(`${src.flag} ${src.country} 精選：`);
    for (const x of top) console.log(`    ★ ${x.date || '----'} (${x.score}) ${x.title}【${x.source}】`);
  }
  await fs.mkdir(path.dirname(RAW), { recursive: true });
  await fs.writeFile(RAW, JSON.stringify(raw, null, 1) + '\n');
  await fs.writeFile(OUT, JSON.stringify(result, null, 1) + '\n');
}

await main();
