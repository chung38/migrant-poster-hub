// crawler/classify.js
// 類別判斷 + 語言判斷。中文、越南文、印尼文、泰文、英文關鍵字都適用。

/** 去掉越南文聲調、統一大小寫，讓 "ma tuý" 與 "ma túy"、"MA TUY" 都能對到 */
export function fold(s = '') {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .normalize('NFC');
}

const LATIN_ONLY = /^[a-z0-9 \-']+$/;

/** 把一個關鍵字轉成比對函式：純數字與英文字要有字界，避免 "lao" 對到 "lao động" 這類誤判 */
function makeMatcher(keyword) {
  const k = fold(keyword).trim();
  if (!k) return () => false;
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/^\d+$/.test(k)) {
    const re = new RegExp(`(?<!\\d)${esc}(?!\\d)`);
    return (t) => re.test(t);
  }
  if (LATIN_ONLY.test(k)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'u');
    return (t) => re.test(t);
  }
  return (t) => t.includes(k);
}

export function compileCategories(json) {
  return {
    fallback: json.fallback || '其他',
    list: json.categories.map((c) => ({
      name: c.name,
      icon: c.icon || '',
      keywords: c.keywords,
      matchers: [c.name, ...c.keywords].map(makeMatcher),
    })),
  };
}

/**
 * @param {{title?:string, text?:string, urls?:string}} input
 * @param {ReturnType<typeof compileCategories>} cats
 * @param {string} [defaultCategory] 來源指定的預設類別（例如 168 交通網）
 */
export function classify({ title = '', text = '' }, cats, defaultCategory) {
  const t = fold(title);
  const b = fold(text);
  const scored = [];
  for (const c of cats.list) {
    let score = 0;
    for (const m of c.matchers) {
      if (m(t)) score += 3;
      else if (m(b)) score += 1;
    }
    if (score > 0) scored.push({ name: c.name, score });
  }
  scored.sort((a, b2) => b2.score - a.score);
  let all = scored.map((s) => s.name);
  if (defaultCategory && !all.includes(defaultCategory)) {
    // 來源本身就是某類別（如交通部 168），標題沒命中關鍵字時以它為主
    if (all.length === 0) all = [defaultCategory];
    else all.push(defaultCategory);
  }
  if (all.length === 0) all = [cats.fallback];
  return { primary: all[0], all };
}

const LANG_RULES = [
  { code: 'vi', hint: /越南|越文|越語|tiếng việt|tieng viet|vietnam|locale=vi\b|\/(vn|vi)\//i,
    script: /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i },
  { code: 'id', hint: /印尼|印文|印語|indonesia|bahasa|locale=in\b|\/id\//i,
    script: /\b(dan|yang|untuk|dengan|tidak|pekerja|anda|jangan|bagi)\b/i },
  { code: 'th', hint: /泰文|泰語|泰國|thailand|\bthai\b(?!\s*s[aả]n)|locale=th\b|\/th\//i, script: /[฀-๿]/ },
  { code: 'en', hint: /英文|英語|english|菲律賓|菲語|tagalog|philippin|locale=(en|tl)\b|\/en\//i,
    script: /\b(the|and|for|your|you|of|workers?|safety|how|what)\b/i },
];

/** 回傳語言代碼陣列：vi / id / th / en / zh / multi */
export function detectLangs({ title = '', text = '', url = '' }, forced) {
  if (forced) return [forced];
  const hintText = `${title} ${url}`;
  const found = new Set();
  if (/多國語|多語|multilingual|五國語|四國語/i.test(hintText)) found.add('multi');
  for (const r of LANG_RULES) {
    if (r.hint.test(hintText)) found.add(r.code);
  }
  if (found.size === 0) {
    for (const r of LANG_RULES) if (r.script.test(title)) found.add(r.code);
  }
  if (found.size === 0 && /[一-鿿]/.test(title)) found.add('zh');
  if (found.size === 0) {
    for (const r of LANG_RULES) if (r.script.test(text.slice(0, 400))) found.add(r.code);
  }
  return found.size ? [...found] : ['zh'];
}
