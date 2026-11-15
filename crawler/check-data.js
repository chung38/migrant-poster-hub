// 檢查資料檔的格式，避免壞掉的資料推上線、讓網站某一區整塊空白。
//
// 用法：
//   node crawler/check-data.js                      檢查全部資料檔
//   node crawler/check-data.js docs/news.json       只檢查指定的檔案
//   node crawler/check-data.js --restore [--clean docs/thumbs] a.json b.json
//       這一組裡只要有一個不合格，整組都還原成上一版（git HEAD），結束碼為 1。
//       --clean 會一併刪掉該資料夾裡還沒進版控的新檔（例如沒用到的縮圖）。
//
// 檢查兩件事：
//   1. 格式：網站會用到的欄位都在、型別正確。
//   2. 沒有突然變少：例如文宣目錄比上一版少了兩成以上、新聞從有變成 0 則，
//      多半是來源網站改版或暫時壞掉，這時保留舊資料比較好。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 小工具 ───────────────────────────────────────────────────────────────
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isUrl = (v) => isStr(v) && /^https?:\/\//.test(v);
const isArr = Array.isArray;
const isObj = (v) => v !== null && typeof v === 'object' && !isArr(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isDate = (v) => isStr(v) && !Number.isNaN(Date.parse(v));
const len = (v) => (isArr(v) ? v.length : 0);

// 逐筆檢查，只回報前 3 筆有問題的，免得訊息太長
function eachItem(errs, list, name, check) {
  if (!isArr(list)) return;
  let bad = 0;
  list.forEach((it, i) => {
    const why = isObj(it) ? check(it, i) : '不是物件';
    if (why) {
      bad++;
      if (bad <= 3) errs.push(`${name}[${i}] ${why}`);
    }
  });
  if (bad > 3) errs.push(`${name} 另外還有 ${bad - 3} 筆有問題`);
}

// 回傳第一個不合格欄位的說明；全部合格回傳空字串
function fields(it, spec) {
  for (const [key, test, label] of spec) {
    if (!test(it[key])) return `缺少或格式錯誤：${key}（應為${label}）`;
  }
  return '';
}
const S = [isStr, '文字'];
const U = [isUrl, '網址'];
const A = [isArr, '陣列'];
const D = [isDate, '日期'];
const N = [isNum, '數字'];

function shrink(errs, name, now, before, ratio) {
  if (before >= 5 && now < before * ratio) {
    errs.push(`${name} 從 ${before} 筆掉到 ${now} 筆（少於上一版的 ${Math.round(ratio * 100)}%），可能是來源網站改版或暫時壞掉`);
  }
}
function wentEmpty(errs, name, now, before) {
  if (before > 0 && now === 0) errs.push(`${name} 從 ${before} 筆變成 0 筆，可能是來源網站暫時壞掉`);
}

// ── 各檔案的規則：(新資料, 上一版或 null) => 錯誤訊息陣列 ──────────────────
const RULES = {
  'docs/catalog.json'(j, prev) {
    const errs = [];
    if (!isArr(j.items)) return ['items 不是陣列'];
    if (!isArr(j.categories) || !j.categories.length) errs.push('categories 不是陣列或是空的');
    const ids = new Set();
    eachItem(errs, j.items, 'items', (it) => {
      const why = fields(it, [
        ['id', ...S], ['title', ...S], ['agency', ...S], ['fileUrl', ...U], ['sourcePage', ...U],
        ['thumb', ...S], ['primaryCategory', ...S], ['categories', ...A], ['langs', ...A],
      ]);
      if (why) return why;
      if (ids.has(it.id)) return `id 重複：${it.id}`;
      ids.add(it.id);
      if (!fs.existsSync(path.join(ROOT, 'docs', it.thumb))) return `找不到縮圖檔 docs/${it.thumb}`;
      return '';
    });
    if (prev) shrink(errs, 'items', j.items.length, len(prev.items), 0.8);
    return errs;
  },

  'docs/report.json'(j) {
    const errs = [];
    if (!isArr(j.sources)) return ['sources 不是陣列'];
    eachItem(errs, j.sources, 'sources', (it) => fields(it, [['id', ...S], ['ok', (v) => typeof v === 'boolean', '是/否']]));
    return errs;
  },

  'data/state.json'(j, prev) {
    if (!isObj(j.seenPages)) return ['seenPages 不是物件'];
    const errs = [];
    if (prev && isObj(prev.seenPages)) shrink(errs, 'seenPages', Object.keys(j.seenPages).length, Object.keys(prev.seenPages).length, 0.8);
    return errs;
  },

  'docs/news.json'(j, prev) {
    const errs = [];
    if (!isDate(j.updatedAt)) errs.push('updatedAt 不是日期');
    if (!isArr(j.items)) return [...errs, 'items 不是陣列'];
    eachItem(errs, j.items, 'items', (it) => fields(it, [['title', ...S], ['link', ...U], ['source', ...S]]));
    if (prev) wentEmpty(errs, 'items', j.items.length, len(prev.items));
    return errs;
  },

  'data/news-raw.json'(j) {
    if (!isArr(j)) return ['整個檔案應該是陣列'];
    const errs = [];
    eachItem(errs, j, '', (it) => fields(it, [['title', ...S], ['link', ...U]]));
    return errs;
  },

  'docs/watch.json'(j) {
    const errs = [];
    if (!isDate(j.checkedAt)) errs.push('checkedAt 不是日期');
    if (!isArr(j.items)) return [...errs, 'items 不是陣列'];
    eachItem(errs, j.items, 'items', (it) => fields(it, [['topic', ...S], ['title', ...S], ['link', ...U]]));
    return errs;
  },

  'docs/laws.json'(j, prev) {
    const errs = [];
    if (!isDate(j.checkedAt)) errs.push('checkedAt 不是日期');
    if (!isNum(j.parser)) errs.push('parser 不是數字');
    if (!isArr(j.items) || !j.items.length) return [...errs, 'items 不是陣列或是空的'];
    eachItem(errs, j.items, 'items', (it) => fields(it, [['pcode', ...S], ['title', ...S], ['url', ...U]]));
    if (!isObj(j.chapters)) return [...errs, 'chapters 不是物件'];
    for (const [id, ch] of Object.entries(j.chapters)) {
      if (!isObj(ch) || !isArr(ch.parts)) { errs.push(`chapters.${id}.parts 不是陣列`); continue; }
      eachItem(errs, ch.parts, `chapters.${id}.parts`, (p) => fields(p, [['pcode', ...S], ['url', ...U], ['articles', ...A]]));
      const before = prev?.chapters?.[id]?.parts;
      if (isArr(before) && before.length && !ch.parts.length) errs.push(`chapters.${id} 的法條原文不見了（上一版有 ${before.length} 段）`);
    }
    if (prev) shrink(errs, 'items', j.items.length, len(prev.items), 0.7);
    return errs;
  },

  'docs/policy.json'(j, prev) {
    const errs = [];
    if (!isDate(j.checkedAt)) errs.push('checkedAt 不是日期');
    if (!isArr(j.items)) return [...errs, 'items 不是陣列'];
    eachItem(errs, j.items, 'items', (it) => fields(it, [['id', ...S], ['title', ...S], ['date', ...D], ['url', ...U]]));
    if (prev) wentEmpty(errs, 'items', j.items.length, len(prev.items));
    return errs;
  },

  'docs/sea-news.json'(j, prev) {
    const errs = [];
    if (!isDate(j.updatedAt)) errs.push('updatedAt 不是日期');
    if (!isArr(j.countries) || !j.countries.length) return [...errs, 'countries 不是陣列或是空的'];
    eachItem(errs, j.countries, 'countries', (c, i) => {
      const why = fields(c, [['id', ...S], ['country', ...S], ['items', ...A]]);
      if (why) return why;
      eachItem(errs, c.items, `countries[${i}].items`, (it) => fields(it, [['title', ...S], ['url', ...U]]));
      return '';
    });
    const total = (x) => (isArr(x?.countries) ? x.countries.reduce((n, c) => n + len(c?.items), 0) : 0);
    if (prev) wentEmpty(errs, '所有國家的新聞', total(j), total(prev));
    return errs;
  },

  'data/sea-raw.json'(j) {
    return isObj(j.lists) ? [] : ['lists 不是物件'];
  },

  // 以下是人工維護的檔案（在 GitHub 網頁上修改時，check.yml 會自動檢查）
  'docs/guides.json'(j) {
    const errs = [];
    if (!isDate(j.updated)) errs.push('updated 不是日期（格式例：2026-11-11）');
    if (!isArr(j.commonSteps)) errs.push('commonSteps 不是陣列');
    if (!isArr(j.industries) || !j.industries.length) return [...errs, 'industries 不是陣列或是空的'];
    eachItem(errs, j.industries, 'industries', (it) => {
      const why = fields(it, [['id', ...S], ['name', ...S]]);
      if (why) return why;
      for (const k of ['who', 'quota', 'fee', 'wage', 'notes', 'laws', 'docs']) {
        if (it[k] !== undefined && !isArr(it[k])) return `${k} 應為陣列（用 [ ] 包起來）`;
      }
      return '';
    });
    return errs;
  },

  'docs/info.json'(j) {
    const errs = [];
    if (!isArr(j.hotlines)) errs.push('hotlines 不是陣列');
    else eachItem(errs, j.hotlines, 'hotlines', (it) => fields(it, [['name', ...S]]));
    if (!isArr(j.offices)) errs.push('offices 不是陣列');
    const p = j.payroll;
    if (!isObj(p)) return [...errs, 'payroll（薪資計算用的費率）不見了'];
    for (const k of ['liRate', 'liEmp', 'nhiRate', 'nhiEmp', 'taxLow', 'taxHigh', 'domBase', 'otMonth', 'otMonthMax']) {
      if (!isNum(p[k])) errs.push(`payroll.${k} 應為數字`);
    }
    for (const k of ['liGrades', 'nhiGrades', 'svcFee']) {
      if (!isArr(p[k]) || !p[k].every(isNum)) errs.push(`payroll.${k} 應為數字陣列`);
    }
    return errs;
  },

  'sources.json'(j) {
    const errs = [];
    if (!isObj(j.settings)) errs.push('settings 不是物件');
    if (!isArr(j.sources)) return [...errs, 'sources 不是陣列'];
    const ids = new Set();
    eachItem(errs, j.sources, 'sources', (it) => {
      // 一般來源靠 startUrls；有 type 的（例如彰化 chcgNews2）是走對方的資料 API，改看 base
      const why = fields(it, [['id', ...S], ['agency', ...S], ...(it.type ? [['base', ...U]] : [['startUrls', ...A]])]);
      if (why) return why;
      if (ids.has(it.id)) return `id 重複：${it.id}`;
      ids.add(it.id);
      if (it.startUrls !== undefined && !(isArr(it.startUrls) && it.startUrls.every(isUrl))) return 'startUrls 裡有不是網址的項目';
      return '';
    });
    return errs;
  },

  'categories.json'(j) {
    const errs = [];
    if (!isArr(j.categories) || !j.categories.length) return ['categories 不是陣列或是空的'];
    eachItem(errs, j.categories, 'categories', (it) => fields(it, [['name', ...S], ['keywords', ...A]]));
    return errs;
  },
};

// ── 主程式 ───────────────────────────────────────────────────────────────
function readPrev(rel) {
  try {
    return JSON.parse(execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }));
  } catch {
    return null; // 上一版沒有這個檔、或上一版本身就壞了
  }
}

