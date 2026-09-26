"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import SlotPicker from "@/components/SlotPicker";
import { useModalA11y } from "@/lib/useModalA11y";
import { useRoomBusy, busyAt, busyTooltip } from "@/lib/slotBusy";
import { buildSlots, slotToMin } from "@/lib/slots";
import { inBreak, overrideOn, overrideFeed, roomBreaksFromFeed, roomScheduleFromFeed, dateKeyOf, type OverrideFeed, type DayOverride } from "@/lib/schedule";
import { incidentEffectiveEnd, roomIncidentsOf, wallNow, wallToday0, wallMinOfDay, type IncidentLike, type IncidentFeed } from "@/lib/incidents";
import { useFollowTodayKey, dayOfKey, dayShiftNoticeOf, dayShiftNoticeVerdict, type DayShiftNotice } from "@/lib/useFollowToday";
import { useScheduleRefetch } from "@/lib/useScheduleRefetch";
import { useDropSlots } from "@/lib/useDropSlots";
import { createClient } from "@/lib/supabase/client";
import { DRAG_MIME, dragStatusesFor, dragChipLabel, isNoopDrop, type DragEntry, type DragRole, type DropTarget } from "@/lib/dragMove";
/* Формат дати — ТОЙ САМИЙ, що в банерах форм запису (`fmtShort`, «1 вересня»).
   Карта дня оголошена дзеркалом форми, тож і про перенесення вона мусить
   говорити тими самими словами; своя копія форматера розійшлася б із ними
   мовчки, як уже розходились три інші дублі правил у цьому проєкті. */
import { fmtShort } from "@/components/BookingModal";
import { modalityShort, modalityKind } from "@/lib/studies";
import type { QueueStatus } from "@/supabase/types";

type Room = {
  id: string;
  name: string;
  modality: string;
  apparatus_model?: string | null;
  schedule?: unknown;
};
type RoomIncident = IncidentLike & { reason_label?: string | null };

/* с81: режим переносу. Карта дня перестає бути лише читанням — у ній можна
   взяти запис (чип «Записи дня» або запис, принесений із дошки перетягуванням)
   і покласти на вільний слот ТОГО САМОГО кабінету. Хто саме може переносити,
   вирішує батько (він і передає `move`): дошка черги — admin/registrar,
   портал — направник із активним грантом. Сервер перевіряє все ще раз. */
export type MoveProps = {
  role: DragRole;
  /** Запис, узятий на дошці: зовнішнє перетягування або кидок на день календаря. */
  entry?: DragEntry | null;
  /** Зовнішнє перетягування ще триває (сітка приймає кидок із дошки). */
  dragActive?: boolean;
  /** Повертає ТЕКСТ помилки або null (успіх) — як `onConfirm` у RescheduleModal. */
  onMove: (entry: DragEntry, target: DropTarget) => Promise<string | null>;
  /** Після успішного переносу — батько оновлює дошку і вирішує, чи закривати вікно. */
  onMoved?: (entry: DragEntry, target: DropTarget) => void;
};

type Props = {
  rooms: Room[];
  /** ⚠️ U-65: потрібен НЕ для запитів, а для ФІЛЬТРА realtime-підписки —
   *  `clinic_id=eq.` на `queue_entries` (див. `lib/slotBusy.ts`). Без нього
   *  підписки не буде зовсім: краще без realtime, ніж крос-тенантний оракул. */
  clinicId: string | null | undefined;
  /* с81: необовʼязкова — портал направника передає зону ОБРАНОГО центру
     (мультицентровий екран; singleton там не виставляється), як і решта його
     модалок; без значення — singleton дошки персоналу. */
  clinicTz?: string;
  incidents: IncidentFeed<RoomIncident>;   // U-11: фід (rows+failed), не голий масив
  /* U-16: фід (мапа+failed), не гола мапа. Персонал передає ВСЮ мапу центру
     (дошка читає `schedule_overrides` таблицею — `sched_staff_read`).
     с81: направник таблицю не читає (RF-03, 0183) — для нього карта дня читає
     день сама через RPC `sched_override_read`: викликач каже це літералом
     `"rpc"`. Проп лишається ОБОВʼЯЗКОВИМ (U-16: повноту викликів перелічує
     tsc), і третього значення немає — фід або RPC. */
  overrides: OverrideFeed | "rpc";
  /** с81: з якого дня і кабінету відкрити (кидок на день календаря; запис із дошки). */
  initialDay?: string | null;
  initialRoomId?: string | null;
  move?: MoveProps;
  onClose: () => void;
};

/* ⚠️ Г1-G (с53, знахідка ревʼю Б): ОДИН формат ключа доби на продукт — тут
   стояла сьома власна копія тіла `dateKeyOf`, і саме вона задає `day`, тобто
   `curKey` для спільного правила. Розходження двох копій формату вбило б
   перенесення МОВЧКИ, а разом із ним і банер. Локальний `pad` пішов із нею:
   інших споживачів у нього не було. */
