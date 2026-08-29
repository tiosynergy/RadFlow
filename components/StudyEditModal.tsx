"use client";

/* ===== RadFlow — Редактор досліджень =====
   Портовано з rf-shell.jsx (StudyEditModal). Тип фіксується кабінетом (МРТ/КТ).
   Сумарна тривалість не може перевищити вільний час до наступного запису —
   зайнятість кабінету беремо через знеособлений RPC room_busy_slots (без PII;
   для направника обходить RLS-сліпоту), p_exclude прибирає сам редагований запис. */

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { CONTRAST_SURCHARGE, BUFFER_DEFAULT, BUFFER_OPTIONS, normBuffer, normDur, DUR_MAX, CONTRAST_DUR, BOOKABLE_MODALITIES, modalityLabel, modalityShort, modalityKind, modalityCode, fmtUah } from "@/lib/studies";
import { buildCatalog, overridesToMap, catalogPriceBreakdown, type ServiceLike, type RoomOverrideRow } from "@/lib/catalog";
import StudySearchBox from "@/components/StudySearchBox";
import type { StudySearchHit } from "@/lib/studySearch";
import { roomScheduleFor, effectiveRoomBreaks, inBreak, offScheduleKind, offReasonText, OFF_SCHED_GRACE_MIN, type DayOverride } from "@/lib/schedule";
import { wallNow, wallMinOfDay, wallDayKey, wallToday0 } from "@/lib/incidents";
import { useRoomBusy, busyAt, busyTooltip } from "@/lib/slotBusy";
import { slotDataTrusted, slotDataFooterText, type SlotDataState } from "@/lib/availabilityTrust";
import { buildSlots } from "@/lib/slots";
import SlotPicker from "@/components/SlotPicker";
import { useModalA11y } from "@/lib/useModalA11y";

const MIN_STUDY = 15;
/* Найкоротший склад, який форма ще ЗБЕРЕЖЕ (мінімум на рядок). Це НЕ MIN_STUDY:
   той відповідає на інше питання — «чи лишилось місце, щоб додати ЩЕ дослідження».
   Константа спільна для `valid` і для поради «скоротіть до N хв» саме тому, що
   з двома різними числами екран казав «вкластися неможливо» там, де сам би
   прийняв склад (ревʼю р1, U-12). */
const MIN_ROW_DUR = 5;

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null };
/* filterOn — стан ЧЕКБОКСА «Контраст» у режимі фільтра. Живе В РЯДКУ, а не в
   мапі по індексу: рядки додають і видаляють, а індекси зсуваються — окрема
   мапа лишала б галочку від видаленого рядка новому (ревʼю, M-A). undefined =
   ще не чіпали, показуємо контрастність самого дослідження. */
type StudyRow = { type: string; region: string; dur: number; contrast: boolean; filterOn?: boolean };
/** Те, що летить у studies (jsonb) — як у BookingModal: з контрастом і ціною. */
type StudyOut = { type: string; region: string; contrast: boolean; dur: number; price: number | null };
type StudyLike = { type?: string; region?: string; dur?: number; contrast?: boolean; price?: number | null };
type StudyPatient = { id: string; room_id: string | null; scheduled_time: string | null; buffer_time_min?: number | null; duration_min?: number | null; patient_name: string | null; studies?: unknown };

interface StudyEditModalProps {
  patient: StudyPatient;
  scheduledDate?: string | null;
  rooms?: RoomOpt[];
  clinicId?: string | null;
  clinicTz?: string | null; // TZ центру запису (мультиклінічний портал направника)
  /** Каталог послуг центру запису (services, 0107). Порожній → статичний фолбэк. */
  services?: ServiceLike[];
  /** Переозначення каталогу по кабінетах (0108): тривалість/ціна/склад беруться
      для кабінету цього запису (patient.room_id) поверх бази центру (фаза 2b). */
  roomOverrides?: RoomOverrideRow[];
  onClose: () => void;
  /* `offSchedule` у meta — ОБОВʼЯЗКОВИЙ: це згода, а не деталь. Батько мусить
     довезти її до сервера (U-12). */
  onConfirm: (arr: StudyOut[], meta: { dur: number; buffer: number; offSchedule: boolean }) => void;
  /* 0077: запис САМ стоїть поза графіком (створений/перенесений за підтвердженням).
     Тоді кінець графіка і перерва його вже не обмежують — інакше легально створений
     запис на 17:55 неможливо було б відредагувати взагалі.

     ⚠️ ОБОВʼЯЗКОВИЙ і БЕЗ дефолта (U-12, с47). Поки проп був необовʼязковим,
     `ReferralPortal` його просто не передавав — і для направника запис, що
     легально стоїть поза графіком, ставав НЕЗБЕРЕЖУВАНИМ назавжди: стеля
     тривалості рахувалась по кінцю графіка, «⚠ Не вміщується» і сіре
     «Зберегти». Рівно той провал, заради якого писалась 0077. Дефолт `= false`
     означав «запис у графіку» — тобто мовчазне ТВЕРДЖЕННЯ на місці незнання. */
  offSchedule: boolean;
  /* Чи МОЖНА цьому користувачу працювати поза графіком. ДЗЕРКАЛО серверного
     правила 0077: `scheduleBlock` має гілку `if (!opts.isStaff) return
     OFF_SCHED_ERR` — підтверджуваний вихід за графік дозволений лише персоналу
     центру. Направник цього не може НІКОЛИ, тож показувати йому галочку
     «Підтверджую роботу поза графіком» (або активне «Зберегти») означає
     обіцяти те, що сервер відхилить.

     Назва СПІЛЬНА з RescheduleModal (`allowOffSchedule`) свідомо: це одне й те
     саме правило на двох сусідніх екранах правки запису, і два імені для нього
     читались би як два різні поняття.

     ⚠️ На відміну від RescheduleModal — обовʼязковий і без дефолта (U-12, с47).
     Там мовчання означає «прав немає» і рятує направника, але мовчки ЗАБИРАЄ
     овертайм у нової дошки персоналу; тут дефолт `true` тихо дав би направнику
     чужі права, дефолт `false` так само тихо забрав би їх у персоналу. Рішення
     пише той, хто знає роль, а `tsc` перелічує місця виклику сам. */
  allowOffSchedule: boolean;
}

