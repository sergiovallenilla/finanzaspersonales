import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";
import Chart from "chart.js/auto";

/**
 * Avanza — ENFOQUE ORIGINAL (v7.1, hotfix)
 * ---------------------------------------
 * Fixes:
 * - Elimina JSX suelto tras <GoalStatus/> que rompía el build.
 * - Corrige estilos .btn (CSS válido, sin template literals dentro del CSS).
 * - Mantiene tests de runtime y toda la funcionalidad previa.
 */

// ---------------- Modelo / Constantes ----------------
const CATS = [
  { id: "obligatorios", name: "Gastos Obligatorios", icon: "🏠" },
  { id: "emergencias", name: "Fondo de Emergencias", icon: "🧰" },
  { id: "ahorro", name: "Ahorro", icon: "🐷" },
  { id: "inversion", name: "Inversión", icon: "📈" },
  { id: "educacion", name: "Educación", icon: "🎓" },
  { id: "diversion", name: "Diversión y Ocio", icon: "🎉" },
];

const defaultBudgets = {
  obligatorios: 0.6,
  emergencias: 0.1,
  ahorro: 0.1,
  inversion: 0.1,
  educacion: 0.05,
  diversion: 0.05,
};

const initialState = {
  balance: 0,
  txs: [], // {id, ts, desc, amount, kind: 'income'|'expense', fixed?, need?, category?}
  goal: null, // {name, cost, months?}
  monthlyIncome: 0,
  budgets: defaultBudgets,
  debts: [], // {id,name,principal,apr,termMonths?,minPayment?,startTs}
};

// ---------------- Reducer ----------------
function reducer(state, action) {
  switch (action.type) {
    case "ADD_TX": {
      const tx = action.tx;
      const delta = tx.kind === "income" ? Math.abs(tx.amount) : -Math.abs(tx.amount);
      return { ...state, balance: state.balance + delta, txs: [tx, ...state.txs] };
    }
    case "DELETE_TX": {
      const idx = state.txs.findIndex((t) => t.id === action.id);
      if (idx === -1) return state;
      const removed = state.txs[idx];
      const delta = removed.kind === "income" ? Math.abs(removed.amount) : -Math.abs(removed.amount);
      return { ...state, txs: state.txs.filter((t) => t.id !== action.id), balance: state.balance - delta };
    }
    case "SET_GOAL": return { ...state, goal: action.goal };
    case "SET_INCOME": return { ...state, monthlyIncome: action.income };
    case "SET_BUDGET": return { ...state, budgets: { ...state.budgets, [action.key]: action.value } };
    case "ADD_DEBT": return { ...state, debts: [action.debt, ...state.debts] };
    case "DELETE_DEBT": return { ...state, debts: state.debts.filter((d) => d.id !== action.id) };
    case "RESET_DEMO": return { ...initialState };
    case "SEED_SAMPLE": { return { ...state, ...action.payload }; }
    default: return state;
  }
}

// ---------------- Utilidades ----------------
const fmt = (n) => `$${(n || 0).toFixed(2)}`;
const pct = (n) => `${(n * 100).toFixed(2)}%`;

function makeTx({ rawDesc, amount, kind, fixed, need, category }) {
  return {
    id: String(Date.now() + Math.random()),
    ts: new Date().toISOString(),
    desc: rawDesc?.trim() || (kind === "income" ? "Ingreso" : "Gasto"),
    amount: Math.abs(Number(amount) || 0),
    kind,
    ...(kind === "expense" ? { fixed, need, category } : {}),
  };
}
const spentByCat = (txs) => {
  const m = Object.fromEntries(CATS.map((c) => [c.id, 0]));
  for (const t of txs) if (t.kind === "expense" && t.category && m[t.category] != null) m[t.category] += t.amount;
  return m; // valores positivos (gastos)
};

// Fondos/envelopes: cada ingreso se distribuye por porcentajes y cada gasto descuenta del fondo.
function deriveEnvelopes(budgets, txs) {
  const env = Object.fromEntries(CATS.map((c) => [c.id, 0]));
  const sorted = [...txs].sort((a,b)=> new Date(a.ts).getTime() - new Date(b.ts).getTime());
  for (const t of sorted) {
    if (t.kind === "income") {
      for (const c of CATS) env[c.id] += (t.amount || 0) * (budgets[c.id] || 0);
    } else if (t.kind === "expense" && t.category && env[t.category] !== undefined) {
      env[t.category] -= t.amount || 0; // puede quedar en rojo
    }
  }
  return env;
}

// Capacidad de pago / DTI
function computeCapacity(state, monthlyDebtPayment) {
  const byCat = spentByCat(state.txs);
  const essentials = byCat.obligatorios || 0; // aproximación simple: obligatorios como esenciales
  const capacity = Math.max(0, (state.monthlyIncome || 0) - essentials - (monthlyDebtPayment || 0));
  const dti = (state.monthlyIncome || 0) > 0 ? (monthlyDebtPayment || 0) / state.monthlyIncome : 0;
  let band = "Riesgo";
  if (dti < 0.2) band = "Excelente"; else if (dti < 0.36) band = "Sano"; else if (dti < 0.43) band = "Atención";
  return { capacity, dti, band };
}

