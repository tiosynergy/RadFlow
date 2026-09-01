"use client";

/* ===== RadFlow — Дошка черги (повна) ===== */

import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode, type MouseEvent } from "react";
import { isRoomBookable, ROOM_OFF_LABEL, visibleRooms, residualSet, roomOffLabel, bookableRooms } from "@/lib/rooms";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import { useQueueSounds } from "@/lib/useQueueSounds";
import { isStudyOverrun, type OverrunSource } from "@/lib/soundEvents";
import { serverNow } from "@/lib/serverClock";
import { useFollowToday, dayOfKey, dayShiftNoticeOf, dayShiftNoticeVisible, type DayShiftNotice } from "@/lib/useFollowToday";
import {
  setQueueEntryStatus,
  cancelQueueEntry,
  completeQueueEntry,
  setQueueEntryCall,
  resolveIncident as resolveIncidentAction,
  submitIncident as submitIncidentAction,
  emergencyStop as emergencyStopAction,
  resolveEmergency as resolveEmergencyAction,
  saveScheduleOverride,
  resetScheduleOverride,
  rescheduleQueueEntry,
  editQueueEntryStudies,
  createBooking,
  createCase,
  caseFromEntry,
  setQueuePriority,
  previewDelayPlan,
  applyDelayPlan,
  type DelayPreview,
} from "@/app/queue/actions";
import Sidebar from "@/components/Sidebar";
import LiveClock from "@/components/LiveClock";
import BookingModal, { type BookingPayload } from "@/components/BookingModal";
import WaitlistCandidatesModal, { fetchWaitlistCandidates, type FreedSlotInfo } from "@/components/WaitlistCandidatesModal";
import { addEntryToWaitlist } from "@/app/waitlist/actions";
import type { WaitlistEntry } from "@/supabase/types";
import PatientEditModal from "@/components/PatientEditModal";
import CompletionModal from "@/components/CompletionModal";
import RescheduleModal, { type RescheduleStudy } from "@/components/RescheduleModal";
import StudyEditModal from "@/components/StudyEditModal";
import CaseModal from "@/components/CaseModal";
import BreakdownModal from "@/components/BreakdownModal";
import EmergencyModal from "@/components/EmergencyModal";
import ConfirmDialog from "@/components/ConfirmDialog";
import RealtimeBadge from "@/components/RealtimeBadge";
import DelayPlanModal, { type DelayApplyPayload } from "@/components/DelayPlanModal";
import MiniCalendar from "@/components/MiniCalendar";
import ScheduleEditModal from "@/components/ScheduleEditModal";
import HelpTip from "@/components/HelpTip";
import RoomDayOverviewModal from "@/components/RoomDayOverviewModal";
import { overrideFeed, roomScheduleFor, roomScheduleFromFeed, roomBreaksFromFeed, dayStatusFromFeed, offScheduleKind, dateKeyOf, type OverrideFeed, type DayOverride } from "@/lib/schedule";
import { slotToMin, slotFmt } from "@/lib/slots";
import { SAFETY_BOOKING_BLOCKED } from "@/lib/availabilityTrust";
import { needsClarification, CLARIFY_META, isLate, LATE_META, computeCallBlock, collisionFor, SAFETY_UNKNOWN_REASON, type CollisionInfo } from "@/lib/queueStatus";
import { visibleStuckByRoom, stuckUnknownOf, stuckDateLabel, stuckDeepLink, stuckBlockReason, canCallIntoRoom, STUCK_UNKNOWN_REASON, type StuckStudy } from "@/lib/stuckStudy";
import CollisionPanel from "@/components/CollisionPanel";
import QuickRescheduleButton from "@/components/QuickRescheduleButton";
import StudyTimer from "@/components/StudyTimer";
import { diffStudies, studyText, BUFFER_DEFAULT, modalityLabel, modalityShort, modalityKind, isContrastName} from "@/lib/studies";
import UnreadDot from "@/components/UnreadDot";
import { useUnreadChanges, useAckWhenVisible } from "@/lib/useUnreadChanges";
import { unreadForEntity, unreadForField, unreadForSurface, calendarDayKey, type UnreadIndex } from "@/lib/unreadChanges";
import type { ServiceLike, RoomOverrideRow } from "@/lib/catalog";
import { PRIORITY_OPTIONS, PRIORITY_META, priorityRank, isActiveStatus, type PatientPriority } from "@/lib/priority";
import Toast, { type ToastData } from "@/components/Toast";
import ShortcutsOverlay from "@/components/ShortcutsOverlay";
import { incidentEffectiveEnd, incidentExpired, incidentAwaitingManualUnblock, entryInIncidentWindow, groupIncidentsByRoom, incidentFeed, incidentMinutesOnDay, roomIncidentsOf, wallNow, wallToday0, setClinicTz, type IncidentFeed } from "@/lib/incidents";
import { quickSearchMatch } from "@/lib/quickSearch";
import { fmtOrigin } from "@/lib/rescheduleOrigin";
import { occupiesSlot } from "@/lib/slotOccupancy";
import type { CallStatus, QueueStatus, Json } from "@/supabase/types";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";

// schedule — базовий графік кабінету (rooms.schedule, JSONB): дні тижня + години.
// Без нього дошка рахувала графік по хардкоду «Пн–Сб 08:00–18:00» (аудит 2026-07-11).
type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null; schedule?: unknown; active?: boolean | null };
type QEntry = {
  id: string; patient_name: string | null; patient_phone: string | null; patient_age: number | null; patient_weight: number | null;
  patient_dob: string | null; patient_sex: string | null; patient_email: string | null;   // перенос у крок кейса
  scheduled_time: string | null; duration_min: number | null; buffer_time_min: number | null; status: string; call_status: string | null; note: string | null;
  studies: Json; studies_original: Json | null; studies_changed_by: string | null; contraindications: boolean; cito: boolean; priority_level: PatientPriority; doctor: string | null; referrer: { full_name: string | null } | null;
  room_id: string | null; updated_at: string; in_progress_at: string | null; clarify_at?: string | null;
  reschedule_origin?: Json | null;
  off_schedule?: boolean | null;   // 0077 — запис зроблено поза графіком (за підтвердженням)
  case_id?: string | null; case_step?: number | null;   // крос-модальний кейс (0091)
};
/* Порожній зріз — СТАБІЛЬНА константа модуля. Новий `[]` на кожному рендері
   інвалідував би всі useMemo, що залежать від `entries`, поки день вантажиться
   (аудит 2026-08-07, H-3). */
const EMPTY_ENTRIES: QEntry[] = [];
/* Ключ робочого зрізу дошки: клініка + день. Одна функція на обидві сторони —
   і на читання (scopeReady), і на запис (setEntriesSnap), щоб формат не розʼїхався. */
const scopeKeyOf = (clinicId: string, dayKey: string) => `${clinicId}|${dayKey}`;
type IncidentRow = { id: string; room_id: string; reason: string; reason_label: string | null; note: string | null; started_at: string; blocked_until: string | null; status: string; auto_unblock: boolean };
type IncidentPayload = { id?: string; roomId: string; reason: string; reasonLabel: string; note: string; startedAt: string; blockedUntil: string | null; autoUnblock: boolean };
/* `capKnown=false` — простої не прочитались, тож ЄМНІСТЬ кабінету невідома
   (U-11). Відсоток тоді порахувався б від ПОВНОГО дня і занизив завантаження:
   кабінет, що півдня стоїть на ремонті, виглядав би недовантаженим. */
type RoomLoadItem = { roomKey: string; name: string; kind: string; pct: number; capKnown: boolean; closed: boolean; color: string; off?: boolean };

/* ── Дати ── */
const WK = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"];
const MON_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
/* «Сьогодні» — за настінним часом КЛІНІКИ (wallToday0), а не браузера оператора.
   Раніше це був startOfDay(new Date()): біля півночі (або в оператора з іншої
   зони) дошка відкривалася на «вчора клініки», а isLate/computeCallBlock рахувалися
   вже по клініці — розбіжність фреймів (аудит M-4). Зона береться з singleton
   setClinicTz(), який виставляється синхронно з пропа clinicTz ДО першого рендера. */
function today0() { return wallToday0(); }
function sameDay(a: Date, b: Date) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function fmtFull(d: Date) { return WK[d.getDay()] + ", " + d.getDate() + " " + MON_GEN[d.getMonth()] + " " + d.getFullYear(); }
function fmtShort(d: Date) { return d.getDate() + " " + MON_GEN[d.getMonth()]; }
/* ⚠️ Г1-E: формат ключа доби — ОДИН на продукт. Тут стояла власна копія тіла
   `dateKeyOf`, і поки ключ жив усередині екрана, розходження було б непомітним.
   Тепер `dayKey` цієї дошки порівнюється з ключем, який рахує спільне правило
   (`dayShiftNoticeVisible`), — дві незалежні копії формату розійшлися б МОВЧКИ,
   і банер про перенесення доби просто ніколи б не з'явився. Ім'я лишаємо: воно
   стоїть у десятках місць, і перейменування нічого не додає. */
function dateKey(d: Date) { return dateKeyOf(d); }

// H4-4: статус НЕ лише кольором. Раніше беджі черги різнились тільки cls (колір) +
// текст, тоді як колл-лист уже мав гліф (CALL_META.icon). Додаємо гліф до кожного
// статусу (як у колл-листі) → впізнаваність за формою, а не лише кольором
// (дальтонізм, швидкий скан). in_progress лишає «живий» pulse-dot замість гліфа.
const ST: Record<string, { label: string; cls: string; dot?: boolean; icon?: string }> = {
  scheduled:   { label: "В черзі",      cls: "gray",   icon: "○" },
  waiting:     { label: "Очікує",       cls: "yellow", icon: "◔" },
  in_progress: { label: "В кабінеті",   cls: "blue", dot: true },
  done:        { label: "Виконано",     cls: "green",  icon: "✓" },
  no_show:     { label: "Неявка",       cls: "red",    icon: "✕" },
  not_held:    { label: "Не відбулося", cls: "orange", icon: "⊘" },
  cancelled:   { label: "Скасовано",    cls: "gray",   icon: "⊗" },
  // 0079/0080: слот втрачено через затримку, пацієнта треба перенести вручну.
  // БЕЗ цього рядка запис малювався б як звичайна «В черзі» (ST[status] || ST.scheduled)
  // — оператор повів би його в кабінет і впіймав сиру помилку тригера переходів.
  needs_reschedule: { label: "Потребує переносу", cls: "orange", icon: "↻" },
};
// needs_reschedule стоїть одразу за «В черзі»: слота вже немає, але дія потрібна
// СЬОГОДНІ — до терміналів (done/not_held/no_show) його опускати не можна.
const FLOW: Record<string, number> = { in_progress: 0, waiting: 1, scheduled: 2, needs_reschedule: 2.5, done: 3, not_held: 4, no_show: 5 };
const STAT_ITEMS = [
  { key: "all", lab: "Всього сьогодні", sub: "записів", cls: "white" },
  { key: "scheduled", lab: "В черзі", sub: "записані", cls: "gray" },
  { key: "waiting", lab: "Очікують", sub: "прийшли", cls: "yellow" },
  { key: "in_progress", lab: "В кабінеті", sub: "зараз", cls: "blue" },
  { key: "done", lab: "Виконано", sub: "процедур", cls: "green" },
  { key: "late", lab: "Запізнення", sub: "понад буфер", cls: "red" },
  { key: "not_held", lab: "Не відбулося", sub: "не відбулось", cls: "orange" },
];

function procLabel(e: { studies?: unknown; note?: string | null }) {
  const s = Array.isArray(e.studies) ? (e.studies as Array<{ type?: string; region?: string; contrast?: boolean }>) : [];
  if (s.length) return s.map((x) => (x.type || "") + (x.region ? " · " + x.region : "") + (x.contrast && !isContrastName(x.region) ? " з контрастом" : "")).join(" + ");
  return e.note || "—";
}
function fmtTimer(sec: number) {
  const m = Math.floor(sec / 60), s = sec % 60, h = Math.floor(m / 60);
  if (h) return h + ":" + String(m % 60).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  return m + ":" + String(s).padStart(2, "0");
}
function toMinHHMM(t: string | null | undefined) { const p = String(t || "").split(":"); return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); }
function incidentCoversDay(inc: IncidentRow | null | undefined, dayDate: Date) {
  if (!inc || !dayDate) return false;
  const dayStart = Date.UTC(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate());
  const dayEnd = dayStart + 24 * 3600e3;
  const start = new Date(inc.started_at).getTime();
  return start < dayEnd && dayStart < incidentEffectiveEnd(inc);
}
function enteredAtOf(e: QEntry | null | undefined): string | null { return e ? (e.in_progress_at || e.updated_at) : null; }

/* ── Живий таймер ──
   Ф4-8: «зараз» — serverNow(), бо enteredAt (in_progress_at) поставила БАЗА.
   Різниця двох РІЗНИХ годинників давала «хв у кабінеті» зі зсувом ПК. */
function LiveTimer({ enteredAt, children }: { enteredAt?: string | null; children: (sec: number) => ReactNode }) {
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => { const t = setInterval(() => setNow(serverNow()), 1000); return () => clearInterval(t); }, []);
  const sec = enteredAt ? Math.max(0, Math.floor((now - new Date(enteredAt).getTime()) / 1000)) : 0;
  return children(sec);
}

/* ── StatsBar ── */
/* `ready=false` — знімок дня ще не належить поточному зрізу (H-3). Показуємо
   «—», а не пораховані нулі: інакше в одному кадрі список чесно пише
   «Завантаження…», а шапка поруч стверджує «0 записів» — і оператор читає
   саме шапку (ревʼю пакета H-3, р.1). */
function StatsBar({ counts, filter, setFilter, ready = true }: { counts: Record<string, number>; filter: string; setFilter: (f: string) => void; ready?: boolean }) {
  return (
    <div className="stats">
      {STAT_ITEMS.map((s) => (
        <div key={s.key}
          className={"stat clickable" + (filter === s.key ? " active" : "")}
          role="button" tabIndex={0}
          onClick={() => setFilter(s.key)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFilter(s.key); } }}>
          <div className="lab">{s.lab}</div>
          <div className={"val tabular " + s.cls}>{ready ? (s.key === "all" ? counts.total : counts[s.key]) : "—"}</div>
          <div className="sub">{s.sub}</div>
        </div>
      ))}
    </div>
  );
}

/* B-1: pending-стан для async-кнопок карток (Викликати/Розблокувати). Обробник
   може повертати проміс (реальний виклик) або нічого (блокер) — спінер вмикаємо
   лише коли є thenable, і глушимо повторний клік, поки він летить. Оптимістичні
   гілки (setStatus) і так миттєво перемальовують картку; спінер важливий там, де
   раунд-тріп видимий (Розблокувати не оптимістичний). */
function useCardBusy() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = (fn: () => void | Promise<unknown>, key: string) => (e?: MouseEvent) => {
    e?.stopPropagation();
    if (busy) return;
    const r = fn();
    if (r && typeof (r as { then?: unknown }).then === "function") {
      setBusy(key);
      (r as Promise<unknown>).finally(() => setBusy(null));
    }
  };
  return { busy, run };
}

