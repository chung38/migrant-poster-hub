# 系統架構：資料這一半

「移次搞定」網站分成兩個 repo：

- **chung38/translate**：網站畫面加翻譯 API，放在 Cloudflare Pages。正式網址：https://yicipass.com
- **chung38/migrant-poster-hub**（這個）：爬蟲與資料。GitHub Actions 依排程抓資料，存成 JSON 放在 `docs/`，再由 GitHub Pages 公開。

網站每次開啟都會直接讀 `https://chung38.github.io/migrant-poster-hub/` 底下的 JSON 和縮圖，所以資料更新後不需要重新部署網站。
整體架構、金鑰放在哪、網站程式要改哪個檔，請看 translate repo 的 [ARCHITECTURE.md](https://github.com/chung38/translate/blob/main/ARCHITECTURE.md)。

> `docs/index.html` 和 `docs/view.html` 現在只負責把舊網址轉到新站，網站畫面請改 translate repo 的 `index.html`。

## 資料檔一覽

| 檔案 | 誰產生 | 什麼時候（台灣時間） | 網站哪裡用 |
|---|---|---|---|
| `docs/catalog.json`、`docs/thumbs/` | `crawler/crawl.js` | 每天 06:23（`crawl.yml`） | 文宣、搜尋 |
| `docs/report.json` | `crawler/crawl.js` | 同上 | 文宣頁底下「各來源抓取狀態」 |
| `data/state.json` | `crawler/crawl.js` | 同上 | 不給網站用；記錄看過的網頁，避免重抓 |
| `docs/news.json`、`data/news-raw.json` | `crawler/news.js` | 每 4 小時（`news.yml`），文宣排程也會順便跑 | 新聞 |
| `docs/watch.json` | `crawler/watch.js` | 同上 | 最低工資、就安費新公告提醒 |
| `docs/sea-news.json`、`data/sea-raw.json` | `crawler/sea-news.js` | 每天 08:13、18:13（`sea-news.yml`） | 新聞頁的東南亞頭條 |
| `docs/laws.json` | `crawler/laws.js` | 每天 03:37（`laws.yml`） | 聘僱指南的法規清單、法條原文 |
| `docs/policy.json` | `crawler/policy.js` | 同上 | 聘僱指南的勞動部新公告 |
| `docs/guides.json` | **人工維護** | 法規有變時（會自動開 Issue 提醒） | 聘僱指南、申請應備文件 |
| `docs/info.json` | **人工維護** | 費率、電話有變時 | 工具：緊急電話、辦事處、節日、薪資計算費率 |
| `sources.json` | **人工維護** | 新增或停用來源時 | 爬蟲要抓哪些政府網站 |
| `categories.json` | **人工維護** | 調整分類時 | 文宣分類與多國語關鍵字 |

## 每次排程的流程

```
GitHub Actions 依時間啟動
  → 爬蟲抓資料、寫入 JSON
  → crawler/check-data.js 檢查格式
       合格  → 存回 GitHub → GitHub Pages 約 1 分鐘後更新 → 網站下次開啟就看得到
       不合格 → 那一組檔案還原成上一版（網站繼續顯示舊資料，不會開天窗）
                → 這次 Action 標成失敗，GitHub 寄信通知
```

`check-data.js` 會擋兩種狀況：

- **格式壞掉**：網站要用的欄位不見了、JSON 寫壞。
- **資料突然變少**：例如文宣目錄比上一版少了兩成以上、新聞從有變成 0 則。這多半是來源網站改版或暫時連不上。

收到失敗通知時，打開那次 Action，在「檢查」步驟裡會寫哪個檔、哪一筆、缺什麼欄位。若是來源網站改版，要修改對應的 `crawler/*.js`。

## 手動修改資料檔

在 GitHub 網頁上修改 `docs/guides.json`、`docs/info.json`、`sources.json` 或 `categories.json` 並存檔後，`check.yml` 會自動檢查格式。如果變紅色，通常是少了逗號、引號或括號，照訊息修正即可。

也可以在自己電腦執行 `node crawler/check-data.js`，一次檢查全部資料檔。

## 權限與設定

- **Actions 要能寫回 repo**：Settings → Actions → General → Workflow permissions 選 **Read and write permissions**。用的是 GitHub 內建的權杖，不需要另外建 token。
- **GitHub Pages**：Settings → Pages → Deploy from a branch → `main` / `docs`。
- **法規異動通知**：會自動開 Issue。請在 repo 右上角 Watch 保持預設或設為 All Activity，才會收到 Email。
- 這個 repo 沒有存放任何金鑰。
