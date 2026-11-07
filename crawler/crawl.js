// crawler/crawl.js
// 每天執行一次：到 sources.json 列出的政府網頁抓最新文宣 → 分類 → 寫入 docs/catalog.json
// 不保存原始檔，只存「政府網站上的檔案連結」＋一張小縮圖（docs/thumbs/*.webp，每張約 10–30KB）
//
// 用法：
//   node crawler/crawl.js                 正常執行
//   node crawler/crawl.js --only wda-file 只跑某一個來源
//   node crawler/crawl.js --dry           只列出會下載什麼，不下載
//   node crawler/crawl.js --reclassify    改了 categories.json 後，重新分類既有資料
//   node crawler/crawl.js --migrate       （一次性）把舊版 archive/ 的檔案轉成縮圖後刪除

import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
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
const THUMB_DIR = path.join(ROOT, 'docs', 'thumbs');
const execFileP = promisify(execFile);

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const RECLASSIFY = args.includes('--reclassify');
const MIGRATE = args.includes('--migrate');
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
  thumbWidth: 360,
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

function guessExt(url, headers) {
  const ct = (headers?.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const cd = headers?.get('content-disposition') || '';
  const cdName = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)/i) || [])[1] || '');
  const fromName = (cdName.match(/\.([a-z0-9]{2,5})$/i) || [])[1];
  const fromUrl = (url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i) || [])[1];
  const ext = (CONTENT_TYPE_EXT[ct] || fromName || fromUrl || '').toLowerCase();
  return { ext: ext === 'jpeg' ? 'jpg' : ext, contentType: ct };
}

/** 合併「內頁標題」與「檔案連結文字」，避免出現「【X】－【X】-宣導」這種重複 */
const core = (t = '') =>
  t.replace(/\.(pdf|jpe?g|png|gif|webp|docx?|pptx?|odt|odp|zip)$/i, '')
    .replace(/LINE@移點通|多國語言版|多國語版|宣導|下載|檔案|另開新視窗/g, '')
    .replace(/[\s【】\[\]（）()「」『』〈〉《》<>\-－—_.:：,，、!！?？]/g, '')
    .toLowerCase();

function mergeTitle(pageTitle = '', linkText = '') {
  const page = clean(pageTitle);
  const link = clean(linkText).replace(/\.(pdf|jpe?g|png|gif|webp|docx?|pptx?|odt|odp|zip)$/i, '');
  const cp = core(page);
  const cl = core(link);
  if (!cl || cp.includes(cl)) return page || link;
  if (!cp) return link;
  if (cl.includes(cp)) {
    // 連結文字＝標題＋額外資訊（例如「【X】越南文版」）→ 只補上多出來的部分
    let rest = cl;
    rest = rest.replace(cp, '');
    const m = link.match(/(中文|越南|越文|印尼|泰文|泰語|泰國|英文|英語|菲律賓|tagalog|english|vietnam|indonesia|thai)[^\s－-]*/i);
    return m ? `${page}－${m[0]}` : rest.length >= 2 ? `${page}－${link}` : page;
  }
  return `${page}－${link}`;
}

/** 產生縮圖：圖片直接縮；PDF 用 pdftoppm 轉第一頁。失敗回傳 null（網頁會顯示檔案類型圖示） */
async function makeThumb(buf, ext, id) {
  try {
    let input = buf;
    if (ext === 'pdf') {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'th-'));
      try {
        await fs.writeFile(path.join(tmp, 'in.pdf'), buf);
        await execFileP('pdftoppm', ['-f', '1', '-l', '1', '-r', '60', '-png', '-singlefile', path.join(tmp, 'in.pdf'), path.join(tmp, 'p')], { timeout: 60000 });
        input = await fs.readFile(path.join(tmp, 'p.png'));
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    } else if (!IMAGE_EXT.includes(ext)) {
      return null;
    }
    await fs.mkdir(THUMB_DIR, { recursive: true });
    const rel = `thumbs/${id}.webp`;
    await sharp(input, { animated: false, limitInputPixels: 2e8 })
      .rotate()
      .resize({ width: settings.thumbWidth, height: Math.round(settings.thumbWidth * 1.5), fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 68 })
      .toFile(path.join(ROOT, 'docs', rel));
    return rel;
  } catch (e) {
    console.log(`   (縮圖失敗 ${id}：${e.message.split('\n')[0]})`);
    return null;
  }
}

