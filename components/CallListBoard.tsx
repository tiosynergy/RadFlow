"use client";

/* ===== RadFlow — Колл-лист (окремий екран) =====
   Записи на завтра (або обраний день) → обдзвін/підтвердження. Статус пишеться у
   queue_entries.call_status (синхронно з дошкою), нотатка — у call_note. Realtime. */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { isRoomBookable, visibleRooms, residualSet, roomOffLabel } from "@/lib/rooms";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import Sidebar from "@/components/Sidebar";
import LiveClock from "@/components/LiveClock";
import Toast from "@/components/Toast";
import { entryInIncidentWindow, groupIncidentsByRoom, incidentExpired, incidentFeed, setClinicTz, wallDayKey, wallToday0 } from "@/lib/incidents";
import { useFollowToday, dayOfKey, dayShiftNoticeOf, dayShiftNoticeVerdict, type DayShiftNotice } from "@/lib/useFollowToday";
import { dateKeyOf } from "@/lib/schedule";
import RescheduleModal, { type RescheduleStudy } from "@/components/RescheduleModal";
import StudyEditModal from "@/components/StudyEditModal";
import WaitlistCandidatesModal, { fetchWaitlistCandidates, type FreedSlotInfo } from "@/components/WaitlistCandidatesModal";
import ConfirmDialog from "@/components/ConfirmDialog";
import type { WaitlistEntry } from "@/supabase/types";
import { cancelQueueEntry, setQueueEntryCall, setCallNote, confirmAllCalls, rescheduleQueueEntry, editQueueEntryStudies, setQueueEntryStatus } from "@/app/queue/actions";
import { addEntryToWaitlist } from "@/app/waitlist/actions";
import { isLate } from "@/lib/queueStatus";
import { modalityKind, isContrastName} from "@/lib/studies";
import type { ServiceLike, RoomOverrideRow } from "@/lib/catalog";
import type { CallStatus, Json } from "@/supabase/types";
import { PRIORITY_META, isActiveStatus, type PatientPriority } from "@/lib/priority";
import { quickSearchMatch } from "@/lib/quickSearch";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null; active?: boolean | null };
type CallEntry = {
  id: string; patient_name: string | null; patient_phone: string | null; patient_age: number | null;
  scheduled_time: string | null; duration_min: number | null; buffer_time_min: number | null; status: string; call_status: string | null;
  priority_level?: PatientPriority | null; call_note?: string | null; studies: Json; doctor?: string | null; room_id: string | null; scheduled_date: string | null;
  off_schedule?: boolean | null;   // 0077
};
/* ⚠️ `auto_unblock` тут ОБОВʼЯЗКОВИЙ, і це не косметика (ревʼю с50).
   `incidentExpired` рахує `inc.auto_unblock !== false`, а `undefined !== false`
   це TRUE — тож без цього поля колл-лист вважав згаслим БУДЬ-ЯКИЙ простій із
   минулим `blocked_until`, включно з РУЧНИМИ, яких pg_cron не знімає взагалі.
   Дошка (`QueueBoard`) поле вибирає, і той самий простій там живий: два екрани
   давали різну відповідь про один запис. tsc мовчав, бо в `IncidentLike` поле
   необовʼязкове. */
type IncidentRow = { id: string; room_id: string; reason_label: string | null; note: string | null; started_at: string; blocked_until: string | null; status: string; auto_unblock: boolean };

const WK = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"];
const MON_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
function fmtFull(d: Date) { return WK[d.getDay()] + ", " + d.getDate() + " " + MON_GEN[d.getMonth()] + " " + d.getFullYear(); }
/* ⚠️ Г1-G (с53): ОДИН формат ключа доби на продукт — тут стояла власна копія.
   `dayKey` тепер порівнюється з ключем, який рахує спільне правило банера, і
   дві копії формату розійшлися б МОВЧКИ: банер зник би, а разом із ним і гейт
   масової дії, який на нього спирається. */
function dateKey(d: Date) { return dateKeyOf(d); }
/* U-1: підпис дати В РЯДКУ рахується з САМОГО рядка, а не з обраної дати.
   Раніше в кожен рядок їхав `dateShort={shortDate(date)}` — мітка бралася зі
   СТАНУ ПІКЕРА (сам форматер після правки лишився без споживачів і прибраний
   разом зі своїм `pad`). Поки після зміни дня на екрані ще стоять рядки
   минулого дня — а вони стоять, бо спінер вішався тільки на зміну клініки, —
   кожен із них уже підписаний НОВОЮ датою, і оператор називає пацієнту чужий
   день. Тепер це структурно неможливо: рядок не може стверджувати дату, якої
   в ньому немає.
   Рядок, а не Date: `scheduled_date` — це календарний день клініки, і проганяти
   його через new Date() означало б повернути зсув зони, з яким боролась 0059. */
function shortDateKey(k?: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(k || ""));
  return m ? m[3] + "." + m[2] : "";
}
function studyKind(e: { studies?: unknown }) {
  const arr = Array.isArray(e.studies) ? (e.studies as Array<{ type?: string }>) : [];
  const s = arr[0] ? arr[0].type : null;
  return s || "МРТ";
}
function procLabel(e: { studies?: unknown; note?: string | null }) {
  const s = Array.isArray(e.studies) ? (e.studies as Array<{ type?: string; region?: string; contrast?: boolean }>) : [];
  if (s.length) return s.map((x) => (x.type || "") + (x.region ? " · " + x.region : "") + (x.contrast && !isContrastName(x.region) ? " з контрастом" : "")).join(" + ");
  return e.note || "—";
}

const CL_META: Record<string, { label: string; cls: string; icon: string }> = {
  not_called: { label: "Ще не дзвонили", cls: "gray", icon: "○" },
  confirmed: { label: "Підтверджено", cls: "green", icon: "✓" },
  no_answer: { label: "Не відповідає", cls: "orange", icon: "✗" },
  to_recall: { label: "Передзвонити", cls: "blue", icon: "↩" },
  declined: { label: "Відмова", cls: "red", icon: "✕" },
};
const CALL_ORDER: Record<string, number> = { not_called: 0, to_recall: 1, no_answer: 2, confirmed: 3, declined: 4 };
const CALL_COLOR: Record<string, string> = { confirmed: "var(--green)", to_recall: "var(--blue-text)", no_answer: "var(--orange)", declined: "var(--red)", not_called: "var(--text-muted)" };

function StatusBadge({ status }: { status: string | null | undefined }) {
  const key = status || "not_called";
  const m = CL_META[key];
  return <span title={m.label} style={{ fontSize: "1.0625rem", lineHeight: 1, color: CALL_COLOR[key] }}>☎</span>;
}

interface CallRowProps {
  p: CallEntry;
  roomName: string;
  roomModel?: string;
  expanded: boolean;
  onToggle: (id: string) => void;
  onSet: (id: string, s: CallStatus) => void;
  onNote: (id: string, v: string) => void;
  onReschedule: (p: CallEntry) => void;
  onEditStudies: (p: CallEntry) => void;
}

