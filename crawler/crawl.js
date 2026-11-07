// crawler/crawl.js
// 每天執行一次：到 sources.json 列出的政府網頁抓最新文宣 → 下載 → 分類 → 寫入 docs/catalog.json
//
// 用法：
//   node crawler/crawl.js                 正常執行
//   node crawler/crawl.js --only wda-file 只跑某一個來源
//   node crawler/crawl.js --dry           只列出會下載什麼，不下載
//   node crawler/crawl.js --reclassify    改了 categories.json 後，重新分類既有資料並搬資料夾

import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { fetch, Agent } from 'undici';
import iconv from 'iconv-lite';
import { compileCategories, classify, detectLangs } from './classify.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES_FILE = process.env.SOURCES_FILE || path.join(ROOT, 'sources.json');
const CATEGORIES_FILE = path.join(ROOT, 'categories.json');
const CATALOG_FILE = path.join(ROOT, 'docs', 'catalog.json');
const REPORT_FILE = path.join(ROOT, 'docs', 'report.json');
const STATE_FILE = path.join(ROOT, 'data', 'state.json');
const ARCHIVE_DIR = 'archive';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const RECLASSIFY = args.includes('--reclassify');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 MigrantPosterHub/1.0';

const FILE_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'doc', 'docx', 'ppt', 'pptx', 'odt', 'odp', 'zip'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const FILE_URL_RE = new RegExp(`\\.(${FILE_EXT.join('|')})(?:$|[?#])`, 'i');
// 政府網站常見的「下載」網址樣式（不一定有副檔名）
const DOWNLOAD_URL_RE = /(\/download-file\/|\/dl-\d+-[0-9a-f]+\.html|Download\.ashx|FileDownload|filedownload|download\.aspx|GetFile|\/Uploads?\/)/i;
// 網站介面圖示，不要下載
const JUNK_RE = /(logo|icon|favicon|banner|btn_|button|arrow|accessib|freego|qrcode|share|print\.png|fb\.png|line\.png|email\.png|ig\.png|yt\.png|\.svg)(?:$|[?#._-])/i;

const CONTENT_TYPE_EXT = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/zip': 'zip',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const shortId = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}
async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 1) + '\n', 'utf8');
}

// ---------------------------------------------------------------- 設定

const cfg = await readJson(SOURCES_FILE, null);
if (!cfg) throw new Error(`讀不到 ${SOURCES_FILE}`);
const settings = {
  maxFileMB: 20,
  maxNewFilesPerRun: 300,
  maxDetailPerSource: 30,
  delayMs: 1200,
  timeoutMs: 30000,
  minImageKB: 15,
  ...(cfg.settings || {}),
};
const categoriesJson = await readJson(CATEGORIES_FILE, null);
const cats = compileCategories(categoriesJson);

const catalog = await readJson(CATALOG_FILE, { items: [] });
const state = await readJson(STATE_FILE, { seenPages: {}, skippedUrls: {} });
state.seenPages ||= {};
state.skippedUrls ||= {};

const byUrl = new Map();
const bySha = new Map();
for (const it of catalog.items) {
  byUrl.set(it.fileUrl, it);
  for (const u of it.altUrls || []) byUrl.set(u, it);
  if (it.sha256) bySha.set(it.sha256, it);
}

// ---------------------------------------------------------------- 網路

const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });
const lastHit = new Map();

async function politeWait(url) {
  const host = new URL(url).host;
  const wait = (lastHit.get(host) || 0) + settings.delayMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

async function request(url, src, { maxBytes } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    await politeWait(url);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8', ...(src.headers || {}) },
        redirect: 'follow',
        signal: AbortSignal.timeout(settings.timeoutMs),
        dispatcher: src.insecureTLS ? insecureAgent : undefined,
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        const err = new Error(`HTTP ${res.status}`);
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw Object.assign(err, { fatal: true });
        throw err;
      }
      const len = Number(res.headers.get('content-length') || 0);
      if (maxBytes && len > maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw Object.assign(new Error(`檔案太大 ${(len / 1048576).toFixed(1)}MB`), { fatal: true, tooBig: true });
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (maxBytes && buf.length > maxBytes) {
        throw Object.assign(new Error(`檔案太大 ${(buf.length / 1048576).toFixed(1)}MB`), { fatal: true, tooBig: true });
      }
      return { buf, headers: res.headers, finalUrl: res.url || url };
    } catch (e) {
      lastErr = e;
      if (e.fatal) break;
      await sleep(2000 * (attempt + 1));
    }
  }
  const msg = lastErr?.cause?.code ? `${lastErr.message} (${lastErr.cause.code})` : lastErr?.message;
  throw Object.assign(new Error(msg || '下載失敗'), { tooBig: lastErr?.tooBig });
}