// ---- Amortización (préstamos / deudas) ----
// Si se da termMonths, calculamos cuota (PMT). Si se da minPayment, usamos ese pago.
function monthlyRate(apr) { return (Number(apr) || 0) / 12; }
function calcPayment({ principal, apr, termMonths, minPayment }) {
  const P = Number(principal) || 0;
  const r = monthlyRate(apr);
  const n = Number(termMonths) || 0;
  if (minPayment && minPayment > 0) return minPayment;
  if (r <= 0 || n <= 0) return 0;
  return (r * P) / (1 - Math.pow(1 + r, -n));
}
function buildSchedule({ principal, apr, payment }) {
  let bal = Number(principal) || 0;
  const r = monthlyRate(apr);
  const sched = [];
  if (bal <= 0 || payment <= 0) return { schedule: [], months: 0, totalInterest: 0 };
  let i = 0, totalInterest = 0;
  const SAFETY = 3600; // 300 años como tope
  while (bal > 0.005 && i < SAFETY) {
    const interest = r * bal;
    let principalPay = payment - interest;
    if (principalPay <= 0) {
      // Pago insuficiente para cubrir intereses -> no converge
      // Forzamos pago mínimo
      principalPay = 1e-2;
    }
    if (principalPay > bal) principalPay = bal;
    bal = bal - principalPay;
    const pay = principalPay + interest;
    totalInterest += interest;
    sched.push({ month: i + 1, payment: pay, interest, principal: principalPay, balance: Math.max(0, bal) });
    i++;
  }
  return { schedule: sched, months: sched.length, totalInterest };
}

