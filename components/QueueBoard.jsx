"use client";

/* ===== RadFlow — Дошка черги (повна) =====
   Портовано з queue-app.jsx + queue-components.jsx на реальні дані Supabase.
   Включає: картки кабінетів з живим таймером, статистику-фільтр, розгортувані
   рядки черги з діями за статусом, міні-календар (навігація по днях), realtime.
   Поки не портовано (окремі модулі): колл-лист, інциденти/поломки, перенесення,
   симуляція, редактор досліджень. */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import Sidebar from "@/components/Sidebar";
import BookingModal from "@/components/BookingModal";
import CompletionModal from "@/components/CompletionModal";
import RescheduleModal from "@/components/RescheduleModal";
import StudyEditModal from "@/components/StudyEditModal";
import BreakdownModal from "@/components/BreakdownModal";
import ScheduleEditModal from "@/components/ScheduleEditModal";
import { roomScheduleFor, dayStatus } from "@/lib/schedule";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";

/* ── Дати ── */
const WK = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"];
const WK_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
const MON_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
const MON_NOM = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function today0() { return startOfDay(new Date()); }
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function dowMon(d) { return (d.getDay() + 6) % 7; }
function fmtFull(d) { return WK[d.getDay()] + ", " + d.getDate() + " " + MON_GEN[d.getMonth()] + " " + d.getFullYear(); }
function fmtShort(d) { return d.getDate() + " " + MON_GEN[d.getMonth()]; }
function dateKey(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }

/* ── Статуси (enum БД ↔ прототип) ── */
const ST = {
  scheduled:   { label: "В черзі",      cls: "gray" },
  waiting:     { label: "Очікує",       cls: "yellow" },
  in_progress: { label: "В кабінеті",   cls: "blue", dot: true },
  done:        { label: "Виконано",     cls: "green" },
  no_show:     { label: "Не відбулось", cls: "red" },
};
const FLOW = { in_progress: 0, waiting: 1, scheduled: 2, done: 3, no_show: 4 };
const STAT_ITEMS = [
  { key: "all", lab: "Всього сьогодні", sub: "записів", cls: "white" },
  { key: "scheduled", lab: "В черзі", sub: "записані", cls: "gray" },
  { key: "waiting", lab: "Очікують", sub: "прийшли", cls: "yellow" },
  { key: "in_progress", lab: "В кабінеті", sub: "зараз", cls: "blue" },
  { key: "done", lab: "Виконано", sub: "процедур", cls: "green" },
  { key: "no_show", lab: "Не відбулось", sub: "неявка", cls: "red" },
];

function modalityLabel(m) { return m === "MRI" ? "МРТ" : m === "CT" ? "КТ" : "Інше"; }
function procLabel(e) {
  const s = Array.isArray(e.studies) ? e.studies : [];
  if (s.length) return s.map((x) => (x.type || "") + (x.region ? " · " + x.region : "") + (x.contrast ? " з контрастом" : "")).join(" + ");
  return e.note || "—";
}
function fmtTimer(sec) {
  const m = Math.floor(sec / 60), s = sec % 60, h = Math.floor(m / 60);
  if (h) return h + ":" + String(m % 60).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  return m + ":" + String(s).padStart(2, "0");
}
function toMinHHMM(t) { const p = String(t || "").split(":"); return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); }
function incWindow(inc) {
  const s = new Date(inc.started_at);
  const startMin = s.getHours() * 60 + s.getMinutes();
  let endMin = 24 * 60;
  if (inc.blocked_until) { const e = new Date(inc.blocked_until); endMin = e.getHours() * 60 + e.getMinutes(); if (endMin <= startMin) endMin = 24 * 60; }
  return [startMin, endMin];
}

/* ── Живий таймер ── */
function LiveTimer({ enteredAt, children }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const sec = enteredAt ? Math.max(0, Math.floor((now - new Date(enteredAt).getTime()) / 1000)) : 0;
  return children(sec);
}

/* ── StatsBar ── */
function StatsBar({ counts, filter, setFilter }) {
  return (
    <div className="stats">
      {STAT_ITEMS.map((s) => (
        <div key={s.key}
          className={"stat clickable" + (filter === s.key ? " active" : "")}
          role="button" tabIndex={0}
          onClick={() => setFilter(s.key)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFilter(s.key); } }}>
          <div className="lab">{s.lab}</div>
          <div className={"val tabular " + s.cls}>{s.key === "all" ? counts.total : counts[s.key]}</div>
          <div className="sub">{s.sub}</div>
        </div>
      ))}
    </div>
  );
}