function decodeHtml(buf, headers) {
  let charset = (headers.get('content-type') || '').match(/charset=([\w-]+)/i)?.[1];
  if (!charset) {
    const head = buf.subarray(0, 2048).toString('latin1');
    charset = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  }
  charset = (charset || 'utf-8').toLowerCase();
  if (charset === 'big5' || charset === 'big-5') charset = 'big5';
  return iconv.encodingExists(charset) ? iconv.decode(buf, charset) : buf.toString('utf8');
}

async function getPage(url, src) {
  const { buf, headers, finalUrl } = await request(url, src);
  const html = decodeHtml(buf, headers);
  return { $: cheerio.load(html), finalUrl };
}

// ---------------------------------------------------------------- 解析

const clean = (s = '') => s.replace(/\s+/g, ' ').trim();

function absUrl(href, base) {
  if (!href) return null;
  href = href.trim();
  if (/^(javascript:|mailto:|tel:|#)/i.test(href)) return null;
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

function isFileUrl(url) {
  if (JUNK_RE.test(url.split('?')[0].split('/').pop() || '')) return false;
  return FILE_URL_RE.test(url) || DOWNLOAD_URL_RE.test(url);
}

function textOf($el) {
  return clean($el.attr('title') || $el.text() || $el.find('img').attr('alt') || '');
}

function collectLinks($, base) {
  const out = [];
  $('a[href]').each((_, a) => {
    const $a = $(a);
    const url = absUrl($a.attr('href'), base);
    if (url) out.push({ url, text: textOf($a) });
  });
  return out;
}

function pickMain($, src) {
  const sels = [src.contentSelector, 'main', '#main', '.main', 'article', '#content', '.content', '.cp', '.page-content', '.container']
    .filter(Boolean);
  for (const s of sels) {
    const $m = $(s).first();
    if ($m.length && clean($m.text()).length > 30) return $m;
  }
  return $('body');
}

function extractDate(text) {
  let m = text.match(/(20\d{2})[./\-年](\d{1,2})[./\-月](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = text.match(/(?<!\d)(1[01]\d)[./\-年](\d{1,2})[./\-月](\d{1,2})/); // 民國年
  if (m) return `${Number(m[1]) + 1911}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return null;
}

function extractDetail($, pageUrl, src) {
  $('script, style, noscript, nav, header, footer, .breadcrumb, .navbar, .menu').remove();
  const $main = pickMain($, src);
  const part = (s) => clean((s || '').split(/\s[|｜]\s|[|｜]/)[0]);
  const site = part($('meta[property="og:site_name"]').attr('content'));
  const options = [
    part($('meta[property="og:title"]').attr('content')),
    part($('title').text()),
    clean($main.find('h1').first().text()),
    clean($main.find('h2, h3').first().text()),
  ];
  const title = options.find((t) => t.length >= 4 && t !== site) || '';
  const mainText = clean($main.text());
  const files = [];
  for (const l of collectLinks(cheerio.load($main.html() || ''), pageUrl)) {
    if (isFileUrl(l.url)) files.push(l);
  }
  if (src.ogImage) {
    const og = absUrl($('meta[property="og:image"]').attr('content'), pageUrl);
    if (og) files.push({ url: og, text: '' });
  }
  if (src.contentImages) {
    $main.find('img[src]').each((_, img) => {
      const u = absUrl($(img).attr('src'), pageUrl);
      if (u && !JUNK_RE.test(u.split('/').pop())) files.push({ url: u, text: clean($(img).attr('alt') || '') });
    });
  }
  return { title, date: extractDate(mainText), snippet: mainText.slice(0, 400), files };
}

/** 列表上的文字常帶日期、[置頂]、「點此下載」等，清掉 */
function cleanListText(t = '') {
  return clean(t)
    .replace(/\[?置頂\]?/g, '')
    .replace(/^(\d{2,4}[./-]\d{1,2}[./-]\d{1,2})\s*/, '')
    .replace(/(\(另開新視窗\)|（另開新視窗）|點此下載|開啟新視窗)/g, '')
    .trim();
}

function keywordOk(src, text) {
  const kws = src.requireKeywords || [];
  if (!kws.length) return true;
  const t = (text || '').toLowerCase();
  return kws.some((k) => t.includes(k.toLowerCase()));
}

// ---------------------------------------------------------------- 存檔

const safeName = (s, n = 60) =>
  clean(s)
    .replace(/[\\/:*?"<>|#%{}^~`[\]]+/g, '')
    .replace(/\s+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, n) || 'file';

function guessExt(url, headers) {
  const ct = (headers?.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const cd = headers?.get('content-disposition') || '';
  const cdName = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)/i) || [])[1] || '');
  const fromName = (cdName.match(/\.([a-z0-9]{2,5})$/i) || [])[1];
  const fromUrl = (url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i) || [])[1];
  const ext = (CONTENT_TYPE_EXT[ct] || fromName || fromUrl || '').toLowerCase();
  return { ext: ext === 'jpeg' ? 'jpg' : ext, contentType: ct };
}

