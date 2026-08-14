# Trade Exit Monitor

獨立於強勢股 Scanner 嘅交易離場監察工具。

## 功能

- 只需要輸入：股票代號、買入日期、買入價、Entry Setup，以及可選 Pivot。
- 每個美股交易日收市後由 GitHub Actions 更新。
- 顯示 Current Price、P/L、10/20/50MA、Initial Stop、Trailing Stop、20–25% Profit Zone。
- 狀態：HOLD / WATCH / REDUCE / EXIT。
- 支援 Breakout / Pullback / VCP 三種 entry setup。

## 重要：新增／刪除交易

GitHub Pages 係靜態網站，唔可以安全地直接寫返 GitHub repo（除非將 GitHub credential 暴露畀前端，唔建議）。

所以頁面內可以：
1. Add / Delete trade；
2. 按「下載更新後 trades.json」；
3. 將下載嘅 trades.json 覆蓋 repo root 內原本 trades.json；
4. 去 Actions > Update Trade Exit Monitor > Run workflow。

之後每日就會自動監察新清單。

## trades.json 格式

```json
[
  {
    "symbol": "CRWD",
    "entry_date": "2026-08-12",
    "entry_price": 221.90,
    "setup": "breakout",
    "entry_pivot": 218.50
  }
]
```

`entry_pivot` 可以省略。

## GitHub Pages

Settings > Pages > Deploy from a branch > main > /(root)

## 離場規則

呢個係 O'Neil / Minervini-inspired rule set，而唔係官方 proprietary 系統。

- 初始風險一般唔容許闊過約 7%。
- Breakout 優先參考 Pivot / swing low。
- Pullback / VCP 優先參考 swing low / 20MA。
- 盈利後逐步用 10MA / 20MA / swing low 提升 trailing reference。
- 約 20–25% profit zone 會提示 REDUCE；如約三星期內已升 20%，會標示 8-week-rule candidate。
- 放量跌穿 20MA / 50MA、跌穿 swing low 或 stop，會提高離場等級。

呢啲係策略參考訊號，唔代表保證價格或投資建議。