function pad(n: number) { return String(n).padStart(2, "0"); }
function toMin(t: string | null | undefined) { const p = String(t || "").split(":"); return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); }
function fmt(m: number) { return pad(Math.floor(m / 60)) + ":" + pad(m % 60); }

export default function StudyEditModal({ patient, scheduledDate, rooms, clinicId, clinicTz, services, roomOverrides, onClose, onConfirm, offSchedule, allowOffSchedule }: StudyEditModalProps) {
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  // Каталог послуг центру (фаза 2a) + переозначення по кабінетах (фаза 2b): виклики
  // резолвера передають кабінет цього запису (roomId) → ціна/тривалість per-room (0108).
  const catalog = useMemo(() => buildCatalog(services, overridesToMap(roomOverrides)), [services, roomOverrides]);
  const roomId = patient.room_id || undefined; // кабінет запису фіксований (не змінюється у формі)
  const regionsFor = catalog.regionsFor;
  const studyDur = catalog.studyDur;
  const studyPrice = catalog.studyPrice;
  const room = (rooms || []).find((r) => r.id === patient.room_id);
  const roomKind = room ? modalityLabel(room.modality) : "МРТ"; // укр. лейбл модальності кабінету
  // Тип дослідження задає кабінет, якщо його модальність відома (МРТ/КТ/УЗД/Рентген/Мамографія).
  const lockType = roomKind !== "Інше";
  const defaultType = lockType ? roomKind : "МРТ";

  const [override, setOverride] = useState<DayOverride | null>(null);
  const [roomSchedule, setRoomSchedule] = useState<unknown>(null); // rooms.schedule кабінету (для перерв/сітки)
  const [schedLoading, setSchedLoading] = useState(true);
  /* U-3/U-4 (с46). PostgREST не кидає — він повертає {data:null, error}. Тут ЖОДНА
     з двох помилок не перевірялась, тож збій читання ставав «особливого дня немає»
     + «графіка кабінету немає», і roomScheduleFor мовчки відкочувався на хардкод
     08–18. Наслідок: дослідження можна було розтягнути ПОЗА реальний графік і
     крізь перерву без жодної згоди, а сітка малювала чужий день. Колишній
     коментар «сітку прикриє busyErr» був фактично хибним: busyErr — інше джерело
     (RPC room_busy_slots), і при цьому збої воно лишається здоровим. */
  const [schedErr, setSchedErr] = useState(false);
  // Графік/оверрайд кабінету на дату (для меж тривалості й сітки слотів). Зайнятість
  // кабінету — окремо через useRoomBusy (realtime), нижче.
  useEffect(() => {
    let cancel = false;
    (async () => {
      // Без кабінету або без дати графіка кабінету не існує — читати нічого (див. schedApplies).
      if (!scheduledDate || !patient.room_id) { if (!cancel) { setSchedLoading(false); setSchedErr(false); } return; }
      setSchedLoading(true);
      try {
        const supabase = createClient();
        if (clinicId) {
          const ov = await supabase.from("schedule_overrides").select("all_closed, label, rooms").eq("clinic_id", clinicId).eq("override_date", scheduledDate).maybeSingle();
          if (ov.error) throw ov.error;   // без оверрайда закритий/скорочений день виглядав би звичайним
          if (!cancel) setOverride((ov.data as unknown as DayOverride) || null);
        }
        const roomRes = await supabase.from("rooms").select("schedule").eq("id", patient.room_id).maybeSingle();
        if (roomRes.error) throw roomRes.error;   // без графіка кабінету межі тихо відкотились би до хардкоду 08–18
        /* Рядка немає — це НЕ «графіка немає». maybeSingle() віддає {data:null,
           error:null}, коли кабінет невидимий за RLS або вже видалений; мовчазний
           відкат на той самий хардкод 08–18 — рівно той дефект, лише без помилки. */
        if (!roomRes.data) throw new Error("room schedule row not readable");
        if (!cancel) setRoomSchedule((roomRes.data as { schedule?: unknown }).schedule ?? null);
        if (!cancel) setSchedErr(false);
      } catch {
        /* Транзієнтний збій (оновлення токена / мережа) — вікно не рушимо, але й
           меж не вигадуємо. Прочитане ОБНУЛЯЄМО: інакше при зміні кабінету/дати
           на екрані лишився б графік ПОПЕРЕДНЬОГО дня і банери говорили б про
           нього як про факт (ревʼю пакета, знахідка 1). */
        if (!cancel) { setOverride(null); setRoomSchedule(null); setSchedErr(true); }
      } finally {
        if (!cancel) setSchedLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [patient.room_id, scheduledDate, clinicId]);

  // Зайнятість кабінету на дату запису (realtime) — сам редагований запис виключаємо
  // (p_exclude), щоб його власне вікно не рахувалося «наступним записом».
  const { spans: roomBusy, loading: busyLoading, error: busyErr } = useRoomBusy({
    roomId: patient.room_id, dateStr: scheduledDate || "", excludeId: patient.id,
  });
  // H-6: поки зайнятість НЕ підтверджена (грузиться/впала), nextStart=null не можна
  // трактувати як «наступних записів немає» (fail-open завищив би доступний час).
  const busyReady = !busyLoading && !busyErr;
  /* Графік кабінету взагалі ЗАСТОСОВНИЙ лише коли є і кабінет, і дата. Без них
     «графіка кабінету» не існує, і брати за межу дефолт 08–18 (як робив цей екран
     для записів без кабінету) — вигадка: запис на 16:00 із 3-годинним переліком
     ставав «⚠ Не вміщується» через кабінет, якого в нього немає. */
  const schedApplies = !!patient.room_id && !!scheduledDate;
  /* Те саме правило, що busyReady (H-6), лише для графіка: поки він не
     ПРОЧИТАНИЙ, брати межі з фолбэка 08–18 — той самий fail-open, іншим джерелом.
     «Не читали» теж означає «не знаємо» — тому schedApplies входить сюди. */
  const schedReady = schedApplies && !schedLoading && !schedErr;
  /* Спільний стан довіри до даних кабінету — те саме правило й ті самі слова, що
     на решті екранів запису (lib/availabilityTrust, пакет U-5/U-6). */
  const availState: SlotDataState = { busyFailed: busyErr, schedFailed: schedErr, loading: busyLoading || schedLoading };
  const availTrusted = slotDataTrusted(availState);
  const availFailed = busyErr || schedErr;
  /* Консервативна стеля на час невідомості — ПОТОЧНА тривалість запису: редагувати
     й скорочувати можна, ЗБІЛЬШИТИ — ні. Одна на обидва джерела, щоб правило не
     розповзлося по файлу двома копіями, які розійдуться.
     Фолбэк саме DUR_MAX, а не Infinity: раніше при duration_min = 0/null стеля
     ставала нескінченною і в UI друкувалося «Доступно у слоті: Infinity хв»
     (у старому коді це маскував завжди скінченний capBySched). */
  const committedDur = patient.duration_min && patient.duration_min > 0 ? patient.duration_min : DUR_MAX;
  // Найближчий СЛІДУЮЧИЙ запис у кабінеті (0074: start_min обрізаний по добі; «хвости»
  // з попередньої доби мають менший старт і сюди не потраплять) — стеля тривалості.
  const nextStart = useMemo(() => {
    const sm = toMin(patient.scheduled_time);
    const arr = roomBusy.map((b) => b.s).filter((m) => m > sm).sort((a, b) => a - b);
    return arr.length ? arr[0] : null;
  }, [roomBusy, patient.scheduled_time]);

  const [buffer, setBuffer] = useState<number>(normBuffer(patient.buffer_time_min ?? BUFFER_DEFAULT));

  const startMin = toMin(patient.scheduled_time);
  // Реальний старт: якщо запис сьогодні і плановий час уже минув (пацієнт
  // запізнюється або вже в кабінеті), фактична зайнятість кабінету рахується
  // від ЗАРАЗ, а не від планового слота. Використовується для м'якого
  // попередження про наїзд на наступний запис (плановий check_no_overlap
  // цього не ловить, бо порівнює планові вікна).
  // «Зараз» у настінному часі клініки (wall-as-UTC мс): і хвилини доби, і дата.
  const _nowW = wallNow(clinicTz || undefined);
  const nowMin = wallMinOfDay(_nowW);
  const todayStr = wallDayKey(clinicTz || undefined);   // «сьогодні» клініки (спільний хелпер)
  const isTodayLate = scheduledDate === todayStr && nowMin > startMin;
  const refStartMin = isTodayLate ? nowMin : startMin;
  // Кінець вікна — за графіком кабінету (з урахуванням особливого графіка),
  // але не далі наступного запису. Буфер займає кабінет ПІСЛЯ досліджень, тож
  // дослідження + буфер не повинні перетнути наступний запис (для графіка —
  // саме дослідження має вміститись, буфер може вийти за межі закриття).
  const dateObj = scheduledDate ? new Date(scheduledDate + "T00:00:00") : wallToday0(clinicTz || undefined);
  const roomSched = roomScheduleFor(dateObj, patient.room_id || "", override, roomSchedule);
  const schedEnd = toMin(roomSched.end);
  /* Стеля за наступним записом. КЛЮЧОВЕ: поки зайнятість не підтверджена
     (busyReady=false: грузиться або впала), НЕ ставимо Infinity — це завищувало б
     доступний час (fail-open). Замість цього консервативна стеля = ПОТОЧНА
     тривалість запису: редагувати/скоротити можна, ЗБІЛЬШИТИ — ні (overflow), поки
     не знаємо про наступний запис. Коли завантажилось — стеля стає справжньою. */
  const capByNext = busyReady
    ? (nextStart != null ? nextStart - startMin - buffer : Infinity)
    : committedDur;
  /* 0077 — ЗАПИС, ЩО ВЖЕ СТОЇТЬ ПОЗА ГРАФІКОМ, теж треба вміти редагувати.
     Без цього запис на 17:55 у кабінеті, що закривається о 18:00, давав
     availableDur = 5 хв → «⚠ Не вміщується» і кнопка «Зберегти» назавжди сіра:
     легально створений запис ставав невиправним. Стеля та сама, що в сітці
     (+OFF_SCHED_GRACE_MIN), а перерва позначений запис уже не обмежує — він і так
     у ній стоїть (тригер 0067 пускає рядки з прапорцем).
     ⚠️ Це НЕ дозвіл тягнути далі: нове перетинання межі вимагає окремої згоди
     (offOk нижче), а сервер усе одно перевірить scheduleBlock.
     schedReady — та сама логіка, що busyReady, лише для графіка: поки він не
     підтверджений, schedEnd — це хардкод 08–18, а не межа ЦЬОГО кабінету, і брати
     її за стелю означало б дозволити тягнути дослідження за реальне закриття. */
  const capBySched = !schedApplies
    ? DUR_MAX                                    // немає кабінету/дати — графік не обмежує (але стеля продукту лишається)
    : schedReady
      ? (offSchedule ? schedEnd + OFF_SCHED_GRACE_MIN : schedEnd) - startMin
      : committedDur;
  // Перерва кабінету після старту теж обмежує тривалість — дослідження не може її перетнути.
  const roomBreaks = effectiveRoomBreaks(dateObj, patient.room_id || "", roomSchedule, override);
  const nextBreakStart = roomBreaks.map((b) => toMin(b.start)).filter((m) => m > startMin).sort((a, b) => a - b)[0];
  const capByBreakRaw = nextBreakStart != null ? nextBreakStart - startMin : Infinity;
  /* Перерви — з ТОГО САМОГО (невідомого при schedErr) графіка: порожній список
     перерв при збої означав би «перерв немає», а не «ми їх не знаємо». */
  const capByBreak = (offSchedule || !schedApplies) ? Infinity : (schedReady ? capByBreakRaw : committedDur);
  const availableDur = Math.max(0, Math.min(capByNext, capBySched, capByBreak));
  // Межа, за якою потрібне НОВЕ підтвердження (кінець графіка / початок перерви).
  const capBySchedStrict = !schedApplies ? DUR_MAX : (schedReady ? schedEnd - startMin : committedDur);
  const capByBreakStrict = !schedApplies ? Infinity : (schedReady ? capByBreakRaw : committedDur);
  const inSchedCap = Math.max(0, Math.min(capByNext, capBySchedStrict, capByBreakStrict));
  /* Підпис межі. Два споживачі — і межі в них РІЗНІ (availableDur та inSchedCap),
     тож підпис теж окремий: інакше банер «поза графіком» показував би реальний
     час 18:00 поруч зі словами «дані не підтверджені» (ревʼю пакета, знахідка 6).
     Правило: називаємо межу лише тоді, коли її дало ПРОЧИТАНЕ джерело; якщо
     тримає консервативна стеля невідомості — так і кажемо. */
  const boundaryLabel = (capByBreak <= capByNext && capByBreak <= capBySched && nextBreakStart != null)
    ? ("до перерви о " + fmt(nextBreakStart))
    : (nextStart != null && (nextStart - buffer) <= schedEnd)
      ? ("до наступного запису о " + fmt(nextStart) + (buffer > 0 ? ` − ${buffer} буфер` : ""))
      : (schedApplies ? ("до кінця графіка (" + fmt(schedEnd) + ")") : "кабінет або дату не призначено");
  const untrustedLabel = "поточна тривалість запису — дані кабінету не підтверджені";
  const labelFor = (cap: number) => (!availTrusted && cap === committedDur ? untrustedLabel : boundaryLabel);
  const windowLabel = labelFor(availableDur);

  // Тривалість за довідником (у каталозі — час позиції як є; CONTRAST_DUR
  // додається лише в легасі-статиці — див. lib/catalog.studyDur).
  function recalc(type: string, region: string, contrast: boolean, prevDur?: number): number {
    if (!region) return 0; // область не обрана → 0: не додаємо час, поки не вибрано
    const ro = regionsFor(type, roomId).find((r) => r.label === region);
    return ro ? studyDur(type, region, contrast, roomId) : (prevDur || 0); // легасі-область поза каталогом → зберегти наявну тривалість
  }
  function seed(): StudyRow[] {
    const base: StudyLike[] = Array.isArray(patient.studies) && patient.studies.length
      ? (patient.studies as StudyLike[])
      : [{ type: defaultType, region: "", dur: 0 }]; // порожня стартова строка — 0 хв, поки не обрано область
    return base.map((s) => {
      const t = lockType ? roomKind : (s.type || "МРТ");
      const keepRegion = !lockType || !s.type || s.type === roomKind;
      const region = keepRegion ? (s.region || "") : "";
      const contrast = keepRegion ? !!s.contrast : false; // ЗБЕРІГАЄМО наявний контраст
      return { type: t, region, contrast, dur: region ? (s.dur || recalc(t, region, contrast)) : recalc(t, "", contrast) };
    });
  }
  const [rows, setRows] = useState<StudyRow[]>(seed);
  /* Знімок складу НА ВІДКРИТТІ: "type|region" → позиція. Потрібен для
     гранфазерингу ціни (див. save) — рахується один раз, бо patient.studies
     під час редагування не змінюється. */
  const origStudies = useMemo(() => {
    const m = new Map<string, StudyLike>();
    const src = Array.isArray(patient.studies) ? (patient.studies as StudyLike[]) : [];
    for (const s of src) if (s?.type && s?.region) m.set(s.type + "|" + s.region + "|" + (s.contrast ? "c" : ""), s);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- знімок на відкриття
  }, []);
  /* Видимий стан чекбокса: у режимі фільтра — власний прапорець рядка, інакше
     контрастність самого дослідження. */
  const rowContrastChecked = (r: StudyRow) =>
    catalog.contrastIsFilter(r.type, roomId) ? (r.filterOn ?? r.contrast) : r.contrast;

  function patch(i: number, p: Partial<StudyRow>) { setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...p } : r))); }
  function setType(i: number, type: string) { if (lockType) return; patch(i, { type, region: "", contrast: false, filterOn: false, dur: recalc(type, "", false) }); }
  function setRegion(i: number, region: string) {
    const r = rows[i];
    /* У режимі фільтра контрастність — властивість обраної позиції прайсу
       (з неї сервер рахує has_contrast), а не стан чекбокса. */
    const contrast = catalog.contrastIsFilter(r.type, roomId)
      ? (catalog.regionInfo(r.type, region, roomId)?.isContrast === true)
      : r.contrast;
    patch(i, { region, contrast, dur: recalc(r.type, region, contrast, r.dur) });
  }
  /* Контраст. У КАТАЛОЗІ це фільтр списку послуг рядка: час не чіпаємо (він
     прийде з обраної позиції), а якщо поточна область фільтр не переживає —
     скидаємо її. У легасі-статиці лишається модифікатор ±CONTRAST_DUR. */
  function setContrast(i: number, contrast: boolean) {
    const r = rows[i];
    /* Гард — по ВИДИМОМУ стану чекбокса, а не по r.contrast: у режимі фільтра ці
       значення навмисне розходяться, і порівняння з r.contrast залишало галочку
       залиплою (ревʼю, H-A). */
    if (rowContrastChecked(r) === contrast) return;
    if (catalog.contrastIsFilter(r.type, roomId)) {
      /* Режим фільтра: чекбокс керує лише СПИСКОМ. Сам прапорець дослідження —
         властивість обраної позиції прайсу, тож знята галочка НЕ робить
         контрастне дослідження неконтрастним (інакше has_contrast=false на
         в/в контрастуванні: кабінет не готує розхідники й не перевіряє алергію).
         Щоб прибрати контраст — треба обрати іншу позицію; якщо поточна не
         переживає новий фільтр, скидаємо її разом із часом. */
      const survives = !r.region
        || catalog.regionsWithContrast(r.type, roomId, contrast).some((x) => x.label === r.region);
      patch(i, survives ? { filterOn: contrast } : { filterOn: contrast, region: "", contrast: false, dur: 0 });
      return;
    }
    const delta = contrast ? CONTRAST_DUR : -CONTRAST_DUR;
    patch(i, { contrast, filterOn: contrast, dur: Math.max(5, (Number(r.dur) || 0) + delta) });
  }
  // H-1: кратно 5, 5..480 — те саме обмеження, що CHECK у БД (0066).
  // 0117: порожнє поле → 0 (БЕЗ normDur-фолбеку 30) — збереження блокує valid.
  // ⚠️ Нормалізуємо на BLUR, а не на кожне натискання: normDur на keystroke
  // зʼїдав першу цифру («4» → 5, «8» → 10 — набрати «45» було неможливо;
  // баг власника, с33). Під час набору приймаємо сире число (лише стеля
  // DUR_MAX), а кратність 5 і мінімум 5 наводимо, коли поле покидають, і ще
  // раз у studiesOut — клік по «Зберегти» самим blur-ом уже нормалізує.
  function setDur(i: number, v: string) { const n = parseInt(v, 10) || 0; patch(i, { dur: Math.max(0, Math.min(DUR_MAX, n)) }); }
  function blurDur(i: number) { const n = Number(rows[i]?.dur) || 0; patch(i, { dur: n > 0 ? normDur(n) : 0 }); }
  function addRow() { setRows((rs) => [...rs, { type: defaultType, region: "", contrast: false, dur: recalc(defaultType, "", false) }]); }
  function removeRow(i: number) { setRows((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs)); }

  // Рахуємо ЛИШЕ дослідження з обраною областю — порожній рядок не додає час
  // у «Разом» і в блок сітки, поки область не вибрано.
  const totalDur = rows.reduce((s, r) => s + (r.region ? (Number(r.dur) || 0) : 0), 0);
  const overflow = totalDur > availableDur;
  const remaining = availableDur - totalDur;
  // М'яке попередження (НЕ блокує збереження): за фактом старту дослідження+буфер
  // закінчаться пізніше наступного запису кабінету.
  const projectedEndMin = refStartMin + totalDur + buffer;
  const realClash = isTodayLate && nextStart != null && projectedEndMin > nextStart;
  const canAdd = remaining >= MIN_STUDY;
  /* 0077: тривалість перетнула межу графіка/перерви — потрібна ОКРЕМА згода.
     Без цього збережений колись прапорець працював би як «вічний дозвіл»: запис,
     підтверджений на 5 хв понаднормово, мовчки розтягнули б ще на дві години. */
  const [offOk, setOffOk] = useState(false);
  const crossesNow = totalDur > inSchedCap;
  const needsOffConfirm = crossesNow && !overflow && allowOffSchedule;
  /* U-12: ДЗЕРКАЛО серверного гейта 0077 (`scheduleBlock`: `if (!opts.isStaff)
     return OFF_SCHED_ERR`). Рахуємо з ЖИВОГО графіка, а не з прапорця запису:
     графік могли звузити ВЖЕ ПІСЛЯ броні, і тоді запис із `off_schedule=false`
     теж не збережеться. Поки графік не прочитаний (`schedReady=false`) —
     не стверджуємо нічого: стелю там і так тримає `committedDur`. */
  /* `scheduled_time` — теж УМОВА гейта на сервері (`cur.scheduled_time` у списку
     разом із room_id/clinic_id/date). Без нього `startMin` = 0 і offScheduleKind
     чесно каже `before_start` — але сервер для такого запису гейт не запускає
     ВЗАГАЛІ, тож заборона була б вигаданою (ревʼю р1). Колонка nullable. */
  const offNow = schedReady && !!patient.scheduled_time
    ? offScheduleKind(startMin, totalDur, roomSched, roomBreaks) : null;
  const offForbiddenForRole = !allowOffSchedule && !!offNow;
  /* Чи врятує СКОРОЧЕННЯ складу. Свідомо не міркуємо, яка зі стель зараз вʼяже:
     `capByBreakStrict` бачить лише перерву ПІСЛЯ старту, тож запис, що сам стоїть
     УСЕРЕДИНІ перерви (поставлений персоналом за підтвердженням або накритий
     перервою, доданою вже після броні), від скорочення поза графіком не вийде —
     і порада «скоротіть до N хв» була б брехнею. Тому питаємо ту саму функцію,
     що й сервер: чи буде запис на inSchedCap хвилин усе ще поза графіком.
     null → скорочення справді допомагає.

     Поріг — MIN_ROW_DUR, той самий, що у `valid`, а НЕ MIN_STUDY (15): MIN_STUDY —
     це «чи є сенс додавати ЩЕ рядок», а тут питання інше — чи можна вкластися
     хоч якимось складом. З порогом 15 екран казав «лише центр» там, де сам би
     прийняв 10-хвилинний склад (ревʼю р1).
     `busyReady` — бо inSchedCap включає стелю за наступним записом: поки
     зайнятість не прочитана, вона дорівнює поточній тривалості, і число в
     пораді через секунду мінялося б саме на очах. */
  const fitsIfShorter = offForbiddenForRole && schedReady && busyReady && inSchedCap >= MIN_ROW_DUR
    && !offScheduleKind(startMin, inSchedCap, roomSched, roomBreaks);
  // 0117 (ревью M2): рядок з областю, але без часу (каталожне «—») — не зберігаємо,
  // інакше в снімок їхав dur 0, а колери мовчки лишали стару тривалість.
  const valid = rows.length > 0 && rows.every((r) => r.region && (Number(r.dur) || 0) >= MIN_ROW_DUR) && !overflow && (!needsOffConfirm || offOk) && !offForbiddenForRole;

  // ── Сітка слотів (read-only візуалізація дня кабінету) ──────────────────────
  // Показуємо зайнятість кабінету і власне вікно запису (green межі + буфер) —
  // при додаванні/видаленні досліджень блок росте/меншає в реальному часі, і
  // видно, чи не наїжджає на сусідні записи. Клік нічого не змінює (freeStates=[])
  // — перенесення слота робиться окремо («Перенести»).
  const schedStartMin = toMin(roomSched.start);
  const isPastDay = !!scheduledDate && !!todayStr && scheduledDate < todayStr;
  const showGrid = !!patient.room_id && !!scheduledDate;
  const gridSlots = showGrid && !roomSched.closed ? buildSlots(schedStartMin, schedEnd + OFF_SCHED_GRACE_MIN) : [];
  function slotState(slot: string): string {
    const s = toMin(slot), eBlock = s + totalDur + buffer;
    if (isPastDay) return "past";
    if (roomSched.closed) return "closed";
    if (scheduledDate === todayStr && s < nowMin) return "past";
    if (roomBusy.some((b) => s >= b.s && s < b.eStudy)) return "busy";
    if (roomBusy.some((b) => s >= b.eStudy && s < b.e)) return "buffer";
    if (roomBusy.some((b) => s < b.e && b.s < eBlock)) return "tight";
    const off = offScheduleKind(s, totalDur, roomSched, roomBreaks);
    if (off) return off.confirmable ? "offsched" : "offhours";
    return "free";
  }
  function slotTitle(slot: string, st: string): string {
    if (st === "busy" || st === "buffer") { const b = busyAt(roomBusy, toMin(slot)); return b ? (toMin(slot) >= b.eStudy ? "Буфер після дослідження\n" : "") + busyTooltip(b) : "Зайнято"; }
    if (st === "break") { const br = inBreak(toMin(slot), roomBreaks); return br ? `Перерва · ${br.start}–${br.end}` : "Перерва"; }
    return "";
  }

  /* Повний склад із цінами — ЄДИНА точка і для save(), і для «Орієнтовної
     вартості» внизу (пакет «пошук/ціна у формах»): показувати одну суму, а
     зберігати іншу — прямий шлях до тихого розходження.

     ГРАНФАЗЕРИНГ (ревʼю, M3): у рядка, який оператор НЕ чіпав (той самий
     type|region, що й у знімку запису), лишаємо ЗБЕРЕЖЕНУ ціну. Інакше запис,
     створений за старим правилом (2400 + 900 доплати), після будь-якої правки
     буфера мовчки дешевшав би до 2400 — історія доходу переписувалась би
     заднім числом. Нову/змінену позицію рахуємо за поточним каталогом.
     Ключ включає контраст: у модифікаторному режимі перемикання галочки
     змінює ціну (±доплата), і без цього снапшот повертав би стару (ревʼю, M-B). */
  const studiesOut: StudyOut[] = rows.filter((r) => r.region).map((r) => {
    const snap = origStudies.get(r.type + "|" + r.region + "|" + (r.contrast ? "c" : ""));
    const price = snap && typeof snap.price === "number"
      ? snap.price
      : studyPrice(r.type, r.region, r.contrast, roomId);
    const rawDur = Number(r.dur) || 0;
    return {
      type: r.type,
      region: r.region,
      contrast: r.contrast,
      // Страховка інваріанта «кратно 5»: він раніше тримався на setDur, який
      // тепер нормалізує лише на blur.
      dur: rawDur > 0 ? normDur(rawDur) : 0,
      price,
    };
  });

  /* Пошук дослідження за назвою: кабінет і центр запису фіксовані, тож видача —
     лише база центру + власні послуги ЦЬОГО кабінета, і лише модальність
     кабінета (lockType). Вибір заповнює перший порожній рядок або додає новий. */
  const searchMods = lockType ? [modalityCode(roomKind)] : undefined;
  const studySearchAllow = (h: StudySearchHit) => h.roomId == null || h.roomId === (patient.room_id || null);
  function pickStudy(h: StudySearchHit) {
    const t = modalityLabel(h.type);
    const contrastVal = catalog.contrastIsFilter(t, roomId)
      ? (catalog.regionInfo(t, h.label, roomId)?.isContrast === true)
      : false;
    const row: StudyRow = { type: t, region: h.label, contrast: contrastVal, dur: recalc(t, h.label, contrastVal) };
    setRows((rs) => {
      const idx = rs.findIndex((r) => !r.region);
      return idx >= 0 ? rs.map((r, i) => (i === idx ? row : r)) : [...rs, row];
    });
  }

  function save() {
    /* Пишемо повний склад (як BookingModal): контраст + ціна — has_contrast на
       сервері рахується саме зі studies. Склад і ціни — див. studiesOut вище. */
    const arr: StudyOut[] = studiesOut;
    /* offSchedule: або запис і був поза графіком (успадкований прапорець), або
       оператор щойно підтвердив нове перетинання межі. Сервер однаково перерахує
       факт сам (scheduleBlock) — сюди їде саме ЗГОДА, а не «стан слота». */
    onConfirm(arr, { dur: totalDur, buffer, offSchedule: offSchedule || (needsOffConfirm && offOk) });
  }

  return (
    <div className="overlay">
      <div className="dialog fade-in bk-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Редагування дослідження">
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--blue-bg)", color: "var(--blue-text)" }}>🩻</span>Дослідження пацієнта</div>
          <button className="icon-btn" onClick={onClose} aria-label="Закрити">✕</button>
        </div>
        <div className="bk-grid">
        <div className="bk-col bk-col-left" style={{ gap: 11 }}>
          <div className="ctx-hint blue" style={{ fontSize: "0.8125rem" }}>Пацієнт: <b>{patient.patient_name}</b> · слот {scheduledDate ? <><b>{scheduledDate.split("-").reverse().join(".")}</b> о </> : "о "}<b>{patient.scheduled_time}</b>{room ? <> · {room.name}{lockType ? <> · <b>{roomKind}</b></> : null}</> : null}. {lockType ? <>Усі дослідження слота — лише <b>{roomKind}</b>.</> : null}</div>
          {/* U-12 (ревʼю р1): при рольовій забороні «Доступно у слоті» називало
              РОЗШИРЕНУ стелю (графік + 2 год grace, перерва не обмежує) — і поруч
              із банером відмови на одному екрані стояло три різні числа: скільки
              «доступно», скільки введено, скільки насправді збережеться. Коли
              зберегти поза графіком не можна, чесна межа одна — та, що в графіку. */}
          <div className={"ctx-hint " + (overflow || offForbiddenForRole ? "red" : "blue")} style={{ fontSize: "0.78125rem" }}>
            {overflow
              ? <>⚠ Не вміщується: разом <b>{totalDur} хв</b>, доступно <b>{availableDur} хв</b> ({windowLabel}). Скоротіть на {totalDur - availableDur} хв.</>
              : offForbiddenForRole
              ? <>Разом <b>{totalDur} хв</b>. У графік кабінету вміщується <b>{inSchedCap} хв</b>.</>
              : <>Доступно у слоті: <b>{availableDur} хв</b> ({windowLabel}). Вільно ще <b>{remaining} хв</b>.</>}
          </div>
          {/* Поки дані кабінету не підтверджені — не даємо збільшувати тривалість
              (fail-closed). При помилці читання це не транзієнт «пусто», а невідомий
              стан. Джерел два (зайнятість і графік) і називає їх спільний хелпер —
              інакше додане джерело знову залишиться без свого рядка в банері. */}
          {!availTrusted && (
            <div className={"ctx-hint " + (availFailed ? "orange" : "blue")} style={{ fontSize: "0.75rem" }}>
              {availFailed
                ? <>⚠ {slotDataFooterText(availState)} — збільшувати тривалість поки не можна. Закрийте й відкрийте вікно, щоб спробувати ще раз.</>
                : <>{slotDataFooterText(availState)}</>}
            </div>
          )}
          {!overflow && realClash && (
            <div className="ctx-hint red" style={{ fontSize: "0.78125rem" }}>
              ⚠ Пацієнт запізнюється/у кабінеті: за фактом (з ~<b>{fmt(refStartMin)}</b>) дослідження + буфер закінчаться о ~<b>{fmt(projectedEndMin)}</b> і перекриють наступний запис о <b>{fmt(nextStart ?? 0)}</b>. Зберегти можна, але перенесіть наступний запис.
            </div>
          )}
          {/* 0077 — тривалість вивела дослідження за графік / у перерву: окрема згода.
              Успадкований прапорець запису тут НЕ рахується за підтвердження — інакше
              одна давня згода дозволяла б тягнути дослідження скільки завгодно. */}
          {needsOffConfirm && (
            <div className="info-banner offsched" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
              <span className="ib-txt">
                <b>⏰ Поза графіком.</b> Разом <b>{totalDur} хв</b> — дослідження вийде за межу
                (<b>{fmt(startMin + inSchedCap)}</b>: {labelFor(inSchedCap)}). Кабінет працюватиме понаднормово.
              </span>
              <label className="fld-lab" style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={offOk} onChange={(e) => setOffOk(e.target.checked)} />
                Підтверджую роботу поза графіком
              </label>
            </div>
          )}
          {/* U-12: ЧЕСНА ВІДМОВА замість мовчазної сірої кнопки. Серверне правило
              0077 лишається (`scheduleBlock`: `if (!opts.isStaff) return
              OFF_SCHED_ERR` — понаднормово підтверджує лише персонал центру), але
              направник більше не гадає, ЧОМУ «Зберегти» неактивне: до U-12 він бачив
              лише «⚠ Не вміщується» і думав, що річ у довжині, а не в ролі.
              Взаємно виключний з блоком вище: той вимагає allowOffSchedule, цей — !allowOffSchedule. */}
          {offForbiddenForRole && offNow && (
            <div className="info-banner offsched" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
              {/* Дві РІЗНІ відмови, і плутати їх не можна (ревʼю р1): підтверджуваний
                  вихід за графік (after_end / перерва) центр справді може погодити —
                  а `closed` / `before_start` / `too_late` сервер відхиляє гілкою
                  `!info.confirmable` РАНІШЕ за перевірку ролі, тобто НІКОМУ. Слати
                  людину до центру по те, чого центр теж не може, — та сама брехня,
                  лише ввічлива: вона коштує дзвінка й повертає пацієнта ні з чим. */}
              <span className="ib-txt">
                <b>⏰ Поза графіком кабінету.</b> Разом <b>{totalDur} хв</b> — {offReasonText(offNow)}.
                {offNow.confirmable
                  ? <> Роботу поза графіком підтверджує лише центр, тож зберегти такий склад звідси не вийде.</>
                  : <> Такий час не може погодити ніхто — ні ви, ні центр.</>}
              </span>
              <span className="ib-txt">
                {fitsIfShorter
                  ? <>Щоб зберегти зараз — скоротіть склад до <b>{inSchedCap} хв</b>.{offNow.confirmable ? <> Якщо потрібно довше — зверніться до центру.</> : null}</>
                  : offNow.confirmable
                  ? <>Змінити склад цього запису може лише центр — зверніться до адміністратора.</>
                  : <>Запис треба перенести на робочий час кабінету — «🗓 Перезаписати» на дошці або зверніться до центру.</>}
              </span>
            </div>
          )}
          <div className="fld" style={{ marginBottom: 8 }}>
            <StudySearchBox
              sources={[{ clinicId: clinicId || "", services }]}
              roomNameOf={(id) => (rooms || []).find((r) => r.id === id)?.name}
              modalities={searchMods}
              allow={studySearchAllow}
              onPick={pickStudy}
              placeholder="Пошук дослідження за назвою — заповнить рядок…"
            />
          </div>
          <div className="st-rows">
            {rows.map((r, i) => {
              const regions = catalog.regionsWithContrast(r.type, roomId, rowContrastChecked(r));
              const hasRegion = !r.region || regions.some((x) => x.label === r.region);
              return (
                <div className="st-row" key={i}>
                  <div className="st-row-head">
                    <span className="st-row-n">Дослідження {i + 1}</span>
                    {rows.length > 1 && <button className="st-row-del" title="Прибрати" onClick={() => removeRow(i)}>✕</button>}
                  </div>
                  <div className="st-row-body">
                    <div className="st-field st-field-type">
                      <span className="st-flab">Тип</span>
                      {lockType ? (
                        <div className="bk-seg st-seg st-seg-locked" title="Тип апарата задає кабінет">
                          <button className={"bk-seg-btn active " + modalityKind(roomKind)} disabled>{modalityShort(roomKind)} 🔒</button>
                        </div>
                      ) : (
                        <div className="bk-seg st-seg" style={{ flexWrap: "wrap" }}>
                          {BOOKABLE_MODALITIES.map((code) => (
                            <button key={code} className={"bk-seg-btn" + (r.type === modalityLabel(code) ? " active " + modalityKind(code) : "")} onClick={() => setType(i, modalityLabel(code))} title={modalityLabel(code)}>{modalityShort(code)}</button>
                          ))}
                        </div>
                      )}
                    </div>
                    <label className="st-field st-field-region">
                      <span className="st-flab">Область дослідження</span>
                      <select className="inp" value={hasRegion ? r.region : ""} onChange={(e) => setRegion(i, e.target.value)}>
                        <option value="">— Оберіть область —</option>
                        {!hasRegion && r.region && <option value={r.region}>{r.region} (поточне)</option>}
                        {regions.map((x) => {
                          /* У модифікаторному режимі (легасі-статика) ціна й ЧАС
                             з увімкненим контрастом = позиція + доплата/+хв — як
                             у формах створення (ревʼю пакета, m-3; час — р.2 m-3:
                             ціну з доплатою показували, а час без — вибір ставив
                             30 хв там, де option обіцяв 15). У каталозі обидва
                             бампи = 0: контрастна позиція вже все містить. */
                          const mod = rowContrastChecked(r) && !catalog.contrastIsFilter(r.type, roomId);
                          const pBump = mod ? (x.contrastPrice ?? CONTRAST_SURCHARGE) : 0;
                          const dBump = mod ? CONTRAST_DUR : 0;
                          return <option key={x.label} value={x.label}>{x.label} · {x.dur == null ? "—" : (x.dur + dBump) + " хв"}{x.price > 0 ? " · " + fmtUah(x.price + pBump) : ""}</option>;
                        })}
                      </select>
                    </label>
                    <div className="st-field st-field-contrast">
                      <span className="st-flab">Контраст</span>
                      <label className={"rf-check" + (rowContrastChecked(r) ? " on" : "")}
                        title={catalog.contrastIsFilter(r.type, roomId)
                          ? "Показати лише послуги з контрастуванням"
                          : `Контраст: +${CONTRAST_DUR} хв до тривалості та доплата`}>
                        {/* ⚠️ Тексту всередині чекбокса НЕМАЄ (рішення власника, с47).
                            Це СКАСОВУЄ рішення с28 («з контрастом», а не «Контраст»):
                            підпис поля над чекбоксом уже «Контраст», і прийменник читався
                            як друга назва того самого. Семантику режиму (фільтр списку vs
                            модифікатор із доплатою) несуть `title` і самі опції списку,
                            де в легасі показані і +15 хв, і доплата. */}
                        <input type="checkbox" checked={rowContrastChecked(r)} onChange={(e) => setContrast(i, e.target.checked)}
                          aria-label={(catalog.contrastIsFilter(r.type, roomId)
                            ? "Контраст: показати лише послуги з контрастуванням"
                            : `Контраст: +${CONTRAST_DUR} хв до тривалості та доплата`) + ` — дослідження ${i + 1}${r.region ? ": " + r.region : ""}`} />
                        <span className="rf-box" />
                      </label>
                    </div>
                    <label className="st-field st-field-dur">
                      <span className="st-flab">Тривалість</span>
                      <div className="st-dur"><input className="inp" type="number" min="5" step="5" value={r.region ? (r.dur || "") : ""} placeholder="—" disabled={!r.region} title={r.region ? "" : "Спершу оберіть область"} onChange={(e) => setDur(i, e.target.value)} onBlur={() => blurDur(i)} /><span className="st-dur-u">хв</span></div>
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
          <button className="btn btn-secondary btn-sm" style={{ marginTop: 10 }} disabled={!canAdd} onClick={addRow}
            title={canAdd ? "" : "Немає вільного часу у слоті"}>＋ Додати дослідження</button>
        </div>
        {/* Права колонка — сітка слотів дня кабінету (read-only, realtime). */}
        <div className="bk-col bk-col-right">
          <div className="bk-sched-head" style={{ marginBottom: 6 }}>
            <span style={{ fontWeight: 600, fontSize: "0.8125rem" }}>Розклад кабінету</span>
            {room && <span className={"bk-sched-mod " + modalityKind(room.modality)}>{roomKind}</span>}
            <span style={{ marginLeft: "auto", fontSize: "0.6875rem", color: "var(--green)" }} title="Оновлюється в реальному часі">● наживо</span>
          </div>
          {!showGrid
            ? <div className="ctx-hint" style={{ fontSize: "0.78125rem" }}>Слот запису не визначено — сітку показати нема для чого.</div>
            : availFailed
            ? <div className="ctx-hint red" style={{ fontSize: "0.78125rem" }}>⚠ {slotDataFooterText(availState)} — оновіть вікно.</div>
            : !availTrusted
            ? <div className="ctx-hint" style={{ fontSize: "0.8125rem", padding: "20px 0", textAlign: "center", color: "var(--text-muted)" }}>⏳ Завантаження зайнятості…</div>
            /* «Кабінет не працює» — теж ТВЕРДЖЕННЯ про графік, тож стоїть ПІСЛЯ
               перевірки довіри: при schedErr ми не знаємо ні що він працює, ні що ні. */
            : roomSched.closed
            ? <div className="ctx-hint" style={{ fontSize: "0.78125rem" }}>Кабінет у цей день не працює.</div>
            : (
              <>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: 4 }}>
                  Слот запису — <b style={{ color: "var(--green)" }}>зелена рамка</b>; блок росте/меншає з тривалістю досліджень.
                </div>
                <SlotPicker
                  slots={gridSlots}
                  value={patient.scheduled_time || ""}
                  onChange={() => { /* read-only: перенесення слота — окремою дією «Перенести» */ }}
                  spanMin={totalDur}
                  bufferMin={buffer}
                  stateOf={slotState}
                  freeStates={[]}
                  titleOf={slotTitle}
                />
                <div className="bk-slot-legend">
                  <span><span className="lg-dot busy" />зайнято</span>
                  <span><span className="lg-dot busybuf" />буфер</span>
                  {buffer > 0 && <span><span className="lg-dot planbuf" />буфер цього запису</span>}
                  {roomBreaks.length > 0 && <span><span className="lg-dot brk" />перерва</span>}
                  {overflow && <span><span className="lg-dot tight" />не вміщується</span>}
                </div>
              </>
            )}
        </div>
        </div>{/* /bk-grid */}
        <div className="dlg-foot">
          <label className="st-total" style={{ display: "flex", alignItems: "center", gap: 6 }} title="Буфер після дослідження (переукладка/дезінфекція)">
            Буфер:
            <select className="inp" style={{ width: 74, padding: "2px 6px" }} value={buffer} onChange={(e) => setBuffer(normBuffer(Number(e.target.value)))}>
              {BUFFER_OPTIONS.map((b) => <option key={b} value={b}>{b} хв</option>)}
            </select>
          </label>
          <span className="st-total">Разом: <b>{totalDur} хв</b>{buffer > 0 ? <> + {buffer} буфер</> : null} · {rows.length} {rows.length === 1 ? "дослідження" : "досл."}{(() => {
            const pb = catalogPriceBreakdown(catalog, studiesOut, roomId);
            return pb.priced > 0 ? <> · <b>{fmtUah(pb.total)}</b>{pb.unpriced > 0 ? ` (ще ${pb.unpriced} без ціни)` : ""}</> : null;
          })()}</span>
          <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
          <button className="btn btn-primary" disabled={!valid} onClick={save}>✓ Зберегти дослідження</button>
        </div>
      </div>
    </div>
  );
}
