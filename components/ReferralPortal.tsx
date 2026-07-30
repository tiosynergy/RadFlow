"use client";

/* ===== RadFlow — Referral Portal 2.0 (крос-клінічний портал направників) =====
   Глобальний направник працює з кількома центрами через referral_access.
   Вкладки: «Нове направлення», «Мої направлення», «Мої центри».
   Зайнятість слотів — через знеособлений RPC room_busy_slots (без PII). */

import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react";
import { bookableRooms, visibleRooms, residualSet, roomOffLabel } from "@/lib/rooms";
import Toast from "@/components/Toast";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import { useQueueSounds } from "@/lib/useQueueSounds";
import { REFERRER_CRITICAL_STATUSES } from "@/lib/soundEvents";
import LiveClock from "@/components/LiveClock";
import CeoDashboardLink from "@/components/CeoDashboardLink";
import PatientEditModal from "@/components/PatientEditModal";
import PhoneInput from "@/components/PhoneInput";
import CitySelect from "@/components/CitySelect";
import RescheduleModal, { type RescheduleStudy } from "@/components/RescheduleModal";
import ReferrerBoard from "@/components/ReferrerBoard";
import ReferrerSidebar from "@/components/ReferrerSidebar";
import { createReferralBooking, rescheduleQueueEntry, cancelQueueEntry, editQueueEntryStudies, createReferralCase, referralCaseFromEntry, type CaseStepInput } from "@/app/queue/actions";
import CaseModal from "@/components/CaseModal";
import BookingModal, { type BookingPayload } from "@/components/BookingModal";
import StudyEditModal from "@/components/StudyEditModal";
import WaitlistModal, { type WaitlistFormOut } from "@/components/WaitlistModal";
import ConfirmDialog from "@/components/ConfirmDialog";
import { addWaitlistEntry, setWaitlistStatus, setWaitlistPriority, updateWaitlistEntry } from "@/app/waitlist/actions";
import { WAITLIST_STATUS_META, desiredWindowText, compareWaitlist } from "@/lib/waitlist";
import type { WaitlistEntry } from "@/supabase/types";
import { roomScheduleFor, effectiveRoomBreaks, inBreak, breakClash, type DayOverride } from "@/lib/schedule";
import { buildSlots, countFit } from "@/lib/slots";
import SlotPicker from "@/components/SlotPicker";
import { slotBlockedByIncidents, wallNow, wallMinOfDay, wallDayKey, wallToday0, type IncidentLike } from "@/lib/incidents";
import { CONTRAST_DUR, CONTRAST_SURCHARGE, BUFFER_DEFAULT, BUFFER_OPTIONS, BOOKABLE_MODALITIES, modalityLabel, modalityShort, modalityKind, modalityCode } from "@/lib/studies";
import { buildCatalog, overridesToMap, type ServiceLike, type RoomOverrideRow } from "@/lib/catalog";
import { PRIORITY_OPTIONS, PRIORITY_META, type PatientPriority } from "@/lib/priority";
import { DobField, BookingCalendar, fmtShort } from "@/components/BookingModal";
import RoomSelect, { ROOM_LIST_MAX_CHIPS } from "@/components/RoomSelect";
import type { Json } from "@/supabase/types";
import "@/styles/prototype/radflow.css";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null; active?: boolean | null };
type Center = { clinicId: string; name: string; city: string | null; status: string; policy?: string | null; room_ids?: string[] | null; accessId?: string | null; timezone?: string | null };
type Referral = {
  id: string; clinic_id: string; created_by: string | null; referrer_id: string | null; patient_name: string | null; patient_phone: string | null; patient_age: number | null;
  scheduled_date: string | null; scheduled_time: string | null; duration_min: number | null; buffer_time_min: number | null; status: string; call_status: string | null;
  priority_level: PatientPriority | null; studies: Json; studies_original: Json | null; studies_changed_by: string | null; contraindications: boolean; doctor: string | null; note: string | null; indication: string | null; room_id: string | null; reschedule_origin: Json | null;
  case_id: string | null; case_step: number | null;   // 0118: кейси направника
};
type StudyOut = { type: string; region: string; contrast?: boolean; dur: number; price: number | null };
type ExtraStudy = { type: string; region: string; dur: number };
/* 0118: накопичений крок майбутнього кейса (пакетний режим «＋ У кейс»). */
type CaseDraftStep = { roomId: string; roomName: string; modality: string; date: string; time: string; dur: number; buffer: number; studies: StudyOut[]; hasContra: boolean };
/* 0074: RPC віддає вікно, ОБРІЗАНЕ по добі (start_min/end_study_min/end_min) — сюди
   потрапляють і «хвости» досліджень, що почалися вчора й перетнули опівніч. */
type BusySlot = {
  scheduled_time: string; duration_min: number; buffer_time_min: number | null;
  start_min?: number | null; end_study_min?: number | null; end_min?: number | null;
};
type SearchClinic = { id: string; name: string; city: string | null; modalities: string[] };
type CenterCardData = {
  name?: string; city?: string | null; policy?: string | null; note?: string | null;
  admins?: Array<{ full_name?: string | null; phone?: string | null; email?: string | null }>;
  rooms?: RoomOpt[];
};
type ApiResult = { ok: boolean; data: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

function pad(n: number) { return String(n).padStart(2, "0"); }
function toMin(t: string | null | undefined) { const p = String(t || "").split(":"); return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); }
function fmt(m: number) { return pad(Math.floor(m / 60)) + ":" + pad(m % 60); }
function dateVal(d: Date) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function calcAge(dob: string | null | undefined) { if (!dob) return null; return Math.floor((Date.now() - new Date(dob).getTime()) / (365.25 * 24 * 3600 * 1000)); }
function procLabel(e: { studies?: unknown; note?: string | null }) {
  const s = Array.isArray(e.studies) ? (e.studies as Array<{ type?: string; region?: string }>) : [];
  if (s.length) return s.map((x) => (x.type || "") + (x.region ? " · " + x.region : "")).join(" + ");
  return e.note || "—";
}
function centerLabel(c?: { name: string; city?: string | null } | null) { return c ? c.name + (c.city ? " · " + c.city : "") : "—"; }
/* Статуси/фільтри/«Запізнення» списку направлень живуть у ReferrerBoard —
   тутешні копії лишились від старої версії порталу (мертвий код, ESLint-шум). */
const ACCESS_ST: Record<string, { label: string; cls: string }> = {
  active: { label: "Активний", cls: "green" },
  pending_clinic: { label: "Очікує підтвердження центру", cls: "yellow" },
  pending_referrer: { label: "Запрошення центру", cls: "blue" },
  revoked: { label: "Відкликано", cls: "gray" },
  declined: { label: "Відхилено", cls: "gray" },
};

async function postJSON(url: string, body: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  } catch { return { ok: false, data: { error: "Помилка зʼєднання із сервером" } }; }
}

/* ---------- Вкладка «Нове направлення» ---------- */
interface NewReferralProps {
  activeCenters: Center[];
  roomsByClinic: Record<string, RoomOpt[]>;
  servicesByClinic: Record<string, ServiceLike[]>;
  roomOverridesByClinic: Record<string, RoomOverrideRow[]>;
  doctorName: string;
  doctorId: string;
  onCreated: (nm: string | null, err?: string) => void;
  /** 0118: створений кейс (id, центр, ПІБ) — портал відкриє екран кейса. */
  onCaseCreated: (caseId: string, clinicId: string, nm: string) => void;
}

