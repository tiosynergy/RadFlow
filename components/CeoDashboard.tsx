"use client";

/* ===== RadFlow — CEO Dashboard (Загальний огляд) =====
   Виконавчий дашборд: KPI, тижневий графік, топ-процедури, завантаженість апаратів.
   Метрики рахуються з queue_entries (період: сьогодні / тиждень / місяць). Realtime. */

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import Sidebar from "@/components/Sidebar";
import LiveClock from "@/components/LiveClock";
import type { Json } from "@/supabase/types";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null };
type EntryRow = { id: string; status: string; duration_min: number | null; studies: Json; room_id: string | null; scheduled_date: string | null; patient_name: string | null };
type WeekRow = { id: string; status: string; scheduled_date: string | null };
type StudyLike = { price?: number; region?: string; contrast?: boolean; type?: string };
type RevenueEntry = { studies?: unknown; note?: string | null };

const WK_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
const MON_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
function startOfDay(d: Date) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function today0() { return startOfDay(new Date()); }
function dateKey(d: Date) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function fmtShort(d: Date) { return d.getDate() + " " + MON_GEN[d.getMonth()]; }
function modalityLabel(m: string) { return m === "MRI" ? "МРТ" : m === "CT" ? "КТ" : "Інше"; }
function fmtUah(n: number) { return String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₴"; }

const PRICE: Record<string, number> = {
  "Головний мозок": 2400, "Хребет — шийний відділ": 2100, "Хребет — грудний відділ": 2100, "Хребет — поперековий відділ": 2100,
  "Колінний суглоб": 1800, "Плечовий суглоб": 1800, "Кульшовий суглоб": 1900, "Черевна порожнина": 2600, "Малий таз": 2600,
  "Серце та судини": 3200, "Молочні залози": 2700,
  "Голова / мозок": 1200, "Органи грудної клітки": 1500, "Органи черевної порожнини": 1700, "Хребет": 1400,
  "Кінцівки": 1200, "КТ-ангіографія": 2400, "Мультизональне дослідження": 2800,
};
const CONTRAST_SURCHARGE = 900;

function entryRevenue(e: RevenueEntry): number {
  const s: StudyLike[] = Array.isArray(e.studies) ? (e.studies as StudyLike[]) : [];
  if (!s.length) return 0;
  return s.reduce((sum, x) => {
    const stored = (typeof x.price === "number") ? x.price : null;
    const est = (PRICE[x.region || ""] || 1500) + (x.contrast ? CONTRAST_SURCHARGE : 0);
    return sum + (stored != null ? stored : est);
  }, 0);
}
function entryFullyPriced(e: RevenueEntry): boolean {
  const s: StudyLike[] = Array.isArray(e.studies) ? (e.studies as StudyLike[]) : [];
  return s.length > 0 && s.every((x) => typeof x.price === "number");
}
function procName(e: RevenueEntry): string {
  const s: StudyLike[] = Array.isArray(e.studies) ? (e.studies as StudyLike[]) : [];
  if (s.length) return (s[0].type || "") + (s[0].region ? " · " + s[0].region : "");
  return e.note || "—";
}

function periodRange(period: string): [Date, Date] {
  const t = today0();
  if (period === "today") return [t, t];
  if (period === "week") { const mon = addDays(t, -((t.getDay() + 6) % 7)); return [mon, addDays(mon, 6)]; }
  const first = new Date(t.getFullYear(), t.getMonth(), 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0);
  return [first, last];
}
function workdaysBetween(a: Date, b: Date): number {
  let n = 0; let d = new Date(a);
  while (d <= b) { if (d.getDay() !== 0) n++; d = addDays(d, 1); }
  return n;
}

function ProgressCircle({ pct, color }: { pct: number; color: string }) {
  const r = 52, c = 2 * Math.PI * r, off = c * (1 - Math.min(100, pct) / 100);
  return (
    <svg width="130" height="130" viewBox="0 0 130 130">
      <circle cx="65" cy="65" r={r} fill="none" stroke="var(--border)" strokeWidth="10" />
      <circle cx="65" cy="65" r={r} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={off} transform="rotate(-90 65 65)" style={{ transition: "stroke-dashoffset .5s" }} />
      <text x="65" y="64" textAnchor="middle" fontSize="30" fontWeight="700" fill="var(--text)" className="tabular">{pct}%</text>
      <text x="65" y="86" textAnchor="middle" fontSize="11" fill="var(--text-muted)">завантаж.</text>
    </svg>
  );
}

const card = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 20 };

