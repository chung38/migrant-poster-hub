# 移次搞定｜移工文宣・新聞一次找齊

每天早上 06:23（台灣時間）自動到各政府機關網站抓最新的移工宣導文宣，
依類別整理，並提供一個可以搜尋的網頁。
**不保存原始檔**：只記錄政府網站上的檔案連結，另存一張約 10–30KB 的小縮圖，repo 幾乎不會變大。

- 搜「毒品」→ 列出所有反毒類文宣，連越南文（ma túy）、印尼文（narkoba）、泰文（ยาเสพติด）的都一起出來
- 沒有搜尋時，網頁會依類別分區顯示（反毒、交通安全、防詐騙、勞動權益、衛生防疫、消防防災…）
- 每份文宣都有縮圖；「開啟檔案」直接連到政府網站上的原始檔，「原網頁」回到該則公告頁

全部跑在 GitHub 上（GitHub Actions 排程 + GitHub Pages 網頁），**免費、不需要自己的伺服器**。

---

## 檔案結構

```
.github/workflows/crawl.yml   每日排程（GitHub Actions）
crawler/crawl.js              爬蟲主程式：抓取 → 下載 → 分類 → 寫入目錄
crawler/classify.js           類別與語言判斷
sources.json                  要抓哪些政府網站（可自行新增）
categories.json               類別與多國語關鍵字（可自行增減）
docs/index.html               搜尋網頁
docs/catalog.json             文宣目錄（程式自動產生，首次可不上傳）
docs/report.json              每次抓取的結果報告（自動產生）
docs/thumbs/*.webp            縮圖（自動產生）
data/state.json               已看過的網頁紀錄（自動產生）
package.json
.gitignore
```

---

## 哪些資料會自動更新

| 資料 | 頻率 | 程式 |
|---|---|---|
| 宣導文宣 | 每天 | `crawler/crawl.js` |
| 熱門移工新聞 | 每 4 小時 | `crawler/news.js` |
| 最低工資、就安費新公告偵測 | 每 4 小時 | `crawler/watch.js` |
| 移工相關法規清單與修正日期、各行業法條原文 | 每天 | `crawler/laws.js` |
| 勞動部「政策法令」公告 | 每天 | `crawler/policy.js` |
| 節日日期（農曆、伊斯蘭曆） | 網頁開啟時自動推算 | `docs/index.html` |

聘僱指南的「重點整理」（`docs/guides.json`）是人工維護。法條有修正或勞動部有新公告時：

1. 網頁該行業會顯示「有比這份整理更新的規定」提醒，並列出新公告與最新法條原文。
2. GitHub 會自動開一個 Issue 通知你（記得在 repo 右上角 Watch 設為 All Activity，或至少保持預設，才會收到 Email／App 通知）。
3. 確認後修改 `docs/guides.json` 內容，並把 `updated` 改成當天日期，提醒就會消失。

## 第一次設定（全部用 GitHub 網頁操作）

1. **建立新的 repository**，例如 `migrant-posters`，選 **Public**（Pages 免費版要 public；文宣都是政府公開資料）。
2. **上傳檔案**：`Add file → Upload files`，把 zip 解開後的檔案依路徑上傳。
   - `.github/workflows/crawl.yml` 和 `.gitignore` 是點開頭的檔案，拖曳上傳常常會被略過，
     請改用 `Add file → Create new file`，檔名欄直接輸入 `.github/workflows/crawl.yml`，再把內容貼上。
3. **開權限**：`Settings → Actions → General → Workflow permissions` 選 **Read and write permissions** → Save。
4. **開網頁**：`Settings → Pages → Build and deployment`
   Source 選 **Deploy from a branch**，Branch 選 **main**、資料夾選 **/docs** → Save。
5. **先手動跑一次**：`Actions → 每日抓取文宣 → Run workflow`。跑完約 5–15 分鐘。
6. 打開 `https://<你的帳號>.github.io/migrant-posters/` 就能搜尋了。之後每天自動更新。

---

## 新增其他機關（例如各縣市勞工局）

打開 `sources.json`，複製一段改網址即可。欄位說明：

| 欄位 | 說明 |
|---|---|
| `id` | 自己取的英文代號，不可重複 |
| `agency` | 機關名稱，會變成資料夾名稱與篩選選項 |
| `startUrls` | 文宣「列表頁」網址（可放多個，例如第 1、2 頁） |
| `detailPattern` | 列表裡「每一則文宣的內頁」網址特徵（正規表示式）。不填的話只抓列表頁上直接連到 PDF/圖片的檔案 |
| `requireKeywords` | 只收標題含這些字的文宣（給不是專門做移工宣導的網站用，例如只收「越南、印尼、泰、多國語」） |
| `lang` | 整個來源都是同一語言時填 `vi` / `id` / `th` / `en` |
| `defaultCategory` | 整個來源都是同一類時填，例如交通部填「交通安全」 |
| `ogImage` | 文宣是內頁的大圖（不是 PDF）時設 `true` |
| `contentImages` | 內頁內文裡的圖片也要抓時設 `true` |
| `insecureTLS` | 少數政府網站憑證設定有問題、出現 certificate 錯誤時設 `true` |
| `enabled` | `false` 暫停這個來源 |

**怎麼找 detailPattern？** 在列表頁對文宣標題按右鍵「複製連結」，看幾則的共同樣式。
例如：`https://xxx.gov.tw/cp-1234-56789-abc12-1.html` → 填 `/cp-1234-\\d+-[0-9a-f]+-1\\.html`
（JSON 裡的反斜線要寫兩個）。

---

## 調整分類

編輯 `categories.json`，在 `keywords` 加中文或外語關鍵字。
改完後到 Actions 手動跑一次即可；舊資料若想照新規則重新分類、搬資料夾，
可在自己電腦執行 `npm install` 後 `npm run reclassify`，再把變更推回 GitHub。

---

## 常見問題

- **某個機關一直抓不到**：網頁底下「各來源最近一次抓取狀態」會顯示原因。
  有些政府網站會擋國外 IP（GitHub 的主機在國外），這種情況可以在自己公司電腦上跑：
  安裝 Node.js 20 → `npm install` → `npm run crawl`，再用 GitHub Desktop 把變更推上去。
- **縮圖怎麼來的**：程式會暫時下載檔案做縮圖（PDF 取第一頁），做完就丟掉。超過 20MB 的檔案（`maxFileMB`）不做縮圖，只留連結。
- **容量**：每份文宣只佔一張小縮圖，一千份約 20–30MB。
- **政府網站下架檔案**：連結會失效，但縮圖、標題、原網頁網址還在，可以據此去找新版本。
- **網頁內容是用 JavaScript 載入的網站**：這類網站列表頁抓不到連結，需要另外找它的資料 API，
  把 API 網址或「內頁」網址直接放進 `startUrls`。