/* ── Картка кабінету ── */
interface RoomStatusCardProps {
  room: RoomOpt;
  patient?: QEntry | null;
  /* с24: незавершене дослідження з іншої дати. Кабінет фізично зайнятий ним
     (індекс 0018 не дасть другий in_progress), але на дошці цього дня його
     немає — тому картка мусить сказати про це сама. */
  stuck?: StuckStudy | null;
  /** Про «хвости» ще нічого не відомо (не завантажились / запит упав) — fail-closed. */
  stuckUnknown?: boolean;
  onFinishStuck?: (s: StuckStudy) => void;
  enteredAt?: string | null;
  nextWaiting?: QEntry | null;
  blocked?: IncidentRow | null;
  schedClosed?: string | boolean | null;
  onComplete: (p: QEntry) => void;
  onCall: (p: QEntry) => void;
  onUnblock: (inc: IncidentRow) => void;
}
function RoomStatusCard({ room, patient, stuck, stuckUnknown, onFinishStuck, enteredAt, nextWaiting, blocked, schedClosed, onComplete, onCall, onUnblock }: RoomStatusCardProps) {
  const kind = modalityShort(room.modality);
  const { busy, run } = useCardBusy();
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
          <div className="rc-foot">
            <span className="rc-blocked-hint">Нові виклики призупинено</span>
            <button className="btn btn-green btn-sm" onClick={run(() => onUnblock(blocked), "unblock")} disabled={!!busy} aria-busy={busy === "unblock"}>{busy === "unblock" ? <><span className="rf-spin" aria-hidden="true" /> Опрацьовується…</> : "🔓 Розблокувати"}</button>
          </div>
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
        /* Кабінет НЕ вільний: у ньому висить незавершене дослідження іншого дня.
           Показуємо ПІБ і дату, даємо закрити прямо звідси, а перехід лишаємо
           для випадків, де потрібні причина/нотатка («не відбулося»). Раніше тут
           писало «Кабінет вільний», кнопка виклику була активною, а сервер
           відповідав «у кабінеті вже є пацієнт» про пацієнта, якого не видно. */
        <div className="rc-body rc-body-stuck">
          <div className="rc-stuck-reason"><span aria-hidden="true">⏳</span> Незавершене дослідження від {stuckDateLabel(stuck.scheduled_date)}</div>
          <div className="rc-brow">
            <span className="rc-proc" title={stuck.patient_name}>{stuck.patient_name}</span>
            {onFinishStuck && <button className="btn btn-green btn-sm" onClick={() => onFinishStuck(stuck)}>✓ Завершити</button>}
          </div>
          <div className="rc-brow">
            <a className="btn btn-secondary btn-sm" href={stuckDeepLink(stuck)}
               aria-label={"Відкрити " + stuckDateLabel(stuck.scheduled_date) + " — кабінет " + room.name}>
              Відкрити {stuckDateLabel(stuck.scheduled_date)}
            </a>
          </div>
        </div>
      ) : stuckUnknown ? (
        /* Не знаємо, чи є хвіст → не стверджуємо «вільний» і не показуємо кнопку
           виклику (ревʼю с24, H1: «помилка завантаження ≠ пусто»). */
        <div className="rc-body empty">
          <div className="rc-free-row"><span aria-hidden="true">⚠</span><span className="rc-free">Стан кабінету не оновився</span></div>
          <div className="rc-free-sub">Дані про незавершені дослідження не завантажились — оновіть сторінку</div>
        </div>
      ) : (
        <div className="rc-body empty">
          <div className="rc-free-row"><span className="rc-free-dot" /><span className="rc-free">Кабінет вільний</span></div>
          {nextWaiting && (
            <button className="btn btn-primary btn-sm" onClick={run(() => onCall(nextWaiting), "call")} disabled={!!busy} aria-busy={busy === "call"}>
              {busy === "call"
                ? <><span className="rf-spin" aria-hidden="true" /> Опрацьовується…</>
                : <>Викликати: {(nextWaiting.patient_name || "").split(" ").slice(0, 2).join(" ")} · {nextWaiting.scheduled_time}</>}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Одиночний вид кабінету ── */
interface CurrentCardProps {
  patient?: QEntry | null;
  /** с24 — незавершене дослідження цього кабінету з іншої дати (див. RoomStatusCard). */
  stuck?: StuckStudy | null;
  stuckUnknown?: boolean;
  onFinishStuck?: (s: StuckStudy) => void;
  roomName: string;
  roomModel?: string | null;
  enteredAt?: string | null;
  nextWaiting?: QEntry | null;
  onCall: (p: QEntry) => void;
  onComplete: (p: QEntry) => void;
  onReschedule?: (p: QEntry) => void;
}
function CurrentCard({ patient, stuck, stuckUnknown, onFinishStuck, roomName, roomModel, enteredAt, nextWaiting, onCall, onComplete, onReschedule }: CurrentCardProps) {
  const { busy, run } = useCardBusy();
  if (!patient && stuck) {
    return (
      <div className="current" style={{ background: "var(--border)", boxShadow: "none" }}>
        <div className="current-inner" style={{ background: "var(--card)", padding: "22px 24px", gap: 18 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "0.9375rem", fontWeight: 600, color: "var(--orange)" }}>
              <span aria-hidden="true">⏳</span> {roomName}: незавершене дослідження від {stuckDateLabel(stuck.scheduled_date)}
            </div>
            <div style={{ fontSize: "0.8125rem", marginTop: 4, color: "var(--text-muted)" }}>
              {stuck.patient_name} — поки запис не завершено, викликати наступного не можна
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            {onFinishStuck && <button className="btn btn-green" onClick={() => onFinishStuck(stuck)}>✓ Завершити</button>}
            <a className="btn btn-secondary" href={stuckDeepLink(stuck)}
               aria-label={"Відкрити " + stuckDateLabel(stuck.scheduled_date) + " — кабінет " + roomName}>
              Відкрити {stuckDateLabel(stuck.scheduled_date)}
            </a>
          </div>
        </div>
      </div>
    );
  }
  if (!patient && stuckUnknown) {
    return (
      <div className="current" style={{ background: "var(--border)", boxShadow: "none" }}>
        <div className="current-inner" style={{ background: "var(--card)", padding: "22px 24px", gap: 18 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "0.9375rem", fontWeight: 600, color: "var(--orange)" }}><span aria-hidden="true">⚠</span> Стан кабінету {roomName} не оновився</div>
            <div style={{ fontSize: "0.8125rem", marginTop: 4, color: "var(--text-muted)" }}>Дані про незавершені дослідження не завантажились — оновіть сторінку</div>
          </div>
        </div>
      </div>
    );
  }
  if (!patient) {
    return (
      <div className="current" style={{ background: "var(--border)", boxShadow: "none" }}>
        <div className="current-inner" style={{ background: "var(--card)", padding: "22px 24px", gap: 18 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "0.9375rem", fontWeight: 600, color: "var(--text-secondary)" }}>{roomName} вільний</div>
            <div style={{ fontSize: "0.8125rem", marginTop: 4, color: "var(--text-muted)" }}>
              {nextWaiting ? "Наступний у черзі: " + nextWaiting.patient_name + " · " + nextWaiting.scheduled_time : "Немає пацієнтів у черзі"}
            </div>
          </div>
          {nextWaiting && <button className="btn btn-primary" onClick={run(() => onCall(nextWaiting), "call")} disabled={!!busy} aria-busy={busy === "call"} style={{ flexShrink: 0 }}>{busy === "call" ? <><span className="rf-spin" aria-hidden="true" /> Опрацьовується…</> : "Викликати наступного"}</button>}
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
            // Той самий поріг, що й у StudyTimer і в звуці перевищення — через
            // спільний предикат, щоб три копії формули не розійшлись (ревʼю L7).
            const over = isStudyOverrun(
              { id: patient.id, status: "in_progress", in_progress_at: enteredAt,
                duration_min: patient.duration_min, buffer_time_min: patient.buffer_time_min },
              (enteredAt ? new Date(enteredAt).getTime() : serverNow()) + sec * 1000
            );
            return (<>
              <div className="t tabular" style={over ? { color: "var(--orange)" } : undefined}>{fmtTimer(sec)}</div>
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

/* ── Завантаженість кабінетів ── */
/* ⚠️ Вікно простоя рахує КАНОНІЧНА `incidentMinutesOnDay` (F4-7). Тут була
   пʼята рукописна копія тієї самої формули, і вона розійшлася з каноном одразу
   в двох місцях: `Math.round` замість floor/ceil і порожній `blocked_until` як
   «до кінця доби» замість «до відновлення». Тут це лише відсоток завантаження,
   тобто дефект показний, а не клінічний, — але саме так копії й розходяться:
   поруч, у планувальнику затримки, та сама розбіжність відкочувала цілу
   транзакцію (F4-5). Кламп до РОБОЧОГО вікна кабінету лишається тут: канонічна
   функція клампить до доби, а відсоток рахується від графіка. */
function incidentWorkMinutes(inc: IncidentRow, date: Date, startMin: number, endMin: number) {
  const span = incidentMinutesOnDay(inc, calendarDayKey(date));
  if (!span) return 0;
  return Math.max(0, Math.min(endMin, span.e) - Math.max(startMin, span.s));
}
function computeRoomLoad(rooms: RoomOpt[] | undefined, entries: QEntry[], date: Date, overrides: OverrideFeed, incidents: IncidentFeed<IncidentRow>): RoomLoadItem[] {
  return (rooms || []).map((r) => {
    /* U-16: `null` = особливі графіки не прочитались, тобто невідомі САМІ МЕЖІ
       дня — а з них рахується вся ємність. Фолбек на базовий тиждень рахував
       санітарний день як повний і занижував відсоток так само тихо, як це
       робили непрочитані простої (U-11). Тому невідомість іде в `capKnown`, а
       не в число. */
    const sched = roomScheduleFromFeed(date, r.id, overrides, r.schedule);
    const startMin = sched ? toMinHHMM(sched.start) : 0, endMin = sched ? toMinHHMM(sched.end) : 0;
    let cap = !sched || sched.closed ? 0 : Math.max(0, endMin - startMin);
    /* U-11: простої ЗМЕНШУЮТЬ ємність. Порожній масив на місці збою читання
       лишав ємність повною і тихо занижував відсоток — той самий fail-open, що
       і в сітці слотів, лише без жодного видимого сліду. */
    const roomInc = roomIncidentsOf(incidents, r.id);
    // Ємність відома, лише коли відомі ОБИДВА джерела: межі дня і простої.
    const capKnown = roomInc !== null && sched !== null;
    if (cap > 0 && roomInc) {
      roomInc.forEach((i) => { cap -= incidentWorkMinutes(i, date, startMin, endMin); });
      cap = Math.max(0, cap);
    }
    /* Критерій «займає час кабінету» — з lib/slotOccupancy, а НЕ літералами
       (ревʼю р.2): це була четверта копія того самого списку, і саме такі копії
       розʼїжджаються після наступної міграції — рівно як розʼїхався hasSlotClash
       (H-2a). needs_reschedule тут виключений так само, як у skip-листах
       check_no_overlap / room_busy_slots: слот звільнено, хвилин у кабінеті вже
       немає. */
    const mins = entries.filter((e) => e.room_id === r.id && occupiesSlot(e.status)).reduce((s, e) => s + (e.duration_min || 0) + (e.buffer_time_min ?? BUFFER_DEFAULT), 0);
    const pct = cap > 0 ? Math.min(100, Math.round((mins / cap) * 100)) : 0;
    return { roomKey: r.id, name: r.name, kind: modalityLabel(r.modality), pct, capKnown, closed: !!sched?.closed, color: r.modality === "MRI" ? "var(--blue-text)" : "var(--orange)", off: !isRoomBookable(r) };
  });
}
/* `ready=false` — знімок дня ще не належить поточному зрізу (H-3): відсотки
   порахувались би по ПОРОЖНЬОМУ дню, тобто «0 %» на кожному апараті й «середня
   0 %» у шапці. Це та сама брехня нулями, що й у StatsBar (ревʼю р.2). */
function RoomLoad({ rooms, onSelectRoom, ready = true }: { rooms: RoomLoadItem[]; onSelectRoom?: (id: string) => void; ready?: boolean }) {
  const [open, setOpen] = useState(true);
  /* Середня — лише по кабінетах із ВІДОМОЮ ємністю (U-11). Домішати сюди
     кабінет, чиї простої не прочитались, означало б завищити середню тим
     самим заниженим відсотком, який ми поруч ховаємо під «—». */
  const known = rooms.filter((r) => r.capKnown);
  const avg = known.length ? Math.round(known.reduce((s, r) => s + r.pct, 0) / known.length) : 0;
  const avgText = ready && known.length ? " · сер. " + avg + "%" : " · —";
  return (
    <div className="rcard">
      <button className={"rcard-toggle" + (open ? " open" : "")} onClick={() => setOpen((o) => !o)}>
        <span className="rct-title">Завантаженість кабінетів</span>
        <span className="rct-sum">{rooms.length}{avgText}</span>
        <span className="rct-chev">⌄</span>
      </button>
      {open && (
        <div className="load-body">
          {rooms.map((r) => (
            <button type="button" className="load-row load-row-link" key={r.roomKey}
              onClick={() => onSelectRoom && onSelectRoom(r.roomKey)} title={"Відкрити чергу: " + r.name}
              style={{ width: "100%", textAlign: "left", border: "none", background: "none", cursor: "pointer" }}>
              <div className="load-top">
                {/* 0123: вимкнений кабінет із дошки НЕ ховаємо — у ньому можуть
                    лишатись пацієнти, і їх треба довести до кінця. Але позначаємо. */}
                <span className="load-name">{r.name} {r.kind}
                  {r.off && <span className="badge gray" style={{ marginLeft: 6 }} title="Кабінет вимкнено: нові записи в нього не приймаються">{ROOM_OFF_LABEL}</span>}
                  {" "}<span className="load-go" aria-hidden>→</span></span>
                <span className="load-pct" style={{ color: r.color }} title={ready && !r.capKnown ? "Простої або особливі графіки кабінету не завантажились — відсоток порахувався б від повного дня" : undefined}>{ready && r.capKnown ? r.pct + "%" : "—"}</span>
              </div>
              <div className="load-bar"><div className="load-fill" style={{ width: (ready && r.capKnown ? r.pct : 0) + "%", background: r.color }} /></div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Рядок черги ── */
const CALL_META: Record<string, { label: string; cls: string; icon: string }> = {
  confirmed:  { label: "Підтверджено", cls: "green", icon: "✓" },
  to_recall:  { label: "Передзвонити", cls: "blue", icon: "↻" },
  no_answer:  { label: "Не відповідає", cls: "orange", icon: "…" },
  declined:   { label: "Відмова", cls: "red", icon: "✕" },
  not_called: { label: "Не дзвонили", cls: "gray", icon: "○" },
};
const CALL_COLOR: Record<string, string> = { confirmed: "var(--green)", to_recall: "var(--blue-text)", no_answer: "var(--orange)", declined: "var(--red)", not_called: "var(--text-muted)" };
// «Перенесено з …» — lib/rescheduleOrigin.ts (одна копія на всі дошки, с42).

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
  in_progress: { icon: "✓", label: "Завершити процедуру",  bg: "var(--green)", color: "#04210d", border: "none" },
  done:        { icon: "✓", label: "Дослідження виконано", bg: "var(--card)",  color: "var(--text-faint)", border: "1px solid var(--border-strong)" },
};
const CALL_SEG_ORDER: CallStatus[] = ["not_called", "confirmed", "to_recall", "no_answer", "declined"];
const CALL_SEG_STYLE: Record<string, { color: string; bg: string }> = {
  not_called: { color: "var(--text-secondary)", bg: "var(--gray-badge-bg)" },
  confirmed:  { color: "var(--green)",     bg: "var(--green-bg)" },
  to_recall:  { color: "var(--blue-text)", bg: "var(--blue-bg)" },
  no_answer:  { color: "var(--orange)",    bg: "var(--orange-bg)" },
  declined:   { color: "var(--red)",       bg: "var(--red-bg)" },
};

interface QueueRowProps {
  p: QEntry; dayDate: Date; roomName: string; roomModel?: string; roomKind: string;
  expanded: boolean; onToggle: (id: string) => void; readOnly: boolean; canCall: boolean; rescheduling: boolean;
  onArrive: (p: QEntry) => void; onCall: (p: QEntry) => void; onComplete: (p: QEntry) => void;
  onNoShow: (p: QEntry) => void; onNotHeld: (p: QEntry) => void; onUndo: (p: QEntry) => void; onCancel: (p: QEntry) => void;
  onSetStatus: (p: QEntry, status: string) => void; onSetCall: (p: QEntry, s: CallStatus) => void;
  onReschedule: (p: QEntry) => void; onEditStudies: (p: QEntry) => void; onEditPatient: (p: QEntry) => void;
  onToWaitlist: (p: QEntry) => void;
  canSetPriority?: boolean; onSetPriority?: (p: QEntry, priority: PatientPriority) => void;
  originHint?: string | null;
  startBlockReason?: string | null;
  // Колізія: дослідження в кабінеті затягнулося і наїжджає на цей запис.
  // collision — для бейджа у згорнутій строці; collisionPanel — панель рішення в розкритій.
  collision?: CollisionInfo | null;
  collisionPanel?: ReactNode;
  // §5.5 — інлайн «перенос на найближче вільне вікно» (готова кнопка з батька,
  // рендериться лише для розгорнутого рядка, щоб RPC не бив по всій дошці).
  quickReschedule?: ReactNode;
  // Похідне попередження «Не за графіком» (tooltip) — null якщо запис у графіку.
  schedDrift?: string | null;
  // 0078–0081 — план при затримці: кнопка на записі, що ЗАРАЗ у кабінеті.
  onDelayPlan?: (p: QEntry) => void;
  delayLoading?: boolean;
  onOpenCase?: (caseId: string) => void;
  onOrganizeCase?: (p: QEntry) => void;
  // Крос-модальний кейс: сукупне вікно маршруту (найраніший старт → найпізніший кінець
  // серед усіх кроків із тим самим case_id) + кількість кроків. Рахує батько з entries.
  caseSpan?: { startMin: number; endMin: number; count: number } | null;
}
function QueueRow({ p, dayDate, roomName, roomModel, roomKind, expanded, onToggle, readOnly, canCall, rescheduling, onArrive, onCall, onComplete, onNoShow, onNotHeld, onUndo, onCancel, onSetStatus, onSetCall, onReschedule, onEditStudies, onEditPatient, onToWaitlist, canSetPriority, onSetPriority, originHint, startBlockReason, collision, collisionPanel, quickReschedule, schedDrift, onDelayPlan, delayLoading, onOpenCase, onOrganizeCase, caseSpan }: QueueRowProps) {
  // «Запізнення» — derived: пацієнт не прийшов, минуло понад буферний час.
  const late = isLate(p.status, dayDate, p.scheduled_time, p.buffer_time_min);
  const _startMs = (dayDate && p.scheduled_time) ? (() => { const [h, m] = String(p.scheduled_time).split(":").map(Number); return Date.UTC(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), h || 0, m || 0); })() : null;
  const _nowW = wallNow();
  // «Неявка»/«Не відбулося» можна ставити лише ПІСЛЯ часу початку дослідження (не наперед).
  const beforeStart = _startMs != null && _nowW < _startMs;
  const overdue = needsClarification(p.status, dayDate, p.scheduled_time) || (p.status === "scheduled" && !!p.clarify_at);
  const meta: { label: string; cls: string; dot?: boolean; title?: string; icon?: string } = late ? LATE_META : overdue ? CLARIFY_META : (ST[p.status] || ST.scheduled);
  const dateStr = dayDate ? String(dayDate.getDate()).padStart(2, "0") + "." + String(dayDate.getMonth() + 1).padStart(2, "0") + "." + dayDate.getFullYear() : "";
  const isTodayRow = dayDate ? sameDay(dayDate, today0()) : true;
  const isFutureRow = dayDate ? (!isTodayRow && dayDate > today0()) : false;
  const canSetStatus = !isFutureRow;
  /* с24. «Дія доступна в день запису» правильна для ПОЧАТКУ дослідження — завести
     пацієнта в кабінет заднім числом не можна. Але для ЗАВЕРШЕННЯ вона створювала
     глухий кут: адміністратор забув натиснути «Завершити», наступного дня кабінет
     заблоковано індексом 0018, а кнопка на вчорашній дошці вимкнена.
     Інтерфейс при цьому сам собі суперечив — кружок «Виконано» в степері
     працював (canSetStatus = !isFutureRow), а велика кнопка того ж переходу ні.
     Сервер дату не перевіряє взагалі (queue_set_status_rpc), тож блок був суто
     клієнтським. Завершити «хвіст» дозволяємо, почати новий — ні. */
  const canFinishPastDay = p.status === "in_progress" && !isFutureRow;
  /* Контекстні позначки (0131/0132). Крапка на картці — агрегат непрочитаних
     змін цього запису; крапка біля блоку послуг — лише його field_scope. */
  const { index: unreadIx } = useUnreadChanges();
  const cardUnread = unreadForEntity(unreadIx, "queue_entry", p.id);
  const studiesUnread = unreadForField(unreadIx, "queue_entry", p.id, "studies");
  /* Підтверджуємо прочитання ЛИШЕ коли рядок РОЗГОРНУТО: згорнута картка не
     показує ані складу послуг, ані даних пацієнта, тож гасити крапку немає
     за що (вимога ТЗ про згорнуті картки). Всередині хука ще дві умови:
     дані успішно завантажені (status === "ready") і підтверджуються лише id
     з відрендереного знімка. */
  useAckWhenVisible(expanded ? { kind: "entity", entityType: "queue_entry", entityId: p.id } : null, expanded);
  const [moreOpen, setMoreOpen] = useState(false);
  // B-1 (аудит v2): pending-стан async-дії рядка — блокує повторний клік і показує спінер.
  const [busy, setBusy] = useState<string | null>(null);
  const proc = procLabel(p);
  const act = (fn: (p: QEntry) => void, key = "act") => (e: MouseEvent) => {
    e.stopPropagation();
    if (busy) return;                                   // захист від подвійного кліку / конкурентних дій
    const r = (fn as (x: QEntry) => unknown)(p);        // обробники async повертають проміс (напр. arrive→setStatus)
    if (r && typeof (r as { then?: unknown }).then === "function") {
      setBusy(key);
      (r as Promise<unknown>).finally(() => setBusy(null));
    }
  };
  const isTerminal = p.status === "done" || p.status === "no_show" || p.status === "not_held";
  // Дзвінок-підтвердження — тепер у правій колонці під «Пріоритет пацієнта» (перенесено з низу картки).
  const showCall = !readOnly && p.status !== "needs_reschedule" && !isTerminal && !!onSetCall;
  // Дзвінок-підтвердження — компактний випадаючий список (замість сегментів).
  // Обрана опція зберігає колірний стиль статусу (bg/border/color з CALL_SEG_STYLE).
  const callSeg = showCall && onSetCall ? (() => {
    const cur = (p.call_status || "not_called") as CallStatus;
    const cs = CALL_SEG_STYLE[cur]; const cm = CALL_META[cur];
    return (
      <div>
        <div className="qd-sf-lab" style={{ marginBottom: 6 }}><span aria-hidden="true">📞</span> Дзвінок-підтвердження</div>
        <div className="qd-call-wrap">
          <select className="qd-call-select" value={cur} title={"Дзвінок: " + cm.label} aria-label="Дзвінок-підтвердження"
            style={{ background: cs.bg, color: cs.color, borderColor: cs.color }}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => { e.stopPropagation(); onSetCall(p, e.target.value as CallStatus); }}>
            {CALL_SEG_ORDER.map((key) => (
              <option key={key} value={key} style={{ background: "var(--bg-elevated)", color: CALL_SEG_STYLE[key].color }}>{CALL_META[key].icon + "  " + CALL_META[key].label}</option>
            ))}
          </select>
          <span className="qd-call-caret" aria-hidden="true">⌄</span>
        </div>
      </div>
    );
  })() : null;

  // ── Компактна смуга «час і маршрут» (верх розкритого рядка) ──
  // Раніше в деталях було видно лише СТАРТ (scheduled_time). Кінець дослідження
  // (старт + тривалість) — те, чого бракувало: коли САМЕ звільниться кабінет від
  // цього запису. Для кейса показуємо ще й сукупне вікно всього маршруту.
  const _sMin = p.scheduled_time ? slotToMin(p.scheduled_time) : null;
  const studyEndMin = _sMin != null ? _sMin + (p.duration_min || 0) : null;
  const buf = p.buffer_time_min ?? 0;
  const metaStrip = (_sMin != null || caseSpan) ? (
    <div className="qd-meta">
      {_sMin != null && studyEndMin != null && p.status !== "in_progress" && (
        <span className="qd-chip" title={"Планове вікно дослідження" + (buf ? ` · +${buf} хв буфер (прибирання/переукладка)` : "")}>
          <span aria-hidden="true">🕐</span>
          <b>{slotFmt(_sMin)}–{slotFmt(studyEndMin)}</b>
          <span className="qd-chip-sub">{p.duration_min} хв{buf ? ` +${buf}` : ""}</span>
        </span>
      )}
      {caseSpan && (
        <span className={"qd-chip" + (p.case_id ? " case" : "")}
          role={p.case_id ? "button" : undefined} tabIndex={p.case_id ? 0 : undefined}
          title={`Крос-модальний кейс · маршрут із ${caseSpan.count} кроків · весь кейс ${slotFmt(caseSpan.startMin)}–${slotFmt(caseSpan.endMin)}` + (p.case_id ? ". Натисніть, щоб відкрити" : "")}
          onClick={p.case_id ? (e) => { e.stopPropagation(); onOpenCase?.(p.case_id!); } : undefined}
          onKeyDown={p.case_id ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onOpenCase?.(p.case_id!); } } : undefined}>
          <span aria-hidden="true">🔗</span>
          Кейс
          <b>{slotFmt(caseSpan.startMin)}–{slotFmt(caseSpan.endMin)}</b>
          <span className="qd-chip-sub">{caseSpan.count} кр.</span>
        </span>
      )}
    </div>
  ) : null;

  return (
    <div className={"qrow-item " + p.status + (expanded ? " open" : "")} data-qrow={p.id}>
      <div className="qrow" role="button" tabIndex={0} onClick={() => onToggle(p.id)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(p.id); } }}>
        <div className="q-time tabular">{p.scheduled_time}<div className="td">{p.duration_min} хв</div><div className="td" style={{ marginTop: 2, color: "var(--text-muted)" }}>{dateStr}</div></div>
        <div className="q-pat">
          <div className="nm">{isActiveStatus(p.status) && p.priority_level !== "planned" && <span className={"prio-tag " + PRIORITY_META[p.priority_level].tone}>{PRIORITY_META[p.priority_level].short}</span>}<span onClick={(e) => { e.stopPropagation(); onEditPatient?.(p); }} style={{ cursor: "pointer", textDecorationLine: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 3 }} title="Редагувати дані пацієнта">{p.patient_name}</span><UnreadDot markers={cardUnread} />{p.case_id && <span onClick={(e) => { e.stopPropagation(); if (p.case_id) onOpenCase?.(p.case_id); }} style={{ cursor: "pointer", marginLeft: 6, fontSize: "0.6875rem", fontWeight: 600, color: "var(--accent, #3b82f6)" }} title="Відкрити крос-модальний кейс">🔗 Кейс</span>}</div>
          <div className="det" style={{ display: "flex", flexDirection: "column", gap: 1, whiteSpace: "normal" }}>
            {p.patient_phone && <span style={{ whiteSpace: "nowrap" }}>Тел. {p.patient_phone}</span>}
            {(p.patient_age != null || p.patient_weight != null) && <span>{[p.patient_age != null ? p.patient_age + " р." : null, p.patient_weight != null ? p.patient_weight + " кг" : null].filter(Boolean).join(", ")}</span>}
            {(p.referrer?.full_name || p.doctor) && <span>Напр.: {p.referrer?.full_name || p.doctor}</span>}
          </div>
        </div>
        <div className="q-proc">
          <div className="pp">{proc}<UnreadDot markers={studiesUnread} /></div>
          <div className="du">{roomKind}</div>
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
          {rescheduling && <span className="badge red" title="Апарат заблоковано — потрібен перенос на інший слот">🔧 Перезапис</span>}
          {/* 0077 — слід рішення: цей запис зробили/перенесли ПОЗА графіком кабінету
              (після закриття або в перерву) за явним підтвердженням персоналу. */}
          {p.off_schedule && (
            <span className="badge offsched" title="Запис поза графіком кабінету (після закриття або в перерву) — підтверджено персоналом">⏰ Поза графіком</span>
          )}
          {schedDrift && (
            <span className="badge red" title={schedDrift}>⚠ Не за графіком</span>
          )}
          {collision?.zone === "clash" && (
            <span className="badge red" title={`Кабінет звільниться о ${collision.freeAt} — дослідження, що триває, наїжджає на цей слот на ${collision.overlapMin} хв. Розгорніть запис, щоб обрати рішення`}>⚠ Накладення</span>
          )}
          {collision?.zone === "drift" && (
            <span className="badge gray" title={`Кабінет відстає від плану на ${collision.driftMin} хв (звільниться о ${collision.freeAt}), але до цього слота ще встигає — буфер поглинає затримку`}>+{collision.driftMin} хв</span>
          )}
          {(p.status === "scheduled" || p.status === "waiting") ? (() => { const cm = CALL_META[p.call_status || "not_called"]; return <span title={"Дзвінок: " + cm.label} aria-label={"Дзвінок: " + cm.label} style={{ fontSize: "0.9375rem", lineHeight: 1, fontWeight: 700, color: CALL_COLOR[p.call_status || "not_called"] }}>{cm.icon}</span>; })() : null}
        </div>
        <span className={"q-chev" + (expanded ? " open" : "")} aria-hidden>›</span>
      </div>

      <div className="qrow-detail-wrap">
        <div className="qrow-detail-inner">
          <div className="qrow-detail">
            {collisionPanel}
            {metaStrip}
            {/* Дослідження (зліва, обтікає) + таймер (справа, угорі) — без переносу, щоб таймер лишався праворуч. */}
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 4, flexWrap: "nowrap" }}>
              <div style={{ flex: "1 1 auto", minWidth: 0 }}>
            {Array.isArray(p.studies) && p.studies.length > 0 && (() => {
              const sdiff = diffStudies(p.studies_original as Parameters<typeof diffStudies>[0], p.studies as Parameters<typeof diffStudies>[1]);
              const changed = sdiff.some((d) => d.state !== "kept");
              return (
                <div>
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
                {/* «Перенесено» і «Примітка» — у лівій колонці поряд із таймером, щоб не лишати порожнечі. */}
                {originHint && (
                  <div className="ctx-hint" style={{ fontSize: "0.75rem", marginTop: 6 }}>{originHint}</div>
                )}
                {p.note && (
                  <div className="qd-info" style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.8125rem", marginTop: 6 }}>
                    <span style={{ color: "var(--text-muted)" }}>Примітка: {p.note}</span>
                  </div>
                )}
              </div>
              {p.status === "in_progress" && (
                <div className="qd-timer-top" style={{ flex: "0 0 auto" }}>
                  <StudyTimer variant="full" size={106} startAt={p.in_progress_at} durationMin={p.duration_min || 30} bufferMin={p.buffer_time_min ?? BUFFER_DEFAULT} />
                </div>
              )}
            </div>

            {/* 0079/0080 — «Потребує переносу». Степер тут НЕ показуємо взагалі:
                матриця переходів у БД дозволяє вийти лише в scheduled / cancelled / no_show,
                тож кнопки «Пацієнт прийшов» / «Викликати в кабінет» / «Завершити» відхилив би
                тригер guard_status_transition — оператор упіймав би сиру помилку БД.
                Слот уже звільнено, тому єдиний легальний шлях назад у чергу — новий слот
                («Перенести»), а не повернення на старий час. */}
            {!readOnly && p.status === "needs_reschedule" && (
              <div className="qd-step">
                <div className="qd-inline-err" role="status">
                  ⚠ Слот втрачено через затримку в кабінеті. Оберіть новий час або скасуйте запис.
                </div>
                <div style={{ display: "flex", gap: 6, padding: "6px 0", flexWrap: "wrap" }}>
                  <button className="btn btn-primary btn-sm" onClick={act(onReschedule)} title="Підібрати новий слот">🗓 Перенести</button>
                  <button className="btn btn-secondary btn-sm" onClick={act(onToWaitlist)} title="Пацієнт чекатиме на вільне вікно">⏳ В лист очікування</button>
                  <button className="btn btn-secondary btn-sm qd-act-red" onClick={act(onCancel)}>✕ Скасувати запис</button>
                </div>
              </div>
            )}

            {!readOnly && p.status !== "needs_reschedule" && (() => {
              const stepIdx = STEP_ORDER.indexOf(p.status);
              const pb = STEP_PRIMARY[p.status] || STEP_PRIMARY.done;
              const advanceFn = p.status === "scheduled" ? onArrive : p.status === "waiting" ? onCall : p.status === "in_progress" ? onComplete : null;
              const advanceDisabled = !advanceFn || (p.status === "waiting" && (!canCall || !!startBlockReason)) || (!isTodayRow && !canFinishPastDay) || late;
              const terminal = p.status === "done" || p.status === "no_show" || p.status === "not_held";
              // P2.4 — причина блокування дії показується інлайн (не лише в tooltip), поки актуальна.
              // startBlockReason (з батька) — вичерпна причина, чому «Викликати в кабінет» неможливий
              // (кабінет зайнятий/зачинено/на ремонті, або дослідження не вміститься до закриття/наступного запису).
              const blockReason = !advanceFn ? "" : late ? "Запізнення понад буферний час — оберіть дію нижче (повернути, перенести, до листа очікування або зняти)" : (!isTodayRow && !canFinishPastDay) ? "Дія доступна в день запису" : (p.status === "waiting" && startBlockReason ? startBlockReason : (p.status === "waiting" && !canCall ? "Кабінет зайнятий — спершу завершіть поточного пацієнта" : ""));
              return (
                <div className="qd-step">
                  {/* Степпер звужено (аудит-фікс): останній крок «Виконано» завершується
                      до колонки «Кабінет», а не тягнеться на всю ширину картки. */}
                  <div style={{ position: "relative", padding: "2px 32px 4px", maxWidth: "62%" }}>
                    <div style={{ position: "absolute", top: 17, left: 56, right: 56, height: 2, background: "var(--border)" }} />
                    <div style={{ position: "relative", display: "flex", justifyContent: "space-between" }}>
                      {STEP_ORDER.map((key, i) => {
                        const isDone = stepIdx >= 0 && i < stepIdx;
                        const isCur = i === stepIdx;
                        const m = STEP_META[key];
                        // Інваріант БД (0069): у 'done' лише з 'in_progress'. Раніше крок
                        // «Виконано» був клікабельний завжди й ловився тостом-помилкою вже
                        // після кліку — тепер він disabled, поки пацієнт не в кабінеті, тож
                        // степпер показує лише валідний шлях (а не помилку постфактум).
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

                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", flexWrap: "wrap", opacity: busy ? 0.7 : 1 }} aria-busy={!!busy}>
                    {terminal ? (
                      p.status === "done" ? (
                        <>
                          <span className="q-noshow-lab" style={{ flex: 1 }}>✓ Виконано</span>
                          <button className="btn btn-secondary btn-sm" onClick={act(onUndo)} title="Повернути пацієнта в чергу (скасувати завершення, без автозапуску)">↩ В чергу</button>
                        </>
                      ) : (
                        <>
                          <span className="q-noshow-lab" style={{ flex: 1 }}>✕ {p.status === "not_held" ? "Не відбулося" : "Неявка"}</span>
                          <button className="btn btn-secondary btn-sm" onClick={act(onReschedule)} title="Перенести на новий слот">🗓 Перенести</button>
                          <button className="btn btn-secondary btn-sm" onClick={act(onUndo)}>↩ Повернути в чергу</button>
                        </>
                      )
                    ) : (
                      <>
                        {/* Primary звужено: тепер за шириною контенту (flex 0 1 auto), а не на весь рядок —
                            щоб поруч помістилися видимі «Редагувати дослідження» та «Перенести». */}
                        <button onClick={advanceDisabled || !advanceFn ? undefined : act(advanceFn, "advance")} disabled={advanceDisabled || !!busy}
                          aria-busy={busy === "advance"}
                          title={(!isTodayRow && !canFinishPastDay) ? "Дія доступна в день запису" : (canFinishPastDay && !isTodayRow ? "Незавершене дослідження з минулого дня — завершіть, щоб звільнити кабінет" : (p.status === "waiting" && !canCall ? "Кабінет зайнятий — спершу завершіть поточного пацієнта" : ""))}
                          style={{ flex: "0 1 auto", minWidth: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "9px 16px", borderRadius: 10, fontSize: "0.84375rem", fontWeight: 600, border: pb.border, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                            cursor: advanceDisabled ? "default" : "pointer", opacity: (advanceDisabled && p.status !== "done") ? 0.55 : 1, background: pb.bg, color: pb.color }}>
                          {busy === "advance" ? <><span className="rf-spin" aria-hidden="true" /> Опрацьовується…</> : <>{pb.icon} {pb.label}</>}
                        </button>
                        {/* Вторинні часті дії — видимі поруч із primary (винесено з меню «Ще»). */}
                        {onEditStudies && <button className="btn btn-secondary btn-sm" style={{ flex: "0 0 auto", whiteSpace: "nowrap" }} onClick={act(onEditStudies)}>🩻 Редагувати дослідження</button>}
                        {quickReschedule}
                        <button className="btn btn-secondary btn-sm" style={{ flex: "0 0 auto", whiteSpace: "nowrap" }} onClick={act(onReschedule)} title={p.status === "in_progress" ? "Зупинити дослідження та перенести на новий слот" : "Обрати інший слот вручну"}>🗓 Перенести</button>
                        {/* «Організувати кейс» перенесено під меню «Ще» (рідка дія) — у рядку лишаємо лише часті. */}
                        <button className="btn btn-secondary btn-sm" style={{ flex: "0 0 auto", whiteSpace: "nowrap" }} aria-expanded={moreOpen} aria-haspopup="menu" onClick={(e) => { e.stopPropagation(); setMoreOpen((o) => !o); }} title="Інші дії з записом">Ще {moreOpen ? "⌃" : "⌄"}</button>
                      </>
                    )}
                  </div>

                  {/* 0078–0081 — план при затримці. Кнопка лише на записі, що ЗАРАЗ у
                      кабінеті: саме він може затягнутися і наїхати на чергу. Чи є
                      затримка насправді — вирішує СЕРВЕР (previewDelayPlan); якщо ні,
                      покаже «черга ще встигає». */}
                  {/* «План при затримці» (ліворуч) + деструктивні дії з меню «Ще» (праворуч, на тому ж рівні). */}
                  {((p.status === "in_progress" && onDelayPlan) || (moreOpen && !terminal)) && (
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap", padding: "2px 0 6px" }}>
                      {p.status === "in_progress" && onDelayPlan && (
                        <button className="btn btn-secondary btn-sm" disabled={delayLoading} onClick={act(onDelayPlan)}
                          title="Порахувати, як затримка впливає на чергу, і за потреби зсунути записи">
                          {delayLoading ? "⏳ Рахую…" : "📋 План при затримці"}
                        </button>
                      )}
                      {moreOpen && !terminal && (
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginLeft: "auto" }} role="menu">
                          {onOrganizeCase && !p.case_id && <button className="btn btn-secondary btn-sm" style={{ whiteSpace: "nowrap" }} onClick={act(onOrganizeCase)} title="Додати іншу модальність/кабінет — організувати крос-модальний кейс">🔗 Організувати кейс</button>}
                          <button className="btn btn-secondary btn-sm qd-act-red" disabled={beforeStart} title={beforeStart ? "Доступно від часу початку дослідження" : ""} onClick={act(onNoShow)}>✕ Неявка</button>
                          <button className="btn btn-secondary btn-sm qd-act-red" disabled={beforeStart} title={beforeStart ? "Доступно від часу початку дослідження" : ""} onClick={act(onNotHeld)}>✕ Не відбулося</button>
                          <button className="btn btn-secondary btn-sm qd-act-red" onClick={act(onCancel)}>✕ Скасувати запис</button>
                        </div>
                      )}
                    </div>
                  )}

                  {advanceDisabled && blockReason && (
                    <div className="qd-inline-err" role="status">⚠ {blockReason}</div>
                  )}

                  {/* Панель рішення для запізнення: явні дії замість прямого виклику. */}
                  {late && !terminal && (
                    <div style={{ display: "flex", gap: 6, padding: "2px 0 6px", flexWrap: "wrap" }}>
                      {/* Кнопки «✓ Виконано» тут БІЛЬШЕ НЕМАЄ: у 'done' можна потрапити лише
                          з 'in_progress' (інваріант БД, 0069) — інакше дослідження «виконувалось»
                          нізвідки і росло в «Доході» CEO. Шлях для пацієнта, який усе ж прийшов:
                          «↩ Все ж прийшов» → викликати в кабінет → «Виконано». */}
                      <button className="btn btn-green btn-sm" onClick={act(onArrive)} title="Пацієнт усе ж прийшов — повернути в живу чергу (Очікує), далі виклик у кабінет">↩ Все ж прийшов</button>
                      <button className="btn btn-secondary btn-sm" onClick={act(onReschedule)}>🗓 Перенести</button>
                      <button className="btn btn-secondary btn-sm" onClick={act(onToWaitlist)} title="Пацієнт чекатиме на вільне вікно">⏳ В лист очікування</button>
                      <button className="btn btn-secondary btn-sm qd-act-red" onClick={act(onNotHeld)}>✕ Не відбулося</button>
                    </div>
                  )}

                  {/* Деструктивні дії «Ще» — тепер у рядку з «План при затримці» (праворуч), вище. */}
                </div>
              );
            })()}
            {/* Пріоритет пацієнта + Дзвінок-підтвердження — вниз праворуч, в один ряд на одному рівні. */}
            {((canSetPriority && onSetPriority) || showCall) && (
              <div style={{ display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap", justifyContent: "flex-end", marginTop: 4 }}>
                {canSetPriority && onSetPriority && (
                  <div>
                    <div className="qd-sf-lab" style={{ marginBottom: 6 }}>Пріоритет пацієнта</div>
                    <div className="prio-seg" role="radiogroup" aria-label="Пріоритет пацієнта">
                      {PRIORITY_OPTIONS.map((pv) => {
                        const m = PRIORITY_META[pv];
                        return (
                          <button key={pv} type="button" role="radio" aria-checked={p.priority_level === pv}
                            className={"prio-seg-btn " + m.tone + (p.priority_level === pv ? " active" : "")}
                            onClick={(e) => { e.stopPropagation(); if (p.priority_level !== pv) onSetPriority(p, pv); }} title={m.desc}>
                            {m.short}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {callSeg}
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Колл-лист (підтвердження) ── */
function CallListPanel({ entries, onSetCall, dateLabel }: { entries: QEntry[]; onSetCall: (p: QEntry, s: CallStatus) => void; dateLabel?: string }) {
  const list = entries.filter((e) => ["not_called", "to_recall", "no_answer"].includes(e.call_status || "not_called") && (e.status === "scheduled" || e.status === "waiting"));
  return (
    <div className="rcard">
      <div className="rcard-toggle open" style={{ cursor: "default" }}>
        <span className="rct-title">Обдзвін — підтвердження{dateLabel ? " · " + dateLabel : ""}</span>
        <span className="rct-sum">{list.length}</span>
      </div>
      <div className="load-body">
        {list.length === 0 ? (
          <div style={{ padding: "8px 4px", fontSize: "0.78125rem", color: "var(--text-muted)" }}>Усіх підтверджено ✓</div>
        ) : list.map((e) => {
          const cm = CALL_META[e.call_status || "not_called"];
          return (
            <div key={e.id} style={{ padding: "8px 0", borderTop: "1px solid var(--border)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontSize: "0.8125rem", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.patient_name}</span>
                <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", flexShrink: 0 }}>{e.scheduled_time}</span>
              </div>
              <div style={{ fontSize: "0.71875rem", color: "var(--text-muted)", margin: "2px 0 4px" }}>{procLabel(e)}</div>
              {e.patient_phone && <a href={"tel:" + e.patient_phone.replace(/\s/g, "")} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "0.78125rem", marginBottom: 6, whiteSpace: "nowrap", color: "var(--blue-text)", textDecoration: "none" }}>☎ {e.patient_phone}</a>}
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <span className={"qd-call " + cm.cls} style={{ fontSize: "0.6875rem" }}>{cm.icon} {cm.label}</span>
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

/* ── Обдзвін через простій ── */
function AffectedPanel({ affected, roomsById, onReschedule }: { affected: QEntry[]; roomsById: Record<string, RoomOpt>; onReschedule: (p: QEntry) => void }) {
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
              <span style={{ fontSize: "0.8125rem", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.patient_name}</span>
              <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", flexShrink: 0 }}>{e.scheduled_time}</span>
            </div>
            <div style={{ fontSize: "0.71875rem", color: "var(--text-muted)", margin: "2px 0 4px" }}>{procLabel(e)} · {(e.room_id ? roomsById[e.room_id] : undefined)?.name}</div>
            {e.patient_phone && <a href={"tel:" + e.patient_phone.replace(/\s/g, "")} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "0.78125rem", marginBottom: 6, whiteSpace: "nowrap", color: "var(--blue-text)", textDecoration: "none" }}>☎ {e.patient_phone}</a>}
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button className="btn btn-primary btn-xs" onClick={() => onReschedule(e)}>🗓 Перенести</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}


/* ── Потребує переносу (0078–0081) ──
   Записи, чий слот втрачено через затримку в кабінеті (status = needs_reschedule).
   Це НЕ скасування: пацієнт чекає, реєстратура підбирає новий час. Виносимо в
   окрему панель, щоб реєстратор одразу бачив, кому дзвонити (call_status уже
   to_recall — RPC поставила). */
function NeedsReschedulePanel({ entries, roomsById, onReschedule, onToWaitlist, onCancel }: { entries: QEntry[]; roomsById: Record<string, RoomOpt>; onReschedule: (p: QEntry) => void; onToWaitlist: (p: QEntry) => void; onCancel: (p: QEntry) => void }) {
  if (!entries.length) return null;
  return (
    <div className="rcard">
      <div className="rcard-toggle open" style={{ cursor: "default" }}>
        <span className="rct-title">Потребує переносу</span>
        <span className="rct-sum" style={{ background: "var(--orange)", color: "#04210d", borderRadius: 10, padding: "1px 8px" }}>{entries.length}</span>
      </div>
      <div className="load-body">
        {entries.map((e) => (
          <div key={e.id} style={{ padding: "8px 0", borderTop: "1px solid var(--border)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span style={{ fontSize: "0.8125rem", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.patient_name}</span>
              <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", flexShrink: 0 }}>було {e.scheduled_time}</span>
            </div>
            <div style={{ fontSize: "0.71875rem", color: "var(--text-muted)", margin: "2px 0 4px" }}>{procLabel(e)} · {(e.room_id ? roomsById[e.room_id] : undefined)?.name}</div>
            {e.patient_phone && <a href={"tel:" + e.patient_phone.replace(/\s/g, "")} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "0.78125rem", marginBottom: 6, whiteSpace: "nowrap", color: "var(--blue-text)", textDecoration: "none" }}>☎ {e.patient_phone}</a>}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button className="btn btn-primary btn-xs" onClick={() => onReschedule(e)}>🗓 Перенести</button>
              <button className="btn btn-secondary btn-xs" title="Пацієнт чекатиме на вільне вікно" onClick={() => onToWaitlist(e)}>⏳ В лист очікування</button>
              <button className="btn btn-secondary btn-xs" onClick={() => onCancel(e)}>✕ Скасувати</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}


/* ── Скасовані + Неявка ── */

/* Рядок панелі — ОКРЕМИЙ компонент модульного рівня, і це не смак, а умова
   роботи заморозки ack (с28): компонент, оголошений усередині рендера батька,
   отримує нову ідентичність щокадру → React ремонтує його, і «знімок на
   момент розкриття» замерзав би заново кожен ререндер (тобто не замерзав би
   зовсім). Рядок монтується лише при розкритій панелі, тож маунт = показ. */
function CancelledRow({ e, unreadIx, ackEnabled, onUndo, onReschedule, onToWaitlist }: {
  e: QEntry;
  unreadIx: UnreadIndex;
  /** true лише для записів, які були в панелі В МОМЕНТ її розкриття. */
  ackEnabled: boolean;
  onUndo: (p: QEntry) => void; onReschedule: (p: QEntry) => void; onToWaitlist: (p: QEntry) => void;
}) {
  /* ⚠️ Скасування — найчастіша критична подія, і його позначку (field_scope
     'status') не можна погасити на дошці: скасований запис туди не потрапляє
     взагалі, він живе ТУТ. Без ack тут крапка висіла б вічно — і на пункті
     навігації, і (з 0133) на конкретному дні календаря.
     ⚠️ ackEnabled, а не безумовне true (ревʼю с28-р1, H-1): маунт рядка ≠
     розкриття панелі. Запис, скасований при ВЖЕ відкритій панелі, монтує
     новий рядок, і заморозка на маунт гасила б critical-позначку без жодної
     дії користувача — недетерміновано, залежно від того, чий refetch
     (entries чи markers) виграв гонку. Тому ack дозволений лише рядкам зі
     знімка розкриття; свіже скасування чекає наступного розкриття панелі. */
  useAckWhenVisible({ kind: "entity", entityType: "queue_entry", entityId: e.id }, ackEnabled);
  const isCancelled = e.status === "cancelled";
  return (
    <div style={{ padding: "8px 0", borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: "0.8125rem", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.patient_name}</span><UnreadDot markers={unreadForEntity(unreadIx, "queue_entry", e.id)} />
        <span className={"badge " + (isCancelled ? "gray" : "red")} style={{ fontSize: "0.65625rem", flexShrink: 0 }}>{isCancelled ? "Скасовано" : "Неявка"}</span>
      </div>
      <div style={{ fontSize: "0.71875rem", color: "var(--text-muted)", margin: "2px 0 6px" }}>{e.scheduled_time} · {procLabel(e)}</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button className="btn btn-secondary btn-xs" onClick={() => onUndo(e)}>↩ В чергу</button>
        <button className="btn btn-secondary btn-xs" onClick={() => onReschedule(e)}>🗓 Перезаписати</button>
        <button className="btn btn-secondary btn-xs" title="Пацієнт чекатиме на вільне вікно" onClick={() => onToWaitlist(e)}>⏳ В лист очікування</button>
      </div>
    </div>
  );
}

function CancelledPanel({ entries, onUndo, onReschedule, onToWaitlist }: { entries: QEntry[]; onUndo: (p: QEntry) => void; onReschedule: (p: QEntry) => void; onToWaitlist: (p: QEntry) => void }) {
  const [open, setOpen] = useState(false);
  /* Знімок id, які були в панелі В МОМЕНТ розкриття (ревʼю с28-р1, H-1):
     тільки їм дозволено ack. Живе в ref — перерахунок від ререндеру зробив
     би знімок беззмістовним. Побічний ефект — у тілі колбека, НЕ в updater-і
     setState (StrictMode двоїть updater-и — правило с27). */
  const openIdsRef = useRef<ReadonlySet<string> | null>(null);
  const toggleOpen = () => {
    const next = !open;
    openIdsRef.current = next ? new Set(entries.map((e) => e.id)) : null;
    setOpen(next);
  };
  const { index: unreadIx } = useUnreadChanges();
  /* Крапка на ЗАГОЛОВКУ згорнутої панелі — ланка «секція» в ієрархії
     поле→картка→секція→навігація. Жива перевірка с28: без неї крапка
     скасування вела в порожнечу — запису на дошці вже немає, панель
     згорнута й нічим не позначена, знайти джерело можна було лише навмання. */
  const headerMarkers = entries.flatMap((e) => unreadForEntity(unreadIx, "queue_entry", e.id));
  if (!entries.length) return null;
  return (
    <div className="rcard">
      <button className={"rcard-toggle" + (open ? " open" : "")} onClick={toggleOpen} aria-expanded={open} style={{ cursor: "pointer" }}>
        <span className="rct-title">Скасовані + Неявка</span><UnreadDot markers={headerMarkers} withCount />
        <span className="rct-sum">{entries.length}</span>
        <span className="rct-chev">⌄</span>
      </button>
      {open && (
        <div className="load-body">
          {entries.map((e) => (
            <CancelledRow key={e.id} e={e} unreadIx={unreadIx} ackEnabled={openIdsRef.current?.has(e.id) ?? false} onUndo={onUndo} onReschedule={onReschedule} onToWaitlist={onToWaitlist} />
          ))}
        </div>
      )}
    </div>
  );
}

interface QueueBoardProps {
  clinicId: string;
  /** IANA-зона центру (clinics.timezone) — приходить із сервера, а не читається з браузера. */
  clinicTz: string;
  rooms?: RoomOpt[];
  /** id вимкнених кабінетів, у яких ЩЕ лишились живі записи («кабінети-залишки»).
   *  Вимкнений кабінет ховаємо зі списків, але поки в ньому щось є — він спливає
   *  назад із підписом «вимкнено · N записів». Див. lib/rooms.ts. */
  residualRoomIds?: string[];
  /** Скільки саме лишилось у кожному такому кабінеті — для підпису. */
  residualRoomCounts?: Record<string, number>;
  /** Каталог послуг центру (services, 0107) — SSR-проп, як rooms. Порожній → статика. */
  services?: ServiceLike[];
  /** Переозначення каталогу по кабінетах (service_room_overrides, 0108) — SSR-проп; проброс у форми запису (2b). */
  roomOverrides?: RoomOverrideRow[];
  clinicName?: string;
  adminName?: string;
  adminRole?: string;
  roleKey?: string;
  /** с22 (deep-link зі сторінки «Пошук»): відкрити дошку на цій даті (YYYY-MM-DD). */
  initialDate?: string | null;
  /** с22: id запису, який треба розгорнути після завантаження дня. */
  initialEntry?: string | null;
}

export default function QueueBoard({ clinicId, clinicTz, rooms, residualRoomIds, residualRoomCounts, services, roomOverrides, clinicName, adminName, adminRole, roleKey = "admin", initialDate = null, initialEntry = null }: QueueBoardProps) {
  /* Зона центру виставляється СИНХРОННО, до першого рендера й до ініціалізаторів
     useState — інакше selectedDate = today0() зафіксував би день БРАУЗЕРА назавжди
     (раніше tz прилітала з клієнтського fetch уже ПІСЛЯ монтування).
     Лише на клієнті: модульний singleton на сервері шарився б між запитами. */
  if (typeof window !== "undefined") setClinicTz(clinicTz);

  const router = useRouter();   // 0086: зміни кабінетів (rooms — SSR-проп) підхоплюємо через router.refresh
  /* ⚠️ ЗНІМОК ЖИВЕ РАЗОМ ІЗ КЛЮЧЕМ ЗРІЗУ (зовнішній аудит 2026-08-07, H-3).
     Раніше `entries` лежали окремо, а `setLoading(true)` залежав ЛИШЕ від
     clinicId. Тому при зміні дати React малював НОВУ дату зі СТАРИМИ рядками:
     лічильник поколінь відсікає застарілу ВІДПОВІДЬ, але не вже відрендерений
     кадр. Дії при цьому лишались активними — оператор міг змінити запис не того
     дня; а `dayDate` у пропах рядка вже був новим, тобто «Запізнення» і мітка
     дати рахувались учорашньому запису по сьогоднішньому дню.
     Ефектом це не лікується: `useEffect` виконується ПІСЛЯ paint. Тому зріз
     звіряється ПІД ЧАС рендеру — див. `scopeReady` нижче. Те саме правило вже
     діяло для `stuckLoaded`, тут воно застосоване до самих даних. */
  const [entriesSnap, setEntriesSnap] = useState<{ scope: string; rows: QEntry[] }>({ scope: "", rows: [] });
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false); // оверлей гарячих клавіш (P3, клавіша «?»)
  const [openCaseId, setOpenCaseId] = useState<string | null>(null);
  const [slotsOverviewOpen, setSlotsOverviewOpen] = useState(false);
  const [completeFor, setCompleteFor] = useState<QEntry | null>(null);
  const [reschedFor, setReschedFor] = useState<QEntry | null>(null);
  // 0078–0081 — план при затримці: preview з сервера + стан застосування.
  const [delayPreview, setDelayPreview] = useState<DelayPreview | null>(null);
  const [delayOpening, setDelayOpening] = useState(false);   // йде previewDelayPlan
  const [delayBusy, setDelayBusy] = useState(false);          // йде applyDelayPlan
  const [editStudiesFor, setEditStudiesFor] = useState<QEntry | null>(null);
  const [editPatientFor, setEditPatientFor] = useState<QEntry | null>(null);
  // «Організувати кейс» із наявного запису: відкриваємо вікно запису в режимі
  // «додати крок» (інша модальність), сиблінг — сам цей запис (0098).
  const [caseFromEntryFor, setCaseFromEntryFor] = useState<QEntry | null>(null);
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [breakdownRoomId, setBreakdownRoomId] = useState<string | null>(null);
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [emergencyBusy, setEmergencyBusy] = useState(false);
  const [emergencyConfirm, setEmergencyConfirm] = useState<{ roomId: string; action: "stop" | "resume" } | null>(null);
  const [overrides, setOverrides] = useState<Record<string, DayOverride>>({});
  const [schedEditOpen, setSchedEditOpen] = useState(false);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [roomView, setRoomView] = useState("all");
  const searchRef = useRef<HTMLInputElement>(null);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  // с22: deep-link «Пошук» → дошка відкривається на даті знайденого запису.
  const [selectedDate, setSelectedDate] = useState(() => {
    if (initialDate && /^\d{4}-\d{2}-\d{2}$/.test(initialDate)) {
      const d = new Date(initialDate + "T00:00:00");
      if (!Number.isNaN(d.getTime())) return d;
    }
    return wallToday0(clinicTz);
  });
  const [toast, setToast] = useState<ToastData | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Слот звільнився (скасування/відмова) → підходящі кандидати з листа очікування.
  const [wlSuggest, setWlSuggest] = useState<{ slot: FreedSlotInfo; candidates: WaitlistEntry[] } | null>(null);
  // Оголошені тут (а не нижче біля хендлерів), бо їх читає гард хоткеїв anyModalOpen.
  const [cancelAsk, setCancelAsk] = useState<{ p: QEntry; mode: "cancel" | "declined" } | null>(null);
  const [offCallAsk, setOffCallAsk] = useState<
    /* U-67 (с50): гілки "clash" тут більше немає — накладення стало жорстким
       блоком із названою причиною (inProgressBlockReason), як на дошці
       радіолога. Діалог «⚠ Викликати все одно» був мертвий: onConfirm
       перечитує жорсткі блоки, а clash не confirmable. */
    | { p: QEntry; kind: "overrun"; end: string; durationMin: number }
    | { p: QEntry; kind: "next_day"; end: string; durationMin: number }
    | null
  >(null);

  const [nowTick, setNowTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setNowTick((n) => n + 1), 20000); return () => clearInterval(t); }, []);

  const deepLinkDone = useRef(false);

  const today = wallToday0(clinicTz);
  const isToday = sameDay(selectedDate, today);
  const isPast = selectedDate < today;
  const dayKey = dateKey(selectedDate);

  /* Ключ робочого зрізу і похідні від нього (аудит 2026-08-07, H-3).
     `entries` віддаємо ПОРОЖНІМИ, доки знімок не належить поточному зрізу, —
     інакше перший же кадр після зміни дати показав би чужий день. Порожній
     масив — стабільна константа, щоб не будити useMemo-споживачів даремно. */
  const scope = scopeKeyOf(clinicId, dayKey);
  const scopeReady = entriesSnap.scope === scope;
  const entries = scopeReady ? entriesSnap.rows : EMPTY_ENTRIES;
  /* Оптимістичні патчі рядків: зріз НЕ чіпають — вони застосовуються до того
     самого знімка, який зараз на екрані. */
  const setEntries = useCallback((upd: QEntry[] | ((es: QEntry[]) => QEntry[])) => {
    setEntriesSnap((s) => ({ scope: s.scope, rows: typeof upd === "function" ? upd(s.rows) : upd }));
  }, []);
  /* Ключ ПОТОЧНОГО зрізу для протухлих замикань (reload, тости з дією). */
  const scopeRef = useRef(scope);
  scopeRef.current = scope;


  // с22: deep-link «Пошук» → після першого завантаження дня розгортаємо знайдений
  // запис і скролимо до нього. Одноразово: далі оператор керує дошкою сам.
  // `scopeReady` тут обовʼязковий: без нього ефект спрацював би на знімку чужого
  // дня, не знайшов би id і назавжди зняв би прапорець (аудит 2026-08-07, H-3).
  useEffect(() => {
    if (deepLinkDone.current || !initialEntry || loading || !scopeReady) return;
    if (!entries.some((e) => e.id === initialEntry)) { deepLinkDone.current = true; return; }
    deepLinkDone.current = true;
    setExpandedRow(initialEntry);
    setTimeout(() => { document.querySelector(`[data-qrow="${initialEntry}"]`)?.scrollIntoView({ block: "center" }); }, 60);
  }, [entries, loading, scopeReady, initialEntry]);

  /* roomsById — ПОВНИЙ список, включно з вимкненими: за ним резолвиться назва
     кабінету в рядку запису. Ховаємо кабінет зі СПИСКІВ, а не з записів. */
  const roomsById = useMemo(() => {
    const m: Record<string, RoomOpt> = {};
    (rooms || []).forEach((r) => { m[r.id] = r; });
    return m;
  }, [rooms]);

  /* …а `visRooms` — те, що показуємо у списках: активні + вимкнені із залишками. */
  const residual = useMemo(() => residualSet(residualRoomIds), [residualRoomIds]);
  const visRooms = useMemo(() => visibleRooms(rooms, residual), [rooms, residual]);
  const offNote = (roomId: string): string | null => {
    const r = roomsById[roomId];
    return r && r.active === false ? roomOffLabel(residualRoomCounts?.[roomId]) : null;
  };

  function notify(msg: string, type = "success", action?: ToastData["action"]) {
    /* Тост із дією прибиваємо до ЗРІЗУ, у якому його породили (ревʼю р.2).
       Ефекта на зміну `scope` мало: `notify` викликається ПІСЛЯ await server
       action, тож послідовність «натиснув «Неявка» на дні A → перемкнув дату →
       промис резолвиться» народжує тост уже на дні B, і ефект його не бачив.
       Клік по «↩ Відмінити» тоді пішов би по запису чужого дня, ще й із
       порожнім expectedFrom. Тут дія просто стає no-op поза своїм зрізом. */
    const born = scopeRef.current;
    const guarded: ToastData["action"] = action
      ? { label: action.label, onAction: () => { if (scopeRef.current !== born) return; action.onAction(); } }
      : undefined;
    setToast({ msg, type, action: guarded });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    // A-1/аудит v2: помилки живуть довше (5–7 с) — оператор встигає прочитати.
    // Тости з дією (soft-undo) теж 6 с — щоб устигнути натиснути «↩ Відмінити».
    toastTimer.current = setTimeout(() => setToast(null), (type === "error" || action) ? 6000 : 3000);
  }

  /* ПОМИЛКА ЗАВАНТАЖЕННЯ ≠ «ПУСТО» (аудит 2026-07-11).
     Раніше всі лоадери робили `data || []`, тож збій мережі виглядав як «даних
     немає»: черга — «Записів на цей день немає», простої — кабінет БЕЗ поломки
     (тобто в зламаний апарат можна було записати пацієнта), особливі графіки —
     закритий день як робочий. Тепер помилку показуємо явно, попередні дані НЕ
     затираємо, а бронювання блокуємо, поки дані про простої/графіки ненадійні. */
  const [entriesErr, setEntriesErr] = useState(false);
  /* Два ОКРЕМІ прапорці: спільний safetyErr затирався тим лоадером, який відповів
     останнім (loadIncidents і loadOverrides ходять паралельно) — і збій простоїв
     «зникав» після успішних графіків, тобто саме той випадок, від якого захист. */
  const [incidentsErr, setIncidentsErr] = useState(false);
  const [overridesErr, setOverridesErr] = useState(false);
  const safetyErr = incidentsErr || overridesErr; // простої / графіки — критично для брони
  /* Для звуку: стартовий стан incidents=[] — це «ще не завантажено», а не «простоїв
     немає». Без цього прапорця перший справжній список став би ДРУГИМ snapshot'ом,
     і давно активний простій «зазвучав» би прямо на маунті дошки. */
  const [incidentsLoaded, setIncidentsLoaded] = useState(false);
  /* Інциденти видно ПРЯМО на дошці (плашки кабінетів, панель) — успішне
     завантаження і є їх показ, тож поверхню incidents підтверджуємо тут
     (ревʼю р2, H-3new: інакше крапка інциденту на «Дошка черги» не гасла б
     ніколи). Хук сам чекає status === "ready" і бере лише знімок.
     ⚠️ refreezeKey (с28): дошка «розгорнута» постійно, тож без перезаморозки
     хук гасив би лише позначки, що застали маунт. Ключ — відбиток УСПІШНО
     завантаженого списку простоїв (ВІДСОРТОВАНИЙ: SELECT без ORDER BY не
     гарантує порядок рядків, і «той самий» список інакше давав би ложні
     перезаморозки — ревʼю с28-р1, M-1) ПЛЮС id непрочитаних позначок, чиї
     інциденти реально є в показаному списку. Другий доданок закриває гонку
     «список приїхав раніше за позначку»: інцидент і позначка народжуються
     однією транзакцією, але клієнт тягне їх двома незалежними refetch-ами,
     і без цього позначка, що програла гонку, висіла б на видимому інциденті
     до наступної події. Ack легальний за ТЗ: сам інцидент уже на екрані. */
  const { index: boardUnreadIx } = useUnreadChanges();
  const incidentsRefreezeKey = (() => {
    const shown = new Set(incidents.map((i) => i.id));
    const markerPart = unreadForSurface(boardUnreadIx, "incidents")
      .filter((m) => m.entity_type === "incident" && shown.has(m.entity_id))
      .map((m) => m.id).sort().join(",");
    const listPart = incidents.map((i) => i.id + ":" + i.status).sort().join("|");
    return listPart + "#" + markerPart;
  })();
  useAckWhenVisible(
    { kind: "surface", surface: "incidents" },
    incidentsLoaded && !incidentsErr,
    incidentsRefreezeKey
  );
  /* с24: незавершені дослідження цієї клініки з ІНШИХ дат. Тримаємо ОКРЕМО від
     `entries` навмисно: на entries зав'язані звук перевищення (useQueueSounds),
     таймери кабінетів і лічильники дня — учорашній запис давав би вічне
     «перевищено час» і псував статистику. Тут вони потрібні рівно для двох
     речей: заблокувати виклик і показати, куди йти закривати. */
  const [stuck, setStuck] = useState<StuckStudy[]>([]);
  /* Стартове `[]` не відрізнити від «хвостів немає» — а від цього залежить, чи
     пускати пацієнта в апарат. Тому окремі прапорці, як у incidents (ревʼю с24,
     H1): поки НЕ завантажено або запит упав — виклик блокуємо (fail-CLOSED) і
     не пишемо «Кабінет вільний». Хибно заблокувати = хвилина затримки й «↻»;
     хибно дозволити = оператор веде пацієнта в зайнятий кабінет і ловить 23505
     про пацієнта, якого на дошці немає. */
  const [stuckFinish, setStuckFinish] = useState<StuckStudy | null>(null);
  const [stuckFinishBusy, setStuckFinishBusy] = useState(false);
  const [stuckLoaded, setStuckLoaded] = useState(false);
  const [stuckErr, setStuckErr] = useState(false);
  /* Два запити в одному reload → відповіді можуть приземлитись урозбій (швидке
     перемикання дат: entries від reload#2 + stuck від reload#1). Лічильник
     поколінь відсікає застарілі (ревʼю с24, M2). */
  const reqGen = useRef(0);
  /* Ключ ПОТОЧНОГО зрізу, доступний із протухлих замикань (ревʼю пакета H-3, р.1).
     `reqGen` рахує ПОРЯДОК ВИДАЧІ, а не актуальність: якщо reload дня A виданий
     ПІЗНІШЕ, ніж reload дня B (дебаунс realtime тримає колбек 250 мс; server action
     тримає замикання на час await), то A має більший gen і відкидає відповідь B.
     Далі знімок лягає зі scope=A, а на екрані вже B → scopeReady=false назавжди,
     `loading` уже знято, і перезапитати нікому: useEffect завʼязаний на identity
     `reload`, яка не змінювалась. Дошка залипала б у скелеті до наступної
     realtime-події або focus. Тому протухле замикання виходить ДО ++reqGen —
     і відповідь актуального запиту спокійно доїжджає. */
  const reload = useCallback(async () => {
    if (scopeKeyOf(clinicId, dayKey) !== scopeRef.current) return;   // протухле замикання
    const gen = ++reqGen.current;
    try {
      const supabase = createClient();
      /* Авто-«Уточнити» (clarify_at) ставить pg_cron: джоб sink-overdue кожні 5 хв
         викликає sink_overdue_scheduled_all() (supabase/cron_jobs.sql).
         Раніше цю RPC смикав КОЖЕН reload дошки: запис у БД із read-лоадера →
         WAL (replica identity full) + рядок в audit_log + realtime-подія всім
         іншим дошкам, які на неї ж і перезавантажувались. Не повертати. */
      const { data, error } = await supabase
        .from("queue_entries")
        .select("id, patient_name, patient_phone, patient_age, patient_weight, patient_dob, patient_sex, patient_email, scheduled_time, duration_min, buffer_time_min, status, call_status, note, studies, studies_original, studies_changed_by, contraindications, cito, priority_level, doctor, referrer:referrer_id(full_name), room_id, updated_at, in_progress_at, clarify_at, reschedule_origin, off_schedule, case_id, case_step")
        .eq("clinic_id", clinicId)
        .eq("scheduled_date", dayKey)
        .order("scheduled_time", { ascending: true });
      if (gen !== reqGen.current) return;              // приїхала відповідь застарілого запиту
      if (error) { setEntriesErr(true); setStuckErr(true); return; }   // до хвостів не дійшли — отже не знаємо
      /* Знімок кладемо РАЗОМ із ключем зрізу, для якого його запитали, — саме
         це робить «чужий день» невидимим у рендері, а не лише в ефекті. */
      setEntriesSnap({ scope: scopeKeyOf(clinicId, dayKey), rows: (data || []) as unknown as QEntry[] });
      setEntriesErr(false);

      /* Окремий запит — «хвости» in_progress з інших дат. Рядків тут не більше,
         ніж кабінетів (унікальний індекс 0018), тож він дешевий.
         ⚠️ Помилку НЕ ескалюємо в entriesErr — черга від неї не бреше. Але й не
         ковтаємо: піднімаємо stuckErr, який блокує виклик і показує банер. */
      const { data: st, error: stErr } = await supabase
        .from("queue_entries")
        .select("id, room_id, patient_name, scheduled_date")
        .eq("clinic_id", clinicId)
        .eq("status", "in_progress")
        .neq("scheduled_date", dayKey)
        .not("room_id", "is", null);
      if (gen !== reqGen.current) return;
      if (stErr) { setStuckErr(true); return; }         // список НЕ чистимо: старі дані краще за порожні
      setStuck((st || []) as unknown as StuckStudy[]);
      setStuckErr(false);
      setStuckLoaded(true);
    } catch {
      if (gen !== reqGen.current) return;
      setEntriesErr(true); // транзієнтний «Failed to fetch» — не рушимо дошку
      setStuckErr(true);   // ...але про хвости ми теж більше нічого не знаємо
    } finally {
      if (gen === reqGen.current) setLoading(false);
    }
  }, [clinicId, dayKey]);

  const loadIncidents = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("incidents")
        .select("id, room_id, reason, reason_label, note, started_at, blocked_until, status, auto_unblock")
        .eq("clinic_id", clinicId).in("status", ["active", "planned"]);
      if (error) { setIncidentsErr(true); return; } // НЕ чистимо incidents: «немає простоїв» — небезпечна брехня
      /* Простої з auto_unblock знімає pg_cron (джоб resolve-expired-incidents,
         supabase/cron_jobs.sql — кожні 5 хв, активний, перевірено в cron.job).
         Раніше це робив клієнт прямо в лоадері — запис у БД на рефетчі +
         залежність від того, чи в когось відкрита дошка.
         ⚠️ ТУТ БУЛО НЕВІРНЕ ТВЕРДЖЕННЯ (ревʼю U-15 р2): «DB-гард
         check_not_during_incident рахує ВІКНО [started_at, blocked_until), а не
         статус». Функція прочитана з живої БД — вона рахує І ТЕ, І ТЕ:
           `where i.room_id = new.room_id and i.status in ('active','planned')
            and tstzrange(started_at, coalesce(blocked_until,'infinity')) && …`
         Отже між `blocked_until` і найближчим прогоном крона (до 5 хв) рядок
         для клієнта вже «згас» (`incidentExpired`), а для сервера ще діє. Різницю
         видно нижче: фідів тепер ДВА, і вибір між ними — не стиль. */
      const list = data || [];
      setIncidents(list);
      setIncidentsErr(false);
      setIncidentsLoaded(true);
    } catch {
      setIncidentsErr(true);
    }
  }, [clinicId]);

  /* Повертає свіжу мапу (а не лише кладе в стан): обробник конфлікту CAS мусить
     перезаморозити знімок із ЦІЄЇ вибірки, а стан у замиканні на той момент
     ще старий. undefined = вибірка не вдалася. */
  const loadOverrides = useCallback(async (): Promise<Record<string, DayOverride> | undefined> => {
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("schedule_overrides")
        // 0135: updated_at — знімок для CAS (замерзає при відкритті модалки графіка)
        .select("override_date, all_closed, label, rooms, updated_at")
        .eq("clinic_id", clinicId);
      if (error) { setOverridesErr(true); return undefined; }
      const m: Record<string, DayOverride> = {};
      (data || []).forEach((o) => { m[o.override_date] = o as unknown as DayOverride; });
      setOverrides(m);
      setOverridesErr(false);
      return m;
    } catch {
      setOverridesErr(true);
      return undefined;
    }
  }, [clinicId]);

  /* `loading` гасне разом із КЛІНІКОЮ І ДНЕМ. Сам по собі цей ефект дефект
     H-3 не лікує (виконується після paint) — його лікує `scopeReady` у рендері;
     але без dayKey тут «Завантаження…» не показувалось би при зміні дати. */
  /* ⚠️ ВСІ СКИДАННЯ ЗАВʼЯЗАНІ НА `scope`, А НЕ НА ПЕРЕЛІК ВИМІРІВ (ревʼю р.2).
     Зріз — це clinicId + день (+ набір кабінетів у дошці радіолога). Поки виміри
     перелічувались руками (`[clinicId, dayKey]`), додавання третього виміру
     закривало ключ і лоадер, але лишало скидання на двох старих — і при зміні
     набору кабінетів `stuckLoaded` казав «дані свіжі» про ПОПЕРЕДНІЙ набір.
     У кадрі між приземленням запису дня і відповіддю запиту «хвостів» картка
     нового кабінету писала б «Кабінет вільний» із живою кнопкою виклику —
     повернення дефекту M-1 по іншій осі. Один рядковий ключ на всі скидання
     робить таку розсинхронізацію структурно неможливою.
     `entriesErr` теж гаситься тут: помилка ПОПЕРЕДНЬОГО зрізу до нового
     стосунку не має, а через новий порядок гілок вона показала б жорстке
     «Не вдалося завантажити чергу» над днем, запит якого ще в польоті. */
  useEffect(() => { setLoading(true); setEntriesErr(false); }, [scope]);
  /* M-1 ревʼю раунду 2: `stuckLoaded` мусить згасати РАЗОМ із датою й клінікою.
     Інакше після «← Сьогодні» список хвостів ще належить попередньому дню, але
     прапорець каже «дані свіжі» — і в кадрі до відповіді другого запиту картка
     знову писала б «Кабінет вільний» із живою кнопкою виклику. Тобто вихідний
     дефект відтворювався б у вікні 100–300 мс. */
  useEffect(() => { setStuckLoaded(false); setStuckErr(false); }, [scope]);
  /* Тост із дією (soft-undo «↩ Відмінити» після «Неявка»/«Не відбулося») живе 6 с
     і смену дня НЕ переживав: оператор міг натиснути «Відмінити» вже на іншому
     дні — і мутація пішла б по запису, якого на екрані немає, а `expectedFrom`
     шукався б у ЧУЖОМУ зрізі (тобто CAS вироджувався б у сліпий запис).
     Той самий клас «дія по рядку поза поточним зрізом», що й H-3 (ревʼю р.1). */
  useEffect(() => {
    setToast((t) => (t && t.action ? null : t));
  }, [scope]);
  useEffect(() => { reload(); }, [reload]);

  // P2.1 — гарячі клавіші реєстратури. Через e.code (незалежно від розкладки UA/RU/EN);
  // не перехоплюємо у полях вводу та при відкритих модалках.
  /* Хоткей кличе бронювання ЧЕРЕЗ ref на свіжу функцію (та сама ідіома, що
     `scopeRef.current = scope` вище). Причина технічна, але важлива:
     `openBooking` — звичайна функція, нова на кожен рендер. У списку залежностей
     ефекту вона перепідписувала б слухач щоразу; без неї eslint справедливо
     скаржився б на неповний список, а вимкнути правило на масиві з двадцяти
     залежностей означає сховати МАЙБУТНІ пропуски саме там, де пропуск дає
     хоткей зі старим станом. Ref оновлюється на кожен рендер, тож «дані в
     порядку» ніколи не буває застарілим, а список лишається під лінтером. */
  const openBookingRef = useRef(openBooking);
  openBookingRef.current = openBooking;
  // Гард має покривати УСІ оверлеї, інакше хоткеї (N/«/»/R/цифри) стріляють
  // під відкритою модалкою. Раніше бракувало 6 станів — зокрема деструктивних
  // ConfirmDialog (cancelAsk/emergencyConfirm) та DelayPlan/Emergency/Waitlist:
  // під ними «N» відкривав бронювання, «R» перезавантажував дошку тощо.
  //
  // U-70: цей самий прапорець тримає і перенесення дати (useFollowToday нижче).
  // ОДИН список навмисно: другий екземпляр «що зараз відкрито» розійшовся б із
  // цим на першій же новій модалці — і розійшовся б МОВЧКИ.
  //
  // ⚠️ Г1-D (пакет с52). Саме це й сталося: `openCaseId` (CaseModal) у списку
  // НЕ БУВ. Кома-в-кому те, від чого застерігав коментар вище, тільки не через
  // другий екземпляр списку, а через новий оверлей, доданий повз цей.
  // Ціна виміряна, не припущена: `useModalA11y` перехоплює лише Esc і Tab, а
  // слухач хоткеїв відсіює тільки INPUT/TEXTAREA/SELECT — тож під відкритим
  // кейсом «N» відкривало БРОНЮВАННЯ поверх кейса, «R» перезавантажувало дошку
  // під ним, цифри міняли кабінет, «/» викидало фокус із діалога в пошук, а
  // j/k наводили фокус на рядок ПОЗАДУ вікна. І поверх усього — поправка
  // годинника переставляла добу дошки під набором кроків кейса.
  // Повнота цього списку тепер перевіряється (tests/followToday.test.ts):
  // сторож рахує гейти оверлеїв ПО ДЖЕРЕЛУ і звіряє з операндами тут, тож
  // наступна нова модалка не пройде мовчки.
  //
  // ⚠️ ЦІНА ЦІЄЇ ПРАВКИ, ЯКУ ЧЕСНО НАЗВАТИ (ревʼю А по цьому ж пакету). `today`
  // нижче рахується ЖИВИМ `wallToday0`, а `selectedDate` під `busy` стоїть, —
  // тож поки перенесення відкладене, `isToday` хибний і `isPast` істинний:
  // за оверлеєм дошка малюється архівом, звук «пацієнт готовий» вимкнено,
  // панелі переносів сховані. Це властивість САМОГО `busy`, вона діяла й для
  // решти 17 оверлеїв; кейс лише робить вікно найдовшим — його набирають
  // хвилинами. Обмін свідомий: альтернатива (як було) — доба дошки їде під
  // відкритим кейсом, а хоткеї стріляють у дошку позаду.
  // ⚠️ Г1-E (с53) ЗАКРИВ ТИШУ ПІСЛЯ ПЕРЕНЕСЕННЯ, А НЕ САМЕ ВІКНО: перенесення й
  // далі чекає закриття оверлея, і доти дошка стоїть на попередній добі —
  // невидима під тим самим оверлеєм. Що змінилось: коли вікно закривається і
  // доба переставляється, дошка про це ГОВОРИТЬ (банер нижче, біля виклику
  // правила). Чому пояснення САМОГО вікна на дошці немає — виміряно там же.
  const anyModalOpen = modalOpen || helpOpen || slotsOverviewOpen || !!openCaseId || !!completeFor || !!reschedFor || !!editStudiesFor || !!editPatientFor || !!caseFromEntryFor || breakdownOpen || schedEditOpen || !!wlSuggest || !!delayPreview || emergencyOpen || !!offCallAsk || !!cancelAsk || !!emergencyConfirm || !!stuckFinish;

  /* U-70: «сьогодні» рахується з ВИМІРЯНОГО годинника, тож поправка, що
     перетинає північ клініки, лишила б дошку на попередній добі — вона мовчки
     стала б архівом. Правило (і його межі) живуть у lib/useFollowToday.ts —
     один екземпляр на цю дошку й на дошку радіолога.

     ⚠️ Г1-E (с53, рішення власника — «банер, як у форм»). Досі ця дошка була
     ЄДИНИМ споживачем правила, який не брав `onShift`: доба переставлялась
     МОВЧКИ. Тепер про це говорить банер «дату дошки змінено з X на Y» — вище,
     першим у стовпці.

     ⚠️ ГЕЙТИ НЕ ЧІПАЄМО, і це вимір, а не обережність. `isToday` рахується від
     ВИМІРЯНОГО «сьогодні» (`today` вище), тож поки дошка стоїть на іншій добі,
     «не сьогодні» — ПРАВДА: `computeCallBlock({ notToday })` закриває виклик, а
     `useQueueSounds` глушить звук саме тому, що показана доба справді не
     сьогоднішня. Зробити `isToday` істинним означало б відкрити «Викликати» на
     добі, яку виміряний годинник сьогоднішньою не вважає — а вікно довге не
     лише опівночі: воно завдовжки з саму поправку, тобто на збитій даті ПК це
     чужий день серед білого дня.

     ⚠️ ВІДКЛАДЕНЕ перенесення (`pendingShift`) ця дошка НЕ показує, і це
     ВИМІРЯНО, а не забуто. Ядро віддає непорожній `pending` ЛИШЕ під `busy`
     (див. гілку відкладання в `decideShift`), а `busy` тут — це рівно
     `anyModalOpen`, і кожен оверлей із цього списку малюється як
     `.overlay` (`position: fixed; inset: 0; z-index: 200;
     background: rgba(0,0,0,0.55); backdrop-filter: blur(6px)`). Тобто банер
     про відкладене перенесення існував би РІВНО тоді, коли дошку не видно, і
     зникав би в мить, коли її відкривають; єдиний кадр, у якому він потрапляє
     на пікселі, — після закриття вікна, і в ньому його текст «доки відкрите
     вікно» вже неправда. Перша редакція Г1-E такий банер мала — його знято за
     рішенням власника після цього виміру. Місце, де пояснення справді було б
     видно, — САМЕ ВІКНО; це окремий пакет, названий у хендофі. */
  const [dayShifted, setDayShifted] = useState<DayShiftNotice | null>(null);
  useFollowToday({ clinicTz, pinnedKey: initialDate, busy: anyModalOpen, value: selectedDate, setDate: setSelectedDate,
    onShift: (d, prev) => setDayShifted((s) => dayShiftNoticeOf(s, prev, d)) });
  /* Дату взяла в руки ЛЮДИНА — банер про автоперенесення відпрацював. Гасимо
     ЯВНО, хоч `dayShiftNoticeVisible` і сам сховає банер на чужій добі: умова
     про безпеку (не брехати про добу, якої на екрані вже немає), а це — про
     намір (оператор побачив і пішов далі, банер не має повертатись). */
  const pickDate = useCallback((d: Date) => { setDayShifted(null); setSelectedDate(d); }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (anyModalOpen) return;
      const code = e.code;
      // «?» (Shift+/) — довідка гарячих клавіш. Перевіряємо ДО «/», бо Shift+/ теж має code="Slash".
      if (e.key === "?" || (code === "Slash" && e.shiftKey)) { e.preventDefault(); setHelpOpen(true); }
      // Через openBooking, а не setModalOpen: гейт safetyErr — один на всі входи.
      else if (code === "KeyN") { e.preventDefault(); openBookingRef.current(); }
      else if ((code === "Slash" || e.key === "/") && !e.shiftKey) { e.preventDefault(); searchRef.current?.focus(); }
      else if (code === "KeyR") { e.preventDefault(); reload(); }
      else if (code === "Backquote" || code === "Digit0") { setRoomView("all"); }
      else if (/^Digit[1-9]$/.test(code)) { const i = parseInt(code.slice(5), 10) - 1; const rs = visRooms; if (rs[i]) setRoomView(rs[i].id); }
      else if (code === "KeyJ" || code === "KeyK") {
        // j/k — навігація по рядках черги (vim-style). Рухаємо DOM-фокус між
        // інтерактивними рядками (.qrow[role=button]); скелетони-заглушки пропускаємо.
        e.preventDefault();
        const rows = Array.from(document.querySelectorAll<HTMLElement>('.qrow[role="button"]'));
        if (!rows.length) return;
        const cur = document.activeElement as HTMLElement | null;
        const idx = rows.findIndex((r) => r === cur || r.contains(cur));
        const next = code === "KeyJ"
          ? (idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1))
          : (idx < 0 ? rows.length - 1 : Math.max(0, idx - 1));
        rows[next]?.focus();
        rows[next]?.scrollIntoView({ block: "nearest" });
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [anyModalOpen, reload, visRooms]);

  const rtHealth = useRealtimeRefetch({
    channelName: clinicId ? "queue-" + clinicId : null,
    subscriptions: [
      /* `reload()` перечитує лише записи. Але поки в центрі є кабінет-залишок,
         зміна запису може ще й ПРИБРАТИ його зі списку («вимкнено · 1 запис» →
         кабінет зникає) — а residual приходить SSR-пропом, тож без refresh підпис
         брехав би саме тоді, коли на нього дивляться. Умова обов'язкова: без
         залишків це був би зайвий refresh на кожну зміну статусу. */
      { table: "queue_entries", filter: "clinic_id=eq." + clinicId,
        onChange: () => { reload(); if ((residualRoomIds?.length ?? 0) > 0) router.refresh(); } },
      /* Залишок може триматись САМЕ вейтліст-броню (residualOffRooms рахує обидві
         таблиці), а дошка черги на waitlist_entries інакше не підписана — тоді
         кабінет висів би в сайдбарі до перезавантаження. Підписка потрібна ЛИШЕ
         заради цього, тож нічого, крім refresh, вона не робить. */
      { table: "waitlist_entries", filter: "clinic_id=eq." + clinicId,
        onChange: () => { if ((residualRoomIds?.length ?? 0) > 0) router.refresh(); } },
      { table: "incidents", filter: "clinic_id=eq." + clinicId, onChange: loadIncidents },
      { table: "schedule_overrides", filter: "clinic_id=eq." + clinicId, onChange: loadOverrides },
      // 0086: rooms — SSR-проп; видалення/правка базового графіка кабінету долітає
      // до всіх ролей через перечитування серверних пропів (router.refresh).
      { table: "rooms", filter: "clinic_id=eq." + clinicId, onChange: () => router.refresh() },
      // Каталог послуг/цін (0107/0108) — SSR-проп у форми запису: зміна адміном
      // (вимкнення послуги, override кабінету) має оновити відкриту форму, а не
      // лишати старий каталог. Низькооборотні таблиці → router.refresh (як rooms).
      { table: "services", filter: "clinic_id=eq." + clinicId, onChange: () => router.refresh() },
      { table: "service_room_overrides", filter: "clinic_id=eq." + clinicId, onChange: () => router.refresh() },
    ],
  });

  /* Звукові сповіщення (три профілі): «пацієнт готовий»
     (scheduled → waiting, лише сьогодні за TZ клініки) + критичні (перший
     перехід у needs_reschedule, інцидент, що фактично став активним).
     Snapshot-логіка сидить ПОВЕРХ наявних лоадерів — useRealtimeRefetch не
     чіпаємо; стан дошки вже включає оптимістичні оновлення, тож власна дія
     оператора і realtime-refetch за нею дають один перехід, не два. Помилкові
     snapshot'и (entriesErr/incidentsErr) baseline не чіпають. */
  /* Контракт джерела перевищень: якщо з select приберуть in_progress_at /
     duration_min / buffer_time_min, TS впаде саме тут, а не мовчки перейде на
     дефолти 30+5 і розійдеться з таймером кабінету (ревʼю M4). */
  const overrunSource: OverrunSource[] = entries;
  void overrunSource;
  useQueueSounds({
    scopeKey: "queue|" + clinicId + "|" + dayKey,
    active: roleKey === "admin" || roleKey === "registrar",
    entries: loading || !scopeReady || entriesErr ? null : entries,
    readyEnabled: isToday,
    incidents: !incidentsLoaded || incidentsErr ? null : incidents,
    incidentScopeKey: clinicId, // інциденти живуть поза денним scope
    overrunEnabled: isToday,    // «дослідження довше плану» — лише сьогоднішня дошка
  });

  /* U-16: ОДИН фід на всіх дітей і на всі похідні дошки. Доти вниз їхала гола
     мапа, а прапорець збою лишався тут — і кожен споживач сам вирішував, що
     означає порожній `{}`. Тепер джерело одне, і забути прапорець неможливо:
     тип пропа без нього не збереться. */
  const overridesFeed = overrideFeed(overrides, overridesErr);
  /* Сира строка — ТІЛЬКИ для редактора графіка: він її не інтерпретує, а
     редагує, і CAS по `updated_at` ловить розбіжність сам. */
  const selectedOverride = overrides[dayKey] || null;
  // Базові графіки кабінетів → «вихідний» у календарі за реальним графіком, не лише неділею.
  /* Лише за графіками кабінетів, які реально працюють: вимкнений кабінет із
     робочою неділею інакше показував би неділю робочою для всього центру. */
  const roomSchedules = bookableRooms(rooms).map((r) => r.schedule);
  // `null` = графіки не прочитались → про день не стверджуємо нічого.
  const selDayStatus = dayStatusFromFeed(overridesFeed, selectedDate, roomSchedules);

  /* 0135, CAS: знімок `updated_at` ЗАМЕРЗАЄ при ВІДКРИТТІ модалки, а не читається
     з живої мапи overrides у момент збереження — realtime довозить чужу правку
     ДО кліку «Зберегти», і CAS зі свіжою міткою «підтвердив» би затирання.
     `null` = «override не існував». Мітку не проганяти через Date (0119). */
  const schedSnapRef = useRef<string | null>(null);
  /* Лічильник ремоунтів модалки графіка (key). Конфлікт CAS без ремоунту — штопор:
     roomState і знімок замерзли від старого стану, повторне «Зберегти» приречене
     назавжди (ревʼю р.1 шагу 2). Ремоунт оновлює ОБИДВА разом — оновлювати лише
     знімок не можна: свіжа мітка при старому roomState «узаконила» б затирання
     чужої правки, тобто повернула б H-5. */
  const [schedEditEpoch, setSchedEditEpoch] = useState(0);
  function openSchedEdit() {
    /* U-16: редагувати те, чого не прочитали, не можна. Модалка відкрилась би
       як «особливого графіка немає» — тобто показала б порожню форму на дні,
       у якого override є. Затирання ловив би CAS (знімок null → sched_conflict),
       але користувач до того встиг би заповнити форму наосліп. */
    if (overridesErr) { notify("Особливі графіки не завантажились — оновіть сторінку", "error"); return; }
    schedSnapRef.current = (overrides[dayKey] || null)?.updated_at ?? null;
    setSchedEditOpen(true);
  }
  /* Конфлікт CAS: перечитати overrides, перезаморозити знімок зі СВІЖОЇ вибірки
     (не зі стану — він у цьому замиканні старий) і ремоунтнути відкриту модалку.
     Якщо вибірка не вдалась — знімок лишається старим: повторне збереження чесно
     дасть конфлікт знову, а не затре чужу правку. */
  async function schedConflictRecover() {
    const fresh = await loadOverrides();
    /* Ремоунт — ЛИШЕ зі свіжими даними: без них він стер би правки користувача,
       нічого не давши взамін (стара пара «знімок + existing» і так консистентна,
       повторне збереження чесно конфліктне, банер overridesErr уже видно). */
    if (!fresh) return;
    schedSnapRef.current = fresh[dayKey]?.updated_at ?? null;
    setSchedEditEpoch((e) => e + 1);
  }
  /* Гард від подвійного кліку «Зберегти»/«Скинути» (інваріант с28): два польоти
     з одним знімком інакше дають «Помилка: конфлікт» ПОВЕРХ успішного тосту —
     оператор бачить вранє про фактично збережений графік. */
  const schedBusyRef = useRef(false);
  async function saveOverride(ov: { all_closed: boolean; label?: string; rooms: Record<string, { closed?: boolean; start?: string; end?: string; breaks?: { start: string; end: string }[] }> }) {
    if (schedBusyRef.current) return;
    schedBusyRef.current = true;
    try {
      const res = await saveScheduleOverride({ overrideDate: dayKey, allClosed: !!ov.all_closed, label: ov.label || null, rooms: ov.rooms || {}, expectedUpdatedAt: schedSnapRef.current });
      /* Модалку закриваємо ЛИШЕ при успіху: закриття до перевірки знищувало б
         незбережену роботу користувача рівно в момент конфлікту (ревʼю 0135). */
      if (!res.ok) {
        notify("Помилка: " + res.error, "error");
        if (res.code === "sched_conflict") await schedConflictRecover();
        return;
      }
      setSchedEditOpen(false);
      notify("Графік оновлено", "success");
      loadOverrides();
    } finally {
      schedBusyRef.current = false;
    }
  }
  async function resetOverride() {
    if (schedBusyRef.current) return;
    schedBusyRef.current = true;
    try {
      const res = await resetScheduleOverride(dayKey, schedSnapRef.current);
      if (!res.ok) {
        notify("Помилка: " + res.error, "error");
        if (res.code === "sched_conflict") await schedConflictRecover();
        return;
      }
      setSchedEditOpen(false);
      notify("Повернуто типовий графік", "success");
      loadOverrides();
    } finally {
      schedBusyRef.current = false;
    }
  }
  const schedOf = (roomId: string) => (rooms || []).find((r) => r.id === roomId)?.schedule;
  /* U-16: `null` = графіки не прочитались → повертаємо false, тобто НЕ
     стверджуємо «зачинено». Протилежне рішення («невідомо → зачинено»)
     виглядає безпечнішим, але змусило б усі картки кабінетів написати
     «🚫 Зачинено» на кожному збої мережі — брехня в інший бік (U-1/U-2).
     Небезпечний бік прикритий раніше й жорсткіше: виклик пацієнта відбиває
     safety_unknown, який у computeCallBlock стоїть ПЕРЕД room_closed, а новий
     запис і перенос — гейт safetyErr. */
  function roomSchedClosed(roomId: string) {
    return roomScheduleFromFeed(selectedDate, roomId, overridesFeed, schedOf(roomId))?.closed ?? false;
  }
  /* ⚠️ А ось для СПИСКУ ОБДЗВОНУ («Постраждалі») напрямок ПРОТИЛЕЖНИЙ, і це
     знайшло ревʼю р1 (F2) як регресію самої правки. `roomSchedClosed` при
     невідомості віддає false — там це правильно (не стверджувати «Зачинено» на
     картці). Але тут вердикт не підпис, а ПЕРЕЛІК ПАЦІЄНТІВ, яким треба
     подзвонити: не подзвонити людині, що приїде в зачинений центр, дорожче,
     ніж подзвонити зайвій. До правки список рахувався з базового тижневого
     графіка (бо `selectedOverride` при збої й так був null) — правка мовчки
     спорожнила панель, і вона зникала цілком (`if (!affected.length) return null`).
     Тому при непрочитаних графіках падаємо на БАЗОВИЙ графік кабінету: він
     приходить SSR-пропом і від `schedule_overrides` не залежить, тобто це
     строго більше інформації, ніж порожній список. */
  function roomClosedForCallList(roomId: string) {
    const s = roomScheduleFromFeed(selectedDate, roomId, overridesFeed, schedOf(roomId));
    if (s) return s.closed;
    return roomScheduleFor(selectedDate, roomId, null, schedOf(roomId)).closed;
  }
  /* Похідне попередження «Не за графіком»: час запису не вкладається в ПОТОЧНИЙ графік
     кабінета (закритий день / до відкриття / за кінець / у перерву). На відміну від
     `off_schedule` (осознанний запис за графіком, підтверджений персоналом), це
     «дрейф» — напр. графік ужали ПІСЛЯ запису, і про це ніхто не попередив. Показуємо
     лише для не-осознанних і живих записів; фікс поруч — «→ Найближче вільне». */
  function schedDriftFor(p: QEntry): string | null {
    if (!p.room_id || !p.scheduled_time || p.off_schedule) return null;
    if (["done", "no_show", "not_held", "cancelled", "needs_reschedule"].includes(p.status)) return null;
    /* U-16: «Не за графіком» — ТВЕРДЖЕННЯ, і на непрочитаних графіках воно
       помиляється в ОБИДВА боки: день, який override відкриває (чергування в
       неділю), виглядав би порушенням, а день, який override закриває, не
       позначався б зовсім. Мовчимо — причину видно в банері над дошкою. */
    const drSched = roomScheduleFromFeed(selectedDate, p.room_id, overridesFeed, schedOf(p.room_id));
    const drBreaks = roomBreaksFromFeed(selectedDate, p.room_id, schedOf(p.room_id), overridesFeed);
    if (!drSched || !drBreaks) return null;
    const osk = offScheduleKind(slotToMin(p.scheduled_time), p.duration_min || 30, drSched, drBreaks);
    if (!osk) return null;
    const why = osk.kind === "closed" ? "кабінет не працює цього дня"
      : osk.kind === "before_start" ? "запис раніше відкриття кабінета"
      : (osk.kind === "after_end" || osk.kind === "too_late") ? ("виходить за кінець графіка" + (osk.end ? " (до " + osk.end + ")" : ""))
      : osk.brk ? ("припадає на перерву " + osk.brk.start + "–" + osk.brk.end) : "поза графіком кабінета";
    return "⚠ Не за графіком: " + why + ". Можливо, графік змінили після запису — перенесіть на вільне вікно.";
  }

  const liveIncidents = incidents.filter((i) => !incidentExpired(i));
  /* U-11: у дітей — ФІД (рядки + чи вдалося прочитати). Раніше вниз їхав голий
     масив, і при incidentsErr це було `[]`: кабінет на ремонті малювався вільним
     у CollisionPanel, QuickRescheduleButton, RoomDayOverviewModal, BreakdownModal
     і в модалках запису. Один вираз на всі точки — щоб копії не розійшлись. */
  const incidentsFeed = incidentFeed(liveIncidents, incidentsErr);
  /* А ЗАВАНТАЖЕНОСТІ потрібні ВСІ простої дня, включно зі знятими: вона рахує
     ЄМНІСТЬ ДНЯ, а `incidentExpired` — предикат «ЗАРАЗ» (auto_unblock і
     blocked_until у минулому). Чотиригодинне ТО зранку зменшило ємність, навіть
     якщо о 14:00 його вже знято; на минулих днях так відпали б узагалі всі
     простої. Ревʼю р2 (F1): перший варіант правки передав сюди liveIncidents і
     тихо занизив відсоток — рівно те викривлення, яке пакет і прибирає. */
  const loadIncidentsFeed = incidentFeed(incidents, incidentsErr);
  /* ФІД ДЛЯ ФОРМ, ЩО ПИШУТЬ `queue_entries` (U-15, ревʼю р2).
     Дзеркалить предикат тригера `check_not_during_incident` РІВНО: він відбирає
     рядки за `status in ('active','planned')` — тобто саме те, що приїхало із
     запиту. ⚠️ Точне формулювання (с49): `blocked_until` гард ЗНАЄ — це верхня
     межа його `tstzrange`, — але НЕ порівнює її з `now()`. Тому рядок, що для
     клієнта вже «згас», для сервера й далі ріже свій відрізок часу.
     `incidentsFeed` вище
     додатково викидає «згаслі» (`incidentExpired`), і це правильно для питання
     «чи заблокований кабінет ЗАРАЗ» (виклики, картки, банери), але НЕ для
     питання «чи прийме це сервер»: у вікні до 5 хв між `blocked_until` і
     прогоном крона форма обіцяла збереження, яке тригер відхиляє. Рівно той
     клас брехні, заради якого U-15 і робився.
     Той самий висновок, що з `loadIncidentsFeed` у ревʼю U-11 (F1): один масив
     на два різні питання — і одне з них отримує неправильну відповідь.
     ⚠️ U-33 (с49): на цей фід переведені ВСІ форми й поради, що пишуть
     `queue_entries` — BookingModal (обидва входи), RescheduleModal,
     WaitlistCandidatesModal, CollisionPanel, QuickRescheduleButton. До того
     дошка була ЄДИНИМ екраном, який викидав «згаслі» простої: CallListBoard і
     ReferralPortal подають сирий фід, тобто адміністратор і направник давали
     різні відповіді на ОДНОМУ записі. Тепер однакові.
     ⚠️ На `incidentsFeed` свідомо лишились екрани, що питають «чи заблоковано
     ЗАРАЗ»: картки кабінетів, банери, BreakdownModal (він простої і знімає) та
     RoomDayOverviewModal (борг U-43: огляд ДНЯ мав би показувати і зняті
     простої, бо вони зайняли години, — але це читання, і йому потрібна власна
     жива перевірка). */
  const writeIncidentsFeed = loadIncidentsFeed;
  // Аварійна зупинка: активні інциденти reason='emergency' → кабінети зупинено.
  const emergencyRooms = Array.from(new Set(liveIncidents.filter((i) => i.reason === "emergency").map((i) => i.room_id)));
  const emergencyActive = emergencyRooms.length > 0;
  // Одна формула групування на два екрани (с50): рукописних копій було дві, і
  // вони встигли розійтись — див. `groupIncidentsByRoom` у lib/incidents.ts.
  const incidentsByRoom = groupIncidentsByRoom(liveIncidents);
  const blockingByRoom: Record<string, IncidentRow> = {};
  liveIncidents.forEach((i) => {
    const s = new Date(i.started_at).getTime();
    if (wallNow() >= s && wallNow() < incidentEffectiveEnd(i)) blockingByRoom[i.room_id] = i;
  });

  const affectedIds = new Set<string>();
  if (!isPast) {
    entries.forEach((e) => {
      if (e.status !== "scheduled" && e.status !== "waiting") return;
      const incs = e.room_id ? incidentsByRoom[e.room_id] : null;
      // durationMin обовʼязковий із с50: постраждалим є запис, ІНТЕРВАЛ якого
      // перетинає простій, а не лише той, чий старт у нього потрапив.
      if (incs && incs.some((inc) => entryInIncidentWindow(dayKey, e.scheduled_time, e.duration_min, inc))) { affectedIds.add(e.id); return; }
      if (e.room_id && roomClosedForCallList(e.room_id)) affectedIds.add(e.id);
    });
  }
  const affected = entries.filter((e) => affectedIds.has(e.id));
  const citoList = entries.filter((e) => e.cito && (e.status === "scheduled" || e.status === "waiting" || e.status === "in_progress"));

  async function submitIncident(payload: IncidentPayload) {
    const res = await submitIncidentAction({
      id: payload.id, roomId: payload.roomId, reason: payload.reason, reasonLabel: payload.reasonLabel,
      note: payload.note, startedAt: payload.startedAt, blockedUntil: payload.blockedUntil, autoUnblock: payload.autoUnblock !== false,
    });
    if (!res.ok) {
      notify(res.code === "duplicate" ? "Кабінет уже має активний простій" : "Помилка: " + res.error, "error");
      return;
    }
    notify(payload.id ? "Збережено" : (res.status === "planned" ? "Заплановано простій" : "Апарат заблоковано"), "success");
    loadIncidents();
    reload();
  }

  async function doEmergencyStop(roomIds: string[], note: string) {
    setEmergencyBusy(true);
    // Дату «цього дня» рахує СЕРВЕР у настінному часі клініки: dateKey(new Date())
    // дав би день браузера оператора (біля півночі / в іншій зоні — не той день).
    const res = await emergencyStopAction({ roomIds, note: note || null });
    setEmergencyBusy(false);
    if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
    // Кабінет, який УЖЕ стоїть на простої (поломка/ТО), другого інциденту не отримує
    // (unique-індекс «один активний інцидент на кабінет», 0017). Пацієнтів його все
    // одно позначено на обдзвон, але зняти аварію з нього «Відновити роботу» не зможе —
    // він знімається як поломка. Мовчки втрачати кабінет в аварії не можна.
    const skipped = roomIds.length - (res.stopped ?? 0);
    notify(
      `Аварійна зупинка: кабінетів ${res.stopped}, на обдзвон ${res.affected}` +
        (skipped > 0 ? ` · ${skipped} вже були у простої (знімати — як простій)` : ""),
      "error"
    );
    setEmergencyOpen(false);
    reload();
  }
  // Відновлюємо ЛИШЕ передані кабінети (порожній список сервер відхилить):
  // раніше виклик без id знімав аварію з усіх кабінетів клініки.
  async function doEmergencyResume(roomIds: string[]) {
    if (!roomIds.length) return;
    setEmergencyBusy(true);
    const res = await resolveEmergencyAction({ roomIds });
    setEmergencyBusy(false);
    if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
    if (res.resolved === 0) { notify("Аварійних зупинок не знято — оновіть сторінку", "error"); loadIncidents(); return; }
    notify(res.resolved === 1 ? "Роботу кабінету відновлено" : `Відновлено кабінетів: ${res.resolved}`, "success");
    setEmergencyOpen(false);
    reload();
  }
  // Кнопка «Аварійна зупинка»: на «Усі кабінети» — модалка вибору; на конкретному
  // кабінеті — тумблер саме цього кабінету через підтвердження (проти випадкового
  // натискання; модалка «Усі кабінети» вже сама вимагає свідомого «Зупинити»).
  function handleEmergencyClick() {
    if (roomView === "all") { setEmergencyOpen(true); return; }
    setEmergencyConfirm({ roomId: roomView, action: emergencyRooms.includes(roomView) ? "resume" : "stop" });
  }

  async function resolveIncident(idOrInc: string | IncidentRow) {
    const id = typeof idOrInc === "string" ? idOrInc : idOrInc?.id;
    if (!id) return;
    const res = await resolveIncidentAction(id);
    if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
    notify("Знято", "success");
    loadIncidents();
    reload();
  }

  /* Закриття «хвоста» прямо з картки кабінету (ревʼю с24, H2).
     ⚠️ НЕ через локальний setStatus(): той бере expectedFrom із `entries`, а
     хвоста там немає за визначенням (він з іншої дати) — CAS би просто зник.
     Тут expectedFrom задаємо явно: якщо запис уже закрив колега, сервер поверне
     stale, і ми скажемо про це замість тихого перезапису чужої дії.
     Тільки «виконано»: якщо дослідження НЕ відбулося, потрібні причина й
     нотатка — для цього лишається перехід на ту дату з повним набором дій. */
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

  /* expectedOverride — ЯВНИЙ CAS-очікуваний статус для ВІДКЛАДЕНИХ викликів
     (soft-undo в тості). Без нього відкат читав би `entriesSnap` із ЗАМИКАННЯ
     того рендера, в якому створювався коллбек тоста, — а там ще стоїть статус
     ДО дії. Сервер порівнював би `scheduled` з фактичним `no_show`, RPC давав
     updated=false, і користувач бачив «Статус змінив інший користувач», хоча
     міняв сам секунду тому (живий прогон с37: відтворено тричі, у т.ч. з
     паузою 4.5 с — тобто це не гонка, а протухле замикання).
     Передаємо САМЕ той статус, який щойно поставили: відкат застосується, лише
     якщо відтоді ніхто нічого не змінив. Якщо змінив — CAS відмовить, і те
     саме повідомлення стане ПРАВДОЮ. */
  async function setStatus(id: string, status: string, expectedOverride?: QueueStatus): Promise<boolean> {
    // H-2: фиксируем статус, который сейчас видит оператор (до оптимистичного
    // обновления) — как expectedFrom для CAS на сервере.
    /* Джерело — САМ ЗНІМОК, а не відфільтрований по зрізу `entries` (ревʼю р.2).
       При `!scopeReady` `entries` = порожня константа, тож `find` повертав би
       undefined — а сервер трактує відсутній `expectedFrom` як «CAS не потрібен»
       і робить звичайний last-write-wins. Тобто рівно в кадрі неузгодженого
       зрізу захист від «статус змінив інший користувач» тихо вимикався б.
       Знімок містить рядок навіть тоді, коли він не показаний. */
    const expectedFrom = expectedOverride
      ?? (entriesSnap.rows.find((e) => e.id === id)?.status as QueueStatus | undefined);
    /* ⚠️ U-70: інстант береться з `serverNow()`. Це ОПТИМІСТИЧНЕ значення
       `in_progress_at`, яке живе до відповіді сервера, а читає його
       `StudyTimer`/LiveTimer — уже з поправкою. На ПК, що поспішає на 8 хв,
       незіставні годинники дали б «минуло −8 хв» рівно в перші секунди після
       натискання «Викликати», тобто саме тоді, коли на таймер і дивляться. */
    const nowIso = new Date(serverNow()).toISOString();
    /* 0129 (ревʼю с26 р2 L-2): БД більше НЕ скидає in_progress_at на повторному
       in_progress → оптимістичний патч теж не має обнуляти таймер «у кабінеті»,
       якщо запис уже in_progress — інакше до reload() екран бреше. */
    setEntries((es) => es.map((e) => {
      if (e.id !== id) return e;
      const patch = status === "in_progress"
        ? { status, in_progress_at: e.status === "in_progress" ? e.in_progress_at : nowIso }
        : { status };
      return { ...e, ...patch, updated_at: nowIso };
    }));
    const res = await setQueueEntryStatus(id, status as QueueStatus, expectedFrom);
    if (!res.ok) {
      let msg;
      if (res.code === "room_busy") msg = "У кабінеті вже є пацієнт — спершу завершіть поточного";
      else if (res.code === "slot_unavailable") msg = "Слот недоступний (зайнятий або простій) — перенесіть пацієнта на інший час";
      else if (res.code === "stale") msg = "Статус змінив інший користувач — дошку оновлено";
      else msg = "Помилка: " + res.error;
      notify(msg, "error");
      reload();
      return false;
    }
    reload();
    return true;
  }
  const arrive = (p: QEntry) => setStatus(p.id, "waiting");
  const undo = (p: QEntry) => setStatus(p.id, "scheduled");
  /* Soft-undo (принцип «реверсивність замість підтверджень», UX-схема §5.3):
     деструктивна дія виконується ОДРАЗУ, а тост дає 6 с на відкат — без блокуючої
     модалки. Відкат повертає САМЕ той статус, який оператор бачив до дії
     (guard_status_transition 0069 дозволяє будь-який перехід, крім →done не з кабінету;
     якщо сервер відхилить відкат — покажемо помилку й синхронізуємо дошку). */
  const noShow = async (p: QEntry) => {
    // Знімок, а не `entries`: при неузгодженому зрізі останній порожній (ревʼю р.2).
    const prev = (entriesSnap.rows.find((e) => e.id === p.id)?.status ?? p.status) as string;
    if (await setStatus(p.id, "no_show")) {
      notify("Позначено: неявка", "info", { label: "↩ Відмінити", onAction: () => setStatus(p.id, prev, "no_show") });
    }
  };
  const notHeld = async (p: QEntry) => {
    // Знімок, а не `entries`: при неузгодженому зрізі останній порожній (ревʼю р.2).
    const prev = (entriesSnap.rows.find((e) => e.id === p.id)?.status ?? p.status) as string;
    if (await setStatus(p.id, "not_held")) {
      notify("Позначено: не відбулося", "info", { label: "↩ Відмінити", onAction: () => setStatus(p.id, prev, "not_held") });
    }
  };
  const openComplete = (p: QEntry) => setCompleteFor(p);

  async function finishComplete(status: "done" | "no_show" | "not_held", extraNote: string) {
    const p = completeFor;
    if (!p) return;
    const note = [p.note, extraNote].map((x) => (x || "").trim()).filter(Boolean).join(" · ") || null;
    const res = await completeQueueEntry(p.id, status, note);
    setCompleteFor(null);
    if (!res.ok) {
      if (handledStale(res)) return;   // запис уже скасовано/завершено іншим оператором
      notify("Помилка: " + res.error, "error");
      return;
    }
    notify(status === "done" ? "Процедуру завершено" : "Позначено: не відбулося", "success");
    reload();
  }

  /* CAS-промах (аудит H-4): сервер відхилив мутацію, бо запис уже не в тому стані,
     який бачить оператор (колега завершив/скасував/перезаписав). Показуємо причину
     і ОДРАЗУ синхронізуємо дошку — інакше оператор дивиться на застарілу картку
     і б'є в кнопку ще раз. */
  function handledStale(res: { ok: boolean; code?: string; error?: string }): boolean {
    if (res.ok || res.code !== "stale") return false;
    notify(res.error || "Стан змінився — оновіть дошку", "error");
    reload();
    loadIncidents();
    return true;
  }

  // Після звільнення слота — запропонувати кандидатів з листа очікування.
  async function suggestWaitlistFor(p: QEntry) {
    /* 0123: у вимкненому кабінеті звільнений слот нікому не пропонуємо — запис
       туди відхилить тригер, і панель кандидатів була б дорогою в нікуди. */
    const rm = (rooms || []).find((r) => r.id === p.room_id);
    if (rm && !isRoomBookable(rm)) return;
    const slot: FreedSlotInfo = { date: dayKey, time: p.scheduled_time, roomId: p.room_id };
    const candidates = await fetchWaitlistCandidates(slot);
    if (candidates.length) setWlSuggest({ slot, candidates });
  }

  async function toWaitlist(p: QEntry) {
    const res = await addEntryToWaitlist(p.id);
    if (!res.ok) {
      notify(res.code === "duplicate" ? "Пацієнт уже в листі очікування" : "Помилка: " + res.error, res.code === "duplicate" ? "info" : "error");
      return;
    }
    notify("Додано до листа очікування: " + (p.patient_name || ""), "success");
  }

  // Запізнення → лист очікування: слот звільняється (запис стає «Не відбулося»).
  async function lateToWaitlist(p: QEntry) {
    const res = await addEntryToWaitlist(p.id);
    if (!res.ok) {
      notify(res.code === "duplicate" ? "Пацієнт уже в листі очікування" : "Помилка: " + res.error, res.code === "duplicate" ? "info" : "error");
      return;
    }
    await setStatus(p.id, "not_held");
    notify("Запізнення: додано до листа очікування, запис — «Не відбулося»", "success");
  }

  /* Скасування — незворотна дія для пацієнта (слот звільняється, статус → cancelled),
     тому лише через підтвердження (раніше було в один клік). Те саме стосується
     сегмента «✕ Відмова» у дзвінку-підтвердженні: call_status='declined' сервер
     трактує як СКАСУВАННЯ запису — кнопка про це не попереджала. */
  const [cancelBusy, setCancelBusy] = useState(false);
  function setCallGuarded(p: QEntry, call_status: string) {
    if (call_status === "declined") { setCancelAsk({ p, mode: "declined" }); return; }
    setCall(p, call_status);
  }
  async function cancelBooking(p: QEntry) {
    const res = await cancelQueueEntry(p.id);
    if (!res.ok) {
      if (handledStale(res)) return;
      notify("Помилка: " + res.error, "error");
      return;
    }
    notify("Запис скасовано", "success");
    reload();
    suggestWaitlistFor(p);
  }
  /* Скасування в один клік + soft-undo (UX-схема §5.3): без блокуючої модалки.
     Явна кнопка «✕ Скасувати запис» діє одразу; на «Відмову» в дзвінку лишається
     ConfirmDialog (там скасування — побічний ефект неочевидної дії). */
  async function cancelUndo(p: QEntry) {
    // Знімок, а не `entries`: при неузгодженому зрізі останній порожній (ревʼю р.2).
    const prev = (entriesSnap.rows.find((e) => e.id === p.id)?.status ?? p.status) as string;
    const res = await cancelQueueEntry(p.id);
    if (!res.ok) { if (handledStale(res)) return; notify("Помилка: " + res.error, "error"); return; }
    reload();
    suggestWaitlistFor(p);
    /* ⚠️ soft-undo пропонуємо, ЛИШЕ якщо попередній стан справді відновлюваний.
       `needs_reschedule` таким не є за побудовою: його ставить лише план
       затримки (`queue_set_status_rpc` кидає 42501 на будь-яку спробу виставити
       його вручну, а `zQueueStatus` його навіть не приймає — «Некоректні дані
       запиту»). До с45 ця гілка була мертвою: скасування запису без слота
       поверталось як stale і тост не зʼявлявся взагалі. Відкривши скасування
       (CANCELLABLE_STATUSES), ми відкрили б і зламане «Відмінити» — тому тут
       звичайний тост без дії. Повернути такий запис у чергу можна «Перенести»
       з панелі скасованих. */
    if (prev === "needs_reschedule") { notify("Запис скасовано", "success"); return; }
    notify("Запис скасовано", "info", { label: "↩ Відмінити", onAction: () => setStatus(p.id, prev, "cancelled") });
  }

  async function setCall(p: QEntry, call_status: string) {
    const patch = call_status === "declined" ? { call_status, status: "cancelled" } : { call_status };
    setEntries((es) => es.map((e) => (e.id === p.id ? { ...e, ...patch } : e)));
    const res = await setQueueEntryCall(p.id, call_status as CallStatus);
    if (!res.ok) {
      // «Відмова» скасовує запис — сервер відхилить її, якщо пацієнт уже в кабінеті.
      if (handledStale(res)) return res;
      notify("Помилка: " + res.error, "error");
      reload();
      return res;
    }
    if (call_status === "declined") { notify("Пацієнт відмовився — запис скасовано", "info"); suggestWaitlistFor(p); }
    reload();
    return res;
  }

  /* ОДИН вхід у бронювання на всі точки: топбар, хоткей N і пункт сайдбара.
     Три копії гейта — це рівно те, з чого почався U-6, і ревʼю р3 показало, що
     копія в сайдбарі вже й відстала: банер стверджував «новий запис
     заблоковано», а пункт меню відкривав модалку. Модалка отримує `incidents`
     ПРОПОМ із дошки, тож при incidentsErr це [] — кабінет на ремонті малювався
     б вільним, і відбив би лише тригер check_not_during_incident. */
  function openBooking() {
    if (safetyErr) { notify(SAFETY_BOOKING_BLOCKED, "error"); return; }
    setModalOpen(true);
  }
  /* Перенос — той самий канал: `incidents` теж приходять пропом. Гейт стоїть у
     самому openReschedule, щоб покрити всіх викликачів одразу (рядок, панель
     наложення onManual, панель «потребує переносу»). */
  const openReschedule = (p: QEntry) => {
    if (safetyErr) { notify(SAFETY_BOOKING_BLOCKED, "error"); return; }
    setReschedFor(p);
  };
  /* U-16, ревʼю р1 (F1): карту дня («▦ Зайнятість кабінету») спершу закрили
     гейтом safetyErr — і це була ПОМИЛКА, яку ревʼю й зловило. Гейт не додавав
     жодної заборони: модалка сама ховає сітку і при непрочитаних простоях, і
     при непрочитаних графіках. Зате він забирав єдиний екран, який чесно
     ПОЯСНЮВАВ збій і давав кнопку «Спробувати ще раз» для зайнятості, — а
     заразом робив нову гілку `overridesFailed` недосяжною з головного входу,
     тобто дві правки одного пакета гасили одна одну.
     Тому входу гейта НЕМАЄ свідомо: read-only екран, який відмовляється
     стверджувати і називає причину, кращий за тост «оновіть сторінку».
     Гейт лишається там, де є ДІЯ: openBooking і openReschedule. */
  /* Повертає ТЕКСТ помилки — модалка покаже його в собі (тост тонув під оверлеєм).
     Виняток — 'stale': переносити вже нічого (запис завершено/скасовано), модалку
     закриваємо і синхронізуємо дошку. */
  async function doReschedule({ roomId, date, time, dur, buffer, reason, offSchedule, studies }: { roomId: string; date: Date; time: string; dur: number; buffer: number; reason: string; offSchedule?: boolean; studies?: RescheduleStudy[] }) {
    const p = reschedFor;
    if (!p) return null;
    const [hh, mm] = time.split(":").map(Number);
    const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hh, mm).toISOString();
    const res = await rescheduleQueueEntry({ id: p.id, roomId, scheduledDate: dateKey(date), scheduledTime: time, scheduledAt: at, durationMin: dur, bufferTimeMin: buffer, reason, offSchedule, studies });
    if (!res.ok) {
      if (res.code === "stale") { setReschedFor(null); handledStale(res); return null; }
      reload();   // сітка модалки підтягне свіжу зайнятість
      return (res.code === "slot_taken" || res.code === "slot_unavailable")
        ? "Слот щойно зайняли — оберіть інший"
        : res.code === "incident" ? "Кабінет у простої (поломка/ТО) у цей час — оберіть інший слот або день"
        : res.error;
    }
    setReschedFor(null);
    notify("Перенесено на " + fmtShort(date) + " " + time, "success");
    reload();
    return null;
  }

  /* §5.5 — інлайн-перенос у ТОЙ САМИЙ кабінет на найближче вільне вікно (слот уже
     порахувала QuickRescheduleButton через firstFittingSlot). Прямий виклик
     rescheduleQueueEntry (без модалки reschedFor); сервер валідує check_no_overlap —
     якщо слот щойно зайняли, показуємо помилку й лишаємо повний модал «Перенести». */
  async function quickRescheduleTo(p: QEntry, time: string) {
    if (!p.room_id) return;
    const [hh, mm] = time.split(":").map(Number);
    const at = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate(), hh || 0, mm || 0).toISOString();
    const res = await rescheduleQueueEntry({
      id: p.id, roomId: p.room_id, scheduledDate: dateKey(selectedDate), scheduledTime: time, scheduledAt: at,
      durationMin: p.duration_min || 30, bufferTimeMin: p.buffer_time_min ?? BUFFER_DEFAULT,
      reason: "Перенос на найближче вільне вікно", offSchedule: false,
    });
    if (!res.ok) {
      if (res.code === "stale") { handledStale(res); return; }
      notify((res.code === "slot_taken" || res.code === "slot_unavailable")
        ? "Слот щойно зайняли — оберіть «🗓 Перенести» вручну"
        : res.code === "incident" ? "Кабінет у простої (поломка/ТО) — оберіть інший слот"
        : "Помилка: " + res.error, "error");
      reload();
      return;
    }
    notify("Перенесено на " + time, "success");
    reload();
  }

  /* Колізія: перенос Б в один клік на слот, запропонований CollisionPanel.
     Переносимо ТІЛЬКИ цей запис (не хвіст) і тільки в межах графіка — слот уже
     перевірений firstFittingSlot; сервер валідує ще раз (check_no_overlap). */
  async function doCollisionMove(p: QEntry, roomId: string, time: string) {
    const [hh, mm] = time.split(":").map(Number);
    const at = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate(), hh, mm).toISOString();
    const res = await rescheduleQueueEntry({
      id: p.id, roomId, scheduledDate: dateKey(selectedDate), scheduledTime: time, scheduledAt: at,
      durationMin: p.duration_min || 30, bufferTimeMin: p.buffer_time_min ?? undefined,
      reason: "Накладення: попереднє дослідження затягнулося",
    });
    if (!res.ok) {
      const msg = (res.code === "slot_taken" || res.code === "slot_unavailable")
        ? "Слот щойно зайняли — оновіть і оберіть інший"
        : res.code === "incident" ? "Кабінет у простої в цей час — оберіть інший слот"
        : "Помилка переносу: " + res.error;
      notify(msg, "error");
      reload();
      return;
    }
    const room = roomsById[roomId];
    notify("Перенесено на " + time + (room && roomId !== p.room_id ? " · " + room.name : ""), "success");
    reload();
  }
  async function doCollisionRecall(p: QEntry) {
    const res = await setCall(p, "to_recall");
    if (!res?.ok) return; // помилку вже показав setCall — не перетираємо її «успіхом»
    notify("Пацієнта позначено на обзвін — він у колл-листі", "info");
  }

  /* ===== 0078–0081 — план при затримці дослідження =====
     Джерело плану — запис у кабінеті (in_progress), що затягнувся. Розрахунок
     робить СЕРВЕР (previewDelayPlan): він читає політику центру, графік, простої і
     рахує delay_min у настінному часі клініки. Клієнт лише відмальовує результат.
     Кнопка доступна персоналу центру; ЗАСТОСОВУЄ лише адмін (гейт і в дії, і в RPC). */
  async function openDelayPlan(p: QEntry) {
    if (delayOpening) return;
    setDelayOpening(true);
    try {
      const res = await previewDelayPlan(p.id);
      if (!res.ok) { notify("Не вдалося порахувати план: " + res.error, "error"); return; }
      if (!res.preview) { notify("Затримки немає — черга ще встигає", "info"); return; }
      setDelayPreview(res.preview);
    } catch {
      // Транзиентний збій (рефреш токена / мережа) — не рушимо дошку.
      notify("Не вдалося порахувати план — спробуйте ще раз", "error");
    } finally {
      setDelayOpening(false);
    }
  }

  async function applyDelay(payload: DelayApplyPayload) {
    const src = delayPreview;
    if (!src || delayBusy) return;
    setDelayBusy(true);
    try {
      const res = await applyDelayPlan({
        sourceId: src.sourceId,
        strategy: payload.strategy,
        delayMin: src.delayMin,
        items: payload.items,
        expected: src.expected,           // знімок, який бачив адмін — для stale-звірки в RPC
        reason: payload.reason,
      });
      if (!res.ok) {
        // stale — черга змінилась, поки дивилися план: у БД нічого не змінено.
        notify(res.code === "stale" ? res.error : "Не вдалося застосувати: " + res.error, res.code === "stale" ? "info" : "error");
        setDelayPreview(null);
        reload();
        return;
      }
      const parts = [];
      if (res.moved) parts.push(`зсунуто ${res.moved}`);
      if (res.flagged) parts.push(`у переносі ${res.flagged}`);
      notify("План застосовано" + (parts.length ? ": " + parts.join(", ") : ""), "success");
      setDelayPreview(null);
      reload();
    } catch {
      notify("Не вдалося застосувати план — спробуйте ще раз", "error");
      reload();
    } finally {
      setDelayBusy(false);
    }
  }

  const openEditStudies = (p: QEntry) => setEditStudiesFor(p);
  async function doEditStudies(arr: { type: string; region: string; dur: number }[], meta: { dur: number; buffer?: number; offSchedule: boolean }) {
    const p = editStudiesFor;
    if (!p) return;
    /* 0077: згоду віддає МОДАЛКА (meta.offSchedule) — це або успадкований прапорець
       запису, що вже стоїть поза графіком, або нова галочка, якщо тривалість щойно
       перетнула межу. Брати тут просто p.off_schedule не можна: тоді давня згода
       мовчки дозволяла б розтягувати дослідження далі без нового підтвердження. */
    const res = await editQueueEntryStudies(p.id, (arr || []) as unknown as Json, (meta && meta.dur) || p.duration_min || 30, meta?.buffer, meta.offSchedule);
    setEditStudiesFor(null);
    if (!res.ok) {
      if (handledStale(res)) return;
      notify("Помилка: " + res.error, "error");
      return;
    }
    notify("Дослідження оновлено", "success");
    reload();
  }

  const openCaseFromEntry = (p: QEntry) => setCaseFromEntryFor(p);
  /* Організувати кейс із запису: додаємо крок іншої модальності через
     case_from_entry_rpc (0098). Успіх → відкриваємо екран кейса. Помилку
     (той самий кабінет / перетин часу) повертаємо вікну — воно покаже. */
  async function doCaseFromEntry(b: BookingPayload): Promise<string | null> {
    const p = caseFromEntryFor;
    if (!p) return null;
    const res = await caseFromEntry(p.id, {
      roomId: b.roomId, studies: b.studies, durationMin: b.dur, bufferTimeMin: b.buffer,
      priorityLevel: b.priority, scheduledDate: dateKey(b.date), scheduledTime: b.time,
      contraindications: !!b.hasContra, doctor: b.doctor ?? null, note: b.notes ?? null,
    });
    if (!res.ok) return res.error;
    setCaseFromEntryFor(null);
    reload();
    if (res.id) setOpenCaseId(res.id);   // одразу показуємо організований кейс
    return null;
  }

  const canEditPriority = roleKey === "admin";
  async function doSetPriority(p: QEntry, priority: PatientPriority) {
    const res = await setQueuePriority(p.id, priority);
    if (!res.ok) { notify(res.code === "forbidden" ? "Немає прав змінювати пріоритет" : "Помилка: " + res.error, "error"); return; }
    notify("Пріоритет оновлено: " + PRIORITY_META[priority].short, "success");
    reload();
  }

  function callBlockOf(p: QEntry) {
    const sched = p.room_id ? roomScheduleFromFeed(selectedDate, p.room_id, overridesFeed, schedOf(p.room_id)) : null;
    return computeCallBlock(p, entries, {
      notToday: !isToday,
      roomStuck: p.room_id ? stuckRooms[p.room_id] ?? null : null,
      stuckUnknown,
      /* с46, U-6: простої/графіки не завантажились → blockingByRoom і
         roomSchedClosed нижче пораховані з порожнього списку, тобто «кабінет
         вільний» тут означає «не знаємо». Дошка вже блокує через це НОВИЙ запис
         (кнопка «＋ Новий запис» і банер) — виклик пацієнта в апарат, який може
         стояти на ремонті, тим більше не можна лишати відкритим. */
      safetyUnknown: safetyErr,
      roomBlocked: !!(p.room_id && blockingByRoom[p.room_id]),
      schedClosed: !!(p.room_id && roomSchedClosed(p.room_id)),
      schedEnd: sched && !sched.closed ? sched.end : null,
    });
  }
  /* 0077: ЖОРСТКА причина, чому виклик неможливий. sched_overrun сюди більше не
     потрапляє — робочий день, що скінчився, тепер не блокує виклик, а вимагає
     підтвердження (центр має добити день). Кнопку через це НЕ вимикаємо. */
  function inProgressBlockReason(p: QEntry): string | null {
    const r = callBlockOf(p);
    if (!r || r.confirmable) return null;
    if (r.code === "wrong_day") return "Запис не на сьогодні — викликати в кабінет можна лише пацієнтів сьогоднішнього дня";
    if (r.code === "safety_unknown") return SAFETY_UNKNOWN_REASON;
    if (r.code === "room_blocked") return "Кабінет заблоковано (поломка/ТО) — спершу розблокуйте апарат";
    if (r.code === "room_closed") return "Кабінет зачинено за графіком на цей день";
    if (r.code === "room_busy") return "Кабінет зайнятий — спершу завершіть поточного пацієнта";
    if (r.code === "room_stuck") return stuckBlockReason(r);
    if (r.code === "stuck_unknown") return STUCK_UNKNOWN_REASON;
    /* U-67 (рішення власника, с50): clash — ЖОРСТКИЙ блок із названою причиною,
       як на дошці радіолога. Тут раніше стояв «override з попередженням»:
       inProgressBlockReason віддавав null, а callPatient відкривав діалог
       «⚠ Викликати все одно».
       ⚠️ Той діалог був МЕРТВИЙ, і це головне. `onConfirm` перечитує жорсткі
       блоки в момент кліку (ревʼю с46 р3, F5), у clash `confirmable` хибний —
       тож підтвердження завжди закінчувалось загальним тостом «Викликати зараз
       неможливо». Кнопка обіцяла дію, якої не існувало.
       ⚠️ І полагодити її «як задумано» було НЕМОЖЛИВО без зміни БД: параметра
       override у `queue_set_status_rpc` немає, а гілка (б) гарда 0129 підніме
       ACTUAL_OVERLAP незалежно від room_busy (той старий коментар стверджував
       протилежне — неправда, знайдено ревʼю А пакета Ф4-2).
       Варіант «дати RPC явний p_force» власник відхилив: це свідомий дозвіл на
       накладення в кабінеті, проти якого побудовані решта шарів.
       Текст — реєстратурний: розкладом володіє саме вона, тож дія називається
       прямо, без «реєстратура має перенести». */
    if (r.code === "clash") {
      return `Дослідження ${r.durationMin} хв зараз не вміститься — о ${r.time} наступний запис` +
        (r.name ? ` (${r.name.split(" ").slice(0, 2).join(" ")})` : "") +
        ". Перенесіть один із записів";
    }
    return null;
  }
  // Виклик поза графіком — через діалог підтвердження (offCallAsk оголошено вище
  // біля кластера модалок, бо його читає гард хоткеїв).
  const [offCallBusy, setOffCallBusy] = useState(false);
  // Повертає проміс setStatus у гілці реального виклику — щоб картка/рядок могли
  // показати pending-стан (спінер) і заблокувати повторний клік. Гілки-блокери
  // (notify / offCallAsk) завершуються синхронно й повертають undefined.
  function callPatient(p: QEntry): void | Promise<void> {
    const r = callBlockOf(p);
    /* U-67: clash іде в загальну гілку жорстких блоків нижче — окремого
       перехоплення більше немає. Порядок тут важливий саме тому: доки clash
       перехоплювався ПЕРЕД `!r.confirmable`, він відкривав діалог, який потім
       сам себе і скасовував. */
    if (r && !r.confirmable) { notify(inProgressBlockReason(p) || "Викликати зараз неможливо", "error"); return; }
    /* M-2: вікно виклику переходить за північ. Дошка тримає рівно одну добу,
       тож накладення на ранковий запис завтра вона не побачить — кажемо про це
       вголос, а не даємо серверу відповісти помилкою. */
    if (r && r.code === "next_day") { setOffCallAsk({ p, kind: "next_day", end: r.end, durationMin: r.durationMin }); return; }
    if (r && r.code === "sched_overrun") { setOffCallAsk({ p, kind: "overrun", end: r.end, durationMin: r.durationMin }); return; }
    return setStatus(p.id, "in_progress").then(() => {});
  }
  function setStatusGuarded(p: QEntry, status: string) {
    // Запізнення понад буфер: прямий виклик у кабінет заблоковано — спершу
    // явне рішення («все ж прийшов» → Очікує, перенос, лист очікування, зняття).
    if (status === "in_progress" && isLate(p.status, selectedDate, p.scheduled_time, p.buffer_time_min)) {
      notify("Пацієнт запізнився понад буферний час — спершу поверніть у чергу, перенесіть або зніміть запис", "error");
      return;
    }
    /* «Виконано» — лише після кабінету (інваріант БД, 0069). Раніше степпер давав
       клікнути крок 4 пацієнту, який навіть не приходив: дослідження «виконувалось»
       нізвідки і росло в «Доході» CEO. */
    if (status === "done" && p.status !== "in_progress" && p.status !== "done") {
      notify("«Виконано» можна поставити лише пацієнту, який був у кабінеті — спершу проведіть його через кабінет", "error");
      return;
    }
    if (status === "in_progress") { callPatient(p); return; }
    setStatus(p.id, status);
  }

  /* Пакетне створення кейса з BookingModal: N кроків різних модальностей (спільний
     пацієнт зі steps[0]) → одна атомарна дія createCase (create_case_rpc, 0093). */
  async function createCaseFromBooking(steps: BookingPayload[]): Promise<string | null> {
    if (!steps.length) return "Додайте хоча б один крок";
    const p0 = steps[0];
    const res = await createCase({
      patient: {
        name: p0.name, phone: p0.phone || null, email: p0.email ?? null,
        dob: p0.dob || null, sex: p0.gender || null, age: p0.age ?? null, weight: p0.weight ?? null,
      },
      referrerId: p0.referrerId,
      note: null,
      steps: steps.map((b) => ({
        roomId: b.roomId, studies: b.studies, durationMin: b.dur, bufferTimeMin: b.buffer,
        priorityLevel: b.priority, scheduledDate: dateKey(b.date), scheduledTime: b.time,
        contraindications: b.hasContra, doctor: b.doctor ?? null, note: b.notes ?? null,
      })),
    });
    if (!res.ok) { reload(); return res.error; }
    setModalOpen(false);
    reload();
    return null;
  }

  async function saveBooking(b: BookingPayload) {
    const [hh, mm] = b.time.split(":").map(Number);
    const at = new Date(b.date.getFullYear(), b.date.getMonth(), b.date.getDate(), hh, mm).toISOString();
    const res = await createBooking({
      roomId: b.roomId, referrerId: b.referrerId ?? null,
      name: b.name, phone: b.phone || null, email: b.email ?? null,
      dob: b.dob || null, sex: b.gender || null, age: b.age || null, weight: b.weight ?? null,
      hasContra: !!b.hasContra, priorityLevel: b.priority,
      studies: b.studies || [], doctor: b.doctor ?? null, notes: b.notes ?? null, durationMin: b.dur, bufferTimeMin: b.buffer,
      scheduledDate: dateKey(b.date), scheduledTime: b.time, scheduledAt: at,
      offSchedule: b.offSchedule,   // 0077 — згода оператора на роботу поза графіком
    });
    if (!res.ok) {
      /* Помилку ПОВЕРТАЄМО модалці — вона покаже її в собі. Раніше тут був notify(),
         а тост малювався ПІД оверлеєм: користувач тиснув «Зберегти» і не бачив нічого. */
      reload();   // сітка модалки підтягне свіжу зайнятість (слот міг щойно зайняти колега)
      return (res.code === "slot_taken" || res.code === "slot_unavailable")
        ? "Слот щойно зайняли — оберіть інший час"
        : res.code === "incident" ? "Кабінет у простої (поломка/ТО) у цей час — оберіть інший слот або день"
        : res.error;
    }
    setModalOpen(false);
    notify("Новий запис: " + b.name + " · " + b.time, "success");
    if (sameDay(b.date, selectedDate)) reload();
    return null;
  }

  const scoped = roomView === "all" ? entries : entries.filter((e) => e.room_id === roomView);
  const boardScoped = scoped.filter((e) => e.status !== "cancelled" && e.status !== "no_show");
  const panelEntries = scoped.filter((e) => e.status === "cancelled" || e.status === "no_show");
  const needsResched = scoped.filter((e) => e.status === "needs_reschedule");
  const counts = useMemo(() => {
    const c: Record<string, number> = { total: 0, scheduled: 0, waiting: 0, in_progress: 0, done: 0, no_show: 0, not_held: 0, cancelled: 0, late: 0 };
    scoped.forEach((e) => {
      if (c[e.status] != null) c[e.status]++;
      if (e.status !== "cancelled") c.total++;
      if (isLate(e.status, selectedDate, e.scheduled_time, e.buffer_time_min)) c.late++;
    });
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, selectedDate, nowTick]);

  const stuckRooms = useMemo(() => visibleStuckByRoom(stuck, dayKey), [stuck, dayKey]);
  /* !scopeReady входить у «не знаємо» (аудит 2026-08-07, H-3): у кадрі між
     зміною дати й відповіддю `stuckLoaded` ще належить ПОПЕРЕДНЬОМУ дню
     (гасить його ефект, а він — після paint). Без цього плитка кабінету
     писала б «Кабінет вільний» на порожньому зрізі. Fail-CLOSED. */
  const stuckUnknown = stuckUnknownOf(stuckLoaded && scopeReady, stuckErr);
  const currentByRoom: Record<string, QEntry> = {}, nextWaitingByRoom: Record<string, QEntry> = {};
  entries.forEach((e) => { if (e.status === "in_progress" && e.room_id) currentByRoom[e.room_id] = e; });
  // «Наступний у черзі» — той самий канон, що й сортування дошки: спершу ЧАС,
  // пріоритет — тай-брейк на однаковий час.
  entries.forEach((e) => {
    if (e.status !== "waiting" || !e.room_id) return;
    const cur = nextWaitingByRoom[e.room_id];
    if (!cur) { nextWaitingByRoom[e.room_id] = e; return; }
    const t = (e.scheduled_time || "").localeCompare(cur.scheduled_time || "");
    if (t < 0 || (t === 0 && priorityRank(e.priority_level) < priorityRank(cur.priority_level))) {
      nextWaitingByRoom[e.room_id] = e;
    }
  });

  const roomLoad = computeRoomLoad(visRooms, entries, selectedDate, overridesFeed, loadIncidentsFeed);

  /* Порядок черги (рішення Ігоря 2026-07-11): у межах статусу — ЗА ЧАСОМ.
     Пріоритет (CITO/Терміново) лишається кольоровим бейджем, але НЕ виносить
     запис угору: інакше дошка не читалась як розклад дня і перенос запису
     візуально «не переміщував» рядок (найчастіша скарга).
     Пріоритет тепер — лише тай-брейк для записів на ОДИН і той самий час. */
  const prioRank = (x: QEntry) => isActiveStatus(x.status) ? priorityRank(x.priority_level) : 9;
  // «Уточнити»: прострочені scheduled (persisted clarify_at або похідна) опускаються
  // в КІНЕЦЬ запланованих (над терміналами), щоб наступний актуальний був першим.
  const clarifyRank = (x: QEntry) =>
    (x.status === "scheduled" && (!!x.clarify_at || needsClarification(x.status, selectedDate, x.scheduled_time))) ? 1 : 0;
  const sorted = boardScoped.slice().sort((a, b) => {
    const d = (FLOW[a.status] ?? 9) - (FLOW[b.status] ?? 9);
    if (d !== 0) return d;
    const cl = clarifyRank(a) - clarifyRank(b);
    if (cl !== 0) return cl;
    const t = (a.scheduled_time || "").localeCompare(b.scheduled_time || "");
    if (t !== 0) return t;
    return prioRank(a) - prioRank(b); // однаковий час → першим терміновіший
  });
  const filtered = sorted.filter((e) => {
    if (filter === "late") {
      if (!isLate(e.status, selectedDate, e.scheduled_time, e.buffer_time_min)) return false;
    } else if (filter !== "all" && e.status !== filter) return false;
    // с22: швидкий пошук — спільний предикат (прізвище з будь-якого місця,
    // телефон ЗА ЦИФРАМИ: код оператора / середина / останні цифри). Порядок
    // рядків не змінюється — фільтр застосовується ПІСЛЯ штатного сортування.
    if (!quickSearchMatch(query, e)) return false;
    return true;
  });

  function toggleRow(id: string) { setExpandedRow((r) => (r === id ? null : id)); }

  const roomViewRoom = roomsById[roomView];

  return (
    <div className="app">
      <Sidebar
        clinicName={clinicName} adminName={adminName} adminRole={adminRole} roleKey={roleKey}
        rooms={visRooms} roomNoteOf={offNote} activeRoom={roomView} onSelectRoom={setRoomView} onNew={openBooking}
        onSlotsOverview={roleKey === "admin" ? () => setSlotsOverviewOpen(true) : undefined}
        incidentCount={liveIncidents.length} onBreakdown={() => { setBreakdownRoomId(roomView !== "all" ? roomView : null); setBreakdownOpen(true); }}
        onEmergency={handleEmergencyClick}
        emergencyActive={roomView !== "all" ? emergencyRooms.includes(roomView) : emergencyActive}
        stoppedRoomIds={Object.keys(blockingByRoom)}
      />
      <div className="main">
        <header className="topbar">
          <div className="tb-title">
            <span className="tic">▦</span>
            <div>
              <h1>Дошка черги</h1>
              <div className="date">{fmtFull(selectedDate)} · <LiveClock tz={clinicTz} /></div>
            </div>
          </div>
          <div className="tb-right">
            <RealtimeBadge health={rtHealth} />
            <button className="btn btn-breakdown" onClick={() => { setBreakdownRoomId(roomView !== "all" ? roomView : null); setBreakdownOpen(true); }} title="Зафіксувати поломку або ТО апарата">🔧 Поломка / ТО</button>
            {/* Дані про простої/графіки не завантажились — бронювати НЕ можна:
                зламаний кабінет виглядав би вільним. */}
            <button className="btn btn-primary btn-lg" disabled={safetyErr}
              title={safetyErr ? SAFETY_BOOKING_BLOCKED : undefined}
              onClick={openBooking}>＋ Новий запис</button>
          </div>
        </header>
        <div className="content-wrap">
          <div className="content">
            {/* ⚠️ Г1-E (с53, рішення власника — «банер, як у форм»). Стоїть
                ПЕРШИМ у стовпці, вище банерів простоїв і помилок завантаження:
                урок дошки обдзвону (F2) був саме про це — підпис у місці, куди
                оператор не дивиться, не відрізняється від тиші, а над цим
                блоком їх може накопичитись півдесятка. Усе, що нижче, — про
                конкретну добу; цей банер каже, ЯКА це доба.
                Називає ОБИДВІ доби (F7): памʼятати, що стояло в заголовку
                хвилину тому, оператор не може — він у цей час розмовляє з
                пацієнтом. Знімає його ЛЮДИНА («Зрозуміло» або зміна дати):
                автогасіння таймером повернуло б тихий сценарій, а дошка — не
                модалка, вона не закривається сама.
                ⚠️ `dayShiftNoticeVisible` — не «чи є стан», а «чи є що сказати
                ПРО ЦЮ добу»: воно ж відсікає поправку туди-назад («змінено з
                1 вересня на 1 вересня») і банер, що пережив перехід оператора
                на іншу дату. Обидві умови живуть у lib/useFollowToday.ts і
                перевіряються ВИКЛИКОМ (tests/followToday.test.ts). */}
            {dayShifted && dayShiftNoticeVisible(dayShifted, dayKey) && (
              <div className="ctx-hint orange" role="status" style={{ marginBottom: 12 }}>
                🕐 Годинник центру уточнено — дату дошки змінено з <b>{fmtFull(dayOfKey(dayShifted.fromKey))}</b> на <b>{fmtFull(dayOfKey(dayShifted.toKey))}</b>.
                {" "}<button className="btn btn-secondary btn-sm" style={{ marginLeft: 6 }} onClick={() => setDayShifted(null)}>Зрозуміло</button>
              </div>
            )}
            {safetyErr && (
              <div className="inc-banner fade-in" style={{ borderColor: "var(--red)" }}>
                <span className="inc-banner-ic">⚠</span>
                <div className="inc-banner-txt">
                  <div className="inc-banner-title">Не завантажились дані про {incidentsErr ? "простої" : ""}{incidentsErr && overridesErr ? " та " : ""}{overridesErr ? "особливі графіки" : ""}</div>
                  <div className="inc-banner-sub">Кабінет на ремонті може виглядати вільним, а закритий день — робочим. Новий запис, перенос і виклик пацієнта в кабінет заблоковано до оновлення.</div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => { loadIncidents(); loadOverrides(); }}>↻ Оновити</button>
              </div>
            )}
            {/* Хвости не оновились → виклики заблоковано fail-closed. Без банера
                оператор бачив би лише «Стан кабінету не оновився» на картках
                (а вони є тільки на «сьогодні») і не мав би кнопки повтору. */}
            {stuckErr && (
              <div className="inc-banner fade-in" style={{ borderColor: "var(--orange)" }} role="alert">
                <span className="inc-banner-ic" aria-hidden="true">⚠</span>
                <div className="inc-banner-txt">
                  <div className="inc-banner-title">Не завантажились дані про незавершені дослідження</div>
                  <div className="inc-banner-sub">Кабінет із забутим дослідженням виглядав би вільним, тому виклики заблоковано до оновлення.</div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => reload()}>↻ Оновити</button>
              </div>
            )}
            {/* Черга не оновилась, але старі рядки на екрані — інакше користувач
                дивиться на застарілі дані й не знає про це. */}
            {entriesErr && entries.length > 0 && (
              <div className="inc-banner fade-in" style={{ borderColor: "var(--orange)" }}>
                <span className="inc-banner-ic">⚠</span>
                <div className="inc-banner-txt">
                  <div className="inc-banner-title">Черга не оновилась</div>
                  <div className="inc-banner-sub">Показано останні завантажені дані — вони можуть бути застарілими.</div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => reload()}>↻ Оновити</button>
              </div>
            )}
            {isToday && citoList.length > 0 && (
              <div className="inc-banner fade-in" style={{ borderColor: "var(--red)" }}>
                <span className="inc-banner-ic">🔴</span>
                <div className="inc-banner-txt">
                  <div className="inc-banner-title">Термінові пацієнти (CITO): {citoList.length}
                    <HelpTip label="Що таке CITO" text={<>CITO — терміновий пацієнт поза чергою: дослідження треба виконати якнайшвидше за медичними показаннями. Такі записи підсвічуються й виносяться вгору дошки.</>} />
                  </div>
                  <div className="inc-banner-sub">{citoList.slice(0, 3).map((e) => (e.patient_name || "").split(" ").slice(0, 2).join(" ")).join(" · ")}{citoList.length > 3 ? " …" : ""}</div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => setFilter("all")}>Показати чергу</button>
              </div>
            )}
            {!isPast && liveIncidents.filter((inc) => incidentCoversDay(inc, selectedDate)).map((inc) => {
              const r = roomsById[inc.room_id];
              const nowBlocking = !!blockingByRoom[inc.room_id] && blockingByRoom[inc.room_id].id === inc.id;
              const awaitingManual = !nowBlocking && incidentAwaitingManualUnblock(inc);
              const startStr = new Date(inc.started_at).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
              const borderColor = nowBlocking ? undefined : awaitingManual ? { borderColor: "var(--green)" } : { borderColor: "var(--orange)" };
              return (
                <div className="inc-banner fade-in" key={inc.id} style={borderColor}>
                  <span className="inc-banner-ic">{nowBlocking ? "🔧" : awaitingManual ? "🔓" : "🗓"}</span>
                  <div className="inc-banner-txt">
                    <div className="inc-banner-title">{r?.name || "Апарат"} {nowBlocking ? "заблоковано" : awaitingManual ? "— простій завершився" : "— заплановано простій"} · {inc.reason_label || "Поломка"}
                      {inc.note ? <span className="inc-banner-window">{inc.note}</span> : null}
                      {(nowBlocking || awaitingManual) && <HelpTip label="Розблокування апарата" text={<>Поки триває простій, апарат заблоковано для записів. Після завершення вікна простою він <b>авто-розблоковується</b>. Якщо вікно минуло, а блок лишився — натисніть «Розблокувати» вручну.</>} />}
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
            {selectedOverride && selDayStatus && selDayStatus.kind !== "none" && (
              <div className="inc-banner fade-in" style={{ borderColor: selDayStatus.kind === "closed" ? "var(--red)" : "var(--blue-line)" }}>
                <span className="inc-banner-ic">{selDayStatus.kind === "closed" ? "🚫" : "🕐"}</span>
                <div className="inc-banner-txt">
                  <div className="inc-banner-title">{selDayStatus.kind === "closed" ? "Неробочий день" : "Особливий графік"} · {fmtShort(selectedDate)}</div>
                  <div className="inc-banner-sub">{selDayStatus.label}</div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={openSchedEdit}>✎ Редагувати</button>
              </div>
            )}
            <div className="board-main-top">
            <StatsBar counts={counts} filter={filter} setFilter={setFilter} ready={scopeReady} />

            {!isToday ? (
              <div className="day-banner">
                <span className="db-ic">{isPast ? "🗂" : "📅"}</span>
                <div className="db-meta">
                  <div className="db-title">{fmtFull(selectedDate)}</div>
                  <div className="db-sub">{selDayStatus && selDayStatus.kind !== "none" ? selDayStatus.label + " · " : ""}{entriesErr && !scopeReady ? "Дані не завантажились" : !scopeReady ? "Завантаження…" : counts.total ? (isPast ? "Архів — день завершено" : "Заплановані записи") + " · " + counts.total + " записів" : "Записів немає"}</div>
                </div>
                {!isPast && <button className="btn btn-secondary btn-sm" onClick={openSchedEdit}>✎ Графік</button>}
                <button className="btn btn-secondary btn-sm" onClick={() => pickDate(today0())}>← Сьогодні</button>
              </div>
            ) : roomView === "all" ? (
              <div className="room-cards">
                {visRooms.map((r) => (
                  <RoomStatusCard key={r.id} room={r}
                    patient={currentByRoom[r.id]} enteredAt={enteredAtOf(currentByRoom[r.id])}
                    stuck={stuckRooms[r.id]} stuckUnknown={stuckUnknown} onFinishStuck={setStuckFinish}
                    nextWaiting={nextWaitingByRoom[r.id]} blocked={blockingByRoom[r.id]}
                    schedClosed={!blockingByRoom[r.id] && roomSchedClosed(r.id) ? (selDayStatus?.label || "Не працює за графіком") : null}
                    onComplete={openComplete} onCall={callPatient} onUnblock={resolveIncident} />
                ))}
                {/* Дві різні ситуації, які легко злити в одну: кабінетів не
                    заводили взагалі — і всі заведені вимкнено. У другій адміну
                    треба сказати причину, інакше він піде «додавати обладнання»,
                    якого й так вистачає. */}
                {visRooms.length === 0 && (
                  (rooms || []).length > 0 ? (
                    <div className="ctx-hint blue">Усі кабінети вимкнено. Увімкніть потрібний у <a href="/setup">Налаштуваннях</a>.</div>
                  ) : (
                    <div className="ctx-hint blue">Кабінетів ще немає. Додайте обладнання в <a href="/setup">Налаштуваннях</a>.</div>
                  )
                )}
              </div>
            ) : (
              <>
                <div className="room-view-head">
                  <button className="btn btn-ghost btn-sm" onClick={() => setRoomView("all")}>← Усі кабінети</button>
                  <span className="rvh-title">
                    <span className={"rvh-tile " + modalityKind(roomViewRoom?.modality || "")}>{modalityShort(roomViewRoom?.modality || "")}</span>
                    {roomViewRoom?.name}{roomViewRoom?.apparatus_model ? " · " + roomViewRoom.apparatus_model : ""}
                  </span>
                </div>
                <CurrentCard
                  patient={currentByRoom[roomView]}
                  stuck={stuckRooms[roomView]} stuckUnknown={stuckUnknown} onFinishStuck={setStuckFinish}
                  roomName={roomViewRoom?.name || "—"}
                  roomModel={roomViewRoom?.apparatus_model}
                  enteredAt={enteredAtOf(currentByRoom[roomView])}
                  nextWaiting={nextWaitingByRoom[roomView]}
                  onCall={callPatient} onComplete={openComplete} onReschedule={openReschedule}
                />
              </>
            )}
          </div>

          <div className="qctrl">
            <div className="spacer" />
            <div className="search">
              <span className="si">⌕</span>
              {/* с22 (ревью HIGH-1): ввід НЕ канонізуємо — formatPhoneSearch зрізав
                  ведучі цифри і вбивав пошук за серединою/останніми цифрами номера.
                  Матчинг тепер цифровий (quickSearchMatch), формат вводу не важливий. */}
              <input ref={searchRef} placeholder="Пошук пацієнта… ( / )" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            {/* P3 discoverability: видима точка входу в довідку хоткеїв (клавіша «?»). */}
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setHelpOpen(true)} title="Гарячі клавіші (?)" aria-label="Гарячі клавіші" style={{ flexShrink: 0 }}>⌨ ?</button>
          </div>

          <div className="qhead">
            <div>Час</div><div>Пацієнт</div><div>Процедура</div><div>Кабінет</div><div>Статус</div><div />
          </div>

          {/* Порядок гілок важливий (ревʼю пакета H-3, раунд 1).
              ПОМИЛКА ЙДЕ ПЕРШОЮ. При збої лоадер робить `setEntriesErr(true); return;`
              і знімок НЕ кладе — отже `scopeReady` лишається false НАЗАВЖДИ, тоді як
              `loading` гасне у finally. Якби скелет стояв першим, він перехопив би
              керування і ветка помилки стала б недосяжною: замість «Не вдалося
              завантажити чергу · ↻» користувач бачив би вічне «Завантаження…».
              Тобто інваріант «помилка ≠ пусто» перетворився б на «помилка = вічне
              завантаження» — гірше за вихідний дефект.
              Далі: !scopeReady — знімок належить іншому дню/клініці, показуємо
              скелет, а не чужі рядки з активними діями (аудит 2026-08-07, H-3). */}
          {entriesErr && !scopeReady ? (
            <div className="empty">
              <div className="ei">⚠</div>
              <div className="et">Не вдалося завантажити чергу</div>
              <div className="es" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                Перевірте зʼєднання — дані можуть бути неповними.
                <button className="btn btn-secondary btn-sm" onClick={() => { setLoading(true); reload(); }}>↻ Спробувати ще раз</button>
              </div>
            </div>
          ) : loading || !scopeReady ? (
            <div className="qrows" aria-busy="true" aria-label="Завантаження черги">
              {Array.from({ length: 5 }).map((_, i) => (
                <div className="qrow-item skel" key={"sk" + i} aria-hidden="true">
                  <div className="qrow">
                    <div className="sk-line sk-time" />
                    <div><div className="sk-line sk-w70" /><div className="sk-line sk-w40" /></div>
                    <div><div className="sk-line sk-w90" /><div className="sk-line sk-w50" /></div>
                    <div className="sk-line sk-w60" />
                    <div className="sk-line sk-badge" />
                    <div />
                  </div>
                </div>
              ))}
            </div>
          ) : entriesErr && entries.length === 0 ? (
            /* Помилка завантаження — це НЕ «записів немає». */
            <div className="empty">
              <div className="ei">⚠</div>
              <div className="et">Не вдалося завантажити чергу</div>
              <div className="es" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                Перевірте зʼєднання — дані можуть бути неповними.
                <button className="btn btn-secondary btn-sm" onClick={() => { setLoading(true); reload(); }}>↻ Спробувати ще раз</button>
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty">
              <div className="ei">⌕</div>
              <div className="et">{entries.length === 0 ? "Записів на цей день немає" : "Нічого не знайдено"}</div>
              <div className="es">{entries.length === 0 ? "Натисніть «Новий запис», щоб додати пацієнта" : "Спробуйте змінити фільтр або пошук"}</div>
            </div>
          ) : (
            <div className="qrows">
              {filtered.map((p) => {
                const room = p.room_id ? roomsById[p.room_id] : undefined;
                // Колізія можлива лише «сьогодні» (йде дослідження) і лише в найближчого запису кабінету.
                const collision = isToday ? collisionFor(p, entries) : null;
                // Сукупне вікно крос-модального кейса: найраніший старт → найпізніший кінець
                // серед активних кроків із тим самим case_id (скасовані/втрачені слоти не рахуємо).
                const caseSpan = p.case_id ? (() => {
                  const sib = entries.filter((e) => e.case_id === p.case_id && e.scheduled_time && e.status !== "cancelled" && e.status !== "needs_reschedule");
                  if (!sib.length) return null;
                  let a = Infinity, b = -Infinity;
                  for (const e of sib) { const s = slotToMin(e.scheduled_time as string); const en = s + (e.duration_min || 0); if (s < a) a = s; if (en > b) b = en; }
                  return { startMin: a, endMin: b, count: sib.length };
                })() : null;
                return (
                  <QueueRow key={p.id} p={p} dayDate={selectedDate}
                    roomName={room?.name || "—"} roomModel={room?.apparatus_model || ""} roomKind={modalityLabel(room?.modality || "")}
                    expanded={expandedRow === p.id} onToggle={toggleRow}
                    readOnly={false}
                    canCall={!stuckUnknown && canCallIntoRoom(p.room_id ? currentByRoom[p.room_id] : null, p.room_id ? stuckRooms[p.room_id] : null)} rescheduling={affectedIds.has(p.id)}
                    onArrive={arrive} onCall={callPatient} onComplete={openComplete}
                    onNoShow={noShow} onNotHeld={notHeld} onUndo={undo} onCancel={cancelUndo} onSetStatus={setStatusGuarded} onSetCall={setCallGuarded}
                    onReschedule={openReschedule} onEditStudies={openEditStudies} onEditPatient={(pt) => setEditPatientFor(pt)}
                    onToWaitlist={lateToWaitlist}
                    canSetPriority={canEditPriority} onSetPriority={doSetPriority}
                    originHint={fmtOrigin(p.reschedule_origin, roomsById, { interrupted: true })}
                    startBlockReason={p.status === "waiting" ? inProgressBlockReason(p) : null}
                    collision={collision}
                    schedDrift={schedDriftFor(p)}
                    onDelayPlan={isToday && (roleKey === "admin" || roleKey === "registrar") ? openDelayPlan : undefined}
                    delayLoading={delayOpening}
                    onOpenCase={setOpenCaseId}
                    onOrganizeCase={openCaseFromEntry}
                    caseSpan={caseSpan}
                    collisionPanel={collision?.zone === "clash" && expandedRow === p.id ? (
                      <CollisionPanel
                        entry={p} info={collision} rooms={rooms} clinicId={clinicId} clinicTz={clinicTz}
                        date={selectedDate} overrides={overridesFeed} incidents={writeIncidentsFeed}
                        onMove={(roomId, time) => doCollisionMove(p, roomId, time)}
                        onRecall={() => doCollisionRecall(p)}
                        onManual={() => openReschedule(p)}
                      />
                    ) : null}
                    quickReschedule={expandedRow === p.id && isToday && p.room_id && (p.status === "scheduled" || p.status === "waiting") ? (
                      <QuickRescheduleButton
                        entry={p} clinicTz={clinicTz} date={selectedDate} overrides={overridesFeed}
                        incidents={writeIncidentsFeed} onPick={(time) => quickRescheduleTo(p, time)}
                      />
                    ) : null} />
                );
              })}
            </div>
          )}
        </div>

          <aside className="rpanel">
            <MiniCalendar selectedDate={selectedDate} onSelectDate={pickDate} overrides={overridesFeed} onEditSchedule={openSchedEdit} tz={clinicTz} roomSchedules={roomSchedules} />
            {isToday && visRooms.length > 0 && <RoomLoad rooms={roomLoad} onSelectRoom={setRoomView} ready={scopeReady} />}
            {!isPast && <NeedsReschedulePanel entries={needsResched} roomsById={roomsById} onReschedule={openReschedule} onToWaitlist={toWaitlist} onCancel={(pt) => setCancelAsk({ p: pt, mode: "cancel" })} />}
            {!isPast && <AffectedPanel affected={affected} roomsById={roomsById} onReschedule={openReschedule} />}
            {!isPast && <CallListPanel entries={entries} onSetCall={setCall} dateLabel={fmtShort(selectedDate)} />}
            {/* key по дню+фільтру (ревʼю с28-р2, M-1new): панель, залишена
                відкритою, інакше переживає перехід на інший день зі знімком
                розкриття СТАРОГО дня — і крапка скасування, заради якої
                користувач прийшов по календарю, не гасне, бо жоден запис
                нового дня в знімку не значиться. Ремонт скидає open+знімок:
                «розкрити» на новому дні знову означає розкрити. */}
            <CancelledPanel key={dayKey + ":" + roomView} entries={panelEntries} onUndo={undo} onReschedule={openReschedule} onToWaitlist={toWaitlist} />
          </aside>
        </div>
      </div>

      {/* Деталі зайнятого слота (ПІБ/статус/дослідження) вирішує СЕРВЕР (RPC 0062):
          admin/radiologist центру — бачать, реєстратор і направник — ні. */}
      {/* clinicTz — ЯВНО в кожну модалку: покладатися на singleton не можна
          (HANDOVER §6.1), інакше «зараз» тихо з'їде на зону браузера. */}
      {modalOpen && <BookingModal rooms={rooms} clinicId={clinicId} clinicTz={clinicTz} incidents={writeIncidentsFeed} services={services} roomOverrides={roomOverrides} onClose={() => setModalOpen(false)} onSave={saveBooking} onCreateCase={createCaseFromBooking} />}
      {/* referralMode={false} — дошка ПЕРСОНАЛУ центру (сторінка /queue віддає
          направника й керівника редиректом, тож clinic_id профілю = центр запису,
          і серверний `isStaff` тут завжди true). U-12: проп обовʼязковий саме щоб
          ця відповідь була написана, а не вгадана дефолтом. */}
      {/* U-15: `writeIncidentsFeed` — бо кейс віддає цей проп ФОРМАМ ЗАПИСУ
          (StudyEditModal / RescheduleModal / BookingModal кроку), а їм потрібен
          предикат СЕРВЕРА, а не «чи заблоковано зараз». Портал направника сюди
          вже подає сирий фід центру, тож обидва входи в CaseModal тепер
          однакові. */}
      {openCaseId && <CaseModal caseId={openCaseId} referralMode={false} rooms={rooms} clinicId={clinicId} clinicTz={clinicTz} incidents={writeIncidentsFeed} services={services} roomOverrides={roomOverrides} onClose={() => setOpenCaseId(null)} onCancelled={reload} />}
      {caseFromEntryFor && (
        <BookingModal
          rooms={rooms} clinicId={clinicId} clinicTz={clinicTz} incidents={writeIncidentsFeed} services={services} roomOverrides={roomOverrides}
          prefill={{
            name: caseFromEntryFor.patient_name || "", phone: caseFromEntryFor.patient_phone || "",
            dob: caseFromEntryFor.patient_dob, gender: caseFromEntryFor.patient_sex,
            weight: caseFromEntryFor.patient_weight, email: caseFromEntryFor.patient_email,
            priority: "planned",
            // Крок кейса — той самий візит: відкриваємо день вихідного запису (dayKey),
            // кабінет/час НЕ підставляємо (крок — інший кабінет, слот обирає оператор).
            date: dayKey,
          }}
          caseSiblings={caseFromEntryFor.room_id && caseFromEntryFor.scheduled_time && caseFromEntryFor.duration_min
            ? [{ roomId: caseFromEntryFor.room_id, date: selectedDate, time: String(caseFromEntryFor.scheduled_time).slice(0, 5), dur: caseFromEntryFor.duration_min }]
            : []}
          onAddCaseStep={doCaseFromEntry}
          onSave={() => {}}
          onClose={() => setCaseFromEntryFor(null)}
        />
      )}
      {slotsOverviewOpen && <RoomDayOverviewModal rooms={visRooms} clinicTz={clinicTz} incidents={incidentsFeed} overrides={overridesFeed} onClose={() => setSlotsOverviewOpen(false)} />}

      {wlSuggest && (
        <WaitlistCandidatesModal clinicId={clinicId} clinicTz={clinicTz} rooms={rooms} incidents={writeIncidentsFeed} services={services} roomOverrides={roomOverrides}
          slot={wlSuggest.slot} candidates={wlSuggest.candidates}
          onClose={() => setWlSuggest(null)}
          onBooked={(msg) => { notify(msg, "success"); reload(); }}
          onError={(msg) => notify(msg, "error")} />
      )}

      {completeFor && (
        <CompletionModal
          patient={completeFor}
          proc={procLabel(completeFor)}
          roomName={(completeFor.room_id ? roomsById[completeFor.room_id] : undefined)?.name || "—"}
          enteredAt={enteredAtOf(completeFor)}
          onClose={() => setCompleteFor(null)}
          onSuccess={(notes) => finishComplete("done", notes)}
          onFail={(reason, notes) => finishComplete("not_held", [reason, notes].filter(Boolean).join(" — "))}
        />
      )}

      {reschedFor && (
        <RescheduleModal patient={reschedFor} rooms={rooms} clinicId={clinicId} clinicTz={clinicTz} incidents={writeIncidentsFeed} onClose={() => setReschedFor(null)} onConfirm={doReschedule} allowOffSchedule />
      )}

      {/* 0078–0081 — план при затримці. Обидва плани прийшли з previewDelayPlan;
          застосовує лише адмін (canApply), радіолог/реєстратор бачать read-only. */}
      {delayPreview && (
        <DelayPlanModal
          preview={delayPreview}
          roomName={roomsById[delayPreview.roomId]?.name || "Кабінет"}
          canApply={roleKey === "admin"}
          busy={delayBusy}
          onClose={() => setDelayPreview(null)}
          onApply={applyDelay}
        />
      )}

      {editStudiesFor && (
        <StudyEditModal patient={editStudiesFor} scheduledDate={dayKey} rooms={rooms} clinicId={clinicId} clinicTz={clinicTz} services={services} roomOverrides={roomOverrides} incidents={writeIncidentsFeed} offSchedule={!!editStudiesFor.off_schedule} allowOffSchedule onClose={() => setEditStudiesFor(null)} onConfirm={doEditStudies} />
      )}
      {editPatientFor && (
        <PatientEditModal entryId={editPatientFor.id} canEditPriority={canEditPriority} onClose={() => setEditPatientFor(null)} onSaved={reload} />
      )}

      {stuckFinish && (
        <ConfirmDialog
          title="Завершити дослідження з минулого дня?"
          text={<>
            <b>{stuckFinish.patient_name}</b> — запис від <b>{stuckDateLabel(stuckFinish.scheduled_date)}</b>, який лишився «у кабінеті».
            Поки він відкритий, кабінет <b>{(rooms || []).find((r) => r.id === stuckFinish.room_id)?.name || "—"}</b> зайнятий і викликати наступного пацієнта не можна.
            {" "}Позначити як <b>виконане</b>? Якщо дослідження насправді не відбулося, відкрийте {stuckDateLabel(stuckFinish.scheduled_date)} і виберіть «Не відбулося» — там можна вказати причину.
          </>}
          confirmLabel="✓ Завершити"
          cancelLabel="Не чіпати"
          busy={stuckFinishBusy}
          onConfirm={confirmStuckFinish}
          onClose={() => setStuckFinish(null)}
        />
      )}

      {breakdownOpen && (
        <BreakdownModal rooms={rooms} incidents={incidentsFeed} overrides={overridesFeed} initialRoomId={breakdownRoomId || undefined} onClose={() => { setBreakdownOpen(false); setBreakdownRoomId(null); }} onSubmit={submitIncident} onResolve={resolveIncident} />
      )}
      {emergencyOpen && (
        <EmergencyModal
          rooms={rooms}
          stoppedRoomIds={emergencyRooms}
          affectedCount={isToday ? entries.filter((e) => emergencyRooms.includes(e.room_id || "") && (e.status === "scheduled" || e.status === "waiting" || e.status === "in_progress")).length : undefined}
          busy={emergencyBusy}
          onClose={() => setEmergencyOpen(false)}
          onStop={doEmergencyStop}
          onResume={doEmergencyResume}
        />
      )}
      {/* 0077 — виклик у кабінет після кінця робочого дня. Центр має добити день:
          кнопка не блокується, але дія свідома. Тут доречний саме ConfirmDialog
          (не галочка, як у модалках): виклик робиться одним кліком просто з дошки. */}
      {offCallAsk && (
        <ConfirmDialog
          title={offCallAsk.kind === "next_day" ? "Викликати попри перехід за північ?"
            : "Викликати поза графіком?"}
          text={offCallAsk.kind === "next_day"
            ? <><b>{offCallAsk.p.patient_name}</b> · запис о {offCallAsk.p.scheduled_time} · {offCallAsk.durationMin} хв. Кабінет буде зайнятий до <b>{offCallAsk.end}</b> завтра. Дошка бачить лише один день — записів завтра до <b>{offCallAsk.end}</b> вона не показує, перевірте їх перед викликом.</>
            : <><b>{offCallAsk.p.patient_name}</b> · запис о {offCallAsk.p.scheduled_time} · {offCallAsk.durationMin} хв.{" "}Кабінет працює до <b>{offCallAsk.end}</b> — робота триватиме понаднормово.</>}
          confirmLabel={offCallAsk.kind === "next_day" ? "🌙 Викликати" : "⏰ Викликати"}
          cancelLabel="Ні"
          busy={offCallBusy}
          onClose={() => setOffCallAsk(null)}
          onConfirm={async () => {
            const a = offCallAsk;
            if (!a) return;
            /* Доба могла змінитись, поки діалог відкритий: next_day за
               побудовою висить в останні (тривалість + буфер) хвилин доби, і
               саме він просить оператора піти перевірити завтрашні записи.
               Підтвердження після 00:00 завело б у кабінет ВЧОРАШНІЙ запис в
               обхід wrong_day — і кабінет отримав би «хвіст» 0018. «Зараз»
               рахуємо в момент кліку, а не з рендера. */
            if (!sameDay(selectedDate, wallToday0())) {
              notify("Доба змінилась — запис уже не на сьогодні, оновіть дошку", "error");
              setOffCallAsk(null);
              return;
            }
            /* Перечитуємо жорсткі блоки в момент КЛІКУ (ревʼю с46 р3, F5):
               діалог міг провисіти хвилини, і за цей час міг упасти рефетч
               простоїв (safety_unknown), кабінет — заблокувати, а інший пацієнт
               — зайти в кабінет. Оператор підтверджував «поза графіком», а не
               «в зламаний апарат». Підтвердження лікує лише те, що показали. */
            const rNow = callBlockOf(a.p);
            if (rNow && !rNow.confirmable) {
              notify(inProgressBlockReason(a.p) || "Викликати зараз неможливо", "error");
              setOffCallAsk(null);
              return;
            }
            setOffCallBusy(true);
            await setStatus(a.p.id, "in_progress");
            setOffCallBusy(false);
            setOffCallAsk(null);
          }}
        />
      )}
      {cancelAsk && (
        <ConfirmDialog
          title={cancelAsk.mode === "declined" ? "Пацієнт відмовився — скасувати запис?" : "Скасувати запис?"}
          text={cancelAsk.mode === "declined"
            ? <>«Відмова» скасовує запис <b>{cancelAsk.p.patient_name}</b> о <b>{cancelAsk.p.scheduled_time}</b>: статус стане «Скасовано», слот звільниться. Якщо пацієнт просто не бере слухавку — оберіть «Не відповідає» або «Передзвонити».</>
            : <>Запис <b>{cancelAsk.p.patient_name}</b> о <b>{cancelAsk.p.scheduled_time}</b> буде скасовано, слот звільниться. Повернути можна лише новим записом.</>}
          confirmLabel="✕ Так, скасувати запис"
          cancelLabel="Ні, залишити"
          danger
          busy={cancelBusy}
          onClose={() => setCancelAsk(null)}
          onConfirm={async () => {
            const a = cancelAsk;
            if (!a) return;
            setCancelBusy(true);
            if (a.mode === "declined") await setCall(a.p, "declined");
            else await cancelBooking(a.p);
            setCancelBusy(false);
            setCancelAsk(null);
          }}
        />
      )}
      {emergencyConfirm && (
        <ConfirmDialog
          title={emergencyConfirm.action === "stop" ? "Аварійно зупинити кабінет?" : "Відновити роботу кабінету?"}
          text={emergencyConfirm.action === "stop"
            ? <>Зупинити роботу <b>{roomsById[emergencyConfirm.roomId]?.name || "кабінет"}</b> до зʼясування обставин? Пацієнтів цього дня буде позначено на обдзвон.</>
            : <>Відновити роботу <b>{roomsById[emergencyConfirm.roomId]?.name || "кабінет"}</b>? Кабінет знову прийматиме записи.</>}
          confirmLabel={emergencyConfirm.action === "stop" ? "🛑 Зупинити" : "▶ Відновити"}
          cancelLabel="Ні, не треба"
          danger={emergencyConfirm.action === "stop"}
          busy={emergencyBusy}
          onClose={() => setEmergencyConfirm(null)}
          onConfirm={async () => {
            const a = emergencyConfirm;
            if (!a) return;
            if (a.action === "stop") await doEmergencyStop([a.roomId], "");
            else await doEmergencyResume([a.roomId]);
            setEmergencyConfirm(null);
          }}
        />
      )}

      {schedEditOpen && (
        <ScheduleEditModal key={schedEditEpoch} date={selectedDate} rooms={visRooms} existing={selectedOverride} entries={entries}
          onClose={() => setSchedEditOpen(false)} onSave={saveOverride} onReset={resetOverride} />
      )}

      {helpOpen && (
        <ShortcutsOverlay
          onClose={() => setHelpOpen(false)}
          shortcuts={[
            { keys: ["N"], label: "Новий запис" },
            { keys: ["/"], label: "Пошук пацієнта" },
            { keys: ["R"], label: "Оновити дошку" },
            { keys: ["J", "K"], label: "Наступний / попередній рядок черги" },
            { keys: ["1", "…", "9"], label: "Перейти до кабінету за номером" },
            { keys: ["0"], label: "Усі кабінети" },
            { keys: ["?"], label: "Ця довідка" },
            { keys: ["Esc"], label: "Закрити вікно" },
          ]}
          glossary={[
            { glyph: "○", term: "В черзі", desc: "Запис заплановано, пацієнт ще не прийшов." },
            { glyph: "◔", term: "Очікує", desc: "Пацієнт прийшов і чекає виклику в кабінет." },
            { glyph: "●", term: "В кабінеті", desc: "Дослідження триває просто зараз (живий таймер)." },
            { glyph: "✓", term: "Виконано", desc: "Дослідження завершено — доступно лише після кабінету." },
            { glyph: "✕", term: "Неявка", desc: "Пацієнт не прийшов у відведений час." },
            { glyph: "⊘", term: "Не відбулося", desc: "Був у кабінеті, але дослідження не проведено (напр. протипоказання)." },
            { glyph: "↻", term: "Потребує переносу", desc: "Слот втрачено через затримку — перенесіть на новий час." },
            { term: "CITO", desc: "Терміновий (ургентний) запис — має пріоритет у черзі." },
            { term: "Обзвін / Колл-лист", desc: "Підтвердження записів дзвінком напередодні." },
            { term: "Простій", desc: "Кабінет зупинено (поломка/ТО/аварія) — виклики призупинено." },
            { term: "Поза графіком", desc: "Слот після закриття чи в перерву — підтверджено персоналом." },
            { term: "Накладення", desc: "Поточне дослідження наїжджає на наступний слот — потрібне рішення." },
            { term: "Буфер", desc: "Запас часу після дослідження на прибирання/підготовку." },
            { term: "Кейс", desc: "Крос-модальний запис: кілька досліджень одного пацієнта різними апаратами." },
          ]}
        />
      )}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