interface CeoDashboardProps {
  clinicId: string;
  rooms?: RoomOpt[];
  clinicName?: string;
  adminName?: string;
  adminRole?: string;
  roleKey?: string;
}

export default function CeoDashboard({ clinicId, rooms, clinicName, adminName, adminRole, roleKey = "admin" }: CeoDashboardProps) {
  const [period, setPeriod] = useState("today");
  const [entries, setEntries] = useState<EntryRow[]>([]);
  const [weekEntries, setWeekEntries] = useState<WeekRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roomsById = useMemo(() => { const m: Record<string, RoomOpt> = {}; (rooms || []).forEach((r) => { m[r.id] = r; }); return m; }, [rooms]);

  function notify(msg: string) { setToast(msg); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 3000); }

  const [from, to] = periodRange(period);

  const reload = useCallback(async () => {
    const supabase = createClient();
    const [f, t] = periodRange(period);
    const { data } = await supabase
      .from("queue_entries")
      .select("id, status, duration_min, studies, room_id, scheduled_date, patient_name")
      .eq("clinic_id", clinicId).neq("status", "cancelled")
      .gte("scheduled_date", dateKey(f)).lte("scheduled_date", dateKey(t));
    setEntries(data || []);
    // тиждень для графіка
    const wk = today0(); const mon = addDays(wk, -((wk.getDay() + 6) % 7));
    const { data: wdata } = await supabase
      .from("queue_entries")
      .select("id, status, scheduled_date")
      .eq("clinic_id", clinicId).neq("status", "cancelled")
      .gte("scheduled_date", dateKey(mon)).lte("scheduled_date", dateKey(addDays(mon, 6)));
    setWeekEntries(wdata || []);
    setLoading(false);
  }, [clinicId, period]);

  // Спинер при первой загрузке/смене клиники.
  useEffect(() => { setLoading(true); }, [clinicId]);

  // Перерасчёт при смене периода: realtime-хук слушает только clinicId.
  useEffect(() => { reload(); }, [reload]);

  // TD-3: единый realtime-паттерн.
  useRealtimeRefetch({
    channelName: clinicId ? "ceo-" + clinicId : null,
    subscriptions: [
      { table: "queue_entries", filter: "clinic_id=eq." + clinicId, onChange: reload },
    ],
  });

  /* KPI */
  const total = entries.length;
  const done = entries.filter((e) => e.status === "done").length;
  const noShow = entries.filter((e) => e.status === "no_show").length;
  const notHeld = entries.filter((e) => e.status === "not_held").length;
  const active = entries.filter((e) => ["scheduled", "waiting", "in_progress"].includes(e.status)).length;

  const workdays = Math.max(1, workdaysBetween(from, to < today0() ? to : today0()));
  const capacityMin = (rooms || []).length * 480 * workdays;
  const bookedMin = entries.filter((e) => e.status !== "no_show" && e.status !== "not_held").reduce((s, e) => s + (e.duration_min || 0), 0);
  const util = capacityMin ? Math.min(100, Math.round((bookedMin / capacityMin) * 100)) : 0;
  const utilColor = util > 70 ? "var(--green)" : util >= 50 ? "var(--orange)" : "var(--red)";

  const doneEntries = entries.filter((e) => e.status === "done");
  const revenue = doneEntries.reduce((s, e) => s + entryRevenue(e), 0);
  const revenueExact = doneEntries.length > 0 && doneEntries.every(entryFullyPriced);

  /* тижневий графік: total + no_show по днях (Пн–Нд) */
  const wk = today0(); const mon = addDays(wk, -((wk.getDay() + 6) % 7));
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(mon, i));
  const weekData = weekDays.map((d) => {
    const k = dateKey(d);
    const dayEntries = weekEntries.filter((e) => e.scheduled_date === k);
    return { d, total: dayEntries.length, noShow: dayEntries.filter((e) => e.status === "no_show" || e.status === "not_held").length };
  });
  const maxBar = Math.max(1, ...weekData.map((x) => x.total));

  /* топ-5 процедур */
  const procMap: Record<string, number> = {};
  entries.forEach((e) => { const n = procName(e); procMap[n] = (procMap[n] || 0) + 1; });
  const topProcs = Object.entries(procMap).sort((a, b) => b[1] - a[1]).slice(0, 5);

  /* завантаженість по апаратах */
  const roomUtil = (rooms || []).map((r) => {
    const mins = entries.filter((e) => e.room_id === r.id && e.status !== "no_show" && e.status !== "not_held").reduce((s, e) => s + (e.duration_min || 0), 0);
    const cap = 480 * workdays;
    return { name: r.name, kind: modalityLabel(r.modality), pct: cap ? Math.min(100, Math.round((mins / cap) * 100)) : 0, color: r.modality === "MRI" ? "var(--blue)" : "var(--orange)" };
  });

  function exportCsv() {
    const head = ["Дата", "Пацієнт", "Процедура", "Кабінет", "Статус", "Дохід"];
    const rows = entries.map((e) => [e.scheduled_date, e.patient_name, procName(e), (e.room_id ? roomsById[e.room_id] : null)?.name || "", e.status, entryRevenue(e)]);
    // Захист від CSV-інʼєкції: значення, що починаються з = + - @, екрануємо апострофом.
    const safe = (c: unknown) => { let v = String(c == null ? "" : c); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
    const csv = [head, ...rows].map((r) => r.map(safe).join(";")).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "ceo-" + period + ".csv"; a.click(); URL.revokeObjectURL(url);
    notify("Експортовано у CSV");
  }

  const PERIODS = [{ k: "today", l: "Сьогодні" }, { k: "week", l: "Цей тиждень" }, { k: "month", l: "Цей місяць" }];
  const periodLabel = period === "today" ? fmtShort(from) : fmtShort(from) + " – " + fmtShort(to);

  return (
    <div className="app">
      <Sidebar clinicName={clinicName} adminName={adminName} adminRole={adminRole} roleKey={roleKey} rooms={rooms} activeNav="ceo" />
      <div className="main">
        <header className="topbar">
          <div className="tb-title">
            <span className="tic">📊</span>
            <div><h1>Дашборд — Загальний огляд</h1><div className="date">{clinicName} · {periodLabel} · <LiveClock /></div></div>
          </div>
          <div className="tb-right">
            <div className="bk-seg">
              {PERIODS.map((p) => <button key={p.k} className={"bk-seg-btn" + (period === p.k ? " active" : "")} onClick={() => setPeriod(p.k)}>{p.l}</button>)}
            </div>
            <button className="btn btn-secondary" onClick={exportCsv}>↧ Експортувати CSV</button>
          </div>
        </header>

        <div className="content" style={{ overflowY: "auto", padding: "22px" }}>
          {loading ? (
            <div className="empty"><div className="et">Завантаження…</div></div>
          ) : (
            <>
              {/* KPI row */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
                <div style={card}>
                  <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>Записи · {PERIODS.find((p) => p.k === period)?.l.toLowerCase()}</div>
                  <div style={{ fontSize: 40, fontWeight: 700 }} className="tabular">{total}</div>
                  <div style={{ display: "flex", gap: 16, marginTop: 14, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13 }}><b style={{ color: "var(--green)" }} className="tabular">{done}</b> <span style={{ color: "var(--text-muted)" }}>виконано</span></span>
                    <span style={{ fontSize: 13 }}><b style={{ color: "var(--red)" }} className="tabular">{noShow}</b> <span style={{ color: "var(--text-muted)" }}>неявка</span></span>
                    <span style={{ fontSize: 13 }}><b style={{ color: "var(--orange)" }} className="tabular">{notHeld}</b> <span style={{ color: "var(--text-muted)" }}>не відбулося</span></span>
                    <span style={{ fontSize: 13 }}><b style={{ color: "var(--blue)" }} className="tabular">{active}</b> <span style={{ color: "var(--text-muted)" }}>в процесі</span></span>
                  </div>
                </div>

                <div style={{ ...card, display: "flex", alignItems: "center", gap: 18 }}>
                  <ProgressCircle pct={util} color={utilColor} />
                  <div>
                    <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Завантаженість</div>
                    <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 8 }}>{(rooms || []).length} апаратів · {workdays} роб. дн.</div>
                    <div style={{ fontSize: 12.5, color: utilColor, marginTop: 6, fontWeight: 600 }}>{util > 70 ? "Висока" : util >= 50 ? "Помірна" : "Низька"}</div>
                  </div>
                </div>

                <div style={card}>
                  <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>{revenueExact ? "Дохід · виконані" : "Дохід (частково оцінка) · виконані"}</div>
                  <div style={{ fontSize: 34, fontWeight: 700, color: "var(--green)" }} className="tabular">{fmtUah(revenue)}</div>
                  <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 12 }}>За цінами довідника досліджень · {done} виконаних</div>
                </div>
              </div>

              {/* Chart + sidebar */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16, marginTop: 16 }}>
                <div style={card}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Дослідження за тиждень</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16 }}>Стовпці — всього, червоні позначки — зрив (неявка + не відбулося)</div>
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 10, height: 180, paddingTop: 10 }}>
                    {weekData.map((x, i) => (
                      <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                        <div style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 600 }} className="tabular">{x.total}</div>
                        <div style={{ width: "100%", display: "flex", alignItems: "flex-end", justifyContent: "center", height: 130, position: "relative" }}>
                          {(() => { const barH = x.total ? Math.max(4, Math.round((x.total / maxBar) * 130)) : 0; return (<>
                          <div style={{ width: 26, height: barH + "px", background: "var(--blue)", borderRadius: "6px 6px 0 0" }} />
                          {x.noShow > 0 && <div title={x.noShow + " не відбулось"} style={{ position: "absolute", bottom: barH + 2, width: 10, height: 10, borderRadius: "50%", background: "var(--red)" }} />}
                        </>); })()}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{WK_SHORT[i]}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <div style={card}>
                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Топ-5 процедур</div>
                    {topProcs.length === 0 ? <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Немає даних</div> : topProcs.map(([n, c], i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "6px 0", borderTop: i ? "1px solid var(--border)" : "none", fontSize: 13 }}>
                        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n}</span>
                        <b className="tabular" style={{ color: "var(--blue)" }}>{c}</b>
                      </div>
                    ))}
                  </div>
                  <div style={card}>
                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Завантаженість по апаратах</div>
                    {roomUtil.length === 0 ? <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Кабінетів немає</div> : roomUtil.map((r, i) => (
                      <div key={i} style={{ marginBottom: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
                          <span>{r.name} <span style={{ color: "var(--text-muted)" }}>{r.kind}</span></span>
                          <b className="tabular" style={{ color: r.color }}>{r.pct}%</b>
                        </div>
                        <div style={{ height: 6, background: "var(--bg-elevated)", borderRadius: 4 }}><div style={{ width: r.pct + "%", height: "100%", background: r.color, borderRadius: 4 }} /></div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "var(--card)", border: "1px solid var(--border-strong)", borderLeft: "4px solid var(--green)", borderRadius: 12, padding: "12px 18px", boxShadow: "var(--shadow-pop)", zIndex: 50, fontSize: 13.5 }}>{toast}</div>
      )}
    </div>
  );
}
