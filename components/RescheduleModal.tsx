"use client";

/* ===== RadFlow — Перенести на новий слот =====
   Портовано з rf-shell.jsx (RescheduleModal). Кабінети — з props (та сама модальність),
   зайняті слоти — через знеособлений RPC room_busy_slots (без PII; для направника
   обходить RLS-сліпоту на чужі записи). p_exclude прибирає сам перенесений запис.

   ДВА РЕЖИМИ (рішення власника 2026-07-27):
   1) той самий кабінет — сітка слотів, склад дослідженнь недоторканий;
   2) ІНШИЙ кабінет — переоформлення: віддаємо BookingModal у moveMode із
      підставленими даними пацієнта і ПОРОЖНІМ переліком, бо в кожного кабінету
      свій прайс. Запис лишається тим самим (id не змінюється), тож кейс,
      направник і історія переносів на місці. */

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  roomScheduleFor, effectiveRoomBreaks, inBreak, breakClash, offScheduleKind, OFF_SCHED_GRACE_MIN,
  type DayOverride,
} from "@/lib/schedule";
import { incidentEffectiveEnd, wallNow, wallMinOfDay, wallDayKey, wallToday0, type IncidentLike } from "@/lib/incidents";
import { useRoomBusy, busyAt, busyTooltip } from "@/lib/slotBusy";
import { BUFFER_DEFAULT, normBuffer, modalityLabel, modalityShort, modalityKind } from "@/lib/studies";
import { useModalA11y } from "@/lib/useModalA11y";
import { buildSlots, countFit } from "@/lib/slots";
import SlotPicker from "@/components/SlotPicker";
import ConfirmDialog from "@/components/ConfirmDialog";
import RoomSelect, { ROOM_LIST_MAX_CHIPS } from "@/components/RoomSelect";
import type { ServiceLike, RoomOverrideRow } from "@/lib/catalog";
import BookingModal, { type BookingPrefill, type BookingPayload } from "@/components/BookingModal";
import { updatePatientDetails } from "@/app/queue/actions";
import type { PatientPriority } from "@/lib/priority";
import { isRoomBookable, ROOM_OFF_LABEL } from "@/lib/rooms";
import type { TablesUpdate } from "@/supabase/types";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null; active?: boolean | null };
/* 0122: склад, обраний заново в каталозі ЦІЛЬОВОГО кабінету. Їде в
   rescheduleQueueEntry і далі в RPC тим самим UPDATE, що й room_id — інакше
   тригер 0121 перевіряв би новий кабінет проти старого складу. */
export interface RescheduleStudy { type: string; region: string; contrast?: boolean; dur?: number; price?: number | null }
// Минимально необходимый набор полей записи (доски передают разные подмножества).
type ReschedulePatient = { id: string; room_id: string | null; duration_min: number | null; buffer_time_min?: number | null; patient_name: string | null; studies?: unknown; note?: string | null; status?: string };

interface RescheduleModalProps {
  patient: ReschedulePatient;
  rooms?: RoomOpt[];
  clinicId?: string | null;
  clinicTz?: string | null; // TZ центру запису (для «зараз» у мультиклінічному порталі)
  incidents?: IncidentLike[];
  onClose: () => void;
  /* Повертає ТЕКСТ ПОМИЛКИ (або null, якщо перенесено) — див. коментар у BookingModal:
     тост із помилкою малювався ПІД оверлеєм, і відмова сервера виглядала як «нічого
     не сталося». Тут це критичніше: без блокування кнопки подвійний клік проходив
     ДВІЧІ (M-6), і другий виклик перезаписував reschedule_origin знімком уже нового
     слота — історія переносу псувалась. */
  onConfirm: (sel: { roomId: string; date: Date; time: string; dur: number; buffer: number; reason: string; offSchedule?: boolean; studies?: RescheduleStudy[] }) => Promise<string | null> | void;
  /* 0077: чи можна переносити ПОЗА графік (після закриття / у перерву) з підтвердженням.
     true — лише дошки ПЕРСОНАЛУ (черга, колл-лист). Портал направника НЕ передає цей
     проп: направник записує пацієнтів ззовні й не знає, чи лишиться зміна. Сервер і
     тригер БД тримають те саме правило — але сітка не має й пропонувати того, що впаде. */
  allowOffSchedule?: boolean;
  /* Активні кроки ТОГО САМОГО кейса (без кроку, що переносимо). Потрібні формі
     переоформлення: інакше вона намалює вільним слот, який перетинає інший крок
     пацієнта, і про конфлікт скаже вже тригер 0095/0096 — після того, як правки
     пацієнта пішли в базу. */
  caseSiblings?: { roomId: string; date: Date; time: string; dur: number }[];
}

