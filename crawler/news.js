// crawler/news.js
// 抓各家媒體的「移工」相關新聞（透過 Google 新聞 RSS 彙整），
// 把不同媒體報導同一件事的新聞合併成一則，依「幾家媒體報導」排出熱門度，取前 10 則寫入 docs/news.json
//
// 用法：node crawler/news.js

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { fetch } from 'undici';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'news.json');
const RAW = path.join(ROOT, 'data', 'news-raw.json'); // 原始抓到的全部新聞（調整合併規則用）
const FROM_RAW = process.argv.includes('--from-raw'); // 不上網，直接用上次的原始資料重算

// 可自行增減搜尋關鍵字
const QUERIES = ['移工', '外籍勞工', '外籍看護', '外國人勞工 勞動部'];
const DAYS = 3; // 只看最近幾天
const TOP = 10;
const SIMILAR = 0.18; // 標題相似度門檻（0–1），越低越容易合併；以實際新聞調校過
const UA = 'Mozilla/5.0 (compatible; MigrantPosterHub/1.0)';

const RSS_BASE = process.env.NEWS_RSS_BASE || 'https://news.google.com/rss/search';
const rssUrl = (q) =>
  `${RSS_BASE}?q=${encodeURIComponent(`${q} when:${DAYS}d`)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;

const clean = (s = '') => s.replace(/\s+/g, ' ').trim();

/** 去掉標題尾巴的「 - 媒體名」與常見雜訊，只留內容 */
function coreTitle(title, source) {
  let t = clean(title);
  if (source && t.endsWith(` - ${source}`)) t = t.slice(0, -(source.length + 3));
  else t = t.replace(/\s[-–—|｜]\s[^-–—|｜]{1,20}$/, '');
  t = t.split(/\s*[|｜]\s/)[0];
  return t.replace(/【[^】]{0,12}】|\[[^\]]{0,12}\]|〈[^〉]{0,12}〉|^(快訊|獨家|影|圖|影音|直播|更新)[／/｜|:：]/g, '').trim();
}

// 幾乎每則都有的字，不拿來判斷是不是同一件事
const STOP = new Set(['移工', '外籍', '籍移', '越籍', '泰籍', '菲籍', '印尼', '越南', '南籍', '尼籍', '勞工', '外勞', '看護']);

/** 中文用「相鄰兩字」切片比較相似度（Dice 係數），英數字整個詞算一片 */
function grams(t) {
  const s = t.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ');
  const set = new Set();
  for (const w of s.match(/[a-z0-9]+/g) || []) set.add(w);
  const han = s.replace(/[a-z0-9 ]+/g, '');
  for (let i = 0; i < han.length - 1; i++) {
    const g = han.slice(i, i + 2);
    if (!STOP.has(g)) set.add(g);
  }
  return set;
}
/** 以 IDF 加權的重疊比例：常見字（移工、外籍…）權重低，專有名詞（汐止、熱炒店…）權重高 */
let IDF = new Map();
function buildIdf(sets) {
  const df = new Map();
  for (const st of sets) for (const g of st) df.set(g, (df.get(g) || 0) + 1);
  const N = sets.length || 1;
  const m = new Map();
  for (const [g, n] of df) m.set(g, Math.log((N + 1) / n));
  IDF = m;
  return m;
}
const w = (g) => IDF.get(g) ?? 1;
function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0, sa = 0, sb = 0;
  for (const g of a) { sa += w(g); if (b.has(g)) inter += w(g); }
  for (const g of b) sb += w(g);
  return inter / Math.min(sa, sb); // 用較短的標題當分母：短標題被長標題包含也算同一則
}

async function fetchQuery(q) {
  const res = await fetch(rssUrl(q), { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const $ = cheerio.load(await res.text(), { xmlMode: true });
  const items = [];
  $('item').each((_, el) => {
    const $el = $(el);
    const source = clean($el.find('source').text());
    const title = clean($el.find('title').text());
    // Google 自己合併的「相關報導」列在 description 裡，也算進報導家數
    const related = cheerio.load($el.find('description').text() || '')('li').length;
    items.push({
      title: coreTitle(title, source),
      link: clean($el.find('link').text()),
      source: source || '新聞',
      sourceUrl: $el.find('source').attr('url') || '',
      pubDate: new Date($el.find('pubDate').text() || Date.now()).toISOString(),
      related,
    });
  });
  return items;
}

const RELEVANT = /移工|外籍|外勞|看護工|外國人|跨國勞動|勞動部|移民署|印尼籍|越南籍|越籍|泰籍|菲籍|菲律賓籍/;
const BAD_SOURCES = /^(Facebook|YouTube|Instagram|X|Threads|PTT)$/i;

async function main() {
  const all = [];
  const errors = [];
  if (FROM_RAW) all.push(...JSON.parse(await fs.readFile(RAW, 'utf8')));
  else for (const q of QUERIES) {
    try {
      all.push(...(await fetchQuery(q)));
    } catch (e) {
      errors.push(`${q}：${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  const since = Date.now() - DAYS * 864e5;
  if (!FROM_RAW && all.length) {
    await fs.mkdir(path.dirname(RAW), { recursive: true });
    await fs.writeFile(RAW, JSON.stringify(all) + '\n');
  }
  const seenLink = new Set();
  const fresh = all
    .map((x) => ({ ...x, title: coreTitle(x.title, x.source) }))
    .filter((x) => x.title && x.link && (FROM_RAW || new Date(x.pubDate).getTime() >= since))
    .filter((x) => RELEVANT.test(x.title) && !BAD_SOURCES.test(x.source))
    .filter((x) => !seenLink.has(x.link) && seenLink.add(x.link));
  buildIdf(fresh.map((x) => grams(x.title)));

  // 合併：任兩篇標題夠像就連在一起（同一件事的不同說法會串成一組），不管來自哪家媒體
  const G = fresh.map((x) => grams(x.title));
  const parent = fresh.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < fresh.length; i++)
    for (let j = i + 1; j < fresh.length; j++)
      if (similarity(G[i], G[j]) >= SIMILAR) parent[find(i)] = find(j);
  const groups = new Map();
  fresh.forEach((x, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, { items: [] });
    groups.get(r).items.push(x);
  });
  const clusters = [...groups.values()];

  const ranked = clusters
    .map((c) => {
      const sources = [...new Map(c.items.map((x) => [x.source, x])).values()];
      const related = Math.max(...c.items.map((x) => x.related || 0));
      const latest = c.items.map((x) => x.pubDate).sort().pop();
      // 熱門度：報導的媒體家數為主，Google 相關報導數為輔，越新越加分
      const hoursAgo = (Date.now() - new Date(latest).getTime()) / 36e5;
      const score = sources.length * 10 + Math.min(related, 10) * 3 + Math.max(0, 24 - hoursAgo) / 6;
      const lead = c.items.find((x) => /中央社|CNA/.test(x.source)) || c.items[0];
      return {
        title: lead.title,
        link: lead.link,
        source: lead.source,
        pubDate: latest,
        count: Math.max(sources.length, related),
        sources: sources.map((x) => ({ name: x.source, link: x.link, title: x.title })),
        score: Math.round(score * 10) / 10,
      };
    })
    .sort((a, b) => b.score - a.score || b.pubDate.localeCompare(a.pubDate))
    .slice(0, TOP);

  if (FROM_RAW) {
    for (const c of clusters.sort((a, b) => b.items.length - a.items.length)) console.log(`[${c.items.length}] ` + c.items.map((x) => x.title.slice(0, 26)).join('  ||  '));
    return;
  }
  if (!ranked.length && errors.length) {
    // 全部失敗時保留舊資料，不要把首頁清空
    console.log('新聞抓取失敗，保留舊資料：', errors.join('；'));
    process.exitCode = 0;
    return;
  }
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), days: DAYS, items: ranked, errors }, null, 1) + '\n');
  console.log(`新聞：抓到 ${fresh.length} 篇，合併後 ${clusters.length} 則，取前 ${ranked.length} 則`);
  for (const n of ranked) console.log(`  [${n.count}] ${n.title}（${n.source}）`);
}

await main();
