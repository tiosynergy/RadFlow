"use client";

/* ===== RadFlow — Колл-лист (окремий екран) =====
   Записи на завтра (або обраний день) → обдзвін/підтвердження. Статус пишеться у
   queue_entries.call_status (синхронно з дошкою), нотатка — у call_note. Realtime. */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import Sidebar from "@/components/Sidebar";
import RescheduleModal from "@/components/RescheduleModal";
import StudyEditModal from "@/components/StudyEditModal";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";

const WK = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"];
const MON_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
function fmtFull(d) { return WK[d.getDay()] + ", " + d.getDate() + " " + MON_GEN[d.getMonth()] + " " + d.getFullYear(); }
function dateKey(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function pad(n) { return String(n).padStart(2, "0"); }
function shortDate(d) { return pad(d.getDate()) + "." + pad(d.getMonth() + 1); }
function modalityLabel(m) { return m === "MRI" ? "МРТ" : m === "CT" ? "КТ" : "Інше"; }
function toMinHHMM(t) { const p = String(t || "").split(":"); return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); }
function incWindow(inc) {
  const s = new Date(inc.started_at);
  const startMin = s.getHours() * 60 + s.getMinutes();
  let endMin = 24 * 60;
  if (inc.blocked_until) { const e = new Date(inc.blocked_until); endMin = e.getHours() * 60 + e.getMinutes(); if (endMin <= startMin) endMin = 24 * 60; }
  return [startMin, endMin];
}
function studyKind(e) {
  const s = Array.isArray(e.studies) && e.studies[0] ? e.studies[0].type : null;
  return s || "МРТ";
}
function procLabel(e) {
  const s = Array.isArray(e.studies) ? e.studies : [];
  if (s.length) return s.map((x) => (x.type || "") + (x.region ? " · " + x.region : "") + (x.contrast ? " з контрастом" : "")).join(" + ");
  return e.note || "—";
}

const CL_META = {
  not_called: { label: "Ще не дзвонили", cls: "gray", icon: "○" },
  confirmed: { label: "Підтверджено", cls: "green", icon: "✓" },
  no_answer: { label: "Не відповідає", cls: "orange", icon: "✗" },
  to_recall: { label: "Передзвонити", cls: "blue", icon: "↩" },
  declined: { label: "Відмова", cls: "red", icon: "✕" },
};
const CALL_ORDER = { not_called: 0, to_recall: 1, no_answer: 2, confirmed: 3, declined: 4 };

function StatusBadge({ status }) {
  const m = CL_META[status || "not_called"];
  return <span className={"badge " + m.cls}>{m.icon} {m.label}</span>;
}