const dateKey = (d: Date) => dateKeyOf(d);
const dateFromKey = (v: string) => {
  const [y, m, d] = v.split("-").map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1);
};
/**
 * Карта дня для адміністратора (з с81 — і для реєстратора та направника). Вона
 * намеренно використовує ті самі room_busy_slots + SlotPicker, що й перенос:
 * візуальна відповідь на питання «кабінет вільний?» не має розходитись із
 * формою запису. У режимі `move` тут ще й переносять — див. `MoveProps`.
 */
export default function RoomDayOverviewModal({ rooms, clinicId, clinicTz, incidents, overrides, initialDay = null, initialRoomId = null, move, onClose }: Props) {
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  const overridesByRpc = overrides === "rpc";
  const [roomId, setRoomId] = useState(() => (initialRoomId && rooms.some((r) => r.id === initialRoomId) ? initialRoomId : rooms[0]?.id || ""));
  const [day, setDay] = useState(() => initialDay || dateKey(wallToday0(clinicTz)));
  const [selectedSlot, setSelectedSlot] = useState("");
  /* с81: слот, обраний КЛІКОМ у режимі переносу, — чекає підтвердження. Гасне з
     будь-якою зміною дня чи кабінету (ефект нижче), включно з поправкою
     годинника через північ: «перенести на 09:00?» про ЧУЖУ добу — та сама вада,
     що й обраний слот, лише з кнопкою «Так» поруч. */
  const [pending, setPending] = useState<string | null>(null);
  /* ⚠️ U-72. `day` зафіксовано ініціалізатором, а `isToday` нижче рахується
     живим `wallToday0`. Після поправки годинника через північ вони розходяться,
     `isToday` стає хибним — і з `stateOf` зникає гілка «час уже минув»: карта
     дня показує ЦІЛИЙ день вільним. Карта оголошена дзеркалом форми запису,
     тож розбіжність саме тут читається як «у формі зайнято, а на карті вільно».
     Записів цей екран не робить, дата видима й редагована — тому й ціна нижча,
     ніж у форм. Правило те саме: винятків «тут лише перегляд» не тримаємо. */
  /* ⚠️ Г1-B (знахідка ревʼю Г по с51, пакет с52). До цієї правки виклик стояв
     БЕЗ `onShift` — і це давало рівно ту ваду, проти якої `onShift` заведено.
     РУЧНА зміна дати тут скидає обраний слот (`onChange` нижче), АВТОМАТИЧНА
     не скидала: слот «09:00», обраний на 2 вересня, лишався підсвіченим і
     підписаним у рядку «Обрано …» вже на карті 1 вересня. Екран оголошений
     дзеркалом форми запису, а адміністратор саме з нього диктує вільний час
     оператору або пацієнту — тобто називає час, звірений з ЧУЖОЮ добою, і
     жоден гард цього не ловить: карта нічого не пише.
     Скидання і банер — та сама пара, що у трьох форм запису; банер знімає той,
     хто взяв дату в свої руки (`onChange`), а не таймер. */
  /* ⚠️ Г1-G (с53): стан у КЛЮЧАХ доби, а рукописна пара умов замінена спільним
     правилом із `lib/useFollowToday.ts` — своя копія була і тут. */
  const [dayShifted, setDayShifted] = useState<DayShiftNotice | null>(null);
  /* с81: кидок на день календаря відкриває карту одразу на ОБРАНОМУ дні
     (`initialDay`). `pinnedKey` для нього НЕ ставимо свідомо (урок F3, с55:
     пін на навігаційній даті глушить правило рівно на «сьогодні»): чужу дату
     правило й так не чіпає (`derivedFromToday`), а якщо кинули на «сьогодні» і
     поправка годинника перейшла північ — карта переставиться і СКАЖЕ про це
     банером нижче, скинувши обраний слот і очікуване підтвердження. */
  useFollowTodayKey({ clinicTz, value: day, setKey: setDay, onShift: (d, prev) => { setSelectedSlot(""); setDayShifted((s) => dayShiftNoticeOf(s, prev, d)); } });
  /* ⚠️ Г1-G: ОДИН вердикт на банер — другий екземпляр умови розійшовся б мовчки.
     ТРИЗНАЧНИЙ (ревʼю А по Г1-G): «туди-назад» — не тиша, `setSelectedSlot("")`
     відпрацював двічі. До Г1-G тут стояло «і це видно» — не аргумент: порожнє
     поле без причини і є та сама тиха вада навиворіт. */
  const dayShiftSay = dayShiftNoticeVerdict(dayShifted, day);

  useEffect(() => { setPending(null); }, [day, roomId]);

  const room = rooms.find((r) => r.id === roomId) || null;
  const date = useMemo(() => dateFromKey(day), [day]);

  /* ===== с81: особливі графіки для направника — по днях, через RPC (RF-03) =====
     Той самий читач і той самий гейт, що в `RescheduleModal.loadSched`:
     помилку RPC піднімаємо (PostgREST не кидає — U-3), відповідь чужого дня
     відкидає лічильник поколінь, збій обнуляє прочитане і піднімає `failed`
     (фід ↔ `overridesFailed` нижче). Живі оновлення — `useScheduleRefetch`
     (для направника фактично лише тик на 30 с: подій по `schedule_overrides`
     він не отримує; сказано в самому хуку). */
  const [ovDay, setOvDay] = useState<{ key: string; ov: DayOverride | null } | null>(null);
  const [ovFailed, setOvFailed] = useState(false);
  const [ovLoading, setOvLoading] = useState(overridesByRpc);
  const ovReqRef = useRef(0);
  const loadOv = useCallback(async () => {
    if (!overridesByRpc) return;
    const req = ++ovReqRef.current;
    try {
      if (!clinicId) throw new Error("no clinic");
      const supabase = createClient();
      const ovRes = await supabase.rpc("sched_override_read", { p_clinic: clinicId, p_date: day }).maybeSingle();
      if (ovRes.error) throw ovRes.error;
      if (req !== ovReqRef.current) return;
      setOvDay({ key: day, ov: (ovRes.data as unknown as DayOverride) || null });
      setOvFailed(false);
    } catch {
      if (req !== ovReqRef.current) return;
      setOvDay(null); setOvFailed(true);
    } finally {
      if (req === ovReqRef.current) setOvLoading(false);
    }
  }, [overridesByRpc, clinicId, day]);
  useEffect(() => { if (overridesByRpc) { setOvLoading(true); loadOv(); } }, [overridesByRpc, loadOv]);
  useScheduleRefetch({ clinicId, dateStr: day, roomId, scope: "overview", onChange: loadOv, enabled: overridesByRpc });
  /* Фід для решти екрана: персоналу — проп, направнику — прочитаний день.
     Ще не прочитаний день = невідомість (`failed`), не порожнеча — інакше
     кадр до відповіді малював би закритий день робочим. */
  const rpcFeed: OverrideFeed = ovDay && ovDay.key === day && !ovFailed
    ? overrideFeed({ ...(ovDay.ov ? { [day]: ovDay.ov } : {}) }, false)
    : overrideFeed(null, true);
  const ovFeed: OverrideFeed = overridesByRpc ? rpcFeed : (overrides as OverrideFeed);
  /* «Читаємо день» рахується й СИНХРОННО (не лише прапорцем, який підіймає
     ефект ПІСЛЯ рендера): інакше на зміні дня один кадр стверджував би «не
     вдалося завантажити» — збій, якого не було (ревʼю с81 р1). */
  const ovPending = overridesByRpc && !ovFailed && (!ovDay || ovDay.key !== day);

  /* U-16: `null` = особливі графіки дня не прочитались. Порожня мапа на місці
     збою означала б «особливих днів немає», і день, закритий ЛИШЕ через
     override, малювався б повною сіткою вільних слотів — на екрані, який
     МУСИТЬ збігатися з формою запису. Той самий клас, що U-11, інший канал. */
  const schedule = roomScheduleFromFeed(date, roomId, ovFeed, room?.schedule ?? null);
  const overridesFailed = schedule === null;
  /* ⚠️ `|| []` тут — ЄДИНЕ місце в пакеті, де невідомість стає порожнечею, і
     безпечне воно лише композиційно: при `overridesFailed` гілка-банер нижче
     перехоплює рендер, `slots` порожній, а `stateOf` має власну розтяжку
     («невідомо → blocked»). Тобто ні `inBreak`, ні `breaks.map`, ні
     `breaks.length` до цього масиву не доходять. Виносиш розрахунок сітки
     з-під тієї гілки — спершу поверни сюди `null` (ревʼю р1 F4 / р2 F7). */
  const breaks = roomBreaksFromFeed(date, roomId, room?.schedule ?? null, ovFeed) || [];
  const { spans, loading, error, reload } = useRoomBusy({ roomId, dateStr: day, clinicId, enabled: !!roomId });
  /* Примітиви в депсах: сам `schedule` — новий обʼєкт на кожен рендер.
     Невідомий графік дає порожню сітку так само, як зачинений день: показувати
     її нема з чого, а гілка-банер нижче все одно перехоплює цей стан. */
  const dayClosed = !!schedule?.closed;
  const dayStart = schedule?.start ?? "";
  const dayEnd = schedule?.end ?? "";
  const slots = useMemo(
    () => (overridesFailed || dayClosed ? [] : buildSlots(slotToMin(dayStart), slotToMin(dayEnd))),
    [overridesFailed, dayClosed, dayStart, dayEnd],
  );
  // Настінний час клініки як хвилини доби. wallNow(tz) уже повертає wall-as-UTC,
  // тож БЕРЕМО wallMinOfDay (UTC-поля), а НЕ форматуємо ще раз у clinicTz —
  // інакше зсув таймзони застосовувався б ДВІЧІ (13:42 ставало 16:42, і всі
  // слоти до 16:40 хибно позначались «Цей час уже минув»).
  const nowMin = wallMinOfDay(wallNow(clinicTz));
  const isToday = day === dateKey(wallToday0(clinicTz));
  /* U-11: null = простої не прочитались. Ця карта — read-only відповідь на
     питання «кабінет вільний?», і вона мусить збігатися з формою запису;
     порожній масив на місці збою малював би ремонт вільним часом. */
  const roomIncidents = roomIncidentsOf(incidents, roomId);
  const incidentsFailed = roomIncidents === null;

  const incidentAt = (min: number) => {
    const instant = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(min / 60), min % 60);
    return (roomIncidents || []).find((i) => instant >= new Date(i.started_at).getTime() && instant < incidentEffectiveEnd(i));
  };
  const stateOf = (slot: string) => {
    const min = slotToMin(slot);
    // Страховка на випадок, якщо гілку-банер колись приберуть: невідомо ≠ вільно.
    if (incidentsFailed) return "blocked";
    if (overridesFailed) return "blocked";
    if (incidentAt(min)) return "blocked";
    const busy = busyAt(spans, min);
    if (busy) return min >= busy.eStudy ? "buffer" : "busy";
    if (inBreak(min, breaks)) return "break";
    // SlotPicker already has a neutral muted style for `tight`; in this read-only
    // screen it denotes elapsed time rather than an insufficient booking duration.
    if (isToday && min < nowMin) return "tight";
    return "free";
  };
  const titleOf = (slot: string, state: string) => {
    const min = slotToMin(slot);
    if (state === "blocked") {
      const incident = incidentAt(min);
      return `Кабінет недоступний${incident?.reason_label ? ` · ${incident.reason_label}` : ""}`;
    }
    if (state === "busy" || state === "buffer") {
      const busy = busyAt(spans, min);
      return busy ? (state === "buffer" ? `Буфер після дослідження\n${busyTooltip(busy)}` : busyTooltip(busy)) : "Зайнято";
    }
    if (state === "break") {
      const brk = inBreak(min, breaks);
      return brk ? `Перерва · ${brk.start}–${brk.end}` : "Перерва";
    }
    if (state === "tight") return "Цей час уже минув";
    return `Вільно · ${slot}`;
  };

  const occupiedMin = spans.reduce((sum, s) => sum + (s.e - s.s), 0);

  /* ===== с81: режим переносу ===== */
  const canMove = !!move;
  /* Запис «у руках»: принесений із дошки (проп) або взятий чипом тут. Живе,
     доки не перенесли, не зняли хрестиком чи не закрили вікно: кінець
     ЗОВНІШНЬОГО перетягування (кидок мимо цілі) його НЕ знімає — інакше
     людині довелось би повертатись на дошку і тягнути заново. */
  const [moving, setMoving] = useState<DragEntry | null>(move?.entry ?? null);
  const extId = move?.entry?.id ?? null;
  useEffect(() => { if (move?.entry) setMoving(move.entry); }, [extId]); // eslint-disable-line react-hooks/exhaustive-deps
  /* Запис «з дошки» стоїть окремим чипом, поки він у руках: зі списку записів
     дня його при цьому прибираємо, щоб не було двох чипів на один запис. */
  const parked = !!moving && !!extId && moving.id === extId;
  const [saving, setSaving] = useState(false);
  const [moveErr, setMoveErr] = useState<string | null>(null);
  const [moveDone, setMoveDone] = useState<string | null>(null);
  /* Ціль — лише кабінет самого запису (межа с81, див. lib/dragMove.ts). */
  const dropRoomOk = !!moving && moving.room_id === roomId;
  const ds = useDropSlots({
    entry: moving, roomId, roomSchedule: room?.schedule ?? null, dateKey: day, clinicId, clinicTz,
    overridesFeed: ovFeed, incidents, enabled: canMove && dropRoomOk, scope: "overview",
  });
  const dropMode = canMove && dropRoomOk;
  /* Кнопка переносу на дошці цієї ролі — щоб підказки називали те, що людина
     справді бачить у рядку («Перенести» у персоналу, «Перезаписати» у направника). */
  const reschedBtn = move?.role === "referrer" ? "«🗓 Перезаписати»" : "«🗓 Перенести»";

  /* «Записи дня» кабінету — щоб узяти запис прямо тут. Читання під RLS: персонал
     бачить усі записи центру, направник — лише свої з активним грантом (0204).
     Помилка читання — не «записів немає» (U-3): чипів тоді немає, є причина.
     Перечитуємо разом із зайнятістю (відбиток спанів): realtime по
     `queue_entries` уже веде в `useRoomBusy`, другу підписку не заводимо. */
  const [dayEntries, setDayEntries] = useState<DragEntry[]>([]);
  const [dayEntriesErr, setDayEntriesErr] = useState(false);
  const [dayEntriesLoaded, setDayEntriesLoaded] = useState(false);
  const deReqRef = useRef(0);
  const statuses = useMemo(() => dragStatusesFor(move?.role ?? "desk"), [move?.role]);
  const spansKey = spans.map((s) => s.s + "-" + s.e).join(",");
  const loadDayEntries = useCallback(async () => {
    if (!canMove || !roomId) { setDayEntries([]); setDayEntriesLoaded(true); return; }
    const req = ++deReqRef.current;
    try {
      const supabase = createClient();
      const { data, error: deErr } = await supabase
        .from("queue_entries")
        .select("id, room_id, clinic_id, scheduled_date, scheduled_time, duration_min, buffer_time_min, status, patient_name")
        .eq("room_id", roomId).eq("scheduled_date", day)
        .in("status", statuses as QueueStatus[])
        .order("scheduled_time", { ascending: true });
      if (req !== deReqRef.current) return;
      if (deErr) { setDayEntriesErr(true); setDayEntriesLoaded(true); return; }
      setDayEntries((data || []) as DragEntry[]);
      setDayEntriesErr(false);
      setDayEntriesLoaded(true);
    } catch {
      if (req !== deReqRef.current) return;
      setDayEntriesErr(true); setDayEntriesLoaded(true);
    }
  }, [canMove, roomId, day, statuses]);
  useEffect(() => { deReqRef.current++; setDayEntriesLoaded(false); setDayEntries([]); }, [roomId, day]);
  /* Читаємо ПІСЛЯ першої відповіді зайнятості (а не на маунті і ще раз на
     першому відбитку спанів — два однакові запити при відкритті, ревʼю с81 р1). */
  useEffect(() => { if (loading) return; loadDayEntries(); }, [loadDayEntries, spansKey, loading]);
  /* Запис, узятий чипом, зник із дня (хтось переніс/скасував, або він уже
     перенесений звідси) — з рук його відпускаємо. Принесений із дошки лишається:
     він законно може бути з іншого дня. */
  useEffect(() => {
    if (!moving || parked || !dayEntriesLoaded || dayEntriesErr) return;
    if (!dayEntries.some((e) => e.id === moving.id)) setMoving(null);
  }, [moving, parked, dayEntries, dayEntriesLoaded, dayEntriesErr]);

  const roomOfMoving = moving ? rooms.find((r) => r.id === moving.room_id) : null;
  /* Слот, обраний кліком, лишається ціллю, лише поки даним можна вірити І він
     досі вільний — дзеркало `valid`/`stillFree` у RescheduleModal (ревʼю с81 р1):
     інакше «✓ Перенести» вело б на сервер по застарілій сітці. */
  const pendingOk = !!pending && dropMode && ds.trusted && ds.stateOf(pending) === "free";
  useEffect(() => {
    if (!pending || pendingOk || saving) return;
    setPending(null);
    setMoveErr("Слот щойно зайняли або дані про день оновились — оберіть слот заново");
  }, [pending, pendingOk, saving]);
  async function doMove(entry: DragEntry, time: string) {
    if (!move || saving) return;
    const target: DropTarget = { roomId, dateKey: day, time };
    setMoveDone(null);
    if (!dropRoomOk) { setMoveErr(`Перенести можна лише в межах кабінету ${roomOfMoving?.name || "запису"} — оберіть його вище`); return; }
    if (isNoopDrop(entry, target)) { setMoveErr("Запис уже стоїть на цьому слоті"); setPending(null); return; }
    /* Та сама перевірка перед КИДКОМ: між рендером сітки і кидком слот могли зайняти. */
    if (!ds.trusted || ds.stateOf(time) !== "free") { setMoveErr("Слот щойно зайняли або дані про день оновились — оберіть слот заново"); setPending(null); ds.reload(); return; }
    setSaving(true); setMoveErr(null);
    try {
      const err = await move.onMove(entry, target);
      if (err) { setMoveErr(err); ds.reload(); loadDayEntries(); return; }
      setMoving(null); setPending(null); setSelectedSlot("");
      setMoveDone(`✓ Перенесено на ${fmtShort(dayOfKey(target.dateKey))} ${target.time}`);
      reload(); ds.reload(); loadDayEntries();
      move.onMoved?.(entry, target);
    } catch {
      setMoveErr("Не вдалося перенести запис — спробуйте ще раз");
    } finally {
      setSaving(false);
    }
  }
  const pickEntry = (e: DragEntry) => {
    if (saving) return;
    setMoveErr(null); setMoveDone(null); setPending(null); setSelectedSlot("");
    setMoving((m) => (m?.id === e.id ? null : e));
  };
  /* Чип — `div role="button"`, а не `<button>`: старт перетягування з кнопок
     форм у Firefox ненадійний; Enter/Space — те саме, що клік. */
  const chipProps = (e: DragEntry) => ({
    role: "button" as const, tabIndex: 0,
    draggable: !saving,
    onClick: () => pickEntry(e),
    onKeyDown: (ev: KeyboardEvent<HTMLDivElement>) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pickEntry(e); } },
    onDragStart: (ev: DragEvent<HTMLDivElement>) => {
      if (saving) { ev.preventDefault(); return; }
      ev.dataTransfer.setData(DRAG_MIME, e.id);
      ev.dataTransfer.effectAllowed = "move";
      setMoveErr(null); setMoveDone(null); setPending(null); setMoving(e);
    },
  });
  /* Зовнішнє перетягування ще триває (рядок дошки над картою) — підказка інша:
     не «натисніть слот», а «відпустіть на слоті». */
  const extDrag = !!move?.dragActive;
  const movingLabel = moving ? dragChipLabel(moving) : "";

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog fade-in" style={{ maxWidth: 620 }} ref={dialogRef} role="dialog" aria-modal="true" aria-label="Зайнятість кабінету">
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--blue-bg)", color: "var(--blue-text)" }}>▦</span>Зайнятість кабінету</div>
          <button className="icon-btn" onClick={onClose} aria-label="Закрити">✕</button>
        </div>
        <div className="dlg-body">
          <div className="ctx-hint blue" style={{ fontSize: "0.8125rem" }}>
            {canMove
              ? "Карта дня оновлюється автоматично. Щоб перенести запис — перетягніть його на вільний слот або натисніть запис, а потім слот."
              : "Карта дня оновлюється автоматично. Зайнятий час включає дослідження та буфер прибирання."}
          </div>

          <div className="fld" style={{ marginTop: 14 }}>
            <span className="fld-lab">Кабінет</span>
            <div className="bd-rooms">
              {rooms.map((r) => (
                <button key={r.id} type="button" className={"bd-room" + (r.id === roomId ? " active" : "")} aria-pressed={r.id === roomId}
                  onClick={() => { setRoomId(r.id); setSelectedSlot(""); setMoveErr(null); }} title={r.apparatus_model ? `${r.name} · ${r.apparatus_model}` : r.name}>
                  <span className={"bd-room-kind " + modalityKind(r.modality)}>{modalityShort(r.modality)}</span>
                  <span className="bd-room-meta"><span className="bd-room-name">{r.name}</span><span className="bd-room-model">{r.apparatus_model || ""}</span></span>
                </button>
              ))}
            </div>
          </div>

          <div className="fld-row" style={{ alignItems: "end" }}>
            <label className="fld" style={{ maxWidth: 200 }}><span className="fld-lab">Дата</span>
              <input className="inp tabular" type="date" value={day} onChange={(e) => { setDay(e.target.value); setSelectedSlot(""); setDayShifted(null); }} />
            </label>
            <div className="fld" style={{ paddingBottom: 8 }}>
              <span className="fld-lab">Режим дня</span>
              {/* U-16: не стверджуємо ані «працює», ані «не працює», поки не
                  прочитали особливі графіки — обидва варіанти були б вигадкою. */}
              <b>{!schedule ? "Не завантажено" : schedule.closed ? "Кабінет не працює" : `${schedule.start}–${schedule.end}`}</b>
              {schedule?.custom && <span style={{ marginLeft: 6, color: "var(--blue-text)", fontSize: "0.75rem" }}>особливий графік</span>}
            </div>
          </div>

          {/* ⚠️ Г1-B: банер СТОЇТЬ НАД гілками нижче, а не всередині — інакше
              при закритому дні / збої читання (там рендер перехоплюється) він
              зник би саме тоді, коли розбіжність доби найдорожча.
              Називає ОБИДВІ доби з тієї самої причини, що й у форм (F7): ту, що
              «була», адміністратор уже сказав уголос, і відкликати треба саме її.

              ⚠️ `from !== to` — НЕ косметика (знахідка ревʼю А по цьому пакету).
              `from` навмисно не затирається другим викликом, і на поправці, що
              зʼїхала й повернулась (01→02→01 — штатний випадок, під нього ж
              написана «фантомна» гілка в `decideShift`), накопичене `from`
              збігається з новим `to`. Банер читався б «день змінено з 1 вересня
              на 1 вересня» — тобто екран стверджував би зміну, якої в підсумку
              не сталось.
              ⚠️ Г1-G ЗАКРИТО (с53): умова більше не рукописна і не місцева —
              вердикт дає спільне `dayShiftNoticeVerdict`, те саме в усіх шести
              екранах і на двох дошках. Раніше цієї умови не було в чотирьох із
              шести, і саме розходження рукописних копій було самим боргом.
              ⚠️ І ВІДРАЗУ ПОПРАВКА ДО ЦЬОГО Ж КОМЕНТАРЯ (ревʼю А по Г1-G).
              Тут стояло «слот при цьому справді скинуто двічі, і це видно» —
              це не аргумент, а та сама тиха вада навиворіт: порожнє поле часу
              без причини оператор читає як збій форми. Тому «туди-назад» тепер
              не мовчить, а каже СВОЇМ текстом — банер є, але про скинутий час,
              а не про зміну дня, якої не сталось. */}
          {dayShifted && dayShiftSay !== "none" && (
            <div className="ctx-hint" role="status" style={{ marginTop: 6 }}>
              {dayShiftSay === "moved"
                ? <>🕐 Годинник центру уточнено — день змінено з <b>{fmtShort(dayOfKey(dayShifted.fromKey))}</b> на <b>{fmtShort(dayOfKey(dayShifted.toKey))}</b>. Це вже інша карта: назвіть вільний час заново.</>
                : <>🕐 Годинник центру уточнено — день лишився <b>{fmtShort(dayOfKey(dayShifted.toKey))}</b>, але обраний час скинуто. Оберіть його заново.</>}
            </div>
          )}

          {/* с81: записи дня кабінету — щоб узяти запис тут. Чип = кнопка: натиснути
              (клавіатура, тач) або перетягнути. Принесений із дошки запис стоїть
              першим і має позначку. */}
          {canMove && (
            <div className="fld" style={{ marginTop: 12 }}>
              <span className="fld-lab">Записи дня · натисніть або перетягніть на вільний слот</span>
              <div className="dd-chips" aria-busy={saving}>
                {parked && moving && (
                  <div className="dd-chip active" aria-pressed="true" title="Запис із дошки — у руках; натисніть, щоб відкласти" {...chipProps(moving)}>
                    <span aria-hidden="true">⇅</span>{movingLabel}<span className="dd-tag">з дошки</span>
                  </div>
                )}
                {dayEntries.filter((e) => !(parked && e.id === extId)).map((e) => (
                  <div key={e.id} className={"dd-chip" + (moving?.id === e.id ? " active" : "")} aria-pressed={moving?.id === e.id}
                    title={moving?.id === e.id ? "У руках — оберіть вільний слот або натисніть ще раз, щоб відкласти" : "Узяти запис для переносу"}
                    {...chipProps(e)}>
                    <span aria-hidden="true">⇅</span>{dragChipLabel(e)}
                  </div>
                ))}
                {!dayEntriesLoaded && !dayEntriesErr && <span className="dd-muted" role="status">⏳ Читаємо записи дня…</span>}
                {dayEntriesErr && <span className="ctx-hint red" style={{ fontSize: "0.75rem" }} role="status">⚠ Не вдалося прочитати записи дня — оновіть сторінку.</span>}
                {dayEntriesLoaded && !dayEntriesErr && dayEntries.length === 0 && !moving && <span className="dd-muted">Записів, які можна перенести, цього дня немає.</span>}
              </div>
              {moving && !dropRoomOk && (
                <div className="ctx-hint" style={{ fontSize: "0.75rem", marginTop: 6 }} role="status">
                  ℹ Перетягуванням запис переноситься в межах кабінету <b>{roomOfMoving?.name || "запису"}</b> — оберіть його вище. В інший кабінет — через {reschedBtn}.
                </div>
              )}
            </div>
          )}

          {/* U-16: гілка невідомості — ПЕРША. Раніше першим стояв `schedule.closed`,
              а він порахований із мапи, якої могло не бути: при збої читання
              екран спокійно казав «не працює» або малював повну сітку вільних
              слотів. Порядок тут — частина правила, а не оформлення.
              с81: ще раніше — «читаємо день» (направник читає графік RPC): доки
              відповіді немає, це не збій і не знання. */}
          {ovLoading || ovPending ? (
            <div className="ctx-hint" style={{ padding: "22px 0", textAlign: "center", color: "var(--text-muted)" }}>⏳ Читаємо графік дня…</div>
          ) : overridesFailed ? (
            <div className="ctx-hint red">⚠ Не вдалося завантажити особливі графіки дня — режим роботи кабінету невідомий. Вільний час не показано. Оновіть сторінку.</div>
          ) : schedule.closed ? (
            <div className="ctx-hint red">🚫 {room?.name || "Кабінет"} не працює цього дня{overrideOn(ovFeed, day)?.label ? ` · ${overrideOn(ovFeed, day)?.label}` : ""}.</div>
          ) : (error || incidentsFailed) ? (
            /* U-11: збій простоїв ховає сітку так само, як збій зайнятості —
               інакше карта показала б «вільно» там, де кабінет на ремонті. */
            <div className="ctx-hint red">⚠ Не вдалося завантажити {error && incidentsFailed ? "зайнятість і простої" : error ? "зайнятість" : "простої"} кабінету. Вільний час не показано.
              {error && <button type="button" className="btn btn-secondary btn-sm" style={{ marginLeft: 6 }} onClick={reload}>Спробувати ще раз</button>}
              {!error && incidentsFailed && <span style={{ marginLeft: 6 }}>Оновіть сторінку.</span>}
            </div>
          ) : loading ? (
            <div className="ctx-hint" style={{ padding: "22px 0", textAlign: "center", color: "var(--text-muted)" }}>⏳ Завантаження зайнятості…</div>
          ) : (
            <>
              <div className="bk-busy-list" style={{ marginTop: 4 }}>
                <span className="bk-busy-lab">За день:</span>
                <span className="bk-busy-chip">{spans.length} записів</span>
                <span className="bk-busy-chip">зайнято {occupiedMin} хв</span>
                {breaks.map((b) => <span className="bk-busy-chip" key={`${b.start}-${b.end}`}>перерва {b.start}–{b.end}</span>)}
              </div>
              <div className="fld" style={{ marginTop: 12 }}>
                <span className="fld-lab">{dropMode && moving ? `${extDrag ? "Відпустіть на вільному слоті" : "Куди перенести"} · блок ${ds.durMin} хв${ds.bufferMin > 0 ? ` + ${ds.bufferMin} буфер` : ""} · крок 5 хв` : "Сітка дня · крок 5 хв"}</span>
                {/* с81: із записом «у руках» сітка рахується для НЬОГО (дослідження
                    + буфер, без самого запису — `p_exclude`), і лише коли цим даним
                    можна вірити; інакше — звичайна карта і причина поруч. */}
                {dropMode && moving && !ds.trusted ? (
                  <div className={"ctx-hint" + (ds.loading ? "" : " red")} style={{ fontSize: "0.78125rem" }} role="status">
                    {ds.loading ? "⏳ Перевіряємо, куди вміщується запис…" : "⚠ " + (ds.missText ?? "Дані про день не завантажились") + ` — перенести звідси не можна. Скористайтесь ${reschedBtn}.`}
                  </div>
                ) : dropMode && moving ? (
                  <SlotPicker slots={ds.slots} stateOf={ds.stateOf} value={pending || ""} onChange={(s) => { setPending(s); setMoveErr(null); setMoveDone(null); }} titleOf={ds.titleOf}
                    freeStates={["free"]} spanMin={ds.durMin} bufferMin={ds.bufferMin} dropActive={dropMode} onDropSlot={(s) => { void doMove(moving, s); }} />
                ) : (
                  <SlotPicker slots={slots} stateOf={stateOf} value={selectedSlot} onChange={setSelectedSlot} titleOf={titleOf} freeStates={["free"]} />
                )}
              </div>
              <div className="bk-slot-legend">
                <span><span className="lg-dot free" />вільно</span>
                {dropMode && moving && <span><span className="lg-dot tight" />не вміщується</span>}
                <span><span className="lg-dot busy" />дослідження</span>
                <span><span className="lg-dot busybuf" />буфер</span>
                {breaks.length > 0 && <span><span className="lg-dot brk" />перерва</span>}
                {(roomIncidents || []).length > 0 && <span><span className="lg-dot busy" />простій / ТО</span>}
                {isToday && !(dropMode && moving) && <span><span className="lg-dot tight" />час минув</span>}
              </div>
              {!moving && selectedSlot && <div className="ctx-hint blue" style={{ marginTop: 10 }}>Обрано {selectedSlot} · {titleOf(selectedSlot, stateOf(selectedSlot))}</div>}
              {/* с81: слот обрано КЛІКОМ — перенос лише за явним «Так». Кидок мишкою
                  підтвердження не питає: сам кидок і є намір. */}
              {/* `aria-disabled`, не `disabled`: усередині пастки фокуса справжній
                  disabled викидає фокус у <body> (правило проєкту, lib/useModalA11y). */}
              {moving && pending && pendingOk && (
                <div className="ctx-hint blue dd-confirm" style={{ marginTop: 10 }}>
                  <span>Перенести <b>{movingLabel}</b> на <b>{fmtShort(dayOfKey(day))} {pending}</b>{room ? ` · ${room.name}` : ""}?</span>
                  <button type="button" className="btn btn-primary btn-sm" aria-disabled={saving} aria-busy={saving} onClick={() => { if (!saving) void doMove(moving, pending); }}>{saving ? <><span className="rf-spin" aria-hidden="true" /> Переносимо…</> : "✓ Перенести"}</button>
                  <button type="button" className="btn btn-ghost btn-sm" aria-disabled={saving} onClick={() => { if (!saving) setPending(null); }}>Скасувати</button>
                </div>
              )}
            </>
          )}
          {moveErr && <div className="ctx-hint red" role="alert" style={{ marginTop: 10 }}>⚠ {moveErr}</div>}
          {/* Регіон результату — ПОСТІЙНИЙ (створений уже з текстом, він міг би не
              озвучитись — та сама причина, що в .slot-hint). */}
          {canMove && (
            <div className={moveDone && !moveErr ? "ctx-hint" : "rf-vh"} role="status" aria-live="polite" style={moveDone && !moveErr ? { marginTop: 10, color: "var(--green)" } : undefined}>
              {moveDone && !moveErr ? moveDone : ""}
            </div>
          )}
        </div>
        <div className="dlg-foot"><span style={{ fontSize: "0.75rem", color: "var(--text-faint)", marginRight: "auto" }}>{canMove ? "Перенос перевіряє сервер: минуле, графік, простої та перетини." : "Дані оновлюються при зміні черги або інциденту."}</span><button className="btn btn-primary" onClick={onClose}>Готово</button></div>
      </div>
    </div>
  );
}
