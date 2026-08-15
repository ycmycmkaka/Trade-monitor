const cfg = window.TRADE_MONITOR_CONFIG;
const { createClient } = window.supabase;
const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
});

const $ = (id) => document.getElementById(id);
let currentUser = null;
let trades = [];

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "—";
}
function pct(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(1)}%` : "—";
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}
function fmtTime(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return esc(v);
  return d.toLocaleString("zh-HK", { hour12:false });
}
function statusClass(s) {
  const x = String(s || "PENDING").toLowerCase();
  if (["hold","watch","reduce","exit"].includes(x)) return x;
  if (x === "error") return "error-status";
  return "pending";
}
function setMessage(id, text="", type="") {
  const el = $(id);
  el.textContent = text;
  el.className = `form-message ${type}`.trim();
}

function renderSummary() {
  const counts = {HOLD:0, WATCH:0, REDUCE:0, EXIT:0, PENDING:0, ERROR:0};
  for (const t of trades) counts[t.status || "PENDING"] = (counts[t.status || "PENDING"] || 0) + 1;
  const latest = trades.map(t => t.last_analyzed_at).filter(Boolean).sort().at(-1);
  $("summaryCard").innerHTML = `
    <div>正在監察</div>
    <div class="summary-count">${trades.length} 筆</div>
    <div class="summary-updated">
      HOLD ${counts.HOLD||0} · WATCH ${counts.WATCH||0} · REDUCE ${counts.REDUCE||0} · EXIT ${counts.EXIT||0}<br>
      最後分析：${latest ? fmtTime(latest) : "未分析"}
    </div>
  `;
}

function render() {
  const body = $("monitorBody");
  body.innerHTML = "";
  $("tradeCount").textContent = `${trades.length} 筆`;
  $("emptyState").classList.toggle("hidden", trades.length > 0);

  for (const t of trades) {
    const tr = document.createElement("tr");
    const pl = t.pl_pct;
    const reasons = Array.isArray(t.reasons) ? t.reasons : [];
    const profitLow = t.profit_zone_20 ?? Number(t.entry_price) * 1.20;
    const profitHigh = t.profit_zone_25 ?? Number(t.entry_price) * 1.25;
    tr.innerHTML = `
      <td class="symbol">${esc(String(t.ticker).toUpperCase())}<br><small>${esc(t.setup || "other")}</small></td>
      <td>${money(t.entry_price)}<br><small>${esc(t.entry_date)}</small></td>
      <td>${money(t.current_close)}</td>
      <td class="${Number(pl)>=0 ? "positive":"negative"}">${pct(pl)}</td>
      <td>${money(t.highest_close_since_entry)}</td>
      <td>${money(t.initial_stop)}<br><small>${t.initial_risk_pct != null ? pct(-Math.abs(t.initial_risk_pct)) : ""}</small></td>
      <td>${money(t.trailing_stop)}</td>
      <td>${money(profitLow)} – ${money(profitHigh)}</td>
      <td>${money(t.ma10)}</td>
      <td>${money(t.ma20)}</td>
      <td>${money(t.ma50)}</td>
      <td><span class="status ${statusClass(t.status)}">${esc(t.status || "PENDING")}</span></td>
      <td class="reason-cell">${t.analysis_error ? `<span class="negative">${esc(t.analysis_error)}</span>` : (reasons.length ? reasons.map(esc).join("<br>") : "等待分析")}</td>
      <td>${fmtTime(t.last_analyzed_at)}</td>
      <td>
        <button class="secondary mini analyze-btn" data-id="${t.id}">更新</button>
        <button class="danger mini delete-btn" data-id="${t.id}">刪除</button>
      </td>
    `;
    body.appendChild(tr);
  }

  body.querySelectorAll(".analyze-btn").forEach(btn => {
    btn.addEventListener("click", () => analyzeTrade(Number(btn.dataset.id), btn));
  });
  body.querySelectorAll(".delete-btn").forEach(btn => {
    btn.addEventListener("click", () => deleteTrade(Number(btn.dataset.id), btn));
  });

  renderSummary();
}

async function loadTrades() {
  const { data, error } = await sb
    .from("trades")
    .select("*")
    .order("created_at", { ascending:false });

  if (error) throw error;
  trades = data || [];
  render();
}

async function analyzeTrade(id, btn=null) {
  const original = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "分析中…"; }

  try {
    const { data, error } = await sb.functions.invoke(cfg.EDGE_FUNCTION_NAME, {
      body: { mode:"one", trade_id:id }
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    await loadTrades();
  } catch (err) {
    console.error(err);
    setMessage("tradeMessage", `分析失敗：${err.message || err}`, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original || "更新"; }
  }
}

async function deleteTrade(id, btn) {
  if (!confirm("確定停止監察呢隻股票？")) return;
  btn.disabled = true;
  try {
    const { error } = await sb.from("trades").delete().eq("id", id);
    if (error) throw error;
    trades = trades.filter(t => t.id !== id);
    render();
  } catch (err) {
    alert(`刪除失敗：${err.message || err}`);
    btn.disabled = false;
  }
}

async function showSession(session) {
  currentUser = session?.user || null;
  $("loginCard").classList.toggle("hidden", !!currentUser);
  $("appArea").classList.toggle("hidden", !currentUser);

  if (currentUser) {
    setMessage("loginMessage", "");
    await loadTrades();
  } else {
    trades = [];
    $("summaryCard").innerHTML = `<div>狀態</div><div class="summary-count">—</div><div class="summary-updated">等待登入</div>`;
  }
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("loginBtn");
  btn.disabled = true;
  btn.textContent = "登入中…";
  setMessage("loginMessage", "");

  try {
    const email = $("emailInput").value.trim();
    const password = $("passwordInput").value;
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await showSession(data.session);
    $("passwordInput").value = "";
  } catch (err) {
    setMessage("loginMessage", `登入失敗：${err.message || err}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "登入";
  }
});