function uniquePath(rel) {
  let p = rel;
  let i = 2;
  const { dir, name, ext } = path.parse(rel);
  while (fss.existsSync(path.join(ROOT, p))) p = path.join(dir, `${name}_${i++}${ext}`);
  return p.split(path.sep).join('/');
}

function buildPath(item) {
  const date = (item.date || item.addedAt.slice(0, 10)).replace(/-/g, '');
  const lang = item.langs.join('-');
  return path.join(ARCHIVE_DIR, safeName(item.primaryCategory, 20), safeName(item.agency, 20), `${date}_${safeName(item.title)}_${lang}.${item.ext}`);
}

// ---------------------------------------------------------------- 主流程

async function crawlSource(src, report, budget) {
  const candidates = [];
  const details = new Map();

  for (const start of src.startUrls) {
    const { $, finalUrl } = await getPage(start, src);
    const detailRe = src.detailPattern ? new RegExp(src.detailPattern) : null;
    for (const l of collectLinks($, finalUrl)) {
      if (detailRe && detailRe.test(l.url)) {
        if (!details.has(l.url) || (l.text && !details.get(l.url))) details.set(l.url, l.text);
      } else if (isFileUrl(l.url)) {
        if (src.sameHostOnly !== false && new URL(l.url).host !== new URL(finalUrl).host && !DOWNLOAD_URL_RE.test(l.url)) continue;
        candidates.push({ fileUrl: l.url, title: cleanListText(l.text), linkText: l.text, sourcePage: finalUrl, date: extractDate(l.text), snippet: '' });
      }
    }
  }
  report.listedDetails = details.size;

  let fetched = 0;
  for (const [url, text] of details) {
    if (fetched >= (src.maxDetail || settings.maxDetailPerSource)) break;
    if (state.seenPages[url] && !src.recheck) continue;
    if (text && !keywordOk(src, text)) continue;
    fetched++;
    try {
      const { $, finalUrl } = await getPage(url, src);
      const info = extractDetail($, finalUrl, src);
      const listTitle = cleanListText(text);
      const pageTitle = listTitle.length >= 4 ? listTitle : info.title || text;
      info.date ||= extractDate(text || '');
      const multi = new Set(info.files.map((f) => f.url)).size > 1;
      for (const f of info.files) {
        const linkText = f.text && f.text !== pageTitle ? f.text : '';
        candidates.push({
          fileUrl: f.url,
          title: multi && linkText ? `${pageTitle}－${linkText.replace(/\.(pdf|jpe?g|png)$/i, '')}` : pageTitle,
          linkText,
          sourcePage: finalUrl,
          date: info.date,
          snippet: info.snippet,
        });
      }
      state.seenPages[url] = now();
    } catch (e) {
      report.errors.push(`${url}：${e.message}`);
    }
  }
  report.fetchedDetails = fetched;

  const seenInRun = new Set();
  for (const c of candidates) {
    if (seenInRun.has(c.fileUrl)) continue;
    seenInRun.add(c.fileUrl);
    if (byUrl.has(c.fileUrl) || state.skippedUrls[c.fileUrl]) continue;
    if (!keywordOk(src, `${c.title} ${c.linkText} ${c.snippet}`)) continue;
    if (budget.left <= 0) {
      report.errors.push('已達本次下載上限 maxNewFilesPerRun，其餘明天繼續');
      break;
    }
    if (DRY) {
      report.newItems.push(c.title || c.fileUrl);
      budget.left--;
      continue;
    }
    try {
      await saveCandidate(c, src, report);
      budget.left--;
    } catch (e) {
      if (e.tooBig) state.skippedUrls[c.fileUrl] = e.message;
      report.errors.push(`${c.fileUrl}：${e.message}`);
    }
  }
}