function CallRow({ p, roomName, roomModel, expanded, onToggle, onSet, onNote, onReschedule, onEditStudies }: CallRowProps) {
  const type = studyKind(p);
  return (
    <div className={"clrow-wrap" + (expanded ? " open" : "")}>
      <div className={"clrow " + (p.call_status || "not_called")}>
        <button className="cl-exp-btn" onClick={() => onToggle(p.id)} title={expanded ? "Згорнути" : "Розгорнути"}>
          <span className={"cl-chev" + (expanded ? " open" : "")}>›</span>
        </button>
        {/* Дата — з самого запису (див. shortDateKey): мітка не може розійтися зі змістом рядка. */}
        <div className="cl-time tabular">{p.scheduled_time}<div className="cl-date">{shortDateKey(p.scheduled_date)}</div></div>
        <button className="cl-name cl-name-btn" onClick={() => onToggle(p.id)}>{p.priority_level && p.priority_level !== "planned" && isActiveStatus(p.status) && <span className={"prio-tag " + PRIORITY_META[p.priority_level].tone} style={{ marginRight: 6 }}>{PRIORITY_META[p.priority_level].short}</span>}{p.patient_name}</button>
        <div className="cl-tel-cell"><a className="tel" href={"tel:" + (p.patient_phone || "").replace(/\s/g, "")}>☎ {p.patient_phone}</a></div>
        <div className="cl-proc">{procLabel(p)}</div>
        <div className="cl-room">{roomName}{roomModel ? <div style={{ fontSize: "0.6875rem", color: "var(--text-muted)" }}>{roomModel}</div> : null}</div>
        <div className="cl-status-cell"><StatusBadge status={p.call_status} /></div>
        <div className="cl-note-cell">
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
              <button className="mini-icon" title="Передзвонити" style={{ color: "var(--blue-text)" }} onClick={() => onSet(p.id, "to_recall")}>↩</button>
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
            <div className="cld-item cld-item-full"><span className="cld-lab">Тип дослідження</span><span className="cld-val cld-val-wrap"><span className={"cld-type " + modalityKind(type)}>{type}</span> {procLabel(p)}</span></div>
            <div className="cld-item"><span className="cld-lab">Телефон</span><span className="cld-val"><a className="tel" href={"tel:" + (p.patient_phone || "").replace(/\s/g, "")}>{p.patient_phone}</a></span></div>
            {p.doctor && <div className="cld-item"><span className="cld-lab">Направник</span><span className="cld-val">{p.doctor}</span></div>}
          </div>
          <div className="cld-actions">
            <span className="cld-lab">Дія:</span>
            <button className="btn btn-green btn-sm" onClick={() => onSet(p.id, "confirmed")}>✓ Підтвердити запис</button>
            <button className="btn btn-secondary btn-sm" onClick={() => onEditStudies(p)}>🩻 Дослідження</button>
            <button className="btn btn-primary btn-sm" onClick={() => onReschedule(p)}>🗓 Перенести на слот</button>
            <button className="btn btn-secondary btn-sm" style={{ color: "var(--orange)" }} onClick={() => onSet(p.id, "no_answer")}>☏ Не відповідає</button>
            <button className="btn btn-secondary btn-sm" style={{ color: "var(--blue-text)" }} onClick={() => onSet(p.id, "to_recall")}>↩ Передзвонити</button>
            <button className="btn btn-secondary btn-sm" style={{ color: "var(--red)" }} onClick={() => onSet(p.id, "declined")}>✕ Відмова</button>
          </div>
        </div>
      )}
    </div>
  );
}

interface IncidentCallSectionProps {
  incident: IncidentRow;
  roomName: string;
  affected: CallEntry[];
  onReschedule: (p: CallEntry) => void;
  onRecall: (p: CallEntry) => void;
  onRefuse: (p: CallEntry) => void;
}

