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
function computeRoomLoad(rooms, entries) {
  const cap = 480; // 8 робочих годин у хвилинах
  return (rooms || []).map((r) => {
    const mins = entries.filter((e) => e.room_id === r.id && e.status !== "no_show").reduce((s, e) => s + (e.duration_min || 0), 0);
    const pct = Math.min(100, Math.round((mins / cap) * 100));
    return { roomKey: r.id, name: r.name, kind: modalityLabel(r.modality), pct, color: r.modality === "MRI" ? "var(--blue)" : "var(--orange)" };
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
const STATUS_SEG = [
  { key: "scheduled", label: "В черзі", cls: "gray" },
  { key: "waiting", label: "Очікує", cls: "yellow" },
  { key: "in_progress", label: "В кабінеті", cls: "blue" },
  { key: "done", label: "Виконано", cls: "green" },
  { key: "no_show", label: "Не відбулось", cls: "red" },
];
const CALL_META = {
  confirmed:  { label: "Підтверджено", cls: "green", icon: "✓" },
  to_recall:  { label: "Передзвонити", cls: "blue", icon: "↻" },
  no_answer:  { label: "Не відповідає", cls: "orange", icon: "…" },
  declined:   { label: "Відмова", cls: "red", icon: "✕" },
  not_called: { label: "Не дзвонили", cls: "gray", icon: "○" },
};
const CALL_SEG = [
  { key: "confirmed", label: "Підтверджено", cls: "green" },
  { key: "to_recall", label: "Передзвонити", cls: "blue" },
  { key: "no_answer", label: "Не відповідає", cls: "orange" },
  { key: "declined", label: "Відмова", cls: "red" },
  { key: "not_called", label: "Не дзвонили", cls: "gray" },
];

function QueueRow({ p, dayDate, roomName, roomKind, expanded, onToggle, readOnly, canCall, rescheduling, onArrive, onCall, onComplete, onNoShow, onUndo, onCancel, onSetStatus, onSetCall, onReschedule, onEditStudies }) {
  const overdue = needsClarification(p.status, dayDate, p.scheduled_time);
  const meta = overdue ? CLARIFY_META : (ST[p.status] || ST.scheduled);
  const proc = procLabel(p);
  const act = (fn) => (e) => { e.stopPropagation(); fn(p); };
  return (
    <div className={"qrow-item " + p.status + (expanded ? " open" : "")} data-qrow={p.id}>
      <div className="qrow" role="button" tabIndex={0} onClick={() => onToggle(p.id)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(p.id); } }}>
        <div className="q-time tabular">{p.scheduled_time}<div className="td">{p.duration_min} хв</div></div>
        <div className="q-pat">
          <div className="nm">{p.cito && (p.status === "scheduled" || p.status === "waiting" || p.status === "in_progress") && <span className="cito-tag">CITO</span>}{p.patient_name}</div>
          <div className="det">{p.patient_age ? p.patient_age + " р. · " : ""}{p.patient_phone || ""}{p.doctor ? " · напр.: " + p.doctor : ""}</div>
        </div>
        <div className="q-proc">
          <div className="pp">{proc}</div>
          <div className="du">{roomKind}</div>
        </div>
        <div className="q-room"><b>{roomName}</b></div>
        <div className="q-status-cell">
          <span className={"badge " + meta.cls}>{meta.dot && <span className="pulse-dot" style={{ width: 6, height: 6 }} />}{meta.label}</span>
          {rescheduling && <span className="badge red" title="Апарат заблоковано — потрібен перенос на інший слот">🔧 Перезапис</span>}
        </div>
        <span className={"q-chev" + (expanded ? " open" : "")} aria-hidden>›</span>
      </div>

      <div className="qrow-detail-wrap">
        <div className="qrow-detail-inner">
          <div className="qrow-detail">
            <div className="qd-info">
              <span className="qd-row"><span className="qd-k">Процедура</span><span className="qd-v">{proc}</span></span>
              <span className="qd-row"><span className="qd-k">Кабінет</span><span className="qd-v">{roomName}</span></span>
              <span className="qd-row"><span className="qd-k">Час · Тривалість</span><span className="qd-v">{p.scheduled_time} · {p.duration_min} хв</span></span>
              {p.patient_phone && <span className="qd-row"><span className="qd-k">Телефон</span><a className="qd-v qd-phone" href={"tel:" + p.patient_phone.replace(/\s/g, "")} onClick={(e) => e.stopPropagation()}>{p.patient_phone}</a></span>}
              {p.patient_age != null && <span className="qd-row"><span className="qd-k">Вік</span><span className="qd-v">{p.patient_age} р.</span></span>}
              {p.patient_weight != null && <span className="qd-row"><span className="qd-k">Вага</span><span className="qd-v">{p.patient_weight} кг</span></span>}
              {p.contraindications && <span className="qd-row"><span className="qd-k">Протипоказання</span><span className="qd-v"><span className="badge red">є</span></span></span>}
              {p.note && <span className="qd-row"><span className="qd-k">Примітки</span><span className="qd-v">{p.note}</span></span>}
              <span className="qd-row"><span className="qd-k">Дзвінок-підтвердження</span><span className="qd-v qd-v-call">
                {(() => { const cm = CALL_META[p.call_status || "not_called"]; return <span className={"qd-call " + cm.cls}>{cm.icon} {cm.label}</span>; })()}
                {onSetCall && p.status !== "done" && p.status !== "no_show" && (p.call_status || "not_called") !== "confirmed" && (
                  <span className="qd-call-quick">
                    {p.patient_phone && <a className="qd-call-tel" href={"tel:" + p.patient_phone.replace(/\s/g, "")} onClick={(e) => e.stopPropagation()} title={"Подзвонити: " + p.patient_phone}>☎</a>}
                    <button className="btn btn-green btn-xs" onClick={(e) => { e.stopPropagation(); onSetCall(p, "confirmed"); }} title="Позначити дзвінок як підтверджений">✓ Підтвердити</button>
                  </span>
                )}
              </span></span>
            </div>

            {!readOnly && (
              <div className="qd-actions">
                {onEditStudies && p.status !== "done" && p.status !== "no_show" && (
                  <button className="btn btn-secondary btn-sm" onClick={act(onEditStudies)}>🩻 Дослідження</button>
                )}
                {p.status === "scheduled" && (
                  <>
                    <button className="btn btn-primary btn-sm" onClick={act(onArrive)}>✓ Пацієнт прийшов</button>
                    <button className="btn btn-secondary btn-sm" onClick={act(onReschedule)}>🗓 Перенести на слот</button>
                    <button className="btn btn-secondary btn-sm qd-act-red" onClick={act(onCancel)}>✕ Скасувати запис</button>
                    <button className="btn btn-secondary btn-sm qd-act-red" onClick={act(onNoShow)}>✕ Неявка</button>
                  </>
                )}
                {p.status === "waiting" && (
                  <>
                    <button className="btn btn-primary btn-sm" disabled={!canCall} onClick={act(onCall)} title={canCall ? "" : "Кабінет зайнятий"}>▶ Викликати в кабінет</button>
                    <button className="btn btn-secondary btn-sm" onClick={act(onReschedule)}>🗓 Перенести на слот</button>
                    <button className="btn btn-secondary btn-sm qd-act-red" onClick={act(onCancel)}>✕ Скасувати запис</button>
                    <button className="btn btn-secondary btn-sm qd-act-red" onClick={act(onNoShow)}>✕ Неявка</button>
                  </>
                )}
                {p.status === "in_progress" && (
                  <button className="btn btn-green btn-sm" onClick={act(onComplete)}>✓ Завершити процедуру</button>
                )}
                {p.status === "done" && <span className="q-done-lab">✓ Дослідження виконано</span>}
                {p.status === "no_show" && (
                  <>
                    <span className="q-noshow-lab">✕ Не відбулось</span>
                    <button className="btn btn-secondary btn-sm" onClick={act(onUndo)}>↩ Повернути в чергу</button>
                  </>
                )}
              </div>
            )}

            {!readOnly && (
              <div className="qd-statusfix">
                <span className="qd-sf-lab">Змінити статус <span className="qd-sf-hint">(у разі помилкового натискання)</span></span>
                <div className="qd-seg">
                  {STATUS_SEG.map((s) => {
                    const lockDone = s.key === "in_progress" && false;
                    return (
                      <button key={s.key}
                        className={"qd-seg-btn " + s.cls + (p.status === s.key ? " active" : "")}
                        onClick={(e) => { e.stopPropagation(); onSetStatus(p, s.key); }}>
                        <span className={"qd-seg-dot " + s.cls} />{s.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {!readOnly && onSetCall && p.status !== "done" && p.status !== "no_show" && (
              <div className="qd-statusfix">
                <span className="qd-sf-lab">Дзвінок-підтвердження <span className="qd-sf-hint">(обдзвін напередодні)</span></span>
                <div className="qd-seg">
                  {CALL_SEG.map((s) => (
                    <button key={s.key} className={"qd-seg-btn " + s.cls + ((p.call_status || "not_called") === s.key ? " active" : "")}
                      onClick={(e) => { e.stopPropagation(); onSetCall(p, s.key); }}>
                      <span className={"qd-seg-dot " + s.cls} />{s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Колл-лист (підтвердження) ── */
function CallListPanel({ entries, onSetCall }) {
  const list = entries.filter((e) => ["not_called", "to_recall", "no_answer"].includes(e.call_status || "not_called") && (e.status === "scheduled" || e.status === "waiting"));
  return (
    <div className="rcard">
      <div className="rcard-toggle open" style={{ cursor: "default" }}>
        <span className="rct-title">Обдзвін — підтвердження</span>
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
              {e.patient_phone && <a className="qd-call-tel" href={"tel:" + e.patient_phone.replace(/\s/g, "")} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12.5, marginBottom: 6 }}>☎ {e.patient_phone}</a>}
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
            {e.patient_phone && <a className="qd-call-tel" href={"tel:" + e.patient_phone.replace(/\s/g, "")} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12.5, marginBottom: 6 }}>☎ {e.patient_phone}</a>}
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
export default function QueueBoard({ clinicId, rooms, clinicName, adminName, adminRole }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [completeFor, setCompleteFor] = useState(null);
  const [reschedFor, setReschedFor] = useState(null);
  const [editStudiesFor, setEditStudiesFor] = useState(null);
  const [incidents, setIncidents] = useState([]);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [overrides, setOverrides] = useState({});
  const [schedEditOpen, setSchedEditOpen] = useState(false);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [roomView, setRoomView] = useState("all");
  const [expandedRow, setExpandedRow] = useState(null);
  const [selectedDate, setSelectedDate] = useState(() => today0());
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

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
      .select("id, patient_name, patient_phone, patient_age, patient_weight, scheduled_time, duration_min, status, call_status, note, studies, contraindications, cito, doctor, room_id, updated_at")
      .eq("clinic_id", clinicId)
      .eq("scheduled_date", dayKey)
      .neq("status", "cancelled")
      .order("scheduled_time", { ascending: true });
    if (!error) setEntries(data || []);
    setLoading(false);
  }, [clinicId, dayKey]);

  const loadIncidents = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("incidents")
      .select("id, room_id, reason, reason_label, note, started_at, blocked_until, status")
      .eq("clinic_id", clinicId).eq("status", "active");
    setIncidents(data || []);
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
    reload();
    loadIncidents();
    loadOverrides();
    const supabase = createClient();
    const channel = supabase
      .channel("queue-" + clinicId)
      .on("postgres_changes", { event: "*", schema: "public", table: "queue_entries", filter: "clinic_id=eq." + clinicId }, () => reload())
      .on("postgres_changes", { event: "*", schema: "public", table: "incidents", filter: "clinic_id=eq." + clinicId }, () => loadIncidents())
      .on("postgres_changes", { event: "*", schema: "public", table: "schedule_overrides", filter: "clinic_id=eq." + clinicId }, () => loadOverrides())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
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

  const incidentByRoom = {};
  incidents.forEach((i) => { incidentByRoom[i.room_id] = i; });

  // Пацієнти, чиї записи потрапили у вікно простою заблокованого апарата → на перенос.
  const affectedIds = new Set();
  if (!isPast) {
    entries.forEach((e) => {
      if (e.status !== "scheduled" && e.status !== "waiting") return;
      if (isToday) {
        const inc = incidentByRoom[e.room_id];
        if (inc) { const [s, en] = incWindow(inc); const m = toMinHHMM(e.scheduled_time); if (m >= s && m < en) { affectedIds.add(e.id); return; } }
      }
      if (roomSchedClosed(e.room_id)) affectedIds.add(e.id);
    });
  }
  const affected = entries.filter((e) => affectedIds.has(e.id));
  const blockedRoomIds = Object.keys(incidentByRoom);
  const citoList = entries.filter((e) => e.cito && (e.status === "scheduled" || e.status === "waiting" || e.status === "in_progress"));

  async function registerBreakdown(data) {
    const supabase = createClient();
    const { error } = await supabase.from("incidents").insert({
      clinic_id: clinicId, room_id: data.roomId, reason: data.reason, reason_label: data.reasonLabel,
      note: data.note, started_at: data.startedAt, blocked_until: data.blockedUntil, status: "active",
    });
    setBreakdownOpen(false);
    if (error) { notify("Помилка: " + error.message, "error"); return; }
    notify("Апарат заблоковано", "success");
    loadIncidents();
  }

  async function resolveIncident(incident) {
    const supabase = createClient();
    const { error } = await supabase.from("incidents").update({ status: "resolved", resolved_at: new Date().toISOString() }).eq("id", incident.id);
    if (error) { notify("Помилка: " + error.message, "error"); return; }
    notify("Апарат розблоковано", "success");
    loadIncidents();
  }

  async function setStatus(id, status) {
    const supabase = createClient();
    const { error } = await supabase.from("queue_entries").update({ status }).eq("id", id);
    if (error) { notify("Помилка: " + error.message, "error"); return; }
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, status, updated_at: new Date().toISOString() } : e)));
    reload();
  }
  const arrive = (p) => setStatus(p.id, "waiting");
  const noShow = (p) => setStatus(p.id, "no_show");
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
    notify(status === "done" ? "Процедуру завершено" : "Позначено: не відбулось", "success");
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
    const { error } = await supabase.from("queue_entries").update({ call_status }).eq("id", p.id);
    if (error) { notify("Помилка: " + error.message, "error"); return; }
    setEntries((es) => es.map((e) => (e.id === p.id ? { ...e, call_status } : e)));
    reload();
  }

  const openReschedule = (p) => setReschedFor(p);
  async function doReschedule({ roomId, date, time, dur }) {
    const p = reschedFor;
    if (!p) return;
    const supabase = createClient();
    const [hh, mm] = time.split(":").map(Number);
    const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hh, mm).toISOString();
    const { error } = await supabase.from("queue_entries").update({
      room_id: roomId, scheduled_date: dateKey(date), scheduled_time: time, scheduled_at: at,
      duration_min: dur, status: "scheduled", call_status: "not_called",
    }).eq("id", p.id);
    setReschedFor(null);
    if (error) { notify("Помилка переносу: " + error.message, "error"); return; }
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

  function callPatient(p) {
    if (incidentByRoom[p.room_id]) { notify("Кабінет заблоковано (поломка/ТО) — спершу розблокуйте апарат", "error"); return; }
    if (roomSchedClosed(p.room_id)) { notify("Кабінет зачинено за графіком на цей день", "error"); return; }
    const busy = entries.some((e) => e.room_id === p.room_id && e.status === "in_progress");
    if (busy) { notify("Кабінет зайнятий — спершу завершіть поточного пацієнта", "error"); return; }
    setStatus(p.id, "in_progress");
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
      .neq("status", "cancelled").neq("status", "no_show");
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
      studies: b.studies || [], doctor: b.doctor, note: b.notes, duration_min: b.dur,
      scheduled_date: dateKey(b.date), scheduled_time: b.time, scheduled_at: at,
      status: "scheduled", call_status: "not_called",
    });
    if (error) { notify(/overlap|exclusion/i.test(error.message) ? "Слот щойно зайняли — оновіть сторінку й оберіть інший час" : "Помилка збереження: " + error.message, "error"); return; }
    setModalOpen(false);
    notify("Новий запис: " + b.name + " · " + b.time, "success");
    if (sameDay(b.date, selectedDate)) reload();
  }

  /* агрегати (scoped — звужено до обраного кабінету в сайдбарі) */
  const scoped = roomView === "all" ? entries : entries.filter((e) => e.room_id === roomView);
  const counts = useMemo(() => {
    const c = { total: scoped.length, scheduled: 0, waiting: 0, in_progress: 0, done: 0, no_show: 0 };
    scoped.forEach((e) => { if (c[e.status] != null) c[e.status]++; });
    return c;
  }, [scoped]);

  // картки кабінетів — по всіх кабінетах (не залежать від фільтра)
  const currentByRoom = {}, nextWaitingByRoom = {};
  entries.forEach((e) => {
    if (e.status === "in_progress") currentByRoom[e.room_id] = e;
  });
  entries.forEach((e) => {
    if (e.status === "waiting" && !nextWaitingByRoom[e.room_id]) nextWaitingByRoom[e.room_id] = e;
  });

  const roomLoad = computeRoomLoad(rooms, entries);

  const sorted = scoped.slice().sort((a, b) => {
    const d = (FLOW[a.status] ?? 9) - (FLOW[b.status] ?? 9);
    if (d !== 0) return d;
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
        incidentCount={incidents.length} onBreakdown={() => setBreakdownOpen(true)}
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
                  <div className="inc-banner-sub">{citoList.slice(0, 3).map((e) => e.patient_name.split(" ").slice(0, 2).join(" ")).join(" · ")}{citoList.length > 3 ? " …" : ""}</div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => setFilter("all")}>Показати чергу</button>
              </div>
            )}
            {isToday && incidents.map((inc) => {
              const r = roomsById[inc.room_id] || {};
              return (
                <div className="inc-banner fade-in" key={inc.id}>
                  <span className="inc-banner-ic">🔧</span>
                  <div className="inc-banner-txt">
                    <div className="inc-banner-title">{r.name || "Апарат"} заблоковано · {inc.reason_label || "Поломка"}
                      {inc.note ? <span className="inc-banner-window">{inc.note}</span> : null}
                    </div>
                    <div className="inc-banner-sub">{(() => { const n = affected.filter((a) => a.room_id === inc.room_id).length; return n > 0 ? n + (n === 1 ? " пацієнт у вікні простою потребує переносу →" : " пацієнтів у вікні простою потребують переносу →") : "Нові виклики на цей апарат призупинено"; })()}</div>
                  </div>
                  <button className="btn btn-secondary btn-sm" onClick={() => resolveIncident(inc)}>🔓 Розблокувати</button>
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
                    patient={currentByRoom[r.id]} enteredAt={currentByRoom[r.id] && currentByRoom[r.id].updated_at}
                    nextWaiting={nextWaitingByRoom[r.id]} blocked={incidentByRoom[r.id]}
                    schedClosed={!incidentByRoom[r.id] && roomSchedClosed(r.id) ? selDayStatus.label : null}
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
                  enteredAt={currentByRoom[roomView] && currentByRoom[roomView].updated_at}
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
                    readOnly={isPast}
                    canCall={!currentByRoom[p.room_id]} rescheduling={affectedIds.has(p.id)}
                    onArrive={arrive} onCall={callPatient} onComplete={openComplete}
                    onNoShow={noShow} onUndo={undo} onCancel={cancelBooking} onSetStatus={(pt, st) => setStatus(pt.id, st)} onSetCall={setCall}
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
            {!isPast && <CallListPanel entries={entries} onSetCall={setCall} />}
          </aside>
        </div>
      </div>

      {modalOpen && <BookingModal rooms={rooms} clinicId={clinicId} onClose={() => setModalOpen(false)} onSave={saveBooking} />}

      {completeFor && (
        <CompletionModal
          patient={completeFor}
          proc={procLabel(completeFor)}
          roomName={(roomsById[completeFor.room_id] || {}).name || "—"}
          enteredAt={completeFor.updated_at}
          onClose={() => setCompleteFor(null)}
          onSuccess={(notes) => finishComplete("done", notes)}
          onFail={(reason, notes) => finishComplete("no_show", [reason, notes].filter(Boolean).join(" — "))}
        />
      )}

      {reschedFor && (
        <RescheduleModal patient={reschedFor} rooms={rooms} clinicId={clinicId} blockedRoomIds={blockedRoomIds} onClose={() => setReschedFor(null)} onConfirm={doReschedule} />
      )}

      {editStudiesFor && (
        <StudyEditModal patient={editStudiesFor} scheduledDate={dayKey} rooms={rooms} onClose={() => setEditStudiesFor(null)} onConfirm={doEditStudies} />
      )}

      {breakdownOpen && (
        <BreakdownModal rooms={rooms} onClose={() => setBreakdownOpen(false)} onConfirm={registerBreakdown} />
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