async function saveCandidate(c, src, report) {
  const { buf, headers, finalUrl } = await request(c.fileUrl, src, { maxBytes: settings.maxFileMB * 1048576 });
  const { ext, contentType } = guessExt(finalUrl, headers);
  if (!ext || !FILE_EXT.includes(ext) || contentType.startsWith('text/html')) {
    state.skippedUrls[c.fileUrl] = `不是文宣檔 (${contentType || '未知'})`;
    return;
  }
  if (IMAGE_EXT.includes(ext) && buf.length < settings.minImageKB * 1024) {
    state.skippedUrls[c.fileUrl] = '圖片太小（多半是網站圖示）';
    return;
  }
  const hash = sha256(buf);
  const dup = bySha.get(hash);
  if (dup) {
    dup.altUrls = [...new Set([...(dup.altUrls || []), c.fileUrl])];
    if (!dup.sources.includes(src.id)) dup.sources.push(src.id);
    byUrl.set(c.fileUrl, dup);
    return;
  }

  const fileName = decodeURIComponent(finalUrl.split('?')[0].split('/').pop() || '');
  const title = clean(c.title) || fileName.replace(/\.[a-z0-9]+$/i, '') || '未命名文宣';
  const textForClass = `${c.linkText} ${fileName} ${c.snippet}`;
  const { primary, all } = classify({ title, text: textForClass }, cats, src.defaultCategory);
  const langs = detectLangs({ title: `${title} ${c.linkText} ${fileName}`, text: c.snippet, url: `${c.sourcePage} ${finalUrl}` }, src.lang);

  const item = {
    id: shortId(c.fileUrl),
    title,
    agency: src.agency,
    sources: [src.id],
    sourceName: src.name,
    sourcePage: c.sourcePage,
    fileUrl: c.fileUrl,
    ext,
    size: buf.length,
    sha256: hash,
    date: c.date,
    langs,
    primaryCategory: primary,
    categories: all,
    snippet: c.snippet ? c.snippet.slice(0, 200) : '',
    addedAt: now(),
  };
  item.localPath = uniquePath(buildPath(item));
  await fs.mkdir(path.join(ROOT, path.dirname(item.localPath)), { recursive: true });
  await fs.writeFile(path.join(ROOT, item.localPath), buf);

  catalog.items.push(item);
  byUrl.set(item.fileUrl, item);
  bySha.set(hash, item);
  report.newItems.push(item.title);
}

async function reclassifyAll() {
  let moved = 0;
  const srcMap = Object.fromEntries(cfg.sources.map((s) => [s.id, s]));
  for (const it of catalog.items) {
    const src = srcMap[it.sources?.[0]] || {};
    const { primary, all } = classify({ title: it.title, text: it.snippet }, cats, src.defaultCategory);
    it.primaryCategory = primary;
    it.categories = all;
    const want = buildPath(it).split(path.sep).join('/');
    if (it.localPath && path.dirname(want) !== path.dirname(it.localPath) && fss.existsSync(path.join(ROOT, it.localPath))) {
      const target = uniquePath(want);
      await fs.mkdir(path.join(ROOT, path.dirname(target)), { recursive: true });
      await fs.rename(path.join(ROOT, it.localPath), path.join(ROOT, target));
      it.localPath = target;
      moved++;
    }
  }
  console.log(`重新分類完成，搬移 ${moved} 個檔案`);
}

async function main() {
  const started = now();
  const reports = [];
  if (RECLASSIFY) {
    await reclassifyAll();
  } else {
    const budget = { left: settings.maxNewFilesPerRun };
    for (const src of cfg.sources) {
      if (src.enabled === false || (ONLY && src.id !== ONLY)) continue;
      const report = { id: src.id, name: src.name, agency: src.agency, ok: true, newItems: [], errors: [] };
      console.log(`\n▶ ${src.agency}｜${src.name}`);
      try {
        await crawlSource(src, report, budget);
      } catch (e) {
        report.ok = false;
        report.errors.unshift(`列表頁讀取失敗：${e.message}`);
      }
      console.log(`  新增 ${report.newItems.length} 筆${report.errors.length ? `，${report.errors.length} 個問題` : ''}`);
      for (const t of report.newItems) console.log(`   + ${t}`);
      for (const e of report.errors.slice(0, 5)) console.log(`   ! ${e}`);
      reports.push({ ...report, newCount: report.newItems.length, newItems: report.newItems.slice(0, 50), errors: report.errors.slice(0, 20) });
    }
  }
  if (DRY) return console.log('\n(--dry 模式，沒有寫入任何檔案)');

  catalog.items.sort((a, b) => (b.date || b.addedAt).localeCompare(a.date || a.addedAt));
  catalog.updatedAt = now();
  catalog.repo = process.env.GITHUB_REPOSITORY || catalog.repo || '';
  catalog.branch = process.env.GITHUB_REF_NAME || catalog.branch || 'main';
  catalog.categories = categoriesJson.categories.map((c) => ({ name: c.name, icon: c.icon, keywords: c.keywords }))
    .concat([{ name: cats.fallback, icon: '📁', keywords: [] }]);
  await writeJson(CATALOG_FILE, catalog);
  await writeJson(STATE_FILE, state);
  if (!RECLASSIFY) await writeJson(REPORT_FILE, { startedAt: started, finishedAt: now(), sources: reports });
  console.log(`\n完成：目錄共 ${catalog.items.length} 筆`);
}

await main();