// ---------------------------------------------------------------- 主流程

/** 彰化縣外國人在地服務網：列表是 JavaScript 從 API 載入的，所以直接呼叫它的 API（各語言分開呼叫） */
async function chcgNews2Candidates(src, report) {
  const base = src.base || 'https://foreigners.chcg.gov.tw';
  const out = [];
  for (const lang of src.langs || ['zh']) {
    await politeWait(base);
    const res = await fetch(`${base}/Api/WebAp/News2/List`, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ lang, groupSeq: src.groupSeq ?? 2, isNews: null, keyword: '', sortingDesc: true, sorting: 'CreatedDate', currentPage: 1, pageSize: src.pageSize || 100 }),
      signal: AbortSignal.timeout(settings.timeoutMs),
      dispatcher: src.insecureTLS ? insecureAgent : undefined,
    });
    if (!res.ok) throw new Error(`API ${lang} HTTP ${res.status}`);
    const json = await res.json();
    (json.data || []).forEach((d, idx) => {
      const sourcePage = `${base}/News2/Detail/${d.newsId}`;
      const date = (d.startDate || '').slice(0, 10) || null;
      const common = { sourcePage, date, snippet: clean(d.summary || ''), lang, seriesOrder: idx };
      const photos = (d.photoList && d.photoList.length ? d.photoList : d.photo ? [d.photo] : []);
      photos.forEach((p, k) => out.push({ ...common, fileUrl: `${base}/Photo/ori/${p.code}`, title: clean(d.name), linkText: p.name || '', photoNo: k }));
      if (d.file?.code) out.push({ ...common, fileUrl: `${base}/File/Get/${d.file.code}`, title: clean(d.name), linkText: d.file.name || '', photoNo: photos.length });
    });
    report.listedDetails = (report.listedDetails || 0) + (json.data || []).length;
  }
  return out;
}

async function crawlSource(src, report, budget) {
  const candidates = [];
  const details = new Map();

  if (src.type === 'chcgNews2') candidates.push(...(await chcgNews2Candidates(src, report)));

  for (const start of src.startUrls || []) {
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
          title: multi ? mergeTitle(pageTitle, linkText) : pageTitle,
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
      report.errors.push('已達本次上限 maxNewFilesPerRun，其餘明天繼續');
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
      report.errors.push(`${c.fileUrl}：${e.message}`);
    }
  }
}

async function saveCandidate(c, src, report) {
  // 暫時下載（只為了判斷檔案類型、去重複、做縮圖），原始檔不保存
  let buf = null;
  let headers = null;
  let finalUrl = c.fileUrl;
  try {
    ({ buf, headers, finalUrl } = await request(c.fileUrl, src, { maxBytes: settings.maxFileMB * 1048576 }));
  } catch (e) {
    if (!e.tooBig) throw e; // 太大的檔案：不做縮圖，但連結照樣收錄
  }
  const { ext, contentType } = guessExt(finalUrl, headers);
  if (!ext || !FILE_EXT.includes(ext) || contentType.startsWith('text/html')) {
    state.skippedUrls[c.fileUrl] = `不是文宣檔 (${contentType || '未知'})`;
    return;
  }
  if (buf && IMAGE_EXT.includes(ext) && buf.length < settings.minImageKB * 1024) {
    state.skippedUrls[c.fileUrl] = '圖片太小（多半是網站圖示）';
    return;
  }
  const hash = buf ? sha256(buf) : null;
  const dup = hash && bySha.get(hash);
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
  const langs = detectLangs({ title: `${title} ${c.linkText} ${fileName}`, text: c.snippet, url: `${c.sourcePage} ${finalUrl}` }, c.lang || src.lang);
  const id = shortId(c.fileUrl);

  const item = {
    id,
    title,
    agency: src.agency,
    sources: [src.id],
    sourceName: src.name,
    sourcePage: c.sourcePage,
    fileUrl: finalUrl,
    ext,
    size: buf ? buf.length : Number(headers?.get('content-length') || 0) || null,
    sha256: hash,
    thumb: buf ? await makeThumb(buf, ext, id) : null,
    phash: undefined,
    date: c.date,
    langs,
    primaryCategory: primary,
    categories: all,
    snippet: c.snippet ? c.snippet.slice(0, 200) : '',
    addedAt: now(),
  };
  if (c.seriesOrder != null) item.seriesOrder = c.seriesOrder;
  if (c.photoNo != null) item.photoNo = c.photoNo;
  if (finalUrl !== c.fileUrl) item.altUrls = [c.fileUrl];

  catalog.items.push(item);
  byUrl.set(c.fileUrl, item);
  byUrl.set(finalUrl, item);
  if (hash) bySha.set(hash, item);
  report.newItems.push(item.title);
}

