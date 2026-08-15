# Trade Exit Monitor v2 — Supabase

呢版已經取消 `trades.json` / localStorage 手動同步流程。

## 架構

- GitHub Pages：前端 UI
- Supabase Auth：登入
- Supabase `trades` table：交易與分析結果
- Supabase Edge Function `analyze-trade`：新增後即時分析
- GitHub Actions：每日美股收市後呼叫 Edge Function，更新所有監察交易

## 已寫入前端的公開設定

- Project URL: `https://ykxsvgtwbfxmjwrmqhmh.supabase.co`
- Publishable key: 已放入 `config.js`

Publishable key 可以放喺 browser；真正權限由 Supabase Auth + RLS 控制。
**Secret key / service_role key 絕對唔好放入 GitHub Pages。**

## 一次性 Supabase 設定

### A. SQL migration

去 Supabase → SQL Editor，執行：

`supabase_setup.sql`

呢段會加入 `setup`、`entry_pivot`、MA、Stop、Status 等分析欄位。

### B. Deploy Edge Function

Supabase → Edge Functions → Deploy a new function

Function name:
`analyze-trade`

將：
`supabase/functions/analyze-trade/index.ts`
完整貼入去。

**重要：關閉 / Disable JWT verification（或用 no-verify-jwt deploy）。**
呢個 function 會自己：
- Browser request：驗證登入 user access token
- Cron request：驗證 `CRON_SECRET`

Supabase hosted Edge Functions 本身有 `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` environment variables。

### C. 設 CRON_SECRET

Supabase → Edge Functions → Secrets：
建立一個隨機長字串，例如 32+ characters：

`CRON_SECRET = 你自己生成嘅秘密字串`

唔好放喺 public repo。

### D. GitHub Actions Secret

GitHub repo → Settings → Secrets and variables → Actions → New repository secret

Name:
`TRADE_MONITOR_CRON_SECRET`

Value：
同 Supabase `CRON_SECRET` 完全相同。

之後 GitHub Action 星期一至五 22:30 UTC 自動更新全部 trades。

## 使用方式

1. 打開網站
2. 用 Supabase Authentication email/password 登入
3. Add Trade：
   - Ticker
   - Entry Date
   - Entry Price
   - Setup
   - Pivot（可選）
4. Save 後：
   - 直接 INSERT Supabase
   - 自動 invoke Edge Function
   - 幾秒後顯示 HOLD / WATCH / REDUCE / EXIT
5. 沽咗股票：網站直接 Delete
6. 唔需要 download/upload JSON

## 策略內容

- Initial risk cap 約 7%
- Breakout：Pivot / swing low 優先
- Pullback / VCP：swing low / 20MA 優先
- 盈利後逐步提高 trailing reference
- 一般 20–25% profit zone 提示 REDUCE
- 約 3 週內升 20%：標記 8-week-rule candidate
- 放量跌穿 20MA / 50MA、近期 swing low、stop：提高至 REDUCE / EXIT

市場數據由 Edge Function 透過 Yahoo Finance chart endpoint 取得；呢個 endpoint 並非正式付費 market-data API，因此將來如 Yahoo 改接口，可能需要更新。