function CallRow({ p, roomName, dateShort, expanded, onToggle, onSet, onNote, onReschedule, onEditStudies }) {
  const type = studyKind(p);
  return (
    <div className={"clrow-wrap" + (expanded ? " open" : "")}>
      <div className={"clrow " + (p.call_status || "not_called")}>
        <button className="cl-exp-btn" onClick={() => onToggle(p.id)} title={expanded ? "Згорнути" : "Розгорнути"}>
          <span className={"cl-chev" + (expanded ? " open" : "")}>›</span>
        </button>
        <div className="cl-time tabular">{p.scheduled_time}<div className="cl-date">{dateShort}</div></div>
        <button className="cl-name cl-name-btn" onClick={() => onToggle(p.id)}>{p.patient_name}</button>
        <div><a className="tel" href={"tel:" + (p.patient_phone || "").replace(/\s/g, "")}>☎ {p.patient_phone}</a></div>
        <div className="cl-proc">{procLabel(p)}</div>
        <div className="cl-room">{roomName}</div>
        <div><StatusBadge status={p.call_status} /></div>
        <div>
          <input key={p.id + ":" + (p.call_note || "")} className="note-input" placeholder="Нотатка…" defaultValue={p.call_note || ""} onBlur={(e) => onNote(p.id, e.target.value)} />
        </div>
        <div className="cl-actions">
          {p.call_status === "confirmed" ? (
            <>
              <span className="q-done-lab">✓ Готово</span>
              <button className="mini-icon" title="Скасувати" onClick={() => onSet(p.id, "not_called")}>↩</button>
            </>
          ) : (
            <>
              <button className="btn btn-green btn-sm" title="Підтвердити" onClick={() => onSet(p.id, "confirmed")}>✓</button>
              <button className="mini-icon" title="Не відповідає" style={{ color: "var(--orange)" }} onClick={() => onSet(p.id, "no_answer")}>☏</button>
              <button className="mini-icon" title="Передзвонити" style={{ color: "#4da3ff" }} onClick={() => onSet(p.id, "to_recall")}>↩</button>
            </>
          )}
        </div>
      </div>
      {expanded && (
        <div className="cl-detail fade-in">
          <div className="cld-grid">
            <div className="cld-item cld-item-full"><span className="cld-lab">Пацієнт (ПІБ)</span><span className="cld-val cld-name">{p.patient_name}</span></div>
            <div className="cld-item"><span className="cld-lab">Кабінет</span><span className="cld-val">{roomName}</span></div>
            <div className="cld-item"><span className="cld-lab">Вік</span><span className="cld-val">{p.patient_age != null ? p.patient_age + " р." : "—"}</span></div>
            <div className="cld-item cld-item-full"><span className="cld-lab">Тип дослідження</span><span className="cld-val cld-val-wrap"><span className={"cld-type " + (type === "МРТ" ? "mrt" : "ct")}>{type}</span> {procLabel(p)}</span></div>
            <div className="cld-item"><span className="cld-lab">Телефон</span><span className="cld-val"><a className="tel" href={"tel:" + (p.patient_phone || "").replace(/\s/g, "")}>{p.patient_phone}</a></span></div>
            {p.doctor && <div className="cld-item"><span className="cld-lab">Направник</span><span className="cld-val">{p.doctor}</span></div>}
          </div>
          <div className="cld-actions">
            <span className="cld-lab">Дія:</span>
            <button className="btn btn-green btn-sm" onClick={() => onSet(p.id, "confirmed")}>✓ Підтвердити запис</button>
            <button className="btn btn-secondary btn-sm" onClick={() => onEditStudies(p)}>🩻 Дослідження</button>
            <button className="btn btn-primary btn-sm" onClick={() => onReschedule(p)}>🗓 Перенести на слот</button>
            <button className="btn btn-secondary btn-sm" style={{ color: "var(--orange)" }} onClick={() => onSet(p.id, "no_answer")}>☏ Не відповідає</button>
            <button className="btn btn-secondary btn-sm" style={{ color: "#4da3ff" }} onClick={() => onSet(p.id, "to_recall")}>↩ Передзвонити</button>
            <button className="btn btn-secondary btn-sm" style={{ color: "var(--red)" }} onClick={() => onSet(p.id, "declined")}>✕ Відмова</button>
          </div>
        </div>
      )}
    </div>
  );
}

