// crawler/laws.js
// 從「全國法規資料庫」自動找出移工相關法規，記錄每部法規的最新修正日期，寫入 docs/laws.json。
// 網頁的「聘僱指南」會列出這些法規，近 90 天內有修正的會標「最新修正」。
//
// 做法：逐一讀取勞動部就業服務類（N009xxxx）與勞動條件類（N003xxxx）法規頁，
// 依標題篩出跟外國人聘僱有關的法規。法規改名或新增時不用改程式。
//
// 用法：node crawler/laws.js

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { fetch } from 'undici';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'laws.json');
const UA = 'Mozilla/5.0 (compatible; MigrantPosterHub/1.0)';

// 要掃描的法規代碼範圍
const RANGES = [
  { prefix: 'N009', from: 1, to: 60 },  // 就業服務類
  { prefix: 'N003', from: 1, to: 60 },  // 勞動條件類（勞基法、最低工資法等）
];
// 標題符合這些字才收錄
const KEEP = /外國人|外國技術人力|移工|就業服務法|就業安定|轉換雇主|私立就業服務機構|勞動基準法$|最低工資法|聘僱/;
const SKIP = /大陸地區|香港|澳門|專業人才延攬|身心障礙|獎勵|補助|津貼/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const roc = (y, m, d) => `${Number(y) + 1911}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

async function readLaw(pcode) {
  const url = `https://law.moj.gov.tw/LawClass/LawAll.aspx?PCode=${pcode}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) return null;
  const $ = cheerio.load(await res.text());
  const text = $('body').text().replace(/\s+/g, ' ');
  const title = ($('#hlLawName').text() || (text.match(/法規名稱[：:]\s*(.+?)\s+(?:EN\s+)?(?:修正日期|公發布日|制定日期)/) || [])[1] || $('title').text().split(/[-|－]/)[0]).trim();
  if (!title || /查無|錯誤|Error/i.test(title)) return null;
  if (/廢止日期|已廢止/.test(text.slice(0, 600))) return null;
  const m = text.match(/修正日期[：:]\s*民國\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日/) || text.match(/(?:公發布日|制定日期)[：:]\s*民國\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日/);
  return { pcode, title, amended: m ? roc(m[1], m[2], m[3]) : null, url };
}

async function main() {
  const items = [];
  let ok = 0, fail = 0;
  for (const r of RANGES) {
    for (let i = r.from; i <= r.to; i++) {
      const pcode = `${r.prefix}${String(i).padStart(4, '0')}`;
      try {
        const law = await readLaw(pcode);
        ok++;
        if (law && KEEP.test(law.title) && !SKIP.test(law.title)) items.push(law);
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
  await fs.writeFile(OUT, JSON.stringify({ checkedAt: new Date().toISOString(), items }, null, 1) + '\n');
  console.log(`法規：收錄 ${items.length} 部（讀取成功 ${ok}、失敗 ${fail}）`);
  for (const l of items) console.log(`  ${l.amended}  ${l.title}  (${l.pcode})`);
}

await main();