// ---------------- UI Genéricas ----------------
function Card({ title, tone, children, right }) {
  const ring = tone === "good" ? "border-emerald-200" : tone === "bad" ? "border-rose-200" : "border-slate-200";
  const bg = tone === "good" ? "bg-emerald-50" : tone === "bad" ? "bg-rose-50" : "bg-white";
  return (
    <div className={`p-4 rounded-2xl border ${ring} ${bg} shadow-sm hover:shadow-md transition-shadow`}>
      {(title || right) && (
        <div className="flex items-center justify-between mb-2">
          {title && <div className="font-semibold">{title}</div>}
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

function Toast({ message }) {
  return (
    <div className={`fixed top-5 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg shadow-lg text-white transition-opacity ${message ? "opacity-100" : "opacity-0"}`} style={{ background: "#111827" }}>
      {message}
    </div>
  );
}

// ---------------- Bloques funcionales ----------------
function Hero({ state, onReset, onSeed }) {
  const totalIncome = state.txs.filter((t) => t.kind === "income").reduce((s, t) => s + t.amount, 0);
  const totalExpense = state.txs.filter((t) => t.kind === "expense").reduce((s, t) => s + t.amount, 0);
  const spendingPct = state.monthlyIncome > 0 ? totalExpense / state.monthlyIncome : 0;
  const badge = spendingPct === 0 ? null : spendingPct < 0.6 ? "Maestro del 60%" : spendingPct < 0.8 ? "Guardián del Saldo" : "Ajuste recomendado";
  const emoji = spendingPct === 0 ? "👋" : spendingPct < 0.6 ? "🥳" : spendingPct < 0.8 ? "😊" : totalExpense > state.monthlyIncome ? "😱" : "🤔";
  const tip = spendingPct === 0
    ? "Añade tu ingreso y un par de gastos para comenzar"
    : spendingPct < 0.6
      ? "Estás dominando tus finanzas: gastos <60% del ingreso"
      : spendingPct < 0.8
        ? "Vas equilibrado; puedes impulsar el ahorro"
        : "Alerta: revisa prescindibles para volver a verde";

  return (
    <div className="rounded-3xl bg-gradient-to-r from-indigo-600 via-indigo-500 to-violet-500 text-white p-6 shadow-md">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-4xl">{emoji}</div>
          <h1 className="text-2xl font-bold mt-1">Avanza — tu compañero financiero</h1>
          <p className="opacity-90">Simple, intuitivo y poderoso. Tú decides; Avanza te acompaña.</p>
          {badge && <span className="mt-3 inline-block bg-white/10 border border-white/20 px-3 py-1 rounded-full text-sm">{badge}</span>}
        </div>
        <div className="flex items-center gap-2 text-sm">
          <button className="btn" onClick={onSeed}>Cargar ejemplo</button>
          <button className="px-3 py-2 rounded-xl border border-white/70 hover:bg-white/10" onClick={onReset}>Restaurar</button>
        </div>
      </div>
      <p className="mt-3 text-sm text-white/90">Sugerencia: {tip}.</p>
    </div>
  );
}

function Summary({ balance, incomeTotal, expenseTotal, debtTotals, envelopes, paycap }) {
  return (
    <section className="grid grid-cols-1 lg:grid-cols-5 gap-3">
      <Card title="Ingresos" right={<span className="text-xs text-slate-500">mensual acumulado</span>}>
        <div className="text-2xl font-bold text-emerald-600">{fmt(incomeTotal)}</div>
      </Card>
      <Card title="Gastos" right={<span className="text-xs text-slate-500">mensual acumulado</span>}>
        <div className="text-2xl font-bold text-rose-600">{fmt(expenseTotal)}</div>
      </Card>
      <Card title="Saldo" tone={balance >= 0 ? "good" : "bad"}>
        <div className={`text-3xl font-bold ${balance >= 0 ? "text-emerald-700" : "text-rose-600"}`}>{fmt(balance)}</div>
        <div className="text-xs text-slate-500 mt-1">Fondos (ahorro+inv+edu+emerg): <b>{fmt((envelopes?.ahorro||0)+(envelopes?.inversion||0)+(envelopes?.educacion||0)+(envelopes?.emergencias||0))}</b></div>
      </Card>
      <Card title="Deuda total" right={<span className="text-xs text-slate-500">pago/mes</span>}>
        <div className="text-2xl font-bold text-indigo-700">{fmt(debtTotals.balance)}</div>
        <div className="text-xs text-slate-500 mt-1">{fmt(debtTotals.payment)} / mes</div>
      </Card>
      <Card title="Capacidad de pago" right={<span className="text-xs text-slate-500">DTI</span>}>
        <div className="text-2xl font-bold text-emerald-700">{fmt(paycap.capacity)}</div>
        <div className={`text-xs mt-1 ${paycap.band === 'Riesgo' || paycap.band === 'Atención' ? 'text-amber-600' : 'text-slate-500'}`}>{(paycap.dti*100).toFixed(1)}% — {paycap.band}</div>
      </Card>
    </section>
  );
}

function AddMovement({ onAdd }) {
  function handleSubmit(e) {
    e.preventDefault();
    const f = e.currentTarget.elements;
    const kind = f.kind.value; // income | expense
    const amount = Number(f.amount.value);
    const desc = f.desc.value;
    if (!amount || amount <= 0) return;
    if (kind === "expense") {
      const fixed = f.fixed.value; // fijo | variable
      const need = f.need.value;   // necesario | prescindible
      const category = f.category.value; // categoría simple para presupuesto
      onAdd(makeTx({ rawDesc: desc, amount, kind, fixed, need, category }));
    } else {
      onAdd(makeTx({ rawDesc: desc, amount, kind }));
    }
    e.currentTarget.reset();
    f.kind.value = "income"; // como el HTML original
  }
  return (
    <Card title={<div className="flex items-center gap-2">➕ Añadir nueva transacción</div>}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex flex-col">
            <label className="text-sm font-semibold">Descripción</label>
            <input name="desc" placeholder="Ej: Salario, Alquiler" className="rounded-xl p-3 border focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          <div className="flex flex-col">
            <label className="text-sm font-semibold">Monto</label>
            <input name="amount" placeholder="Ej: 500" type="number" step="0.01" className="rounded-xl p-3 border focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          <div className="flex flex-col">
            <label className="text-sm font-semibold">Tipo</label>
            <select name="kind" defaultValue="income" className="rounded-xl p-3 border focus:outline-none focus:ring-2 focus:ring-indigo-500">
              <option value="income">Ingreso</option>
              <option value="expense">Gasto</option>
            </select>
          </div>
          <div className="flex flex-col">
            <label className="text-sm font-semibold">Categoría</label>
            <select name="category" defaultValue="obligatorios" className="rounded-xl p-3 border focus:outline-none focus:ring-2 focus:ring-indigo-500">
              {CATS.map((c) => (
                <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex flex-col">
            <label className="text-sm font-semibold">Tipo de Gasto</label>
            <select name="fixed" defaultValue="variable" className="rounded-xl p-3 border focus:outline-none focus:ring-2 focus:ring-indigo-500">
              <option value="variable">Variable</option>
              <option value="fijo">Fijo</option>
            </select>
          </div>
          <div className="flex flex-col">
            <label className="text-sm font-semibold">Prioridad</label>
            <select name="need" defaultValue="necesario" className="rounded-xl p-3 border focus:outline-none focus:ring-2 focus:ring-indigo-500">
              <option value="necesario">Necesario</option>
              <option value="prescindible">Prescindible</option>
            </select>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2">
          <span className="text-xs text-slate-500">Consejo: registra primero tus fijos (alquiler, servicios) y luego variables.</span>
          <button className="btn">Añadir</button>
        </div>
      </form>
    </Card>
  );
}

function Budgets({ monthlyIncome, budgets, usedMap, envelopes, onSetIncome, onSetBudget, onToast }) {
  const totalPct = Object.values(budgets).reduce((s, p) => s + p, 0);
  const off = Math.round((totalPct - 1) * 100);

  // Preparar filas de categorías
  const rows = useMemo(() => CATS.map((c) => {
    const pctv = budgets[c.id] || 0;
    const budget = pctv * monthlyIncome;
    const used = usedMap[c.id] || 0;
    const ratio = budget ? Math.min(1, used / budget) : 0;
    const color = ratio >= 1 ? "bg-red-500" : ratio >= 0.8 ? "bg-yellow-500" : "bg-green-500";
    return { c, pctv, budget, used, ratio, color };
  }), [budgets, monthlyIncome, usedMap]);

  // Alertas
  const exceededKey = rows.filter(r => r.ratio >= 1).map(r => r.c.id).join(",");
  useEffect(() => { if (exceededKey) { const names = rows.filter(r => r.ratio >= 1).map(r => r.c.name).join(", "); onToast && onToast(`¡Alerta! Excediste: ${names}.`); } }, [exceededKey]);
  useEffect(() => { if (off !== 0) onToast && onToast("Atención: los porcentajes deben sumar 100%."); }, [off]);

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <h2 className="font-semibold">⚙️ Presupuesto por categoría</h2>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-slate-600">Ingreso neto mensual</span>
          <input className="w-32 border p-2 rounded-xl" type="number" value={monthlyIncome} onChange={(e) => onSetIncome(Number(e.target.value) || 0)} placeholder="2000" />
        </label>
      </div>
      <p className="text-xs text-slate-600">Cada ingreso se reparte automáticamente entre tus fondos según estos porcentajes. Gastar en una categoría descuenta de su fondo (puede quedar en rojo).</p>
      <p className={`text-sm ${off === 0 ? "text-emerald-600" : "text-amber-600"}`}>
        Total: {Math.round(totalPct * 100)}% {off !== 0 && `(ajusta ${off > 0 ? "-" + Math.abs(off) : "+" + Math.abs(off)} pts)`}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {rows.map(({ c, pctv, budget, used, ratio, color }) => (
          <div key={c.id} className="p-4 bg-white rounded-2xl border hover:shadow-sm transition-shadow">
            <div className="flex items-center justify-between gap-3">
              <div className="font-medium">{c.icon} {c.name}</div>
              <div className="flex items-center gap-2 text-sm">
                <input className="w-16 border p-1 rounded text-right" type="number" value={Math.round(pctv * 100)} onChange={(e) => onSetBudget(c.id, (Number(e.target.value) || 0) / 100)} />
                <span className="text-slate-500">%</span>
              </div>
            </div>
            <div className="mt-2 h-3 bg-slate-100 rounded-full overflow-hidden">
              <div className={`h-3 ${color} transition-all`} style={{ width: `${Math.round(ratio * 100)}%` }} />
            </div>
            <div className="mt-1 text-xs text-slate-500 grid grid-cols-1 sm:grid-cols-3 gap-1">
              <span>Usado: <b>{fmt(used)}</b></span>
              <span>Presupuesto: <b>{fmt(budget)}</b></span>
              <span>Fondo actual: <b className={envelopes?.[c.id] < 0 ? "text-rose-600" : "text-emerald-600"}>{fmt(envelopes?.[c.id] || 0)}</b></span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Breakdown({ txs }) {
  const fixedVar = useMemo(() => {
    const f = txs.filter((t) => t.kind === "expense");
    const total = f.reduce((s, t) => s + t.amount, 0) || 1;
    const fijo = f.filter((t) => t.fixed === "fijo").reduce((s, t) => s + t.amount, 0);
    const variable = total - fijo;
    return { fijo, variable };
  }, [txs]);
  const needDisp = useMemo(() => {
    const f = txs.filter((t) => t.kind === "expense");
    const total = f.reduce((s, t) => s + t.amount, 0) || 1;
    const necesario = f.filter((t) => t.need === "necesario").reduce((s, t) => s + t.amount, 0);
    const prescindible = total - necesario;
    return { necesario, prescindible };
  }, [txs]);
  return (
    <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card title="Gastos Fijos vs Variables">
        <ul className="text-sm">
          <li>Fijos: <span className="font-semibold">{fmt(fixedVar.fijo)}</span></li>
          <li>Variables: <span className="font-semibold">{fmt(fixedVar.variable)}</span></li>
        </ul>
      </Card>
      <Card title="Gastos Necesarios vs Prescindibles">
        <ul className="text-sm">
          <li>Necesarios: <span className="font-semibold">{fmt(needDisp.necesario)}</span></li>
          <li>Prescindibles: <span className="font-semibold">{fmt(needDisp.prescindible)}</span></li>
        </ul>
      </Card>
    </section>
  );
}

function Projection({ txs, months, setMonths, toast, monthlyIncome }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);

  const totalIncome = txs.filter((t) => t.kind === "income").reduce((s, t) => s + t.amount, 0);
  const totalExpense = txs.filter((t) => t.kind === "expense").reduce((s, t) => s + t.amount, 0);
  const currentBalance = totalIncome - totalExpense;

  const incomeCount = txs.filter((t) => t.kind === "income").length || 1;
  const expenseCount = txs.filter((t) => t.kind === "expense").length || 1;
  const incomeAvg = totalIncome / incomeCount;
  const expenseAvg = totalExpense / expenseCount;
  const netAvg = incomeAvg - expenseAvg;

  const labels = useMemo(() => { const arr = ["Actual"]; for (let i = 1; i <= months; i++) arr.push(`Mes ${i}`); return arr; }, [months]);
  const data = useMemo(() => { const arr = [currentBalance]; for (let i = 1; i <= months; i++) arr.push(currentBalance + netAvg * i); return arr; }, [months, currentBalance, netAvg]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const ctx = canvasRef.current.getContext("2d");
    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(ctx, {
      type: "line",
      data: { labels, datasets: [{ label: "Proyección de Saldo", data, borderColor: "#6366f1", backgroundColor: "rgba(99,102,241,0.1)", borderWidth: 2, fill: true, tension: 0.3 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, title: { display: true, text: "Periodo" } }, y: { title: { display: true, text: "Saldo ($)" } } } },
    });
  }, [labels, data]);

  useEffect(() => { // Alertas
    if (months <= 0) return;
    const projectedBalance = data[data.length - 1];
    if (projectedBalance < 0) toast && toast(`Alerta: con tu ritmo actual, el saldo en ${months} meses sería ${fmt(projectedBalance)}.`);
    else if (projectedBalance > monthlyIncome) toast && toast(`¡Bien! Saldo proyectado en ${months} meses: ${fmt(projectedBalance)}.`);
  }, [months, data, monthlyIncome, toast]);

  return (
    <section className="space-y-3">
      <h2 className="font-semibold">📈 Proyección de saldo</h2>
      <label className="flex items-center gap-2 text-sm">
        <span className="text-slate-600">Número de meses</span>
        <input className="w-28 border p-2 rounded-xl" type="number" value={months} onChange={(e) => setMonths(Number(e.target.value) || 0)} />
      </label>
      <div className="border rounded-2xl p-4 bg-white h-[40vh]">
        <canvas ref={canvasRef} />
      </div>
      <p className="text-xs text-center text-slate-500">La proyección usa promedios simples de tus ingresos y gastos registrados.</p>
    </section>
  );
}

function Movements({ txs, onDelete }) {
  return (
    <section className="space-y-2">
      <h2 className="font-semibold">🧾 Historial de transacciones</h2>
      {txs.length === 0 && <div className="text-sm text-slate-500">Aún no hay movimientos.</div>}
      {txs.map((t) => (
        <div key={t.id} className="p-3 rounded-2xl border bg-white grid grid-cols-[1fr_auto_auto_auto] gap-2 items-center hover:shadow-sm transition-shadow">
          <div className="truncate">
            <div className="font-medium">{t.desc}</div>
            {t.kind === "expense" && (
              <div className="text-xs text-slate-500 flex gap-2 flex-wrap mt-0.5">
                <span className="px-2 py-0.5 border rounded-full">{t.fixed === "fijo" ? "Fijo" : "Variable"}</span>
                <span className={`px-2 py-0.5 border rounded-full ${t.need === "prescindible" ? "bg-amber-50" : "bg-emerald-50"}`}>{t.need === "prescindible" ? "Prescindible" : "Necesario"}</span>
                {t.category && <span className="px-2 py-0.5 border rounded-full">{CATS.find((x) => x.id === t.category)?.name}</span>}
              </div>
            )}
          </div>
          <div className={t.kind === "income" ? "text-emerald-600 font-semibold" : "text-rose-600 font-semibold"}>
            {t.kind === "income" ? "+" : "-"}{t.amount.toFixed(2)}
          </div>
          <div className="text-xs text-slate-500">{new Date(t.ts).toLocaleString("es-ES")}</div>
          <button onClick={() => onDelete(t.id)} className="text-xs text-slate-500 hover:text-rose-600">Eliminar</button>
        </div>
      ))}
    </section>
  );
}

// ---------------- Deudas ----------------
function DebtForm({ onAdd }) {
  function handleSubmit(e) {
    e.preventDefault();
    const f = e.currentTarget.elements;
    const name = f.name.value.trim();
    const principal = Number(f.principal.value);
    const apr = Number(f.apr.value) / 100; // % a decimal anual
    const termMonths = Number(f.term.value || 0);
    const minPayment = Number(f.payment.value || 0);
    if (!name || !principal || principal <= 0) return;
    const id = String(Date.now() + Math.random());
    onAdd({ id, name, principal, apr, termMonths: termMonths || undefined, minPayment: minPayment || undefined, startTs: new Date().toISOString() });
    e.currentTarget.reset();
  }
  return (
    <Card title={<span>💳 Añadir deuda</span>}>
      <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <input name="name" className="border p-2 rounded-xl" placeholder="Nombre (p.ej. Tarjeta Visa)" />
        <input name="principal" type="number" className="border p-2 rounded-xl" placeholder="Principal ($)" />
        <input name="apr" type="number" step="0.01" className="border p-2 rounded-xl" placeholder="Tasa anual (%)" />
        <input name="term" type="number" className="border p-2 rounded-xl" placeholder="Plazo (meses) opcional" />
        <input name="payment" type="number" className="border p-2 rounded-xl" placeholder="Pago mensual (si lo sabes)" />
        <div className="flex items-center justify-end"><button className="btn">Agregar</button></div>
      </form>
    </Card>
  );
}

function DebtsList({ debts, onDelete }) {
  if (!debts?.length) return (
    <Card title="📉 Deudas">
      <div className="text-sm text-slate-500">Aún no has registrado deudas.</div>
    </Card>
  );

  return (
    <section className="grid grid-cols-1 gap-3">
      {debts.map((d) => {
        const payment = calcPayment(d);
        const { schedule, months, totalInterest } = buildSchedule({ principal: d.principal, apr: d.apr, payment });
        const payoffDate = new Date(Date.now()); payoffDate.setMonth(payoffDate.getMonth() + months);
        return (
          <Card key={d.id} title={<span>📉 {d.name}</span>} right={<button className="text-xs text-slate-500 hover:text-rose-600" onClick={() => onDelete(d.id)}>Eliminar</button>}>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-sm">
              <div><span className="text-slate-500">Principal</span><div className="font-semibold">{fmt(d.principal)}</div></div>
              <div><span className="text-slate-500">Tasa</span><div className="font-semibold">{pct(d.apr)}</div></div>
              <div><span className="text-slate-500">Pago estimado</span><div className="font-semibold">{fmt(payment)}</div></div>
              <div><span className="text-slate-500">Se liquida en</span><div className="font-semibold">{months} meses ({payoffDate.toLocaleDateString("es-ES")})</div></div>
            </div>
            <div className="mt-2 text-xs text-slate-500">Intereses totales estimados: <b>{fmt(totalInterest)}</b></div>
            {schedule.length > 0 && (
              <details className="mt-2">
                <summary className="text-sm cursor-pointer select-none">Ver tabla de amortización</summary>
                <div className="mt-2 max-h-64 overflow-auto border rounded-xl">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 sticky top-0">
                      <tr>
                        <th className="text-left p-2">Mes</th>
                        <th className="text-right p-2">Pago</th>
                        <th className="text-right p-2">Interés</th>
                        <th className="text-right p-2">Principal</th>
                        <th className="text-right p-2">Saldo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {schedule.slice(0, 360).map((r) => (
                        <tr key={r.month} className="odd:bg-white even:bg-slate-50">
                          <td className="p-2">{r.month}</td>
                          <td className="p-2 text-right">{fmt(r.payment)}</td>
                          <td className="p-2 text-right">{fmt(r.interest)}</td>
                          <td className="p-2 text-right">{fmt(r.principal)}</td>
                          <td className="p-2 text-right">{fmt(r.balance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </Card>
        );
      })}
    </section>
  );
}

function DebtsSummary({ debts }) {
  const totals = useMemo(() => {
    if (!debts?.length) return { balance: 0, payment: 0, interest: 0 };
    let bal = 0, pay = 0, intTot = 0;
    for (const d of debts) {
      bal += d.principal;
      const p = calcPayment(d);
      pay += p;
      const { totalInterest } = buildSchedule({ principal: d.principal, apr: d.apr, payment: p });
      intTot += totalInterest;
    }
    return { balance: bal, payment: pay, interest: intTot };
  }, [debts]);
  return totals;
}

// ---------------- Metas ----------------
function GoalForm({ onSetGoal }) {
  function handleSubmit(e) {
    e.preventDefault();
    const name = e.currentTarget.elements.goalname.value;
    const cost = parseFloat(e.currentTarget.elements.goalcost.value);
    const months = parseInt(e.currentTarget.elements.goalmonths.value || "0", 10);
    if (name && cost > 0) onSetGoal({ name, cost, months });
    e.currentTarget.reset();
  }
  return (
    <Card title="🎯 Establecer una meta financiera">
      <form onSubmit={handleSubmit} className="space-y-2">
        <input name="goalname" placeholder="Ej: Viaje a Japón" className="w-full border p-2 rounded-xl" />
        <input name="goalcost" placeholder="Costo ($)" type="number" className="w-full border p-2 rounded-xl" />
        <input name="goalmonths" placeholder="Plazo deseado (meses, opcional)" type="number" className="w-full border p-2 rounded-xl" />
        <div className="flex justify-end"><button className="btn">Calcular plan</button></div>
      </form>
    </Card>
  );
}

function GoalStatus({ goal, balance, monthlySavings }) {
  if (!goal) return null;
  const remaining = Math.max(0, goal.cost - balance);
  if (remaining <= 0) return <div className="p-3 bg-indigo-50 rounded-2xl">¡Felicidades! Meta <b>{goal.name}</b> alcanzada.</div>;
  const etaByRhythm = monthlySavings > 0 ? Math.ceil(remaining / monthlySavings) : null;
  if (goal.months > 0) {
    const required = remaining / goal.months;
    const ok = monthlySavings >= required;
    return (
      <div className={`p-3 rounded-2xl ${ok ? "bg-emerald-50" : "bg-amber-50"}`}>
        Para lograr <b>{goal.name}</b> en <b>{goal.months} meses</b> necesitas ahorrar <b>{fmt(required)}</b>/mes. Ritmo actual: <b>{fmt(monthlySavings)}</b>/mes. {ok ? "¡Vas bien!" : "Recorta prescindibles o aumenta ingresos."}
        {etaByRhythm ? <> — Con tu ritmo actual, la alcanzarías en ~<b>{etaByRhythm}</b> meses.</> : null}
      </div>
    );
  }
  return (
    <div className="p-3 bg-indigo-50 rounded-2xl">Faltan {fmt(remaining)}. {etaByRhythm ? `Lo lograrías en ~${etaByRhythm} meses si mantienes el ritmo.` : "Empieza a ahorrar/invertir para avanzar."}</div>
  );
}

// ---------------- App ----------------
export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState, (init) => {
    if (typeof localStorage !== "undefined") {
      const saved = localStorage.getItem("avanza-state-v7");
      if (saved) return JSON.parse(saved);
    }
    return init;
  });
  const [toastMsg, setToastMsg] = useState("");
  const [months, setMonths] = useState(6);

  const toast = (m) => {
    setToastMsg(m);
    window.clearTimeout(window.__avanza_toast);
    window.__avanza_toast = window.setTimeout(() => setToastMsg(""), 3200);
  };

  useEffect(() => { if (typeof localStorage !== "undefined") localStorage.setItem("avanza-state-v7", JSON.stringify(state)); }, [state]);

  const incomeTotal = useMemo(() => state.txs.filter((t) => t.kind === "income").reduce((s, t) => s + t.amount, 0), [state.txs]);
  const expenseTotal = useMemo(() => state.txs.filter((t) => t.kind === "expense").reduce((s, t) => s + t.amount, 0), [state.txs]);
  const usedMap = useMemo(() => spentByCat(state.txs), [state.txs]);
  const envelopes = useMemo(() => deriveEnvelopes(state.budgets, state.txs), [state.budgets, state.txs]);
  const monthlySavings = incomeTotal - expenseTotal;
  const debtTotals = DebtsSummary({ debts: state.debts });
  const paycap = computeCapacity(state, debtTotals.payment);

  // Semilla de ejemplo
  function seedExample() {
    const now = Date.now();
    const seed = {
      monthlyIncome: 2500,
      budgets: { ...defaultBudgets },
      txs: [
        makeTx({ rawDesc: "Nómina", amount: 2500, kind: "income" }),
        makeTx({ rawDesc: "Alquiler", amount: 900, kind: "expense", fixed: "fijo", need: "necesario", category: "obligatorios" }),
        makeTx({ rawDesc: "Supermercado", amount: 260, kind: "expense", fixed: "variable", need: "necesario", category: "obligatorios" }),
        makeTx({ rawDesc: "Restaurante", amount: 120, kind: "expense", fixed: "variable", need: "prescindible", category: "diversion" }),
        makeTx({ rawDesc: "Transporte", amount: 60, kind: "expense", fixed: "variable", need: "necesario", category: "obligatorios" })
      ].map((t, i) => ({ ...t, ts: new Date(now - i * 36e5).toISOString() })),
    };
    dispatch({ type: "SEED_SAMPLE", payload: seed });
    toast("Ejemplo cargado. Añade deudas para ver su amortización.");
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 space-y-6">
      <Hero state={state} onReset={() => dispatch({ type: "RESET_DEMO" })} onSeed={seedExample} />

      <Summary balance={state.balance} incomeTotal={incomeTotal} expenseTotal={expenseTotal} debtTotals={debtTotals} envelopes={envelopes} paycap={paycap} />

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">
        <div className="xl:col-span-2 space-y-6">
          <AddMovement onAdd={(tx) => dispatch({ type: "ADD_TX", tx })} />
          <Budgets
            monthlyIncome={state.monthlyIncome}
            budgets={state.budgets}
            usedMap={usedMap}
            envelopes={envelopes}
            onSetIncome={(income) => dispatch({ type: "SET_INCOME", income })}
            onSetBudget={(key, value) => dispatch({ type: "SET_BUDGET", key, value })}
            onToast={toast}
          />
          <Breakdown txs={state.txs} />
          <Projection txs={state.txs} months={months} setMonths={setMonths} toast={toast} monthlyIncome={state.monthlyIncome} />
          <GoalForm onSetGoal={(goal) => dispatch({ type: "SET_GOAL", goal })} />
          <GoalStatus goal={state.goal} balance={state.balance} monthlySavings={monthlySavings} />
          <Movements txs={state.txs} onDelete={(id) => dispatch({ type: "DELETE_TX", id })} />
        </div>
        <div className="space-y-6">
          <DebtForm onAdd={(debt) => { dispatch({ type: "ADD_DEBT", debt }); toast("Deuda añadida."); }} />
          <DebtsList debts={state.debts} onDelete={(id) => dispatch({ type: "DELETE_DEBT", id })} />
        </div>
      </div>

      <Toast message={toastMsg} />
    </div>
  );
}

// ---------------- Estilos base (btn) ----------------
function injectStyles() {
  const id = "avanza-btn";
  if (typeof document === "undefined" || document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.innerHTML = 
    `.btn{all:unset;display:inline-block;padding:.5rem .75rem;border-radius:.75rem;background:#111827;color:#fff;border:1px solid #111827}`+
    `.btn:hover{opacity:.9}`+
    `.btn:active{opacity:.8}`;
  document.head.appendChild(style);
}
if (typeof document !== "undefined") injectStyles();

// ---------------- Tests (runtime) ----------------
function runTests() {
  const s0 = { ...initialState };
  // Gasto necesario fijo en obligatorios
  const g1 = makeTx({ rawDesc: "alquiler", amount: 800, kind: "expense", fixed: "fijo", need: "necesario", category: "obligatorios" });
  const s1 = reducer(s0, { type: "ADD_TX", tx: g1 });
  console.assert(s1.balance === -800 && s1.txs.length === 1, "ADD_TX gasto correcto");
  // Ingreso
  const i1 = makeTx({ rawDesc: "nomina", amount: 2000, kind: "income" });
  const s2 = reducer(s1, { type: "ADD_TX", tx: i1 });
  console.assert(s2.balance === 1200 && s2.txs.length === 2, "ADD_TX ingreso correcto");
  // Presupuesto suma 100%
  const totPct = Object.values(s2.budgets).reduce((a, b) => a + b, 0);
  console.assert(Math.round(totPct * 100) === 100, "Budgets suman 100%");
  // spentByCat
  const used = spentByCat(s2.txs);
  console.assert(used.obligatorios === 800, "spentByCat acumula obligatorios");
  // Delete
  const s3 = reducer(s2, { type: "DELETE_TX", id: g1.id });
  console.assert(s3.balance === 2000 && s3.txs.length === 1, "DELETE_TX revierte gasto");

  // ---- Tests de deudas ----
  const pmt = calcPayment({ principal: 1000, apr: 0.24, termMonths: 12 });
  console.assert(pmt > 0, "PMT > 0");
  const sch = buildSchedule({ principal: 1000, apr: 0.24, payment: pmt });
  console.assert(sch.months <= 12 + 1, "se liquida en ~n meses");
  const sch2 = buildSchedule({ principal: 1000, apr: 0.24, payment: pmt + 10 });
  console.assert(sch2.months < sch.months, "pago mayor -> menos meses");

  // Reducer de deudas
  const d = { id: "d1", name: "Test", principal: 500, apr: 0.2, termMonths: 6 };
  const s4 = reducer(s3, { type: "ADD_DEBT", debt: d });
  console.assert(s4.debts.length === 1, "ADD_DEBT agrega");
  const s5 = reducer(s4, { type: "DELETE_DEBT", id: "d1" });
  console.assert(s5.debts.length === 0, "DELETE_DEBT elimina");

  // Capacidad: si ingreso=2000 y obligatorios=800 y deuda pago=200 => capacity=1000
  const tA = [makeTx({ rawDesc: "ing", amount: 2000, kind: "income" }), makeTx({ rawDesc: "alq", amount: 800, kind: "expense", category: "obligatorios", fixed: "fijo", need: "necesario" })];
  const cap = computeCapacity({ ...initialState, monthlyIncome: 2000, txs: tA }, 200);
  console.assert(Math.round(cap.capacity) === 1000, "computeCapacity básico");

  console.log("✅ Tests OK (v7.1)");
}
if (typeof window !== "undefined" && !window.__AVANZA_TESTS_V71__) {
  window.__AVANZA_TESTS_V71__ = true;
  try { runTests(); } catch (e) { console.error("Tests error:", e); }
}
