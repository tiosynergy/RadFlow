"use client";

/* ===== RadFlow — Кабінет радіолога =====
   Дзеркало дошки адміністратора, звужене до авторизованих кабінетів радіолога:
   статуси досліджень (кроки + Неявка/Не відбулося/Повернути) та власні нотатки.
   Перенос, редагування досліджень, скасування, обдзвін і поломки — лише в адміна. */

import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import { signOutAndRedirect } from "@/lib/auth";
import { needsClarification, CLARIFY_META } from "@/lib/queueStatus";
import { roomScheduleFor, dayStatus, type DayOverride } from "@/lib/schedule";
import { diffStudies, studyText } from "@/lib/studies";
import { incidentEffectiveEnd, incidentExpired, wallNow } from "@/lib/incidents";
import type { QueueStatus, Json } from "@/supabase/types";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";
import "@/styles/prototype/radiologist.css";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null };
type RadEntry = {
  id: string; patient_name: string | null; patient_phone: string | null; patient_age: number | null;
  patient_sex: string | null; patient_weight: number | null; scheduled_time: string | null; duration_min: number | null;
  status: string; call_status: string | null; studies: Json; studies_original: Json | null; has_contrast: boolean;
  contraindications: boolean; cito: boolean; doctor: string | null; note: string | null; radiologist_note: string | null;
  indication: string | null; room_id: string | null; updated_at: string; in_progress_at: string | null;
};
type IncidentRow = { id: string; room_id: string; reason: string; reason_label: string | null; note: string | null; started_at: string; blocked_until: string | null; status: string; auto_unblock: boolean };

const WK = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"];
const WK_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
const MON_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
const MON_NOM = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
function startOfDay(d: Date) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function today0() { return startOfDay(new Date()); }
function sameDay(a: Date, b: Date) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function dowMon(d: Date) { return (d.getDay() + 6) % 7; }
function fmtFull(d: Date) { return WK[d.getDay()] + ", " + d.getDate() + " " + MON_GEN[d.getMonth()] + " " + d.getFullYear(); }
function fmtShort(d: Date) { return d.getDate() + " " + MON_GEN[d.getMonth()]; }
function dateKey(d: Date) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function modalityLabel(m: string) { return m === "MRI" ? "МРТ" : m === "CT" ? "КТ" : "Інше"; }
function procLabel(e: { studies?: unknown; note?: string | null }) {
  const s = Array.isArray(e.studies) ? (e.studies as Array<{ type?: string; region?: string; contrast?: boolean }>) : [];
  if (s.length) return s.map((x) => (x.type || "") + (x.region ? " · " + x.region : "") + (x.contrast ? " з контрастом" : "")).join(" + ");
  return e.note || "—";
}
function regionOf(e: { studies?: unknown }) {
  const s = Array.isArray(e.studies) ? (e.studies as Array<{ region?: string }>) : [];
  return s.map((x) => x.region).filter(Boolean).join(", ");
}
function fmtTimer(sec: number) {
  const m = Math.floor(sec / 60), s = sec % 60, h = Math.floor(m / 60);
  if (h) return h + ":" + String(m % 60).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  return m + ":" + String(s).padStart(2, "0");
}
function enteredAtOf(e: RadEntry | null | undefined): string | null { return e ? (e.in_progress_at || e.updated_at) : null; }

const ST: Record<string, { label: string; cls: string; dot?: boolean }> = {
  scheduled: { label: "В черзі", cls: "gray" },
  waiting: { label: "Очікує", cls: "yellow" },
  in_progress: { label: "В кабінеті", cls: "blue", dot: true },
  done: { label: "Виконано", cls: "green" },
  no_show: { label: "Неявка", cls: "red" },
  not_held: { label: "Не відбулося", cls: "orange" },
  cancelled: { label: "Скасовано", cls: "gray" },
};
const FLOW: Record<string, number> = { in_progress: 0, waiting: 1, scheduled: 2, done: 3, not_held: 4, no_show: 5 };
const STAT_ITEMS = [
  { key: "all", lab: "Всього", sub: "досліджень", cls: "white" },
  { key: "scheduled", lab: "В черзі", sub: "записані", cls: "gray" },
  { key: "waiting", lab: "Очікують", sub: "прийшли", cls: "yellow" },
  { key: "in_progress", lab: "В кабінеті", sub: "зараз", cls: "blue" },
  { key: "done", lab: "Виконано", sub: "досліджень", cls: "green" },
  { key: "not_held", lab: "Не відбулося", sub: "не відбулось", cls: "orange" },
];

