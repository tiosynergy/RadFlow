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
import { needsClarification, CLARIFY_META } from "@/lib/queueStatus";
import { diffStudies, studyText } from "@/lib/studies";
import { incidentEffectiveEnd, incidentExpired, incidentAwaitingManualUnblock } from "@/lib/incidents";
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
  no_show:     { label: "Неявка",       cls: "red" },
  not_held:    { label: "Не відбулося", cls: "orange" },
  cancelled:   { label: "Скасовано",    cls: "gray" },
};
const FLOW = { in_progress: 0, waiting: 1, scheduled: 2, done: 3, not_held: 4, no_show: 5 };
const STAT_ITEMS = [
  { key: "all", lab: "Всього сьогодні", sub: "записів", cls: "white" },
  { key: "scheduled", lab: "В черзі", sub: "записані", cls: "gray" },
  { key: "waiting", lab: "Очікують", sub: "прийшли", cls: "yellow" },
  { key: "in_progress", lab: "В кабінеті", sub: "зараз", cls: "blue" },
  { key: "done", lab: "Виконано", sub: "процедур", cls: "green" },
  { key: "not_held", lab: "Не відбулося", sub: "не відбулось", cls: "orange" },
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
// Чи запис (день + час) потрапляє в період блокування інциденту (працює і для багатоденних простоїв).
function entryInIncidentWindow(scheduledTime, dayDate, inc) {
  if (!inc || !scheduledTime || !dayDate) return false;
  const [h, m] = String(scheduledTime).split(":").map(Number);
  const dt = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), h || 0, m || 0).getTime();
  const start = new Date(inc.started_at).getTime();
  return dt >= start && dt < incidentEffectiveEnd(inc);
}
// Чи день потрапляє в період блокування (для банера на потрібні дні).
function incidentCoversDay(inc, dayDate) {
  if (!inc || !dayDate) return false;
  const dayStart = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate()).getTime();
  const dayEnd = dayStart + 24 * 3600e3;
  const start = new Date(inc.started_at).getTime();
  return start < dayEnd && dayStart < incidentEffectiveEnd(inc);
}
function incWindow(inc) {
  const s = new Date(inc.started_at);
  const startMin = s.getHours() * 60 + s.getMinutes();
  let endMin = 24 * 60;
  if (inc.blocked_until) { const e = new Date(inc.blocked_until); endMin = e.getHours() * 60 + e.getMinutes(); if (endMin <= startMin) endMin = 24 * 60; }
  return [startMin, endMin];
}

/* Момент входу в кабінет: окрема мітка in_progress_at; для старих рядків — updated_at. */
function enteredAtOf(e) { return e ? (e.in_progress_at || e.updated_at) : null; }

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
              Викликати: {(nextWaiting.patient_name || "").split(" ").slice(0, 2).join(" ")} · {nextWaiting.scheduled_time}
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
          <div className="cur-proc">{procLabel(patient)} · {patient.duration_min} хв</div>
          <div className="cur-meta">
            <span className="mi"><b>Час:</b> {patient.scheduled_time}</span>
            <span className="mi"><b>Кабінет:</b> {roomName}{roomModel ? " (" + roomModel + ")" : ""}</span>
            {patient.patient_age != null && <span className="mi"><b>Вік:</b> {patient.patient_age} р.</span>}
            {patient.patient_phone && <span className="mi"><b>Тел:</b> {patient.patient_phone}</span>}
          </div>
        </div>
        <div className="cur-timer">
          <LiveTimer enteredAt={enteredAt}>{(sec) => {
            const over = sec > (patient.duration_min || 30) * 60;
            return (<>
              <div className="t tabular" style={over ? { color: "var(--orange)" } : null}>{fmtTimer(sec)}</div>
              <div className="tl">{over ? "перевищено час" : "хв у кабінеті"}</div>
            </>);
          }}</LiveTimer>
        </div>
        <div className="cur-actions">
          <button className="btn btn-green" onClick={() => onComplete(patient)}>✓ Завершити процедуру</button>
          {onReschedule && <button className="btn btn-secondary btn-sm" onClick={() => onReschedule(patient)} style={{ justifyContent: "center" }}>🗓 Перенести</button>}
        </div>
      </div>
    </div>
  );
}

