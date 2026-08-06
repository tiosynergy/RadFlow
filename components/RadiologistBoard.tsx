"use client";

/* ===== RadFlow — Кабінет радіолога =====
   Дзеркало дошки адміністратора, звужене до авторизованих кабінетів радіолога:
   статуси досліджень (кроки + Неявка/Не відбулося/Повернути) та власні нотатки.
   Перенос, редагування досліджень, скасування, обдзвін і поломки — лише в адміна. */

import { useState, useEffect, useCallback, useRef, useMemo, type MouseEvent } from "react";
import Toast from "@/components/Toast";
import StudyTimer from "@/components/StudyTimer";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import UnreadDot from "@/components/UnreadDot";
import { UnreadChangesMount, useUnreadChanges, useAckWhenVisible } from "@/lib/useUnreadChanges";
import { unreadForEntity, unreadForDate, calendarDayKey } from "@/lib/unreadChanges";
import { useQueueSounds } from "@/lib/useQueueSounds";
import type { OverrunSource } from "@/lib/soundEvents";
import { signOutAndRedirect } from "@/lib/auth";
import { needsClarification, CLARIFY_META, isLate, LATE_META, computeCallBlock } from "@/lib/queueStatus";
import { visibleStuckByRoom, stuckUnknownOf, stuckDateLabel, stuckDeepLink, stuckBlockReason, canCallIntoRoom, STUCK_UNKNOWN_REASON, type StuckStudy } from "@/lib/stuckStudy";
import { roomScheduleFor, dayStatus, type DayOverride } from "@/lib/schedule";
import { diffStudies, studyText, BUFFER_DEFAULT, modalityLabel, modalityShort, modalityKind, isContrastName} from "@/lib/studies";
import { PRIORITY_META, priorityRank, isActiveStatus, type PatientPriority } from "@/lib/priority";
import { incidentEffectiveEnd, incidentExpired, wallNow, wallToday0, setClinicTz } from "@/lib/incidents";
import { quickSearchMatch } from "@/lib/quickSearch";
import { setQueueEntryStatus, setRadiologistNote, previewDelayPlan, type DelayPreview } from "@/app/queue/actions";
import CeoDashboardLink from "@/components/CeoDashboardLink";
import ConfirmDialog from "@/components/ConfirmDialog";
import DelayPlanModal from "@/components/DelayPlanModal";
import type { QueueStatus, Json } from "@/supabase/types";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";
import "@/styles/prototype/radiologist.css";
import NavDrawer from "@/components/NavDrawer";
import SoundToggle from "@/components/SoundToggle";
import { visibleRooms, residualSet, roomOffLabel, bookableRooms } from "@/lib/rooms";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null; schedule?: unknown; active?: boolean | null };
type RadEntry = {
  id: string; patient_name: string | null; patient_phone: string | null; patient_age: number | null;
  patient_sex: string | null; patient_weight: number | null; scheduled_time: string | null; duration_min: number | null; buffer_time_min: number | null;
  status: string; call_status: string | null; studies: Json; studies_original: Json | null; studies_changed_by: string | null; has_contrast: boolean;
  contraindications: boolean; cito: boolean; priority_level: PatientPriority; doctor: string | null; note: string | null; radiologist_note: string | null;
  indication: string | null; room_id: string | null; updated_at: string; in_progress_at: string | null; clarify_at?: string | null;
  off_schedule?: boolean | null;   // 0077 — запис поза графіком (за підтвердженням персоналу)
};
type IncidentRow = { id: string; room_id: string; reason: string; reason_label: string | null; note: string | null; started_at: string; blocked_until: string | null; status: string; auto_unblock: boolean };

const WK = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"];
const WK_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
const MON_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
const MON_NOM = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
function startOfDay(d: Date) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
/* «Сьогодні» — за настінним часом КЛІНІКИ (зона з singleton setClinicTz, який
   виставляється синхронно з пропа clinicTz). Раніше startOfDay(new Date()) давав
   день БРАУЗЕРА, тоді як isLate/computeCallBlock рахувалися по клініці (M-4). */
function today0() { return wallToday0(); }
function sameDay(a: Date, b: Date) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function dowMon(d: Date) { return (d.getDay() + 6) % 7; }
function fmtFull(d: Date) { return WK[d.getDay()] + ", " + d.getDate() + " " + MON_GEN[d.getMonth()] + " " + d.getFullYear(); }
function fmtShort(d: Date) { return d.getDate() + " " + MON_GEN[d.getMonth()]; }
function dateKey(d: Date) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function procLabel(e: { studies?: unknown; note?: string | null }) {
  const s = Array.isArray(e.studies) ? (e.studies as Array<{ type?: string; region?: string; contrast?: boolean }>) : [];
  if (s.length) return s.map((x) => (x.type || "") + (x.region ? " · " + x.region : "") + (x.contrast && !isContrastName(x.region) ? " з контрастом" : "")).join(" + ");
  return e.note || "—";
}
function regionOf(e: { studies?: unknown }) {
  const s = Array.isArray(e.studies) ? (e.studies as Array<{ region?: string }>) : [];
  return s.map((x) => x.region).filter(Boolean).join(", ");
}
function enteredAtOf(e: RadEntry | null | undefined): string | null { return e ? (e.in_progress_at || e.updated_at) : null; }

// H4-4: статус гліфом+кольором (паритет із колл-листом і дошкою адміна), а не лише кольором.
const ST: Record<string, { label: string; cls: string; dot?: boolean; icon?: string }> = {
  scheduled: { label: "В черзі", cls: "gray", icon: "○" },
  waiting: { label: "Очікує", cls: "yellow", icon: "◔" },
  in_progress: { label: "В кабінеті", cls: "blue", dot: true },
  done: { label: "Виконано", cls: "green", icon: "✓" },
  no_show: { label: "Неявка", cls: "red", icon: "✕" },
  not_held: { label: "Не відбулося", cls: "orange", icon: "⊘" },
  cancelled: { label: "Скасовано", cls: "gray", icon: "⊗" },
  // 0079/0080 — слот втрачено через затримку. Радіолог це БАЧИТЬ, але переносить реєстратор/адмін.
  needs_reschedule: { label: "Потребує переносу", cls: "orange", icon: "↻" },
};
const FLOW: Record<string, number> = { in_progress: 0, waiting: 1, scheduled: 2, needs_reschedule: 2.5, done: 3, not_held: 4, no_show: 5 };
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
  in_progress: { label: "В кабінеті", color: "var(--blue-text)" },
  done:        { label: "Виконано",   color: "#30d158" },
};
/* border — не косметика: заливка --blue (#0d6ecf) дає лише 2.75:1 проти --card
   рядка, тобто найнатискуваніша кнопка дошки не відділяється від фону
   (WCAG 1.4.11, поріг 3:1). --blue-line тримає 3.82. Зелена заливка
   відділяється сама (6.89), сірій «виконано» межа теж не завадить. */
const STEP_PRIMARY: Record<string, { icon: string; label: string; bg: string; color: string; border: string }> = {
  scheduled:   { icon: "✓", label: "Пацієнт прийшов",      bg: "var(--blue)",  color: "#fff", border: "1px solid var(--blue-line)" },
  waiting:     { icon: "▶", label: "Викликати в кабінет",  bg: "var(--blue)",  color: "#fff", border: "1px solid var(--blue-line)" },
  in_progress: { icon: "✓", label: "Завершити дослідження", bg: "var(--green)", color: "#04210d", border: "none" },
  done:        { icon: "✓", label: "Дослідження виконано", bg: "var(--card)",  color: "var(--text-faint)", border: "1px solid var(--border-strong)" },
};

