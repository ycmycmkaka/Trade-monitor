from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
from yahooquery import Ticker

ROOT = Path(__file__).resolve().parent
TRADES_FILE = ROOT / "trades.json"
OUTPUT_FILE = ROOT / "trade_monitor.json"


def safe_float(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except Exception:
        return None


def trade_key(t):
    return f"{str(t['symbol']).upper()}|{t['entry_date']}|{float(t['entry_price']):.4f}"


def normalize_history(raw, symbol):
    if raw is None or len(raw) == 0:
        return None
    df = raw.copy()
    if isinstance(df.index, pd.MultiIndex):
        try:
            df = df.xs(symbol, level=0)
        except Exception:
            try:
                df = df.xs(symbol.upper(), level=0)
            except Exception:
                return None
    df = df.reset_index()
    date_col = "date" if "date" in df.columns else None
    if not date_col:
        return None
    df[date_col] = pd.to_datetime(df[date_col], errors="coerce")
    for c in ["open", "high", "low", "close", "volume"]:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.dropna(subset=["date", "high", "low", "close"]).sort_values("date")
    return df


def confirmed_swings(df, window=3):
    highs, lows = [], []
    h = df["high"].to_numpy()
    l = df["low"].to_numpy()
    for i in range(window, len(df) - window):
        if h[i] == max(h[i-window:i+window+1]):
            highs.append((i, float(h[i])))
        if l[i] == min(l[i-window:i+window+1]):
            lows.append((i, float(l[i])))
    return highs, lows


def strict_pivot(local_highs, current_close, n_bars, lookback=60, cluster_pct=0.02,
                 min_touches=2, min_sep=5, min_span=10):
    candidates = sorted(
        [(i, p) for i, p in local_highs if i >= n_bars - lookback and current_close * 0.85 <= p <= current_close * 1.12],
        key=lambda x: x[0]
    )
    valid = []
    for s in range(len(candidates)):
        for e in range(s + 1, len(candidates)):
            raw = candidates[s:e+1]
            ps = [p for _, p in raw]
            if min(ps) <= 0 or max(ps) / min(ps) - 1 > cluster_pct:
                continue
            touches = []
            for idx, price in raw:
                if not touches or idx - touches[-1][0] >= min_sep:
                    touches.append((idx, price))
                elif price > touches[-1][1]:
                    touches[-1] = (idx, price)
            if len(touches) < min_touches:
                continue
            span = touches[-1][0] - touches[0][0]
            if span < min_span:
                continue
            tps = [p for _, p in touches]
            valid.append((len(touches), span, touches[-1][0], -(max(tps)/min(tps)-1), max(tps)))
    if not valid:
        return None
    return max(valid)[-1]


def latest_swing_low_before(lows, idx, max_lookback=30):
    vals = [(i, p) for i, p in lows if i <= idx and i >= idx - max_lookback]
    return vals[-1][1] if vals else None


def latest_swing_low(lows, n_bars, max_lookback=25):
    vals = [(i, p) for i, p in lows if i >= n_bars - max_lookback]
    return vals[-1][1] if vals else None


def analyze_trade(trade, df):
    symbol = str(trade["symbol"]).upper()
    entry_date = pd.Timestamp(trade["entry_date"]).normalize()
    entry_price = float(trade["entry_price"])
    setup = str(trade.get("setup", "other")).lower()

    df = df.copy()
    df["ma10"] = df["close"].rolling(10).mean()
    df["ma20"] = df["close"].rolling(20).mean()
    df["ma50"] = df["close"].rolling(50).mean()
    df["avg_vol50"] = df["volume"].rolling(50).mean()

    # Use the first market session on/after entry date.
    eligible = df.index[df["date"].dt.normalize() >= entry_date]
    if len(eligible) == 0:
        raise ValueError("Entry date is after available market data")
    entry_idx = int(eligible[0])

    local_highs, local_lows = confirmed_swings(df)
    entry_row = df.iloc[entry_idx]
    current = df.iloc[-1]
    since_entry = df.iloc[entry_idx:]

    highest_close = float(since_entry["close"].max())
    current_close = float(current["close"])
    pl_pct = (current_close / entry_price - 1) * 100
    max_gain_pct = (highest_close / entry_price - 1) * 100

    manual_pivot = safe_float(trade.get("entry_pivot"))
    historical_highs = [(i, p) for i, p in local_highs if i <= entry_idx]
    computed_pivot = strict_pivot(historical_highs, entry_price, entry_idx + 1)
    entry_pivot = manual_pivot or computed_pivot

    entry_swing_low = latest_swing_low_before(local_lows, entry_idx, 35)

    # Initial stop:
    # O'Neil-style hard risk cap: no wider than ~7% below actual purchase price.
    hard_stop = entry_price * 0.93
    structural_candidates = []

    if setup == "breakout":
        if entry_pivot and entry_pivot < entry_price * 1.03:
            structural_candidates.append(entry_pivot * 0.98)
        if entry_swing_low:
            structural_candidates.append(entry_swing_low * 0.99)
    elif setup in ("pullback", "vcp"):
        if entry_swing_low:
            structural_candidates.append(entry_swing_low * 0.99)
        ma20_entry = safe_float(entry_row.get("ma20"))
        if ma20_entry and ma20_entry < entry_price:
            structural_candidates.append(ma20_entry * 0.98)
    else:
        if entry_swing_low:
            structural_candidates.append(entry_swing_low * 0.99)

    structural_candidates = [x for x in structural_candidates if x and x < entry_price]
    structural_stop = max(structural_candidates) if structural_candidates else hard_stop
    initial_stop = max(hard_stop, structural_stop)
    if initial_stop >= entry_price:
        initial_stop = hard_stop

    initial_risk_pct = (entry_price - initial_stop) / entry_price * 100

    ma10 = safe_float(current.get("ma10"))
    ma20 = safe_float(current.get("ma20"))
    ma50 = safe_float(current.get("ma50"))
    avg_vol50 = safe_float(current.get("avg_vol50"))
    volume = safe_float(current.get("volume"))
    vol_ratio = volume / avg_vol50 if volume and avg_vol50 and avg_vol50 > 0 else None

    current_swing_low = latest_swing_low(local_lows, len(df), 25)

    # Trailing reference: never move lower than initial stop.
    trailing_stop = initial_stop
    if max_gain_pct >= 5:
        trailing_stop = max(trailing_stop, entry_price * 0.99)
    if max_gain_pct >= 10:
        if ma20:
            trailing_stop = max(trailing_stop, ma20 * 0.98)
        if current_swing_low and current_swing_low < current_close:
            trailing_stop = max(trailing_stop, current_swing_low * 0.99)
    if max_gain_pct >= 20:
        if ma20:
            trailing_stop = max(trailing_stop, ma20 * 0.99)
        if ma10:
            trailing_stop = max(trailing_stop, ma10 * 0.97)
    trailing_stop = min(trailing_stop, current_close * 0.999) if current_close > initial_stop else trailing_stop

    # Detect whether +20% was reached within roughly 3 trading weeks.
    first_20_idx = None
    target20 = entry_price * 1.20
    for j in range(entry_idx, len(df)):
        if float(df.iloc[j]["high"]) >= target20:
            first_20_idx = j
            break
    fast_20 = first_20_idx is not None and (first_20_idx - entry_idx) <= 15
    trading_days_held = len(df) - 1 - entry_idx

    # Down-volume warning
    prev_close = float(df.iloc[-2]["close"]) if len(df) >= 2 else current_close
    down_day = current_close < prev_close
    heavy_down = down_day and vol_ratio is not None and vol_ratio >= 1.2

    reasons = []
    status = "HOLD"

    # Hard exits first
    if current_close <= initial_stop:
        status = "EXIT"
        reasons.append(f"收市 {current_close:.2f} 已低於 Initial Stop {initial_stop:.2f}")
    elif current_close <= trailing_stop and max_gain_pct >= 5:
        status = "EXIT"
        reasons.append(f"收市跌穿策略 Trailing Stop {trailing_stop:.2f}")
    elif ma50 and current_close < ma50 and heavy_down:
        status = "EXIT"
        reasons.append("放量跌穿 50MA，屬較強趨勢破壞訊號")
    elif current_swing_low and ma20 and current_close < current_swing_low and current_close < ma20:
        status = "EXIT"
        reasons.append("同時跌穿近期 swing low 及 20MA")

    if status != "EXIT":
        # IBD 20–25% profit zone, with an 8-week-rule style exception.
        if pl_pct >= 20 and pl_pct <= 30 and not (fast_20 and trading_days_held < 40):
            status = "REDUCE"
            reasons.append("已進入約 20–25%+ 一般獲利區，可考慮分段鎖利")
        elif ma20 and current_close < ma20 and heavy_down:
            status = "REDUCE"
            reasons.append("放量跌穿 20MA，趨勢明顯轉弱")
        elif ma10 and current_close < ma10:
            status = "WATCH"
            reasons.append("收市跌穿 10MA，先提高警覺")
        elif heavy_down:
            status = "WATCH"
            reasons.append("出現高於平均水平嘅放量下跌日")
        else:
            reasons.append("主要升勢結構暫未觸發離場條件")

        if fast_20 and trading_days_held < 40:
            reasons.append("曾於約 3 週內升達 20%：符合 8-week hold rule 候選特徵")

    if ma20 and current_close >= ma20:
        reasons.append("仍企於 20MA 之上")
    if ma50 and current_close >= ma50:
        reasons.append("仍企於 50MA 之上")

    return {
        "trade_key": trade_key(trade),
        "symbol": symbol,
        "entry_date": str(trade["entry_date"]),
        "entry_price": round(entry_price, 4),
        "setup": setup,
        "entry_pivot": round(entry_pivot, 4) if entry_pivot else None,
        "current_close": round(current_close, 4),
        "pl_pct": round(pl_pct, 2),
        "max_gain_pct": round(max_gain_pct, 2),
        "highest_close_since_entry": round(highest_close, 4),
        "initial_stop": round(initial_stop, 4),
        "initial_risk_pct": round(initial_risk_pct, 2),
        "trailing_stop": round(trailing_stop, 4),
        "profit_zone_20": round(entry_price * 1.20, 4),
        "profit_zone_25": round(entry_price * 1.25, 4),
        "ma10": round(ma10, 4) if ma10 else None,
        "ma20": round(ma20, 4) if ma20 else None,
        "ma50": round(ma50, 4) if ma50 else None,
        "volume_ratio_50d": round(vol_ratio, 2) if vol_ratio else None,
        "recent_swing_low": round(current_swing_low, 4) if current_swing_low else None,
        "fast_20pct_gain": fast_20,
        "trading_days_held": trading_days_held,
        "status": status,
        "reasons": reasons,
    }


def main():
    trades = json.loads(TRADES_FILE.read_text(encoding="utf-8"))
    if not trades:
        OUTPUT_FILE.write_text(
            json.dumps({
                "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
                "results": []
            }, ensure_ascii=False, indent=2),
            encoding="utf-8"
        )
        print("No trades to monitor.")
        return

    symbols = sorted({str(t["symbol"]).upper().strip() for t in trades})
    results = []

    # A little over one year gives enough MA history and entry-date context.
    for symbol in symbols:
        print(f"Downloading {symbol}...")
        try:
            raw = Ticker(symbol, asynchronous=False).history(period="18mo", interval="1d")
            df = normalize_history(raw, symbol)
            if df is None or len(df) < 80:
                raise ValueError("Insufficient history")

            for trade in [t for t in trades if str(t["symbol"]).upper().strip() == symbol]:
                try:
                    results.append(analyze_trade(trade, df))
                except Exception as exc:
                    results.append({
                        "trade_key": trade_key(trade),
                        "symbol": symbol,
                        "entry_date": trade.get("entry_date"),
                        "entry_price": trade.get("entry_price"),
                        "setup": trade.get("setup"),
                        "status": "ERROR",
                        "reasons": [str(exc)]
                    })
        except Exception as exc:
            for trade in [t for t in trades if str(t["symbol"]).upper().strip() == symbol]:
                results.append({
                    "trade_key": trade_key(trade),
                    "symbol": symbol,
                    "entry_date": trade.get("entry_date"),
                    "entry_price": trade.get("entry_price"),
                    "setup": trade.get("setup"),
                    "status": "ERROR",
                    "reasons": [f"Market data error: {exc}"]
                })

    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "results": results
    }
    OUTPUT_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {len(results)} monitored trades.")


if __name__ == "__main__":
    main()