function checkFile(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return ['檔案不存在'];
  let j;
  try {
    j = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    return [`不是合法的 JSON：${e.message}`];
  }
  const rule = RULES[rel];
  if (!rule) return [];
  try {
    return rule(j, readPrev(rel));
  } catch (e) {
    return [`檢查時出錯：${e.message}`];
  }
}

function restore(files, cleanDirs) {
  for (const rel of files) {
    try {
      execFileSync('git', ['cat-file', '-e', `HEAD:${rel}`], { cwd: ROOT, stdio: 'ignore' });
      execFileSync('git', ['checkout', 'HEAD', '--', rel], { cwd: ROOT, stdio: 'ignore' });
      console.log(`  ↩ 已還原成上一版：${rel}`);
    } catch {
      fs.rmSync(path.join(ROOT, rel), { force: true });
      console.log(`  ✕ 上一版沒有這個檔，已刪除：${rel}`);
    }
  }
  for (const dir of cleanDirs) {
    execFileSync('git', ['clean', '-fdq', '--', dir], { cwd: ROOT, stdio: 'ignore' });
    console.log(`  ✕ 已清掉 ${dir} 裡新增的檔案`);
  }
}

const args = process.argv.slice(2);
const doRestore = args.includes('--restore');
const cleanDirs = [];
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--restore') continue;
  if (args[i] === '--clean') { cleanDirs.push(args[++i]); continue; }
  files.push(path.relative(ROOT, path.resolve(args[i])).split(path.sep).join('/'));
}
const targets = files.length ? files : Object.keys(RULES).filter((rel) => fs.existsSync(path.join(ROOT, rel)));

const failed = [];
for (const rel of targets) {
  const errs = checkFile(rel);
  if (errs.length) {
    failed.push([rel, errs]);
    console.log(`✗ ${rel}`);
    for (const e of errs) {
      console.log(`    ${e}`);
      if (process.env.GITHUB_ACTIONS) console.log(`::error file=${rel}::${e}`);
    }
  } else {
    console.log(`✓ ${rel}`);
  }
}

if (failed.length && process.env.GITHUB_STEP_SUMMARY) {
  const md = ['### 資料檢查沒通過', '', doRestore ? '下面這組檔案已還原成上一版，網站會繼續顯示舊資料。' : '', ''];
  for (const [rel, errs] of failed) md.push(`**${rel}**`, ...errs.map((e) => `- ${e}`), '');
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n');
}

if (failed.length) {
  if (doRestore) restore(targets, cleanDirs);
  process.exit(1);
}