// Годинник — за часом ЦЕНТРУ (як і решта дошки), а не браузера радіолога.
function LiveClock({ tz }: { tz?: string }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => { setNow(new Date()); const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" };
  const txt = (() => {
    if (!now) return "--:--:--";
    try { return now.toLocaleTimeString("uk-UA", tz ? { ...opts, timeZone: tz } : opts); }
    catch { return now.toLocaleTimeString("uk-UA", opts); }
  })();
  return <span className="rad-clock tabular" suppressHydrationWarning>🕐 {txt}</span>;
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
  /** с24 — незавершене дослідження цього кабінету з іншої дати (див. lib/stuckStudy.ts). */
  stuck?: StuckStudy | null;
  /** Про «хвости» ще нічого не відомо — не стверджуємо «вільний» (fail-closed). */
  stuckUnknown?: boolean;
  onFinishStuck?: (s: StuckStudy) => void;
  enteredAt?: string | null;
  nextWaiting?: RadEntry | null;
  blocked?: IncidentRow | null;
  schedClosed?: string | boolean | null;
  callBlockReason?: string | null;
  onComplete: (p: RadEntry) => void;
  onCall: (p: RadEntry) => void;
}

function RoomStatusCard({ room, patient, stuck, stuckUnknown, onFinishStuck, enteredAt, nextWaiting, blocked, schedClosed, callBlockReason, onComplete, onCall }: RoomStatusCardProps) {
  const kind = modalityShort(room.modality);
  if (!blocked && schedClosed) {
    return (
      <div className="room-card blocked-card">
        <div className="rc-head">
          <span className={"equip-tile " + modalityKind(room.modality)}>{kind}</span>
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
          <span className={"equip-tile " + modalityKind(room.modality)}>{kind}</span>
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
    <div className={"room-card " + (patient ? "busy" : stuck ? "stuck" : "free")}>
      <div className="rc-head">
        <span className={"equip-tile " + modalityKind(room.modality)}>{kind}</span>
        <div className="rc-h-meta">
          <div className="rc-name">{room.name}</div>
          <div className="rc-model">{room.apparatus_model || ""}</div>
        </div>
        {/* Таймер зворотного відліку (0093) — у шапці плитки, навпроти модальності/назви
            кабінету; розмір вміщує год:хв:сек. ≤5 хв — червоне з пульсацією. */}
        {patient && (
          <StudyTimer variant="mini" size={60} startAt={enteredAt} durationMin={patient.duration_min || 30} bufferMin={patient.buffer_time_min ?? BUFFER_DEFAULT} />
        )}
      </div>
      {patient ? (
        <div className="rc-body rc-body-busy">
          <div className="rc-brow">
            <span className="rc-pat"><span className="pulse-dot" />{patient.patient_name}</span>
          </div>
          <div className="rc-brow">
            <span className="rc-proc" title={procLabel(patient)}>{procLabel(patient)} · {patient.duration_min} хв · {patient.scheduled_time}</span>
            <button className="btn btn-green btn-sm" onClick={() => onComplete(patient)}>✓ Завершити</button>
          </div>
        </div>
      ) : stuck ? (
        /* Кабінет фізично зайнятий незавершеним дослідженням іншого дня: індекс
           0018 не дасть другий in_progress. Закрити можна ПРЯМО ТУТ — перехід на
           архівну дату радіологу не допоможе, бо там уся дошка readOnly
           (ревʼю с24, H2): саме та роль, яка найчастіше й забуває натиснути
           «Завершити», інакше не могла б звільнити власний кабінет. */
        <div className="rc-body rc-body-stuck">
          <div className="rc-stuck-reason"><span aria-hidden="true">⏳</span> Незавершене дослідження від {stuckDateLabel(stuck.scheduled_date)}</div>
          <div className="rc-brow">
            <span className="rc-proc" title={stuck.patient_name}>{stuck.patient_name}</span>
            {onFinishStuck && <button className="btn btn-green btn-sm" onClick={() => onFinishStuck(stuck)}>✓ Завершити</button>}
          </div>
          <div className="rc-brow">
            {/* На архівній даті дошка радіолога readOnly — тому «переглянути», а не
                «відкрити»: закривають хвіст кнопкою вище, тут лише подивитись деталі. */}
            <a className="btn btn-secondary btn-sm" href={stuckDeepLink(stuck, "radiologist")}
               title="Перегляд запису на дошці того дня (дії там недоступні)"
               aria-label={"Переглянути " + stuckDateLabel(stuck.scheduled_date) + " — кабінет " + room.name}>
              Переглянути {stuckDateLabel(stuck.scheduled_date)}
            </a>
          </div>
        </div>
      ) : stuckUnknown ? (
        <div className="rc-body empty">
          <div className="rc-free-row"><span aria-hidden="true">⚠</span><span className="rc-free">Стан кабінету не оновився</span></div>
          <div className="rc-free-sub">Дані про незавершені дослідження не завантажились — оновіть сторінку</div>
        </div>
      ) : (
        <div className="rc-body empty">
          <div className="rc-free-row"><span className="rc-free-dot" /><span className="rc-free">Кабінет вільний</span></div>
          {nextWaiting && (
            <button className="btn btn-primary btn-sm" disabled={!!callBlockReason} title={callBlockReason || "Викликати наступного"} onClick={() => onCall(nextWaiting)}>
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
  startBlockReason?: string | null;
  onArrive: (p: RadEntry) => void;
  onCall: (p: RadEntry) => void;
  onComplete: (p: RadEntry) => void;
  onNoShow: (p: RadEntry) => void;
  onNotHeld: (p: RadEntry) => void;
  onUndo: (p: RadEntry) => void;
  onSetStatus: (p: RadEntry, status: string) => void;
  noteValue?: string | null;
  onSaveNote: (id: string, v: string) => void;
  // 0078–0081 — радіолог може ІНІЦІЮВАТИ перерахунок плану при затримці (не застосовує).
  onDelayPlan?: (p: RadEntry) => void;
  delayLoading?: boolean;
}

function RadQueueRow({ p, dayDate, roomName, roomModel, roomKind, expanded, onToggle, readOnly, canCall, startBlockReason, onArrive, onCall, onComplete, onNoShow, onNotHeld, onUndo, onSetStatus, noteValue, onSaveNote, onDelayPlan, delayLoading }: RadQueueRowProps) {
  /* Контекстні позначки: крапка на рядку = агрегат непрочитаного цього
     запису; гаситься лише при РОЗГОРНУТОМУ рядку з успішно завантаженими
     даними (усередині хука: status === "ready" + лише знімок). */
  const { index: unreadIx } = useUnreadChanges();
  const rowUnread = unreadForEntity(unreadIx, "queue_entry", p.id);
  useAckWhenVisible(expanded ? { kind: "entity", entityType: "queue_entry", entityId: p.id } : null, expanded);
  // «Запізнення» (derived) видно й радіологу; прямий виклик такого пацієнта
  // блокується (рішення ухвалює реєстратура: повернути/перенести/зняти).
  const late = isLate(p.status, dayDate, p.scheduled_time, p.buffer_time_min);
  const overdue = needsClarification(p.status, dayDate, p.scheduled_time) || (p.status === "scheduled" && !!p.clarify_at);
  // «Неявка»/«Не відбулося» — лише ПІСЛЯ часу початку дослідження (не наперед).
  const _startMs = (dayDate && p.scheduled_time) ? (() => { const [h, m] = String(p.scheduled_time).split(":").map(Number); return Date.UTC(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), h || 0, m || 0); })() : null;
  const beforeStart = _startMs != null && wallNow() < _startMs;
  const meta: { label: string; cls: string; dot?: boolean; title?: string; icon?: string } = late ? LATE_META : overdue ? CLARIFY_META : (ST[p.status] || ST.scheduled);
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
          <div className="nm">{isActiveStatus(p.status) && p.priority_level !== "planned" && <span className={"prio-tag " + PRIORITY_META[p.priority_level].tone}>{PRIORITY_META[p.priority_level].short}</span>}{p.patient_name}</div>
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
        <div className="q-room">
          {(() => {
            const arr = Array.isArray(p.studies) ? (p.studies as Array<{ type?: string }>) : [];
            const km = (arr[0] && arr[0].type) || ((roomKind === "МРТ" || roomKind === "КТ") ? roomKind : "");
            if (!km) return null;
            const isCt = km === "КТ";
            return <span style={{ flexShrink: 0, fontSize: "0.625rem", fontWeight: 700, padding: "2px 6px", borderRadius: 5, lineHeight: 1.4, background: isCt ? "var(--orange-bg)" : "var(--blue-bg)", color: isCt ? "var(--orange)" : "var(--blue-text)" }}>{km}</span>;
          })()}
          <b>{roomName}</b>
          {roomModel ? <span style={{ fontSize: "0.6875rem", color: "var(--text-muted)" }}>{roomModel}</span> : null}
        </div>
        <div className="q-status-cell">
          <span className={"badge " + meta.cls} title={meta.title}>{meta.dot && <span className="pulse-dot" style={{ width: 6, height: 6 }} />}{!meta.dot && meta.icon && <span aria-hidden="true" style={{ marginRight: 3 }}>{meta.icon}</span>}{meta.label}</span>
          {/* 0077 — запис зроблено поза графіком кабінету (підтверджено персоналом). */}
          {p.off_schedule && (
            <span className="badge offsched" title="Запис поза графіком кабінету (після закриття або в перерву) — підтверджено персоналом">⏰ Поза графіком</span>
          )}
        </div>
        <UnreadDot markers={rowUnread} /><span className={"q-chev" + (expanded ? " open" : "")} aria-hidden>›</span>
      </div>

      <div className="qrow-detail-wrap">
        <div className="qrow-detail-inner">
          <div className="qrow-detail">
            {/* Дослідження + Показання/Примітка (ліворуч) обтікають таймер (справа, угорі) — як на дошці адміна. */}
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 4, flexWrap: "nowrap" }}>
              <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                {Array.isArray(p.studies) && p.studies.length > 0 && (() => {
                  const sdiff = diffStudies(p.studies_original as Parameters<typeof diffStudies>[0], p.studies as Parameters<typeof diffStudies>[1]);
                  const changed = sdiff.some((d) => d.state !== "kept");
                  return (
                    <div style={{ marginBottom: 8 }}>
                      <div className="qd-sf-lab" style={{ marginBottom: 6 }}>{(p.studies as unknown[]).length > 1 ? "Дослідження (" + (p.studies as unknown[]).length + ")" : "Дослідження"}{changed && <span style={{ color: "var(--orange)", fontWeight: 400 }}> · змінено {p.studies_changed_by === "referrer" ? "направником" : "клінікою"}</span>}{p.contraindications && <span style={{ color: "var(--red)", fontWeight: 600 }}> · ⚠ Протипоказання</span>}</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: "0.8125rem" }}>
                        {sdiff.map((d, i) => (
                          <div key={i} style={{ color: d.state === "added" ? "var(--green)" : d.state === "removed" ? "var(--red)" : "var(--text-secondary)", textDecoration: d.state === "removed" ? "line-through" : "none" }}>
                            {d.state === "added" ? "＋ " : d.state === "removed" ? "－ " : ""}{studyText(d.s)}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
                {(p.note || p.indication) && (
                  <div className="qd-info" style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.8125rem", marginBottom: 4 }}>
                    {p.indication && <span style={{ color: "var(--text-muted)" }}>Показання: {p.indication}</span>}
                    {p.note && <span style={{ color: "var(--text-muted)" }}>Примітка: {p.note}</span>}
                  </div>
                )}
              </div>
              {p.status === "in_progress" && (
                <div className="qd-timer-top" style={{ flex: "0 0 auto" }}>
                  <StudyTimer variant="full" size={106} startAt={p.in_progress_at} durationMin={p.duration_min || 30} bufferMin={p.buffer_time_min ?? BUFFER_DEFAULT} />
                </div>
              )}
            </div>

            {/* 0079/0080 — «Потребує переносу»: радіолог бачить факт, але дій не має.
                Перенос робить реєстратор/адмін (рішення власника), а степер тут відхилив би
                тригер переходів (вийти можна лише в scheduled/cancelled/no_show). */}
            {!readOnly && p.status === "needs_reschedule" && (
              <div className="qd-step">
                <div className="qd-inline-err" role="status">
                  ⚠ Слот втрачено через затримку. Новий час підбирає реєстратура.
                </div>
              </div>
            )}

            {!readOnly && p.status !== "needs_reschedule" && (() => {
              const stepIdx = STEP_ORDER.indexOf(p.status);
              const pb = STEP_PRIMARY[p.status] || STEP_PRIMARY.done;
              const advanceFn = p.status === "scheduled" ? onArrive : p.status === "waiting" ? onCall : p.status === "in_progress" ? onComplete : null;
              const advanceDisabled = !advanceFn || (p.status === "waiting" && (!canCall || !!startBlockReason)) || isFutureRow || late;
              const terminal = p.status === "done" || p.status === "no_show" || p.status === "not_held";
              return (
                <div className="qd-step">
                  <div style={{ position: "relative", padding: "2px 32px 4px" }}>
                    <div style={{ position: "absolute", top: 17, left: 56, right: 56, height: 2, background: "var(--border)" }} />
                    <div style={{ position: "relative", display: "flex", justifyContent: "space-between" }}>
                      {STEP_ORDER.map((key, i) => {
                        const isDone = stepIdx >= 0 && i < stepIdx;
                        const isCur = i === stepIdx;
                        const m = STEP_META[key];
                        // Інваріант БД (0069): у 'done' лише з 'in_progress' — крок «Виконано»
                        // disabled, поки пацієнт не в кабінеті (паритет із дошкою адміна).
                        const stepBlocked = key === "done" && p.status !== "in_progress" && p.status !== "done";
                        const stepDisabled = !canSetStatus || stepBlocked;
                        const stepTitle = !canSetStatus
                          ? "Майбутній запис — статус зміните в день запису"
                          : stepBlocked
                            ? "«Виконано» доступне лише коли пацієнт у кабінеті — спершу проведіть його через кабінет"
                            : "Встановити статус: " + m.label;
                        return (
                          <div key={key} style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 72 }}>
                            <button onClick={stepDisabled ? undefined : act(() => onSetStatus(p, key))} disabled={stepDisabled} title={stepTitle} aria-disabled={stepDisabled}
                              style={{ width: 30, height: 30, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.8125rem", fontWeight: 700, fontVariantNumeric: "tabular-nums", cursor: stepDisabled ? "not-allowed" : "pointer", opacity: stepBlocked ? 0.4 : 1,
                                background: isDone ? "var(--green)" : (isCur ? m.color : "transparent"),
                                border: "1.5px solid " + ((isDone || isCur) ? "transparent" : "var(--border-strong)"),
                                color: isDone ? "#04210d" : (isCur ? "#1c1c1e" : "var(--text-faint)") }}>
                              {isDone ? "✓" : i + 1}
                            </button>
                            <span style={{ marginTop: 8, fontSize: "0.75rem", textAlign: "center", color: isCur ? "var(--text)" : (isDone ? "var(--text-secondary)" : "var(--text-faint)"), fontWeight: isCur ? 700 : 400 }}>{m.label}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0" }}>
                    {terminal ? (
                      p.status === "done" ? (
                        <>
                          <span className="q-noshow-lab" style={{ flex: 1 }}>✓ Виконано</span>
                          <button className="btn btn-secondary btn-sm" onClick={act(onUndo)} title="Повернути пацієнта в чергу (скасувати завершення, без автозапуску)">↩ В чергу</button>
                        </>
                      ) : (
                        <>
                          <span className="q-noshow-lab" style={{ flex: 1 }}>✕ {p.status === "not_held" ? "Не відбулося" : "Неявка"}</span>
                          <button className="btn btn-secondary btn-sm" onClick={act(onUndo)}>↩ Повернути в чергу</button>
                        </>
                      )
                    ) : (
                      <>
                        <button onClick={advanceDisabled || !advanceFn ? undefined : act(advanceFn)} disabled={advanceDisabled}
                          title={late ? "Запізнення понад буферний час — рішення ухвалює реєстратура (повернути/перенести/зняти)" : isFutureRow ? "Майбутній запис — дія доступна в день запису" : (p.status === "waiting" && startBlockReason ? startBlockReason : (p.status === "waiting" && !canCall ? "Кабінет зайнятий — спершу завершіть поточного пацієнта" : ""))}
                          style={{ flex: 8, minWidth: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "9px 8px", borderRadius: 10, fontSize: "0.84375rem", fontWeight: 600, border: pb.border, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                            cursor: advanceDisabled ? "default" : "pointer", opacity: (advanceDisabled && p.status !== "done") ? 0.55 : 1, background: pb.bg, color: pb.color }}>
                          {pb.icon} {pb.label}
                        </button>
                        {!terminal && <button className="btn btn-secondary btn-sm" style={{ flex: 1, minWidth: 0 }} onClick={(e) => { e.stopPropagation(); setMoreOpen((o) => !o); }} title="Більше дій">⋯</button>}
                      </>
                    )}
                  </div>

                  {p.status === "waiting" && advanceDisabled && startBlockReason && (
                    <div style={{ fontSize: "0.75rem", color: "var(--red)", padding: "2px 0 6px" }}>⚠ {startBlockReason}</div>
                  )}

                  {/* 0078–0081 — радіолог бачить, як затримка цього дослідження впливає
                      на чергу, і може ІНІЦІЮВАТИ перерахунок. Застосовує план адмін —
                      модалка відкриється в режимі перегляду (canApply=false). */}
                  {p.status === "in_progress" && onDelayPlan && (
                    <div style={{ padding: "2px 0 6px" }}>
                      <button className="btn btn-secondary btn-sm" disabled={delayLoading} onClick={act(() => onDelayPlan(p))}
                        title="Порахувати, як затримка впливає на чергу (застосовує адміністратор)">
                        {delayLoading ? "⏳ Рахую…" : "📋 План при затримці"}
                      </button>
                    </div>
                  )}

                  {moreOpen && !terminal && (
                    <div style={{ display: "flex", gap: 6, padding: "2px 0 6px", flexWrap: "wrap" }}>
                      <button className="btn btn-secondary btn-sm qd-act-red" disabled={beforeStart} title={beforeStart ? "Доступно від часу початку дослідження" : ""} onClick={act(onNoShow)}>✕ Неявка</button>
                      <button className="btn btn-secondary btn-sm qd-act-red" disabled={beforeStart} title={beforeStart ? "Доступно від часу початку дослідження" : ""} onClick={act(onNotHeld)}>✕ Не відбулося</button>
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

function MiniCalendar({ selectedDate, onSelectDate, overridesByDate, tz, roomSchedules }: { selectedDate: Date; onSelectDate: (d: Date) => void; overridesByDate?: Record<string, DayOverride>; tz?: string; roomSchedules?: unknown[] }) {
  /* Локальна копія сітки (історично окрема від @/components/MiniCalendar).
     Крапки потрібні й тут: радіолог — штатна аудиторія фан-ауту по СВОЇХ
     кабінетах, і його дошка так само вантажить ОДИН день (ревʼю 0133). */
  const { index: unreadIx } = useUnreadChanges();
  // tz передаємо явно: під час SSR модульний singleton не виставлений (він лише
  // клієнтський), і «сьогодні» в сітці розійшлося б із рештою дошки.
  const today = wallToday0(tz);
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
          <button className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shift(-1)} title="Попередній місяць" aria-label="Попередній місяць">‹</button>
          <button className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shift(1)} title="Наступний місяць" aria-label="Наступний місяць">›</button>
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
          const st = dayStatus(ov, cd, roomSchedules);
          const markClosed = st.kind === "closed";
          const markCustom = st.kind === "custom";
          return (
            <button key={d} className={"cal-day" + (isToday ? " today" : "") + (isSel && !isToday ? " selected" : "") + (markClosed ? " holiday" : "") + (markCustom ? " custom" : "")}
              title={st.label || undefined} onClick={() => onSelectDate(startOfDay(cd))}>
              {d}
              {(markClosed || markCustom) && <span className={"cal-sched " + (markClosed ? "closed" : "custom")} />}
            {unreadForDate(unreadIx, calendarDayKey(cd)).length > 0 && <span className="cal-change" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RadSidebar({ rooms, roomNoteOf, roomFilter, setRoomFilter, counts, adminName }: { rooms?: RoomOpt[]; roomNoteOf?: (roomId: string) => string | null; roomFilter: string; setRoomFilter: (s: string) => void; counts: Record<string, number>; adminName?: string }) {
  const router = useRouter();
  const single = (rooms || []).length === 1;
  const initials = (() => { const p = String(adminName || "").trim().split(/\s+/); return ((p[0] || "Р")[0] + (p[1] ? p[1][0] : "")).toUpperCase(); })();
  async function signOut() { await signOutAndRedirect(router); }
  return (
    /* Підписка на позначки: радіолог — адресат маршрутизації по своїх
       кабінетах (0131), тож без маунта його позначки копичились би вічно
       (ревʼю р2, H-2new). */
    <NavDrawer label="авторизовані кабінети">
      <UnreadChangesMount />
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
              <span className={"sb-cab-tile " + modalityKind(r.modality)}>{modalityShort(r.modality)}</span>
              {/* У вимкненого кабінету-залишку замість моделі апарата — причина,
                  чому він досі тут: «вимкнено · 3 записи» (як у Sidebar). */}
              <span className="sb-cab-meta"><span className="sb-cab-name">{r.name}</span><span className="sb-cab-model">{roomNoteOf?.(r.id) || r.apparatus_model || ""}</span></span>
            </button>
          ))}
        </div>
        <div className="sb-section">
          <div className="sb-label">Перейти</div>
          <a href="/radiologist" className="sb-item active"><span className="ic">⌂</span><span className="sb-item-lab">Моя черга</span></a>
          {/* с22: універсальний пошук (область — лише призначені кабінети). */}
          <a href="/search" className="sb-item"><span className="ic">⌕</span><span className="sb-item-lab">Пошук</span></a>
        </div>
      </nav>
      <div className="sb-settings">
        {/* Звукові сповіщення: «пацієнт готовий» + критичні по призначених кабінетах. */}
        <SoundToggle />
      </div>
      <div className="sb-user">
        <div className="avatar" style={{ background: "linear-gradient(135deg,#1a7a36,#0f5d27)" }}>{initials}</div>
        <div className="meta"><div className="nm">{adminName || "Радіолог"}</div><div className="rl">Радіолог</div></div>
        <button onClick={signOut} title="Вийти з акаунта" aria-label="Вийти"
          style={{ marginLeft: "auto", background: "transparent", border: "1px solid var(--border-strong)", color: "var(--text-secondary)", borderRadius: 8, padding: "6px 10px", fontSize: "0.78125rem", cursor: "pointer" }}>
          Вийти
        </button>
      </div>
    </NavDrawer>
  );
}

interface RadiologistBoardProps {
  clinicId: string;
  /** IANA-зона центру (clinics.timezone) — із сервера, а не з браузера. */
  clinicTz: string;
  rooms?: RoomOpt[];
  /** id вимкнених кабінетів, у яких ЩЕ лишились живі записи («кабінети-залишки»).
   *  Вимкнений кабінет ховаємо зі списків, але поки в ньому щось є — він спливає
   *  назад із підписом «вимкнено · N записів». Див. lib/rooms.ts. */
  residualRoomIds?: string[];
  /** Скільки саме лишилось у кожному такому кабінеті — для підпису. */
  residualRoomCounts?: Record<string, number>;
  adminName?: string;
  /** с22 (deep-link зі сторінки «Пошук»): відкрити дошку на цій даті (YYYY-MM-DD). */
  initialDate?: string | null;
  /** с22: id запису, який треба розгорнути після завантаження дня. */
  initialEntry?: string | null;
}

export default function RadiologistBoard({ clinicId, clinicTz, rooms, residualRoomIds, residualRoomCounts, adminName, initialDate = null, initialEntry = null }: RadiologistBoardProps) {
  // Синхронно, до ініціалізаторів useState (selectedDate) — інакше день дошки
  // фіксується по браузеру ще до того, як прилетить tz. Тільки на клієнті.
  if (typeof window !== "undefined") setClinicTz(clinicTz);

  const router = useRouter();   // 0086: зміни кабінетів (SSR-проп) → router.refresh

  /* Списки кабінетів (сайдбар, плитки апаратів) — активні + вимкнені із залишками.
     Самі ЗАПИСИ фільтром не чіпаємо: запит черги й далі йде по ПОВНОМУ переліку
     призначених кабінетів, інакше архів минулого дня у вимкненому кабінеті став
     би невидимим саме тому, що кабінет уже спорожнів. */
  const residual = useMemo(() => residualSet(residualRoomIds), [residualRoomIds]);
  const visRooms = useMemo(() => visibleRooms(rooms, residual), [rooms, residual]);
  // «Єдиний кабінет» рахуємо по ВИДИМИХ: інакше радіолог із двома кабінетами, з
  // яких один вимкнено, не отримав би авто-вибір і сидів би на порожньому «Усі».
  const single = visRooms.length === 1;
  const [entries, setEntries] = useState<RadEntry[]>([]);
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [overrides, setOverrides] = useState<Record<string, DayOverride>>({});
  const [loading, setLoading] = useState(true);
  /* Помилка завантаження ≠ «порожньо» (аудит 2026-07-12, H-6). Найнебезпечніше —
     простої: при збої loadIncidents ставив [] → ЗАБЛОКОВАНИЙ кабінет виглядав
     вільним, і радіолог кликав пацієнта в апарат на ремонті. Тепер тримаємо
     прапорці помилок окремо, старі дані НЕ затираємо, а виклик у кабінет
     блокуємо, поки дані про простої/графік ненадійні. */
  const [entriesErr, setEntriesErr] = useState(false);
  /* с24: незавершені дослідження ПРИЗНАЧЕНИХ кабінетів з інших дат. Окремо від
     `entries` — інакше вчорашній запис давав би вічний звук перевищення і
     ламав лічильники дня. RLS у радіолога ширша за його кабінети, тому область
     звужує сам запит (`.in("room_id", roomIds)`), як і основний лоадер. */
  const [stuck, setStuck] = useState<StuckStudy[]>([]);
  /* Стартове `[]` не відрізнити від «хвостів немає» (ревʼю с24, H1) — тому
     fail-CLOSED: поки не завантажили або запит упав, виклик блокуємо. */
  const [stuckLoaded, setStuckLoaded] = useState(false);
  const [stuckErr, setStuckErr] = useState(false);
  const [stuckFinish, setStuckFinish] = useState<StuckStudy | null>(null);
  const [stuckFinishBusy, setStuckFinishBusy] = useState(false);
  /* Два запити в одному reload — відсікаємо приземлення застарілих (M2). */
  const reqGen = useRef(0);
  const [incidentsErr, setIncidentsErr] = useState(false);
  const [overridesErr, setOverridesErr] = useState(false);
  const safetyErr = incidentsErr || overridesErr;
  /* Для звуку: стартовий [] — «ще не завантажено», а не «простоїв немає» (див.
     QueueBoard): без прапорця давно активний простій звучав би на маунті. */
  const [incidentsLoaded, setIncidentsLoaded] = useState(false);
  const [roomFilter, setRoomFilter] = useState(single ? (visRooms[0]?.id || "all") : "all");
  /* Кабінет-залишок може зникнути зі списку просто під час зміни (закрили останній
     запис) — і фільтр лишився б на кабінеті, якого вже немає у сайдбарі: дошка
     порожня, а кнопки «Усі кабінети» при одному видимому кабінеті теж немає, тобто
     повернутись нічим. Скидаємо на «всі» (або на єдиний, що лишився). */
  useEffect(() => {
    if (roomFilter === "all") return;
    if (visRooms.some((r) => r.id === roomFilter)) return;
    setRoomFilter(single ? (visRooms[0]?.id || "all") : "all");
  }, [visRooms, roomFilter, single]);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  // с22: deep-link «Пошук» → дошка відкривається на даті знайденого запису.
  const [selectedDate, setSelectedDate] = useState(() => {
    if (initialDate && /^\d{4}-\d{2}-\d{2}$/.test(initialDate)) {
      const d = new Date(initialDate + "T00:00:00");
      if (!Number.isNaN(d.getTime())) return d;
    }
    return wallToday0(clinicTz);
  });
  // 0078–0081 — план при затримці: радіолог лише ІНІЦІЮЄ перерахунок (canApply=false).
  const [delayPreview, setDelayPreview] = useState<DelayPreview | null>(null);
  const [delayOpening, setDelayOpening] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Лёгкий тикер для авто-появи статусу «⚠ Уточнити» та перерахунку простоїв.
  const [, setNowTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setNowTick((n) => n + 1), 20000); return () => clearInterval(t); }, []);

  // с22: deep-link «Пошук» → одноразово розгорнути знайдений запис і проскролити.
  const deepLinkDone = useRef(false);
  useEffect(() => {
    if (deepLinkDone.current || !initialEntry || loading) return;
    if (!entries.some((e) => e.id === initialEntry)) { deepLinkDone.current = true; return; }
    deepLinkDone.current = true;
    setExpandedRow(initialEntry);
    setTimeout(() => { document.querySelector(`[data-qrow="${initialEntry}"]`)?.scrollIntoView({ block: "center" }); }, 60);
  }, [entries, loading, initialEntry]);

  const today = wallToday0(clinicTz);
  const isToday = sameDay(selectedDate, today);
  const isPast = selectedDate < today;
  // H1-5/H4-2: минулий день = архів. Підпис давно казав «Архів — лише перегляд»,
  // але readOnly був фіктивним (false) — кнопки дій лишались живими, UI брехав про
  // режим. Тепер минула дата справді read-only (як і має бути для завершеного дня):
  // ряди без дій-кнопок, нотатки лише для читання. Сьогодні/майбутнє — без змін
  // (майбутні ряди й далі disabled через isFutureRow з підказкою).
  const readOnly = isPast;
  const dayKey = dateKey(selectedDate);
  /* roomsById — ПОВНИЙ список призначених кабінетів: за ним резолвиться назва
     кабінету в рядку черги. Ховаємо кабінет зі СПИСКІВ, а не з записів. */
  const roomsById = useMemo(() => { const m: Record<string, RoomOpt> = {}; (rooms || []).forEach((r) => { m[r.id] = r; }); return m; }, [rooms]);
  const roomIds = useMemo(() => (rooms || []).map((r) => r.id), [rooms]);
  const visRoomIds = useMemo(() => visRooms.map((r) => r.id), [visRooms]);
  const offNote = (roomId: string): string | null => {
    const r = roomsById[roomId];
    return r && r.active === false ? roomOffLabel(residualRoomCounts?.[roomId]) : null;
  };

  function notify(msg: string, type = "success") {
    setToast({ msg, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  /* 0078–0081 — радіолог бачить, як затримка впливає на чергу. previewDelayPlan
     рахує все на СЕРВЕРІ (політика центру, графік, простої, настінний час). Радіолог
     план НЕ застосовує — модалка відкриється в режимі перегляду (canApply=false). */
  async function openDelayPlan(p: RadEntry) {
    if (delayOpening) return;
    setDelayOpening(true);
    try {
      const res = await previewDelayPlan(p.id);
      if (!res.ok) { notify("Не вдалося порахувати план: " + res.error, "error"); return; }
      if (!res.preview) { notify("Затримки немає — черга ще встигає", "info"); return; }
      setDelayPreview(res.preview);
    } catch {
      notify("Не вдалося порахувати план — спробуйте ще раз", "error");
    } finally {
      setDelayOpening(false);
    }
  }

  const reload = useCallback(async () => {
    // Транзієнтний «Failed to fetch» (рефреш токена / зміна сесії / мережевий збій)
    // НЕ повинен валитись у Next error overlay — конвенція проєкту.
    const gen = ++reqGen.current;
    try {
      const supabase = createClient();
      // Авто-«Уточнити» (clarify_at) ставить pg_cron (джоб sink-overdue, кожні 5 хв,
      // supabase/cron_jobs.sql) — не смикаємо RPC з read-лоадера (запис у БД на кожен
      // рефетч давав WAL + audit_log + realtime-луну на всі дошки).
      let q = supabase
        .from("queue_entries")
        .select("id, patient_name, patient_phone, patient_age, patient_sex, patient_weight, scheduled_time, duration_min, buffer_time_min, status, call_status, studies, studies_original, studies_changed_by, has_contrast, contraindications, cito, priority_level, doctor, note, radiologist_note, indication, room_id, updated_at, in_progress_at, clarify_at, off_schedule")
        .eq("clinic_id", clinicId)
        .eq("scheduled_date", dayKey)
        .neq("status", "cancelled");
      if (roomIds.length) q = q.in("room_id", roomIds);
      const { data, error } = await q.order("scheduled_time", { ascending: true });
      // PostgREST не кидає — помилку треба читати самому, інакше «збій» = «записів немає».
      if (gen !== reqGen.current) return;              // відповідь застарілого запиту
      if (error) { setEntriesErr(true); setStuckErr(true); return; }   // до хвостів не дійшли — отже не знаємо
      setEntries(data || []);
      setEntriesErr(false);

      /* «Хвости» in_progress з інших дат. Без призначених кабінетів не питаємо
         взагалі: інакше запит пішов би по всій клініці, а радіолог не має
         бачити чужі кабінети. Помилку НЕ ковтаємо — вона блокує виклик. */
      if (roomIds.length) {
        const { data: st, error: stErr } = await supabase
          .from("queue_entries")
          .select("id, room_id, patient_name, scheduled_date")
          .eq("clinic_id", clinicId)
          .eq("status", "in_progress")
          .neq("scheduled_date", dayKey)
          .in("room_id", roomIds);
        if (gen !== reqGen.current) return;
        if (stErr) { setStuckErr(true); return; }       // список НЕ чистимо
        setStuck((st || []) as unknown as StuckStudy[]);
        setStuckErr(false);
        setStuckLoaded(true);
      } else {
        /* Кабінетів не призначено — викликати нікуди, блокувати нічого. */
        setStuck([]); setStuckErr(false); setStuckLoaded(true);
      }
    } catch {
      if (gen !== reqGen.current) return;
      setEntriesErr(true);   // старі рядки лишаються на екрані + банер «черга не оновилась»
      setStuckErr(true);
    } finally {
      if (gen === reqGen.current) setLoading(false);
    }
  }, [clinicId, dayKey, roomIds]);

  const loadIncidents = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("incidents")
        .select("id, room_id, reason, reason_label, note, started_at, blocked_until, status, auto_unblock")
        .eq("clinic_id", clinicId).in("status", ["active", "planned"]);
      // НЕ чистимо incidents: «простоїв немає» — найнебезпечніша брехня на цій дошці.
      if (error) { setIncidentsErr(true); return; }
      setIncidents(data || []);
      setIncidentsErr(false);
      setIncidentsLoaded(true);
    } catch { setIncidentsErr(true); }
  }, [clinicId]);

  const loadOverrides = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data, error } = await supabase.from("schedule_overrides").select("override_date, all_closed, label, rooms").eq("clinic_id", clinicId);
      if (error) { setOverridesErr(true); return; }   // закритий день не має виглядати робочим
      const m: Record<string, DayOverride> = {};
      (data || []).forEach((o) => { m[o.override_date] = o as unknown as DayOverride; });
      setOverrides(m);
      setOverridesErr(false);
    } catch { setOverridesErr(true); }
  }, [clinicId]);

  // Спинер при первой загрузке/смене клиники; лоадеры снимут его по завершении.
  useEffect(() => { setLoading(true); }, [clinicId]);

  // Перезапрос записей при смене дня/кабинетов: realtime-хук слушает только clinicId.
  /* M-1 ревʼю раунду 2: `stuckLoaded` мусить згасати РАЗОМ із датою й клінікою.
     Інакше після «← Сьогодні» список хвостів ще належить попередньому дню, але
     прапорець каже «дані свіжі» — і в кадрі до відповіді другого запиту картка
     знову писала б «Кабінет вільний» із живою кнопкою виклику. Тобто вихідний
     дефект відтворювався б у вікні 100–300 мс. */
  useEffect(() => { setStuckLoaded(false); }, [clinicId, dayKey]);
  useEffect(() => { reload(); }, [reload]);

  // TD-3: единый realtime-паттерн.
  useRealtimeRefetch({
    channelName: clinicId ? "rad-" + clinicId : null,
    subscriptions: [
      /* Поки є кабінет-залишок, зміна запису може прибрати його зі списку —
         а residual приходить SSR-пропом. Без refresh підпис «вимкнено · N»
         лишався б старим. Умова обов'язкова: без залишків це зайвий refresh. */
      { table: "queue_entries", filter: "clinic_id=eq." + clinicId,
        onChange: () => { reload(); if ((residualRoomIds?.length ?? 0) > 0) router.refresh(); } },
      { table: "incidents", filter: "clinic_id=eq." + clinicId, onChange: loadIncidents },
      { table: "schedule_overrides", filter: "clinic_id=eq." + clinicId, onChange: loadOverrides },
      // 0086: rooms — SSR-проп (у радіолога ще й ВІДФІЛЬТРОВАНИЙ призначеними
      // кабінетами); зміни долітають через router.refresh (сервер перерахує підмножину).
      { table: "rooms", filter: "clinic_id=eq." + clinicId, onChange: () => router.refresh() },
    ],
  });

  /* Звукові сповіщення радіолога — ЛИШЕ призначені йому кабінети: записи вже
     обмежені запитом (roomIds), інциденти звужує incidentRoomIds (лоадер бере
     всю клініку). «Пацієнт готовий» — лише сьогодні; критичні — needs_reschedule
     та інцидент, що фактично став активним. Snapshot-логіка поверх лоадерів,
     помилкові snapshot'и baseline не чіпають. */
  // Контракт джерела перевищень — див. QueueBoard (ревʼю M4).
  const overrunSource: OverrunSource[] = entries;
  void overrunSource;
  useQueueSounds({
    /* roomIds У КЛЮЧІ обов'язкові (ревʼю H1): коли радіологу видають новий
       кабінет посеред зміни, запит підтягує його записи — і давно перевищене
       дослідження там прозвучало б як щойно перетнуте. Зміна набору кабінетів
       → тихий re-baseline, як в інцидентів. */
    scopeKey: "rad|" + clinicId + "|" + dayKey + "|" + roomIds.join(","),
    /* Без призначених кабінетів запит записів іде по всій клініці (roomIds
       порожній → без .in-фільтра) — такому радіологу звуки глушимо, щоб не
       озвучувати чужі кабінети. */
    active: roomIds.length > 0,
    entries: loading || entriesErr ? null : entries,
    readyEnabled: isToday,
    incidents: !incidentsLoaded || incidentsErr ? null : incidents,
    incidentRoomIds: roomIds,
    incidentScopeKey: clinicId + "|" + roomIds.join(","), // поза денним scope; новий кабінет → тихий re-baseline
    overrunEnabled: isToday,    // «дослідження довше плану» — лише сьогоднішня дошка
  });

  const selectedOverride = overrides[dayKey] || null;
  /* Лише за графіками кабінетів, які реально працюють: вимкнений кабінет із
     робочою неділею інакше показував би неділю робочою для всього центру. */
  const roomSchedules = bookableRooms(rooms).map((r) => r.schedule);
  const selDayStatus = dayStatus(selectedOverride, selectedDate, roomSchedules);
  // Графік конкретного кабінету — за ПОВНИМ списком (резолв за id).
  const schedOf = (roomId: string) => (rooms || []).find((r) => r.id === roomId)?.schedule;
  function roomSchedClosed(roomId: string) { return roomScheduleFor(selectedDate, roomId, selectedOverride, schedOf(roomId)).closed; }

  // Інциденти, що ВЖЕ діють (без авто-знятих наприкінці вікна).
  const liveIncidents = incidents.filter((i) => !incidentExpired(i));
  const blockingByRoom: Record<string, IncidentRow> = {};
  liveIncidents.forEach((i) => {
    const s = new Date(i.started_at).getTime();
    if (wallNow() >= s && wallNow() < incidentEffectiveEnd(i)) blockingByRoom[i.room_id] = i;
  });

  /* Закриття «хвоста» прямо з картки кабінету (ревʼю с24, H2). Для радіолога це
     ЄДИНИЙ шлях: перехід веде на архівну дату, а там уся дошка readOnly.
     ⚠️ НЕ через локальний setStatus(): той бере expectedFrom із `entries`, а
     хвоста там немає за визначенням (він з іншої дати) — CAS би просто зник.
     Тут expectedFrom задаємо явно: якщо запис уже закрив колега, сервер поверне
     stale, і ми скажемо про це замість тихого перезапису чужої дії. */
  async function confirmStuckFinish() {
    if (!stuckFinish) return;
    const s = stuckFinish;
    setStuckFinishBusy(true);
    try {
      const res = await setQueueEntryStatus(s.id, "done" as QueueStatus, "in_progress" as QueueStatus);
      if (!res.ok) {
        notify(res.code === "stale" ? "Запис уже змінив інший користувач — дошку оновлено" : "Помилка: " + res.error, "error");
        return;
      }
      /* Гасимо картку одразу, не чекаючи відповіді reload: інакше «✓ Завершити»
         ще секунду виглядає доступною і провокує другий клік (ревʼю р2, L1). */
      setStuck((list) => list.filter((x) => x.id !== s.id));
      notify("Дослідження від " + stuckDateLabel(s.scheduled_date) + " завершено — кабінет вільний", "success");
    } catch {
      /* Обрив мережі: Server Action реджектиться. Без catch діалог замерзав із
         вимкненою кнопкою — і для радіолога це єдиний шлях закрити хвіст. */
      notify("Не вдалося завершити — перевірте зв'язок і спробуйте ще раз", "error");
    } finally {
      setStuckFinishBusy(false);
      setStuckFinish(null);
      reload();
    }
  }

  async function setStatus(id: string, status: string) {
    const cur = entries.find((e) => e.id === id);
    if (status === "done" && cur && cur.status !== "in_progress") { notify("«Виконано» можна лише для пацієнта в кабінеті", "error"); return; }
    // Server Action (серверная сессия + единая обработка ошибок); оптимистично локально.
    const nowIso = new Date().toISOString();
    const patch = status === "in_progress" ? { status, in_progress_at: nowIso } : { status };
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, ...patch, updated_at: nowIso } : e)));
    // H-2: cur.status — то, что видит рентгенолог; CAS на сервере.
    const res = await setQueueEntryStatus(id, status as QueueStatus, cur?.status as QueueStatus | undefined);
    if (!res.ok) {
      const msg = res.code === "room_busy" ? "У кабінеті вже є пацієнт — спершу завершіть поточного"
        : res.code === "slot_unavailable" ? "Слот недоступний (простій/зайнято) — зверніться до адміністратора"
        : res.code === "stale" ? "Статус змінив інший користувач — дошку оновлено"
        : "Помилка: " + res.error;
      notify(msg, "error");
      reload();
      return;
    }
    reload();
  }
  async function saveNote(id: string, radiologist_note: string) {
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, radiologist_note } : e)));
    const res = await setRadiologistNote(id, radiologist_note);
    if (!res.ok) notify("Помилка збереження нотатки: " + res.error, "error");
  }

  function callBlockOf(p: RadEntry) {
    const sched = p.room_id ? roomScheduleFor(selectedDate, p.room_id, selectedOverride, schedOf(p.room_id)) : null;
    return computeCallBlock(p, entries, {
      notToday: !sameDay(selectedDate, today0()),
      roomStuck: p.room_id ? stuckRooms[p.room_id] ?? null : null,
      stuckUnknown,
      roomBlocked: !!(p.room_id && blockingByRoom[p.room_id]),
      schedClosed: !!(p.room_id && roomSchedClosed(p.room_id)),
      schedEnd: sched && !sched.closed ? sched.end : null,
    });
  }
  /* 0077: sched_overrun більше НЕ блокує радіолога — рішення власника: центр має
     добити день, і саме радіолог заводить пацієнта в кабінет. Замість «реєстратура
     має перенести запис» — діалог підтвердження. Решта причин лишаються жорсткими. */
  function inProgressBlockReason(p: RadEntry): string | null {
    /* Дані про простої/графік не завантажились — вважати кабінет вільним НЕ МОЖНА
       (це виклик пацієнта в апарат, який може бути на ремонті). Гейт до всіх інших
       перевірок; DB-гард 0020 однаково відхилив би, але оператор має бачити причину. */
    if (safetyErr) return "Дані про простої/графік не оновились — виклик заблоковано, оновіть сторінку";
    const r = callBlockOf(p);
    if (!r || r.confirmable) return null;
    if (r.code === "wrong_day") return "Запис не на сьогодні — викликати в кабінет можна лише пацієнтів сьогоднішнього дня";
    if (r.code === "room_blocked") return "Кабінет заблоковано (поломка/ТО) — зніме адміністратор";
    if (r.code === "room_closed") return "Кабінет зачинено за графіком на цей день";
    if (r.code === "room_busy") return "Кабінет зайнятий — спершу завершіть поточного пацієнта";
    if (r.code === "room_stuck") return stuckBlockReason(r);
    if (r.code === "stuck_unknown") return STUCK_UNKNOWN_REASON;
    if (r.code === "clash") return `Дослідження ${r.durationMin} хв зараз не вміститься — о ${r.time} наступний запис. Реєстратура має перенести один із записів`;
    return null;
  }
  const [offCallAsk, setOffCallAsk] = useState<{ p: RadEntry; end: string; durationMin: number } | null>(null);
  const [offCallBusy, setOffCallBusy] = useState(false);
  function callPatient(p: RadEntry) {
    // safetyErr — жорсткий гейт: підтверджувати виклик на невідомих даних про простої не можна.
    if (safetyErr) { notify("Дані про простої/графік не оновились — виклик заблоковано, оновіть сторінку", "error"); return; }
    const r = callBlockOf(p);
    if (r && !r.confirmable) { notify(inProgressBlockReason(p) || "Викликати зараз неможливо", "error"); return; }
    if (r && r.code === "sched_overrun") { setOffCallAsk({ p, end: r.end, durationMin: r.durationMin }); return; }
    setStatus(p.id, "in_progress");
  }
  function setStatusGuarded(p: RadEntry, status: string) {
    // Запізнення понад буфер: прямий виклик заблоковано (рішення — за реєстратурою).
    if (status === "in_progress" && isLate(p.status, selectedDate, p.scheduled_time, p.buffer_time_min)) {
      notify("Пацієнт запізнився понад буферний час — реєстратура має повернути його в чергу, перенести або зняти запис", "error");
      return;
    }
    // «Виконано» — лише після кабінету (інваріант БД, 0069).
    if (status === "done" && p.status !== "in_progress" && p.status !== "done") {
      notify("«Виконано» можна поставити лише пацієнту, який був у кабінеті", "error");
      return;
    }
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

  const stuckRooms = useMemo(() => visibleStuckByRoom(stuck, dayKey), [stuck, dayKey]);
  const stuckUnknown = stuckUnknownOf(stuckLoaded, stuckErr);
  const currentByRoom: Record<string, RadEntry> = {}, nextWaitingByRoom: Record<string, RadEntry> = {};
  entries.forEach((e) => { if (e.status === "in_progress" && e.room_id) currentByRoom[e.room_id] = e; });
  // «Наступний у черзі» — як і сортування: спершу ЧАС, пріоритет — тай-брейк.
  entries.forEach((e) => {
    if (e.status !== "waiting" || !e.room_id) return;
    const cur = nextWaitingByRoom[e.room_id];
    if (!cur) { nextWaitingByRoom[e.room_id] = e; return; }
    const t = (e.scheduled_time || "").localeCompare(cur.scheduled_time || "");
    if (t < 0 || (t === 0 && priorityRank(e.priority_level) < priorityRank(cur.priority_level))) nextWaitingByRoom[e.room_id] = e;
  });
  const cardRooms = roomFilter === "all" ? visRooms : visRooms.filter((r) => r.id === roomFilter);

  const filtered = scoped.filter((p) => {
    if (filter !== "all" && p.status !== filter) return false;
    // с22: швидкий пошук — спільний предикат (прізвище з будь-якого місця, телефон
    // ЗА ЦИФРАМИ, процедура як і раніше). Порядок рядків не змінюється.
    if (!quickSearchMatch(query, p, procLabel(p))) return false;
    return true;
  }).sort((a, b) => {
    const d = (FLOW[a.status] ?? 9) - (FLOW[b.status] ?? 9);
    if (d !== 0) return d;
    // «Уточнити»: прострочені scheduled опускаються в кінець запланованих.
    const clA = (a.status === "scheduled" && (!!a.clarify_at || needsClarification(a.status, selectedDate, a.scheduled_time))) ? 1 : 0;
    const clB = (b.status === "scheduled" && (!!b.clarify_at || needsClarification(b.status, selectedDate, b.scheduled_time))) ? 1 : 0;
    if (clA !== clB) return clA - clB;
    // У межах статусу — ЗА ЧАСОМ (як на дошці адміна): пріоритет лишається
    // бейджем, але не виносить запис угору. Тай-брейк на однаковий час — пріоритет.
    const t = (a.scheduled_time || "").localeCompare(b.scheduled_time || "");
    if (t !== 0) return t;
    const ac = isActiveStatus(a.status) ? priorityRank(a.priority_level) : 9;
    const bc = isActiveStatus(b.status) ? priorityRank(b.priority_level) : 9;
    return ac - bc;
  });

  return (
    <div className="app">
      <RadSidebar rooms={visRooms} roomNoteOf={offNote} roomFilter={roomFilter} setRoomFilter={setRoomFilter} counts={counts} adminName={adminName} />
      <div className="main">
        <header className="topbar">
          <div className="tb-title">
            <span className="tic">🩺</span>
            <div><h1>Кабінет радіолога</h1><div className="date">{adminName} · Радіолог</div></div>
          </div>
          <div className="tb-right">
            <CeoDashboardLink />
            <span className="rad-date">{fmtFull(selectedDate)}</span>
            <LiveClock tz={clinicTz} />
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
            {/* Банер простою — лише по ВИДИМИХ кабінетах: у виведеного з експлуатації
                й уже порожнього кабінету простій нікого не стосується, а сам кабінет
                на екрані ніде не показано — банер посилався б у нікуди. */}
            {!isPast && liveIncidents.filter((inc) => visRoomIds.includes(inc.room_id)).map((inc) => {
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
              <div className="inc-banner fade-in" style={{ borderColor: selDayStatus.kind === "closed" ? "var(--red)" : "var(--blue-line)" }}>
                <span className="inc-banner-ic">{selDayStatus.kind === "closed" ? "🚫" : "🕐"}</span>
                <div className="inc-banner-txt">
                  <div className="inc-banner-title">{selDayStatus.kind === "closed" ? "Неробочий день" : "Особливий графік"} · {fmtShort(selectedDate)}</div>
                  <div className="inc-banner-sub">{selDayStatus.label}</div>
                </div>
              </div>
            )}

            {/* Збій завантаження ≠ «все добре»: кажемо прямо, що дані ненадійні. */}
            {stuckErr && !safetyErr && !entriesErr && (
              <div className="inc-banner fade-in" style={{ borderColor: "var(--orange)" }} role="alert">
                <span className="inc-banner-ic" aria-hidden="true">⚠</span>
                <div className="inc-banner-txt">
                  <div className="inc-banner-title">Не завантажились дані про незавершені дослідження</div>
                  <div className="inc-banner-sub">Кабінет із забутим дослідженням виглядав би вільним, тому виклики заблоковано до оновлення.</div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => reload()}>↻ Оновити</button>
              </div>
            )}
            {(safetyErr || entriesErr) && (
              <div className="inc-banner fade-in" style={{ borderColor: "var(--red)" }} role="alert">
                <span className="inc-banner-ic">⚠</span>
                <div className="inc-banner-txt">
                  <div className="inc-banner-title">
                    {safetyErr ? "Дані про простої / графік не оновились" : "Черга не оновилась"}
                  </div>
                  <div className="inc-banner-sub">
                    {safetyErr
                      ? "Виклик у кабінет заблоковано — кабінет може бути на ремонті. Оновіть сторінку."
                      : "На екрані — попередні дані. Оновіть сторінку."}
                  </div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => { reload(); loadIncidents(); loadOverrides(); }}>↻ Оновити</button>
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
                    stuck={stuckRooms[r.id]} stuckUnknown={stuckUnknown} onFinishStuck={setStuckFinish}
                    nextWaiting={nextWaitingByRoom[r.id]} blocked={blockingByRoom[r.id]}
                    schedClosed={!blockingByRoom[r.id] && roomSchedClosed(r.id) ? (selDayStatus.label || "Не працює за графіком") : null}
                    callBlockReason={nextWaitingByRoom[r.id] ? inProgressBlockReason(nextWaitingByRoom[r.id]) : null}
                    onComplete={completeProc} onCall={callPatient} />
                ))}
              </div>
            )}

            <div className="qctrl">
              <div className="spacer" />
              <div className="search"><span className="si">⌕</span>
                {/* с22 (ревью HIGH-1): ввід не канонізуємо — цифровий матчинг quickSearchMatch. */}
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
                      readOnly={readOnly} canCall={!stuckUnknown && canCallIntoRoom(p.room_id ? currentByRoom[p.room_id] : null, p.room_id ? stuckRooms[p.room_id] : null)}
                      startBlockReason={p.status === "waiting" ? inProgressBlockReason(p) : null}
                      onArrive={arrive} onCall={callPatient} onComplete={completeProc}
                      onNoShow={noShow} onNotHeld={notHeld} onUndo={undo} onSetStatus={setStatusGuarded}
                      noteValue={p.radiologist_note} onSaveNote={saveNote}
                      onDelayPlan={isToday ? openDelayPlan : undefined} delayLoading={delayOpening} />
                  );
                })}
              </div>
            )}
          </div>
          <aside className="rpanel">
            <MiniCalendar selectedDate={selectedDate} onSelectDate={setSelectedDate} overridesByDate={overrides} tz={clinicTz} roomSchedules={roomSchedules} />
          </aside>
        </div>
      </div>

      {/* 0077 — виклик у кабінет після кінця робочого дня: свідома дія, не заборона. */}
      {stuckFinish && (
        <ConfirmDialog
          title="Завершити дослідження з минулого дня?"
          text={<>
            <b>{stuckFinish.patient_name}</b> — запис від <b>{stuckDateLabel(stuckFinish.scheduled_date)}</b>, який лишився «у кабінеті».
            Поки він відкритий, кабінет <b>{(rooms || []).find((r) => r.id === stuckFinish.room_id)?.name || "—"}</b> зайнятий і викликати наступного пацієнта не можна.
            {" "}Позначити як <b>виконане</b>? Якщо дослідження не відбулося, це має оформити реєстратура на дошці того дня.
          </>}
          confirmLabel="✓ Завершити"
          cancelLabel="Не чіпати"
          busy={stuckFinishBusy}
          onConfirm={confirmStuckFinish}
          onClose={() => setStuckFinish(null)}
        />
      )}

      {offCallAsk && (
        <ConfirmDialog
          title="Викликати поза графіком?"
          text={<><b>{offCallAsk.p.patient_name}</b> · запис о {offCallAsk.p.scheduled_time} · {offCallAsk.durationMin} хв.
            {" "}Кабінет працює до <b>{offCallAsk.end}</b> — робота триватиме понаднормово.</>}
          confirmLabel="⏰ Викликати"
          cancelLabel="Ні"
          busy={offCallBusy}
          onClose={() => setOffCallAsk(null)}
          onConfirm={async () => {
            const a = offCallAsk;
            if (!a) return;
            setOffCallBusy(true);
            await setStatus(a.p.id, "in_progress");
            setOffCallBusy(false);
            setOffCallAsk(null);
          }}
        />
      )}

      {/* 0078–0081 — план при затримці, режим перегляду: радіолог ініціює, але не
          застосовує (canApply=false — і кнопки «Застосувати» в модалці не буде). */}
      {delayPreview && (
        <DelayPlanModal
          preview={delayPreview}
          roomName={roomsById[delayPreview.roomId]?.name || "Кабінет"}
          canApply={false}
          busy={false}
          onClose={() => setDelayPreview(null)}
          onApply={() => { /* радіолог не застосовує — недосяжно при canApply=false */ }}
        />
      )}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