function pad(n: number) { return String(n).padStart(2, "0"); }
function toMin(t: string | null | undefined) { const p = String(t || "").split(":"); return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); }
function fmt(m: number) { return pad(Math.floor(m / 60)) + ":" + pad(m % 60); }
function dateVal(d: Date) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function procLabel(e: { studies?: unknown; note?: string | null }) {
  const s = Array.isArray(e.studies) ? (e.studies as Array<{ type?: string; region?: string; contrast?: boolean }>) : [];
  if (s.length) return s.map((x) => (x.type || "") + (x.region ? " · " + x.region : "") + (x.contrast ? " з контрастом" : "")).join(" + ");
  return e.note || "—";
}

/* Проміжний стан «читаємо картку»: власний діалог із власною пасткою фокуса —
   інакше фокус на час завантаження падав би на <body> (WCAG 2.4.3). */
function MoveFormLoading({ onClose }: { onClose: () => void }) {
  const ref = useModalA11y<HTMLDivElement>(onClose);
  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 420 }} ref={ref} role="dialog" aria-modal="true" aria-label="Підготовка форми переоформлення">
        <div className="dlg-body">
          <div style={{ fontSize: 13, padding: "24px 0", textAlign: "center", color: "var(--text-muted)" }}
            role="status" aria-live="polite">⏳ Готуємо форму переоформлення…</div>
        </div>
        <div className="dlg-foot">
          <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
        </div>
      </div>
    </div>
  );
}