async function reclassifyAll() {
  const srcMap = Object.fromEntries(cfg.sources.map((x) => [x.id, x]));
  for (const it of catalog.items) {
    const src = srcMap[it.sources?.[0]] || {};
    const { primary, all } = classify({ title: it.title, text: it.snippet }, cats, src.defaultCategory);
    it.primaryCategory = primary;
    it.categories = all;
  }
  console.log(`重新分類完成，共 ${catalog.items.length} 筆`);
}

/** 舊版（有 archive/ 資料夾）→ 新版：做縮圖、修標題、刪除原始檔 */
async function migrateOld() {
  let n = 0;
  for (const it of catalog.items) {
    const sep = it.title.indexOf('－');
    if (sep > 0) it.title = mergeTitle(it.title.slice(0, sep), it.title.slice(sep + 1));
    if (it.localPath) {
      const abs = path.join(ROOT, it.localPath);
      if (fss.existsSync(abs) && !it.thumb) it.thumb = await makeThumb(await fs.readFile(abs), it.ext, it.id);
      delete it.localPath;
      n++;
    }
  }
  for (const [u, why] of Object.entries(state.skippedUrls)) if (/太大/.test(why)) delete state.skippedUrls[u];
  await reclassifyAll();
  await fs.rm(path.join(ROOT, 'archive'), { recursive: true, force: true });
  console.log(`轉換完成：${n} 筆改為只存連結＋縮圖，已刪除 archive/`);
}


// ---------------------------------------------------------------- 跨網頁合併同一則文宣的各語言版本

const LANG_VERSION = { zh: '中文版', vi: '越南文版', id: '印尼文版', th: '泰文版', en: '英文版' };
// 標題裡代表語言版本的字眼，例如「英語版（English）」「越南文版」「(泰文)」
const LANG_MARK_RE = /\s*[-－—_]?\s*(國語|中文|華語|英語|英文|泰語|泰文|越南語|越南文|越文|印尼語|印尼文|印文|菲律賓語|菲語)版?\s*([（(][^）)]*[）)])?/g;

/**
 * 有些機關把每種語言放在不同網頁，這裡把它們標成同一組（item.group），搜尋頁會合成一張卡片。
 * 1. 標題去掉語言字眼後相同 → 同一組（例如司法院《勞動事件法推廣單》英語版／泰語版…）
 * 2. 同一個 series（例如交通部 168 的越／印／泰／英文版）同一天發布、各語言數量相同 → 依發布順序配對
 */