/* ── Картка кабінету ── */
function RoomStatusCard({ room, patient, enteredAt, nextWaiting, blocked, schedClosed, onComplete, onCall, onUnblock }) {
  const kind = modalityLabel(room.modality);
  if (!blocked && schedClosed) {
    return (
      <div className="room-card blocked-card">
        <div className="rc-head">
          <span className={"equip-tile " + (room.modality === "MRI" ? "mrt" : "ct")}>{kind}</span>
          <div className="rc-h-meta">
            <div className="rc-name">{room.name}</div>
            <div className="rc-model">{room.apparatus_model || ""}</div>
          </div>
          <span className="badge red">🚫 Зачинено</span>
        </div>
        <div className="rc-body">
          <div className="rc-blocked-reason">🗓 {typeof schedClosed === "string" ? schedClosed : "Не працює за графіком"}</div>
          <div className="rc-foot"><span className="rc-blocked-hint">Виклики недоступні цього дня</span></div>
        </div>
      </div>
    );
  }
  if (blocked) {
    return (
      <div className="room-card blocked-card">
        <div className="rc-head">
          <span className={"equip-tile " + (room.modality === "MRI" ? "mrt" : "ct")}>{kind}</span>
          <div className="rc-h-meta">
            <div className="rc-name">{room.name}</div>
            <div className="rc-model">{room.apparatus_model || ""}</div>
          </div>
          <span className="badge red">🔒 Заблоковано</span>
        </div>
        <div className="rc-body">
          <div className="rc-blocked-reason">🔧 {blocked.reason_label || "Поломка"}{blocked.note ? " · " + blocked.note : ""}</div>
          <div className="rc-foot">
            <span className="rc-blocked-hint">Нові виклики призупинено</span>
            <button className="btn btn-green btn-sm" onClick={() => onUnblock(blocked)}>🔓 Розблокувати</button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className={"room-card " + (patient ? "busy" : "free")}>
      <div className="rc-head">
        <span className={"equip-tile " + (room.modality === "MRI" ? "mrt" : "ct")}>{kind}</span>
        <div className="rc-h-meta">
          <div className="rc-name">{room.name}</div>
          <div className="rc-model">{room.apparatus_model || ""}</div>
        </div>
      </div>
      {patient ? (
        <div className="rc-body rc-body-busy">
          <div className="rc-brow">
            <span className="rc-pat"><span className="pulse-dot" />{patient.patient_name}</span>
            <LiveTimer enteredAt={enteredAt}>{(sec) => {
              const over = sec > (patient.duration_min || 30) * 60;
              return <span className={"rc-timer tabular" + (over ? " over" : "")} title={over ? "Час перевищено" : "Зараз в кабінеті"}>{fmtTimer(sec)}</span>;
            }}</LiveTimer>
          </div>
          <div className="rc-brow">
            <span className="rc-proc" title={procLabel(patient)}>{procLabel(patient)} · {patient.duration_min} хв · {patient.scheduled_time}</span>
            <button className="btn btn-green btn-sm" onClick={() => onComplete(patient)}>✓ Завершити</button>
          </div>
        </div>
      ) : (
        <div className="rc-body empty">
          <div className="rc-free-row"><span className="rc-free-dot" /><span className="rc-free">Кабінет вільний</span></div>
          {nextWaiting && (
            <button className="btn btn-primary btn-sm" onClick={() => onCall(nextWaiting)}>
              Викликати: {nextWaiting.patient_name.split(" ").slice(0, 2).join(" ")} · {nextWaiting.scheduled_time}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Одиночний вид кабінету (поточний пацієнт) ── */
function CurrentCard({ patient, roomName, roomModel, enteredAt, nextWaiting, onCall, onComplete, onReschedule }) {
  if (!patient) {
    return (
      <div className="current" style={{ background: "var(--border)", boxShadow: "none" }}>
        <div className="current-inner" style={{ background: "var(--card)", padding: "22px 24px", gap: 18 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-secondary)" }}>{roomName} вільний</div>
            <div style={{ fontSize: 13, marginTop: 4, color: "var(--text-muted)" }}>
              {nextWaiting ? "Наступний у черзі: " + nextWaiting.patient_name + " · " + nextWaiting.scheduled_time : "Немає пацієнтів у черзі"}
            </div>
          </div>
          {nextWaiting && <button className="btn btn-primary" onClick={() => onCall(nextWaiting)} style={{ flexShrink: 0 }}>Викликати наступного</button>}
        </div>
      </div>
    );
  }
  return (
    <div className="current">
      <div className="current-inner">
        <div className="cur-main">
          <div className="cur-tag"><span className="pulse-dot" />Зараз в кабінеті — {roomName}</div>
          <div className="cur-name">{patient.patient_name}</div>
          <div className="cur-proc">{procLabel(patient)} · {patient.duration