/* ── Завантаженість кабінетів (права панель) ── */
// Перетин вікна простою з робочим вікном дня (у хвилинах від початку дня), або 0.
function incidentWorkMinutes(inc, date, startMin, endMin) {
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const s = new Date(inc.started_at).getTime();
  const e = inc.blocked_until ? new Date(inc.blocked_until).getTime() : dayStart + 24 * 3600e3;
  const sMin = Math.max(startMin, Math.round((s - dayStart) / 60000));
  const eMin = Math.min(endMin, Math.round((e - dayStart) / 60000));
  return Math.max(0, eMin - sMin);
}
// Ємність дня = робоче вікно графіка кабінету мінус простої; закритий день → 0.
function computeRoomLoad(rooms, entries, date, override, incidents) {
  return (rooms || []).map((r) => {
    const sched = roomScheduleFor(date, r.id, override);
    const startMin = toMinHHMM(sched.start), endMin = toMinHHMM(sched.end);
    let cap = sched.closed ? 0 : Math.max(0, endMin - startMin);
    if (cap > 0) {
      (incidents || []).filter((i) => i.room_id === r.id).forEach((i) => { cap -= incidentWorkMinutes(i, date, startMin, endMin); });
      cap = Math.max(0, cap);
    }
    const mins = entries.filter((e) => e.room_id === r.id && e.status !== "no_show" && e.status !== "cancelled" && e.status !== "not_held").reduce((s, e) => s + (e.duration_min || 0), 0);
    const pct = cap > 0 ? Math.min(100, Math.round((mins / cap) * 100)) : 0;
    return { roomKey: r.id, name: r.name, kind: modalityLabel(r.modality), pct, closed: sched.closed, color: r.modality === "MRI" ? "var(--blue)" : "var(--orange)" };
  });
}
function RoomLoad({ rooms, onSelectRoom }) {
  const [open, setOpen] = useState(true);
  const avg = rooms.length ? Math.round(rooms.reduce((s, r) => s + r.pct, 0) / rooms.length) : 0;
  return (
    <div className="rcard">
      <button className={"rcard-toggle" + (open ? " open" : "")} onClick={() => setOpen((o) => !o)}>
        <span className="rct-title">Завантаженість кабінетів</span>
        <span className="rct-sum">{rooms.length} · сер. {avg}%</span>
        <span className="rct-chev">⌄</span>
      </button>
      {open && (
        <div className="load-body">
          {rooms.map((r) => (
            <button type="button" className="load-row load-row-link" key={r.roomKey}
              onClick={() => onSelectRoom && onSelectRoom(r.roomKey)} title={"Відкрити чергу: " + r.name}
              style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer" }}>
              <div className="load-top">
                <span className="load-name">{r.name} {r.kind} <span className="load-go" aria-hidden>→</span></span>
                <span className="load-pct" style={{ color: r.color }}>{r.pct}%</span>
              </div>
              <div className="load-bar"><div className="load-fill" style={{ width: r.pct + "%", background: r.color }} /></div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Рядок черги ── */
const CALL_META = {
  confirmed:  { label: "Підтверджено", cls: "green", icon: "✓" },
  to_recall:  { label: "Передзвонити", cls: "blue", icon: "↻" },
  no_answer:  { label: "Не відповідає", cls: "orange", icon: "…" },
  declined:   { label: "Відмова", cls: "red", icon: "✕" },
  not_called: { label: "Не дзвонили", cls: "gray", icon: "○" },
};

/* Прогрес-крок статусу: happy-path 4 кроки (scheduled→waiting→in_progress→done).
   Пройдені — з ✓, поточний підсвічено; клік по кроку = виправлення статусу. */
const STEP_ORDER = ["scheduled", "waiting", "in_progress", "done"];
const STEP_META = {
  scheduled:   { label: "В черзі",    color: "#aeaeb2" },
  waiting:     { label: "Очікує",     color: "#ffd60a" },
  in_progress: { label: "В кабінеті", color: "#4da3ff" },
  done:        { label: "Виконано",   color: "#30d158" },
};
const STEP_PRIMARY = {
  scheduled:   { icon: "✓", label: "Пацієнт прийшов",      bg: "var(--blue)",  color: "#fff" },
  waiting:     { icon: "▶", label: "Викликати в кабінет",  bg: "var(--blue)",  color: "#fff" },
  in_progress: { icon: "✓", label: "Завершити процедуру",  bg: "var(--green)", color: "#04210d" },
  done:        { icon: "✓", label: "Дослідження виконано", bg: "var(--card)",  color: "var(--text-faint)" },
};
const CALL_SEG_ORDER = ["not_called", "confirmed", "to_recall", "no_answer", "declined"];
const CALL_SEG_STYLE = {
  not_called: { color: "var(--text-secondary)", bg: "var(--gray-badge-bg)" },
  confirmed:  { color: "var(--green)",     bg: "var(--green-bg)" },
  to_recall:  { color: "var(--blue-text)", bg: "var(--blue-bg)" },
  no_answer:  { color: "var(--orange)",    bg: "var(--orange-bg)" },
  declined:   { color: "var(--red)",       bg: "var(--red-bg)" },
};

function QueueRow({ p, dayDate, roomName, roomKind, expanded, onToggle, readOnly, canCall, rescheduling, onArrive, onCall, onComplete, onNoShow, onNotHeld, onUndo, onCancel, onSetStatus, onSetCall, onReschedule, onEditStudies }) {
  const overdue = needsClarification(p.status, dayDate, p.scheduled_time);
  const meta = overdue ? CLARIFY_META : (ST[p.status] || ST.scheduled);
  const dateStr = dayDate ? String(dayDate.getDate()).padStart(2, "0") + "." + String(dayDate.getMonth() + 1).padStart(2, "0") + "." + dayDate.getFullYear() : "";
  const isTodayRow = dayDate ? sameDay(dayDate, today0()) : true;
  const isFutureRow = dayDate ? (!isTodayRow && dayDate > today0()) : false;
  const canSetStatus = !isFutureRow; // статус/дзвінок можна уточнювати в день запису і для минулих (архівних) днів; для майбутніх — ні
  const [moreOpen, setMoreOpen] = useState(false);
  const proc = procLabel(p);
  const act = (fn) => (e) => { e.stopPropagation(); fn(p); };
  return (
    <div className={"qrow-item " + p.status + (expanded ? " open" : "")} data-qrow={p.id}>
      <div className="qrow" role="button" tabIndex={0} onClick={() => onToggle(p.id)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(p.id); } }}>
        <div className="q-time tabular">{p.scheduled_time}<div className="td">{p.duration_min} хв</div><div className="td" style={{ marginTop: 2, color: "var(--text-muted)" }}>{dateStr}</div></div>
        <div className="q-pat">
          <div className="nm">{p.cito && (p.status === "scheduled" || p.status === "waiting" || p.status === "in_progress") && <span className="cito-tag">CITO</span>}{p.patient_name}</div>
          <div className="det" style={{ display: "flex", flexDirection: "column", gap: 1, whiteSpace: "normal" }}>
            {p.patient_phone && <span style={{ whiteSpace: "nowrap" }}>Тел. {p.patient_phone}</span>}
            {(p.patient_age != null || p.patient_weight != null) && <span>{[p.patient_age != null ? p.patient_age + " р." : null, p.patient_weight != null ? p.patient_weight + " кг" : null].filter(Boolean).join(", ")}</span>}
            {p.doctor && <span>Напр.: {p.doctor}</span>}
          </div>
        </div>
        <div className="q-proc">
          <div className="pp">{proc}</div>
          <div className="du">{roomKind}</div>
        </div>
        <div className="q-room" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3 }}>
          {(() => {
            const km = (Array.isArray(p.studies) && p.studies[0] && p.studies[0].type) || ((roomKind === "МРТ" || roomKind === "КТ") ? roomKind : "");
            if (!km) return null;
            const isCt = km === "КТ";
            return <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 5, lineHeight: 1.4, background: isCt ? "var(--orange-bg)" : "var(--blue-bg)", color: isCt ? "var(--orange)" : "#4da3ff" }}>{km}</span>;
          })()}
          <b>{roomName}</b>
        </div>
        <div className="q-status-cell">
          <span className={"badge " + meta.cls} title={meta.title}>{meta.dot && <span className="pulse-dot" style={{ width: 6, height: 6 }} />}{meta.label}</span>
          {rescheduling && <span className="badge red" title="Апарат заблоковано — потрібен перенос на інший слот">🔧 Перезапис</span>}
        </div>
        <span className={"q-chev" + (expanded ? " open" : "")} aria-hidden>›</span>
      </div>

      <div className="qrow-detail-wrap">
        <div className="qrow-detail-inner">
          <div className="qrow-detail">
            {Array.isArray(p.studies) && p.studies.length > 0 && (() => {
              const sdiff = diffStudies(p.studies_original, p.studies);
              const changed = sdiff.some((d) => d.state !== "kept");
              return (
                <div style={{ marginBottom: 8 }}>
                  <div className="qd-sf-lab" style={{ marginBottom: 6 }}>{p.studies.length > 1 ? "Дослідження (" + p.studies.length + ")" : "Дослідження"}{changed && <span style={{ color: "var(--orange)", fontWeight: 400 }}> · змінено</span>}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 13 }}>
                    {sdiff.map((d, i) => (
                      <div key={i} style={{ color: d.state === "added" ? "var(--green)" : d.state === "removed" ? "var(--red)" : "var(--text-secondary)", textDecoration: d.state === "removed" ? "line-through" : "none" }}>
                        {d.state === "added" ? "＋ " : d.state === "removed" ? "－ " : ""}{studyText(d.s)}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
            {(p.contraindications || p.note) && (
              <div className="qd-info" style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, marginBottom: 4 }}>
                {p.contraindications && <span style={{ color: "var(--red)", fontWeight: 600 }}>⚠ Протипоказання</span>}
                {p.note && <span style={{ color: "var(--text-muted)" }}>Примітка: {p.note}</span>}
              </div>
            )}

            {!readOnly && (() => {
              const stepIdx = STEP_ORDER.indexOf(p.status);
              const pb = STEP_PRIMARY[p.status] || STEP_PRIMARY.done;
              const advanceFn = p.status === "scheduled" ? onArrive : p.status === "waiting" ? onCall : p.status === "in_progress" ? onComplete : null;
              const advanceDisabled = !advanceFn || (p.status === "waiting" && !canCall) || !isTodayRow;
              const terminal = p.status === "done" || p.status === "no_show" || p.status === "not_held";
              return (
                <div className="qd-step">
                  {/* Прогрес-крок: пройдені ✓, поточний підсвічено, клік по кроку = виправлення статусу */}
                  <div style={{ position: "relative", padding: "14px 32px 4px" }}>
                    <div style={{ position: "absolute", top: 29, left: 56, right: 56, height: 2, background: "var(--border)" }} />
                    <div style={{ position: "relative", display: "flex", justifyContent: "space-between" }}>
                      {STEP_ORDER.map((key, i) => {
                        const isDone = stepIdx >= 0 && i < stepIdx;
                        const isCur = i === stepIdx;
                        const m = STEP_META[key];
                        return (
                          <div key={key} style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 72 }}>
                            <button onClick={canSetStatus ? act(() => onSetStatus(p, key)) : undefined} disabled={!canSetStatus} title={canSetStatus ? "Встановити статус: " + m.label : "Майбутній запис — статус зміните в день запису"}
                              style={{ width: 30, height: 30, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, fontVariantNumeric: "tabular-nums", cursor: canSetStatus ? "pointer" : "default",
                                background: isDone ? "var(--green)" : (isCur ? m.color : "transparent"),
                                border: "1.5px solid " + ((isDone || isCur) ? "transparent" : "var(--border-strong)"),
                                color: isDone ? "#04210d" : (isCur ? "#1c1c1e" : "var(--text-faint)") }}>
                              {isDone ? "✓" : i + 1}
                            </button>
                            <span style={{ marginTop: 8, fontSize: 12, textAlign: "center", color: isCur ? "var(--text)" : (isDone ? "var(--text-secondary)" : "var(--text-faint)"), fontWeight: isCur ? 700 : 400 }}>{m.label}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Основна дія — рух на наступний крок */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0" }}>
                    {(p.status === "no_show" || p.status === "not_held") ? (
                      <>
                        <span className="q-noshow-lab" style={{ flex: 1 }}>✕ {p.status === "not_held" ? "Не відбулося" : "Неявка"}</span>
                        <button className="btn btn-secondary btn-sm" onClick={act(onUndo)}>↩ Повернути в чергу</button>
                      </>
                    ) : (
                      <>
                        <button onClick={advanceDisabled ? undefined : act(advanceFn)} disabled={advanceDisabled}
                          title={!isTodayRow ? "Дія доступна в день запису" : (p.status === "waiting" && !canCall ? "Кабінет зайнятий — спершу завершіть поточного пацієнта" : "")}
                          style={{ flex: 8, minWidth: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "9px 8px", borderRadius: 10, fontSize: 13.5, fontWeight: 600, border: "none", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                            cursor: advanceDisabled ? "default" : "pointer", opacity: (advanceDisabled && p.status !== "done") ? 0.55 : 1, background: pb.bg, color: pb.color }}>
                          {pb.icon} {pb.label}
                        </button>
                        {!terminal && onEditStudies && <button className="btn btn-secondary btn-sm" style={{ flex: 4, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} onClick={act(onEditStudies)}>🩻 Редагувати дослідження</button>}
                        {!terminal && <button className="btn btn-secondary btn-sm" style={{ flex: 2, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} onClick={act(onReschedule)} title="Перенести на слот">🗓 Перенести</button>}
                        <button className="btn btn-secondary btn-sm" style={{ flex: 1, minWidth: 0 }} onClick={(e) => { e.stopPropagation(); setMoreOpen((o) => !o); }} title="Більше дій">⋯</button>
                      </>
                    )}
                  </div>

                  {moreOpen && !terminal && (
                    <div style={{ display: "flex", gap: 6, padding: "2px 0 6px", flexWrap: "wrap" }}>
                      <button className="btn btn-secondary btn-sm qd-act-red" onClick={act(onNoShow)}>✕ Неявка</button>
                      <button className="btn btn-secondary btn-sm qd-act-red" onClick={act(onNotHeld)}>✕ Не відбулося</button>
                      <button className="btn btn-secondary btn-sm qd-act-red" onClick={act(onCancel)}>✕ Скасувати запис</button>
                    </div>
                  )}

                  {/* Дзвінок-підтвердження — один сегментований перемикач, завжди видно поточне значення */}
                  {onSetCall && !terminal && (
                    <div style={{ marginTop: 6 }}>
                      <div className="qd-sf-lab" style={{ marginBottom: 8 }}>Дзвінок-підтвердження</div>
                      <div style={{ display: "flex", background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 10, padding: 3, gap: 2 }}>
                        {CALL_SEG_ORDER.map((key) => {
                          const cm = CALL_META[key]; const cs = CALL_SEG_STYLE[key];
                          const active = (p.call_status || "not_called") === key;
                          return (
                            <button key={key} onClick={act(() => onSetCall(p, key))}
                              style={{ flex: 1, textAlign: "center", padding: "8px 4px", borderRadius: 8, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap", border: "none",
                                background: active ? cs.bg : "transparent", color: active ? cs.color : "var(--text-muted)", fontWeight: active ? 600 : 400 }}>
                              {cm.icon} {cm.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Колл-лист (підтвердження) ── */
function CallListPanel({ entries, onSetCall, dateLabel }) {
  const list = entries.filter((e) => ["not_called", "to_recall", "no_answer"].includes(e.call_status || "not_called") && (e.status === "scheduled" || e.status === "waiting"));
  return (
    <div className="rcard">
      <div className="rcard-toggle open" style={{ cursor: "default" }}>
        <span className="rct-title">Обдзвін — підтвердження{dateLabel ? " · " + dateLabel : ""}</span>
        <span className="rct-sum">{list.length}</span>
      </div>
      <div className="load-body">
        {list.length === 0 ? (
          <div style={{ padding: "8px 4px", fontSize: 12.5, color: "var(--text-muted)" }}>Усіх підтверджено ✓</div>
        ) : list.map((e) => {
          const cm = CALL_META[e.call_status || "not_called"];
          return (
            <div key={e.id} style={{ padding: "8px 0", borderTop: "1px solid var(--border)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.patient_name}</span>
                <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>{e.scheduled_time}</span>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text-muted)", margin: "2px 0 4px" }}>{procLabel(e)}</div>
              {e.patient_phone && <a href={"tel:" + e.patient_phone.replace(/\s/g, "")} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12.5, marginBottom: 6, whiteSpace: "nowrap", color: "#4da3ff", textDecoration: "none" }}>☎ {e.patient_phone}</a>}
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <span className={"qd-call " + cm.cls} style={{ fontSize: 11 }}>{cm.icon} {cm.label}</span>
                <button className="btn btn-green btn-xs" onClick={() => onSetCall(e, "confirmed")} title="Підтверджено">✓</button>
                <button className="btn btn-secondary btn-xs" onClick={() => onSetCall(e, "to_recall")} title="Передзвонити">↻</button>
                <button className="btn btn-secondary btn-xs" onClick={() => onSetCall(e, "no_answer")} title="Не відповідає">…</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Обдзвін через простій (постраждалі від поломки) ── */
function AffectedPanel({ affected, roomsById, onReschedule }) {
  if (!affected.length) return null;
  return (
    <div className="rcard">
      <div className="rcard-toggle open" style={{ cursor: "default" }}>
        <span className="rct-title">Обдзвін через простій</span>
        <span className="rct-sum" style={{ background: "var(--red)", color: "#fff", borderRadius: 10, padding: "1px 8px" }}>{affected.length}</span>
      </div>
      <div className="load-body">
        {affected.map((e) => (
          <div key={e.id} style={{ padding: "8px 0", borderTop: "1px solid var(--border)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.patient_name}</span>
              <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>{e.scheduled_time}</span>
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", margin: "2px 0 4px" }}>{procLabel(e)} · {(roomsById[e.room_id] || {}).name}</div>
            {e.patient_phone && <a href={"tel:" + e.patient_phone.replace(/\s/g, "")} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12.5, marginBottom: 6, whiteSpace: "nowrap", color: "#4da3ff", textDecoration: "none" }}>☎ {e.patient_phone}</a>}
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button className="btn btn-primary btn-xs" onClick={() => onReschedule(e)}>🗓 Перенести</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Міні-календар (навігація по днях) ── */
function MiniCalendar({ selectedDate, onSelectDate, overridesByDate, onEditSchedule }) {
  const today = today0();
  const ovMap = overridesByDate || {};
  const [viewMonth, setViewMonth] = useState(() => new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
  const shift = (n) => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  const y = viewMonth.getFullYear(), mo = viewMonth.getMonth();
  const first = new Date(y, mo, 1);
  const days = new Date(y, mo + 1, 0).getDate();
  const startIdx = dowMon(first);
  const cells = [];
  for (let i = 0; i < startIdx; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  return (
    <div className="bk-cal">
      <div className="cal-head">
        <span className="cal-month">{MON_NOM[mo]} {y}</span>
        <div className="cal-nav">
          <button className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shift(-1)} title="Попередній місяць">‹</button>
          <button className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shift(1)} title="Наступний місяць">›</button>
        </div>
      </div>
      <div className="cal-grid">
        {WK_SHORT.map((d) => <div className="cal-dow" key={d}>{d}</div>)}
        {cells.map((d, i) => {
          if (d === null) return <div className="cal-day empty-day" key={"e" + i} />;
          const cd = new Date(y, mo, d);
          const isToday = sameDay(cd, today);
          const isSel = sameDay(cd, selectedDate);
          const ov = ovMap[dateKey(cd)] || null;
          const st = dayStatus(ov, cd);
          const markClosed = st.kind === "closed";
          const markCustom = st.kind === "custom";
          return (
            <button key={d} className={"cal-day" + (isToday ? " today" : "") + (isSel && !isToday ? " selected" : "") + (markClosed ? " holiday" : "") + (markCustom ? " custom" : "")}
              title={st.label || undefined} onClick={() => onSelectDate(startOfDay(cd))}>
              {d}
              {(markClosed || markCustom) && <span className={"cal-sched " + (markClosed ? "closed" : "custom")} />}
            </button>
          );
        })}
      </div>
      {onEditSchedule && (
        <button className="btn btn-secondary btn-sm" style={{ width: "100%", marginTop: 10, justifyContent: "center" }} onClick={() => onEditSchedule()}>
          ✎ Графік на {selectedDate.getDate()} {MON_NOM[selectedDate.getMonth()].toLowerCase()}
        </button>
      )}
    </div>
  );
}

/* ── Головний компонент ── */
/* ── Скасовані + Неявка (нижня панель, згортувана) ── */
function CancelledPanel({ entries, onUndo, onReschedule }) {
  const [open, setOpen] = useState(false);
  if (!entries.length) return null;
  return (
    <div className="rcard">
      <button className={"rcard-toggle" + (open ? " open" : "")} onClick={() => setOpen((o) => !o)} style={{ cursor: "pointer" }}>
        <span className="rct-title">Скасовані + Неявка</span>
        <span className="rct-sum">{entries.length}</span>
        <span className="rct-chev">⌄</span>
      </button>
      {open && (
        <div className="load-body">
          {entries.map((e) => {
            const isCancelled = e.status === "cancelled";
            return (
              <div key={e.id} style={{ padding: "8px 0", borderTop: "1px solid var(--border)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                  <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.patient_name}</span>
                  <span className={"badge " + (isCancelled ? "gray" : "red")} style={{ fontSize: 10.5, flexShrink: 0 }}>{isCancelled ? "Скасовано" : "Неявка"}</span>
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)", margin: "2px 0 6px" }}>{e.scheduled_time} · {procLabel(e)}</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button className="btn btn-secondary btn-xs" onClick={() => onUndo(e)}>↩ В чергу</button>
                  <button className="btn btn-secondary btn-xs" onClick={() => onReschedule(e)}>🗓 Перезаписати</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function QueueBoard({ clinicId, rooms, clinicName, adminName, adminRole }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [completeFor, setCompleteFor] = useState(null);
  const [reschedFor, setReschedFor] = useState(null);
  const [editStudiesFor, setEditStudiesFor] = useState(null);
  const [incidents, setIncidents] = useState([]);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [breakdownRoomId, setBreakdownRoomId] = useState(null);
  const [overrides, setOverrides] = useState({});
  const [schedEditOpen, setSchedEditOpen] = useState(false);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [roomView, setRoomView] = useState("all");
  const [expandedRow, setExpandedRow] = useState(null);
  const [selectedDate, setSelectedDate] = useState(() => today0());
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  // Лёгкий тикер: перерендер раз на 20 с, щоб статус «⚠ Уточнити» зʼявлявся
  // автоматично одразу після настання часу запису (без ручного оновлення).
  const [, setNowTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setNowTick((n) => n + 1), 20000); return () => clearInterval(t); }, []);

  const today = today0();
  const isToday = sameDay(selectedDate, today);
  const isPast = selectedDate < today;
  const dayKey = dateKey(selectedDate);

  const roomsById = useMemo(() => {
    const m = {};
    (rooms || []).forEach((r) => { m[r.id] = r; });
    return m;
  }, [rooms]);

  function notify(msg, type = "success") {
    setToast({ msg, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  const reload = useCallback(async () => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("queue_entries")
      .select("id, patient_name, patient_phone, patient_age, patient_weight, scheduled_time, duration_min, status, call_status, note, studies, studies_original, contraindications, cito, doctor, room_id, updated_at, in_progress_at")
      .eq("clinic_id", clinicId)
      .eq("scheduled_date", dayKey)
      .order("scheduled_time", { ascending: true });
    if (!error) setEntries(data || []);
    setLoading(false);
  }, [clinicId, dayKey]);

  const loadIncidents = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("incidents")
      .select("id, room_id, reason, reason_label, note, started_at, blocked_until, status, auto_unblock")
      .eq("clinic_id", clinicId).in("status", ["active", "planned"]);
    const list = data || [];
    // Авто-розблокування: інциденти з галочкою auto_unblock, у яких настав час завершення,
    // знімаємо автоматично — кабінет і черга відновлюються самі (синхронно для всіх ролей через realtime).
    const expired = list.filter((i) => incidentExpired(i));
    if (expired.length) {
      await supabase.from("incidents").update({ status: "resolved", resolved_at: new Date().toISOString() }).in("id", expired.map((i) => i.id));
    }
    setIncidents(list);
  }, [clinicId]);

  const loadOverrides = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("schedule_overrides")
      .select("override_date, all_closed, label, rooms")
      .eq("clinic_id", clinicId);
    const m = {};
    (data || []).forEach((o) => { m[o.override_date] = o; });
    setOverrides(m);
  }, [clinicId]);

  useEffect(() => {
    setLoading(true);
    const supabase = createClient();
    const refetchAll = () => { reload(); loadIncidents(); loadOverrides(); };
    let channel;
    let cancelled = false;
    (async () => {
      // Realtime з RLS не доставляє postgres_changes, якщо сокет не авторизований —
      // тому СПЕРШУ ставимо токен сесії на realtime, і лише потім підписуємось.
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) supabase.realtime.setAuth(session.access_token);
      } catch (e) { /* ignore */ }
      if (cancelled) return;
      refetchAll();
      channel = supabase
        .channel("queue-" + clinicId)
        .on("postgres_changes", { event: "*", schema: "public", table: "queue_entries", filter: "clinic_id=eq." + clinicId }, () => reload())
        .on("postgres_changes", { event: "*", schema: "public", table: "incidents", filter: "clinic_id=eq." + clinicId }, () => loadIncidents())
        .on("postgres_changes", { event: "*", schema: "public", table: "schedule_overrides", filter: "clinic_id=eq." + clinicId }, () => loadOverrides())
        .subscribe();
    })();
    // Підстраховка, якщо подію realtime втрачено: оновлення при поверненні на вкладку + легкий поллінг.
    const onVis = () => { if (document.visibilityState === "visible") refetchAll(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    const pollTimer = setInterval(refetchAll, 10000);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
      clearInterval(pollTimer);
      if (channel) supabase.removeChannel(channel);
    };
  }, [clinicId, reload, loadIncidents, loadOverrides]);

  const selectedOverride = overrides[dayKey] || null;
  const selDayStatus = dayStatus(selectedOverride, selectedDate);

  async function saveOverride(ov) {
    const supabase = createClient();
    const empty = !ov.all_closed && (!ov.rooms || Object.keys(ov.rooms).length === 0);
    if (empty) {
      await supabase.from("schedule_overrides").delete().eq("clinic_id", clinicId).eq("override_date", dayKey);
    } else {
      await supabase.from("schedule_overrides").upsert({
        clinic_id: clinicId, override_date: dayKey, all_closed: !!ov.all_closed, label: ov.label || null, rooms: ov.rooms || {}, updated_at: new Date().toISOString(),
      }, { onConflict: "clinic_id,override_date" });
    }
    setSchedEditOpen(false);
    notify("Графік оновлено", "success");
    loadOverrides();
  }
  async function resetOverride() {
    const supabase = createClient();
    await supabase.from("schedule_overrides").delete().eq("clinic_id", clinicId).eq("override_date", dayKey);
    setSchedEditOpen(false);
    notify("Повернуто типовий графік", "success");
    loadOverrides();
  }
  function roomSchedClosed(roomId) { return roomScheduleFor(selectedDate, roomId, selectedOverride).closed; }

  // Інциденти, що ВЖЕ діють: відкидаємо ті, у яких авто-розблокування і час завершення минув
  // (банер/блокування зникають одразу при настанні blocked_until, ще до фонового зняття в БД).
  const liveIncidents = incidents.filter((i) => !incidentExpired(i));
  // Кабінет може мати кілька одночасних простоїв (напр. поломка + планове ТО) —
  // тримаємо масив на кабінет, щоб не загубити жодне вікно простою.
  const incidentsByRoom = {};
  liveIncidents.forEach((i) => { (incidentsByRoom[i.room_id] = incidentsByRoom[i.room_id] || []).push(i); });
  // Блокування діє ЗАРАЗ лише якщо поточний час у вікні простою; кінець залежить від
  // auto_unblock (Infinity при ручному знятті). Запланований майбутній ТО не блокує наперед.
  const blockingByRoom = {};
  liveIncidents.forEach((i) => {
    const s = new Date(i.started_at).getTime();
    if (Date.now() >= s && Date.now() < incidentEffectiveEnd(i)) blockingByRoom[i.room_id] = i;
  });

  // Пацієнти, чиї записи потрапили у вікно простою заблокованого апарата → на перенос.
  const affectedIds = new Set();
  if (!isPast) {
    entries.forEach((e) => {
      if (e.status !== "scheduled" && e.status !== "waiting") return;
      const incs = incidentsByRoom[e.room_id];
      if (incs && incs.some((inc) => entryInIncidentWindow(e.scheduled_time, selectedDate, inc))) { affectedIds.add(e.id); return; }
      if (roomSchedClosed(e.room_id)) affectedIds.add(e.id);
    });
  }
  const affected = entries.filter((e) => affectedIds.has(e.id));
  const blockedRoomIds = Object.keys(incidentsByRoom);
  const citoList = entries.filter((e) => e.cito && (e.status === "scheduled" || e.status === "waiting" || e.status === "in_progress"));

  async function submitIncident(payload) {
    const supabase = createClient();
    const startMs = new Date(payload.startedAt).getTime();
    // Майбутній старт → «заплановано» (не блокує наперед); поточний/минулий → активний зараз.
    const status = startMs > Date.now() ? "planned" : "active";
    const fields = { room_id: payload.roomId, reason: payload.reason, reason_label: payload.reasonLabel, note: payload.note, started_at: payload.startedAt, blocked_until: payload.blockedUntil, auto_unblock: payload.autoUnblock !== false, status };
    const { error } = payload.id
      ? await supabase.from("incidents").update(fields).eq("id", payload.id)
      : await supabase.from("incidents").insert({ clinic_id: clinicId, ...fields });
    if (error) { notify(/duplicate|unique|23505/i.test(error.message) ? "Кабінет уже має активний простій" : "Помилка: " + error.message, "error"); return; }
    // Поломка ЗАРАЗ під час дослідження → пацієнт «у кабінеті» → «Не відбулося».
    if (!payload.id && status === "active") {
      await supabase.from("queue_entries").update({ status: "not_held" }).eq("clinic_id", clinicId).eq("room_id", payload.roomId).eq("status", "in_progress");
    }
    notify(payload.id ? "Збережено" : (status === "planned" ? "Заплановано простій" : "Апарат заблоковано"), "success");
    loadIncidents();
    reload();
  }

  async function resolveIncident(idOrInc) {
    const id = typeof idOrInc === "string" ? idOrInc : idOrInc?.id;
    if (!id) return;
    const supabase = createClient();
    const { error } = await supabase.from("incidents").update({ status: "resolved", resolved_at: new Date().toISOString() }).eq("id", id);
    if (error) { notify("Помилка: " + error.message, "error"); return; }
    notify("Знято", "success");
    loadIncidents();
    reload();
  }

  async function setStatus(id, status) {
    const supabase = createClient();
    const nowIso = new Date().toISOString();
    // Момент входу в кабінет фіксуємо окремо (для коректного таймера, незалежного від updated_at).
    const patch = status === "in_progress" ? { status, in_progress_at: nowIso } : { status };
    const { error } = await supabase.from("queue_entries").update(patch).eq("id", id);
    if (error) {
      let msg;
      // Порушення інваріанта «один in_progress на кабінет» (індекс queue_one_in_progress_per_room).
      if (status === "in_progress" && /in_progress|duplicate|23505/i.test(error.message)) msg = "У кабінеті вже є пацієнт — спершу завершіть поточного";
      // Слот зайнятий іншим записом або потрапляє у вікно простою (поломка/ТО) — типово при поверненні в чергу.
      else if (/overlap|exclusion|incident/i.test(error.message)) msg = "Слот недоступний (зайнятий або простій) — перенесіть пацієнта на інший час";
      else msg = "Помилка: " + error.message;
      notify(msg, "error"); return;
    }
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, ...patch, updated_at: nowIso } : e)));
    reload();
  }
  const arrive = (p) => setStatus(p.id, "waiting");
  const noShow = (p) => setStatus(p.id, "no_show");
  const notHeld = (p) => setStatus(p.id, "not_held");
  const undo = (p) => setStatus(p.id, "scheduled");
  const openComplete = (p) => setCompleteFor(p);

  async function finishComplete(status, extraNote) {
    const p = completeFor;
    if (!p) return;
    const supabase = createClient();
    const note = [p.note, extraNote].map((x) => (x || "").trim()).filter(Boolean).join(" · ") || null;
    const { error } = await supabase.from("queue_entries").update({ status, note }).eq("id", p.id);
    setCompleteFor(null);
    if (error) { notify("Помилка: " + error.message, "error"); return; }
    notify(status === "done" ? "Процедуру завершено" : "Позначено: не відбулося", "success");
    reload();
  }

  async function cancelBooking(p) {
    const supabase = createClient();
    const { error } = await supabase.from("queue_entries").update({ status: "cancelled" }).eq("id", p.id);
    if (error) { notify("Помилка: " + error.message, "error"); return; }
    notify("Запис скасовано", "success");
    reload();
  }

  async function setCall(p, call_status) {
    const supabase = createClient();
    // Відмова пацієнта на обдзвоні → запис скасовується.
    const patch = call_status === "declined" ? { call_status, status: "cancelled" } : { call_status };
    const { error } = await supabase.from("queue_entries").update(patch).eq("id", p.id);
    if (error) { notify("Помилка: " + error.message, "error"); return; }
    setEntries((es) => es.map((e) => (e.id === p.id ? { ...e, ...patch } : e)));
    if (call_status === "declined") notify("Пацієнт відмовився — запис скасовано", "info");
    reload();
  }

  const openReschedule = (p) => setReschedFor(p);
  async function doReschedule({ roomId, date, time, dur }) {
    const p = reschedFor;
    if (!p) return;
    const supabase = createClient();
    const [hh, mm] = time.split(":").map(Number);
    const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hh, mm).toISOString();
    // повторна перевірка зайнятості кабінету на цільову дату (без самого пацієнта)
    const startMin = hh * 60 + mm, endMin = startMin + (dur || 30);
    const { data: clash } = await supabase
      .from("queue_entries").select("id, scheduled_time, duration_min")
      .eq("room_id", roomId).eq("scheduled_date", dateKey(date))
      .neq("status", "cancelled").neq("status", "no_show").neq("status", "not_held");
    if ((clash || []).some((q) => {
      if (q.id === p.id) return false;
      const [qh, qm] = String(q.scheduled_time || "0:0").split(":").map(Number);
      const qs = (qh || 0) * 60 + (qm || 0);
      return qs < endMin && startMin < qs + (q.duration_min || 30);
    })) { notify("Слот щойно зайняли — оберіть інший", "error"); return; }
    const { error } = await supabase.from("queue_entries").update({
      room_id: roomId, scheduled_date: dateKey(date), scheduled_time: time, scheduled_at: at,
      duration_min: dur, status: "scheduled", call_status: "not_called",
    }).eq("id", p.id);
    setReschedFor(null);
    if (error) { notify(/incident/i.test(error.message) ? "Кабінет у простої (поломка/ТО) у цей час — оберіть інший слот або день" : /overlap|exclusion/i.test(error.message) ? "Слот зайнятий — оберіть інший" : "Помилка переносу: " + error.message, "error"); return; }
    notify("Перенесено на " + fmtShort(date) + " " + time, "success");
    reload();
  }

  const openEditStudies = (p) => setEditStudiesFor(p);
  async function doEditStudies(arr, meta) {
    const p = editStudiesFor;
    if (!p) return;
    const supabase = createClient();
    const { error } = await supabase.from("queue_entries").update({
      studies: arr, duration_min: (meta && meta.dur) || p.duration_min,
      has_contrast: (arr || []).some((s) => s.contrast),
    }).eq("id", p.id);
    setEditStudiesFor(null);
    if (error) { notify("Помилка: " + error.message, "error"); return; }
    notify("Дослідження оновлено", "success");
    reload();
  }

  // Причина, чому пацієнта НЕ можна зараз завести в кабінет (null = можна).
  function inProgressBlockReason(p) {
    if (blockingByRoom[p.room_id]) return "Кабінет заблоковано (поломка/ТО) — спершу розблокуйте апарат";
    if (roomSchedClosed(p.room_id)) return "Кабінет зачинено за графіком на цей день";
    if (entries.some((e) => e.room_id === p.room_id && e.status === "in_progress" && e.id !== p.id)) return "Кабінет зайнятий — спершу завершіть поточного пацієнта";
    return null;
  }
  function callPatient(p) {
    const reason = inProgressBlockReason(p);
    if (reason) { notify(reason, "error"); return; }
    setStatus(p.id, "in_progress");
  }
  // Єдина точка зміни статусу зі сходинок прогрес-кроку: перехід у in_progress
  // завжди проходить ті самі перевірки, що й кнопка «Викликати в кабінет».
  function setStatusGuarded(p, status) {
    if (status === "in_progress") { callPatient(p); return; }
    setStatus(p.id, status);
  }

  async function saveBooking(b) {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    const [hh, mm] = b.time.split(":").map(Number);
    const at = new Date(b.date.getFullYear(), b.date.getMonth(), b.date.getDate(), hh, mm).toISOString();
    // повторна перевірка слота безпосередньо перед вставкою (його могли зайняти, поки відкрита модалка)
    const startMin = hh * 60 + mm, endMin = startMin + (b.dur || 30);
    const { data: clash } = await supabase
      .from("queue_entries").select("scheduled_time, duration_min")
      .eq("room_id", b.roomId).eq("scheduled_date", dateKey(b.date))
      .neq("status", "cancelled").neq("status", "no_show").neq("status", "not_held");
    if ((clash || []).some((q) => {
      const [qh, qm] = String(q.scheduled_time || "0:0").split(":").map(Number);
      const qs = (qh || 0) * 60 + (qm || 0);
      return qs < endMin && startMin < qs + (q.duration_min || 30);
    })) { notify("Слот щойно зайняли — оновіть сторінку й оберіть інший час", "error"); return; }
    const { error } = await supabase.from("queue_entries").insert({
      clinic_id: clinicId, room_id: b.roomId, created_by: user?.id ?? null,
      patient_name: b.name, patient_phone: b.phone || null, patient_email: b.email,
      patient_dob: b.dob || null, patient_sex: b.gender || null, patient_age: b.age || null, patient_weight: b.weight,
      contraindications: !!b.hasContra, cito: !!b.cito, has_contrast: (b.studies || []).some((s) => s.contrast),
      studies: b.studies || [], studies_original: b.studies || [], doctor: b.doctor, note: b.notes, duration_min: b.dur,
      scheduled_date: dateKey(b.date), scheduled_time: b.time, scheduled_at: at,
      status: "scheduled", call_status: "not_called",
    });
    if (error) { notify(/incident/i.test(error.message) ? "Кабінет у простої (поломка/ТО) у цей час — оберіть інший слот або день" : /overlap|exclusion/i.test(error.message) ? "Слот щойно зайняли — оновіть сторінку й оберіть інший час" : "Помилка збереження: " + error.message, "error"); return; }
    setModalOpen(false);
    notify("Новий запис: " + b.name + " · " + b.time, "success");
    if (sameDay(b.date, selectedDate)) reload();
  }

  /* агрегати (scoped — звужено до обраного кабінету в сайдбарі) */
  const scoped = roomView === "all" ? entries : entries.filter((e) => e.room_id === roomView);
  // Основний список: активні + завершені + «не відбулося». Скасовані та неявки — в окремій панелі.
  const boardScoped = scoped.filter((e) => e.status !== "cancelled" && e.status !== "no_show");
  const panelEntries = scoped.filter((e) => e.status === "cancelled" || e.status === "no_show");
  const counts = useMemo(() => {
    const c = { total: 0, scheduled: 0, waiting: 0, in_progress: 0, done: 0, no_show: 0, not_held: 0, cancelled: 0 };
    scoped.forEach((e) => { if (c[e.status] != null) c[e.status]++; if (e.status !== "cancelled") c.total++; });
    return c;
  }, [scoped]);

  // картки кабінетів — по всіх кабінетах (не залежать від фільтра)
  const currentByRoom = {}, nextWaitingByRoom = {};
  entries.forEach((e) => {
    if (e.status === "in_progress") currentByRoom[e.room_id] = e;
  });
  // Наступний на виклик: CITO (терміновий) має пріоритет, інакше найраніший за часом
  // (entries вже впорядковані за scheduled_time за зростанням).
  entries.forEach((e) => {
    if (e.status !== "waiting") return;
    const cur = nextWaitingByRoom[e.room_id];
    if (!cur || (e.cito && !cur.cito)) nextWaitingByRoom[e.room_id] = e;
  });

  const roomLoad = computeRoomLoad(rooms, entries, selectedDate, selectedOverride, incidents);

  // CITO підіймається вгору в межах свого статусу (для активних записів).
  const citoRank = (x) => (x.cito && (x.status === "scheduled" || x.status === "waiting" || x.status === "in_progress")) ? 0 : 1;
  const sorted = boardScoped.slice().sort((a, b) => {
    const d = (FLOW[a.status] ?? 9) - (FLOW[b.status] ?? 9);
    if (d !== 0) return d;
    const c = citoRank(a) - citoRank(b);
    if (c !== 0) return c;
    return (a.scheduled_time || "").localeCompare(b.scheduled_time || "");
  });
  const filtered = sorted.filter((e) => {
    if (filter !== "all" && e.status !== filter) return false;
    if (query.trim()) return (e.patient_name || "").toLowerCase().includes(query.trim().toLowerCase());
    return true;
  });

  function toggleRow(id) { setExpandedRow((r) => (r === id ? null : id)); }

  return (
    <div className="app">
      <Sidebar
        clinicName={clinicName} adminName={adminName} adminRole={adminRole}
        rooms={rooms} activeRoom={roomView} onSelectRoom={setRoomView} onNew={() => setModalOpen(true)}
        incidentCount={liveIncidents.length} onBreakdown={() => { setBreakdownRoomId(null); setBreakdownOpen(true); }}
      />
      <div className="main">
        <header className="topbar">
          <div className="tb-title">
            <span className="tic">▦</span>
            <div>
              <h1>Дошка черги</h1>
              <div className="date">{fmtFull(selectedDate)}</div>
            </div>
          </div>
          <div className="tb-right">
            <span className="rt-pill"><span className="pulse-dot" style={{ background: "var(--green)", width: 7, height: 7 }} />Real-time</span>
            <button className="btn btn-secondary" onClick={reload}>↻ Оновити</button>
            <button className="btn btn-breakdown" onClick={() => setBreakdownOpen(true)} title="Зафіксувати поломку або ТО апарата">🔧 Поломка / ТО</button>
            <button className="btn btn-primary btn-lg" onClick={() => setModalOpen(true)}>＋ Новий запис</button>
          </div>
        </header>
        <div className="content-wrap">
          <div className="content">
            {isToday && citoList.length > 0 && (
              <div className="inc-banner fade-in" style={{ borderColor: "var(--red)" }}>
                <span className="inc-banner-ic">🔴</span>
                <div className="inc-banner-txt">
                  <div className="inc-banner-title">Термінові пацієнти (CITO): {citoList.length}</div>
                  <div className="inc-banner-sub">{citoList.slice(0, 3).map((e) => (e.patient_name || "").split(" ").slice(0, 2).join(" ")).join(" · ")}{citoList.length > 3 ? " …" : ""}</div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => setFilter("all")}>Показати чергу</button>
              </div>
            )}
            {!isPast && liveIncidents.filter((inc) => incidentCoversDay(inc, selectedDate)).map((inc) => {
              const r = roomsById[inc.room_id] || {};
              const nowBlocking = !!blockingByRoom[inc.room_id] && blockingByRoom[inc.room_id].id === inc.id;
              // Ручний режим і вікно вже завершилося: кабінет вже вільний, але запис чекає на підтвердження зняття.
              const awaitingManual = !nowBlocking && incidentAwaitingManualUnblock(inc);
              const startStr = new Date(inc.started_at).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
              const borderColor = nowBlocking ? undefined : awaitingManual ? { borderColor: "var(--green)" } : { borderColor: "var(--orange)" };
              return (
                <div className="inc-banner fade-in" key={inc.id} style={borderColor}>
                  <span className="inc-banner-ic">{nowBlocking ? "🔧" : awaitingManual ? "🔓" : "🗓"}</span>
                  <div className="inc-banner-txt">
                    <div className="inc-banner-title">{r.name || "Апарат"} {nowBlocking ? "заблоковано" : awaitingManual ? "— простій завершився" : "— заплановано простій"} · {inc.reason_label || "Поломка"}
                      {inc.note ? <span className="inc-banner-window">{inc.note}</span> : null}
                    </div>
                    <div className="inc-banner-sub">{(() => {
                      const n = affected.filter((a) => a.room_id === inc.room_id).length;
                      if (awaitingManual) return "Час завершення минув · кабінет вільний · підтвердьте зняття вручну →";
                      if (!nowBlocking) return "Заплановано з " + startStr + " · виклики поки працюють" + (n > 0 ? " · пацієнтів у вікні: " + n + " →" : "");
                      return n > 0 ? n + (n === 1 ? " пацієнт у вікні простою потребує переносу →" : " пацієнтів у вікні простою потребують переносу →") : "Нові виклики на цей апарат призупинено";
                    })()}</div>
                  </div>
                  <button className="btn btn-secondary btn-sm" onClick={() => { setBreakdownRoomId(inc.room_id); setBreakdownOpen(true); }}>✎ Редагувати</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => resolveIncident(inc)}>{nowBlocking || awaitingManual ? "🔓 Розблокувати" : "✕ Скасувати"}</button>
                </div>
              );
            })}
            {selectedOverride && selDayStatus.kind !== "none" && (
              <div className="inc-banner fade-in" style={{ borderColor: selDayStatus.kind === "closed" ? "var(--red)" : "var(--blue)" }}>
                <span className="inc-banner-ic">{selDayStatus.kind === "closed" ? "🚫" : "🕐"}</span>
                <div className="inc-banner-txt">
                  <div className="inc-banner-title">{selDayStatus.kind === "closed" ? "Неробочий день" : "Особливий графік"} · {fmtShort(selectedDate)}</div>
                  <div className="inc-banner-sub">{selDayStatus.label}</div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => setSchedEditOpen(true)}>✎ Редагувати</button>
              </div>
            )}
            <div className="board-main-top">
            <StatsBar counts={counts} filter={filter} setFilter={setFilter} />

            {!isToday ? (
              <div className="day-banner">
                <span className="db-ic">{isPast ? "🗂" : "📅"}</span>
                <div className="db-meta">
                  <div className="db-title">{fmtFull(selectedDate)}</div>
                  <div className="db-sub">{selDayStatus.kind !== "none" ? selDayStatus.label + " · " : ""}{counts.total ? (isPast ? "Архів — день завершено" : "Заплановані записи") + " · " + counts.total + " записів" : "Записів немає"}</div>
                </div>
                {!isPast && <button className="btn btn-secondary btn-sm" onClick={() => setSchedEditOpen(true)}>✎ Графік</button>}
                <button className="btn btn-secondary btn-sm" onClick={() => setSelectedDate(today0())}>← Сьогодні</button>
              </div>
            ) : roomView === "all" ? (
              <div className="room-cards">
                {(rooms || []).map((r) => (
                  <RoomStatusCard key={r.id} room={r}
                    patient={currentByRoom[r.id]} enteredAt={enteredAtOf(currentByRoom[r.id])}
                    nextWaiting={nextWaitingByRoom[r.id]} blocked={blockingByRoom[r.id]}
                    schedClosed={!blockingByRoom[r.id] && roomSchedClosed(r.id) ? selDayStatus.label : null}
                    onComplete={openComplete} onCall={callPatient} onUnblock={resolveIncident} />
                ))}
                {(rooms || []).length === 0 && (
                  <div className="ctx-hint blue">Кабінетів ще немає. Додайте обладнання в <a href="/setup">Налаштуваннях</a>.</div>
                )}
              </div>
            ) : (
              <>
                <div className="room-view-head">
                  <button className="btn btn-ghost btn-sm" onClick={() => setRoomView("all")}>← Усі кабінети</button>
                  <span className="rvh-title">
                    <span className={"rvh-tile " + ((roomsById[roomView] || {}).modality === "MRI" ? "mrt" : "ct")}>{modalityLabel((roomsById[roomView] || {}).modality)}</span>
                    {(roomsById[roomView] || {}).name}{(roomsById[roomView] || {}).apparatus_model ? " · " + roomsById[roomView].apparatus_model : ""}
                  </span>
                </div>
                <CurrentCard
                  patient={currentByRoom[roomView]}
                  roomName={(roomsById[roomView] || {}).name || "—"}
                  roomModel={(roomsById[roomView] || {}).apparatus_model}
                  enteredAt={enteredAtOf(currentByRoom[roomView])}
                  nextWaiting={nextWaitingByRoom[roomView]}
                  onCall={callPatient} onComplete={openComplete} onReschedule={openReschedule}
                />
              </>
            )}
          </div>

          {/* Search */}
          <div className="qctrl">
            <div className="spacer" />
            <div className="search">
              <span className="si">⌕</span>
              <input placeholder="Пошук пацієнта…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          </div>

          <div className="qhead">
            <div>Час</div><div>Пацієнт</div><div>Процедура</div><div>Кабінет</div><div>Статус</div><div />
          </div>

          {loading ? (
            <div className="empty"><div className="et">Завантаження…</div></div>
          ) : filtered.length === 0 ? (
            <div className="empty">
              <div className="ei">⌕</div>
              <div className="et">{entries.length === 0 ? "Записів на цей день немає" : "Нічого не знайдено"}</div>
              <div className="es">{entries.length === 0 ? "Натисніть «Новий запис», щоб додати пацієнта" : "Спробуйте змінити фільтр або пошук"}</div>
            </div>
          ) : (
            <div className="qrows">
              {filtered.map((p) => {
                const room = roomsById[p.room_id] || {};
                return (
                  <QueueRow key={p.id} p={p} dayDate={selectedDate}
                    roomName={room.name || "—"} roomKind={modalityLabel(room.modality)}
                    expanded={expandedRow === p.id} onToggle={toggleRow}
                    readOnly={false}
                    canCall={!currentByRoom[p.room_id]} rescheduling={affectedIds.has(p.id)}
                    onArrive={arrive} onCall={callPatient} onComplete={openComplete}
                    onNoShow={noShow} onNotHeld={notHeld} onUndo={undo} onCancel={cancelBooking} onSetStatus={setStatusGuarded} onSetCall={setCall}
                    onReschedule={openReschedule} onEditStudies={openEditStudies} />
                );
              })}
            </div>
          )}
        </div>

          {/* Right panel */}
          <aside className="rpanel">
            <MiniCalendar selectedDate={selectedDate} onSelectDate={setSelectedDate} overridesByDate={overrides} onEditSchedule={() => setSchedEditOpen(true)} />
            {isToday && (rooms || []).length > 0 && <RoomLoad rooms={roomLoad} onSelectRoom={setRoomView} />}
            {!isPast && <AffectedPanel affected={affected} roomsById={roomsById} onReschedule={openReschedule} />}
            {!isPast && <CallListPanel entries={entries} onSetCall={setCall} dateLabel={fmtShort(selectedDate)} />}
            <CancelledPanel entries={panelEntries} onUndo={undo} onReschedule={openReschedule} />
          </aside>
        </div>
      </div>

      {modalOpen && <BookingModal rooms={rooms} clinicId={clinicId} incidents={liveIncidents} onClose={() => setModalOpen(false)} onSave={saveBooking} />}

      {completeFor && (
        <CompletionModal
          patient={completeFor}
          proc={procLabel(completeFor)}
          roomName={(roomsById[completeFor.room_id] || {}).name || "—"}
          enteredAt={enteredAtOf(completeFor)}
          onClose={() => setCompleteFor(null)}
          onSuccess={(notes) => finishComplete("done", notes)}
          onFail={(reason, notes) => finishComplete("not_held", [reason, notes].filter(Boolean).join(" — "))}
        />
      )}

      {reschedFor && (
        <RescheduleModal patient={reschedFor} rooms={rooms} clinicId={clinicId} incidents={liveIncidents} onClose={() => setReschedFor(null)} onConfirm={doReschedule} />
      )}

      {editStudiesFor && (
        <StudyEditModal patient={editStudiesFor} scheduledDate={dayKey} rooms={rooms} clinicId={clinicId} onClose={() => setEditStudiesFor(null)} onConfirm={doEditStudies} />
      )}

      {breakdownOpen && (
        <BreakdownModal rooms={rooms} incidents={liveIncidents} overrides={overrides} initialRoomId={breakdownRoomId} onClose={() => { setBreakdownOpen(false); setBreakdownRoomId(null); }} onSubmit={submitIncident} onResolve={resolveIncident} />
      )}

      {schedEditOpen && (
        <ScheduleEditModal date={selectedDate} rooms={rooms} existing={selectedOverride} entries={entries}
          onClose={() => setSchedEditOpen(false)} onSave={saveOverride} onReset={resetOverride} />
      )}

      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "var(--card)", border: "1px solid var(--border-strong)", borderLeft: "4px solid " + (toast.type === "error" ? "var(--red)" : "var(--green)"), borderRadius: 12, padding: "12px 18px", boxShadow: "var(--shadow-pop)", zIndex: 50, fontSize: 13.5 }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