$("logoutBtn").addEventListener("click", async () => {
  await sb.auth.signOut();
  await showSession(null);
});

$("tradeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("addTradeBtn");
  btn.disabled = true;
  btn.textContent = "儲存中…";
  setMessage("tradeMessage", "");

  try {
    const ticker = $("symbolInput").value.trim().toUpperCase();
    const entry_date = $("entryDateInput").value;
    const entry_price = Number($("entryPriceInput").value);
    const setup = $("setupInput").value;
    const p = Number($("pivotInput").value);

    if (!ticker || !entry_date || !Number.isFinite(entry_price) || entry_price <= 0) {
      throw new Error("請填齊股票代號、日期同有效買入價");
    }

    const row = { ticker, entry_date, entry_price, setup };
    if (Number.isFinite(p) && p > 0) row.entry_pivot = p;

    const { data, error } = await sb
      .from("trades")
      .insert(row)
      .select("*")
      .single();

    if (error) throw error;

    btn.textContent = "立即分析中…";
    setMessage("tradeMessage", `${ticker} 已儲存，正在取得最新市場數據…`, "ok");

    const { data: analysisData, error: analysisError } = await sb.functions.invoke(cfg.EDGE_FUNCTION_NAME, {
      body: { mode:"one", trade_id:data.id }
    });
    if (analysisError) throw analysisError;
    if (analysisData?.error) throw new Error(analysisData.error);

    e.target.reset();
    setMessage("tradeMessage", `${ticker} 已儲存並完成分析。`, "ok");
    await loadTrades();
  } catch (err) {
    console.error(err);
    setMessage("tradeMessage", `新增／分析失敗：${err.message || err}`, "error");
    await loadTrades().catch(()=>{});
  } finally {
    btn.disabled = false;
    btn.textContent = "加入並立即分析";
  }
});

$("refreshAllBtn").addEventListener("click", async () => {
  const btn = $("refreshAllBtn");
  btn.disabled = true;
  btn.textContent = "讀取中…";
  try { await loadTrades(); }
  finally { btn.disabled = false; btn.textContent = "重新讀取"; }
});

sb.auth.onAuthStateChange((_event, session) => {
  if ((session?.user?.id || null) !== (currentUser?.id || null)) {
    showSession(session).catch(console.error);
  }
});

(async function init() {
  const { data } = await sb.auth.getSession();
  await showSession(data.session);
})();
