"use client";

/* ===== RadFlow — Новий запис (повна модалка) =====
   Портовано з queue-app.jsx (NewBookingModal + BookingCalendar + DobField).
   Кабінети беруться з БД (rooms), зайняті слоти — з Supabase (queue_entries). */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import AddDoctorModal from "@/components/AddDoctorModal";
import ConfirmDialog from "@/components/ConfirmDialog";
import PhoneInput from "@/components/PhoneInput";
import {
  roomScheduleFor, effectiveRoomBreaks, inBreak, breakClash, offScheduleKind, OFF_SCHED_GRACE_MIN,
  type DayOverride,
} from "@/lib/schedule";
import { incidentEffectiveEnd, wallNow, wallMinOfDay, wallToday0, type IncidentLike } from "@/lib/incidents";
import { useRoomBusy, busyAt, busyTooltip } from "@/lib/slotBusy";
import { CONTRAST_SURCHARGE, CONTRAST_DUR, BUFFER_DEFAULT, BUFFER_OPTIONS, studyLabel, normDur, BOOKABLE_MODALITIES, modalityLabel, modalityShort, modalityKind, modalityCode } from "@/lib/studies";
import { buildCatalog, overridesToMap, type ServiceLike, type RoomOverrideRow } from "@/lib/catalog";
import { PRIORITY_OPTIONS, PRIORITY_META, type PatientPriority } from "@/lib/priority";
import { useModalA11y } from "@/lib/useModalA11y";
import { countFit } from "@/lib/slots";
import SlotPicker from "@/components/SlotPicker";
import HelpTip from "@/components/HelpTip";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null };
type DocOpt = { id: string; name: string; spec?: string | null; clinic_name?: string | null; phone?: string | null };
type ExtraStudy = { type: string; region: string; dur: number };
type StudyOut = { type: string; region: string; contrast?: boolean; dur: number; price: number | null };
export type BookingPayload = {
  name: string; phone: string; email: string | null; age: number; dob: string;
  weight: number | null; gender: string; proc: string; dur: number; buffer: number; studies: StudyOut[];
  roomId: string; date: Date; time: string; notes: string | null;
  hasContra: boolean; priority: PatientPriority; doctor: string | null; referrerId: string | null;
  // 0077: оператор ПІДТВЕРДИВ роботу поза графіком (після закриття / у перерву).
  // Це лише «згода», а не «слот поза графіком»: що писати в БД — вирішує сервер.
  offSchedule?: boolean;
};
type ParsedDob = { ok: false; partial?: boolean; err?: string } | { ok: true; iso: string };

/** Передзаповнення форми (напр. запис пацієнта з листа очікування). */
export type BookingPrefill = {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  dob?: string | null; // YYYY-MM-DD
  gender?: string | null; // 'М' | 'Ж'
  weight?: number | null;
  hasContra?: boolean;
  priority?: PatientPriority | null;
  notes?: string | null;
  buffer?: number | null;
  studies?: Array<{ type?: string; region?: string; contrast?: boolean; dur?: number }> | null;
  // Слот, що звільнився (підказка кандидатів): одразу підставляємо кабінет/дату/час.
  roomId?: string | null;
  date?: string | null; // YYYY-MM-DD
  time?: string | null; // HH:MM
};

/* ── Дати ── */
const WK_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
const MONTHS_NOM = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const MONTHS_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
/* «Сьогодні» — за настінним часом КЛІНІКИ (singleton setClinicTz виставляють дошки
   синхронно з пропа clinicTz). Раніше це був день браузера, і в центрі іншої зони
   календар відкривався на день, який ТАМ уже минув. Де є явна зона (bookDate) —
   передаємо її аргументом, не покладаючись на singleton. */
export function today0() { return wallToday0(); }
export function sameDay(a: Date, b: Date) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function dowMon(d: Date) { return (d.getDay() + 6) % 7; }
export function fmtShort(d: Date) { return d.getDate() + " " + MONTHS_GEN[d.getMonth()]; }
function dateKey(d: Date) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }

/* ── Слоти часу ── */
const BK_START = 8 * 60, BK_END = 18 * 60, BK_STEP = 5; // крок вибору слота — 5 хв (сітка групується у 30-хв блоки в SlotPicker)
function toMin(t: string) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function fmtMin(min: number) { return String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0"); }
function slotsList(startMin = BK_START, endMin = BK_END) {
  const out: string[] = [];
  const s0 = Math.ceil(startMin / BK_STEP) * BK_STEP;
  for (let m = s0; m < endMin; m += BK_STEP) out.push(fmtMin(m));
  return out;
}

/* ── Дата народження ── */
function dobFmt(s: string | null | undefined) { if (!s) return ""; const p = String(s).split("-"); return p.length === 3 ? p[2] + "." + p[1] + "." + p[0] : s; }
function dobMask(raw: string) {
  const d = String(raw).replace(/\D/g, "").slice(0, 8);
  let out = d.slice(0, 2);
  if (d.length >= 3) out += "." + d.slice(2, 4);
  if (d.length >= 5) out += "." + d.slice(4, 8);
  return out;
}
function parseDob(text: string): ParsedDob {
  const m = String(text).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return { ok: false, partial: true };
  const dd = +m[1], mm = +m[2], yyyy = +m[3];
  const t = today0();
  if (mm < 1 || mm > 12) return { ok: false, err: "Некоректний місяць" };
  if (dd < 1 || dd > 31) return { ok: false, err: "Некоректний день" };
  const dt = new Date(yyyy, mm - 1, dd);
  if (dt.getFullYear() !== yyyy || dt.getMonth() !== mm - 1 || dt.getDate() !== dd) return { ok: false, err: "Такої дати не існує" };
  if (dt > t) return { ok: false, err: "Дата в майбутньому" };
  if (yyyy < t.getFullYear() - 120) return { ok: false, err: "Перевірте рік (вік > 120)" };
  return { ok: true, iso: yyyy + "-" + m[2] + "-" + m[1] };
}

export function DobField({ value, onChange, invalid }: { value: string; onChange: (v: string) => void; invalid?: boolean }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => dobFmt(value));
  const [err, setErr] = useState("");
  const t = today0();
  const base = value ? new Date(value + "T00:00:00") : new Date(t.getFullYear() - 30, t.getMonth(), 1);
  const [viewMonth, setViewMonth] = useState(() => new Date(base.getFullYear(), base.getMonth(), 1));
  const shift = (n: number) => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  const shiftYear = (n: number) => setViewMonth((m) => new Date(m.getFullYear() + n, m.getMonth(), 1));

  function onType(raw: string) {
    const masked = dobMask(raw);
    setText(masked);
    if (masked.length < 10) { setErr(""); onChange(""); return; }
    const res = parseDob(masked);
    if (res.ok) { setErr(""); onChange(res.iso); const d = new Date(res.iso + "T00:00:00"); setViewMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }
    else { setErr(res.err || "Некоректна дата"); onChange(""); }
  }
  function openCal() {
    if (value) { const d = new Date(value + "T00:00:00"); setViewMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }
    setOpen((o) => !o);
  }
  const y = viewMonth.getFullYear(), mo = viewMonth.getMonth();
  const first = new Date(y, mo, 1);
  const days = new Date(y, mo + 1, 0).getDate();
  const startIdx = dowMon(first);
  const label = MONTHS_NOM[mo] + " " + y;
  const sel = value ? new Date(value + "T00:00:00") : null;
  const cells: (number | null)[] = [];
  for (let i = 0; i < startIdx; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  function pick(d: number) {
    const cd = new Date(y, mo, d);
    const iso = cd.getFullYear() + "-" + String(cd.getMonth() + 1).padStart(2, "0") + "-" + String(cd.getDate()).padStart(2, "0");
    onChange(iso); setText(dobFmt(iso)); setErr(""); setOpen(false);
  }
  return (
    <div className="bk-dob">
      <div className="bk-dob-field">
        <input className={"inp bk-dob-input" + (err || invalid ? " bk-dob-inv" : "")} type="text" inputMode="numeric"
          placeholder="дд.мм.рррр" value={text} maxLength={10} onChange={(e) => onType(e.target.value)} />
        <button type="button" className={"bk-dob-ic-btn" + (open ? " open" : "")} onClick={openCal} title="Обрати в календарі">🗓</button>
      </div>
      {err && <span className="bk-dob-err">⚠ {err}</span>}
      {open && (
        <>
          <div className="bk-dob-backdrop" onClick={() => setOpen(false)} />
          <div className="bk-dob-pop">
            <div className="cal-head">
              <div className="cal-nav">
                <button type="button" className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shiftYear(-1)} title="Попередній рік">«</button>
                <button type="button" className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shift(-1)} title="Попередній місяць">‹</button>
              </div>
              <span className="cal-month">{label}</span>
              <div className="cal-nav">
                <button type="button" className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shift(1)} title="Наступний місяць">›</button>
                <button type="button" className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shiftYear(1)} title="Наступний рік">»</button>
              </div>
            </div>
            <div className="cal-grid">
              {WK_SHORT.map((d) => <div className="cal-dow" key={d}>{d}</div>)}
              {cells.map((d, i) => {
                if (d === null) return <div className="cal-day empty-day" key={"e" + i} />;
                const cd = new Date(y, mo, d);
                const isSel = sel && sameDay(cd, sel);
                const isToday = sameDay(cd, t);
                const future = cd > t;
                return (
                  <button type="button" key={d} disabled={future}
                    className={"cal-day" + (isSel ? " selected" : "") + (isToday && !isSel ? " today" : "") + (future ? " muted" : "")}
                    onClick={() => !future && pick(d)}>{d}</button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* today — «сьогодні» В ТАЙМЗОНІ КЛІНІКИ (не браузера). Якщо не передати, впадемо
   на дату браузера: у центрі іншої зони це відкривало день, який ТАМ уже минув,
   і всі його слоти малювались вільними (isBookToday рахувався по браузеру, а
   nowMin — по клініці: два різні фрейми часу в одній перевірці). */
export function BookingCalendar({ value, onPick, today }: { value: Date; onPick: (d: Date) => void; today?: Date }) {
  const t = today || today0();
  const [viewMonth, setViewMonth] = useState(() => new Date(value.getFullYear(), value.getMonth(), 1));
  const shift = (n: number) => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  const y = viewMonth.getFullYear(), mo = viewMonth.getMonth();
  const first = new Date(y, mo, 1);
  const days = new Date(y, mo + 1, 0).getDate();
  const startIdx = dowMon(first);
  const label = MONTHS_NOM[mo] + " " + y;
  const cells: (number | null)[] = [];
  for (let i = 0; i < startIdx; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  return (
    <div className="bk-cal">
      <div className="cal-head">
        <span className="cal-month">{label}</span>
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
          const isToday = sameDay(cd, t);
          const isSel = sameDay(cd, value);
          const isSunday = cd.getDay() === 0;
          const isPast = cd < t;
          /* Неділю більше НЕ блокуємо жорстко: робочі дні кабінету тепер беруться
             з rooms.schedule (аудит 2026-07-11). Якщо кабінет у цей день не працює,
             сітка слотів покаже банер «🚫 Кабінет не працює». Блокуємо лише минуле. */
          const disabled = isPast;
          return (
            <button className={"cal-day" + (isToday ? " today" : "") + (isSel && !isToday ? " selected" : "") + (disabled ? " muted" : "") + (isSunday && !isPast ? " holiday" : "")}
              key={d} disabled={disabled} onClick={() => !disabled && onPick(cd)}>
              {d}{!disabled && <span className="cdot" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface BookingModalProps {
  rooms?: RoomOpt[];
  clinicId?: string | null;
  /** IANA-зона центру. Передавати ЯВНО: модальний _clinicTz виставляють не всі
      екрани (напр. /waitlist), і тоді «зараз» рахувалося б по браузеру. */
  clinicTz?: string | null;
  incidents?: IncidentLike[];
  /** Каталог послуг центру (services, 0107). Порожній/відсутній → статичний
      lib/studies (фолбэк). Області/тривалості/ціни беруться звідси (фаза 2a). */
  services?: ServiceLike[];
  /** Переозначення каталогу по кабінетах (service_room_overrides, 0108). При
      обраному кабінеті ціна/тривалість/склад беруться per-room поверх бази центру
      (фаза 2b). Порожній/відсутній → база центру. */
  roomOverrides?: RoomOverrideRow[];
  prefill?: BookingPrefill | null; // напр. запис із листа очікування
  onClose: () => void;
  /* Повертає ТЕКСТ ПОМИЛКИ (або null, якщо збережено). Раніше було `=> void`, і при
     відмові сервера («слот щойно зайняли», перетин через опівніч тощо) модалка
     лишалась відкритою, а тост із помилкою малювався на дошці ПІД оверлеєм
     (z-index 100 проти 200) — користувач тиснув «Зберегти» і не бачив нічого.
     Тепер помилку показує сама модалка. Заразом це закриває M-6: поки запит
     у польоті, кнопка заблокована (подвійний клік більше не створює дубль). */
  onSave: (b: BookingPayload) => Promise<string | null> | void;
  /** Пакетний режим (кейс): якщо передано, зʼявляється «＋ У кейс» / «Створити кейс».
      Приймає накопичені кроки різних модальностей → одна атомарна дія createCase. */
  onCreateCase?: (steps: BookingPayload[]) => Promise<string | null> | void;
  /** Режим «додати крок до вже створеного кейса»: якщо передано, замість
      «Зберегти запис» — «Додати крок до кейса» (addCaseStep), а сітка/блок кабінету
      враховують УЖЕ наявні кроки кейса (caseSiblings). Пакетний бар не показуємо. */
  onAddCaseStep?: (b: BookingPayload) => Promise<string | null> | void;
  /** Наявні (активні) кроки кейса — для контролю пересічень у режимі onAddCaseStep:
      той самий кабінет заблоковано, зайнятий іншим кроком час — casebusy у сітці. */
  caseSiblings?: { roomId: string; date: Date; time: string; dur: number }[];
}

export default function BookingModal({ rooms, clinicId, clinicTz, incidents = [], services, roomOverrides, prefill, onClose, onSave, onCreateCase, onAddCaseStep, caseSiblings }: BookingModalProps) {
  // Dirty-guard: не втрачати заповнену форму при випадковому закритті (Esc/✕/Скасувати).
  // dirty вмикається будь-якою зміною поля (onChangeCapture на діалозі); requestClose
  // питає підтвердження лише коли є незбережені зміни. useModalA11y читає колбек через
  // ref (завжди свіжий), тож requestClose бачить актуальний dirty.
  const [dirty, setDirty] = useState(false);
  const [askClose, setAskClose] = useState(false);
  const requestClose = () => { if (dirty) setAskClose(true); else onClose(); };
  const dialogRef = useModalA11y<HTMLDivElement>(requestClose);
  // Каталог послуг центру (фаза 2a) + переозначення по кабінетах (фаза 2b): drop-in
  // шорткати з тими самими сигнатурами, що статичні lib/studies. Виклики нижче
  // передають roomId обраного кабінету → ціна/тривалість/склад per-room (0108).
  // Порожній каталог модальності → делегує статиці (див. lib/catalog.ts).
  const catalog = useMemo(() => buildCatalog(services, overridesToMap(roomOverrides)), [services, roomOverrides]);
  const regionsFor = catalog.regionsFor;
  const studyPrice = catalog.studyPrice;
  // Передзаповнення: перше дослідження → основне (тип/область/контраст), решта → додаткові.
  const pfStudies = Array.isArray(prefill?.studies) ? (prefill!.studies as NonNullable<BookingPrefill["studies"]>) : [];
  const pfPrimary = pfStudies[0] || null;
  /* Модальності, для яких у центрі Є кабінети (у порядку реєстру). Сегменти типу
     показуємо лише для них — не пропонуємо записати на модальність без обладнання. */
  const availableModalities = BOOKABLE_MODALITIES.filter((code) => (rooms || []).some((r) => r.modality === code));
  const pfCode = pfPrimary ? modalityCode(pfPrimary.type) : "";
  // studyType тепер тримає КОД модальності (MRI/CT/US/XRAY/MAMMO/OTHER), а не MRT/CT.
  const pfType: string = (pfCode && availableModalities.includes(pfCode)) ? pfCode : (availableModalities[0] || "MRI");
  const [name, setName] = useState(prefill?.name || "");
  const [dob, setDob] = useState(prefill?.dob || "");
  const [gender, setGender] = useState(prefill?.gender || "");
  const [weight, setWeight] = useState(prefill?.weight != null ? String(prefill.weight) : "");
  const [phone, setPhone] = useState(prefill?.phone || "");
  const [email, setEmail] = useState(prefill?.email || "");
  const [studyType, setStudyType] = useState(pfType);
  const [region, setRegion] = useState(pfPrimary?.region || "");
  const [contrast, setContrast] = useState(pfPrimary?.contrast === true);
  const [buffer, setBuffer] = useState<number>(prefill?.buffer ?? BUFFER_DEFAULT);
  const [hasContra, setHasContra] = useState(prefill?.hasContra === true);
  const [priority, setPriority] = useState<PatientPriority | "">(prefill?.priority || ""); // обов'язковий вибір при новій записі
  const [notes, setNotes] = useState(prefill?.notes || "");
  const [docs, setDocs] = useState<DocOpt[]>([]);
  const [doctorId, setDoctorId] = useState("");
  const [addDoc, setAddDoc] = useState(false);
  const [override, setOverride] = useState<DayOverride | null>(null);
  const [roomSchedule, setRoomSchedule] = useState<unknown>(null); // rooms.schedule обраного кабінету (для перерв)

  useEffect(() => {
    let cancel = false;
    (async () => {
      if (!clinicId) return;
      try {
        const supabase = createClient();
        const [docRes, accRes] = await Promise.all([
          supabase.from("doctors").select("id, name, spec, clinic_name, phone").eq("clinic_id", clinicId).order("name"),
          supabase.from("referral_access").select("referrer_id").eq("clinic_id", clinicId).eq("status", "active"),
        ]);
        const list: DocOpt[] = docRes.data || [];
        const seen = new Set(list.map((d) => (d.name || "").trim()));
        const refIds = Array.from(new Set((accRes.data || []).map((a) => a.referrer_id)));
        if (refIds.length) {
          const { data: profs } = await supabase.from("profiles").select("id, full_name").in("id", refIds);
          (profs || []).forEach((pr) => { const n = (pr.full_name || "").trim(); if (n && !seen.has(n)) { seen.add(n); list.push({ id: "ref:" + pr.id, name: n, spec: "направник" }); } });
        }
        list.sort((a, b) => (a.name || "").localeCompare(b.name || "", "uk"));
        if (!cancel) setDocs(list);
      } catch {
        // Транзієнтний збій мережі — модалка лишається робочою (конвенція проєкту).
      }
    })();
    return () => { cancel = true; };
  }, [clinicId]);

  const roomsOfType = (code: string) => (rooms || []).filter((r) => r.modality === code);
  // Авто-вибір лише коли кабінет один; якщо їх кілька — користувач обирає вручну.
  // Передзаповнений слот (кандидат на вікно, що звільнилося) має пріоритет; кабінет
  // приймаємо лише якщо він підходить за модальністю дослідження.
  const [roomId, setRoomId] = useState(() => {
    const l = roomsOfType(pfType);
    if (prefill?.roomId && l.some((r) => r.id === prefill.roomId)) return prefill.roomId;
    return l.length === 1 ? l[0].id : "";
  });
  const [bookDate, setBookDate] = useState(() => {
    const t0 = wallToday0(clinicTz || undefined);   // день КЛІНІКИ, не браузера
    if (prefill?.date) { const d = new Date(prefill.date + "T00:00:00"); if (!isNaN(d.getTime()) && d >= t0) return d; }
    return t0;
  });
  const [time, setTime] = useState(prefill?.date && prefill?.time ? prefill.time : "");
  const [schedLoading, setSchedLoading] = useState(true); // графік + перерви кабінету (зайнятість — окремий хук)
  const [schedErr, setSchedErr] = useState(false);

  const allRegions = regionsFor(studyType, roomId);
  const regions = contrast ? allRegions.filter((r) => r.contrast) : allRegions;
  const primaryKind = modalityLabel(studyType); // укр. текст, який кладеться в studies[].type

  function changeType(code: string) {
    setStudyType(code); setRegion(""); setContrast(false); setTime("");
    const list = roomsOfType(code);
    setRoomId(list.length === 1 ? list[0].id : "");
    const k = modalityLabel(code);
    setExtraStudies((a) => a.map((s) => (s.type === k ? s : { ...s, type: k, region: "", dur: exDur(k, "") })));
  }
  function toggleContrast(v: boolean) {
    setContrast(v);
    if (v && region && !allRegions.some((r) => r.label === region && r.contrast)) { setRegion(""); setTime(""); }
  }
  function calcAge(d: string) { if (!d) return 0; const b = new Date(d); if (isNaN(b.getTime())) return 0; const n = new Date(); let a = n.getFullYear() - b.getFullYear(); const m = n.getMonth() - b.getMonth(); if (m < 0 || (m === 0 && n.getDate() < b.getDate())) a--; return a < 0 ? 0 : a; }

  const contrastSuffix = contrast ? " з контрастом" : "";
  const procLabel = region ? `${primaryKind} · ${region}${contrastSuffix}` : primaryKind;
  const regionObj = regions.find((r) => r.label === region);
  const computedDur = regionObj ? (regionObj.dur == null ? 0 : regionObj.dur + (contrast ? CONTRAST_DUR : 0)) : (allRegions[0]?.dur ?? 20);
  const price = regionObj ? regionObj.price + (contrast ? (regionObj.contrastPrice ?? CONTRAST_SURCHARGE) : 0) : null;
  const fmtPrice = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₴";

  const [durEdit, setDurEdit] = useState("");
  // Передзаповнена тривалість (може бути кастомною) — застосовується один раз при відкритті.
  const pfDurRef = useRef<number | null>(pfPrimary?.dur ?? null);
  useEffect(() => {
    if (!region) return;
    if (pfDurRef.current != null) { setDurEdit(String(pfDurRef.current)); pfDurRef.current = null; return; }
    // 0117: час області «—» → порожнє поле (ручний ввід), НЕ "0".
    setDurEdit(computedDur > 0 ? String(computedDur) : "");
  }, [region, contrast, studyType, roomId]); // eslint-disable-line react-hooks/exhaustive-deps -- зміна кабінету пересчитує дефолтну тривалість (per-room 0108)
  // Realtime-зміна каталожної тривалості (та сама область/кабінет): підхоплюємо новий
  // default, ЛИШЕ якщо оператор не редагував поле вручну (durEdit === попередній
  // default). Ручну правку зберігаємо. (0111 realtime каталогу.)
  const prevDefDurRef = useRef<number>(computedDur);
  useEffect(() => {
    const prev = prevDefDurRef.current;
    prevDefDurRef.current = computedDur;
    if (region && durEdit === String(prev) && String(prev) !== String(computedDur)) setDurEdit(computedDur > 0 ? String(computedDur) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- лише на realtime-зміну каталожного default
  }, [computedDur]);
  // Обрана область стала НЕДОСТУПНОЮ (прихована в кабінеті per-room 0108, АБО
  // адмін вимкнув послугу — realtime-refresh каталогу 0111) → знімаємо вибір і час.
  // Ключ ефекту — підпис набору доступних областей (не лише roomId): інакше при
  // realtime-правці каталогу форма лишалася б із «фантомно обраною» закритою
  // послугою (Nielsen «запобігання помилок»/«видимість стану»; сервер теж ріже).
  const availSig = regionsFor(studyType, roomId).map((r) => r.label + "|" + (r.contrast ? "1" : "0")).join("");
  useEffect(() => {
    const avail = regionsFor(studyType, roomId);
    if (region && !avail.some((r) => r.label === region)) { setRegion(""); setTime(""); }
    // Область ще доступна, але контраст їй вимкнули в каталозі (contrast_allowed=false,
    // realtime) → знімаємо флаг контрасту, інакше payload/ціна лишаються з контрастом.
    else if (region && contrast) { const sel = avail.find((r) => r.label === region); if (sel && !sel.contrast) { setContrast(false); setTime(""); } }
    setExtraStudies((a) => a.map((s) => (s.region && !avail.some((r) => r.label === s.region) ? { ...s, region: "", dur: 0 } : s)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- перезапуск при зміні набору доступних областей / контрасту (кабінет АБО realtime-каталог)
  }, [availSig]);
  // H-1: кратно 5 і в межах 5..480 — інакше «47» їхало в БД (ламає сітку слотів),
  // а «0» взагалі обходив анти-овербукінг (порожній tstzrange). CHECK у 0066 — останній рубіж.
  // 0117: область з часом «—» і порожнє поле → 0 БЕЗ normDur-фолбеку (він давав
  // фіктивні 30 хв, ревью H1) — збереження блокує miss.dur, доки час не введено.
  const durRaw = parseInt(durEdit, 10) || computedDur;
  const dur = durRaw > 0 ? normDur(durRaw) : 0;
  const durCustom = region && parseInt(durEdit, 10) && parseInt(durEdit, 10) !== computedDur;

  const [extraStudies, setExtraStudies] = useState<ExtraStudy[]>(() =>
    pfStudies.slice(1).filter((s) => s?.region).map((s) => ({
      type: modalityLabel(s.type),
      region: s.region as string,
      dur: Number(s.dur) || (regionsFor(s.type, roomId)[0]?.dur ?? 0),
    }))
  );
  const exRegions = (t: string) => regionsFor(t, roomId);
  // Область не обрана → 0 (не «дефолт першої області»): порожнє дослідження НЕ
  // повинно додавати час у слот/сітку, поки область справді не вибрана.
  const exDur = (t: string, reg: string) => { const o = exRegions(t).find((r) => r.label === reg); return o ? (o.dur ?? 0) : 0; };
  const exPatch = (i: number, p: Partial<ExtraStudy>) => setExtraStudies((a) => a.map((r, idx) => (idx === i ? { ...r, ...p } : r)));
  const exSetRegion = (i: number, reg: string) => { const r = extraStudies[i]; exPatch(i, { region: reg, dur: exDur(r.type, reg) }); };
  const exSetDur = (i: number, v: string) => exPatch(i, { dur: Math.max(5, parseInt(v, 10) || 0) });
  const exAdd = () => setExtraStudies((a) => [...a, { type: primaryKind, region: "", dur: exDur(primaryKind, "") }]);
  const exRemove = (i: number) => setExtraStudies((a) => a.filter((_, idx) => idx !== i));
  const validExtra = extraStudies.filter((s) => s.region);

  const primaryStudy: StudyOut | null = region ? { type: primaryKind, region, contrast: contrast === true, dur, price: studyPrice(primaryKind, region, contrast, roomId) } : null;
  const allStudies: StudyOut[] = (primaryStudy ? [primaryStudy] : []).concat(validExtra.map((s) => ({ type: s.type, region: s.region, dur: Number(s.dur) || 0, price: studyPrice(s.type, s.region, false, roomId) })));
  const combinedLabel = allStudies.length ? allStudies.map(studyLabel).join(" + ") : procLabel;
  const slotDur = dur + validExtra.reduce((s, x) => s + (Number(x.dur) || 0), 0);

  /* зайняті слоти обраного кабінету на обрану дату — з Supabase.
     Поки не завантажено — сітку показуємо як «завантаження», а не «усе вільно». */
  const dateKeyStr = dateKey(bookDate);
  const schedReqRef = useRef(0); // гонка: відповідь по старому кабінету/даті не має перетирати нову
  const loadSched = useCallback(async () => {
    const req = ++schedReqRef.current;
    try {
      const supabase = createClient();
      if (clinicId) {
        const ovRes = await supabase.from("schedule_overrides").select("all_closed, label, rooms").eq("clinic_id", clinicId).eq("override_date", dateKeyStr).maybeSingle();
        if (ovRes.error) throw ovRes.error;
        if (req !== schedReqRef.current) return;
        setOverride((ovRes.data as unknown as DayOverride) || null);
      }
      if (!roomId) { if (req === schedReqRef.current) { setRoomSchedule(null); setSchedErr(false); } return; }
      const roomRes = await supabase.from("rooms").select("schedule").eq("id", roomId).maybeSingle();
      if (roomRes.error) throw roomRes.error; // інакше сітка тихо повернеться до хардкоду «Пн–Сб 08–18»
      if (req !== schedReqRef.current) return;
      setRoomSchedule((roomRes.data as { schedule?: unknown } | null)?.schedule ?? null);
      setSchedErr(false);
    } catch {
      // Транзієнтний збій — модалку не рушимо, але й сітку не малюємо (конвенція проєкту).
      if (req === schedReqRef.current) setSchedErr(true);
    } finally {
      if (req === schedReqRef.current) setSchedLoading(false);
    }
  }, [roomId, dateKeyStr, clinicId]);

  useEffect(() => { setSchedLoading(true); loadSched(); }, [loadSched]);

  /* Зайнятість — через RPC room_busy_slots (спільний хук + realtime), а НЕ прямим
     select із queue_entries. Дві причини:
       • ПІБ/дослідження зайнятих слотів має віддавати сервер лише адміну та
         радіологу (гейт у 0062) — інакше правило трималося б на UI-прапорці, а
         дані реєстратора все одно летіли б у браузер;
       • RPC уже рахує окупацію in_progress від ФАКТИЧНОГО старту (0060) — не
         треба дублювати цю арифметику на клієнті. */
  const { spans: roomBusy, loading: busyLoading, error: busyError } = useRoomBusy({ roomId, dateStr: dateKeyStr });
  const slotsLoading = busyLoading || schedLoading;

  /* Свіжість зайнятості кабінету. useRoomBusy лишає СТАРІ spans до кінця
     перезавантаження, а busySpans() щоразу віддає новий масив — тож при зміні
     кабінету (напр. вхід у правку кроку кейса) є один кадр зі старими spans ще
     ДО того, як busyLoading встигне стати true. На ньому авто-зняття слота (taken)
     помилково гасило свій же валідний слот як «щойно зайняли». Фіксуємо ключ
     кабінету/дати, для якого зайнятість ГАРАНТОВАНО довантажилась (перехід
     busyLoading true→false), і зіставляємо його перед авто-зняттям. */
  const roomDateKey = (roomId || "") + "|" + dateKeyStr;
  const busyFreshRef = useRef<string | null>(null);
  const prevBusyLoadingRef = useRef(busyLoading);
  useEffect(() => {
    if (prevBusyLoadingRef.current && !busyLoading && roomId) busyFreshRef.current = roomDateKey;
    prevBusyLoadingRef.current = busyLoading;
  }, [busyLoading, roomDateKey, roomId]);

  /* Один фрейм часу на всю модалку — НАСТІННИЙ час клініки (clinics.timezone).
     Було: nowMin по клініці, а «сьогодні» (today0) по браузеру — при розбіжності
     зон перевірка «past» або вимикалась, або зрізала майбутнє. */
  const _wNow = wallNow(clinicTz || undefined);
  const nowMin = wallMinOfDay(_wNow);
  const clinicToday = wallToday0(clinicTz || undefined); // «сьогодні» клініки (спільний хелпер)
  const isBookToday = sameDay(bookDate, clinicToday);
  const isPastDay = bookDate < clinicToday;
  const roomSched = roomScheduleFor(bookDate, roomId, override, roomSchedule); // базовий графік кабінету + override на дату
  const schedStartMin = toMin(roomSched.start), schedEndMin = toMin(roomSched.end);
  // Перерви кабінету на цю дату (обід тощо) — дослідження не може їх перетинати.
  const roomBreaks = effectiveRoomBreaks(bookDate, roomId, roomSchedule, override);

  // Простій (поломка/ТО) обраного кабінету: слоти у вікні інциденту — недоступні.
  const roomIncidents = (incidents || []).filter((i) => i.room_id === roomId);
  function slotBlockedByIncident(slotMin: number) {
    if (!roomIncidents.length) return false;
    const base = Date.UTC(bookDate.getFullYear(), bookDate.getMonth(), bookDate.getDate(), Math.floor(slotMin / 60), slotMin % 60);
    return roomIncidents.some((inc) => {
      const start = new Date(inc.started_at).getTime();
      return base >= start && base < incidentEffectiveEnd(inc);
    });
  }

  /* 0077 — ПОРЯДОК ПЕРЕВІРОК ТУТ Є ЧАСТИНОЮ БЕЗПЕКИ.
     Спершу все, що НЕ лікується підтвердженням (минуле, простій, зайнятість
     кабінету), і лише потім — «поза графіком». Якби offsched повертався раніше,
     оператор побачив би фіолетовий «можна з підтвердженням» слот поверх чужого
     запису, підтвердив би — і отримав відмову тригера. Класифікацію виходу за
     графік рахує offScheduleKind() — ТА САМА чиста функція, що й на сервері. */
  const [caseSteps, setCaseSteps] = useState<BookingPayload[]>([]);   // пакетний режим (кейс)
  // Редагування вже доданого кроку кейса: індекс кроку, форма якого зараз у полях
  // (null — режим «додати новий»). Оголошено ДО slotState/fitCount, бо сітка тепер
  // враховує зайнятість пацієнта в інших кроках кейса.
  const [editIndex, setEditIndex] = useState<number | null>(null);
  /* Вікна присутності пацієнта в ІНШИХ кроках кейса на цю дату (крок, що
     редагується, — виключаємо). Слот, що їх перетинає, для кейса не підходить:
     пацієнт не може бути у двох кабінетах одночасно (RPC 0094 відхилив би). Це
     лише візуальний гейт у сітці — остаточний рубіж усе одно в БД. */
  // У режимі «додати крок до кейса» контроль пересічень спирається на вже наявні
  // кроки кейса (caseSiblings, з БД), а не на пакетні caseSteps (їх тут немає).
  const siblingSteps = caseSiblings ?? [];
  const caseBusyWindows = [
    ...caseSteps.filter((cs, i) => i !== editIndex && sameDay(cs.date, bookDate)),
    ...siblingSteps.filter((cs) => sameDay(cs.date, bookDate)),
  ].map((cs) => { const st = toMin(cs.time); return { s: st, e: st + cs.dur }; });
  /* Кабінети, уже зайняті ІНШИМИ кроками кейса. Кейс — це РІЗНІ кабінети/модальності
     (0095): два кроки в одному кабінеті заборонені (кілька досліджень одного
     кабінету — це звичайний запис). Крок, що редагується, — виключаємо. */
  const caseRoomIds = [
    ...caseSteps.filter((_, i) => i !== editIndex).map((cs) => cs.roomId),
    ...siblingSteps.map((cs) => cs.roomId),
  ];
  const roomInCase = !!roomId && caseRoomIds.includes(roomId);

  function slotState(slot: string) {
    // e — кінець дослідження (має вміститись у графік); eBlock — з буфером (для перетину з іншими записами).
    const s = toMin(slot), eBlock = s + slotDur + buffer;
    if (isPastDay) return "past";  // день у минулому (за часом клініки) — весь закритий
    if (roomSched.closed) return "closed";
    if (slotBlockedByIncident(s)) return "blocked";
    if (isBookToday && s < nowMin) return "past";
    // Саме дослідження і буфер прибирання після нього — окремі стани: кабінет
    // зайнятий і там, і там, але видно, коли дослідження реально закінчується.
    if (roomBusy.some((b) => s >= b.s && s < b.eStudy)) return "busy";
    if (roomBusy.some((b) => s >= b.eStudy && s < b.e)) return "buffer";
    if (roomBusy.some((b) => s < b.e && b.s < eBlock)) return "tight";
    // Крос-модальний кейс: кабінет вільний, але пацієнт у цей час уже зайнятий
    // іншим кроком кейса (присутність = тривалість дослідження, без буфера).
    if (caseBusyWindows.some((w) => s < w.e && w.s < s + slotDur)) return "casebusy";
    const off = offScheduleKind(s, slotDur, roomSched, roomBreaks);
    if (off) return off.confirmable ? "offsched" : "offhours";
    return "free";
  }
  /** Обраний слот поза графіком? (null — у межах графіка) */
  const selOff = time ? offScheduleKind(toMin(time), slotDur, roomSched, roomBreaks) : null;
  const needsOffConfirm = !!selOff?.confirmable;
  function nextApptAfter(slot: string) {
    const s = toMin(slot);
    const after = roomBusy.filter((b) => b.s >= s).sort((a, b) => a.s - b.s)[0];
    return after ? fmtMin(after.s) : null;
  }
  function breakLabel(slot: string) {
    const br = inBreak(toMin(slot), roomBreaks);
    return br ? `Перерва в роботі кабінету · ${br.start}–${br.end}` : "Перерва в роботі кабінету";
  }
  /* Тултип зайнятої пʼятихвилинки. Деталі (статус/ПІБ/дослідження) з'являються,
     лише якщо їх віддав сервер — тобто для адміна та радіолога цього центру
     (гейт у RPC 0062). Реєстратор і направник бачать знеособлене «Зайнято». */
  function busyLabel(slot: string) {
    const b = busyAt(roomBusy, toMin(slot));
    if (!b) return "Зайнято";
    const inBuf = toMin(slot) >= b.eStudy;
    return (inBuf ? "Буфер після дослідження (кабінет ще зайнятий)\n" : "") + busyTooltip(b);
  }
  function blockedLabel(slot: string) {
    const s = toMin(slot);
    const base = Date.UTC(bookDate.getFullYear(), bookDate.getMonth(), bookDate.getDate(), Math.floor(s / 60), s % 60);
    const inc = roomIncidents.find((i) => base >= new Date(i.started_at).getTime() && base < incidentEffectiveEnd(i));
    const until = inc?.blocked_until ? new Date(inc.blocked_until).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) : null;
    return "Кабінет на ремонті/ТО" + (until ? "\nДо " + until : "\nДо відновлення");
  }
  // Причина «не вміщується» — у тому ж порядку, що й перевірки в slotState.
  function tightReason(slot: string) {
    const s = toMin(slot);
    const endLab = `кінець графіка (${fmtMin(schedEndMin)})`;
    if (s + slotDur > schedEndMin) return endLab;
    const br = breakClash(s, slotDur, roomBreaks);
    if (br) return `перерву ${br.start}–${br.end}`;
    const appt = nextApptAfter(slot);
    return appt ? `запис о ${appt}` : endLab;
  }
  // 0077 — тултип слота поза графіком: одразу пояснюємо, що буде потрібне підтвердження.
  function offSchedLabel(slot: string) {
    const off = offScheduleKind(toMin(slot), slotDur, roomSched, roomBreaks);
    if (!off) return slot;
    if (off.kind === "break" && off.brk) {
      return `Поза графіком · перерва ${off.brk.start}–${off.brk.end}\nЗаписати можна, але потрібне підтвердження`;
    }
    return `Поза графіком · кабінет працює до ${off.end}\nЗаписати можна, але потрібне підтвердження`;
  }
  /* Сітка добудовується на OFF_SCHED_GRACE_MIN за кінець графіка (0077): без цього
     слотів після закриття у сітці фізично немає — клікати нема по чому. Слоти далі
     стелі лишаються поза сіткою взагалі (offScheduleKind → too_late, не підтверджуваний). */
  const slots = slotsList(schedStartMin, schedEndMin + OFF_SCHED_GRACE_MIN);
  // Скільки ще досліджень цієї тривалості реально вміщується (жадібна укладка),
  // а не к-сть вільних 5-хв позицій — вони перетинаються і завищують число.
  const fitCount = countFit(slots, (s) => slotState(s) === "free", slotDur + buffer);
  const busyList = roomBusy.slice().sort((a, b) => a.s - b.s);

  // Режим «додати крок до кейса»: пацієнта бере зі знімка кейса add_case_step_rpc,
  // тож поля пацієнта у формі — лише передзаповнення, вони НЕ блокують збереження.
  const addMode = !!onAddCaseStep;
  const miss: Record<string, boolean> = { name: !addMode && !name.trim(), dob: !addMode && !dob, gender: !addMode && !gender, phone: !addMode && !phone.trim(), priority: !priority, region: !region, room: !roomId, time: !time, dur: !!region && dur < 5, exdur: validExtra.some((s) => (Number(s.dur) || 0) < 5) };
  const MISS_LABELS: Record<string, string> = { name: "ПІБ", dob: "Дата народження", gender: "Стать", phone: "Телефон", priority: "Пріоритет", region: "Область дослідження", room: "Кабінет", time: "Слот часу", dur: "Тривалість (хв)", exdur: "Тривалість додаткових досліджень" };
  const missingList = Object.keys(MISS_LABELS).filter((k) => miss[k]).map((k) => MISS_LABELS[k]);
  // 0077: «поза графіком» — теж легальний вибір, тому НЕ timeBad. Але зберегти
  // його можна лише з галочкою підтвердження (offOk) — див. valid нижче.
  // 0106: КРОКИ КЕЙСА — лише в межах графіка (case-RPC пишуть off_schedule=false,
  // а тригер графіка 0084 тепер бачить канонічний 'HH:MM' і реально їх перевіряє;
  // раніше 'HH:MM:SS' повз regex — слот «підтверджувався», а сервер усе одно
  // впав би). У режимі додавання кроку offsched-слот невибірний.
  const SELECTABLE = onAddCaseStep ? ["free"] : ["free", "offsched"];
  const timeBad = time ? !SELECTABLE.includes(slotState(time)) : false;
  const room = (rooms || []).find((r) => r.id === roomId) || null;
  const [offOk, setOffOk] = useState(false);
  // Вибрали інший слот / змінили тривалість → згода протухла, підтверджуємо заново.
  useEffect(() => { setOffOk(false); }, [time, roomId, slotDur, dateKeyStr]);
  const valid = missingList.length === 0 && roomId && !timeBad && !roomSched.closed
    && (!needsOffConfirm || offOk);

  /* Realtime: обраний слот зайняли, поки модалка була відкрита — знімаємо вибір
     і кажемо про це, а не даємо натиснути «Зберегти» й отримати помилку в лоб. */
  const [taken, setTaken] = useState<string | null>(null);
  useEffect(() => {
    if (!time || slotsLoading) return;
    // Зайнятість ще не підтверджена свіжою для ПОТОЧНОГО кабінету/дати — на кадрі
    // зі старими spans (зміна кабінету) свій же слот гасити не можна.
    if (busyFreshRef.current !== roomDateKey) return;
    if (!SELECTABLE.includes(slotState(time))) { setTaken(time); setTime(""); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomBusy, slotsLoading, timeBad]);

  // Запит у польоті + помилка сервера — показуємо тут, у модалці (див. onSave).
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  function buildPayload(): BookingPayload {
    const sel = docs.find((d) => String(d.id) === String(doctorId));
    return {
      name: name.trim(), phone, email: email.trim() || null,
      age: calcAge(dob), dob, weight: weight ? +weight : null, gender,
      proc: combinedLabel, dur: slotDur, buffer, studies: allStudies,
      roomId, date: bookDate, time, notes: notes.trim() || null,
      hasContra, priority: priority as PatientPriority, doctor: sel?.name || null,
      referrerId: sel && String(sel.id).startsWith("ref:") ? String(sel.id).slice(4) : null,
      offSchedule: needsOffConfirm && offOk,   // 0077 — згода оператора; рішення за сервером
    };
  }

  async function handleSave() {
    if (!valid || saving) return;   // M-6: подвійний клік не створює другий запис
    setSaving(true);
    setSaveErr(null);
    try {
      const err = await onSave(buildPayload());
      // Успіх → батько закриває модалку. Помилка → лишаємось відкритими й показуємо її.
      if (err) setSaveErr(err);
    } catch {
      setSaveErr("Не вдалося зберегти запис — спробуйте ще раз");
    } finally {
      setSaving(false);
    }
  }

  /* Додати крок до наявного кейса. Кабінет наявного кроку заблоковано (roomInCase),
     час іншого кроку — casebusy у сітці; остаточний рубіж — тригери 0095/0096. */
  async function handleAddCaseStep() {
    if (!onAddCaseStep || !valid || saving || roomInCase) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const err = await onAddCaseStep(buildPayload());
      if (err) setSaveErr(err);
    } catch {
      setSaveErr("Не вдалося додати крок — спробуйте ще раз");
    } finally {
      setSaving(false);
    }
  }

  /* Пакетний режим (кейс): «＋ У кейс» накопичує поточний крок і скидає крок-
     специфічне (лишаючи пацієнта) — оператор обирає наступну модальність; «Створити
     кейс» шле всі кроки однією атомарною дією createCase (create_case_rpc, 0093). */
  /* Скинути крок-специфічні поля (лишаючи пацієнта) — після додавання/оновлення. */
  function resetStepFields() {
    setRegion(""); setContrast(false); setExtraStudies([]); setTime(""); setDurEdit("");
  }

  /* «＋ У кейс» / «Оновити крок»: у режимі редагування ЗАМІНЮЄ крок editIndex,
     інакше додає новий. Далі — вихід із редагування і скидання полів кроку. */
  function addStepToCase() {
    if (!valid) return;
    // 0106: кейс — лише в графіку (create_case_rpc/add_case_step_rpc пишуть
    // off_schedule=false; слот «за графіком» сервер тепер відхиляє завжди).
    if (needsOffConfirm) {
      setSaveErr("Кроки кейса — лише в межах графіка кабінету. Оберіть слот у графіку.");
      return;
    }
    // Кейс = різні кабінети: не додаємо крок у кабінет, який уже є в кейсі (0095).
    if (editIndex === null && roomInCase) return;
    const p = buildPayload();
    setCaseSteps((arr) => (editIndex !== null ? arr.map((s, j) => (j === editIndex ? p : s)) : [...arr, p]));
    setEditIndex(null);
    resetStepFields();
  }

  /* Завантажити вже доданий крок назад у форму для редагування (час, дослідження,
     слот, кабінет, буфер, пріоритет тощо). Зворотне до buildPayload. Пацієнта НЕ
     чіпаємо — він спільний для кейса. */
  function loadStepForEdit(i: number) {
    const s = caseSteps[i];
    if (!s) return;
    const studies = Array.isArray(s.studies) ? (s.studies as StudyOut[]) : [];
    const primary = studies[0];
    if (primary) {
      const code = modalityCode(primary.type) || studyType;
      setStudyType(code);
      setContrast(primary.contrast === true);
      pfDurRef.current = Number(primary.dur) || null;   // durEdit-ефект підхопить кастомну тривалість
      setRegion(primary.region || "");
    }
    setExtraStudies(studies.slice(1).map((x) => ({
      type: x.type, region: x.region || "", dur: Number(x.dur) || (regionsFor(x.type, s.roomId)[0]?.dur ?? 0),
    })));
    setRoomId(s.roomId);
    if (s.date instanceof Date && !isNaN(s.date.getTime())) setBookDate(s.date);
    setTime(s.time);
    setBuffer(s.buffer ?? BUFFER_DEFAULT);
    setPriority(s.priority);
    setHasContra(s.hasContra === true);
    setNotes(s.notes || "");
    // Лікар-направник (best-effort): направник має пріоритет, інакше — за іменем.
    if (s.referrerId) setDoctorId("ref:" + s.referrerId);
    else if (s.doctor) { const d = docs.find((x) => (x.name || "").trim() === s.doctor); setDoctorId(d ? String(d.id) : ""); }
    else setDoctorId("");
    setEditIndex(i);
    setSaveErr(null);
  }

  /* Вийти з режиму редагування без збереження змін до кроку. */
  function cancelEdit() {
    setEditIndex(null);
    resetStepFields();
  }

  async function createCaseNow() {
    if (!onCreateCase || saving) return;
    // У режимі редагування поточна форма — це крок editIndex (не новий): якщо
    // валідна, вкладаємо зміни в нього; інакше беремо кейс як є.
    const steps = editIndex !== null
      ? (valid ? caseSteps.map((s, j) => (j === editIndex ? buildPayload() : s)) : [...caseSteps])
      // Поточний крок додаємо лише якщо його кабінет ще не в кейсі (різні кабінети).
      : (valid && !roomInCase ? [...caseSteps, buildPayload()] : [...caseSteps]);
    if (steps.length < 2) return;   // кейс — щонайменше два кроки різних кабінетів
    // 0106: жоден крок кейса не може бути «поза графіком» (сервер відхилить весь кейс).
    if (steps.some((s) => s.offSchedule)) {
      setSaveErr("Кроки кейса — лише в межах графіка кабінету. Приберіть крок «поза графіком».");
      return;
    }
    setSaving(true);
    setSaveErr(null);
    try {
      const err = await onCreateCase(steps);
      if (err) setSaveErr(err);
    } catch {
      setSaveErr("Не вдалося створити кейс — спробуйте ще раз");
    } finally {
      setSaving(false);
    }
  }

  const roomKeys = roomsOfType(studyType);

  return (
    <>
    <div className="overlay">
      <div className="dialog fade-in bk-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Новий запис пацієнта" onChangeCapture={() => setDirty(true)}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic">{addMode ? "🔗" : "＋"}</span>{addMode ? "Додати крок до кейса" : "Новий запис"}</div>
          <button className="icon-btn" onClick={requestClose} aria-label="Закрити">✕</button>
        </div>

        <div className="bk-grid">
          {/* ЛІВА КОЛОНКА */}
          <div className="bk-col bk-col-left">
            <div className="bk-section-label">Пацієнт</div>

            <label className="fld">
              <span className={"fld-lab" + (miss.name ? " bk-miss-lab" : "")}>ПІБ <span className="req">*</span></span>
              <input className="inp" placeholder="Прізвище Ім'я По батькові" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
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
                <div className="inp bk-age" title="Розраховано з дати народження">{dob ? calcAge(dob) : "—"}</div>
              </div>
              <label className="fld" style={{ flex: "0 0 60px" }}>
                <span className="fld-lab">Вага</span>
                {/* Клампимо до 400 кг (= PATIENT_WEIGHT_MAX у lib/validation.ts): інакше
                    «9999» пройшло б інпут і повернулося з сервера загальним 400. */}
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
              <div className="fld" style={{ flex: "0 0 auto" }}>
                <span className="fld-lab">Тип <span className="req">*</span></span>
                <div className="bk-seg" style={{ flexWrap: "wrap" }}>
                  {availableModalities.map((code) => (
                    <button key={code} className={"bk-seg-btn" + (studyType === code ? " active " + modalityKind(code) : "")} onClick={() => changeType(code)} title={modalityLabel(code)}>{modalityShort(code)}</button>
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
                <select className="inp" value={region} onChange={(e) => setRegion(e.target.value)}>
                  <option value="">— Оберіть область —</option>
                  {regions.map((r) => (
                    <option key={r.label} value={r.label}>{r.label}{contrastSuffix} · {r.dur == null ? "—" : r.dur + (contrast ? CONTRAST_DUR : 0) + " хв"}</option>
                  ))}
                </select>
              </label>
              <label className="fld" style={{ flex: "0 0 88px" }}>
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
              <label className="fld" style={{ flex: "0 0 76px" }}>
                <span className="fld-lab">Буфер <HelpTip label="Що таке буфер" text={<>Буфер — запас часу <b>після</b> дослідження на переукладку, дезінфекцію та підготовку кабінета до наступного пацієнта. Кабінет вважається зайнятим на «тривалість + буфер», тож буфер оберігає наступний слот від накладення.</>} /></span>
                <select className="inp" value={buffer} onChange={(e) => setBuffer(Number(e.target.value))} title="Час на переукладку/дезінфекцію після дослідження">
                  {BUFFER_OPTIONS.map((b) => <option key={b} value={b}>{b} хв</option>)}
                </select>
                <span className="bk-time-state none">після дослідження</span>
              </label>
            </div>

            {price != null && (
              <div className="ctx-hint blue" style={{ marginBottom: 6 }}>Орієнтовна вартість: {fmtPrice(price)}</div>
            )}

            {/* Додаткові дослідження */}
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

            <div className="fld">
              <span className="fld-lab">Лікар-направник</span>
              <div style={{ display: "flex", gap: 8 }}>
                <select className="inp" value={doctorId} onChange={(e) => setDoctorId(e.target.value)} style={{ flex: 1 }}>
                  <option value="">— Без направлення / самозвернення —</option>
                  {docs.map((d) => <option key={d.id} value={d.id}>{d.name}{d.spec ? " · " + d.spec : ""}</option>)}
                </select>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAddDoc(true)}>＋ Додати</button>
              </div>
            </div>

            <label className="fld" style={{ flex: 1 }}>
              <span className="fld-lab">Примітки</span>
              <textarea className="inp bk-notes" placeholder="Додаткова інформація, скеровання, особливі вимоги…" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
          </div>

          {/* ПРАВА КОЛОНКА — Scheduler */}
          <div className="bk-col bk-col-right">
            <div className="bk-sched-head">
              <span className="bk-sched-spark">✦</span>
              <span className="bk-sched-title">Розклад</span>
              <span className={"bk-sched-mod " + modalityKind(studyType)}>{modalityLabel(studyType)}</span>
              <span className="bk-sched-sync"><span className="pulse-dot" style={{ background: "var(--green)", width: 6, height: 6 }} /> синхр. з чергою</span>
            </div>

            <div className="fld">
              <span className={"fld-lab" + (miss.room ? " bk-miss-lab" : "")}>Кабінет <span className="req">*</span></span>
              {roomKeys.length === 0 ? (
                <div className="ctx-hint red">Немає кабінетів типу {modalityLabel(studyType)}. Додайте обладнання в налаштуваннях.</div>
              ) : (
                <>
                  <div className="bk-room-chips">
                    {roomKeys.map((r) => (
                      <button key={r.id} className={"bk-room-chip" + (roomId === r.id ? " active" : "") + " " + modalityKind(studyType)}
                        onClick={() => { setRoomId(r.id); setTime(""); }} title={r.name + (r.apparatus_model ? " · " + r.apparatus_model : "")}>
                        <span className="bk-room-chip-name">{r.name}</span>
                        {r.apparatus_model && <span className="bk-room-chip-model">{r.apparatus_model}</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            <BookingCalendar value={bookDate} today={clinicToday} onPick={(d) => { setBookDate(d); setTime(""); }} />

            <div className="fld">
              <div className="bk-slots-head">
                <span className={"fld-lab" + (miss.time ? " bk-miss-lab" : "")} style={{ margin: 0 }}>Вільні слоти · {fmtShort(bookDate)} {miss.time ? "— оберіть час *" : ""}</span>
                <span className="bk-free-count">блок {slotDur} хв{allStudies.length > 1 ? ` (${allStudies.length} досл.)` : ""} + {buffer} буфер · {allStudies.length === 0 ? "оберіть область" : slotsLoading ? "завантаження…" : "вміщується ще " + fitCount}</span>
              </div>
              {/* Банери — лише КОЛИ КАБІНЕТ ОБРАНО: без roomId графік падає на дефолт
                  (неділя = вихідний) і показував хибне «Кабінет не працює». */}
              {roomId && roomSched.closed && <div className="ctx-hint red" style={{ marginBottom: 10 }}>🚫 {room ? room.name : "Кабінет"} не працює {fmtShort(bookDate)}{override && override.label ? " · " + override.label : ""}. Оберіть інший день або кабінет.</div>}
              {roomId && !roomSched.closed && roomSched.custom && <div className="ctx-hint blue" style={{ marginBottom: 10 }}>🕐 Особливий графік {fmtShort(bookDate)}: {roomSched.start}–{roomSched.end}.</div>}
              {roomId && !roomSched.closed && slots.some((s) => slotState(s) === "blocked") && <div className="ctx-hint red" style={{ marginBottom: 10 }}>🔧 {room ? room.name : "Кабінет"} на ремонті/ТО{roomIncidents[0]?.blocked_until ? " до " + new Date(Math.max(...roomIncidents.map((i) => i.blocked_until ? new Date(i.blocked_until).getTime() : 0))).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) : ""}. Оберіть слот після відновлення або інший день/кабінет.</div>}
              {taken && <div className="ctx-hint red" style={{ marginBottom: 10 }}>⚡ Слот {taken} щойно зайняли — оберіть інший. <button className="btn btn-secondary btn-sm" style={{ marginLeft: 6 }} onClick={() => setTaken(null)}>Зрозуміло</button></div>}
              {/* Зайнятість/графік не завантажились — сітку НЕ показуємо: порожній день
                  виглядав би як «усе вільно», і можна було б записати пацієнта поверх іншого. */}
              {(busyError || schedErr) && !slotsLoading
                ? <div className="ctx-hint red" style={{ marginBottom: 10 }}>⚠ Не вдалося завантажити {busyError ? "зайнятість" : "графік"} кабінету — оновіть сторінку. Показувати вільний час не можемо.</div>
                : allStudies.length === 0
                ? <div className="ctx-hint" style={{ fontSize: 13, padding: "20px 0", textAlign: "center", color: "var(--text-muted)" }}>Оберіть область дослідження, щоб побачити вільний час</div>
                : slotsLoading
                ? <div className="ctx-hint" style={{ fontSize: 13, padding: "20px 0", textAlign: "center", color: "var(--text-muted)" }}>⏳ Завантаження вільних слотів…</div>
                : <div className={miss.time ? "bk-miss-slots" : undefined}>
                <SlotPicker
                  slots={slots}
                  value={time}
                  onChange={setTime}
                  spanMin={slotDur}
                  bufferMin={buffer}
                  resetKey={roomId + "|" + dateKey(bookDate) + "|" + slotDur + "|" + buffer}
                  stateOf={slotState}
                  freeStates={SELECTABLE}
                  titleOf={(s, st) => (st === "busy" || st === "buffer") ? busyLabel(s)
                    : st === "blocked" ? blockedLabel(s)
                    : st === "break" ? breakLabel(s)
                    : st === "casebusy" ? "Пацієнт зайнятий іншим кроком кейса в цей час — оберіть інший слот"
                    : st === "offsched" ? (onAddCaseStep ? "Кроки кейса — лише в межах графіка кабінету" : offSchedLabel(s))
                    : st === "offhours" ? "Кабінет не працює в цей час"
                    : st === "tight" ? `Не вміщується: блок ${slotDur} хв перетне ${tightReason(s)}`
                    : st === "past" ? "Час минув"
                    : `Вільно · ${s}–${fmtMin(toMin(s) + slotDur)}`}
                />
              </div>}
              {busyList.length > 0 && (
                <div className="bk-busy-list">
                  <span className="bk-busy-lab">Зайнятий час:</span>
                  {/* Дослідження і буфер — окремо: видно, коли кабінет реально звільняється. */}
                  {busyList.map((b, i) => (
                    <span className="bk-busy-chip" key={i}>
                      {fmtMin(b.s)}–{fmtMin(b.eStudy)}{b.e > b.eStudy ? <span style={{ opacity: 0.7 }}> +{b.e - b.eStudy} хв</span> : null}
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
                {caseBusyWindows.length > 0 && <span><span className="lg-dot casebusy" />інший крок кейса</span>}
                {roomBreaks.length > 0 && <span><span className="lg-dot brk" />перерва</span>}
                <span><span className="lg-dot offsched" />поза графіком</span>
              </div>
              {/* 0077 — підтвердження роботи поза графіком. Це НЕ вкладений діалог:
                  тост/модалка поверх модалки в цьому проекті вже давали «кнопка не
                  працює» (помилка малювалась ПІД оверлеєм). Згода живе тут, поруч зі
                  слотом, і протухає при зміні слота/кабінету/тривалості. */}
              {needsOffConfirm && (
                <div className="info-banner offsched" style={{ marginTop: 10, flexDirection: "column", alignItems: "stretch", gap: 8 }}>
                  <span className="ib-txt">
                    <b>⏰ Поза графіком.</b>{" "}
                    {selOff?.kind === "break" && selOff.brk
                      ? <>Слот потрапляє в <b>перерву {selOff.brk.start}–{selOff.brk.end}</b>.</>
                      : <>Кабінет працює до <b>{selOff?.end}</b>, а дослідження закінчиться о <b>{fmtMin(toMin(time) + slotDur)}</b>.</>}
                    {" "}Запис буде позначено як «поза графіком».
                  </span>
                  <label className="fld-lab" style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <input type="checkbox" checked={offOk} onChange={(e) => setOffOk(e.target.checked)} />
                    Підтверджую роботу поза графіком
                  </label>
                </div>
              )}
              {time && (() => {
                const s = toMin(time), e = s + slotDur, eBlock = s + slotDur + buffer;
                const blocked = slotBlockedByIncident(s);
                const conflict = roomBusy.find((b) => s < b.e && b.s < eBlock);
                return (
                  <div className={"bk-slot-confirm " + (blocked || conflict ? "bad" : "ok")}>
                    {blocked ? <>⚠ Кабінет на ремонті/ТО у цей час — оберіть інший слот або день</>
                      : conflict ? <>⚠ Перетин із записом {fmtMin(conflict.s)}–{fmtMin(conflict.e)} — оберіть інший слот</>
                      : <>✓ Слот вільний. Запис: <b>{time}–{fmtMin(e)}</b> ({slotDur} хв){buffer > 0 ? <> + буфер {buffer} хв (до {fmtMin(eBlock)})</> : null}.</>}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>

        {/* Помилка сервера — ТУТ, а не тостом під оверлеєм. */}
        {saveErr && (
          <div className="dlg-err" role="alert">⚠ {saveErr}</div>
        )}

        {onCreateCase && (
          <div className="bk-case-bar" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "8px 16px", borderTop: "1px solid var(--border)" }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", whiteSpace: "nowrap" }}>🔗 Кейс:</span>
            {caseSteps.length === 0 && <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>додайте кроки різних модальностей і створіть кейс</span>}
            {caseSteps.map((s, i) => {
              const rm = (rooms || []).find((r) => r.id === s.roomId);
              const editing = editIndex === i;
              return (
                <span
                  key={i}
                  onClick={() => (editing ? cancelEdit() : loadStepForEdit(i))}
                  title={editing ? "Редагується — натисніть, щоб вийти" : "Редагувати крок (час, дослідження, слот…)"}
                  style={{ cursor: "pointer", fontSize: 11.5, padding: "2px 6px 2px 8px", borderRadius: 999,
                    border: "1px solid " + (editing ? "var(--accent, #3b82f6)" : "var(--border)"),
                    background: editing ? "color-mix(in srgb, var(--accent, #3b82f6) 14%, transparent)" : "transparent",
                    display: "inline-flex", alignItems: "center", gap: 6 }}
                >
                  <span style={{ fontSize: 10, opacity: 0.7 }}>{i + 1}</span>
                  {modalityLabel(rm?.modality || "")} · {rm?.name || "—"} · {s.time}–{fmtMin(toMin(s.time) + s.dur)}
                  <button
                    onClick={(e) => { e.stopPropagation(); setCaseSteps((arr) => arr.filter((_, j) => j !== i)); if (editIndex !== null) cancelEdit(); }}
                    title="Прибрати крок"
                    style={{ cursor: "pointer", background: "none", border: "none", color: "var(--text-muted)", padding: 0, lineHeight: 1 }}
                  >✕</button>
                </span>
              );
            })}
            {/* Кейс = різні кабінети: підказка, коли поточний кабінет уже у кейсі. */}
            {editIndex === null && roomInCase && (
              <span style={{ flexBasis: "100%", fontSize: 11.5, color: "var(--orange, #e08a00)" }}>
                ⚠ Кабінет «{room?.name}» уже у кейсі. Кейс — це різні кабінети/модальності; кілька досліджень одного кабінету оформіть звичайним записом («＋ Додати дослідження»).
              </span>
            )}
            {editIndex !== null
              ? (
                <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
                  <button className="btn btn-ghost btn-sm" disabled={saving} onClick={cancelEdit} title="Вийти з редагування без змін">Скасувати правку</button>
                  <button className="btn btn-primary btn-sm" disabled={!valid || saving || needsOffConfirm} onClick={addStepToCase} title={needsOffConfirm ? "Кроки кейса — лише в межах графіка кабінету" : "Зберегти зміни в кроці"}>✓ Оновити крок {editIndex + 1}</button>
                </span>
              )
              : <button className="btn btn-ghost btn-sm" disabled={!valid || saving || roomInCase || needsOffConfirm} onClick={addStepToCase} style={{ marginLeft: "auto" }} title={roomInCase ? "Цей кабінет уже у кейсі — оберіть інший кабінет/модальність" : needsOffConfirm ? "Кроки кейса — лише в межах графіка кабінету" : "Додати поточний крок до кейса"}>＋ У кейс</button>}
            <button className="btn btn-primary btn-sm" disabled={saving || (caseSteps.length + (editIndex === null && valid && !roomInCase ? 1 : 0)) < 2} onClick={createCaseNow} title="Кейс — щонайменше два кроки в різних кабінетах">
              Створити кейс ({caseSteps.length + (editIndex === null && valid && !roomInCase ? 1 : 0)})
            </button>
          </div>
        )}

        <div className="dlg-foot">
          {valid
            ? <span className="bk-summary">{name.split(" ").slice(0, 2).join(" ")} · {allStudies.length > 1 ? allStudies.length + " досл." : primaryKind} · {room ? room.name : ""} · {fmtShort(bookDate)} {time}–{fmtMin(toMin(time) + slotDur)}</span>
            : <span className="bk-missing">{missingList.map((m, i) => <span className="bk-miss-chip" key={i}>{m}</span>)}</span>}
          <button className="btn btn-ghost" onClick={requestClose} disabled={saving}>Скасувати</button>
          {addMode
            ? <button className="btn btn-primary" disabled={!valid || saving || roomInCase} onClick={handleAddCaseStep} title={roomInCase ? "Цей кабінет уже у кейсі — оберіть іншу модальність/кабінет" : "Додати крок до кейса"}>
                {saving ? "Додавання…" : "Додати крок до кейса"}
              </button>
            : <button className="btn btn-primary" disabled={!valid || saving} onClick={handleSave}>
                {saving ? "Збереження…" : "Зберегти запис"}
              </button>}
        </div>
      </div>
    </div>
    {addDoc && (
      <AddDoctorModal existing={docs} onClose={() => setAddDoc(false)} onSave={async (d) => {
        const supabase = createClient();
        const { data, error } = await supabase.from("doctors").insert({ clinic_id: clinicId as string, name: d.name, spec: d.spec || null, clinic_name: d.clinic || null, phone: d.phone || null }).select("id, name, spec, clinic_name, phone").single();
        if (!error && data) { setDocs((arr) => [...arr, data]); setDoctorId(String(data.id)); }
        setAddDoc(false);
      }} />
    )}
    {askClose && (
      <ConfirmDialog
        title="Незбережені зміни"
        text="Форму запису заповнено, але не збережено. Закрити без збереження?"
        confirmLabel="Закрити без збереження"
        cancelLabel="Продовжити редагування"
        danger
        onConfirm={() => { setAskClose(false); onClose(); }}
        onClose={() => setAskClose(false)}
      />
    )}
    </>
  );
}
