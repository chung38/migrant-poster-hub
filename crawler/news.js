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

// 可自行增減搜尋關鍵字
const QUERIES = ['移工', '外籍勞工', '外籍看護', '外國人勞工 勞動部'];
const DAYS = 3; // 只看最近幾天
const TOP = 10;
const SIMILAR = 0.45; // 標題相似度門檻（0–1），越低越容易合併
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
  return t.replace(/【[^】]{0,12}】|\[[^\]]{0,12}\]|〈[^〉]{0,12}〉|^(快訊|獨家|影|圖|影音)[｜|:：]/g, '').trim();
}

/** 中文用「相鄰兩字」切片比較相似度（Dice 係數），英數字整個詞算一片 */
function grams(t) {
  const s = t.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ');
  const set = new Set();
  for (const w of s.match(/[a-z0-9]+/g) || []) set.add(w);
  const han = s.replace(/[a-z0-9 ]+/g, '');
  for (let i = 0; i < han.length - 1; i++) set.add(han.slice(i, i + 2));
  return set;
}
function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const g of a) if (b.has(g)) n++;
  return (2 * n) / (a.size + b.size);
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

async function main() {
  const all = [];
  const errors = [];
  for (const q of QUERIES) {
    try {
      all.push(...(await fetchQuery(q)));
    } catch (e) {
      errors.push(`${q}：${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  const since = Date.now() - DAYS * 864e5;
  const fresh = all.filter((x) => x.title && x.link && new Date(x.pubDate).getTime() >= since);

  // 合併：同一則新聞（標題夠像）不管來自哪家媒體都併成一組
  const clusters = [];
  for (const it of fresh.sort((a, b) => b.pubDate.localeCompare(a.pubDate))) {
    const g = grams(it.title);
    let best = null;
    let bestSim = 0;
    for (const c of clusters) {
      const s = Math.max(...c.grams.map((cg) => similarity(g, cg)));
      if (s > bestSim) { bestSim = s; best = c; }
    }
    if (best && (bestSim >= SIMILAR || best.items.some((x) => x.link === it.link))) {
      if (!best.items.some((x) => x.link === it.link || (x.source === it.source && similarity(grams(x.title), g) > 0.8))) {
        best.items.push(it);
        best.grams.push(g);
      }
    } else {
      clusters.push({ items: [it], grams: [g] });
    }
  }

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