function NewReferral({ activeCenters, roomsByClinic, servicesByClinic, roomOverridesByClinic, doctorName, onCreated, onCaseCreated }: NewReferralProps) {
  const [centerId, setCenterId] = useState(() => (activeCenters.length === 1 ? activeCenters[0].clinicId : ""));
  const [name, setName] = useState("");
  const [dob, setDob] = useState("");
  const [gender, setGender] = useState("");
  const [weight, setWeight] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [studyType, setStudyType] = useState("МРТ");
  const [region, setRegion] = useState("");
  const [contrast, setContrast] = useState(false);
  const [buffer, setBuffer] = useState<number>(BUFFER_DEFAULT);
  const [hasContra, setHasContra] = useState(false);
  const [priority, setPriority] = useState<PatientPriority | "">("");
  const [comment, setComment] = useState("");
  const [extraStudies, setExtraStudies] = useState<ExtraStudy[]>([]);
  /* «Завтра» — від доби ЦЕНТРУ (направник глобальний, центр може бути в іншій зоні).
     Центр ще не обрано → беремо зону ПЕРШОГО доступного: вибір довільний, але
     детермінований і однаковий на сервері й на клієнті (undefined впав би на зону
     процесу при SSR і на зону браузера при гідрації → розбіжність розмітки).
     Після вибору центру дата підтягнеться ефектом нижче. */
  const [bookDate, setBookDate] = useState(() => {
    const d = wallToday0(activeCenters[0]?.timezone || undefined);
    d.setDate(d.getDate() + 1);
    return d;
  });
  const [roomId, setRoomId] = useState<string | null>(null);
  const [time, setTime] = useState("");
  const [dayEntries, setDayEntries] = useState<BusySlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(true);
  const [slotsErr, setSlotsErr] = useState(false); // зайнятість/простої не завантажились — сітку не показуємо
  const [override, setOverride] = useState<DayOverride | null>(null);
  const [roomSchedule, setRoomSchedule] = useState<unknown>(null); // rooms.schedule обраного кабінету (для перерв)
  const [incidents, setIncidents] = useState<IncidentLike[]>([]);
  const [busy, setBusy] = useState(false);
  // 0118: пакетний режим «кейс» — накопичені кроки (паритет batch-бару BookingModal).
  const [caseSteps, setCaseSteps] = useState<CaseDraftStep[]>([]);
  const [caseBusy, setCaseBusy] = useState(false);
  const [caseErr, setCaseErr] = useState<string | null>(null);

  const date = dateVal(bookDate);
  const modality = modalityCode(studyType); // studyType тут — укр. лейбл ("МРТ"/"УЗД"…)
  const primaryKind = studyType;
  const selCenter = activeCenters.find((c) => c.clinicId === centerId) || null;
  const allRooms = roomsByClinic[centerId] || [];
  const allowedRoomIds = selCenter && Array.isArray(selCenter.room_ids) && selCenter.room_ids.length ? selCenter.room_ids : null;
  /* 0123: вимкнені кабінети направнику не показуємо взагалі — на його дошці
     немає «ведення» записів, лише запис і перегляд своїх; кабінет, у якому вже
     є його запис, лишається видимим у самому рядку запису (там назва з БД). */
  const rooms = bookableRooms(allowedRoomIds ? allRooms.filter((r) => allowedRoomIds.includes(r.id)) : allRooms);
  // Модальності, доступні направнику в цьому центрі (є кабінет і можна записати).
  const availableModalities = BOOKABLE_MODALITIES.filter((code) => rooms.some((r) => r.modality === code));
  const modAllowed = (code: string) => rooms.some((r) => r.modality === code);
  const roomsOfType = rooms.filter((r) => r.modality === modality);
  const room = roomsOfType.find((r) => r.id === roomId) || null;

  /* Центр обрано (або змінено) → підтягуємо дату до доби ЦЕНТРУ, якщо поточний
     вибір уже минув за його часом. Інакше направник із іншої зони відкривав день,
     який у центрі позаду, і всі слоти були закриті гардом «минуле» (0063). */
  const selTz = (selCenter?.timezone || activeCenters[0]?.timezone) || undefined;
  useEffect(() => {
    if (!selTz) return;
    setBookDate((d) => {
      const t0 = wallToday0(selTz);
      if (d >= t0) return d;
      const nx = new Date(t0); nx.setDate(nx.getDate() + 1); return nx;
    });
  }, [selTz]);

  // Каталог послуг ОБРАНОГО центру (фаза 2a): drop-in шорткати lib/studies.
  // Порожній (центр не обрано / без сіду) → статичний фолбэк.
  const catalog = useMemo(() => buildCatalog(servicesByClinic[centerId], overridesToMap(roomOverridesByClinic[centerId])), [servicesByClinic, roomOverridesByClinic, centerId]);
  const regionsFor = catalog.regionsFor;
  const studyPrice = catalog.studyPrice;

  const allRegions = regionsFor(studyType, roomId || undefined);
  /* «Контраст» — ФІЛЬТР списку послуг (правило одне на продукт, lib/catalog). */
  const regions = catalog.regionsWithContrast(studyType, roomId || undefined, contrast);
  const contrastFilters = catalog.contrastIsFilter(studyType, roomId || undefined);
  const regionObj = regions.find((r) => r.label === region);
  /* Суфікс і доплата/+CONTRAST_DUR — лише модифікаторний режим (легасі-статика):
     у каталозі контрастність уже в назві, а ціна позиції вже контрастна. */
  const contrastSuffix = contrast && !contrastFilters ? " з контрастом" : "";
  const durBump = contrast && !contrastFilters ? CONTRAST_DUR : 0;
  const priceBump = contrast && !contrastFilters ? (regionObj?.contrastPrice ?? CONTRAST_SURCHARGE) : 0;
  const computedDur = regionObj ? (regionObj.dur == null ? 0 : regionObj.dur + durBump) : (allRegions[0]?.dur ?? 20);
  const price = regionObj ? regionObj.price + priceBump : null;
  const fmtPrice = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₴";

  const [durEdit, setDurEdit] = useState("");
  // 0117: каталожне «—» → порожнє поле (ручний ввід).
  useEffect(() => { if (region) setDurEdit(computedDur > 0 ? String(computedDur) : ""); }, [region, contrast, studyType, roomId]); // eslint-disable-line react-hooks/exhaustive-deps -- зміна кабінету пересчитує дефолтну тривалість (per-room 0108)
  // Realtime-зміна каталожної тривалості (та сама область/кабінет): підхоплюємо новий
  // default, ЛИШЕ якщо оператор не редагував поле вручну. (0111 realtime каталогу.)
  const prevDefDurRef = useRef<number>(computedDur);
  useEffect(() => {
    const prev = prevDefDurRef.current;
    prevDefDurRef.current = computedDur;
    if (region && durEdit === String(prev) && String(prev) !== String(computedDur)) setDurEdit(computedDur > 0 ? String(computedDur) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- лише на realtime-зміну каталожного default
  }, [computedDur]);
  // 0117: час області «—» і порожнє поле → 0 (без фолбеку в 5 хв — ревью H2:
  // направник мовчки бронював 5-хвилинний слот) — збереження блокує miss.dur.
  const durRaw = parseInt(durEdit, 10) || computedDur;
  const dur = durRaw > 0 ? Math.max(5, durRaw) : 0;
  const durCustom = region && parseInt(durEdit, 10) && parseInt(durEdit, 10) !== computedDur;

  const exRegions = (t: string) => regionsFor(t, roomId || undefined);
  // Область не обрана → 0 (порожнє дослідження не додає час, поки область не вибрана).
  const exDur = (t: string, reg: string) => { const o = exRegions(t).find((r) => r.label === reg); return o ? (o.dur ?? 0) : 0; };
  function changeType(t: string) {
    setStudyType(t); setRegion(""); setContrast(false); setTime("");
    setExtraStudies((a) => a.map((s) => (s.type === t ? s : { ...s, type: t, region: "", dur: exDur(t, "") })));
  }
  function toggleContrast(v: boolean) {
    setContrast(v);
    // Обрана область не переживає новий фільтр → знімаємо вибір (і час).
    if (v && region && !catalog.regionsWithContrast(studyType, roomId || undefined, true).some((r) => r.label === region)) { setRegion(""); setTime(""); }
  }
  // Обрана область стала НЕДОСТУПНОЮ (прихована в кабінеті per-room 0108, АБО адмін
  // вимкнув послугу — realtime-каталог 0111) → знімаємо «фантомний» вибір і час. Ключ —
  // підпис набору доступних областей, а не лише roomId (Nielsen; сервер теж ріже).
  const availSig = regionsFor(studyType, roomId || undefined).map((r) => r.label + "|" + (r.isContrast ? "1" : "0") + (r.contrast ? "1" : "0")).join("");
  useEffect(() => {
    const avail = regionsFor(studyType, roomId || undefined);
    if (region && !avail.some((r) => r.label === region)) { setRegion(""); setTime(""); }
    // Область доступна, але контраст їй вимкнули в каталозі (realtime) → знімаємо флаг.
    // Область ще доступна, але вже не проходить фільтр «Контраст» → знімаємо галочку.
    else if (region && contrast && !catalog.regionsWithContrast(studyType, roomId || undefined, true).some((r) => r.label === region)) { setContrast(false); setTime(""); }
    setExtraStudies((a) => a.map((s) => (s.region && !avail.some((r) => r.label === s.region) ? { ...s, region: "", dur: 0 } : s)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- перезапуск при зміні набору доступних областей / контрасту (кабінет АБО realtime-каталог)
  }, [availSig]);

  const exPatch = (i: number, p: Partial<ExtraStudy>) => setExtraStudies((a) => a.map((r, idx) => (idx === i ? { ...r, ...p } : r)));
  const exSetRegion = (i: number, reg: string) => { const r = extraStudies[i]; exPatch(i, { region: reg, dur: exDur(r.type, reg) }); };
  const exSetDur = (i: number, v: string) => exPatch(i, { dur: Math.max(5, parseInt(v, 10) || 0) });
  const exAdd = () => setExtraStudies((a) => [...a, { type: primaryKind, region: "", dur: exDur(primaryKind, "") }]);
  const exRemove = (i: number) => setExtraStudies((a) => a.filter((_, idx) => idx !== i));
  const validExtra = extraStudies.filter((s) => s.region);

  /* studies[].contrast у режимі фільтра — властивість обраної позиції прайсу,
     а не стан чекбокса (з нього сервер рахує has_contrast). */
  const primaryContrast = contrastFilters ? (regionObj?.isContrast === true) : contrast === true;
  const primaryStudy: StudyOut | null = region ? { type: primaryKind, region, contrast: primaryContrast, dur, price: studyPrice(primaryKind, region, contrast, roomId || undefined) } : null;
/* Додаткові дослідження теж можуть бути контрастними позиціями прайсу (їх
   список НЕ фільтрується — це свідомо), тож contrast беремо з САМОЇ позиції.
   Інакше «основне без контрасту + додаткове з в/в контрастуванням» давало б
   has_contrast=false на всю запис (ревʼю, High-4). */
  const exContrast = (t: string, reg: string) =>
    catalog.contrastIsFilter(t, roomId || undefined) ? (exRegions(t).find((r) => r.label === reg)?.isContrast === true) : false;
  const allStudies: StudyOut[] = (primaryStudy ? [primaryStudy] : []).concat(validExtra.map((s) => ({ type: s.type, region: s.region, contrast: exContrast(s.type, s.region), dur: Number(s.dur) || 0, price: studyPrice(s.type, s.region, false, roomId || undefined) })));
  const slotDur = dur + validExtra.reduce((s, x) => s + (Number(x.dur) || 0), 0);

  /* 0118: зайнятість пацієнта накопиченими кроками кейса на ЦЮ дату (casebusy у
     сітці) + кабінети, вже задіяні в кейсі (кейс = РІЗНІ кабінети, 0095). */
  const caseWindows = caseSteps.filter((s) => s.date === date).map((s) => { const st = toMin(s.time); return { s: st, e: st + s.dur }; });
  const caseRoomIds = caseSteps.map((s) => s.roomId);
  const roomInCase = !!roomId && caseRoomIds.includes(roomId);

  function calcAgeLocal(d: string) { const a = calcAge(d); return a == null || a < 0 ? 0 : a; }

  useEffect(() => {
    if (!modAllowed(modalityCode(studyType))) {
      const first = availableModalities[0];
      if (first) setStudyType(modalityLabel(first));
      setRegion(""); setContrast(false); setTime("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerId]);

  useEffect(() => {
    setRoomId((prev) => (roomsOfType.some((r) => r.id === prev) ? prev : (roomsOfType.length === 1 ? roomsOfType[0].id : null)));
    setTime("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerId, studyType]);

  /* Помилка завантаження ≠ «вільно» (аудит 2026-07-11). Раніше і зайнятість, і
     простої бралися як `data || []`: при збої RPC весь день виглядав вільним, а
     зламаний кабінет — робочим. Тепер піднімаємо slotsErr, сітку не показуємо. */
  const loadDay = useCallback(async (silent = false) => {
    // Гейт «Завантаження…» показуємо ЛИШЕ при первинному завантаженні / зміні
    // кабінету-дати (silent=false). Фонові перезапити (realtime, focus/visibility)
    // — silent: сітка не мигає в «завантаження» на кожен тик, стара лишається до
    // приходу нових даних (як у BookingModal). Помилку/дані оновлюємо все одно.
    if (!silent) setSlotsLoading(true);
    try {
      const supabase = createClient();
      if (centerId) {
        const ov = await supabase.from("schedule_overrides").select("all_closed, label, rooms").eq("clinic_id", centerId).eq("override_date", date).maybeSingle();
        if (ov.error) throw ov.error;
        setOverride((ov.data as unknown as DayOverride) || null);
        const inc = await supabase.from("incidents").select("room_id, started_at, blocked_until, status, auto_unblock").eq("clinic_id", centerId).in("status", ["active", "planned"]);
        if (inc.error) throw inc.error;
        setIncidents(inc.data || []);
      }
      if (!roomId) { setDayEntries([]); setRoomSchedule(null); setSlotsErr(false); return; }
      const roomRes = await supabase.from("rooms").select("schedule").eq("id", roomId).maybeSingle();
      setRoomSchedule((roomRes.data as { schedule?: unknown } | null)?.schedule ?? null);
      // Знеособлена зайнятість: для направника RPC віддає рядки БЕЗ ПІБ/статусу/
      // досліджень (гейт у 0062) — він бачить лише, що час зайнятий.
      const { data, error } = await supabase.rpc("room_busy_slots", { p_room: roomId, p_date: date });
      if (error) throw error; // PostgREST не кидає сам — інакше «зайнятий день» став би «вільним»
      setDayEntries(data || []);
      setSlotsErr(false);
    } catch {
      // Транзієнтний збій (рефреш токена / мережа) — портал не рушимо, але й
      // «усе вільно» не малюємо: показуємо помилку й ховаємо сітку.
      setSlotsErr(true);
    } finally {
      if (!silent) setSlotsLoading(false);
    }
  }, [centerId, roomId, date]);

  useEffect(() => { (async () => { await loadDay(); })(); }, [loadDay]);
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible") loadDay(true); };
    document.addEventListener("visibilitychange", onVis); window.addEventListener("focus", onVis);
    return () => { document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", onVis); };
  }, [loadDay]);
  /* Realtime: сітка оновлюється, поки направник заповнює форму. Увага: події
     ходять під RLS, тож про ЧУЖІ записи направник події не отримає — його рятує
     refetch по focus/visibility вище + повторна перевірка слота на сервері. */
  useRealtimeRefetch({
    channelName: centerId ? "ref-slots-" + centerId + "-" + (roomId || "none") + "-" + date : null,
    subscriptions: [
      { table: "queue_entries", onChange: () => loadDay(true) },
      { table: "incidents", onChange: () => loadDay(true) },
    ],
  });

  const dateObj = new Date(date + "T00:00:00");
  const roomSched = roomScheduleFor(dateObj, roomId || "", override, roomSchedule);
  const schedStart = toMin(roomSched.start), schedEnd = toMin(roomSched.end);
  // eStudy — кінець САМОГО дослідження; e — кінець зайнятості (з буфером прибирання).
  const busySlots = (dayEntries || []).map((e) => {
    // 0074: пріоритет — обрізані по добі хвилини. Жодних «|| 30»: на хвостовому
    // рядку duration_min законно 0 (у цю добу зайшов лише буфер).
    if (e.start_min != null && e.end_min != null) {
      return { s: e.start_min, eStudy: e.end_study_min ?? e.end_min, e: e.end_min };
    }
    const s = toMin(e.scheduled_time);
    const eStudy = s + (e.duration_min ?? 30);
    return { s, eStudy, e: eStudy + (e.buffer_time_min ?? BUFFER_DEFAULT) };
  });
  const roomBreaks = effectiveRoomBreaks(dateObj, roomId || "", roomSchedule, override); // перерви кабінету на цю дату
  // «Зараз» у настінному часі центру (wall-as-UTC мс): і хвилини доби, і «сьогодні».
  const _nowW = wallNow(selTz);
  const nowMin = wallMinOfDay(_nowW);
  // «Сьогодні» ЦЕНТРУ (не браузера): направник глобальний, центр може бути в іншій зоні.
  const centerTodayStr = wallDayKey(selTz);
  const centerToday = wallToday0(selTz);
  const isBookToday = date === centerTodayStr;
  const isPastDay = date < centerTodayStr;
  const slots: string[] = buildSlots(schedStart, schedEnd); // крок 5 хв
  function slotState(slot: string) {
    // b — кінець дослідження (має вміститись у графік); bBlock — з буфером (перетин з іншими).
    const a = toMin(slot), b = a + slotDur, bBlock = a + slotDur + buffer;
    if (isPastDay) return "past"; // день у минулому за часом ЦЕНТРУ
    if (roomSched.closed) return "closed";
    const slotMs = Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), Math.floor(a / 60), a % 60);
    if (slotBlockedByIncidents(incidents, roomId || "", slotMs)) return "blocked";
    if (a < schedStart || a >= schedEnd) return "offhours";
    if (b > schedEnd) return "tight";
    if (inBreak(a, roomBreaks)) return "break";                 // сам слот — перерва кабінету
    if (breakClash(a, slotDur, roomBreaks)) return "tight";     // слот робочий, але дослідження заїде в перерву
    if (isBookToday && a < nowMin) return "past";
    // Дослідження і буфер прибирання після нього — окремі стани (кабінет зайнятий і там, і там).
    if (busySlots.some((x) => a >= x.s && a < x.eStudy)) return "busy";
    if (busySlots.some((x) => a >= x.eStudy && a < x.e)) return "buffer";
    if (busySlots.some((x) => a < x.e && x.s < bBlock)) return "tight";
    // 0118: кабінет вільний, але пацієнт у цей час уже зайнятий іншим накопиченим
    // кроком кейса (присутність = тривалість дослідження, без буфера; фінальний
    // рубіж — CASE_PATIENT_OVERLAP у RPC/тригерах 0094/0096).
    if (caseWindows.some((w) => a < w.e && w.s < a + slotDur)) return "casebusy";
    return "free";
  }
  function nextApptAfter(slot: string) {
    const s = toMin(slot);
    const after = busySlots.filter((x) => x.s >= s).sort((a, b) => a.s - b.s)[0];
    return after ? fmt(after.s) : null;
  }
  function breakLabel(slot: string) {
    const br = inBreak(toMin(slot), roomBreaks);
    return br ? `Перерва в роботі кабінету · ${br.start}–${br.end}` : "Перерва в роботі кабінету";
  }
  // Причина «не вміщується» — у тому ж порядку, що й перевірки в slotState.
  function tightReason(slot: string) {
    const a = toMin(slot);
    const endLab = `кінець графіка (${fmt(schedEnd)})`;
    if (a + slotDur > schedEnd) return endLab;
    const br = breakClash(a, slotDur, roomBreaks);
    if (br) return `перерву ${br.start}–${br.end}`;
    const appt = nextApptAfter(slot);
    return appt ? `запис о ${appt}` : endLab;
  }
  // Реальна місткість дня для цієї тривалості (жадібна укладка), а не к-сть 5-хв позицій.
  const fitCount = countFit(slots, (s) => slotState(s) === "free", slotDur + buffer);
  const busyList = busySlots.slice().sort((a, b) => a.s - b.s);

  const miss: Record<string, boolean> = { center: !centerId, name: !name.trim(), dob: !dob, gender: !gender, phone: !phone.trim(), priority: !priority, region: !region, room: !roomId, time: !time, dur: !!region && dur < 5, exdur: validExtra.some((s) => (Number(s.dur) || 0) < 5) };
  const MISS_LABELS: Record<string, string> = { center: "Центр", name: "ПІБ", dob: "Дата народження", gender: "Стать", phone: "Телефон", priority: "Пріоритет", region: "Область дослідження", room: "Кабінет", time: "Слот часу", dur: "Тривалість (хв)", exdur: "Тривалість додаткових досліджень" };
  const missingList = Object.keys(MISS_LABELS).filter((k) => miss[k]).map((k) => MISS_LABELS[k]);
  const timeBad = time ? slotState(time) !== "free" : false;
  const valid = centerId && missingList.length === 0 && roomId && !timeBad && !roomSched.closed;

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    const [hh, mm] = time.split(":").map(Number);
    const at = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), hh, mm).toISOString();
    // Server Action: серверна перевірка доступу направника + пред-перевірка слота + insert.
    const res = await createReferralBooking({
      clinicId: centerId, roomId: roomId as string,
      name: name.trim(), phone: phone.trim() || null, email: email.trim() || null,
      dob: dob || null, sex: gender || null, age: calcAgeLocal(dob), weight: weight ? +weight : null,
      hasContra: !!hasContra, priorityLevel: priority || undefined, studies: allStudies as Json,
      doctorName, note: comment.trim() || null, durationMin: slotDur, bufferTimeMin: buffer,
      scheduledDate: date, scheduledTime: time, scheduledAt: at,
    });
    setBusy(false);
    if (!res.ok) {
      const msg = (res.code === "slot_taken" || res.code === "slot_unavailable") ? "Слот щойно зайняли — оновіть сторінку й оберіть інший час"
        : res.code === "incident" ? "Кабінет у простої (ремонт/ТО) у цей час — оберіть інший слот або день"
        : res.code === "forbidden" ? "Немає доступу до цього центру/кабінету" : res.error;
      onCreated(null, msg);
      return;
    }
    setName(""); setDob(""); setGender(""); setWeight(""); setPhone(""); setEmail(""); setRegion(""); setContrast(false); setHasContra(false); setPriority(""); setComment(""); setExtraStudies([]); setTime("");
    onCreated(name.trim());
  }

  /* ===== 0118 — пакетний режим «кейс» =====
     «＋ У кейс» накопичує поточний крок і скидає крок-специфічні поля (пацієнт
     лишається спільним); «Створити кейс (N)» шле все однією атомарною дією
     createReferralCase (create_case_rpc, гілка направника). Центр на час
     накопичення заблоковано — кейс живе в ОДНОМУ центрі. */
  function resetStepFields() {
    setRegion(""); setContrast(false); setExtraStudies([]); setTime(""); setDurEdit("");
  }
  function draftFromForm(): CaseDraftStep | null {
    if (!roomId || !room) return null;
    return { roomId, roomName: room.name, modality: primaryKind, date, time, dur: slotDur, buffer, studies: allStudies, hasContra };
  }
  function addStepToCase() {
    if (!valid || roomInCase) return;
    const d = draftFromForm();
    if (!d) return;
    setCaseErr(null);
    setCaseSteps((arr) => [...arr, d]);
    resetStepFields();
  }
  const caseTotal = caseSteps.length + (valid && !roomInCase ? 1 : 0);
  async function createCaseNow() {
    if (caseBusy) return;
    const cur = valid && !roomInCase ? draftFromForm() : null;
    const steps = cur ? [...caseSteps, cur] : [...caseSteps];
    if (steps.length < 2) return;   // кейс — щонайменше два кроки різних кабінетів
    setCaseBusy(true); setCaseErr(null);
    const res = await createReferralCase({
      clinicId: centerId,
      patient: {
        name: name.trim(), phone: phone.trim() || null, email: email.trim() || null,
        dob: dob || null, sex: gender || null, age: calcAgeLocal(dob), weight: weight ? +weight : null,
      },
      note: comment.trim() || null,
      steps: steps.map((s) => ({
        roomId: s.roomId, studies: s.studies as unknown as CaseStepInput["studies"], durationMin: s.dur,
        bufferTimeMin: s.buffer, priorityLevel: (priority || undefined) as PatientPriority | undefined,
        scheduledDate: s.date, scheduledTime: s.time, contraindications: s.hasContra,
        doctor: doctorName || null, note: null,
      })),
    });
    setCaseBusy(false);
    if (!res.ok) {
      setCaseErr(res.code === "slot_taken" || res.code === "slot_unavailable" ? "Слот щойно зайняли — оновіть сторінку й оберіть інший час" : res.error);
      return;
    }
    const nm = name.trim();
    setCaseSteps([]);
    setName(""); setDob(""); setGender(""); setWeight(""); setPhone(""); setEmail(""); setRegion(""); setContrast(false); setHasContra(false); setPriority(""); setComment(""); setExtraStudies([]); setTime("");
    if (res.id) onCaseCreated(res.id, centerId, nm);
  }

  if (activeCenters.length === 0) {
    return (
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <div className="empty"><div className="ei">🏥</div><div className="et">Немає авторизованих центрів</div><div className="es">Додайте центр у вкладці «Мої центри» — після підтвердження зможете створювати направлення.</div></div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 880, margin: "0 auto" }}>
      <div className="dialog bk-dialog" style={{ margin: 0, maxHeight: "none", overflow: "visible" }}>
        <div className="bk-grid">
          <div className="bk-col bk-col-left">
            <div className="bk-section-label" style={{ marginTop: 0 }}>Центр</div>
            <label className="fld">
              <span className={"fld-lab" + (miss.center ? " bk-miss-lab" : "")}>Куди направляємо <span className="req">*</span></span>
              <select className="inp" value={centerId} disabled={caseSteps.length > 0}
                title={caseSteps.length > 0 ? "Кейс живе в одному центрі — приберіть кроки кейса, щоб змінити центр" : undefined}
                onChange={(e) => { setCenterId(e.target.value); setTime(""); }}>
                <option value="">— Оберіть центр —</option>
                {activeCenters.map((c) => <option key={c.clinicId} value={c.clinicId}>{centerLabel(c)}</option>)}
              </select>
              {caseSteps.length > 0 && <span className="bk-time-state none">центр заблоковано, поки формується кейс</span>}
            </label>

            <div className="bk-section-label">Пацієнт</div>

            <label className="fld">
              <span className={"fld-lab" + (miss.name ? " bk-miss-lab" : "")}>ПІБ <span className="req">*</span></span>
              <input className="inp" placeholder="Прізвище Ім'я По батькові" value={name} onChange={(e) => setName(e.target.value)} />
            </label>

            <div className="fld-row">
              <div className="fld" style={{ flex: "0 0 150px" }}>
                <span className={"fld-lab" + (miss.dob ? " bk-miss-lab" : "")}>Дата народження <span className="req">*</span></span>
                <DobField value={dob} onChange={setDob} invalid={miss.dob} />
              </div>
              <div className="fld" style={{ flex: "0 0 auto" }}>
                <span className={"fld-lab" + (miss.gender ? " bk-miss-lab" : "")}>Стать <span className="req">*</span></span>
                <div className="bk-gender-row">
                  <button className={"bk-gender-btn" + (gender === "М" ? " active" : "")} onClick={() => setGender("М")} title="Чоловіча">♂</button>
                  <button className={"bk-gender-btn" + (gender === "Ж" ? " active" : "")} onClick={() => setGender("Ж")} title="Жіноча">♀</button>
                </div>
              </div>
              <div className="fld" style={{ flex: "0 0 52px" }}>
                <span className="fld-lab">Вік</span>
                <div className="inp bk-age" title="Розраховано з дати народження">{dob ? calcAgeLocal(dob) : "—"}</div>
              </div>
              <label className="fld" style={{ flex: "0 0 60px" }}>
                <span className="fld-lab">Вага</span>
                <input className="inp" placeholder="кг" value={weight}
                  onChange={(e) => { const w = e.target.value.replace(/\D/g, "").slice(0, 3); setWeight(w && +w > 400 ? "400" : w); }} />
              </label>
            </div>

            <div className="fld-row">
              <label className="fld">
                <span className={"fld-lab" + (miss.phone ? " bk-miss-lab" : "")}>Телефон <span className="req">*</span></span>
                <PhoneInput value={phone} onChange={setPhone} />
              </label>
              <label className="fld">
                <span className="fld-lab">Email</span>
                <input className="inp" type="email" placeholder="patient@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
            </div>

            <div className="bk-section-label">Дослідження</div>

            <div className="fld-row" style={{ alignItems: "flex-end" }}>
              <div className="fld" style={{ flex: "0 0 130px" }}>
                <span className="fld-lab">Тип <span className="req">*</span></span>
                <div className="bk-seg">
                  {availableModalities.map((code) => (
                    <button key={code} className={"bk-seg-btn" + (studyType === modalityLabel(code) ? " active " + modalityKind(code) : "")} onClick={() => changeType(modalityLabel(code))} title={modalityLabel(code)}>{modalityShort(code)}</button>
                  ))}
                </div>
              </div>
              <div className="fld">
                <span className="fld-lab">Параметри</span>
                <div className="bk-check-row">
                  <label className={"rf-check" + (contrast ? " on" : "")}>
                    <input type="checkbox" checked={contrast} onChange={(e) => toggleContrast(e.target.checked)} />
                    <span className="rf-box" /><span>Контраст</span>
                  </label>
                  <label className={"rf-check" + (hasContra ? " warn" : "")}>
                    <input type="checkbox" checked={hasContra} onChange={(e) => setHasContra(e.target.checked)} />
                    <span className="rf-box" /><span>Протипоказання</span>
                  </label>
                </div>
              </div>
            </div>

            <div className="fld">
              <span className={"fld-lab" + (miss.priority ? " bk-miss-lab" : "")}>Пріоритет пацієнта <span className="req">*</span></span>
              <div className="prio-seg" role="radiogroup" aria-label="Пріоритет пацієнта">
                {PRIORITY_OPTIONS.map((pv) => {
                  const m = PRIORITY_META[pv];
                  return (
                    <button key={pv} type="button" role="radio" aria-checked={priority === pv}
                      className={"prio-seg-btn " + m.tone + (priority === pv ? " active" : "")}
                      onClick={() => setPriority(pv)} title={m.desc}>
                      {m.short}
                    </button>
                  );
                })}
              </div>
              <span className="bk-time-state none">{priority ? PRIORITY_META[priority as PatientPriority].desc : "оберіть пріоритет — впливає на порядок у черзі"}</span>
            </div>

            <div className="fld-row" style={{ alignItems: "flex-start" }}>
              <label className="fld" style={{ flex: "1 1 auto" }}>
                <span className={"fld-lab" + (miss.region ? " bk-miss-lab" : "")}>Область дослідження <span className="req">*</span></span>
                <select className="inp" value={region} onChange={(e) => { setRegion(e.target.value); setTime(""); }}>
                  <option value="">— Оберіть область —</option>
                  {regions.map((r) => (
                    <option key={r.label} value={r.label}>{r.label}{contrastSuffix} · {r.dur == null ? "—" : r.dur + durBump + " хв"}</option>
                  ))}
                </select>
              </label>
              <label className="fld" style={{ flex: "0 0 108px" }}>
                <span className="fld-lab">Тривалість <span className="req">*</span></span>
                <div className="bk-dur-row">
                  <input className="inp bk-dur-input" type="number" min="5" step="5" placeholder="—"
                    value={durEdit} onChange={(e) => setDurEdit(e.target.value.replace(/\D/g, ""))} disabled={!region} />
                  <span className="bk-dur-unit">хв</span>
                </div>
                <span className={"bk-time-state " + (durCustom ? "busy" : "none")}>
                  {!region ? "оберіть область" : durCustom ? `↺ за замовч. ${computedDur} хв` : computedDur > 0 ? "за тривалістю області" : "час не задано — введіть"}
                </span>
              </label>
              <label className="fld" style={{ flex: "0 0 96px" }}>
                <span className="fld-lab">Буфер</span>
                <select className="inp" value={buffer} onChange={(e) => setBuffer(Number(e.target.value))} title="Час на переукладку/дезінфекцію після дослідження">
                  {BUFFER_OPTIONS.map((b) => <option key={b} value={b}>{b} хв</option>)}
                </select>
                <span className="bk-time-state none">після дослідження</span>
              </label>
            </div>

            {price != null && (
              <div className="ctx-hint blue" style={{ marginBottom: 6 }}>Орієнтовна вартість: {fmtPrice(price)}</div>
            )}

            <div className="fld">
              {extraStudies.length > 0 && (
                <div className="bk-study-table">
                  <div className="bk-study-head"><span>Тип</span><span>Область дослідження</span><span>Трив.</span><span /></div>
                  {extraStudies.map((r, i) => {
                    const regs = exRegions(r.type);
                    return (
                      <div className="bk-study-row" key={i}>
                        <div className="bk-seg bk-seg-sm st-seg-locked" title="Тип = тип основного дослідження">
                          <button className={"bk-seg-btn active " + modalityKind(studyType)} disabled>{modalityShort(studyType)}</button>
                        </div>
                        <select className="inp" value={r.region} onChange={(e) => exSetRegion(i, e.target.value)}>
                          <option value="">— Оберіть область —</option>
                          {regs.map((x) => <option key={x.label} value={x.label}>{x.label} · {x.dur == null ? "—" : x.dur + " хв"}</option>)}
                        </select>
                        <div className="bk-study-dur"><input className="inp" type="number" min="5" step="5" value={r.region ? (r.dur || "") : ""} placeholder="—" disabled={!r.region} title={r.region ? "" : "Спершу оберіть область"} onChange={(e) => exSetDur(i, e.target.value)} /><span className="st-dur-u">хв</span></div>
                        <button className="st-row-del" title="Прибрати" onClick={() => exRemove(i)}>✕</button>
                      </div>
                    );
                  })}
                </div>
              )}
              <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: extraStudies.length > 0 ? 8 : 0 }} onClick={exAdd}>＋ Додати дослідження</button>
            </div>

            <label className="fld" style={{ flex: 1 }}>
              <span className="fld-lab">Примітки</span>
              <textarea className="inp bk-notes" placeholder="Клінічне питання, показання, що шукаємо, особливі вимоги…" value={comment} onChange={(e) => setComment(e.target.value)} />
            </label>
          </div>

          <div className="bk-col bk-col-right">
            <div className="bk-sched-head">
              <span className="bk-sched-spark">✦</span>
              <span className="bk-sched-title">Розклад</span>
              <span className={"bk-sched-mod " + modalityKind(studyType)}>{studyType}</span>
              <span className="bk-sched-sync"><span className="pulse-dot" style={{ background: "var(--green)", width: 6, height: 6 }} /> синхр. з чергою</span>
            </div>

            <div className="fld">
              <span className={"fld-lab" + (miss.room ? " bk-miss-lab" : "")}>Кабінет <span className="req">*</span></span>
              {!centerId ? (
                // Без обраного центру ще нічого не відомо про кабінети — не лякаємо
                // червоним «немає кабінету типу …».
                <div className="ctx-hint">Спершу оберіть центр.</div>
              ) : roomsOfType.length === 0 ? (
                <div className="ctx-hint red">У цьому центрі немає кабінету типу {studyType}.</div>
              ) : (
                <>
                  {/* Той самий поріг, що й у персонала: роль не має міняти
                      поведінку вибору кабінету (вимога власника). */}
                  {roomsOfType.length > ROOM_LIST_MAX_CHIPS ? (
                    <RoomSelect rooms={roomsOfType} value={roomId || ""}
                      onChange={(id) => { setRoomId(id); setTime(""); }} />
                  ) : (
                  <div className="bk-room-chips">
                    {roomsOfType.map((r) => (
                      <button key={r.id} className={"bk-room-chip" + (roomId === r.id ? " active" : "") + " " + modalityKind(r.modality)}
                        onClick={() => { setRoomId(r.id); setTime(""); }} title={r.name + (r.apparatus_model ? " · " + r.apparatus_model : "")}>
                        <span className="bk-room-chip-name">{r.name}</span>
                        {r.apparatus_model && <span className="bk-room-chip-model">{r.apparatus_model}</span>}
                      </button>
                    ))}
                  </div>
                  )}
                </>
              )}
            </div>

            <BookingCalendar value={bookDate} today={centerToday} onPick={(d) => { setBookDate(d); setTime(""); }} />

            <div className="fld">
              <div className="bk-slots-head">
                <span className={"fld-lab" + (miss.time ? " bk-miss-lab" : "")} style={{ margin: 0 }}>Вільні слоти · {fmtShort(bookDate)} {miss.time ? "— оберіть час *" : ""}</span>
                <span className="bk-free-count">блок {slotDur} хв{allStudies.length > 1 ? ` (${allStudies.length} досл.)` : ""} + {buffer} буфер · {allStudies.length === 0 ? "оберіть область" : slotsLoading ? "завантаження…" : "вміщується ще " + fitCount}</span>
              </div>
              {/* Вердикт про графік має сенс ЛИШЕ коли кабінет обрано: без roomId
                  roomScheduleFor() не знаходить кабінет в override.rooms і падає на
                  дефолт (неділя = вихідний) → показувало хибне «Кабінет не працює»
                  навіть у день, який override відкриває (чергування). */}
              {roomId && roomSched.closed && <div className="ctx-hint red" style={{ marginBottom: 10 }}>🚫 {room ? room.name : "Кабінет"} не працює {fmtShort(bookDate)}{override && override.label ? " · " + override.label : ""}. Оберіть інший день або кабінет.</div>}
              {roomId && !roomSched.closed && roomSched.custom && <div className="ctx-hint blue" style={{ marginBottom: 10 }}>🕐 Особливий графік {fmtShort(bookDate)}: {roomSched.start}–{roomSched.end}.</div>}
              {roomId && !roomSched.closed && slots.some((s) => slotState(s) === "blocked") && <div className="ctx-hint red" style={{ marginBottom: 10 }}>🔧 {room ? room.name : "Кабінет"} на ремонті/ТО у частині дня. Оберіть вільний слот або інший день.</div>}
              {/* Зайнятість не завантажилась — сітку НЕ показуємо: порожній день
                  виглядав би як «усе вільно», і направник записав би пацієнта поверх чужого. */}
              {slotsErr && !slotsLoading
                ? <div className="ctx-hint red" style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <span>⚠ Не вдалося завантажити зайнятість кабінету — показати вільний час не можемо.</span>
                    <button className="btn btn-secondary btn-sm" onClick={() => loadDay()}>↻ Спробувати ще раз</button>
                  </div>
                : allStudies.length === 0
                ? <div className="ctx-hint" style={{ fontSize: "0.8125rem", padding: "20px 0", textAlign: "center", color: "var(--text-muted)" }}>Оберіть область дослідження, щоб побачити вільний час</div>
                : slotsLoading
                ? <div className="ctx-hint" style={{ fontSize: "0.8125rem", padding: "20px 0", textAlign: "center", color: "var(--text-muted)" }}>⏳ Завантаження вільних слотів…</div>
                : <div className={miss.time ? "bk-miss-slots" : undefined}>
                <SlotPicker
                  slots={slots}
                  value={time}
                  onChange={setTime}
                  spanMin={slotDur}
                  bufferMin={buffer}
                  resetKey={(roomId || "") + "|" + date + "|" + slotDur + "|" + buffer}
                  stateOf={slotState}
                  titleOf={(s, st) => st === "busy" ? "Зайнято"
                    : st === "buffer" ? "Буфер після дослідження — кабінет ще зайнятий"
                    : st === "blocked" ? "Кабінет на ремонті/ТО"
                    : st === "break" ? breakLabel(s)
                    : st === "tight" ? `Не вміщується: блок ${slotDur} хв перетне ${tightReason(s)}`
                    : st === "casebusy" ? "Пацієнт зайнятий іншим кроком кейса в цей час — оберіть інший слот"
                    : st === "past" ? "Час минув"
                    : `Вільно · ${s}–${fmt(toMin(s) + slotDur)}`}
                />
              </div>}
              {busyList.length > 0 && (
                <div className="bk-busy-list">
                  <span className="bk-busy-lab">Зайнятий час:</span>
                  {busyList.map((b, i) => (
                    <span className="bk-busy-chip" key={i}>
                      {fmt(b.s)}–{fmt(b.eStudy)}{b.e > b.eStudy ? <span style={{ opacity: 0.7 }}> +{b.e - b.eStudy} хв</span> : null}
                    </span>
                  ))}
                </div>
              )}
              <div className="bk-slot-legend">
                <span><span className="lg-dot free" />вільно</span>
                <span><span className="lg-dot tight" />не вміщується</span>
                <span><span className="lg-dot busy" />зайнято</span>
                <span><span className="lg-dot busybuf" />буфер</span>
                {time && buffer > 0 && <span><span className="lg-dot planbuf" />буфер цього запису</span>}
                {roomBreaks.length > 0 && <span><span className="lg-dot brk" />перерва</span>}
                {caseWindows.length > 0 && <span><span className="lg-dot casebusy" />інший крок кейса</span>}
              </div>
              {time && (() => {
                const s = toMin(time), e = s + slotDur, eBlock = s + slotDur + buffer;
                const slotMs = Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), Math.floor(s / 60), s % 60);
                const blocked = slotBlockedByIncidents(incidents, roomId || "", slotMs);
                const conflict = busySlots.find((b) => s < b.e && b.s < eBlock);
                return (
                  <div className={"bk-slot-confirm " + (blocked || conflict ? "bad" : "ok")}>
                    {blocked ? <>⚠ Кабінет на ремонті/ТО у цей час — оберіть інший слот або день</>
                      : conflict ? <>⚠ Перетин із записом {fmt(conflict.s)}–{fmt(conflict.e)} — оберіть інший слот</>
                      : <>✓ Слот вільний. Запис: <b>{time}–{fmt(e)}</b> ({slotDur} хв){buffer > 0 ? <> + буфер {buffer} хв (до {fmt(eBlock)})</> : null}.</>}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>

        {caseErr && (
          <div className="dlg-err" role="alert">⚠ {caseErr}</div>
        )}

        {/* 0118: batch-бар кейса (паритет BookingModal): «＋ У кейс» накопичує кроки
            різних модальностей, «Створити кейс (N)» — одна атомарна дія. */}
        <div className="bk-case-bar" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "8px 16px", borderTop: "1px solid var(--border)" }}>
          <span style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--text-muted)", whiteSpace: "nowrap" }}>🔗 Кейс:</span>
          {caseSteps.length === 0 && <span style={{ fontSize: "0.71875rem", color: "var(--text-muted)" }}>додайте кроки різних модальностей — направлення підуть одним кейсом</span>}
          {caseSteps.map((s, i) => (
            <span key={i} style={{ fontSize: "0.71875rem", padding: "2px 6px 2px 8px", borderRadius: 999, border: "1px solid var(--border)", display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: "0.625rem", opacity: 0.7 }}>{i + 1}</span>
              {s.modality} · {s.roomName} · {s.time}–{fmt(toMin(s.time) + s.dur)}
              <button onClick={() => { setCaseErr(null); setCaseSteps((arr) => arr.filter((_, j) => j !== i)); }} title="Прибрати крок"
                style={{ cursor: "pointer", background: "none", border: "none", color: "var(--text-muted)", padding: 0, lineHeight: 1 }}>✕</button>
            </span>
          ))}
          {roomInCase && (
            <span style={{ flexBasis: "100%", fontSize: "0.71875rem", color: "var(--orange, #e08a00)" }}>
              ⚠ Кабінет «{room?.name}» уже у кейсі. Кейс — це різні кабінети/модальності; кілька досліджень одного кабінету оформіть звичайним направленням («＋ Додати дослідження»).
            </span>
          )}
          <button className="btn btn-ghost btn-sm" disabled={!valid || caseBusy || roomInCase} onClick={addStepToCase} style={{ marginLeft: "auto" }}
            title={roomInCase ? "Цей кабінет уже у кейсі — оберіть інший кабінет/модальність" : "Додати поточний крок до кейса"}>＋ У кейс</button>
          <button className="btn btn-primary btn-sm" disabled={caseBusy || caseTotal < 2} onClick={createCaseNow} title="Кейс — щонайменше два кроки в різних кабінетах">
            {caseBusy ? "Створення…" : `Створити кейс (${caseTotal})`}
          </button>
        </div>

        <div className="dlg-foot">
          {valid
            ? <span className="bk-summary">{name.split(" ").slice(0, 2).join(" ")} · {allStudies.length > 1 ? allStudies.length + " досл." : primaryKind} · {room ? room.name : ""} · {fmtShort(bookDate)} {time}–{fmt(toMin(time) + slotDur)}</span>
            : <span className="bk-missing">{missingList.map((m, i) => <span className="bk-miss-chip" key={i}>{m}</span>)}</span>}
          <button className="btn btn-primary" disabled={!valid || busy || caseSteps.length > 0} onClick={submit}
            title={caseSteps.length > 0 ? "Формується кейс — завершіть його кнопкою «Створити кейс» або приберіть кроки" : undefined}>
            {busy ? "Відправляємо…" : "Відправити направлення"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* «Мої направлення» → тепер компонент ReferrerBoard (доска-черга як у адміна).
   Стара карткова версія (MyReferrals) видалена. */

/* ---------- Розгорнута картка центру ---------- */
function CenterDetails({ data, loading }: { data?: CenterCardData | null; loading: boolean }) {
  const panel = { background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", padding: 16, margin: "4px 0 8px" };
  if (loading) return <div style={panel}><div style={{ color: "var(--text-muted)", fontSize: "0.8125rem" }}>Завантаження…</div></div>;
  if (!data) return <div style={panel}><div style={{ color: "var(--text-muted)", fontSize: "0.8125rem" }}>Не вдалося завантажити деталі центру.</div></div>;
  const admins = Array.isArray(data.admins) ? data.admins : [];
  const rooms = Array.isArray(data.rooms) ? data.rooms : [];
  const realEmail = (e?: string | null) => e && !/@referrer\.radflow\.local$/i.test(e);
  const lbl = { color: "var(--text-muted)", fontSize: "0.71875rem", textTransform: "uppercase" as const, letterSpacing: ".04em", margin: "0 0 8px" };
  return (
    <div style={panel}>
      <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", rowGap: 8, columnGap: 10, fontSize: "0.8125rem", marginBottom: 16 }}>
        <span style={{ color: "var(--text-muted)" }}>Центр</span><span style={{ fontWeight: 600 }}>{data.name}</span>
        <span style={{ color: "var(--text-muted)" }}>Місто</span><span>{data.city || "—"}</span>
        <span style={{ color: "var(--text-muted)" }}>Режим бронювання</span><span>{data.policy === "confirm" ? "з підтвердженням оператора" : "пряма черга (одразу в чергу)"}</span>
        {data.note ? <><span style={{ color: "var(--text-muted)" }}>Примітка</span><span>{data.note}</span></> : null}
      </div>

      <div style={lbl}>Адміністратор центру</div>
      {admins.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: "0.8125rem", marginBottom: 16 }}>Контакти не вказані.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
          {admins.map((a, i) => {
            const phone = a.phone || "";
            const email = realEmail(a.email) ? a.email : "";
            return (
              <div key={i} style={{ fontSize: "0.8125rem" }}>
                <div style={{ fontWeight: 600 }}>{a.full_name || "Адміністратор"}</div>
                <div style={{ color: "var(--text-secondary)", display: "flex", gap: 16, flexWrap: "wrap", marginTop: 3 }}>
                  {phone ? <a href={"tel:" + phone} style={{ color: "var(--blue)", textDecoration: "none" }}>📞 {phone}</a> : null}
                  {email ? <a href={"mailto:" + email} style={{ color: "var(--blue)", textDecoration: "none" }}>✉ {email}</a> : null}
                  {!phone && !email ? <span style={{ color: "var(--text-muted)" }}>контакти не вказані</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={lbl}>Доступне обладнання для вас</div>
      {rooms.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: "0.8125rem" }}>Кабінети не вказані.</div>
      ) : (
        <div className="bd-rooms">
          {rooms.map((r) => (
            <div key={r.id} className="bd-room" style={{ cursor: "default" }} title={r.name + (r.apparatus_model ? " · " + r.apparatus_model : "")}>
              <span className={"bd-room-kind " + modalityKind(r.modality)}>{modalityShort(r.modality)}</span>
              <span className="bd-room-meta"><span className="bd-room-name">{r.name}</span><span className="bd-room-model">{r.apparatus_model || ""}</span></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Вкладка «Мої центри» ---------- */
interface MyCentersProps {
  centers: Center[];
  canManage: boolean;
  onChanged: () => void;
  notify: (msg: string, type?: string) => void;
}

function MyCenters({ centers, canManage, onChanged, notify }: MyCentersProps) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchClinic[]>([]);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, CenterCardData>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);

  function toggleExpand(c: Center) {
    if (!c.accessId) return;
    setExpandedId((id) => (id === c.accessId ? null : c.accessId!));
  }

  const expandedCenter = centers.find((c) => c.accessId === expandedId) || null;
  const expandedSig = expandedCenter ? JSON.stringify([expandedCenter.status, expandedCenter.policy, expandedCenter.room_ids]) : "";
  useEffect(() => {
    if (!expandedId) return;
    let cancelled = false;
    (async () => {
      setLoadingId(expandedId);
      const supabase = createClient();
      const { data, error } = await supabase.rpc("referral_center_card", { p_access_id: expandedId });
      if (cancelled) return;
      setLoadingId((id) => (id === expandedId ? null : id));
      if (!error && data) setDetails((d) => ({ ...d, [expandedId]: data as unknown as CenterCardData }));
    })();
    return () => { cancelled = true; };
  }, [expandedId, expandedSig]);

  const knownIds = useMemo(() => new Set(centers.map((c) => c.clinicId)), [centers]);
  const invites = centers.filter((c) => c.status === "pending_referrer");
  const active = centers.filter((c) => c.status === "active");
  const awaiting = centers.filter((c) => c.status === "pending_clinic");
  const history = centers.filter((c) => c.status === "revoked" || c.status === "declined");

  async function search() {
    setSearching(true);
    const supabase = createClient();
    const { data } = await supabase.rpc("search_clinics", { q: q.trim() });
    setResults((data || []).filter((c) => !knownIds.has(c.id)));
    setSearching(false);
  }

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) { setResults([]); setSearching(false); return; }
    let active2 = true;
    setSearching(true);
    const t = setTimeout(async () => {
      const supabase = createClient();
      const { data } = await supabase.rpc("search_clinics", { q: query });
      if (!active2) return;
      setResults((data || []).filter((c) => !knownIds.has(c.id)));
      setSearching(false);
    }, 250);
    return () => { active2 = false; clearTimeout(t); };
  }, [q, knownIds]);

  async function sendRequest(clinicId: string) {
    setBusyId(clinicId);
    const { ok, data } = await postJSON("/api/referral/access/request", { clinic_id: clinicId });
    setBusyId(null);
    if (!ok) { notify(data.error || "Помилка", "error"); return; }
    notify("Запит надіслано — очікуйте підтвердження центру", "success");
    setResults((rs) => rs.filter((r) => r.id !== clinicId));
    onChanged();
  }

  async function decide(accessId: string, decision: string) {
    setBusyId(accessId);
    const { ok, data } = await postJSON("/api/referral/access/decide", { access_id: accessId, decision });
    setBusyId(null);
    if (!ok) { notify(data.error || "Помилка", "error"); return; }
    notify(decision === "approve" ? "Запрошення прийнято" : decision === "revoke" ? "Доступ відкликано" : "Відхилено", "success");
    onChanged();
  }

  const card = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 18, marginBottom: 14 };
  function Row({ c, children, onClick, expandable, expanded }: { c: Center; children?: ReactNode; onClick?: () => void; expandable?: boolean; expanded?: boolean }) {
    const m = ACCESS_ST[c.status] || ACCESS_ST.active;
    return (
      <div onClick={onClick} title={expandable ? (expanded ? "Згорнути" : "Натисніть, щоб переглянути деталі центру") : undefined} style={{ padding: "12px 0", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", cursor: onClick ? "pointer" : "default" }}>
        {expandable && <span style={{ color: "var(--text-muted)", fontSize: "0.8125rem", width: 12, flexShrink: 0, display: "inline-block", transition: "transform .15s", transform: expanded ? "rotate(90deg)" : "none" }}>▸</span>}
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>{c.name}</div>
          <div style={{ fontSize: "0.78125rem", color: "var(--text-muted)" }}>{c.city || "—"}{c.status === "active" ? " · режим: " + (c.policy === "confirm" ? "з підтвердженням" : "пряма черга") : ""}</div>
        </div>
        <span className={"badge " + m.cls}>{m.label}</span>
        {children}
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 820, margin: "0 auto" }}>
      {canManage && (
        <div style={card}>
          <div className="bk-section-label" style={{ marginTop: 0 }}>Додати центр</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="inp" placeholder="Почніть вводити назву або місто центру…" value={q} autoComplete="off" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") search(); }} />
            <button className="btn btn-secondary" onClick={search} disabled={searching || q.trim().length < 2}>{searching ? "Пошук…" : "Знайти"}</button>
          </div>
          {q.trim().length >= 2 && (
            <div style={{ marginTop: 10 }}>
              {results.length === 0 ? (
                <div style={{ fontSize: "0.78125rem", color: "var(--text-muted)", padding: "8px 0" }}>{searching ? "Шукаємо…" : "Нічого не знайдено. Уточніть назву або місто."}</div>
              ) : results.map((r) => (
                <div key={r.id} style={{ padding: "10px 0", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: "0.84375rem" }}>{r.name}</div>
                    <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{r.city || "—"}{Array.isArray(r.modalities) && r.modalities.length ? " · " + r.modalities.map(modalityLabel).join(", ") : ""}</div>
                  </div>
                  <button className="btn btn-primary btn-sm" disabled={busyId === r.id} onClick={() => sendRequest(r.id)}>{busyId === r.id ? "…" : "Надіслати запит"}</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {invites.length > 0 && (
        <div style={card}>
          <div className="bk-section-label" style={{ marginTop: 0 }}>Запрошення центрів ({invites.length})</div>
          {invites.map((c) => (
            <div key={c.accessId}>
              <Row c={c} expandable expanded={expandedId === c.accessId} onClick={() => toggleExpand(c)}>
                <button className="btn btn-primary btn-sm" disabled={busyId === c.accessId} onClick={(e) => { e.stopPropagation(); decide(c.accessId!, "approve"); }}>Прийняти</button>
                <button className="btn btn-secondary btn-sm" disabled={busyId === c.accessId} onClick={(e) => { e.stopPropagation(); if (window.confirm("Відхилити запрошення центру «" + c.name + "»?\n\nВи зможете надіслати запит на доступ пізніше вручну.")) decide(c.accessId!, "decline"); }}>Відхилити</button>
              </Row>
              {expandedId === c.accessId && <CenterDetails data={details[c.accessId!]} loading={loadingId === c.accessId && !details[c.accessId!]} />}
            </div>
          ))}
        </div>
      )}

      <div style={card}>
        <div className="bk-section-label" style={{ marginTop: 0 }}>Активні центри ({active.length})</div>
        {active.length === 0 ? <div style={{ color: "var(--text-muted)", padding: 8, fontSize: "0.8125rem" }}>Поки немає активних центрів.</div>
          : active.map((c) => (
            <div key={c.accessId || c.clinicId}>
              <Row c={c} expandable={!!c.accessId} expanded={expandedId === c.accessId} onClick={c.accessId ? () => toggleExpand(c) : undefined}>
                {canManage && c.accessId && <button className="btn btn-secondary btn-sm qd-act-red" disabled={busyId === c.accessId} onClick={(e) => { e.stopPropagation(); if (window.confirm("Відкликати доступ до «" + c.name + "»? Створені направлення лишаться у центрі, нові ви створювати не зможете.")) decide(c.accessId!, "revoke"); }}>Відкликати</button>}
              </Row>
              {c.accessId && expandedId === c.accessId && <CenterDetails data={details[c.accessId]} loading={loadingId === c.accessId && !details[c.accessId]} />}
            </div>
          ))}
      </div>

      {awaiting.length > 0 && (
        <div style={card}>
          <div className="bk-section-label" style={{ marginTop: 0 }}>Очікують підтвердження ({awaiting.length})</div>
          {awaiting.map((c) => <Row key={c.accessId} c={c} />)}
        </div>
      )}

      {history.length > 0 && (
        <div style={card}>
          <div className="bk-section-label" style={{ marginTop: 0 }}>Історія</div>
          {history.map((c) => (
            <Row key={c.accessId} c={c}>
              {canManage && <button className="btn btn-secondary btn-sm" disabled={busyId === c.clinicId} onClick={() => sendRequest(c.clinicId)}>{busyId === c.clinicId ? "…" : "Надіслати запит знову"}</button>}
            </Row>
          ))}
        </div>
      )}
    </div>
  );
}

/* Текстове поле, що росте вниз у міру набору (авто-висота),
   але не більше maxRows видимих рядків — далі зʼявляється прокрутка. */
function AutoTextarea({ value, onChange, placeholder, className = "inp", maxRows = 5 }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; maxRows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 20;
    const padT = parseFloat(cs.paddingTop) || 0;
    const padB = parseFloat(cs.paddingBottom) || 0;
    const borderT = parseFloat(cs.borderTopWidth) || 0;
    const borderB = parseFloat(cs.borderBottomWidth) || 0;
    // box-sizing: border-box → у height входять padding і border.
    const extra = padT + padB + borderT + borderB;
    const max = line * maxRows + extra;
    const full = el.scrollHeight + borderT + borderB;
    el.style.height = Math.min(full, max) + "px";
    el.style.overflowY = full > max ? "auto" : "hidden";
  }, [value, maxRows]);
  return (
    <textarea
      ref={ref}
      className={className}
      placeholder={placeholder}
      rows={1}
      style={{ resize: "none", overflow: "hidden" }}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/* ---------- Вкладка «Мій профіль» (направник редагує власні дані) ---------- */
function MyProfile({ doctorId, notify, onSaved }: { doctorId: string; notify: (m: string, t?: string) => void; onSaved: () => void }) {
  const [form, setForm] = useState({ login: "", full_name: "", phone: "", note: "", city: "", email: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      const supabase = createClient();
      const [{ data: p }, { data: priv }] = await Promise.all([
        supabase.from("profiles").select("login, full_name, phone, note, city").eq("id", doctorId).maybeSingle(),
        supabase.from("referrer_private").select("email").eq("referrer_id", doctorId).maybeSingle(),
      ]);
      if (!active) return;
      setForm({ login: p?.login || "", full_name: p?.full_name || "", phone: p?.phone || "", note: p?.note || "", city: p?.city || "", email: priv?.email || "" });
      setLoading(false);
    })();
    return () => { active = false; };
  }, [doctorId]);

  async function save() {
    if (!form.login.trim()) { notify("Вкажіть логін", "error"); return; }
    if (!form.full_name.trim()) { notify("Вкажіть ПІБ", "error"); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/referral/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { notify(data.error || "Помилка", "error"); setSaving(false); return; }
      notify("Профіль збережено", "success");
      onSaved();
    } catch { notify("Помилка зʼєднання із сервером", "error"); }
    setSaving(false);
  }

  const card = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 20, maxWidth: 640, margin: "0 auto" };
  const reqMark = <span style={{ color: "var(--red)" }}> *</span>;
  if (loading) return <div className="empty"><div className="et">Завантаження профілю…</div></div>;
  return (
    <div style={card}>
      <div className="bk-section-label" style={{ marginTop: 0 }}>Мій профіль</div>
      <div className="fld-row">
        <label className="fld" style={{ flex: 1 }}><span className="fld-lab" style={{ color: "var(--red)" }}>Логін{reqMark}</span><input className="inp" value={form.login} onChange={(e) => setForm((f) => ({ ...f, login: e.target.value }))} /></label>
        <label className="fld" style={{ flex: 1 }}><span className="fld-lab" style={{ color: "var(--red)" }}>ПІБ{reqMark}</span><input className="inp" placeholder="Прізвище Імʼя По батькові" value={form.full_name} onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))} /></label>
      </div>
      <div className="fld-row">
        <label className="fld" style={{ flex: 1 }}><span className="fld-lab" style={{ color: "var(--red)" }}>Телефон{reqMark}</span><PhoneInput required value={form.phone} onChange={(v) => setForm((f) => ({ ...f, phone: v }))} /></label>
        <label className="fld" style={{ flex: 1 }}><span className="fld-lab" style={{ color: "var(--red)" }}>Email (для відновлення доступу){reqMark}</span><input className="inp" type="email" placeholder="name@example.com" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} /></label>
      </div>
      <div className="fld-row" style={{ alignItems: "flex-start" }}>
        <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Місто</span><CitySelect value={form.city} onChange={(v) => setForm((f) => ({ ...f, city: v }))} /></label>
        <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Примітки</span><AutoTextarea placeholder="напр. спеціалізація (необовʼязково)" value={form.note} onChange={(v) => setForm((f) => ({ ...f, note: v }))} /></label>
      </div>
      <div className="hint-blue">🔒 <b>Email бачите лише ви</b> — він потрібен для відновлення доступу й не видимий центрам. Логін, ПІБ, телефон, місто і примітки видно центрам, до яких ви підключені.</div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
        <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? "Зберігаємо…" : "Зберегти"}</button>
      </div>
    </div>
  );
}

/* ── Лист очікування направника: власні пацієнти в усіх авторизованих центрах ── */
function MyWaitlist({ entries, centersById, onOpenAdd, onEdit, onCancel, onRestore, onPriority }: {
  entries: WaitlistEntry[];
  centersById: Record<string, Center>;
  onOpenAdd: () => void;
  onEdit: (e: WaitlistEntry) => void;
  onCancel: (e: WaitlistEntry) => void;
  onRestore: (e: WaitlistEntry) => void;
  onPriority: (e: WaitlistEntry, v: PatientPriority) => void;
}) {
  const waiting = entries.filter((e) => e.status === "waiting").sort(compareWaitlist);
  const rest = entries.filter((e) => e.status !== "waiting").sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  const list = [...waiting, ...rest];
  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="info-banner">
        <span className="ib-ic">⏳</span>
        <span className="ib-txt"><b>Лист очікування</b> — ваші пацієнти, що чекають на вільне вікно в центрі. Коли слот звільниться, центр запише пацієнта — статус зміниться на «Записано».</span>
        <button className="btn btn-primary btn-sm" style={{ flexShrink: 0 }} onClick={onOpenAdd}>＋ Додати пацієнта</button>
      </div>
      {list.length === 0 ? (
        <div className="empty"><div className="ei">⏳</div><div className="et">Лист порожній</div><div className="es">Додайте пацієнта, що чекає на вільне вікно</div></div>
      ) : (
        list.map((p) => {
          const m = PRIORITY_META[p.priority_level];
          const st = WAITLIST_STATUS_META[p.status];
          const center = centersById[p.clinic_id];
          return (
            <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 12, background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", padding: "10px 14px", opacity: p.status === "waiting" ? 1 : 0.72 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "0.84375rem", fontWeight: 600, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  {p.status !== "waiting" && <span className="badge">{st.label}</span>}
                  {p.priority_level !== "planned" && p.status === "waiting" && <span className={"prio-tag " + m.tone}>{m.short}</span>}
                  {p.status === "waiting" ? (
                    <span onClick={() => onEdit(p)} title="Редагувати дані пацієнта та дослідження"
                      style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", cursor: "pointer", textDecorationLine: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 3 }}>{p.patient_name}</span>
                  ) : (
                    <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.patient_name}</span>
                  )}
                </div>
                <div style={{ fontSize: "0.71875rem", color: "var(--text-muted)", marginTop: 2 }}>
                  {centerLabel(center)} · {procLabel(p)} · {desiredWindowText(p)}
                </div>
              </div>
              {p.status === "waiting" && (
                <div className="prio-seg" role="radiogroup" aria-label="Пріоритет пацієнта" style={{ flexShrink: 0 }}>
                  {PRIORITY_OPTIONS.map((pv) => {
                    const pm = PRIORITY_META[pv];
                    return (
                      <button key={pv} type="button" role="radio" aria-checked={p.priority_level === pv}
                        className={"prio-seg-btn " + pm.tone + (p.priority_level === pv ? " active" : "")}
                        title={pm.desc} onClick={() => onPriority(p, pv)}>
                        {pm.short}
                      </button>
                    );
                  })}
                </div>
              )}
              {p.status === "waiting" && (
                <button className="btn btn-secondary btn-sm" style={{ flexShrink: 0 }} title="Редагувати пацієнта/дослідження/вікно" onClick={() => onEdit(p)}>✎ Редагувати</button>
              )}
              {p.status === "waiting"
                ? <button className="btn btn-secondary btn-sm" style={{ color: "var(--red)", flexShrink: 0 }} onClick={() => onCancel(p)}>✕ Зняти</button>
                : (p.status === "cancelled" || p.status === "expired")
                  ? <button className="btn btn-secondary btn-sm" style={{ flexShrink: 0 }} onClick={() => onRestore(p)}>↩ Повернути</button>
                  : null}
            </div>
          );
        })
      )}
    </div>
  );
}

interface ReferralPortalProps {
  role: string;
  centers: Center[];
  roomsByClinic: Record<string, RoomOpt[]>;
  /** clinic_id → id вимкнених кабінетів, у яких ЩЕ лишились живі записи направника
   *  («кабінети-залишки»): вимкнений кабінет ховаємо зі списків, але поки в ньому
   *  щось є — він спливає назад із підписом «вимкнено · N». Див. lib/rooms.ts. */
  residualRoomIdsByClinic?: Record<string, string[]>;
  /** clinic_id → room_id → скільки саме лишилось (для підпису). */
  residualRoomCountsByClinic?: Record<string, Record<string, number>>;
  /** Каталоги послуг за центрами (clinic_id → services, 0107). RLS services_referrer_read. */
  servicesByClinic: Record<string, ServiceLike[]>;
  /** Переозначення каталогу по кабінетах за центрами (clinic_id → service_room_overrides, 0108). */
  roomOverridesByClinic: Record<string, RoomOverrideRow[]>;
  doctorName: string;
  doctorId: string;
  /** Адмін у режимі перегляду порталу: куди його повернути (null для направника). */
  backHref?: string | null;
  /** Назва власного центру адміна — підпис кнопки повернення. */
  backLabel?: string | null;
}

export default function ReferralPortal({ role, centers, roomsByClinic, residualRoomIdsByClinic, residualRoomCountsByClinic, servicesByClinic, roomOverridesByClinic, doctorName, doctorId, backHref = null, backLabel = null }: ReferralPortalProps) {
  const router = useRouter();
  const canManage = role === "referrer";
  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const activeCenters = useMemo(() => centers.filter((c) => c.status === "active"), [centers]);
  const centersById = useMemo(() => { const m: Record<string, Center> = {}; centers.forEach((c) => { m[c.clinicId] = c; }); return m; }, [centers]);

  /* Кабінети для СПИСКІВ порталу (сайдбар, фільтр доски): активні + вимкнені, у яких
     ще лишились живі записи цього направника. `roomsByClinic` лишається ПОВНИМ і далі
     йде туди, де за room_id резолвиться назва кабінету в рядку направлення чи в кейсі,
     — фільтруємо списки, а не записи (див. lib/rooms.ts). */
  const visRoomsByClinic = useMemo(() => {
    const m: Record<string, RoomOpt[]> = {};
    for (const [cid, rs] of Object.entries(roomsByClinic)) {
      m[cid] = visibleRooms(rs, residualSet(residualRoomIdsByClinic?.[cid]));
    }
    return m;
  }, [roomsByClinic, residualRoomIdsByClinic]);
  const offNote = useCallback((clinicId: string, roomId: string): string | null => {
    const r = (roomsByClinic[clinicId] || []).find((x) => x.id === roomId);
    return r && r.active === false ? roomOffLabel(residualRoomCountsByClinic?.[clinicId]?.[roomId]) : null;
  }, [roomsByClinic, residualRoomCountsByClinic]);

  // Коди модальностей, доступних направнику в центрі за грантом (room_ids; null = усі
  // кабінети). Передаємо у WaitlistModal, щоб він не пропонував недоступні модальності
  // (сервер addWaitlistEntry перевіряє те саме).
  // Вимкнені кабінети сюди не рахуємо: у листі очікування напрямок існує лише щоб
  // із нього ЗАПИСАТИ, а в непрацюючий апарат не запишеш — модальність, у якій усі
  // кабінети центру вимкнено, направник пропонувати не повинен.
  const centerModalities = (c: Center): string[] => {
    const rs = bookableRooms(roomsByClinic[c.clinicId] || []);
    const ids = Array.isArray(c.room_ids) && c.room_ids.length ? c.room_ids : null;
    const allowed = ids ? rs.filter((r) => ids.includes(r.id)) : rs;
    return Array.from(new Set(allowed.map((r) => r.modality)));
  };
  const pendingInvites = centers.filter((c) => c.status === "pending_referrer").length;

  const [tab, setTab] = useState(() => (activeCenters.length === 0 ? "centers" : "new"));
  // Швидкий фільтр з сайдбару: клік по центру/кабінету → доска «Мої направлення».
  const [boardFocus, setBoardFocus] = useState<{ clinicId: string; roomId: string; nonce: number } | null>(null);
  const [editPatientFor, setEditPatientFor] = useState<Referral | null>(null);
  const [referrals, setReferrals] = useState<Referral[]>([]);
  // H-6: збій читання списку ≠ «направлень немає» (сітку слотів уже прикриває slotsErr).
  const [listErr, setListErr] = useState(false);
  const [reschedFor, setReschedFor] = useState<Referral | null>(null);
  const [editStudiesFor, setEditStudiesFor] = useState<Referral | null>(null);
  const [wlEntries, setWlEntries] = useState<WaitlistEntry[]>([]);
  const [wlAddOpen, setWlAddOpen] = useState(false);
  const [wlEditFor, setWlEditFor] = useState<WaitlistEntry | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function notify(msg: string, type = "success") { setToast({ msg, type }); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 3200); }

  const reload = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("queue_entries")
        .select("id, clinic_id, created_by, referrer_id, patient_name, patient_phone, patient_age, scheduled_date, scheduled_time, duration_min, buffer_time_min, status, call_status, priority_level, studies, studies_original, studies_changed_by, contraindications, doctor, note, indication, room_id, reschedule_origin, case_id, case_step")
        .eq("referrer_id", doctorId)
        .order("scheduled_date", { ascending: false }).order("scheduled_time", { ascending: true });
      // H-6: збій читання показувався як «Немає направлень» — лікар вважав, що
      // його пацієнти не записані, і записував їх удруге.
      if (error) { setListErr(true); return; }
      setReferrals(data || []);
      setListErr(false);
    } catch { setListErr(true); }
  }, [doctorId]);

  // Лист очікування: RLS показує направнику лише власні рядки (created_by).
  const reloadWaitlist = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("waitlist_entries")
        .select("*")
        .eq("created_by", doctorId)
        .order("created_at", { ascending: true });
      if (error) { setListErr(true); return; }
      setWlEntries(data || []);
    } catch { setListErr(true); }
  }, [doctorId]);
  useEffect(() => { reloadWaitlist(); }, [reloadWaitlist]);

  // TD-3: единый realtime-хук.
  useRealtimeRefetch({
    channelName: doctorId ? "ref-" + doctorId : null,
    subscriptions: [
      { table: "queue_entries", filter: "referrer_id=eq." + doctorId, onChange: reload },
      { table: "waitlist_entries", filter: "created_by=eq." + doctorId, onChange: reloadWaitlist },
      { table: "referral_access", filter: "referrer_id=eq." + doctorId, onChange: () => router.refresh() },
      // 0086: зміни кабінетів дозволених центрів (видалення/графік) → оновлюємо
      // портал. Без filter: RLS доставляє направнику лише кабінети його центрів
      // (REPLICA IDENTITY FULL з 0086 дає clinic_id і в подіях DELETE).
      { table: "rooms", onChange: () => router.refresh() },
      // Каталог послуг/цін центрів направника (0107/0108) — RLS доставляє лише
      // доступні центри/кабінети (як rooms); зміна каталогу адміном → оновити портал.
      { table: "services", onChange: () => router.refresh() },
      { table: "service_room_overrides", onChange: () => router.refresh() },
    ],
  });

  /* Звукові сповіщення направника: ЛИШЕ критичні події ВЛАСНИХ направлень —
     перший перехід у needs_reschedule або not_held. «Пацієнт готовий» та
     інциденти направника не стосуються (readyEnabled=false, incidents не
     передаємо — доступ до даних заради звуку не розширюємо). Snapshot-логіка
     поверх reload(); помилковий snapshot (listErr) baseline не чіпає. */
  useQueueSounds({
    scopeKey: "ref|" + doctorId,
    entries: listErr ? null : referrals,
    readyEnabled: false,
    criticalStatuses: REFERRER_CRITICAL_STATUSES,
  });

  async function wlAdd(w: WaitlistFormOut) {
    const res = await addWaitlistEntry({
      clinicId: w.clinicId, name: w.name, phone: w.phone, email: w.email, dob: w.dob, sex: w.sex, age: w.age, weight: w.weight,
      priorityLevel: w.priorityLevel, studies: w.studies, durationMin: w.durationMin, bufferTimeMin: w.bufferTimeMin,
      desiredDateFrom: w.desiredDateFrom, desiredDateTo: w.desiredDateTo,
      desiredTimeFrom: w.desiredTimeFrom, desiredTimeTo: w.desiredTimeTo, note: w.note,
    });
    if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
    setWlAddOpen(false);
    notify("Додано до листа очікування: " + w.name, "success");
    reloadWaitlist();
  }
  async function wlEditSave(w: WaitlistFormOut) {
    const p = wlEditFor;
    if (!p) return;
    const res = await updateWaitlistEntry(p.id, {
      patient_name: w.name, patient_phone: w.phone, patient_email: w.email,
      patient_dob: w.dob, patient_sex: w.sex, patient_age: w.age, patient_weight: w.weight,
      studies: w.studies, duration_min: w.durationMin, buffer_time_min: w.bufferTimeMin,
      desired_date_from: w.desiredDateFrom, desired_date_to: w.desiredDateTo,
      desired_time_from: w.desiredTimeFrom, desired_time_to: w.desiredTimeTo,
      note: w.note,
    });
    if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
    setWlEditFor(null);
    notify("Запис листа оновлено", "success");
    reloadWaitlist();
  }

  const [wlConfirmRemove, setWlConfirmRemove] = useState<WaitlistEntry | null>(null);
  async function wlCancel(e: WaitlistEntry) {
    const res = await setWaitlistStatus(e.id, "cancelled");
    if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
    notify("Знято з листа очікування", "info"); reloadWaitlist();
  }
  async function wlRestore(e: WaitlistEntry) {
    const res = await setWaitlistStatus(e.id, "waiting");
    if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
    notify("Повернено в очікування", "success"); reloadWaitlist();
  }
  async function wlPrio(e: WaitlistEntry, v: PatientPriority) {
    if (e.priority_level === v) return;
    setWlEntries((es) => es.map((x) => (x.id === e.id ? { ...x, priority_level: v } : x)));
    const res = await setWaitlistPriority(e.id, v);
    if (!res.ok) { notify("Помилка: " + res.error, "error"); reloadWaitlist(); }
  }

  /* CAS-промах: центр уже провів/скасував пацієнта, поки в направника висіла стара
     вкладка. Показуємо причину і перечитуємо список — раніше перенос ВОСКРЕШАВ
     завершений запис (патч містить status:'scheduled'). */
  function handledStale(res: { ok: boolean; code?: string; error?: string }): boolean {
    if (res.ok || res.code !== "stale") return false;
    notify(res.error || "Стан змінився — оновіть сторінку", "error");
    reload();
    return true;
  }

  // Повертає ТЕКСТ помилки — модалка покаже його в собі (тост тонув під оверлеєм).
  async function doReschedule({ roomId, date, time, dur, buffer, reason, studies }: { roomId: string; date: Date; time: string; dur: number; buffer: number; reason: string; studies?: RescheduleStudy[] }) {
    const p = reschedFor; if (!p) return null;
    const [hh, mm] = time.split(":").map(Number);
    const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hh, mm).toISOString();
    const res = await rescheduleQueueEntry({ id: p.id, roomId, scheduledDate: dateVal(date), scheduledTime: time, scheduledAt: at, durationMin: dur, bufferTimeMin: buffer, reason, studies });
    if (!res.ok) {
      if (res.code === "stale") { setReschedFor(null); handledStale(res); return null; }
      reload();
      // Перенос у минуле / поза графіком кабінету заборонено (сервер + тригер 0063).
      return (res.code === "slot_taken" || res.code === "slot_unavailable")
        ? "Слот щойно зайняли — оберіть інший"
        : res.code === "incident" ? "Кабінет у простої — оберіть інший слот"
        : res.error;
    }
    setReschedFor(null);
    notify("Перенесено", "success"); reload();
    return null;
  }

  /* Скасування направлення — незворотне (слот звільняється). Раніше йшло в один
     клік, хоча зняття з листа очікування поруч уже питало підтвердження. */
  const [cancelAsk, setCancelAsk] = useState<Referral | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  async function doCancel(entry: Referral) {
    if (!entry) return;
    const res = await cancelQueueEntry(entry.id);
    if (!res.ok) {
      if (handledStale(res)) return;   // пацієнта вже провели/скасували в центрі
      notify("Помилка скасування: " + res.error, "error");
      return;
    }
    notify("Направлення скасовано", "success"); reload();
  }

  async function doEditStudies(arr: { type: string; region: string; dur: number }[], meta: { dur: number; buffer: number }) {
    const p = editStudiesFor;
    if (!p) return;
    const res = await editQueueEntryStudies(p.id, arr as unknown as Json, meta.dur || p.duration_min || 30, meta.buffer);
    setEditStudiesFor(null);
    if (!res.ok) {
      if (handledStale(res)) return;
      notify("Помилка збереження досліджень: " + res.error, "error");
      return;
    }
    notify("Дослідження оновлено", "success"); reload();
  }

  /* ===== 0118 — кейси направника: екран кейса + «Організувати кейс» ===== */
  /* Кабінети центру, звужені грантом (referral_access.room_ids; null/[] = усі).
     ПОВНИЙ перелік, вимкнені НЕ ріжемо: звідси кабінети йдуть у CaseModal (назви
     кроків уже створеного кейса — це запис, а не список) і в BookingModal, яка
     сама фільтрує через bookableRooms. Вирізати вимкнені тут означало б показати
     крок кейса без назви кабінету. */
  const grantedRooms = useCallback((clinicId: string): RoomOpt[] => {
    const all = roomsByClinic[clinicId] || [];
    const ids = centersById[clinicId]?.room_ids;
    const list = Array.isArray(ids) && ids.length ? ids : null;
    return list ? all.filter((r) => list.includes(r.id)) : all;
  }, [roomsByClinic, centersById]);

  const [openCase, setOpenCase] = useState<{ caseId: string; clinicId: string; incidents: IncidentLike[] } | null>(null);
  const [organizeFor, setOrganizeFor] = useState<{ r: Referral; incidents: IncidentLike[] } | null>(null);

  // Простої центру для сітки кроку — інакше заблокований час малювався б вільним
  // (збій читання → порожньо: сервер усе одно відхилить, це лише підказка).
  async function centerIncidents(clinicId: string): Promise<IncidentLike[]> {
    try {
      const { data } = await createClient().from("incidents")
        .select("room_id, started_at, blocked_until, status, auto_unblock")
        .eq("clinic_id", clinicId).in("status", ["active", "planned"]);
      return data || [];
    } catch { return []; }
  }
  async function openCaseScreen(caseId: string, clinicId: string) {
    setOpenCase({ caseId, clinicId, incidents: await centerIncidents(clinicId) });
  }
  async function startOrganize(r: Referral) {
    setOrganizeFor({ r, incidents: await centerIncidents(r.clinic_id) });
  }
  /* Крок іншої модальності до СВОГО запису → referralCaseFromEntry (гілка 0118).
     Помилки гардів (той самий кабінет / перетин часу) повертаємо модалці. */
  async function doOrganize(b: BookingPayload): Promise<string | null> {
    const ctx = organizeFor;
    if (!ctx) return null;
    const res = await referralCaseFromEntry(ctx.r.id, ctx.r.clinic_id, {
      roomId: b.roomId, studies: b.studies, durationMin: b.dur, bufferTimeMin: b.buffer,
      priorityLevel: b.priority, scheduledDate: dateVal(b.date), scheduledTime: b.time,
      contraindications: !!b.hasContra, doctor: b.doctor ?? null, note: b.notes ?? null,
    });
    if (!res.ok) return res.error;
    setOrganizeFor(null);
    reload();
    if (res.id) openCaseScreen(res.id, ctx.r.clinic_id);   // одразу показуємо кейс
    return null;
  }

  function onCentersChanged() { router.refresh(); }

  const reschedRooms = reschedFor ? (roomsByClinic[reschedFor.clinic_id] || []) : [];
  const TAB_META: Record<string, { t: string; i: string }> = {
    new: { t: "Нове направлення", i: "＋" }, mine: { t: "Мої направлення", i: "▦" },
    waitlist: { t: "Лист очікування", i: "⏳" }, centers: { t: "Мої центри", i: "🏥" }, profile: { t: "Мій профіль", i: "👤" },
  };
  const tabMeta = TAB_META[tab] || TAB_META.new;

  return (
    <div className="app">
      <ReferrerSidebar centers={activeCenters} roomsByClinic={visRoomsByClinic} roomNoteOf={offNote} doctorName={doctorName}
        backHref={backHref} backLabel={backLabel}
        activeTab={tab}
        onNav={(key) => { if (key === "mine") setBoardFocus({ clinicId: "all", roomId: "all", nonce: Date.now() }); setTab(key); }}
        onSelectRoom={(clinicId, roomId) => { setBoardFocus({ clinicId, roomId, nonce: Date.now() }); setTab("mine"); }}
        activeClinic={tab === "mine" ? boardFocus?.clinicId : undefined}
        activeRoom={tab === "mine" ? boardFocus?.roomId : undefined}
        counts={{ mine: referrals.length, waitlist: wlEntries.filter((e) => e.status === "waiting").length, pendingInvites }}
        canManage={canManage} onSignOut={signOut} />
      <div className="main">
        <header className="topbar">
          <div className="tb-title">
            <span className="tic">{tabMeta.i}</span>
            <div><h1>{tabMeta.t}</h1></div>
          </div>
          <div className="tb-right">
            {/* Годинник — за часом центру (перший доступний): направник глобальний,
                singleton setClinicTz тут не виставляється. */}
            <span style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}><LiveClock tz={activeCenters[0]?.timezone || undefined} /></span>
            {/* Дубль кнопки з сайдбару: на вузькому екрані сайдбар згортається,
                і єдиний вихід із порталу зникав би разом із ним. */}
            {backHref && (
              <a href={backHref} className="btn btn-secondary btn-sm" title={"Повернутися до робочого місця: " + (backLabel || "мій центр")}>
                <span aria-hidden>←</span> {backLabel || "Мій центр"}
              </a>
            )}
            <CeoDashboardLink />
          </div>
        </header>
        <div className="content" style={{ flex: 1 }}>
        {tab === "new" && (
          <NewReferral activeCenters={activeCenters} roomsByClinic={roomsByClinic} servicesByClinic={servicesByClinic} roomOverridesByClinic={roomOverridesByClinic} doctorName={doctorName} doctorId={doctorId}
            onCreated={(nm, err) => { if (err) notify("Помилка: " + err, "error"); else { notify("Направлення відправлено: " + nm, "success"); reload(); setTab("mine"); } }}
            onCaseCreated={(caseId, clinicId, nm) => { notify("Кейс створено: " + nm, "success"); reload(); setTab("mine"); openCaseScreen(caseId, clinicId); }} />
        )}
        {tab === "mine" && (
          <>
            {/* Збій читання ≠ «направлень немає»: інакше лікар вирішить, що пацієнт
                не записаний, і запише його вдруге. */}
            {listErr && (
              <div className="ctx-hint red" style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }} role="alert">
                <span>⚠ Список направлень не завантажився — показане може бути неповним.</span>
                <button className="btn btn-secondary btn-sm" onClick={() => { reload(); reloadWaitlist(); }}>↻ Спробувати ще раз</button>
              </div>
            )}
            {/* roomsByClinic — ПОВНИЙ (назва кабінету в рядку направлення),
                visRoomsByClinic — лише для випадайки «Кабінет» у фільтрі. */}
            <ReferrerBoard referrals={referrals} activeCenters={activeCenters} centersById={centersById} roomsByClinic={roomsByClinic} visRoomsByClinic={visRoomsByClinic} doctorId={doctorId}
              focus={boardFocus}
              onReschedule={(r) => setReschedFor(r)} onCancel={(r) => setCancelAsk(r)} onEditPatient={(r) => setEditPatientFor(r)} onEditStudies={(r) => setEditStudiesFor(r)}
              onOpenCase={openCaseScreen} onOrganizeCase={startOrganize} />
          </>
        )}
        {tab === "waitlist" && (
          <MyWaitlist entries={wlEntries} centersById={centersById} onOpenAdd={() => setWlAddOpen(true)}
            onEdit={(e) => setWlEditFor(e)} onCancel={(e) => setWlConfirmRemove(e)} onRestore={wlRestore} onPriority={wlPrio} />
        )}
        {tab === "centers" && (
          <MyCenters centers={centers} canManage={canManage} onChanged={onCentersChanged} notify={notify} />
        )}
        {tab === "profile" && canManage && (
          <MyProfile doctorId={doctorId} notify={notify} onSaved={() => router.refresh()} />
        )}
        </div>
      </div>

      {reschedFor && (
        <RescheduleModal patient={reschedFor} rooms={reschedRooms} clinicId={reschedFor.clinic_id} clinicTz={centersById[reschedFor.clinic_id]?.timezone} onClose={() => setReschedFor(null)} onConfirm={doReschedule} />
      )}
      {editStudiesFor && (
        <StudyEditModal patient={editStudiesFor} scheduledDate={editStudiesFor.scheduled_date} rooms={roomsByClinic[editStudiesFor.clinic_id] || []} clinicId={editStudiesFor.clinic_id} clinicTz={centersById[editStudiesFor.clinic_id]?.timezone} services={servicesByClinic[editStudiesFor.clinic_id]} roomOverrides={roomOverridesByClinic[editStudiesFor.clinic_id]} onClose={() => setEditStudiesFor(null)} onConfirm={doEditStudies} />
      )}
      {wlAddOpen && (
        <WaitlistModal centers={activeCenters.map((c) => ({ clinicId: c.clinicId, name: centerLabel(c), modalities: centerModalities(c) }))}
          servicesByCenter={servicesByClinic}
          roomOverridesByCenter={roomOverridesByClinic}
          onClose={() => setWlAddOpen(false)} onSave={wlAdd} />
      )}
      {wlEditFor && (
        <WaitlistModal initial={wlEditFor}
          allowedModalities={centersById[wlEditFor.clinic_id] ? centerModalities(centersById[wlEditFor.clinic_id]) : undefined}
          servicesByCenter={servicesByClinic}
          roomOverridesByCenter={roomOverridesByClinic}
          onClose={() => setWlEditFor(null)} onSave={wlEditSave} />
      )}
      {cancelAsk && (
        <ConfirmDialog title="Скасувати направлення?"
          text={<>Запис <b style={{ color: "var(--text)" }}>{cancelAsk.patient_name}</b> о <b style={{ color: "var(--text)" }}>{cancelAsk.scheduled_time}</b> буде скасовано, слот звільниться. Повернути можна лише новим направленням.</>}
          confirmLabel="✕ Скасувати направлення" cancelLabel="Залишити" danger busy={cancelBusy}
          onConfirm={async () => {
            const p = cancelAsk;
            if (!p) return;
            setCancelBusy(true);
            await doCancel(p);
            setCancelBusy(false);
            setCancelAsk(null);
          }}
          onClose={() => setCancelAsk(null)} />
      )}
      {wlConfirmRemove && (
        <ConfirmDialog title="Зняти з листа очікування"
          text={<>Зняти <b style={{ color: "var(--text)" }}>{wlConfirmRemove.patient_name}</b> з листа очікування? Запис можна буде повернути.</>}
          confirmLabel="Зняти з листа" danger
          onConfirm={async () => { const p = wlConfirmRemove; setWlConfirmRemove(null); await wlCancel(p); }}
          onClose={() => setWlConfirmRemove(null)} />
      )}
      {editPatientFor && (
        <PatientEditModal entryId={editPatientFor.id} canEditPriority onClose={() => setEditPatientFor(null)} onSaved={reload} />
      )}
      {/* 0118: екран СВОГО кейса (referralMode: дії через referral-обгортки). */}
      {openCase && (
        <CaseModal caseId={openCase.caseId} referralMode
          rooms={grantedRooms(openCase.clinicId)} clinicId={openCase.clinicId}
          clinicTz={centersById[openCase.clinicId]?.timezone} incidents={openCase.incidents}
          services={servicesByClinic[openCase.clinicId]} roomOverrides={roomOverridesByClinic[openCase.clinicId]}
          onClose={() => setOpenCase(null)} onCancelled={() => { notify("Кейс скасовано", "info"); reload(); }} />
      )}
      {/* 0118: «Організувати кейс» — крок іншої модальності до свого запису. */}
      {organizeFor && (
        <BookingModal
          rooms={grantedRooms(organizeFor.r.clinic_id)} clinicId={organizeFor.r.clinic_id}
          clinicTz={centersById[organizeFor.r.clinic_id]?.timezone} incidents={organizeFor.incidents}
          services={servicesByClinic[organizeFor.r.clinic_id]} roomOverrides={roomOverridesByClinic[organizeFor.r.clinic_id]}
          prefill={{
            name: organizeFor.r.patient_name || "", phone: organizeFor.r.patient_phone || "",
            priority: organizeFor.r.priority_level || "planned",
            // Крок кейса — той самий візит: відкриваємо день вихідного запису.
            date: organizeFor.r.scheduled_date || undefined,
          }}
          caseSiblings={organizeFor.r.room_id && organizeFor.r.scheduled_date && organizeFor.r.scheduled_time
            ? [{ roomId: organizeFor.r.room_id, date: new Date(organizeFor.r.scheduled_date + "T00:00:00"), time: String(organizeFor.r.scheduled_time).slice(0, 5), dur: organizeFor.r.duration_min ?? 0 }]
            : []}
          onAddCaseStep={doOrganize}
          onSave={() => {}}
          onClose={() => setOrganizeFor(null)}
        />
      )}
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
