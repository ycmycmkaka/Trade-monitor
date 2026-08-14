let serverTrades = [];
let draftTrades = [];
let monitorMap = new Map();

const $ = (id) => document.getElementById(id);

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
function keyOf(t) { return `${String(t.symbol).toUpperCase()}|${t.entry_date}|${Number(t.entry_price).toFixed(4)}`; }

function saveDraft() {
  localStorage.setItem("tradeMonitorDraft", JSON.stringify(draftTrades));
  $("draftStatus").textContent = "你有未同步到 GitHub 嘅草稿變更；下載 trades.json 後覆蓋 repo。";
}
function loadDraftOrServer() {
  const raw = localStorage.getItem("tradeMonitorDraft");
  if (raw) {
    try { draftTrades = JSON.parse(raw); $("draftStatus").textContent = "已載入瀏覽器草稿；下載 trades.json 後覆蓋 repo。"; return; } catch {}
  }
  draftTrades = structuredClone(serverTrades);
}
function resetDraft() {
  localStorage.removeItem("tradeMonitorDraft");
  draftTrades = structuredClone(serverTrades);
  $("draftStatus").textContent = "已還原 GitHub 上嘅 trades.json。";
  render();
}
function downloadTrades() {
  const blob = new Blob([JSON.stringify(draftTrades, null, 2) + "\n"], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "trades.json"; a.click();
  URL.revokeObjectURL(url);
}
function statusClass(s) {
  const x = String(s || "PENDING").toLowerCase();
  return ["hold","watch","reduce","exit"].includes(x) ? x : "pending";
}
function render() {
  const body = $("monitorBody");
  body.innerHTML = "";
  $("tradeCount").textContent = `${draftTrades.length} 筆`;
  $("emptyState").classList.toggle("hidden", draftTrades.length > 0);

  for (const t of draftTrades) {
    const k = keyOf(t);
    const m = monitorMap.get(k);
    const tr = document.createElement("tr");
    const pl = m?.pl_pct;
    const profitLow = Number(t.entry_price) * 1.20;
    const profitHigh = Number(t.entry_price) * 1.25;

    tr.innerHTML = `
      <td class="symbol">${esc(String(t.symbol).toUpperCase())}<br><small>${esc(t.setup || "")}</small></td>
      <td>${money(t.entry_price)}<br><small>${esc(t.entry_date)}</small></td>
      <td>${money(m?.current_close)}</td>
      <td class="${Number(pl)>=0 ? "positive":"negative"}">${pct(pl)}</td>
      <td>${money(m?.highest_close_since_entry)}</td>
      <td>${money(m?.initial_stop)}<br><small>${m?.initial_risk_pct != null ? pct(-Math.abs(m.initial_risk_pct)) : ""}</small></td>
      <td>${money(m?.trailing_stop)}</td>
      <td>${money(profitLow)} – ${money(profitHigh)}</td>
      <td>${money(m?.ma10)}</td>
      <td>${money(m?.ma20)}</td>
      <td>${money(m?.ma50)}</td>
      <td><span class="status ${statusClass(m?.status)}">${esc(m?.status || "PENDING")}</span></td>
      <td class="reason-cell">${m ? (m.reasons || []).map(esc).join("<br>") : "等待下一次 GitHub Action 更新。"}</td>
      <td><button class="danger" data-key="${esc(k)}">刪除</button></td>
    `;
    body.appendChild(tr);
  }

  body.querySelectorAll("button[data-key]").forEach(btn => {
    btn.addEventListener("click", () => {
      draftTrades = draftTrades.filter(t => keyOf(t) !== btn.dataset.key);
      saveDraft(); render();
    });
  });
}

async function init() {
  const [tradesRes, monitorRes] = await Promise.all([
    fetch(`trades.json?t=${Date.now()}`, {cache:"no-store"}),
    fetch(`trade_monitor.json?t=${Date.now()}`, {cache:"no-store"})
  ]);
  serverTrades = tradesRes.ok ? await tradesRes.json() : [];
  const monitor = monitorRes.ok ? await monitorRes.json() : {generated_at:"等待第一次更新", results:[]};
  for (const x of (monitor.results || [])) monitorMap.set(x.trade_key, x);

  loadDraftOrServer();
  $("summaryCard").innerHTML = `
    <div>正在監察</div>
    <div class="summary-count">${serverTrades.length} 筆</div>
    <div class="summary-updated">市場數據：${esc(monitor.generated_at || "等待第一次更新")}</div>
  `;
  render();
}

$("tradeForm").addEventListener("submit", e => {
  e.preventDefault();
  const symbol = $("symbolInput").value.trim().toUpperCase();
  const entry_date = $("entryDateInput").value;
  const entry_price = Number($("entryPriceInput").value);
  const setup = $("setupInput").value;
  const p = Number($("pivotInput").value);
  if (!symbol || !entry_date || !Number.isFinite(entry_price) || entry_price <= 0) return;

  const obj = {symbol, entry_date, entry_price, setup};
  if (Number.isFinite(p) && p > 0) obj.entry_pivot = p;

  const k = keyOf(obj);
  draftTrades = draftTrades.filter(t => keyOf(t) !== k);
  draftTrades.push(obj);
  draftTrades.sort((a,b) => a.symbol.localeCompare(b.symbol));
  saveDraft(); render();
  e.target.reset();
});

$("downloadTradesBtn").addEventListener("click", downloadTrades);
$("resetDraftBtn").addEventListener("click", resetDraft);

init().catch(err => {
  console.error(err);
  $("summaryCard").textContent = "資料載入失敗";
});