function IncidentCallSection({ incident, roomName, affected, onReschedule, onRecall, onRefuse }: IncidentCallSectionProps) {
  const [openId, setOpenId] = useState<string | null>(null);
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
                  {/* Дата обовʼязкова: запит по простою — `.gte(scheduled_date, today)`
                      БЕЗ верхньої межі, а простій «до відновлення» триває нескінченно
                      (incidentEffectiveEnd → Infinity). Тож сюди законно потрапляє
                      пацієнт, записаний на три тижні вперед, і сам лише час «14:30»
                      під заголовком «Записи на 29 серпня» читається як «сьогодні». */}
                  <span className="cl-inc-time tabular">{p.scheduled_time}<span className="cl-date" style={{ marginLeft: 6 }}>{shortDateKey(p.scheduled_date)}</span></span>
                  <span className="cl-inc-name">{p.patient_name} · <span style={{ color: "var(--text-muted)" }}>{procLabel(p)}</span></span>
                </button>
                {isOpen && (
                  <div className="cl-inc-detail fade-in">
                    {p.patient_phone && <a className="btn btn-primary btn-sm" href={"tel:" + p.patient_phone.replace(/\s/g, "")}>☎ Подзвонити {p.patient_phone}</a>}
                    <div className="cld-actions" style={{ marginTop: 8 }}>
                      <button className="btn btn-primary btn-sm" onClick={() => onReschedule(p)}>🗓 Перенести на слот</button>
                      <button className="btn btn-secondary btn-sm" style={{ color: "var(--blue-text)" }} onClick={() => onRecall(p)}>↩ Передзвонити</button>
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

/* ── Секція «Запізнення» (сьогодні): обдзвін пацієнтів, що не прийшли понад буфер ── */
function LateCallSection({ late, roomsById, onReschedule, onRecall, onToWaitlist, onRefuse }: {
  late: CallEntry[];
  roomsById: Record<string, RoomOpt>;
  onReschedule: (p: CallEntry) => void;
  onRecall: (p: CallEntry) => void;
  onToWaitlist: (p: CallEntry) => void;
  onRefuse: (p: CallEntry) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (!late.length) return null;
  return (
    <div className="info-banner red cl-inc-sec" style={{ flexDirection: "column", alignItems: "stretch", borderColor: "var(--red)", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="ib-ic">⏰</span>
        <span className="ib-txt">
          <b>Запізнення сьогодні</b> — <b>{late.length}</b> {late.length === 1 ? "пацієнт не прийшов" : "пацієнтів не прийшли"} понад буферний час.
          Зателефонуйте: перенести на слот, до листа очікування або зафіксувати відмову.
        </span>
      </div>
      <div className="cl-inc-list">
        {late.map((p) => {
          const isOpen = openId === p.id;
          return (
            <div className={"cl-inc-item" + (isOpen ? " open" : "")} key={p.id}>
              <button className="cl-inc-row" onClick={() => setOpenId((o) => (o === p.id ? null : p.id))}>
                <span className={"cl-chev" + (isOpen ? " open" : "")}>›</span>
                <span className="cl-inc-time tabular">{p.scheduled_time}</span>
                <span className="cl-inc-name">{p.patient_name} · <span style={{ color: "var(--text-muted)" }}>{procLabel(p)}{p.room_id && roomsById[p.room_id] ? " · " + roomsById[p.room_id].name : ""}</span></span>
              </button>
              {isOpen && (
                <div className="cl-inc-detail fade-in">
                  {p.patient_phone && <a className="btn btn-primary btn-sm" href={"tel:" + p.patient_phone.replace(/\s/g, "")}>☎ Подзвонити {p.patient_phone}</a>}
                  <div className="cld-actions" style={{ marginTop: 8 }}>
                    <button className="btn btn-primary btn-sm" onClick={() => onReschedule(p)}>🗓 Перенести на слот</button>
                    <button className="btn btn-secondary btn-sm" onClick={() => onToWaitlist(p)} title="Пацієнт чекатиме на вільне вікно">⏳ В лист очікування</button>
                    <button className="btn btn-secondary btn-sm" style={{ color: "var(--blue-text)" }} onClick={() => onRecall(p)}>↩ Передзвонити</button>
                    <button className="btn btn-secondary btn-sm" style={{ color: "var(--red)" }} onClick={() => onRefuse(p)}>✕ Відмова</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface CallListBoardProps {
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
  /** Каталог послуг центру (services, 0107) — SSR-проп, як rooms. Порожній → статика. */
  services?: ServiceLike[];
  /** Переозначення каталогу по кабінетах (service_room_overrides, 0108) — проброс у форми (2b). */
  roomOverrides?: RoomOverrideRow[];
  clinicName?: string;
  adminName?: string;
  adminRole?: string;
  roleKey?: string;
}

export default function CallListBoard({ clinicId, clinicTz, rooms, residualRoomIds, residualRoomCounts, services, roomOverrides, clinicName, adminName, adminRole, roleKey = "admin" }: CallListBoardProps) {
  // Синхронно, до ініціалізаторів useState: від зони залежить і «завтра» (день
  // обдзвону), і todayKey (секції «Запізнення» / «постраждалі»). Тільки на клієнті.
  if (typeof window !== "undefined") setClinicTz(clinicTz);

  const router = useRouter();   // 0086: зміни кабінетів (SSR-проп) → router.refresh

  // «Завтра» — доба КЛІНІКИ, а не браузера: біля півночі оператор з іншої зони
  // відкривав обдзвін не на той день.
  const tomorrow = useMemo(() => { const d = wallToday0(clinicTz); d.setDate(d.getDate() + 1); return d; }, [clinicTz]);
  const [date, setDate] = useState(tomorrow);
  /* ⚠️ U-72. Заморозка тут ПОДВІЙНА: `useMemo` з деп-листом `[clinicTz]`
     (поправка годинника зону не міняє, тож мемо не перерахується НІКОЛИ) плюс
     `useState` від нього. Живе поруч `todayKey` нижче — і після поправки через
     північ екран рветься на два дні: список і CSV ідуть по `dayKey`, а простої
     та секція «Запізнення» — по `todayKey`.
     Дату в БД цей екран не пише, але пише СТАТУСИ пачкою: «✓ Всіх підтверджено»
     бере цілі з відфільтрованого по `dayKey` списку, тобто одним кліком
     підтверджує записи чужої доби. Тому перенесення тут не косметика.
     30-секундний тікер нижче не рятує: він лише перемальовує компонент, а
     `tomorrow`/`date` тримає деп-лист.

     ⚠️ `busy` спершу не передавався ВЗАГАЛІ — знайшли обидва ревʼю, незалежно.
     Ціна саме тут найгостріша: діалог «✓ Всіх підтверджено» показує КІЛЬКІСТЬ
     цілей за поточну добу, оператор читає її 2–4 секунди, а `onConfirm`
     обчислює `confirmTargets` у МОМЕНТ КЛІКА — по вже перезавантаженому
     списку. Тобто підтвердження пачкою могло піти на інший день, необоротно і
     без сліду (сам діалог і каже: «дію не можна скасувати однією кнопкою»).
     Список нижче — повний перелік оверлеїв і запитів у польоті цього екрана,
     за зразком `anyModalOpen` сусідніх дошок; нова модалка мусить потрапити
     і сюди. `loading` теж тут: поки список дня не прочитано, цілі невідомі. */
  // ↓ сам виклик правила стоїть НИЖЧЕ, поряд із оголошенням `anyBusy`: `busy`
  //   мусить бачити всі оверлеї цього екрана, а вони оголошені далі.
  const [entries, setEntries] = useState<CallEntry[]>([]);
  const [loading, setLoading] = useState(true);
  /* U-1: зріз, до якого належать рядки НА ЕКРАНІ (клініка + день). Спінер раніше
     вішався тільки на зміну клініки, тож при зміні ДНЯ список минулого дня
     спокійно стояв далі — а при збої читання лишався взагалі назавжди («старий
     список лишається на екрані + банер» — правильно для того самого дня і хибно
     для іншого). Той самий приймач, що в CeoDashboard (с46). */
  const loadedKeyRef = useRef<string | null>(null);
  /* Покоління: два швидкі перемикання дня дають два запити, і без нього ПІЗНІША
     відповідь старішого запиту перезаписала б новіші рядки. Зразок — lib/slotBusy. */
  const genRef = useRef(0);
  /* Ключ ПОТОЧНОГО зрізу, доступний із ПРОТУХЛИХ замикань — і це не те саме, що
     genRef (ревʼю пакета; той самий висновок, що H-3 у QueueBoard). `genRef`
     рахує ПОРЯДОК ВИДАЧІ, а не актуальність: `reload` живе в замиканнях шести
     обробників (setCall, cancelEntry, doConfirmAll, doReschedule, doEditStudies,
     onToWaitlist) і в дебаунсі realtime, тож замикання дня A цілком може бути
     ВИДАНЕ пізніше за reload дня B — тоді A отримує більший gen, відкидає
     відповідь B, кладе рядки дня A під заголовком дня B, а спінер B не знімає
     ніхто: useEffect завʼязаний на identity `reload`, яка не мінялась.
     Тому протухле замикання виходить ДО ++genRef. */
  const scopeRef = useRef("");
  /* Окреме покоління для `loadIncidents` (фаза 4 аудиту, с50): у нього ДВА
     запити й СВІЙ зріз — `todayKey`, а не обраний день. Спільний лічильник
     плутав би два незалежні потоки. Оголошено тут, поруч із рештою ref-ів, бо
     `incScopeRef.current` пишеться в рендері нижче. */
  const incGenRef = useRef(0);
  const incScopeRef = useRef("");
  // H-6: збій завантаження ≠ «записів немає» / «простоїв немає».
  const [entriesErr, setEntriesErr] = useState(false);
  const [incidentsErr, setIncidentsErr] = useState(false);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reschedFor, setReschedFor] = useState<CallEntry | null>(null);
  const [editStudiesFor, setEditStudiesFor] = useState<CallEntry | null>(null);
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [affectedToday, setAffectedToday] = useState<CallEntry[]>([]);
  const [todayScheduled, setTodayScheduled] = useState<CallEntry[]>([]); // для секції «Запізнення»
  const [, setNowTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setNowTick((n) => n + 1), 30000); return () => clearInterval(t); }, []);
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Слот звільнився (відмова) → підходящі кандидати з листа очікування.
  const [wlSuggest, setWlSuggest] = useState<{ slot: FreedSlotInfo; candidates: WaitlistEntry[] } | null>(null);

  // «Сьогодні» для секцій «Запізнення» / «постраждалі» — доба КЛІНІКИ (0059).
  // Раніше зона прилітала клієнтським fetch уже після монтування, і перший прохід
  // лоадерів ішов по дню БРАУЗЕРА.
  const todayKey = wallDayKey(clinicTz);

  const dayKey = dateKey(date);
  /* U-11: у модалки їде ФІД (рядки + чи вдалося прочитати), а не голий масив:
     при incidentsErr це було `[]`, і кабінет на ремонті виглядав вільним. */
  const incidentsFeed = incidentFeed(incidents, incidentsErr);
  const scopeKey = clinicId + "|" + dayKey;
  scopeRef.current = scopeKey;   // пишемо в рендері — див. коментар біля scopeRef
  incScopeRef.current = clinicId + "|" + todayKey;   // зріз loadIncidents — свій
  /* roomsById — ПОВНИЙ список, включно з вимкненими: за ним резолвиться назва
     кабінету в рядку обдзвону й у CSV. Ховаємо кабінет зі СПИСКІВ, а не з записів. */
  const roomsById = useMemo(() => { const m: Record<string, RoomOpt> = {}; (rooms || []).forEach((r) => { m[r.id] = r; }); return m; }, [rooms]);

  /* …а `visRooms` — те, що показуємо у списках: активні + вимкнені із залишками. */
  const residual = useMemo(() => residualSet(residualRoomIds), [residualRoomIds]);
  const visRooms = useMemo(() => visibleRooms(rooms, residual), [rooms, residual]);
  const offNote = (roomId: string): string | null => {
    const r = roomsById[roomId];
    return r && r.active === false ? roomOffLabel(residualRoomCounts?.[roomId]) : null;
  };

  function notify(msg: string, type = "success") {
    setToast({ msg, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), type === "error" ? 6000 : 3000);
  }

  const reload = useCallback(async () => {
    const key = clinicId + "|" + dayKey;
    if (key !== scopeRef.current) return;   // протухле замикання — ДО ++genRef
    const gen = ++genRef.current;
    const stale = () => gen !== genRef.current;   // нас обігнав новіший запит
    /* Збій: старі рядки лишаємо на екрані ЛИШЕ якщо вони про ТОЙ САМИЙ день.
       Інакше стираємо: «застарілі» і «з іншого дня» — різні речі, і друге
       оператор прочитає як список сьогоднішнього обдзвону. */
    const failed = () => {
      if (stale()) return;
      if (loadedKeyRef.current !== key) { loadedKeyRef.current = null; setEntries([]); }
      setEntriesErr(true);
    };
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("queue_entries")
        .select("id, patient_name, patient_phone, patient_age, scheduled_time, duration_min, buffer_time_min, status, call_status, priority_level, call_note, studies, doctor, room_id, scheduled_date, off_schedule")
        .eq("clinic_id", clinicId)
        .eq("scheduled_date", dayKey)
        .in("status", ["scheduled", "waiting"])
        .order("scheduled_time", { ascending: true });
      // H-6: PostgREST не кидає сам — без цієї перевірки збій виглядав як «записів немає»,
      // і оператор просто нікому не дзвонив у цей день.
      if (error) { failed(); return; }
      if (stale()) return;
      setEntries(data || []);
      loadedKeyRef.current = key;
      setEntriesErr(false);
    } catch {
      failed();
    } finally {
      if (!stale()) setLoading(false);
    }
  }, [clinicId, dayKey]);

  /* ⚠️ Гонка тут була детермінованою (фаза 4 аудиту, с50): `setIncidents`
     стояв ДО другого `await`, `setAffectedToday` — після, і жодної сверки
     покоління, при тому що сусідній `reload` у цьому ж файлі має і `genRef`, і
     `scopeRef`. Аварійна зупинка міняє `incidents` І `queue_entries` однією
     транзакцією і дає ДВА виклики майже одночасно (дві підписки з РІЗНИМИ
     debounceKey) — повільніший прогін клав свої «постраждалі» зверху свіжих
     простоїв, і секція нового кабінету писала «Усіх постраждалих опрацьовано
     ✓» БЕЗ банера: кабінет зупинений, пацієнти записані, дзвонити нема кому. */
  const loadIncidents = useCallback(async () => {
    const key = clinicId + "|" + todayKey;
    if (key !== incScopeRef.current) return;   // протухле замикання — ДО ++gen
    const gen = ++incGenRef.current;
    const stale = () => gen !== incGenRef.current;
    try {
    const supabase = createClient();
    const { data: incs, error } = await supabase
      .from("incidents")
      .select("id, room_id, reason_label, note, started_at, blocked_until, status, auto_unblock")
      .eq("clinic_id", clinicId).in("status", ["active", "planned"]);
    if (stale()) return;
    if (error) { setIncidentsErr(true); return; }   // «простоїв немає» ≠ «не змогли прочитати»
    setIncidentsErr(false);
    setIncidents(incs || []);
    if (!incs || !incs.length) { setAffectedToday([]); return; }
    const entsRes = await supabase
      .from("queue_entries")
      .select("id, patient_name, patient_phone, patient_age, scheduled_time, duration_min, buffer_time_min, status, call_status, priority_level, studies, room_id, scheduled_date, off_schedule")
      .eq("clinic_id", clinicId).gte("scheduled_date", todayKey)
      .in("room_id", incs.map((i) => i.room_id)).in("status", ["scheduled", "waiting"]);
    /* Помилку ЦЬОГО читання ковтали, хоча сусіднє (incidents) її перевіряло:
       ents=null → aff=[] → секція каже «Усіх постраждалих опрацьовано ✓» і
       «У вікні простою активних записів немає», причому БЕЗ банера, бо
       incidentsErr лишався false. Кабінет зламаний, пацієнти на нього записані,
       а оператор бачить, що дзвонити нема кому (той самий клас, що U-3/U-4). */
    if (stale()) return;
    if (entsRes.error) { setIncidentsErr(true); return; }
    const ents = entsRes.data;
    /* ⚠️ Простоїв на кабінет може бути КІЛЬКА: вибірка бере `active` І
       `planned`, тож у кабінета цілком буває активна поломка вранці й планове
       ТО ввечері. Раніше тут стояла мапа «один простій на кабінет», і
       останній у масиві затирав попередні — постраждалі другого вікна зникали
       мовчки, причому який саме зникне, вирішував недетермінований порядок
       видачі PostgREST. У `QueueBoard` (`incidentsByRoom`) форма ВЖЕ була
       правильною — розійшлись два екрани про одне й те саме. */
    const byRoom = groupIncidentsByRoom(incs);
    const aff = (ents || []).filter((e) => {
      const list = e.room_id ? byRoom[e.room_id] : null;
      if (!list || !list.length) return false;
      return list.some((inc) => !incidentExpired(inc)
        && entryInIncidentWindow(e.scheduled_date, e.scheduled_time, e.duration_min, inc));
    });
    setAffectedToday(aff);
    } catch { if (!stale()) setIncidentsErr(true); }
  }, [clinicId, todayKey]);

  // Записи на СЬОГОДНІ зі статусом scheduled — джерело секції «Запізнення»
  // (обраний день колл-листа за замовчуванням завтра, тому окремий запит).
  const loadTodayScheduled = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("queue_entries")
        .select("id, patient_name, patient_phone, patient_age, scheduled_time, duration_min, buffer_time_min, status, call_status, priority_level, studies, doctor, room_id, scheduled_date, off_schedule")
        .eq("clinic_id", clinicId)
        .eq("scheduled_date", todayKey)
        .eq("status", "scheduled")
        .order("scheduled_time", { ascending: true });
      /* Коментар у catch обіцяв «лишаємо попередній список», але PostgREST не
         кидає: при помилці сюди приходив {data:null} і `data || []` СТИРАВ
         список — секція «Запізнення» просто зникала (LateCallSection віддає
         null на порожньому), без банера й без лічильника. Тепер обіцянка
         виконується буквально: не змогли прочитати — нічого не чіпаємо. */
      if (error) return;
      setTodayScheduled(data || []);
    } catch { /* транзієнтний збій — лишаємо попередній список */ }
  }, [clinicId, todayKey]);
  useEffect(() => { loadTodayScheduled(); }, [loadTodayScheduled]);

  /* Спінер — на КОЖЕН зріз, а не лише на зміну клініки (U-1). Прив'язка до
     [clinicId] означала: перемкнув день — рядки минулого дня стоять далі, і
     єдине, що змінилось, це підпис дати. */
  useEffect(() => { setLoading(true); }, [clinicId, dayKey]);

  // Перезапрос записей при смене дня: realtime-хук слушает только clinicId.
  useEffect(() => { reload(); }, [reload]);

  // TD-3: единый realtime-паттерн.
  useRealtimeRefetch({
    channelName: clinicId ? "calllist-" + clinicId : null,
    subscriptions: [
      /* + router.refresh, поки в центрі є кабінет-залишок: residual — SSR-проп,
         і без цього підпис «вимкнено · N» лишався б старим саме на екрані, де
         статуси міняють пачками. Умова обов'язкова — інакше зайвий refresh на
         кожен дзвінок. */
      { table: "queue_entries", filter: "clinic_id=eq." + clinicId,
        onChange: () => { reload(); loadIncidents(); loadTodayScheduled(); if ((residualRoomIds?.length ?? 0) > 0) router.refresh(); } },
      { table: "incidents", filter: "clinic_id=eq." + clinicId, onChange: loadIncidents },
      // 0086: rooms — SSR-проп (назви кабінетів у колл-листі); правку/видалення підхоплюємо через router.refresh.
      { table: "rooms", filter: "clinic_id=eq." + clinicId, onChange: () => router.refresh() },
      // Каталог послуг/цін (0107/0108) — SSR-проп у форми запису; зміна адміном → оновити.
      { table: "services", filter: "clinic_id=eq." + clinicId, onChange: () => router.refresh() },
      { table: "service_room_overrides", filter: "clinic_id=eq." + clinicId, onChange: () => router.refresh() },
    ],
  });

  // Після звільнення слота — запропонувати кандидатів з листа очікування.
  async function suggestWaitlistFor(p: CallEntry) {
    /* 0123: у вимкненому кабінеті звільнений слот нікому не пропонуємо — запис
       туди відхилить тригер, і панель кандидатів була б дорогою в нікуди. */
    const rm = (rooms || []).find((r) => r.id === p.room_id);
    if (rm && !isRoomBookable(rm)) return;
    const slot: FreedSlotInfo = { date: p.scheduled_date || dayKey, time: p.scheduled_time, roomId: p.room_id };
    const candidates = await fetchWaitlistCandidates(slot);
    if (candidates.length) setWlSuggest({ slot, candidates });
  }

  /* CAS-промах (аудит H-4): запис уже не в тому стані, який бачить оператор
     колл-листа (пацієнт міг прийти і бути в кабінеті, поки список висів). Показуємо
     причину і перезавантажуємо — мовчки перетирати чужий перехід не можна. */
  function handledStale(res: { ok: boolean; code?: string; error?: string }): boolean {
    if (res.ok || res.code !== "stale") return false;
    notify(res.error || "Стан змінився — оновіть список", "error");
    reload();
    loadIncidents();
    loadTodayScheduled();
    return true;
  }

  async function cancelEntry(p: CallEntry) {
    const res = await cancelQueueEntry(p.id);
    if (!res.ok) {
      if (handledStale(res)) return;
      notify("Помилка: " + res.error, "error");
      return;
    }
    notify("Запис скасовано (відмова)", "success");
    reload(); loadIncidents();
    suggestWaitlistFor(p);
  }

  /* «✕ Відмова» ставить call_status='declined', а це на сервері СКАСОВУЄ запис
     (status → cancelled). Кнопка про це не попереджала — користувач дізнавався з
     тоста постфактум. Тепер деструктивна гілка йде через підтвердження. */
  const [declineAsk, setDeclineAsk] = useState<{ p: CallEntry; mode: "declined" | "cancel" } | null>(null);
  const [declineBusy, setDeclineBusy] = useState(false);
  function setCallGuarded(id: string, call_status: CallStatus) {
    if (call_status !== "declined") { setCall(id, call_status); return; }
    const entry = entries.find((e) => e.id === id) || null;
    if (entry) setDeclineAsk({ p: entry, mode: "declined" });
  }

  async function setCall(id: string, call_status: CallStatus) {
    // Відмова = скасування запису (як на дошці черги); оптимістично локально.
    const entry = entries.find((e) => e.id === id) || null;
    const patch = call_status === "declined" ? { call_status, status: "cancelled" } : { call_status };
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, ...patch } : e)));
    const res = await setQueueEntryCall(id, call_status);
    if (!res.ok) {
      // «Відмова» скасовує запис — сервер відхилить її, якщо пацієнт уже в кабінеті.
      if (handledStale(res)) return;
      notify("Помилка: " + res.error, "error");
      reload();
      return;
    }
    if (call_status === "declined") {
      notify("Пацієнт відмовився — запис скасовано", "info");
      if (entry) suggestWaitlistFor(entry);
    }
    reload();
  }
  async function setNote(id: string, call_note: string) {
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, call_note } : e)));
    const res = await setCallNote(id, call_note);
    if (!res.ok) notify("Помилка збереження нотатки: " + res.error, "error");
  }
  /* «✓ Всіх підтверджено» — масова НЕОЧЕВИДНА дія. Було три проблеми:
     1) підтверджувала ВСІХ за день, ігноруючи активний фільтр/пошук (оператор
        відфільтрував «Не відповідає» — а підтвердились і ті, кому не дзвонили);
     2) без підтвердження — один клік, скасувати нічим;
     3) рапортувала успіх навіть коли RLS не оновила жодного рядка.
     Тепер: діємо рівно на видимий (відфільтрований) список, повз уже
     підтверджених, через ConfirmDialog, і показуємо реальну кількість. */
  const [confirmAllAsk, setConfirmAllAsk] = useState(false);
  const [confirmAllBusy, setConfirmAllBusy] = useState(false);
  /* ⚠️ F2 (знахідка ревʼю Б, MED-HIGH; рішення власника с51 — «банер + скидання,
     як у формах»). Досі цей екран був ЄДИНИМ, де дата одночасно (а) вимовляється
     пацієнту голосом, (б) задає цілі НЕЗВОРОТНОЇ масової дії і (в) мінялась
     МОВЧКИ: `onShift` сюди не передавався взагалі.

     Сценарій цілком у межах написаного коду: ПК відстає на 7 хв, оператор
     відкрив «Обдзвін на 1 вересня», `loading` відклав перенесення, список
     догрузився — `busy` знявся, шапка стала «на 2 вересня». Оператор дзвонить
     далі по нових рядках (дати в них правильні, ніщо не натякає на підміну), в
     кінці тисне «Всіх підтверджено» — статуси лягають записам 2-го, а цілу
     зміну 1-го НЕ ОБДЗВОНЕНО, і про це не дізнається ніхто.

     Що саме «скидається». У формах запису пара до банера — `setTime("")`: вона
     робить Save НЕМОЖЛИВИМ, поки оператор не обере слот заново. Прямий аналог
     тут — не чистити фільтр (це мовчки змінило б КІЛЬКІСТЬ цілей під оператором,
     тобто одну тиху несподіванку на іншу), а зупинити саму незворотну дію:
     доки перенесення не підтверджено кнопкою, «Всіх підтверджено» вимкнено.
     Масова дія знову доступна лише після того, як людина побачила банер і
     натиснула «Зрозуміло».

     ⚠️ ВІДКРИТИЙ ДІАЛОГ тут закривати НЕ ТРЕБА, і це варто сказати, бо перша
     редакція цього фіксу кликала `setConfirmAllAsk(false)` в `onShift` —
     мертвий виклик. `confirmAllAsk` входить у `anyBusy` нижче, тобто при
     відкритому діалозі перенесення ВІДКЛАДАЄТЬСЯ і `onShift` не виконується
     взагалі; стану «діалог відкритий І onShift працює» не існує. Захист тут
     цілком на `busy`, і він був до цього фіксу. Знайшло ревʼю В; сам виклик,
     коментар про нього і пін, що його закріплював, знято. */
  /* ⚠️ Г1-G (с53): стан у КЛЮЧАХ доби, умови видимості — зі спільного правила
     `lib/useFollowToday.ts`. Умови `from !== to` тут не було, а ціна саме на
     цьому екрані найвища: банер не просто підпис — на нього спирається ГЕЙТ
     незворотної масової дії, тож «змінено з 1 вересня на 1 вересня» блокувало
     «Всіх підтверджено» з причиною, яка сама себе спростовує. */
  const [dayShifted, setDayShifted] = useState<DayShiftNotice | null>(null);

  /* U-72 — сам виклик правила «дошка слідує за сьогодні». Обґрунтування і ціна
     розписані нагорі, біля заморозки `tomorrow`/`date`; тут він стоїть тому,
     що `busy` мусить бачити ВСІ оверлеї, а два з них оголошені щойно.
     ОДИН вираз на всі стани — другий екземпляр «що зараз відкрито» розійшовся б
     із цим на першій же новій модалці, і розійшовся б МОВЧКИ. */
  const anyBusy = loading || confirmAllBusy || confirmAllAsk || declineBusy || !!declineAsk
    || !!reschedFor || !!editStudiesFor || !!wlSuggest;
  /* ⚠️ Перший `from` НЕ затирається (ревʼю В): коливання поправки біля півночі
     дало б другий виклик, і день, який оператор реально обдзвонював, у банері
     вже не назвали б. Коментар СТОЇТЬ НАД викликом, а не всередині: якорі
     стенда беруть виклик цілком, і комент усередині робив би їх заручниками
     власного формулювання. */
  useFollowToday({ clinicTz, offsetDays: 1, busy: anyBusy, value: date, setDate,
    onShift: (d, prev) => setDayShifted((s) => dayShiftNoticeOf(s, prev, d)) });
  /* ⚠️ Г1-G: ОДИН вердикт на банер І на гейт масової дії. Два екземпляри умови
     розійшлися б мовчки — і найгірший бік розходження не «зайвий банер», а
     заблокована незворотна дія без видимої причини.
     ⚠️ ВЕРДИКТ ТРИЗНАЧНИЙ (ревʼю А по Г1-G, HIGH). Перша редакція пакета дала
     сюди бул, і на поправці «туди-назад» він давав `false`: банер зникав, а
     РАЗОМ ІЗ НИМ відкривався гейт незворотної масової дії — саме тоді, коли
     необдзвоненим лишався день, що встиг постояти на дошці між двома
     поправками. Гейт дивиться на «не none», текст — на конкретний стан. */
  const dayShiftSay = dayShiftNoticeVerdict(dayShifted, dayKey);

  async function doConfirmAll(ids: string[]) {
    if (!ids.length) return;
    setConfirmAllBusy(true);
    const res = await confirmAllCalls(ids);
    setConfirmAllBusy(false);
    setConfirmAllAsk(false);
    if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
    if (res.updated === 0) { notify("Жодного запису не оновлено — перевірте доступ і оновіть сторінку", "error"); reload(); return; }
    notify(res.updated === 1 ? "Пацієнта підтверджено" : `Підтверджено пацієнтів: ${res.updated}`, "success");
    reload();
  }

  // Повертає ТЕКСТ помилки — модалка покаже його в собі (тост тонув під оверлеєм).
  async function doReschedule({ roomId, date: d, time, dur, buffer, reason, offSchedule, studies }: { roomId: string; date: Date; time: string; dur: number; buffer: number; reason: string; offSchedule?: boolean; studies?: RescheduleStudy[] }) {
    const p = reschedFor;
    if (!p) return null;
    const [hh, mm] = time.split(":").map(Number);
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm).toISOString();
    const res = await rescheduleQueueEntry({ id: p.id, roomId, scheduledDate: dateKey(d), scheduledTime: time, scheduledAt: at, durationMin: dur, bufferTimeMin: buffer, callStatus: "confirmed", reason, offSchedule, studies });
    if (!res.ok) {
      if (res.code === "stale") { setReschedFor(null); handledStale(res); return null; }
      reload();
      return (res.code === "slot_taken" || res.code === "slot_unavailable")
        ? "Слот щойно зайняли — оберіть інший"
        : res.code === "incident" ? "Кабінет у простої — оберіть інший слот"
        : res.error;
    }
    setReschedFor(null);
    notify("Перенесено · підтверджено", "success");
    reload();
    return null;
  }
  async function doEditStudies(arr: { type: string; region: string; dur: number }[], meta: { dur: number; buffer?: number; offSchedule: boolean }) {
    const p = editStudiesFor;
    if (!p) return;
    // 0077: згоду віддає модалка (успадкований прапорець або нова галочка) — див. QueueBoard.doEditStudies.
    const res = await editQueueEntryStudies(p.id, arr as Json, (meta && meta.dur) || p.duration_min || 30, meta?.buffer, meta.offSchedule);
    setEditStudiesFor(null);
    if (!res.ok) {
      if (handledStale(res)) return;
      notify("Помилка: " + res.error, "error");
      return;
    }
    notify("Дослідження оновлено", "success");
    reload();
  }

  function exportCsv() {
    /* Ім'я файлу береться з ПІКЕРА, а рядки — зі стану. Поки триває завантаження
       нового дня, це різні зрізи, і файл «call-list-30.08.csv» поїхав би з
       пацієнтами 29-го. Кнопка гаситься при loading (як «Підтвердити всіх»), а
       дата ще й стоїть КОЛОНКОЮ — щоб помилку було видно у самому файлі. */
    const head = ["Дата", "Час", "Пацієнт", "Телефон", "Процедура", "Кабінет", "Статус", "Нотатка"];
    const rows = entries.map((e) => [e.scheduled_date || "", e.scheduled_time, e.patient_name, e.patient_phone || "", procLabel(e), (e.room_id ? roomsById[e.room_id] : undefined)?.name || "", (CL_META[e.call_status || "not_called"]).label, (e.call_note || "").replace(/[\n;]/g, " ")]);
    const csv = [head, ...rows].map((r) => r.map((c) => '"' + String(c ?? "").replace(/"/g, '""') + '"').join(";")).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "call-list-" + dayKey + ".csv"; a.click();
    URL.revokeObjectURL(url);
    notify("Колл-лист експортовано у CSV", "info");
  }

  const counts: Record<string, number> = { total: entries.length, not_called: 0, confirmed: 0, no_answer: 0, to_recall: 0, declined: 0 };
  entries.forEach((e) => { const s = e.call_status || "not_called"; if (counts[s] != null) counts[s]++; });
  const pct = (n: number) => (counts.total ? Math.round((n / counts.total) * 100) : 0);
  const stats = [
    { lab: "Всього записів", val: counts.total, pct: 100, color: "var(--text-faint)", cls: "" },
    { lab: "Підтверджено", val: counts.confirmed, pct: pct(counts.confirmed), color: "var(--green)", cls: "green" },
    { lab: "Не відповідає", val: counts.no_answer, pct: pct(counts.no_answer), color: "var(--orange)", cls: "orange" },
    { lab: "Передзвонити", val: counts.to_recall, pct: pct(counts.to_recall), color: "var(--blue-text)", cls: "blue" },
  ];
  const statColor: Record<string, string> = { "": "var(--text)", green: "var(--green)", orange: "var(--orange)", blue: "var(--blue-text)" };
  const tabs = [
    { key: "all", label: "Всі", ct: counts.total },
    { key: "not_called", label: "Ще не дзвонили", ct: counts.not_called },
    { key: "to_recall", label: "Передзвонити", ct: counts.to_recall },
    { key: "no_answer", label: "Не відповідає", ct: counts.no_answer },
    { key: "confirmed", label: "Підтверджено", ct: counts.confirmed },
  ];

  const filtered = entries.filter((p) => {
    if (filter !== "all" && (p.call_status || "not_called") !== filter) return false;
    // с22: швидкий пошук — спільний предикат (прізвище з будь-якого місця, телефон
    // ЗА ЦИФРАМИ, процедура як і раніше). Порядок рядків не змінюється.
    if (!quickSearchMatch(query, p, procLabel(p))) return false;
    return true;
  }).sort((a, b) => {
    const pa = CALL_ORDER[a.call_status || "not_called"] ?? 9, pb = CALL_ORDER[b.call_status || "not_called"] ?? 9;
    if (pa !== pb) return pa - pb;
    return String(a.scheduled_time).localeCompare(String(b.scheduled_time));
  });

  // Масове підтвердження діє на ВИДИМИЙ список (фільтр + пошук), повз уже підтверджених.
  const isNarrowed = filter !== "all" || query.trim().length > 0;
  const confirmTargets = filtered.filter((p) => (p.call_status || "not_called") !== "confirmed");

  return (
    <div className="app">
      <Sidebar clinicName={clinicName} adminName={adminName} adminRole={adminRole} roleKey={roleKey} rooms={visRooms} roomNoteOf={offNote} activeNav="calls" />
      <div className="main">
        <header className="topbar">
          <div className="tb-title">
            <span className="tic">☎</span>
            <div>
              <h1>Колл-лист</h1>
              <div className="date">Записи на {fmtFull(date)} · <LiveClock tz={clinicTz} /></div>
            </div>
          </div>
          <div className="tb-right">
            {/* Ручна зміна дня гасить банер сама: оператор бачить, що робить. */}
            <input className="inp tabular" type="date" value={dayKey} onChange={(e) => { const [y, m, d] = e.target.value.split("-").map(Number); setDate(new Date(y, m - 1, d)); setDayShifted(null); }} style={{ width: 150 }} />
            <button className="btn btn-secondary" disabled={loading} onClick={exportCsv} title={loading ? "Зачекайте — список цього дня ще вантажиться" : "Вивантажити видимий день у CSV"}>↧ Експорт</button>
            {/* ⚠️ F2: доки перенесення дня не підтверджено людиною, НЕЗВОРОТНА
                масова дія недоступна — це пара до банера нижче і прямий аналог
                `setTime("")` у трьох формах запису.

                ⚠️ ПОЯСНЕННЯ МУСИТЬ БУТИ ВИДИМИМ (знахідка ревʼю В). Дві пастки,
                створені самим гейтом: банер живе в ПРОКРУЧУВАНІЙ області
                (`.content-full`), а шапка не прокручується — оператор, який
                гортав список, побачив би лише те, що кнопка раптом посіріла; і
                `title` на DISABLED-кнопці в Chrome та Safari не показується
                взагалі, бо елемент не отримує вказівникових подій. Тому: сам
                текст кнопки каже причину, а `title` переїхав на обгортку. */}
            <span title={dayShiftSay !== "none" ? "День змінив годинник центру — підтвердіть банер над списком" : isNarrowed ? "Підтвердить лише тих, кого видно за поточним фільтром" : "Підтвердить усіх непідтверджених за цей день"}>
              <button className="btn btn-primary" disabled={loading || dayShiftSay !== "none" || confirmTargets.length === 0} onClick={() => setConfirmAllAsk(true)}>
                {dayShiftSay !== "none"
                  ? "🕐 День змінено — див. банер"
                  : `✓ Всіх підтверджено${confirmTargets.length ? ` (${confirmTargets.length})` : ""}`}
              </button>
            </span>
          </div>
        </header>
        <div className="content-full">
          <div className="page-max">
            {/* ⚠️ F2 (ревʼю Б, MED-HIGH; рішення власника с51). Банер стоїть ПЕРШИМ
                у стовпці, а не в шапці праворуч: у формах запису урок був саме
                про це — підпис у колонці, куди оператор не дивиться, не
                відрізняється від тиші. Називає ОБИДВА дні (F7: памʼятати
                попередній під час розмови оператор не може) і не гасне сам —
                зняти його може лише людина, і доти масова дія вимкнена. */}
            {/* ⚠️ `orange`, а не голий `ctx-hint` (ревʼю В): базовий клас — без
                фону, рамки і кольору, тобто ЄДИНИЙ вихід із заблокованої
                незворотної операції був намальований слабше за «кабінет не
                працює». */}
            {/* ⚠️ ДВА ТЕКСТИ, ОДИН ВЕРДИКТ (ревʼю А по Г1-G). `returned` — це не
                «нічого не сталось»: поправок було дві, і між ними на дошці
                стояв ІНШИЙ день, який так і лишився необдзвоненим. Мовчати тут
                означало б відкрити гейт масової дії саме в цю мить. */}
            {dayShifted && dayShiftSay !== "none" && (
              <div className="ctx-hint orange" role="status" style={{ marginBottom: 12 }}>
                {dayShiftSay === "moved"
                  ? <>🕐 Годинник центру уточнено — день обдзвону змінено з <b>{fmtFull(dayOfKey(dayShifted.fromKey))}</b> на <b>{fmtFull(dayOfKey(dayShifted.toKey))}</b>.</>
                  : <>🕐 Годинник центру уточнювався двічі і повернувся на <b>{fmtFull(dayOfKey(dayShifted.toKey))}</b> — між поправками на дошці стояв інший день.</>}
                {" "}Перед масовим підтвердженням перевірте, кого ви вже обдзвонили: попередній день лишився необдзвоненим.
                {" "}<button className="btn btn-secondary btn-sm" style={{ marginLeft: 6 }} onClick={() => setDayShifted(null)}>Зрозуміло</button>
              </div>
            )}
            {(() => {
              // День «сьогодні» — за настінним часом клініки (той самий, за яким
              // вибрано todayScheduled), інакше isLate рахував би не той день.
              const [ty, tm, td] = todayKey.split("-").map(Number);
              const t0 = new Date(ty, (tm || 1) - 1, td || 1);
              const lateList = todayScheduled.filter((e) => isLate(e.status, t0, e.scheduled_time, e.buffer_time_min));
              return (
                <LateCallSection late={lateList} roomsById={roomsById}
                  onReschedule={(p) => setReschedFor(p)}
                  onRecall={(p) => setCall(p.id, "to_recall")}
                  onToWaitlist={async (p) => {
                    const res = await addEntryToWaitlist(p.id);
                    if (!res.ok) { notify(res.code === "duplicate" ? "Пацієнт уже в листі очікування" : "Помилка: " + res.error, res.code === "duplicate" ? "info" : "error"); return; }
                    // Слот звільняється: запис — «Не відбулося» (термінальний підсумок запізнення).
                    // expectedFrom='scheduled' (CAS): пацієнт міг прийти, поки список висів
                    // — тоді статус не перетираємо, а показуємо, що стан змінився.
                    const upd = await setQueueEntryStatus(p.id, "not_held", "scheduled");
                    if (!upd.ok) notify(
                      upd.code === "stale"
                        ? "Додано до листа, але пацієнт уже не «Заплановано» — перевірте чергу"
                        : "Додано до листа, але статус не оновлено: " + upd.error,
                      "error");
                    else notify("Запізнення: додано до листа очікування, запис — «Не відбулося»", "success");
                    reload(); loadTodayScheduled();
                  }}
                  onRefuse={(p) => setDeclineAsk({ p, mode: "cancel" })} />
              );
            })()}
            {incidents.map((inc) => (
              <IncidentCallSection key={inc.id} incident={inc}
                roomName={roomsById[inc.room_id]?.name || "Апарат"}
                /* ⚠️ Фільтр по КАБІНЕТУ тут більше не годиться (ревʼю с50).
                   `affectedToday` — ОБʼЄДНАННЯ по всіх простоях кабінета
                   (`list.some(...)` у `loadIncidents`). Поки простій на кабінет
                   був один, обʼєднання збігалося з його вікном. Щойно кілька
                   простоїв стали легальними, той самий фільтр почав класти
                   пацієнта з ранкової поломки в секцію вечірнього ТО — з чужою
                   причиною, чужим вікном і чужим лічильником у банері. Це той
                   самий клас, що описаний в `incidentDurCapMin`: банер не сміє
                   називати причиною те, що причиною не є. Тому атрибуція — по
                   ПРОСТОЮ, тим самим предикатом, що й відбір. */
                affected={affectedToday.filter((a) => a.room_id === inc.room_id
                  && !incidentExpired(inc)
                  && entryInIncidentWindow(a.scheduled_date, a.scheduled_time, a.duration_min, inc))}
                onReschedule={(p) => setReschedFor(p)}
                onRecall={(p) => setCall(p.id, "to_recall")}
                onRefuse={(p) => setDeclineAsk({ p, mode: "cancel" })} />
            ))}
            {(entriesErr || incidentsErr) && (
              <div className="inc-banner fade-in" style={{ borderColor: "var(--red)" }} role="alert">
                <span className="inc-banner-ic">⚠</span>
                <div className="inc-banner-txt">
                  <div className="inc-banner-title">{entriesErr ? "Список не оновився" : "Дані про простої не оновились"}</div>
                  {/* Текст залежить від того, ЩО саме зараз на екрані: після правки
                      рядки чужого дня стираються, і обіцяти «на екрані попередні
                      дані» над порожнім списком означало б суперечити самому собі. */}
                  <div className="inc-banner-sub">
                    {entriesErr
                      ? (entries.length > 0
                        ? "На екрані — попередні дані цього ж дня, частина пацієнтів може бути не показана. Оновіть сторінку."
                        : "Список цього дня показати не можемо — це НЕ означає, що записів немає. Оновіть сторінку.")
                      : "Секція «Обдзвін через простій» може бути неповною. Оновіть сторінку."}
                  </div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => { reload(); loadIncidents(); loadTodayScheduled(); }}>↻ Оновити</button>
              </div>
            )}

            <div className="info-banner">
              <span className="ib-ic">🤖</span>
              <span className="ib-txt"><b>Обдзвін напередодні</b> — зателефонуйте кожному пацієнту, що записаний на цей день, і зафіксуйте статус. Статус миттєво синхронізується з чергою.</span>
            </div>

            <div className="cl-stats">
              {stats.map((s) => (
                <div className="cl-stat" key={s.lab}>
                  <div className="lab">{s.lab}</div>
                  <div className="val tabular" style={{ color: statColor[s.cls] }}>{loading ? "—" : s.val}</div>
                  <div className="mini-bar"><div className="mini-fill" style={{ width: s.pct + "%", background: s.color }} /></div>
                </div>
              ))}
            </div>

            <div className="qctrl">
              <div className="pills">
                {tabs.map((t) => (
                  /* Лічильники — з `entries`, тобто з ПОПЕРЕДНЬОГО дня, поки новий
                     вантажиться. Картки вище вже маскуються через loading; без цього
                     ж рядки сховані за спінером, а числа поруч і далі описують
                     учорашній обдзвін (ревʼю пакета). */
                  <button key={t.key} className={"pill" + (filter === t.key ? " active" : "")} onClick={() => setFilter(t.key)}>
                    {t.label}<span className="ct">({loading ? "—" : t.ct})</span>
                  </button>
                ))}
              </div>
              <div className="spacer" />
              <div className="search"><span className="si">⌕</span>
                {/* с22 (ревью HIGH-1): ввід не канонізуємо — цифровий матчинг quickSearchMatch. */}
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
              <div className="empty"><div className="ei">{entriesErr ? "⚠" : "☎"}</div>
                <div className="et">{entriesErr ? "Список не завантажився" : "Немає записів"}</div>
                <div className="es">{entriesErr ? "Це не означає, що записів немає — оновіть сторінку" : entries.length === 0 ? "На цей день записів немає" : "Змініть фільтр або пошук"}</div>
              </div>
            ) : (
              <div className="clrows">
                {filtered.map((p) => (
                  <CallRow key={p.id} p={p} roomName={(p.room_id ? roomsById[p.room_id] : undefined)?.name || "—"} roomModel={(p.room_id ? roomsById[p.room_id] : undefined)?.apparatus_model || ""}
                    expanded={expandedId === p.id} onToggle={(id) => setExpandedId((x) => (x === id ? null : id))}
                    onSet={setCallGuarded} onNote={setNote} onReschedule={(pt) => setReschedFor(pt)} onEditStudies={(pt) => setEditStudiesFor(pt)} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* clinicTz — ЯВНО (HANDOVER §6.1): singleton не гарантія. */}
      {reschedFor && (
        <RescheduleModal patient={reschedFor} rooms={rooms} clinicId={clinicId} clinicTz={clinicTz} incidents={incidentsFeed} onClose={() => setReschedFor(null)} onConfirm={doReschedule} allowOffSchedule />
      )}
      {editStudiesFor && (
        /* Дата — ІЗ ЗАПИСУ, а не з пікера: цей проп веде читання графіка,
           оверрайда і зайнятості кабінету, тож при найменшому розходженні
           тривалість перевірялась би по чужому дню. Той самий підхід, що з
           підписом дати в рядку. */
        <StudyEditModal patient={editStudiesFor} scheduledDate={editStudiesFor.scheduled_date || dayKey} rooms={rooms} clinicId={clinicId} clinicTz={clinicTz} services={services} roomOverrides={roomOverrides} incidents={incidentsFeed} offSchedule={!!editStudiesFor.off_schedule} allowOffSchedule onClose={() => setEditStudiesFor(null)} onConfirm={doEditStudies} />
      )}

      {declineAsk && (
        <ConfirmDialog
          title="Скасувати запис пацієнта?"
          text={<>«Відмова» скасовує запис <b>{declineAsk.p.patient_name}</b> о <b>{declineAsk.p.scheduled_time}</b>: статус стане «Скасовано», слот звільниться. Якщо пацієнт просто не бере слухавку — оберіть «Не відповідає» або «Передзвонити».</>}
          confirmLabel="✕ Так, скасувати запис"
          cancelLabel="Ні, залишити"
          danger
          busy={declineBusy}
          onClose={() => setDeclineAsk(null)}
          onConfirm={async () => {
            const a = declineAsk;
            if (!a) return;
            setDeclineBusy(true);
            if (a.mode === "declined") await setCall(a.p.id, "declined");
            else await cancelEntry(a.p);
            setDeclineBusy(false);
            setDeclineAsk(null);
          }}
        />
      )}

      {confirmAllAsk && (
        <ConfirmDialog
          title="Підтвердити обдзвін масово?"
          text={<>
            Статус «Підтверджено» отримають <b>{confirmTargets.length}</b> {confirmTargets.length === 1 ? "пацієнт" : "пацієнтів"} на <b>{fmtFull(date)}</b>
            {isNarrowed ? <> — <b>лише ті, кого видно за поточним фільтром</b> ({tabs.find((t) => t.key === filter)?.label || "Всі"}{query.trim() ? ` · пошук «${query.trim()}»` : ""}).</> : <> — усі, кому статус ще не проставлено.</>}
            {" "}Дію не можна скасувати однією кнопкою — статус доведеться міняти вручну.
          </>}
          confirmLabel={`✓ Підтвердити (${confirmTargets.length})`}
          cancelLabel="Скасувати"
          busy={confirmAllBusy}
          onClose={() => setConfirmAllAsk(false)}
          onConfirm={() => doConfirmAll(confirmTargets.map((p) => p.id))}
        />
      )}

      {wlSuggest && (
        <WaitlistCandidatesModal clinicId={clinicId} clinicTz={clinicTz} rooms={rooms} incidents={incidentsFeed} services={services} roomOverrides={roomOverrides}
          slot={wlSuggest.slot} candidates={wlSuggest.candidates}
          onClose={() => setWlSuggest(null)}
          onBooked={(msg) => { notify(msg, "success"); reload(); }}
          onError={(msg) => notify(msg, "error")} />
      )}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