const STEP_ORDER = ["scheduled", "waiting", "in_progress", "done"];
const STEP_META: Record<string, { label: string; color: string }> = {
  scheduled:   { label: "В черзі",    color: "#aeaeb2" },
  waiting:     { label: "Очікує",     color: "#ffd60a" },
  in_progress: { label: "В кабінеті", color: "#4da3ff" },
  done:        { label: "Виконано",   color: "#30d158" },
};
const STEP_PRIMARY: Record<string, { icon: string; label: string; bg: string; color: string }> = {
  scheduled:   { icon: "✓", label: "Пацієнт прийшов",      bg: "var(--blue)",  color: "#fff" },
  waiting:     { icon: "▶", label: "Викликати в кабінет",  bg: "var(--blue)",  color: "#fff" },
  in_progress: { icon: "✓", label: "Завершити дослідження", bg: "var(--green)", color: "#04210d" },
  done:        { icon: "✓", label: "Дослідження виконано", bg: "var(--card)",  color: "var(--text-faint)" },
};

function LiveClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => { setNow(new Date()); const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  return <span className="rad-clock tabular" suppressHydrationWarning>🕐 {now ? now.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--:--:--"}</span>;
}
function LiveTimer({ enteredAt, children }: { enteredAt?: string | null; children: (sec: number) => ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const sec = enteredAt ? Math.max(0, Math.floor((now - new Date(enteredAt).getTime()) / 1000)) : 0;
  return children(sec);
}

function StatsBar({ counts, filter, setFilter }: { counts: Record<string, number>; filter: string; setFilter: (f: string) => void }) {
  return (
    <div className="stats">
      {STAT_ITEMS.map((s) => (
        <div key={s.key} className={"stat clickable" + (filter === s.key ? " active" : "")} role="button" tabIndex={0}
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

interface RoomStatusCardProps {
  room: RoomOpt;
  patient?: RadEntry | null;
  enteredAt?: string | null;
  nextWaiting?: RadEntry | null;
  blocked?: IncidentRow | null;
  schedClosed?: string | boolean | null;
  onComplete: (p: RadEntry) => void;
  onCall: (p: RadEntry) => void;
}

function RoomStatusCard({ room, patient, enteredAt, nextWaiting, blocked, schedClosed, onComplete, onCall }: RoomStatusCardProps) {
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
          <div className="rc-foot"><span className="rc-blocked-hint">Виклики призупинено (зніме адміністратор)</span></div>
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

interface RadQueueRowProps {
  p: RadEntry;
  dayDate: Date;
  roomName: string;
  roomModel?: string;
  roomKind: string;
  expanded: boolean;
  onToggle: (id: string) => void;
  readOnly: boolean;
  canCall: boolean;
  onArrive: (p: RadEntry) => void;
  onCall: (p: RadEntry) => void;
  onComplete: (p: RadEntry) => void;
  onNoShow: (p: RadEntry) => void;
  onNotHeld: (p: RadEntry) => void;
  onUndo: (p: RadEntry) => void;
  onSetStatus: (p: RadEntry, status: string) => void;
  noteValue?: string | null;
  onSaveNote: (id: string, v: string) => void;
}

function RadQueueRow({ p, dayDate, roomName, roomModel, roomKind, expanded, onToggle, readOnly, canCall, onArrive, onCall, onComplete, onNoShow, onNotHeld, onUndo, onSetStatus, noteValue, onSaveNote }: RadQueueRowProps) {
  const overdue = needsClarification(p.status, dayDate, p.scheduled_time);
  const meta: { label: string; cls: string; dot?: boolean; title?: string } = overdue ? CLARIFY_META : (ST[p.status] || ST.scheduled);
  const dateStr = dayDate ? String(dayDate.getDate()).padStart(2, "0") + "." + String(dayDate.getMonth() + 1).padStart(2, "0") + "." + dayDate.getFullYear() : "";
  const isTodayRow = dayDate ? sameDay(dayDate, today0()) : true;
  const isFutureRow = dayDate ? (!isTodayRow && dayDate > today0()) : false;
  const canSetStatus = !isFutureRow;
  const [moreOpen, setMoreOpen] = useState(false);
  const [note, setNote] = useState(noteValue || "");
  useEffect(() => { setNote(noteValue || ""); }, [p.id, noteValue]);
  const proc = procLabel(p);
  const act = (fn: (p: RadEntry) => void) => (e: MouseEvent) => { e.stopPropagation(); fn(p); };
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
          <div className="du">{roomKind}{regionOf(p) ? " · " + regionOf(p) : ""}</div>
        </div>
        <div className="q-room" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3 }}>
          {(() => {
            const arr = Array.isArray(p.studies) ? (p.studies as Array<{ type?: string }>) : [];
            const km = (arr[0] && arr[0].type) || ((roomKind === "МРТ" || roomKind === "КТ") ? roomKind : "");
            if (!km) return null;
            const isCt = km === "КТ";
            return <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 5, lineHeight: 1.4, background: isCt ? "var(--orange-bg)" : "var(--blue-bg)", color: isCt ? "var(--orange)" : "#4da3ff" }}>{km}</span>;
          })()}
          <b>{roomName}</b>
          {roomModel ? <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{roomModel}</span> : null}
        </div>
        <div className="q-status-cell">
          <span className={"badge " + meta.cls} title={meta.title}>{meta.dot && <span className="pulse-dot" style={{ width: 6, height: 6 }} />}{meta.label}</span>
        </div>
        <span className={"q-chev" + (expanded ? " open" : "")} aria-hidden>›</span>
      </div>

      <div className="qrow-detail-wrap">
        <div className="qrow-detail-inner">
          <div className="qrow-detail">
            {Array.isArray(p.studies) && p.studies.length > 0 && (() => {
              const sdiff = diffStudies(p.studies_original as Parameters<typeof diffStudies>[0], p.studies as Parameters<typeof diffStudies>[1]);
              const changed = sdiff.some((d) => d.state !== "kept");
              return (
                <div style={{ marginBottom: 8 }}>
                  <div className="qd-sf-lab" style={{ marginBottom: 6 }}>{(p.studies as unknown[]).length > 1 ? "Дослідження (" + (p.studies as unknown[]).length + ")" : "Дослідження"}{changed && <span style={{ color: "var(--orange)", fontWeight: 400 }}> · змінено</span>}</div>
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
            {(p.contraindications || p.note || p.indication) && (
              <div className="qd-info" style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, marginBottom: 4 }}>
                {p.contraindications && <span style={{ color: "var(--red)", fontWeight: 600 }}>⚠ Протипоказання</span>}
                {p.indication && <span style={{ color: "var(--text-muted)" }}>Показання: {p.indication}</span>}
                {p.note && <span style={{ color: "var(--text-muted)" }}>Примітка: {p.note}</span>}
              </div>
            )}

            {!readOnly && (() => {
              const stepIdx = STEP_ORDER.indexOf(p.status);
              const pb = STEP_PRIMARY[p.status] || STEP_PRIMARY.done;
              const advanceFn = p.status === "scheduled" ? onArrive : p.status === "waiting" ? onCall : p.status === "in_progress" ? onComplete : null;
              const advanceDisabled = !advanceFn || (p.status === "waiting" && !canCall) || isFutureRow;
              const terminal = p.status === "done" || p.status === "no_show" || p.status === "not_held";
              return (
                <div className="qd-step">
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

                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0" }}>
                    {(p.status === "no_show" || p.status === "not_held") ? (
                      <>
                        <span className="q-noshow-lab" style={{ flex: 1 }}>✕ {p.status === "not_held" ? "Не відбулося" : "Неявка"}</span>
                        <button className="btn btn-secondary btn-sm" onClick={act(onUndo)}>↩ Повернути в чергу</button>
                      </>
                    ) : (
                      <>
                        <button onClick={advanceDisabled || !advanceFn ? undefined : act(advanceFn)} disabled={advanceDisabled}
                          title={isFutureRow ? "Майбутній запис — дія доступна в день запису" : (p.status === "waiting" && !canCall ? "Кабінет зайнятий — спершу завершіть поточного пацієнта" : "")}
                          style={{ flex: 8, minWidth: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "9px 8px", borderRadius: 10, fontSize: 13.5, fontWeight: 600, border: "none", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                            cursor: advanceDisabled ? "default" : "pointer", opacity: (advanceDisabled && p.status !== "done") ? 0.55 : 1, background: pb.bg, color: pb.color }}>
                          {pb.icon} {pb.label}
                        </button>
                        {!terminal && <button className="btn btn-secondary btn-sm" style={{ flex: 1, minWidth: 0 }} onClick={(e) => { e.stopPropagation(); setMoreOpen((o) => !o); }} title="Більше дій">⋯</button>}
                      </>
                    )}
                  </div>

                  {moreOpen && !terminal && (
                    <div style={{ display: "flex", gap: 6, padding: "2px 0 6px", flexWrap: "wrap" }}>
                      <button className="btn btn-secondary btn-sm qd-act-red" onClick={act(onNoShow)}>✕ Неявка</button>
                      <button className="btn btn-secondary btn-sm qd-act-red" onClick={act(onNotHeld)}>✕ Не відбулося</button>
                    </div>
                  )}
                </div>
              );
            })()}

            <div className="pd-notes" style={{ marginTop: 8 }}>
              <span className="qd-sf-lab">Примітки радіолога {!readOnly && <span className="pd-autosave">· автозбереження</span>}</span>
              <textarea className="pd-textarea" rows={3} placeholder={readOnly ? "—" : "Внутрішня нотатка (видно команді)…"} value={note} disabled={readOnly}
                onChange={(e) => setNote(e.target.value)} onBlur={(e) => onSaveNote(p.id, e.target.value)} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniCalendar({ selectedDate, onSelectDate, overridesByDate }: { selectedDate: Date; onSelectDate: (d: Date) => void; overridesByDate?: Record<string, DayOverride> }) {
  const today = today0();
  const ovMap = overridesByDate || {};
  const [viewMonth, setViewMonth] = useState(() => new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
  const shift = (n: number) => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  const y = viewMonth.getFullYear(), mo = viewMonth.getMonth();
  const first = new Date(y, mo, 1);
  const days = new Date(y, mo + 1, 0).getDate();
  const startIdx = dowMon(first);
  const cells: (number | null)[] = [];
  for (let i = 0; i < startIdx; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  return (
    <div className="bk-cal">
      <div className="cal-head">
        <span className="cal-month">{MON_NOM[mo]} {y}</span>
        <div className="cal-nav">
          <button className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shift(-1)}>‹</button>
          <button className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shift(1)}>›</button>
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
    </div>
  );
}

function RadSidebar({ rooms, roomFilter, setRoomFilter, counts, adminName }: { rooms?: RoomOpt[]; roomFilter: string; setRoomFilter: (s: string) => void; counts: Record<string, number>; adminName?: string }) {
  const router = useRouter();
  const single = (rooms || []).length === 1;
  const initials = (() => { const p = String(adminName || "").trim().split(/\s+/); return ((p[0] || "Р")[0] + (p[1] ? p[1][0] : "")).toUpperCase(); })();
  async function signOut() { await signOutAndRedirect(router); }
  return (
    <aside className="sidebar">
      <div className="sb-head">
        <a href="/queue" className="sb-logo"><span className="dot" />RadFlow</a>
        <div className="sb-sub">Радіолог · робоче місце</div>
      </div>
      <nav className="sb-nav">
        <div className="sb-section">
          <div className="sb-label">Авторизовані кабінети</div>
          {!single && (
            <button className={"sb-cab sb-cab-btn" + (roomFilter === "all" ? " active" : "")} style={{ width: "100%", textAlign: "left", border: "none", cursor: "pointer" }} onClick={() => setRoomFilter("all")}>
              <span className="sb-cab-tile" style={{ background: "var(--card-hover)", color: "var(--text-secondary)" }}>▦</span>
              <span className="sb-cab-meta"><span className="sb-cab-name">Усі кабінети</span><span className="sb-cab-model">{(rooms || []).length} апаратів · {counts.total} у черзі</span></span>
            </button>
          )}
          {(rooms || []).map((r) => (
            <button key={r.id} className={"sb-cab sb-cab-btn" + (roomFilter === r.id ? " active" : "")} style={{ width: "100%", textAlign: "left", border: "none", cursor: "pointer" }} onClick={() => setRoomFilter(r.id)}>
              <span className={"sb-cab-tile " + (r.modality === "MRI" ? "mrt" : "ct")}>{modalityLabel(r.modality)}</span>
              <span className="sb-cab-meta"><span className="sb-cab-name">{r.name}</span><span className="sb-cab-model">{r.apparatus_model || ""}</span></span>
            </button>
          ))}
        </div>
        <div className="sb-section">
          <div className="sb-label">Перейти</div>
          <a href="/queue" className="sb-item"><span className="ic">▦</span><span className="sb-item-lab">Дошка черги</span></a>
          <a href="/radiologist" className="sb-item"><span className="ic">⌂</span><span className="sb-item-lab">Моя черга</span></a>
        </div>
      </nav>
      <div className="sb-user">
        <div className="avatar" style={{ background: "linear-gradient(135deg,#30d158,#1a7a36)" }}>{initials}</div>
        <div className="meta"><div className="nm">{adminName || "Радіолог"}</div><div className="rl">Радіолог</div></div>
        <button onClick={signOut} title="Вийти з акаунта" aria-label="Вийти"
          style={{ marginLeft: "auto", background: "transparent", border: "1px solid var(--border-strong)", color: "var(--text-secondary)", borderRadius: 8, padding: "6px 10px", fontSize: 12.5, cursor: "pointer" }}>
          Вийти
        </button>
      </div>
    </aside>
  );
}

interface RadiologistBoardProps {
  clinicId: string;
  rooms?: RoomOpt[];
  adminName?: string;
}

export default function RadiologistBoard({ clinicId, rooms, adminName }: RadiologistBoardProps) {
  const single = (rooms || []).length === 1;
  const [entries, setEntries] = useState<RadEntry[]>([]);
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [overrides, setOverrides] = useState<Record<string, DayOverride>>({});
  const [loading, setLoading] = useState(true);
  const [roomFilter, setRoomFilter] = useState(single ? (rooms?.[0]?.id || "all") : "all");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(() => today0());
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Лёгкий тикер для авто-появи статусу «⚠ Уточнити» та перерахунку простоїв.
  const [, setNowTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setNowTick((n) => n + 1), 20000); return () => clearInterval(t); }, []);

  const today = today0();
  const isToday = sameDay(selectedDate, today);
  const isPast = selectedDate < today;
  const readOnly = false;
  const dayKey = dateKey(selectedDate);
  const roomsById = useMemo(() => { const m: Record<string, RoomOpt> = {}; (rooms || []).forEach((r) => { m[r.id] = r; }); return m; }, [rooms]);
  const roomIds = useMemo(() => (rooms || []).map((r) => r.id), [rooms]);

  function notify(msg: string, type = "success") {
    setToast({ msg, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  const reload = useCallback(async () => {
    const supabase = createClient();
    let q = supabase
      .from("queue_entries")
      .select("id, patient_name, patient_phone, patient_age, patient_sex, patient_weight, scheduled_time, duration_min, status, call_status, studies, studies_original, has_contrast, contraindications, cito, doctor, note, radiologist_note, indication, room_id, updated_at, in_progress_at")
      .eq("clinic_id", clinicId)
      .eq("scheduled_date", dayKey)
      .neq("status", "cancelled");
    if (roomIds.length) q = q.in("room_id", roomIds);
    const { data } = await q.order("scheduled_time", { ascending: true });
    setEntries(data || []);
    setLoading(false);
  }, [clinicId, dayKey, roomIds]);

  const loadIncidents = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("incidents")
      .select("id, room_id, reason, reason_label, note, started_at, blocked_until, status, auto_unblock")
      .eq("clinic_id", clinicId).in("status", ["active", "planned"]);
    setIncidents(data || []);
  }, [clinicId]);

  const loadOverrides = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase.from("schedule_overrides").select("override_date, all_closed, label, rooms").eq("clinic_id", clinicId);
    const m: Record<string, DayOverride> = {};
    (data || []).forEach((o) => { m[o.override_date] = o as unknown as DayOverride; });
    setOverrides(m);
  }, [clinicId]);

  // Спинер при первой загрузке/смене клиники; лоадеры снимут его по завершении.
  useEffect(() => { setLoading(true); }, [clinicId]);

  // Перезапрос записей при смене дня/кабинетов: realtime-хук слушает только clinicId.
  useEffect(() => { reload(); }, [reload]);

  // TD-3: единый realtime-паттерн.
  useRealtimeRefetch({
    channelName: clinicId ? "rad-" + clinicId : null,
    subscriptions: [
      { table: "queue_entries", filter: "clinic_id=eq." + clinicId, onChange: reload },
      { table: "incidents", filter: "clinic_id=eq." + clinicId, onChange: loadIncidents },
      { table: "schedule_overrides", filter: "clinic_id=eq." + clinicId, onChange: loadOverrides },
    ],
  });

  const selectedOverride = overrides[dayKey] || null;
  const selDayStatus = dayStatus(selectedOverride, selectedDate);
  function roomSchedClosed(roomId: string) { return roomScheduleFor(selectedDate, roomId, selectedOverride).closed; }

  // Інциденти, що ВЖЕ діють (без авто-знятих наприкінці вікна).
  const liveIncidents = incidents.filter((i) => !incidentExpired(i));
  const blockingByRoom: Record<string, IncidentRow> = {};
  liveIncidents.forEach((i) => {
    const s = new Date(i.started_at).getTime();
    if (wallNow() >= s && wallNow() < incidentEffectiveEnd(i)) blockingByRoom[i.room_id] = i;
  });

  async function setStatus(id: string, status: string) {
    const cur = entries.find((e) => e.id === id);
    if (status === "done" && cur && cur.status !== "in_progress") { notify("«Виконано» можна лише для пацієнта в кабінеті", "error"); return; }
    const supabase = createClient();
    const nowIso = new Date().toISOString();
    const patch = status === "in_progress" ? { status: status as QueueStatus, in_progress_at: nowIso } : { status: status as QueueStatus };
    const { error } = await supabase.from("queue_entries").update(patch).eq("id", id);
    if (error) {
      let msg;
      if (status === "in_progress" && /in_progress|duplicate|23505/i.test(error.message)) msg = "У кабінеті вже є пацієнт — спершу завершіть поточного";
      else if (/incident/i.test(error.message)) msg = "Кабінет у простої (поломка/ТО) — дію заблоковано";
      else if (/overlap|exclusion/i.test(error.message)) msg = "Слот недоступний — зверніться до адміністратора";
      else msg = "Помилка: " + error.message;
      notify(msg, "error"); return;
    }
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, ...patch, updated_at: nowIso } : e)));
    reload();
  }
  async function saveNote(id: string, radiologist_note: string) {
    const supabase = createClient();
    await supabase.from("queue_entries").update({ radiologist_note }).eq("id", id);
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, radiologist_note } : e)));
  }

  function inProgressBlockReason(p: RadEntry): string | null {
    if (p.room_id && blockingByRoom[p.room_id]) return "Кабінет заблоковано (поломка/ТО) — зніме адміністратор";
    if (p.room_id && roomSchedClosed(p.room_id)) return "Кабінет зачинено за графіком на цей день";
    if (entries.some((e) => e.room_id === p.room_id && e.status === "in_progress" && e.id !== p.id)) return "Кабінет зайнятий — спершу завершіть поточного пацієнта";
    return null;
  }
  function callPatient(p: RadEntry) {
    const reason = inProgressBlockReason(p);
    if (reason) { notify(reason, "error"); return; }
    setStatus(p.id, "in_progress");
  }
  function setStatusGuarded(p: RadEntry, status: string) {
    if (status === "in_progress") { callPatient(p); return; }
    setStatus(p.id, status);
  }
  const arrive = (p: RadEntry) => setStatus(p.id, "waiting");
  const completeProc = (p: RadEntry) => setStatus(p.id, "done");
  const noShow = (p: RadEntry) => setStatus(p.id, "no_show");
  const notHeld = (p: RadEntry) => setStatus(p.id, "not_held");
  const undo = (p: RadEntry) => setStatus(p.id, "scheduled");

  const scoped = roomFilter === "all" ? entries : entries.filter((e) => e.room_id === roomFilter);
  const counts: Record<string, number> = { total: scoped.length, scheduled: 0, waiting: 0, in_progress: 0, done: 0, no_show: 0, not_held: 0 };
  scoped.forEach((e) => { if (counts[e.status] != null) counts[e.status]++; });
  const citoList = scoped.filter((e) => e.cito && (e.status === "scheduled" || e.status === "waiting" || e.status === "in_progress"));

  const currentByRoom: Record<string, RadEntry> = {}, nextWaitingByRoom: Record<string, RadEntry> = {};
  entries.forEach((e) => { if (e.status === "in_progress" && e.room_id) currentByRoom[e.room_id] = e; });
  entries.forEach((e) => {
    if (e.status !== "waiting" || !e.room_id) return;
    const cur = nextWaitingByRoom[e.room_id];
    if (!cur || (e.cito && !cur.cito)) nextWaitingByRoom[e.room_id] = e;
  });
  const cardRooms = roomFilter === "all" ? (rooms || []) : (rooms || []).filter((r) => r.id === roomFilter);

  const filtered = scoped.filter((p) => {
    if (filter !== "all" && p.status !== filter) return false;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      if (!((p.patient_name || "").toLowerCase().includes(q) || procLabel(p).toLowerCase().includes(q) || (p.patient_phone || "").includes(q))) return false;
    }
    return true;
  }).sort((a, b) => {
    const d = (FLOW[a.status] ?? 9) - (FLOW[b.status] ?? 9);
    if (d !== 0) return d;
    const ac = (a.cito && (a.status === "scheduled" || a.status === "waiting" || a.status === "in_progress")) ? 0 : 1;
    const bc = (b.cito && (b.status === "scheduled" || b.status === "waiting" || b.status === "in_progress")) ? 0 : 1;
    if (ac !== bc) return ac - bc;
    return (a.scheduled_time || "").localeCompare(b.scheduled_time || "");
  });

  return (
    <div className="app">
      <RadSidebar rooms={rooms} roomFilter={roomFilter} setRoomFilter={setRoomFilter} counts={counts} adminName={adminName} />
      <div className="main">
        <header className="topbar">
          <div className="tb-title">
            <span className="tic">🩺</span>
            <div><h1>Кабінет радіолога</h1><div className="date">{adminName} · Радіолог</div></div>
          </div>
          <div className="tb-right">
            <span className="rad-date">{fmtFull(selectedDate)}</span>
            <LiveClock />
            <span className="rt-pill"><span className="pulse-dot" style={{ background: "var(--green)", width: 7, height: 7 }} />Real-time</span>
            <span className="rad-counter">Опрацьовано: <b>{counts.done}</b> / {counts.total}</span>
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
              </div>
            )}
            {!isPast && liveIncidents.filter((inc) => roomIds.includes(inc.room_id)).map((inc) => {
              const r = roomsById[inc.room_id];
              const nowBlocking = !!blockingByRoom[inc.room_id] && blockingByRoom[inc.room_id].id === inc.id;
              const startStr = new Date(inc.started_at).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
              return (
                <div className="inc-banner fade-in" key={inc.id} style={nowBlocking ? undefined : { borderColor: "var(--orange)" }}>
                  <span className="inc-banner-ic">{nowBlocking ? "🔧" : "🗓"}</span>
                  <div className="inc-banner-txt">
                    <div className="inc-banner-title">{r?.name || "Апарат"} {nowBlocking ? "заблоковано" : "— заплановано простій"} · {inc.reason_label || "Поломка"}
                      {inc.note ? <span className="inc-banner-window">{inc.note}</span> : null}
                    </div>
                    <div className="inc-banner-sub">{nowBlocking ? "Виклики на цей апарат призупинено · зніме адміністратор" : "Заплановано з " + startStr + " · виклики поки працюють"}</div>
                  </div>
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
              </div>
            )}

            {!isToday && (
              <div className="day-banner" style={{ marginBottom: 14 }}>
                <span className="db-ic">{isPast ? "🗂" : "📅"}</span>
                <div className="db-meta">
                  <div className="db-title">{fmtFull(selectedDate)}</div>
                  <div className="db-sub">{counts.total === 0 ? "Записів немає" : (isPast ? "Архів — день завершено · лише перегляд" : "Заплановані дослідження") + " · " + counts.total + " записів"}</div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => setSelectedDate(today0())}>← Сьогодні</button>
              </div>
            )}

            <StatsBar counts={counts} filter={filter} setFilter={setFilter} />

            {isToday && cardRooms.length > 0 && (
              <div className="room-cards">
                {cardRooms.map((r) => (
                  <RoomStatusCard key={r.id} room={r}
                    patient={currentByRoom[r.id]} enteredAt={enteredAtOf(currentByRoom[r.id])}
                    nextWaiting={nextWaitingByRoom[r.id]} blocked={blockingByRoom[r.id]}
                    schedClosed={!blockingByRoom[r.id] && roomSchedClosed(r.id) ? selDayStatus.label : null}
                    onComplete={completeProc} onCall={callPatient} />
                ))}
              </div>
            )}

            <div className="qctrl">
              <div className="spacer" />
              <div className="search"><span className="si">⌕</span>
                <input placeholder="Пошук пацієнта…" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
            </div>

            <div className="qhead">
              <div>Час</div><div>Пацієнт</div><div>Дослідження</div><div>Кабінет</div><div>Статус</div><div />
            </div>

            {loading ? (
              <div className="empty"><div className="et">Завантаження…</div></div>
            ) : filtered.length === 0 ? (
              <div className="empty"><div className="ei">⌕</div><div className="et">{entries.length === 0 ? "Записів на цей день немає" : "Нічого не знайдено"}</div><div className="es">Змініть фільтр, кабінет або пошук</div></div>
            ) : (
              <div className="qrows">
                {filtered.map((p) => {
                  const r = p.room_id ? roomsById[p.room_id] : undefined;
                  return (
                    <RadQueueRow key={p.id} p={p} dayDate={selectedDate}
                      roomName={r?.name || "—"} roomModel={r?.apparatus_model || ""} roomKind={modalityLabel(r?.modality || "")}
                      expanded={expandedRow === p.id} onToggle={(id) => setExpandedRow((x) => (x === id ? null : id))}
                      readOnly={readOnly} canCall={!(p.room_id && currentByRoom[p.room_id])}
                      onArrive={arrive} onCall={callPatient} onComplete={completeProc}
                      onNoShow={noShow} onNotHeld={notHeld} onUndo={undo} onSetStatus={setStatusGuarded}
                      noteValue={p.radiologist_note} onSaveNote={saveNote} />
                  );
                })}
              </div>
            )}
          </div>
          <aside className="rpanel">
            <MiniCalendar selectedDate={selectedDate} onSelectDate={setSelectedDate} overridesByDate={overrides} />
          </aside>
        </div>
      </div>

      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "var(--card)", border: "1px solid var(--border-strong)", borderLeft: "4px solid " + (toast.type === "error" ? "var(--red)" : "var(--green)"), borderRadius: 12, padding: "12px 18px", boxShadow: "var(--shadow-pop)", zIndex: 50, fontSize: 13.5 }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