function IncidentCallSection({ incident, roomName, affected, onReschedule, onRecall, onRefuse }) {
  const [openId, setOpenId] = useState(null);
  return (
    <div className="info-banner red cl-inc-sec" style={{ flexDirection: "column", alignItems: "stretch", borderColor: "var(--red)", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="ib-ic">🔧</span>
        <span className="ib-txt" style={{ flex: 1 }}>
          <b>{roomName} заблоковано</b> — {incident.reason_label || "Поломка"}{incident.note ? " · " + incident.note : ""}.{" "}
          {affected.length > 0
            ? <><b>{affected.length}</b> {affected.length === 1 ? "пацієнт потребує" : "пацієнтів потребують"} обдзвону на перезапис — дзвоніть прямо тут.</>
            : <>Усіх постраждалих опрацьовано ✓</>}
        </span>
      </div>
      {affected.length === 0 ? (
        <div className="cl-inc-empty">У вікні простою активних записів немає.</div>
      ) : (
        <div className="cl-inc-list">
          {affected.map((p) => {
            const isOpen = openId === p.id;
            return (
              <div className={"cl-inc-item" + (isOpen ? " open" : "")} key={p.id}>
                <button className="cl-inc-row" onClick={() => setOpenId((o) => (o === p.id ? null : p.id))}>
                  <span className={"cl-chev" + (isOpen ? " open" : "")}>›</span>
                  <span className="cl-inc-time tabular">{p.scheduled_time}</span>
                  <span className="cl-inc-name">{p.patient_name} · <span style={{ color: "var(--text-muted)" }}>{procLabel(p)}</span></span>
                </button>
                {isOpen && (
                  <div className="cl-inc-detail fade-in">
                    {p.patient_phone && <a className="btn btn-primary btn-sm" href={"tel:" + p.patient_phone.replace(/\s/g, "")}>☎ Подзвонити {p.patient_phone}</a>}
                    <div className="cld-actions" style={{ marginTop: 8 }}>
                      <button className="btn btn-primary btn-sm" onClick={() => onReschedule(p)}>🗓 Перенести на слот</button>
                      <button className="btn btn-secondary btn-sm" style={{ color: "#4da3ff" }} onClick={() => onRecall(p)}>↩ Передзвонити</button>
                      <button className="btn btn-secondary btn-sm" style={{ color: "var(--red)" }} onClick={() => onRefuse(p)}>✕ Відмова</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function CallListBoard({ clinicId, rooms, clinicName, adminName, adminRole, roleKey = "admin" }) {
  const tomorrow = useMemo(() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); return d; }, []);
  const [date, setDate] = useState(tomorrow);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const [reschedFor, setReschedFor] = useState(null);
  const [editStudiesFor, setEditStudiesFor] = useState(null);
  const [incidents, setIncidents] = useState([]);
  const [affectedToday, setAffectedToday] = useState([]);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const dayKey = dateKey(date);
  const roomsById = useMemo(() => { const m = {}; (rooms || []).forEach((r) => { m[r.id] = r; }); return m; }, [rooms]);

  function notify(msg, type = "success") {
    setToast({ msg, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  const reload = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("queue_entries")
      .select("id, patient_name, patient_phone, patient_age, scheduled_time, duration_min, status, call_status, call_note, studies, doctor, room_id, scheduled_date")
      .eq("clinic_id", clinicId)
      .eq("scheduled_date", dayKey)
      .in("status", ["scheduled", "waiting"])
      .order("scheduled_time", { ascending: true });
    setEntries(data || []);
    setLoading(false);
  }, [clinicId, dayKey]);

  const loadIncidents = useCallback(async () => {
    const supabase = createClient();
    const { data: incs } = await supabase
      .from("incidents")
      .select("id, room_id, reason_label, note, started_at, blocked_until, status")
      .eq("clinic_id", clinicId).in("status", ["active", "planned"]);
    setIncidents(incs || []);
    if (!incs || !incs.length) { setAffectedToday([]); return; }
    const todayKey = dateKey(new Date());
    const { data: ents } = await supabase
      .from("queue_entries")
      .select("id, patient_name, patient_phone, patient_age, scheduled_time, duration_min, status, call_status, studies, room_id, scheduled_date")
      .eq("clinic_id", clinicId).gte("scheduled_date", todayKey)
      .in("room_id", incs.map((i) => i.room_id)).in("status", ["scheduled", "waiting"]);
    const byRoom = {}; incs.forEach((i) => { byRoom[i.room_id] = i; });
    // Пострадавшие — за весь період блокування (вкл. майбутні дні), за повним datetime.
    const aff = (ents || []).filter((e) => {
      const inc = byRoom[e.room_id]; if (!inc || !e.scheduled_date || !e.scheduled_time) return false;
      const [h, m] = String(e.scheduled_time).split(":").map(Number);
      const [Y, Mo, D] = String(e.scheduled_date).split("-").map(Number);
      const dt = new Date(Y, (Mo || 1) - 1, D || 1, h || 0, m || 0).getTime();
      const start = new Date(inc.started_at).getTime();
      const end = inc.blocked_until ? new Date(inc.blocked_until).getTime() : Infinity;
      return dt >= start && dt < end;
    });
    setAffectedToday(aff);
  }, [clinicId]);

  useEffect(() => {
    setLoading(true);
    reload();
    loadIncidents();
    const supabase = createClient();
    const channel = supabase
      .channel("calllist-" + clinicId)
      .on("postgres_changes", { event: "*", schema: "public", table: "queue_entries", filter: "clinic_id=eq." + clinicId }, () => { reload(); loadIncidents(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "incidents", filter: "clinic_id=eq." + clinicId }, () => loadIncidents())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [clinicId, reload, loadIncidents]);

  async function cancelEntry(p) {
    const supabase = createClient();
    const { error } = await supabase.from("queue_entries").update({ status: "cancelled" }).eq("id", p.id);
    if (error) { notify("Помилка: " + error.message, "error"); return; }
    notify("Запис скасовано (відмова)", "success");
    reload(); loadIncidents();
  }

  async function setCall(id, call_status) {
    const supabase = createClient();
    // Відмова = скасування запису (як на дошці черги), інакше дані розходяться між екранами.
    const patch = call_status === "declined" ? { call_status, status: "cancelled" } : { call_status };
    const { error } = await supabase.from("queue_entries").update(patch).eq("id", id);
    if (error) { notify("Помилка: " + error.message, "error"); return; }
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, ...patch } : e)));
    if (call_status === "declined") notify("Пацієнт відмовився — запис скасовано", "info");
    reload();
  }
  async function setNote(id, call_note) {
    const supabase = createClient();
    await supabase.from("queue_entries").update({ call_note }).eq("id", id);
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, call_note } : e)));
  }
  async function confirmAll() {
    const supabase = createClient();
    const ids = entries.map((e) => e.id);
    if (!ids.length) return;
    await supabase.from("queue_entries").update({ call_status: "confirmed" }).in("id", ids);
    notify("Усіх пацієнтів підтверджено", "success");
    reload();
  }

  async function doReschedule({ roomId, date: d, time, dur }) {
    const p = reschedFor;
    if (!p) return;
    const supabase = createClient();
    const [hh, mm] = time.split(":").map(Number);
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm).toISOString();
    const { error } = await supabase.from("queue_entries").update({
      room_id: roomId, scheduled_date: dateKey(d), scheduled_time: time, scheduled_at: at, duration_min: dur, status: "scheduled", call_status: "confirmed",
    }).eq("id", p.id);
    setReschedFor(null);
    if (error) { notify(/incident/i.test(error.message) ? "Кабінет у простої — оберіть інший слот" : /overlap|exclusion/i.test(error.message) ? "Слот зайнятий — оберіть інший" : "Помилка переносу: " + error.message, "error"); return; }
    notify("Перенесено · підтверджено", "success");
    reload();
  }
  async function doEditStudies(arr, meta) {
    const p = editStudiesFor;
    if (!p) return;
    const supabase = createClient();
    const { error } = await supabase.from("queue_entries").update({ studies: arr, duration_min: (meta && meta.dur) || p.duration_min }).eq("id", p.id);
    setEditStudiesFor(null);
    if (error) { notify("Помилка: " + error.message, "error"); return; }
    notify("Дослідження оновлено", "success");
    reload();
  }

  function exportCsv() {
    const head = ["Час", "Пацієнт", "Телефон", "Процедура", "Кабінет", "Статус", "Нотатка"];
    const rows = entries.map((e) => [e.scheduled_time, e.patient_name, e.patient_phone || "", procLabel(e), (roomsById[e.room_id] || {}).name || "", (CL_META[e.call_status || "not_called"]).label, (e.call_note || "").replace(/[\n;]/g, " ")]);
    const csv = [head, ...rows].map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(";")).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "call-list-" + dayKey + ".csv"; a.click();
    URL.revokeObjectURL(url);
    notify("Колл-лист експортовано у CSV", "info");
  }

  const counts = { total: entries.length, not_called: 0, confirmed: 0, no_answer: 0, to_recall: 0, declined: 0 };
  entries.forEach((e) => { const s = e.call_status || "not_called"; if (counts[s] != null) counts[s]++; });
  const pct = (n) => (counts.total ? Math.round((n / counts.total) * 100) : 0);
  const stats = [
    { lab: "Всього записів", val: counts.total, pct: 100, color: "var(--text-faint)", cls: "" },
    { lab: "Підтверджено", val: counts.confirmed, pct: pct(counts.confirmed), color: "var(--green)", cls: "green" },
    { lab: "Не відповідає", val: counts.no_answer, pct: pct(counts.no_answer), color: "var(--orange)", cls: "orange" },
    { lab: "Передзвонити", val: counts.to_recall, pct: pct(counts.to_recall), color: "#4da3ff", cls: "blue" },
  ];
  const statColor = { "": "var(--text)", green: "var(--green)", orange: "var(--orange)", blue: "#4da3ff" };
  const tabs = [
    { key: "all", label: "Всі", ct: counts.total },
    { key: "not_called", label: "Ще не дзвонили", ct: counts.not_called },
    { key: "to_recall", label: "Передзвонити", ct: counts.to_recall },
    { key: "no_answer", label: "Не відповідає", ct: counts.no_answer },
    { key: "confirmed", label: "Підтверджено", ct: counts.confirmed },
  ];

  const filtered = entries.filter((p) => {
    if (filter !== "all" && (p.call_status || "not_called") !== filter) return false;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      if (!((p.patient_name || "").toLowerCase().includes(q) || (p.patient_phone || "").includes(q) || procLabel(p).toLowerCase().includes(q))) return false;
    }
    return true;
  }).sort((a, b) => {
    const pa = CALL_ORDER[a.call_status || "not_called"] ?? 9, pb = CALL_ORDER[b.call_status || "not_called"] ?? 9;
    if (pa !== pb) return pa - pb;
    return String(a.scheduled_time).localeCompare(String(b.scheduled_time));
  });

  return (
    <div className="app">
      <Sidebar clinicName={clinicName} adminName={adminName} adminRole={adminRole} roleKey={roleKey} rooms={rooms} activeNav="calls" />
      <div className="main">
        <header className="topbar">
          <div className="tb-title">
            <span className="tic">☎</span>
            <div>
              <h1>Колл-лист</h1>
              <div className="date">Записи на {fmtFull(date)}</div>
            </div>
          </div>
          <div className="tb-right">
            <input className="inp tabular" type="date" value={dayKey} onChange={(e) => { const [y, m, d] = e.target.value.split("-").map(Number); setDate(new Date(y, m - 1, d)); }} style={{ width: 150 }} />
            <button className="btn btn-secondary" onClick={exportCsv}>↧ Експорт</button>
            <button className="btn btn-primary" onClick={confirmAll}>✓ Всіх підтверджено</button>
          </div>
        </header>
        <div className="content-full">
          <div className="page-max">
            {incidents.map((inc) => (
              <IncidentCallSection key={inc.id} incident={inc}
                roomName={(roomsById[inc.room_id] || {}).name || "Апарат"}
                affected={affectedToday.filter((a) => a.room_id === inc.room_id)}
                onReschedule={(p) => setReschedFor(p)}
                onRecall={(p) => setCall(p.id, "to_recall")}
                onRefuse={(p) => cancelEntry(p)} />
            ))}
            <div className="info-banner">
              <span className="ib-ic">🤖</span>
              <span className="ib-txt"><b>Обдзвін напередодні</b> — зателефонуйте кожному пацієнту, що записаний на цей день, і зафіксуйте статус. Статус миттєво синхронізується з чергою.</span>
            </div>

            <div className="cl-stats">
              {stats.map((s) => (
                <div className="cl-stat" key={s.lab}>
                  <div className="lab">{s.lab}</div>
                  <div className="val tabular" style={{ color: statColor[s.cls] }}>{s.val}</div>
                  <div className="mini-bar"><div className="mini-fill" style={{ width: s.pct + "%", background: s.color }} /></div>
                </div>
              ))}
            </div>

            <div className="qctrl">
              <div className="pills">
                {tabs.map((t) => (
                  <button key={t.key} className={"pill" + (filter === t.key ? " active" : "")} onClick={() => setFilter(t.key)}>
                    {t.label}<span className="ct">({t.ct})</span>
                  </button>
                ))}
              </div>
              <div className="spacer" />
              <div className="search"><span className="si">⌕</span>
                <input placeholder="Пошук…" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
            </div>

            <div className="clhead">
              <div /><div>Час</div><div>Пацієнт</div><div>Телефон</div><div>Процедура</div>
              <div>Кабінет</div><div>Статус</div><div>Нотатка</div><div style={{ textAlign: "right" }}>Дії</div>
            </div>
            {loading ? (
              <div className="empty"><div className="et">Завантаження…</div></div>
            ) : filtered.length === 0 ? (
              <div className="empty"><div className="ei">☎</div><div className="et">Немає записів</div><div className="es">{entries.length === 0 ? "На цей день записів немає" : "Змініть фільтр або пошук"}</div></div>
            ) : (
              <div className="clrows">
                {filtered.map((p) => (
                  <CallRow key={p.id} p={p} roomName={(roomsById[p.room_id] || {}).name || "—"} dateShort={shortDate(date)}
                    expanded={expandedId === p.id} onToggle={(id) => setExpandedId((x) => (x === id ? null : id))}
                    onSet={setCall} onNote={setNote} onReschedule={(pt) => setReschedFor(pt)} onEditStudies={(pt) => setEditStudiesFor(pt)} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {reschedFor && (
        <RescheduleModal patient={reschedFor} rooms={rooms} clinicId={clinicId} incidents={incidents} onClose={() => setReschedFor(null)} onConfirm={doReschedule} />
      )}
      {editStudiesFor && (
        <StudyEditModal patient={editStudiesFor} scheduledDate={dayKey} rooms={rooms} onClose={() => setEditStudiesFor(null)} onConfirm={doEditStudies} />
      )}

      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "var(--card)", border: "1px solid var(--border-strong)", borderLeft: "4px solid " + (toast.type === "error" ? "var(--red)" : "var(--green)"), borderRadius: 12, padding: "12px 18px", boxShadow: "var(--shadow-pop)", zIndex: 50, fontSize: 13.5 }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