function assignGroups(items) {
  for (const it of items) { delete it.group; delete it.groupTitle; delete it.version; }

  const byTitle = new Map();
  for (const it of items) {
    const base = it.title.split('－')[0];
    const marks = base.match(LANG_MARK_RE);
    if (!marks) continue;
    const stripped = clean(base.replace(LANG_MARK_RE, ' '));
    if (stripped.length < 4) continue;
    const key = `${it.agency}|${stripped}`;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push({ it, version: clean(marks.join(' ').replace(/^[-－—_\s]+/, '')) });
  }
  for (const [key, arr] of byTitle) {
    if (new Set(arr.map((x) => x.it.sourcePage)).size < 2) continue;
    for (const { it, version } of arr) {
      it.group = `t:${shortId(key)}`;
      it.groupTitle = key.split('|')[1];
      it.version = version;
    }
  }

  // 同一個 series（例如交通部 168、彰化縣服務網）的各語言版：
  // 同一天發布的公告，用「縮圖長得像不像」（感知雜湊 dHash）配對；圖文排版相同、只是文字語言不同
  const seriesOf = Object.fromEntries(cfg.sources.filter((x) => x.series).map((x) => [x.id, x.series]));
  const buckets = new Map();
  for (const it of items) {
    const series = seriesOf[it.sources?.[0]];
    if (!series || it.group) continue;
    const key = `${series}|${it.date || ''}`;
    if (!buckets.has(key)) buckets.set(key, new Map());
    const units = buckets.get(key);
    const ukey = `${it.langs?.[0] || 'zh'}|${it.sourcePage}`;
    if (!units.has(ukey)) units.set(ukey, []);
    units.get(ukey).push(it);
  }
  const LANG_PRIORITY = ['zh', 'en', 'vi', 'id', 'th'];
  const langOf = (u) => u[0].langs?.[0] || 'zh';
  for (const [key, unitMap] of buckets) {
    const units = [...unitMap.values()].map((u) => u.sort((a, b) => (a.photoNo || 0) - (b.photoNo || 0)));
    const langs = [...new Set(units.map(langOf))].sort((a, b) => LANG_PRIORITY.indexOf(a) - LANG_PRIORITY.indexOf(b));
    if (langs.length < 2) continue;
    const clusters = []; // 每個 cluster：{ anchor: unit, members: Map(lang → unit) }
    for (const lang of langs) {
      const mine = units.filter((u) => langOf(u) === lang);
      const pairs = [];
      for (const u of mine) {
        for (const c of clusters) {
          if (c.members.has(lang)) continue;
          const d = hamming(u[0].phash, c.anchor[0].phash);
          if (d <= PHASH_MAX) pairs.push({ u, c, d });
        }
      }
      pairs.sort((x, y) => x.d - y.d);
      const used = new Set();
      for (const { u, c, d } of pairs) {
        if (used.has(u) || c.members.has(lang)) continue;
        c.members.set(lang, u);
        used.add(u);
      }
      for (const u of mine) if (!used.has(u)) clusters.push({ anchor: u, members: new Map([[lang, u]]) });
    }
    clusters.forEach((c, i) => {
      if (c.members.size < 2) return;
      const lead = c.members.get('zh') || c.members.get('en') || c.anchor;
      for (const unit of c.members.values()) {
        unit.forEach((m, k) => {
          m.group = `s:${shortId(`${key}|${lead[0].id}`)}`;
          m.groupTitle = lead[0].title;
          m.version = (LANG_VERSION[m.langs?.[0]] || '') + (unit.length > 1 ? `（第 ${k + 1} 張）` : '');
        });
      }
    });
  }
}

// ---------------------------------------------------------------- 感知雜湊（判斷兩張圖是不是同一張海報的不同語言版）

const PHASH_MAX = 0.42; // 16×16 dHash 的差異比例；實測同一張海報不同語言約 0–0.40，不同海報約 0.41 以上
async function dhash(input) {
  const N = 16;
  const { data } = await sharp(input).greyscale().resize(N + 1, N, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let bits = '';
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) bits += data[y * (N + 1) + x] > data[y * (N + 1) + x + 1] ? '1' : '0';
  return bits;
}
function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n / a.length;
}
/** 舊資料沒有 phash 的，從縮圖補算 */
async function fillPhash(items) {
  for (const it of items) {
    if (it.phash || !it.thumb) continue;
    const abs = path.join(ROOT, 'docs', it.thumb);
    if (fss.existsSync(abs)) it.phash = await dhash(abs).catch(() => undefined);
  }
}

async function main() {
  const started = now();
  const reports = [];
  if (MIGRATE) {
    await migrateOld();
  } else if (RECLASSIFY) {
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

  await fillPhash(catalog.items);
  assignGroups(catalog.items);
  catalog.items.sort((a, b) => (b.date || b.addedAt).localeCompare(a.date || a.addedAt));
  catalog.updatedAt = now();
  catalog.categories = categoriesJson.categories.map((c) => ({ name: c.name, icon: c.icon, keywords: c.keywords }))
    .concat([{ name: cats.fallback, icon: '📁', keywords: [] }]);
  await writeJson(CATALOG_FILE, catalog);
  await writeJson(STATE_FILE, state);
  if (!RECLASSIFY && !MIGRATE) await writeJson(REPORT_FILE, { startedAt: started, finishedAt: now(), sources: reports });
  console.log(`\n完成：目錄共 ${catalog.items.length} 筆`);
}

await main();
