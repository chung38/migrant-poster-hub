// crawler/watch.js
// 監看「最低工資」「就業安定費」「家事移工薪資」是否有新公告（透過 Google 新聞），
// 有的話寫進 docs/watch.json；網頁會在「重要數字速查」上方提醒「有新公告，數字待確認」。
// 數字本身不自動改：要有人確認後再更新 docs/info.json（避免抓錯數字誤導雇主）。
//
// 用法：node crawler/watch.js

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { fetch } from 'undici';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'watch.json');
const DAYS = 60;
const UA = 'Mozilla/5.0 (compatible; MigrantPosterHub/1.0)';

const TOPICS = [
  { topic: '最低工資', q: '最低工資 調整 勞動部', re: /(最低工資|基本工資).{0,20}(調|漲|拍板|通過|公告|審議|上路|確定)|(調|漲|拍板|通過).{0,12}(最低工資|基本工資)/ },
  { topic: '就業安定費', q: '就業安定費 調整', re: /就業安定費.{0,20}(調|漲|降|減|免|新制|上路|修正)|(調|漲|降|減|免|修正).{0,12}就業安定費/ },
  { topic: '家事移工薪資', q: '家事移工 薪資 調整', re: /(家事移工|看護工|外籍看護|家庭看護|外傭).{0,15}(薪資|月薪|工資).{0,15}(調|漲|新制|上路)|(調|漲).{0,10}(家事移工|看護工|外籍看護).{0,10}(薪|工資)/ },
];

const clean = (s = '') => s.replace(/\s+/g, ' ').trim();
const rss = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:${DAYS}d`)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;

async function main() {
  const items = [];
  const errors = [];
  for (const t of TOPICS) {
    try {
      const res = await fetch(rss(t.q), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const $ = cheerio.load(await res.text(), { xmlMode: true });
      $('item').each((_, el) => {
        const $el = $(el);
        const source = clean($el.find('source').text());
        let title = clean($el.find('title').text());
        if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
        title = title.split(/\s*[|｜]\s/)[0];
        if (!t.re.test(title)) return;
        items.push({ topic: t.topic, title, link: clean($el.find('link').text()), source, pubDate: new Date($el.find('pubDate').text() || Date.now()).toISOString() });
      });
    } catch (e) {
      errors.push(`${t.topic}：${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  if (!items.length && errors.length) {
    console.log('公告監看失敗，保留舊資料：', errors.join('；'));
    return;
  }
  // 同一則標題只留一筆，新的在前
  const seen = new Set();
  const uniq = items.sort((a, b) => b.pubDate.localeCompare(a.pubDate)).filter((x) => !seen.has(x.title) && seen.add(x.title)).slice(0, 15);
  await fs.writeFile(OUT, JSON.stringify({ checkedAt: new Date().toISOString(), days: DAYS, items: uniq, errors }, null, 1) + '\n');
  console.log(`公告監看：${uniq.length} 則`);
  for (const n of uniq) console.log(`  [${n.topic}] ${n.title}（${n.source} ${n.pubDate.slice(0, 10)}）`);
}

await main();