export default function RescheduleModal({ patient, rooms, clinicId, clinicTz, incidents = [], onClose, onConfirm, allowOffSchedule = false, caseSiblings }: RescheduleModalProps) {
  // Dirty-guard: не втрачати обраний слот/причину при випадковому закритті.
  const [dirty, setDirty] = useState(false);
  const [askClose, setAskClose] = useState(false);
  const requestClose = () => { if (dirty) setAskClose(true); else onClose(); };
  const curRoom = (rooms || []).find((r) => r.id === patient.room_id);
  const modality = curRoom ? curRoom.modality : "MRI";
  const kind = modalityLabel(modality);
  const baseDur = patient.duration_min || 30;   // у режимі 1 склад не змінюється → dur той самий
  const buffer = normBuffer(patient.buffer_time_min ?? BUFFER_DEFAULT); // переноситься разом із записом
  /* Кабінети тієї ж модальності, зокрема заблоковані простоєм — щоб можна було
     перенести на дату ПІСЛЯ відновлення. 0123: ВИМКНЕНІ кабінети зі списку
     прибираємо (записувати в них не можна), КРІМ поточного кабінету запису —
     інакше запис, що лишився у вимкненому кабінеті, не можна було б навіть
     посунути по часу, а в списку не було б жодного обраного чипа. */
  const options = (rooms || []).filter((r) => r.modality === modality
    && (isRoomBookable(r) || r.id === patient.room_id));
  const curRoomOff = !!curRoom && !isRoomBookable(curRoom);

  const [roomId, setRoomId] = useState<string>(() => patient.room_id || options[0]?.id || "");
  // «Завтра» — від доби КЛІНІКИ, а не браузера: біля півночі в іншій зоні
  // модалка пропонувала перенести на день, який у центрі вже настав/минув.
  const [dateStr, setDateStr] = useState<string>(() => { const d = wallToday0(clinicTz || undefined); d.setDate(d.getDate() + 1); return dateVal(d); });
  const [time, setTime] = useState("");
  const [override, setOverride] = useState<DayOverride | null>(null);
  const [roomSchedule, setRoomSchedule] = useState<unknown>(null); // rooms.schedule обраного кабінету (для перерв)
  const [reason, setReason] = useState("");
  const [schedLoading, setSchedLoading] = useState(true);
  const [schedErr, setSchedErr] = useState(false); // графік/перерви кабінету не завантажились
  // Слот, який ми обрали, зайняли, поки модалка була відкрита (realtime).
  const [taken, setTaken] = useState<string | null>(null);

  /* ===== Перенос в ІНШИЙ кабінет = переоформлення (рішення власника 2026-07-27) =====
     Спочатку тут був автопідбір замін позиція-в-позицію. Власник спростив правило:
     склад між кабінетами НЕ переноситься взагалі — у кожного кабінету свій прайс,
     тож дослідження обираються заново. Тому при зміні кабінету відкривається
     звичайна форма запису з ПІДСТАВЛЕНИМИ даними пацієнта і порожнім переліком.
     Запис лишається ТІЄЮ САМОЮ (id не змінюється) — зберігаються кейс, направник,
     історія переносів; збереження йде через перенос, а не створення нової. */
  const [svcRows, setSvcRows] = useState<ServiceLike[]>([]);
  const [ovRows, setOvRows] = useState<RoomOverrideRow[]>([]);
  const [entryRow, setEntryRow] = useState<Record<string, unknown> | null>(null);
  /* Форму переоформлення НЕ можна малювати, поки картка не прочитана: BookingModal
     бере prefill лише у початкових значеннях useState, тож змонтована з порожнім
     prefill вона так і лишиться порожньою. */
  const [entryReady, setEntryReady] = useState(false);
  /* Прайс не прочитався → buildCatalog([]) мовчки відкотився б до СТАТИЧНОГО
     довідника lib/studies, і форма запропонувала б послуги, яких у кабінеті
     немає: сервер відповів би «оновіть форму», а оновлювати нічого. Тому
     блокуємо так само, як і нечитану картку. */
  const [catalogErr, setCatalogErr] = useState(false);
  useEffect(() => {
    let cancel = false;
    if (!clinicId) { setEntryReady(true); return; }
    (async () => {
      try {
        const supabase = createClient();
        const [svc, ov, ent] = await Promise.all([
          supabase.from("services")
            .select("id, name, modality, duration_min, price, contrast_allowed, contrast_price, active, sort_order, room_id")
            .eq("clinic_id", clinicId),
          supabase.from("service_room_overrides")
            .select("room_id, service_id, price, duration_min, contrast_price, active")
            .eq("clinic_id", clinicId),
          // Дані пацієнта для передзаповнення: дошки передають різні підмножини,
          // тож читаємо рядок самі — інакше довелось би правити 4 точки виклику.
          supabase.from("queue_entries")
            .select("patient_name, patient_phone, patient_email, patient_dob, patient_age, patient_sex, patient_weight, priority_level, note, contraindications")
            .eq("id", patient.id).maybeSingle(),
        ]);
        if (cancel) return;
        // PostgREST не кидає: помилка приходить полем error із data = null.
        setCatalogErr(!!(svc.error || ov.error));
        setSvcRows((svc.data ?? []) as ServiceLike[]);
        setOvRows((ov.data ?? []) as RoomOverrideRow[]);
        setEntryRow((ent.data ?? null) as Record<string, unknown> | null);
      } catch {
        // Картку/прайс не прочитали → переоформлення блокуємо (див. moveBlocked):
        // краще чесна відмова, ніж форма з порожнім ПІБ і чужим переліком послуг.
        if (!cancel) { setEntryRow(null); setCatalogErr(true); }
      } finally {
        if (!cancel) setEntryReady(true);
      }
    })();
    return () => { cancel = true; };
  }, [clinicId, patient.id]);

  /* Кабінет змінили → переоформлення. Запис БЕЗ кабінету (room_id = null) сюди не
     потрапляє: там перший же автовибір зі списку виглядав би як «зміна». */
  const roomChanged = !!patient.room_id && roomId !== patient.room_id;
  const moveBlocked = roomChanged && entryReady && (!entryRow || catalogErr);
  const showMove = roomChanged && entryReady && !moveBlocked;
  const showMoveLoading = roomChanged && !entryReady;
  const dur = baseDur;

  /* Поки видно форму переоформлення, ЦЕЙ діалог у DOM відсутній — його пастка
     фокуса й Esc мають замовкнути (див. useModalA11y): інакше Tab гасне в
     порожнечу, а Esc закриває все дерево замість верхнього вікна. */
  const dialogRef = useModalA11y<HTMLDivElement>(requestClose, !showMove && !showMoveLoading);

  useEffect(() => {
    let cancel = false;
    setSchedLoading(true);
    (async () => {
      try {
        const supabase = createClient();
        if (clinicId) {
          const ovRes = await supabase.from("schedule_overrides").select("all_closed, label, rooms").eq("clinic_id", clinicId).eq("override_date", dateStr).maybeSingle();
          if (!cancel) setOverride((ovRes.data as unknown as DayOverride) || null);
        }
        if (!roomId) { if (!cancel) { setRoomSchedule(null); setSchedErr(false); } return; }
        const roomRes = await supabase.from("rooms").select("schedule").eq("id", roomId).maybeSingle();
        if (roomRes.error) throw roomRes.error; // без графіка кабінету сітка тихо повернулась би до хардкоду 08–18
        if (!cancel) { setRoomSchedule((roomRes.data as { schedule?: unknown } | null)?.schedule ?? null); setSchedErr(false); }
      } catch {
        // Транзієнтний збій (оновлення токена / мережа) — модаль не рушимо, але
        // й сітку не малюємо: графік кабінету невідомий.
        if (!cancel) setSchedErr(true);
      } finally {
        if (!cancel) setSchedLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [roomId, dateStr, clinicId]);

  /* Зайнятість — спільний хук: RPC room_busy_slots + realtime (queue_entries,
     incidents). Поки не завантажилась — сітку не показуємо як «усе вільно».
     Деталі (ПІБ/статус/дослідження) сервер віддає лише адміну та радіологу (0062). */
  const { spans: busy, loading: busyLoading, error: busyError } = useRoomBusy({ roomId, dateStr, excludeId: patient.id });
  const slotsLoading = busyLoading || schedLoading;
  const dateObj = new Date(dateStr + "T00:00:00");
  // «Зараз» у настінному часі клініки (wall-as-UTC мс): і хвилини доби, і «сьогодні».
  const _nowW = wallNow(clinicTz || undefined);
  const nowMin = wallMinOfDay(_nowW);
  const clinicTodayStr = wallDayKey(clinicTz || undefined);   // «сьогодні» клініки (спільний хелпер)
  const isToday = dateStr === clinicTodayStr;
  /* Дата в МИНУЛОМУ. Раніше перевірка «past» стояла під `isToday`, тому для
     будь-якої минулої дати вона не виконувалась і весь день малювався вільним
     (атрибут min на <input type="date"> нічого не блокує — його можна ввести
     руками або вставити). Тепер минулий день закритий цілком. */
  const isPastDay = dateStr < clinicTodayStr;
  const roomSched = roomScheduleFor(dateObj, roomId, override, roomSchedule);
  const schedStart = toMin(roomSched.start), schedEnd = toMin(roomSched.end);
  const roomBreaks = effectiveRoomBreaks(dateObj, roomId, roomSchedule, override); // перерви кабінету на цю дату
  // Простій обраного кабінету (поломка + ТО): слоти у будь-якому вікні — недоступні (на дату після відновлення кабінет вільний).
  const roomIncidents = (incidents || []).filter((i) => i.room_id === roomId);
  const roomIncident = roomIncidents[0];
  function slotBlockedByIncident(slotMin: number) {
    if (!roomIncidents.length) return false;
    const dt = Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), Math.floor(slotMin / 60), slotMin % 60);
    return roomIncidents.some((inc) => {
      const start = new Date(inc.started_at).getTime();
      return dt >= start && dt < incidentEffectiveEnd(inc);
    });
  }
  // 0077: персоналу сітка добудовується на 2 год за кінець графіка (є що клікати);
  // направнику — рівно як раніше, по графіку.
  const slots: string[] = buildSlots(schedStart, allowOffSchedule ? schedEnd + OFF_SCHED_GRACE_MIN : schedEnd);
  /* Порядок перевірок = порядок у BookingModal і на сервері: спершу все, що НЕ
     лікується підтвердженням (минуле, простій, зайнятість), потім «поза графіком». */
  function slotState(s: string) {
    // bBlock — кінець із буфером (перетин з іншими записами).
    const a = toMin(s), bBlock = a + dur + buffer;
    if (isPastDay) return "past";                            // весь день у минулому
    if (roomSched.closed) return "closed";
    if (slotBlockedByIncident(a)) return "blocked";
    if (isToday && a < nowMin) return "past";
    // Розділяємо саме дослідження і буфер прибирання після нього: кабінет зайнятий
    // і там, і там, але видно, коли дослідження реально закінчується.
    if (busy.some((x) => a >= x.s && a < x.eStudy)) return "busy";
    if (busy.some((x) => a >= x.eStudy && a < x.e)) return "buffer";
    if (busy.some((x) => a < x.e && x.s < bBlock)) return "tight";
    const off = offScheduleKind(a, dur, roomSched, roomBreaks);
    if (off) {
      if (off.confirmable && allowOffSchedule) return "offsched";
      // Без права на овертайм — стара поведінка: перерва сірим, «не влазить» помаранчевим.
      return off.kind === "break" ? "break" : off.kind === "after_end" ? "tight" : "offhours";
    }
    return "free";
  }
  const selOff = time ? offScheduleKind(toMin(time), dur, roomSched, roomBreaks) : null;
  const needsOffConfirm = allowOffSchedule && !!selOff?.confirmable;
  const SELECTABLE = ["free", "offsched"];
  function offSchedLabel(s: string) {
    const off = offScheduleKind(toMin(s), dur, roomSched, roomBreaks);
    if (!off) return s;
    if (off.kind === "break" && off.brk) return `Поза графіком · перерва ${off.brk.start}–${off.brk.end}\nПеренести можна, але потрібне підтвердження`;
    return `Поза графіком · кабінет працює до ${off.end}\nПеренести можна, але потрібне підтвердження`;
  }
  function nextApptAfter(s: string) { const a = toMin(s); const f = busy.filter((x) => x.s >= a).sort((x, y) => x.s - y.s)[0]; return f ? fmt(f.s) : null; }
  function breakLabel(s: string) { const br = inBreak(toMin(s), roomBreaks); return br ? "Перерва в роботі кабінету · " + br.start + "–" + br.end : "Перерва в роботі кабінету"; }
  // Причина «не вміщується» — у тому ж порядку, що й перевірки в slotState.
  function tightReason(s: string) {
    const a = toMin(s);
    if (a + dur > schedEnd) return "кінець дня";
    const br = breakClash(a, dur, roomBreaks);
    if (br) return "перерву " + br.start + "–" + br.end;
    const appt = nextApptAfter(s);
    return appt ? "запис о " + appt : "кінець дня";
  }
  // Тултип зайнятої пʼятихвилинки: статус/ПІБ/дослідження — лише якщо сервер їх
  // віддав (admin/radiologist центру, гейт у RPC 0062); інакше просто «Зайнято».
  function busyLabel(s: string) {
    const b = busyAt(busy, toMin(s));
    if (!b) return "Зайнято";
    const inBuf = toMin(s) >= b.eStudy;
    return (inBuf ? "Буфер після дослідження (кабінет ще зайнятий)\n" : "") + busyTooltip(b);
  }
  function blockedLabel(s: string) {
    const a = toMin(s);
    const dt = Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), Math.floor(a / 60), a % 60);
    const inc = roomIncidents.find((i) => dt >= new Date(i.started_at).getTime() && dt < incidentEffectiveEnd(i));
    const until = inc?.blocked_until ? new Date(inc.blocked_until).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) : null;
    return "Кабінет на ремонті/ТО" + (until ? "\nДо " + until : "\nДо відновлення");
  }
  // Реальна місткість дня для цієї тривалості (жадібна укладка), а не к-сть 5-хв позицій.
  const fitCount = countFit(slots, (s) => slotState(s) === "free", dur + buffer);
  const busyList = busy.slice().sort((a, b) => a.s - b.s);
  const room = (rooms || []).find((r) => r.id === roomId);
  const [offOk, setOffOk] = useState(false);
  useEffect(() => { setOffOk(false); }, [time, roomId, dateStr]);   // згода протухає при зміні слота
  const valid = roomId && time && !roomSched.closed && SELECTABLE.includes(slotState(time))
    && (!needsOffConfirm || offOk) && !moveBlocked;

  /* Realtime: слот, який ми вже обрали, щойно зайняли (або кабінет закрили) —
     знімаємо вибір і кажемо про це, щоб «Перенести» не впало помилкою в лоб. */
  const stillFree = !time || slotsLoading || SELECTABLE.includes(slotState(time));
  useEffect(() => {
    if (!time || slotsLoading) return;
    if (!SELECTABLE.includes(slotState(time))) { setTaken(time); setTime(""); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, slotsLoading, stillFree]);

  // Запит у польоті + помилка сервера — показуємо в модалці (див. onConfirm).
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  async function handleConfirm() {
    if (!valid || saving) return;   // M-6: подвійний клік більше не переносить двічі
    setSaving(true);
    setSaveErr(null);
    try {
      const err = await onConfirm({
        roomId, date: dateObj, time, dur, buffer, reason: reason.trim(),
        offSchedule: needsOffConfirm && offOk,   // 0077 — згода оператора
      });
      if (err) setSaveErr(err);     // успіх → батько закриває модалку
    } catch {
      setSaveErr("Не вдалося перенести запис — спробуйте ще раз");
    } finally {
      setSaving(false);
    }
  }

  /* ===== Гілка «інший кабінет» ===== */
  const er = entryRow || {};
  const erStr = (k: string) => { const v = er[k]; return typeof v === "string" && v.trim() ? v : null; };
  const erNum = (k: string) => { const v = er[k]; return typeof v === "number" ? v : null; };
  const movePrefill: BookingPrefill = {
    name: erStr("patient_name") ?? patient.patient_name,
    phone: erStr("patient_phone"),
    email: erStr("patient_email"),
    dob: erStr("patient_dob"),
    gender: erStr("patient_sex"),
    weight: erNum("patient_weight"),
    hasContra: er.contraindications === true,
    priority: erStr("priority_level") as PatientPriority | null,
    notes: erStr("note"),
    buffer,
    studies: [],          // склад обирається заново під прайс цільового кабінету
    roomId,
    date: dateStr,
  };

  /* Зберігаємо у ДВА кроки, саме в такому порядку: спершу правки пацієнта, потім
     перенос. Зворотний порядок при відмові патча лишав би запис уже перенесеним, і
     користувач тиснув би «Перенести» вдруге — а другий перенос перезаписує
     reschedule_origin знімком уже нового слота (та сама пастка, що й M-6).
     Пріоритет тут НЕ чіпаємо: це окрема дія з перевіркою ролі (403 для
     реєстратора зірвав би весь перенос) — у формі він показаний лише для читання. */
  async function handleMoveSave(b: BookingPayload): Promise<string | null> {
    const patch: TablesUpdate<"queue_entries"> = {};
    const p = patch as Record<string, unknown>;
    const put = (col: string, val: unknown) => { if ((er[col] ?? null) !== (val ?? null)) p[col] = val; };
    // ПІБ у режимі переносу не обовʼязковий (поле могло бути порожнім у старому
    // записі), але порожнім його НЕ пишемо: серверна схема вимагає мін. 1 символ,
    // і патч упав би generic-помилкою без підсвіченого поля.
    if (b.name.trim()) put("patient_name", b.name.trim());
    put("patient_phone", b.phone);
    put("patient_email", b.email);
    put("patient_sex", b.gender || null);
    put("patient_weight", b.weight);
    put("contraindications", b.hasContra);
    put("note", b.notes);
    // Вік — похідний від дати народження: без дати не чіпаємо (calcAge('') не число).
    if (b.dob) { put("patient_dob", b.dob); put("patient_age", b.age); }
    let patched = false;
    if (Object.keys(p).length) {
      const res = await updatePatientDetails(patient.id, patch);
      if (!res.ok) return res.error;
      patched = true;
    }
    const err = await onConfirm({
      roomId: b.roomId, date: b.date, time: b.time, dur: b.dur, buffer: b.buffer,
      reason: reason.trim(), offSchedule: b.offSchedule,
      studies: b.studies as RescheduleStudy[],
    });
    // Правки пацієнта вже в базі — кажемо про це прямо, інакше користувач закриє
    // форму в упевненості, що «нічого не збереглося», і введе їх удруге.
    if (err) return patched ? "Дані пацієнта збережено, але перенести не вдалося: " + err : err;
    return null;
  }

  /* Обрали ІНШИЙ кабінет → це переоформлення, а не зсув по сітці: показуємо форму
     запису з даними пацієнта і порожнім переліком досліджень (див. блок вище).
     Вихід ✕ повертає до звичайного переносу — кабінет скидаємо на поточний. */
  const backToSlots = () => { setRoomId(patient.room_id || options[0]?.id || ""); setTime(""); };
  if (showMoveLoading) return <MoveFormLoading onClose={backToSlots} />;
  if (showMove) {
    return (
      <BookingModal
        moveMode
        rooms={options.filter((r) => r.id !== patient.room_id)}
        clinicId={clinicId}
        clinicTz={clinicTz}
        incidents={incidents}
        services={svcRows}
        roomOverrides={ovRows}
        caseSiblings={caseSiblings}
        allowOffSchedule={allowOffSchedule}
        prefill={movePrefill}
        onClose={backToSlots}
        onSave={handleMoveSave}
        extraFields={
          <label className="fld"><span className="fld-lab">Причина переносу (необовʼязково)</span>
            <input className="inp" value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="Напр.: пацієнт запізнився / за бажанням пацієнта / апарат зайнятий" /></label>
        }
      />
    );
  }

  return (
    <>
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 520 }} ref={dialogRef} role="dialog" aria-modal="true" aria-label="Перенесення запису" onChangeCapture={() => setDirty(true)}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--blue-bg)", color: "var(--blue)" }}>🗓</span>Перенести на новий слот</div>
          <button className="icon-btn" onClick={requestClose} aria-label="Закрити">✕</button>
        </div>
        <div className="dlg-body">
          {/* Тут склад НІКОЛИ не змінюється (зміна кабінету відкриває форму
              переоформлення вище), тож шапка описує запис як є. */}
          <div className="ctx-hint blue" style={{ fontSize: 13 }}>Пацієнт: <b>{patient.patient_name}</b> · {procLabel(patient)} · {dur} хв{buffer > 0 ? ` + ${buffer} буфер` : ""}</div>
          <label className="fld"><span className="fld-lab">Причина переносу (необовʼязково)</span>
            <input className="inp" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Напр.: пацієнт запізнився / за бажанням пацієнта / апарат зайнятий" /></label>
          <div className="fld">
            <span className="fld-lab">Кабінет ({kind})</span>
            {options.length === 0
              ? <div className="ctx-hint red" style={{ fontSize: 12.5 }}>Немає кабінетів типу {kind}.</div>
              : options.length > ROOM_LIST_MAX_CHIPS
              // Понад 3 кабінети — список (єдиний поріг з BookingModal/порталом):
              // картки .bd-room у вузькій модалці переносу тиснуть назви ще сильніше.
              ? <RoomSelect rooms={options} value={roomId}
                  onChange={(id) => { setRoomId(id); setTime(""); }} />
              : <div className="bd-rooms">
                  {options.map((r) => {
                    const off = !isRoomBookable(r);   // 0123: лише поточний кабінет запису
                    return (
                    <button key={r.id} className={"bd-room" + (roomId === r.id ? " active" : "")} onClick={() => { setRoomId(r.id); setTime(""); }}
                      title={r.name + (r.apparatus_model ? " · " + r.apparatus_model : "") + (off ? " · " + ROOM_OFF_LABEL : "")}>
                      <span className={"bd-room-kind " + modalityKind(r.modality)}>{modalityShort(r.modality)}</span>
                      <span className="bd-room-meta"><span className="bd-room-name">{r.name}{off ? " · " + ROOM_OFF_LABEL : ""}</span><span className="bd-room-model">{r.apparatus_model || ""}</span></span>
                    </button>
                    );
                  })}
                </div>}
            {/* 0123: запис лишився у вимкненому кабінеті — час міняти можна, і це
                треба сказати прямо, інакше зникнення інших чипів виглядає як збій. */}
            {curRoomOff && (
              <div className="ctx-hint blue" style={{ fontSize: 12.5, marginTop: 8 }} role="status" aria-live="polite">
                ℹ Кабінет <b>{curRoom?.name}</b> вимкнено. Час у ньому змінити можна,
                а щоб перевести пацієнта — оберіть інший кабінет зі списку.
              </div>
            )}
            {moveBlocked && (
              <div className="ctx-hint red" style={{ fontSize: 12.5, marginTop: 8 }} role="status" aria-live="polite">
                ⚠ Не вдалося прочитати {catalogErr ? "прайс кабінетів" : "картку пацієнта"} —
                переоформлення в інший кабінет зараз недоступне. Оновіть сторінку
                або поверніть поточний кабінет, щоб просто змінити час.
              </div>
            )}
          </div>

          <div className="fld-row">
            <label className="fld" style={{ maxWidth: 180 }}><span className="fld-lab">Дата</span>
              {/* Клампимо в onChange: атрибут min лише малює межу, але не блокує
                  введення/вставку минулої дати. */}
              <input className="inp tabular" type="date" min={clinicTodayStr} value={dateStr}
                onChange={(e) => { const v = e.target.value; setDateStr(v && v < clinicTodayStr ? clinicTodayStr : v); setTime(""); }} /></label>
            <div className="fld"><span className="fld-lab">Вільні слоти · блок {dur} хв · {slotsLoading ? "завантаження…" : "вміщується ще " + fitCount}</span></div>
          </div>
          <div className="fld">
            {isPastDay && <div className="ctx-hint red" style={{ marginBottom: 10 }}>⏳ {dateStr} уже минуло — перенести можна лише на майбутній час.</div>}
            {roomSched.closed && <div className="ctx-hint red" style={{ marginBottom: 10 }}>🚫 {room ? room.name : "Кабінет"} не працює {dateStr}{override && override.label ? " · " + override.label : ""}. Оберіть інший день.</div>}
            {!roomSched.closed && roomSched.custom && <div className="ctx-hint blue" style={{ marginBottom: 10 }}>🕐 Особливий графік: {roomSched.start}–{roomSched.end}.</div>}
            {roomIncident && slots.some((s) => slotState(s) === "blocked") && <div className="ctx-hint red" style={{ marginBottom: 10 }}>🔧 {room ? room.name : "Кабінет"} на ремонті/ТО{roomIncident.blocked_until ? " до " + new Date(roomIncident.blocked_until).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) : ""}. Оберіть слот після відновлення або інший день.</div>}
            {taken && <div className="ctx-hint red" style={{ marginBottom: 10 }}>⚡ Слот {taken} щойно зайняли — оберіть інший. <button className="btn btn-secondary btn-sm" style={{ marginLeft: 6 }} onClick={() => setTaken(null)}>Зрозуміло</button></div>}
            {/* Зайнятість не завантажилась — сітку НЕ показуємо (порожній день = «усе вільно»). */}
            {(busyError || schedErr) && !slotsLoading
              ? <div className="ctx-hint red">⚠ Не вдалося завантажити {busyError ? "зайнятість" : "графік"} кабінету — оновіть сторінку. Показувати вільний час не можемо.</div>
              : slotsLoading
              ? <div className="ctx-hint" style={{ fontSize: 13, padding: "20px 0", textAlign: "center", color: "var(--text-muted)" }}>⏳ Завантаження вільних слотів…</div>
              : <SlotPicker
                  slots={slots}
                  value={time}
                  onChange={(s) => { setTime(s); setDirty(true); }}
                  spanMin={dur}
                  bufferMin={buffer}
                  resetKey={roomId + "|" + dateStr + "|" + dur + "|" + buffer}
                  stateOf={slotState}
                  freeStates={SELECTABLE}
                  titleOf={(s, st) => (st === "busy" || st === "buffer") ? busyLabel(s) : st === "blocked" ? blockedLabel(s) : st === "break" ? breakLabel(s) : st === "offsched" ? offSchedLabel(s) : st === "offhours" ? "Кабінет не працює в цей час" : st === "tight" ? ("Не вміщується: блок " + dur + " хв перетне " + tightReason(s)) : st === "past" ? "Час минув" : ("Вільно · " + s + "–" + fmt(toMin(s) + dur))}
                />}
            {busyList.length > 0 && (
              <div className="bk-busy-list">
                <span className="bk-busy-lab">Зайнятий час{room ? " (" + room.name + ")" : ""}:</span>
                {/* Дослідження і буфер прибирання — окремо: видно, коли кабінет реально звільняється. */}
                {busyList.map((b, i) => (
                  <span className="bk-busy-chip" key={i}>
                    {fmt(b.s)}–{fmt(b.eStudy)}{b.e > b.eStudy ? <span style={{ opacity: 0.7 }}> +{b.e - b.eStudy} хв</span> : null}
                  </span>
                ))}
              </div>
            )}
            {/* 0077 — підтвердження переносу поза графік (лише дошки персоналу). */}
            {needsOffConfirm && (
              <div className="info-banner offsched" style={{ marginTop: 10, flexDirection: "column", alignItems: "stretch", gap: 8 }}>
                <span className="ib-txt">
                  <b>⏰ Поза графіком.</b>{" "}
                  {selOff?.kind === "break" && selOff.brk
                    ? <>Слот потрапляє в <b>перерву {selOff.brk.start}–{selOff.brk.end}</b>.</>
                    : <>Кабінет працює до <b>{selOff?.end}</b>, а дослідження закінчиться о <b>{fmt(toMin(time) + dur)}</b>.</>}
                  {" "}Запис буде позначено як «поза графіком».
                </span>
                <label className="fld-lab" style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={offOk} onChange={(e) => setOffOk(e.target.checked)} />
                  Підтверджую роботу поза графіком
                </label>
              </div>
            )}
            <div className="bk-slot-legend">
              <span><span className="lg-dot free" />вільно</span>
              <span><span className="lg-dot tight" />не вміщується</span>
              <span><span className="lg-dot busy" />зайнято</span>
              <span><span className="lg-dot busybuf" />буфер</span>
              {time && buffer > 0 && <span><span className="lg-dot planbuf" />буфер цього запису</span>}
              {roomBreaks.length > 0 && <span><span className="lg-dot brk" />перерва</span>}
              {allowOffSchedule && <span><span className="lg-dot offsched" />поза графіком</span>}
            </div>
          </div>
        </div>
        {saveErr && <div className="dlg-err" role="alert">⚠ {saveErr}</div>}

        <div className="dlg-foot">
          {valid
            ? <span className="bk-summary">{room ? room.name : ""} · {dateStr} {time}–{fmt(toMin(time) + dur)}{buffer > 0 ? " (+" + buffer + " хв буфер → вільно з " + fmt(toMin(time) + dur + buffer) + ")" : ""}</span>
            : <span style={{ fontSize: 12, color: "var(--text-faint)", marginRight: "auto", alignSelf: "center" }}>Оберіть кабінет, дату та слот</span>}
          <button className="btn btn-ghost" onClick={requestClose} disabled={saving}>Скасувати</button>
          <button className="btn btn-primary" disabled={!valid || saving} onClick={handleConfirm}>
            {saving ? "Перенесення…" : "✓ Перенести на цей слот"}
          </button>
        </div>
      </div>
    </div>
    {askClose && (
      <ConfirmDialog
        title="Незбережені зміни"
        text="Обрано новий слот/причину, але перенесення не збережено. Закрити без збереження?"
        confirmLabel="Закрити без збереження"
        cancelLabel="Продовжити"
        danger
        onConfirm={() => { setAskClose(false); onClose(); }}
        onClose={() => setAskClose(false)}
      />
    )}
    </>
  );
}
