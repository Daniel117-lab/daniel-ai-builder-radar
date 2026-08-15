# Daniel AI Builder 情報雷達

一個細而透明嘅公開情報頁：每六小時從 Hacker News 搜尋最近七日嘅 AI builder 訊號，排序後顯示最多 20 條。呢個 repo 係 Dot.ai L3 Day 1 功課第二部分，同私人 Daniel OS 分開；公開內容只有新聞 metadata。

## 公開頁與資料

- Pages：<https://daniel117-lab.github.io/daniel-ai-builder-radar/>
- 固定資料介面：[`data/news.json`](data/news.json)
- 搜尋詞：`AI`、`LLM`、`AI agent`、`AI automation`、`OpenAI`、`Anthropic`
- 顯示欄位：標題、原文／HN 討論連結、網域、相對時間、points
- 不保存：正文、摘要、節錄、留言、AI 生成描述、API 原始候選

## 資料流程

1. [`scripts/fetch-news.mjs`](scripts/fetch-news.mjs) 以 Algolia HN Search API 嘅 `search` endpoint 執行六次查詢。
2. API 端用 Unix timestamp 限制最近七日，每組最多取 100 個候選。
3. 合併後按 Hacker News `objectID` 及正規化 URL 去重，再按 points、發佈時間排序，保留 20 條。
4. 六個查詢全部成功先以 temp file → rename 更新 JSON；任何一個失敗都 exit 1、保留舊檔。
5. 同一個 GitHub Actions run 有資料改變先 commit `data/news.json`，之後部署嗰次成功資料到 Pages。

JSON 介面固定為：

```json
{
  "fetchedAt": "ISO timestamp",
  "windowStart": "ISO timestamp",
  "queries": ["AI", "LLM", "AI agent"],
  "stories": [
    {
      "objectID": "string",
      "title": "string",
      "url": "https://...",
      "domain": "example.com",
      "points": 123,
      "publishedAt": "ISO timestamp"
    }
  ]
}
```

## 來源、用量與版權界線

- 搜尋來源係 [Algolia Hacker News Search API](https://hn.algolia.com/api)。官方頁面提供公開程式介面，列明每 IP 每小時 10,000 次上限。
- 排程每六小時一次，每次六個 query，即約 **6 requests/run、24 requests/day**，遠低於上限，亦不需要 API key 或 secret。
- 2026-08-15 檢查 Hacker News `robots.txt`：它限制投票、登入、回覆等互動路徑。本專案不 crawl Hacker News 頁面，只經公開 Algolia API 搜尋並連結到原文／討論頁。
- API 搜尋結果只轉存必要 metadata；標題及連結用作索引。全文、摘要、節錄及內容權利保留予原作者、Hacker News 及原網站。
- 如來源條款或 API 規則日後改變，應暫停 workflow 再重新檢查。

## 本機使用

需要 Node.js 24 或近期內建 `fetch` 嘅 Node 版本；沒有第三方 package。

```bash
node --test scripts/fetch-news.test.mjs
node scripts/check-project.mjs
node scripts/fetch-news.mjs
python3 -m http.server 4173
```

然後開啟 `http://127.0.0.1:4173/news.html`。唔好直接用 `file://`，因為瀏覽器會阻擋頁面讀取 JSON。

## 失敗處理

- 任一 API query 失敗：紅字回報、exit 1、舊 `data/news.json` 不變、清走 temp file。
- JSON 缺失或損壞：公開頁顯示紅色錯誤狀態，唔會白畫面。
- `fetchedAt` 超過八小時：顯示黃色過期提示，但保留最後一次成功結果。
- GitHub Actions 失敗：Pages 維持上一個成功部署；先檢查 workflow log，唔應該手動寫入不完整資料。

## GitHub Pages 驗收

- Workflow 使用官方 Pages Actions：checkout v7、setup-node v6、configure-pages v6、upload-pages-artifact v5、deploy-pages v5。
- 支援 `workflow_dispatch` 手動執行，排程為 UTC `17 */6 * * *`。
- 手動 run 應同時見到 data update commit（如有改變）同成功 `deploy` job。
- 公開頁 `fetchedAt` 要等於該次成功資料；排程未實際經過六小時前，排程驗收標示「未確認」。

驗收紀錄見 [`Outputs/2026-08-15_Learning_Dotai-L3_AI-Builder-Radar_Review_v01.md`](Outputs/2026-08-15_Learning_Dotai-L3_AI-Builder-Radar_Review_v01.md)。
