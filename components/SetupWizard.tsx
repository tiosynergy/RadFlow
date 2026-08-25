"use client";

/* ===== RadFlow — Setup Wizard (Майстер налаштування) =====
   Портовано з прототипу wizard-app.jsx + wizard-steps.jsx.
   Дані префілляться з Supabase і зберігаються при «Запустити кабінет». */

import { useState, useEffect, useLayoutEffect, useRef, type Dispatch, type SetStateAction, type MutableRefObject } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { normalizeLogin, isValidLogin, LOGIN_HINT } from "@/lib/login";
import type { Json, TablesInsert, Tables } from "@/supabase/types";
import CitySelect from "@/components/CitySelect";
import ServicesEditor from "@/components/ServicesEditor";
import StaffManager from "@/components/StaffManager";
import ReferrersManager from "@/components/ReferrersManager";
import CeoManager from "@/components/CeoManager";
import QueuePolicySettings, { type QueuePolicyInitial } from "@/components/QueuePolicySettings";
import GoogleCalendarBackupSettings from "@/components/GoogleCalendarBackupSettings";
import ConfirmDialog from "@/components/ConfirmDialog";
import DangerZone from "@/components/DangerZone";
import UnreadDot from "@/components/UnreadDot";
import { UnreadChangesMount, useUnreadChanges } from "@/lib/useUnreadChanges";
import { unreadForSurface, type SurfaceKey } from "@/lib/unreadChanges";
import { formatPhoneUA, isValidPhoneUA } from "@/lib/phone";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";
import "@/styles/prototype/radflow-wizard.css";
import { roomScheduleFor, effectiveRoomBreaks, offScheduleKind, dateKeyOf, type Break } from "@/lib/schedule";
import { slotToMin } from "@/lib/slots";
import { MODALITIES, modalityCode } from "@/lib/studies";
import { wallDayKey } from "@/lib/incidents";
import { roomDeleteBlockReason } from "@/lib/rooms";

/* Статуси «живого» запису: пацієнт іще чекає на кабінет. needs_reschedule — теж
   живий (запис без слота, реєстратура має передзвонити).
   ⚠️ 0126: видалення кабінету ЦИМ СПИСКОМ БІЛЬШЕ НЕ КЕРУЄТЬСЯ — там блокує будь-яка
   історія, незалежно від статусу. Список лишився для попередження при ВИМКНЕННІ
   («у кабінеті N майбутніх активних записів») і для уточнення в діалозі видалення. */
const OPEN_STATUSES = ["scheduled", "waiting", "in_progress", "needs_reschedule"] as const;

/* ===== Таймзона центру (IANA) =====
   Від неї залежать «Запізнення», «Уточнити», гарди виклику в кабінет і заборона
   запису в минуле (канон wall-as-UTC, міграції 0035/0059). Тому це ЯВНЕ поле, а
   не мовчазний авто-детект браузера при кожному збереженні. */
function browserTz(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Kyiv"; }
  catch { return "Europe/Kyiv"; }
}
/** Повний список зон (сучасні рушії) з фолбеком на короткий перелік. */
function tzList(): string[] {
  const withValues = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  try {
    const all = withValues.supportedValuesOf?.("timeZone");
    if (all && all.length) return all;
  } catch { /* старий рушій — фолбек нижче */ }
  return ["Europe/Kyiv", "Europe/Warsaw", "Europe/Berlin", "Europe/Prague", "Europe/Vilnius",
    "Europe/Riga", "Europe/Bucharest", "Europe/Chisinau", "Europe/London", "Europe/Lisbon",
    "Europe/Madrid", "Europe/Rome", "Europe/Istanbul", "Asia/Tbilisi", "UTC"];
}
/** «Europe/Kyiv · 15:42» — щоб адмін одразу бачив, чи час центру збігається з реальним. */
function tzNow(tz: string): string {
  try { return new Intl.DateTimeFormat("uk-UA", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date()); }
  catch { return "—"; }
}

type Toast = { id: number; msg: string; type: string; out?: boolean };
type DayHours = { start: string; end: string; breaks: Break[] };
type EquipItem = {
  id: number | string;
  type: string; desc: string; room: string;
  days: number[];
  start: string; end: string; breaks: Break[];
  perDay: boolean; dayHours: DayHours[];
  roomId?: string;
  /* 0123: false = кабінет вимкнено. Нові записи в нього не приймаються (тригер
     check_room_active), наявні лишаються робочими, прайс/інциденти/привязки
     радіологів цілі. Видалити рядок можна ЛИШЕ вимкнений — і лише якщо в ньому
     НІКОЛИ не було жодного запису (0126, тригер guard_delete_room). */
  active?: boolean;
};
type WizardData = {
  clinic: string; city: string; address: string; phones: string[]; emails: string[];
  timezone: string;
  adminName: string; adminEmail: string; adminLogin: string; aPhones: string[]; aEmails: string[]; equip: EquipItem[];
};
type WizardInitial = Partial<{
  clinic: string; city: string; address: string; phones: string[]; emails: string[];
  timezone: string;
  adminName: string; adminEmail: string; adminLogin: string; adminPhone: string; equip: EquipItem[];
}>;

/* ---------- Toasts ---------- */
function Toasts({ toasts }: { toasts: Toast[] }) {
  const icons: Record<string, string> = { success: "✓", error: "✕", info: "ℹ", warning: "⚠" };
  return (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <div className={"toast " + t.type + (t.out ? " out" : "")} key={t.id}>
          <span className="ti">{icons[t.type]}</span>
          <span className="tmsg">{t.msg}</span>
        </div>
      ))}
    </div>
  );
}
function useToasts(): [Toast[], (msg: string, type?: string) => void] {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  function push(msg: string, type = "success") {
    const id = ++seq.current;
    setToasts((ts) => [...ts, { id, msg, type }]);
    setTimeout(() => setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, out: true } : t))), 3400);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 3700);
  }
  return [toasts, push];
}

const Req = () => <span className="req" title="Обов'язкове поле">*</span>;

/* Список телефонів / email-ів */
function ContactList({ label, items, setItems, type, ph, required }: {
  label: string;
  items: string[];
  setItems: Dispatch<SetStateAction<string[]>>;
  type?: string;
  ph?: string;
  required?: boolean;
}) {
  const isPhone = type !== "email";
  const noun = isPhone ? "телефон" : "email";
  const upd = (i: number, v: string) => setItems((a) => a.map((x, j) => (j === i ? v : x)));
  const add = () => setItems((a) => [...a, ""]);
  const del = (i: number) => setItems((a) => (a.length > 1 ? a.filter((_, j) => j !== i) : [""]));
  const empty = required && items.every((x) => x.trim() === "");
  return (
    <div className="fld">
      <span className="fld-lab">{label}{required && <Req />}</span>
      {items.map((v, i) => {
        const badPhone = isPhone && v.trim() !== "" && !isValidPhoneUA(v);
        return (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
          <input className={"inp" + ((empty && i === 0) || badPhone ? " invalid" : "")} type={isPhone ? "tel" : "email"} inputMode={isPhone ? "tel" : undefined} placeholder={ph} value={v}
            onChange={(e) => upd(i, isPhone ? formatPhoneUA(e.target.value) : e.target.value)} />
          <button className="mini-icon" type="button" title={"Видалити " + noun} onClick={() => del(i)}>✕</button>
        </div>
        );
      })}
      <button className="btn btn-secondary btn-sm add-btn" type="button" onClick={add}>＋ Додати {noun}</button>
    </div>
  );
}

const EQ_DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
const DEF_START_T = "08:00", DEF_END_T = "18:00";
const mkDay = (): DayHours => ({ start: DEF_START_T, end: DEF_END_T, breaks: [] });
const tbMin = (t: string) => { const [h, m] = (t || "").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const minToT = (n: number) => String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0");
/* Розумний дефолт нової перерви: перша — типовий обід 13:00–14:00 (якщо
   вписується), наступні — одразу після попередньої, у межах графіка, БЕЗ
   перетину. Так додавання перерв «просто працює», не впираючись у помилки. */
function defaultBreak(existing: Break[], dayStart: string, dayEnd: string): Break {
  const lo = tbMin(dayStart || DEF_START_T), hi = tbMin(dayEnd || DEF_END_T);
  if (existing.length === 0 && tbMin("13:00") >= lo && tbMin("14:00") <= hi) return { start: "13:00", end: "14:00" };
  const lastEnd = existing.length ? Math.max(...existing.map((b) => tbMin(b.end) || lo)) : lo;
  let s = Math.max(lastEnd, lo);
  let e = Math.min(s + 60, hi);
  if (e <= s) { s = lo; e = Math.min(lo + 60, hi); } // графік заповнений — валідний інтервал, користувач підправить
  return { start: minToT(s), end: minToT(e) };
}
function mkSched(): Omit<EquipItem, "id" | "type" | "desc" | "room" | "roomId"> {
  return { days: [1, 1, 1, 1, 1, 0, 0], start: DEF_START_T, end: DEF_END_T, breaks: [], perDay: false, dayHours: Array.from({ length: 7 }, () => mkDay()) };
}

/* Валідація однієї перерви в контексті свого списку та годин дня.
   Час у форматі "HH:MM" коректно порівнюється лексикографічно. */
function breakRowError(list: Break[], bi: number, dayStart: string, dayEnd: string): string | null {
  const b = list[bi];
  if (!b.start || !b.end) return "Вкажіть початок і кінець перерви";
  if (b.end <= b.start) return "Кінець перерви раніший за початок";
  if (dayStart && b.start < dayStart) return "Перерва до відкриття кабінету";
  if (dayEnd && b.end > dayEnd) return "Перерва після закриття кабінету";
  for (let j = 0; j < list.length; j++) {
    if (j === bi) continue;
    const o = list[j];
    if (o.start && o.end && o.end > o.start && b.start < o.end && o.start < b.end) return "Перетин з іншою перервою";
  }
  return null;
}
/* Валідація годин самого дня (не перерви). Порожнє поле або кінець ≤ початок
   раніше зберігались мовчки — і сітка слотів просто зникала (roomScheduleFor
   не дає жодного слота при start ≥ end). Тепер це помилка, що блокує «Зберегти». */
function dayHoursError(start: string, end: string): string | null {
  if (!start || !end) return "Вкажіть години роботи";
  if (end <= start) return "Кінець раніший за початок";
  return null;
}
/** Чи всі перерви всіх кабінетів коректні (для гейтингу «Зберегти»). */
function equipBreaksValid(equip: EquipItem[]): boolean {
  return equip.every((e) =>
    e.perDay
      ? e.dayHours.every((dh, di) => !e.days[di] || dh.breaks.every((_, bi) => breakRowError(dh.breaks, bi, dh.start, dh.end) === null))
      : e.breaks.every((_, bi) => breakRowError(e.breaks, bi, e.start, e.end) === null)
  );
}
/** Чи коректні години роботи всіх кабінетів (для гейтингу «Зберегти»).
    perDay: перевіряємо кожен УВІМКНЕНИЙ день; інакше — єдині години кабінету. */
function equipHoursValid(equip: EquipItem[]): boolean {
  return equip.every((e) =>
    e.perDay
      ? e.dayHours.every((dh, di) => !e.days[di] || dayHoursError(dh.start, dh.end) === null)
      : dayHoursError(e.start, e.end) === null
  );
}

/* Пункти бічної навігації майстра (кружки без нумерації).
   Профіль / Адміністратор / Обладнання / Прайс — секції цього екрана (anchor);
   Радіологи / Направники / Керівники — окремі сторінки керування (href). */
/* surfaces — які поверхні контекстних позначок (0131) «живуть» у пункті:
   крапка на пункті каже адміну, ДЕ саме є непрочитані зміни (с28, запит
   власника).
   ⚠️ Тут ЛИШЕ ті поверхні, у яких (а) є джерело в тригерах 0132 і (б) є де
   погасити. `rooms` / `schedule` / `staff` навмисно НЕ вписані: джерел у 0132
   немає (schedule_overrides чекає CAS з M-2 аудиту, staff-таблиці відкладені),
   а якби зʼявились — крапка тут загорілась би без жодного ack і стала вічною
   (ревʼю с28-р3). Додаєш поверхню — додай і точку підтвердження. */
const WIZ_NAV: { label: string; desc: string; anchor?: string; href?: string; surfaces?: SurfaceKey[] }[] = [
  { label: "Профіль клініки", desc: "Назва та контакти центру", anchor: "sec-clinic" },
  { label: "Адміністратор", desc: "Обліковий запис адміна", anchor: "sec-admin" },
  { label: "Обладнання та кабінети", desc: "Апарати та розклад", anchor: "sec-equip" },
  { label: "Послуги та прайс", desc: "Каталог послуг і цін центру", anchor: "sec-price", surfaces: ["services"] },
  { label: "Управління чергою", desc: "Політика при затримці", anchor: "sec-queue" },
  { label: "Резервне копіювання", desc: "Google Calendar (аварійна копія)", anchor: "sec-gcal" },
  { label: "Персонал і доступи", desc: "Радіологи та реєстратори", anchor: "sec-staff" },
  { label: "Лікарі-направники", desc: "Направники центру", anchor: "sec-referrers", surfaces: ["centers"] },
  { label: "Керівники (CEO)", desc: "Аналітичний доступ", anchor: "sec-ceo" },
];
// Секції, що належать майстру первинного налаштування (з кнопкою «Запустити кабінет»).
const FORM_SECTIONS = ["sec-clinic", "sec-admin", "sec-equip", "sec-price"];

/* ---------- Крок 1: Профіль клініки ---------- */
function StepRegister({ report, onData, initial, active, clinicId, services, rooms, roomOverrides, notify, assignRoomIds }: { report: (k: number, ok: boolean) => void; onData: (d: WizardData) => void; initial: WizardInitial; active: string; clinicId: string; services: ServiceRow[]; rooms: SetupRoom[]; roomOverrides: SroRow[]; notify: (msg: string, type?: string) => void; assignRoomIds: MutableRefObject<((a: Array<{ localId: number | string; roomId: string }>) => void) | null> }) {
  const [clinic, setClinic] = useState(initial.clinic || "");
  const [city, setCity] = useState(initial.city || "");
  const [address, setAddress] = useState(initial.address || "");
  const [phones, setPhones] = useState<string[]>(initial.phones && initial.phones.length ? initial.phones : [""]);
  const [emails, setEmails] = useState<string[]>(initial.emails && initial.emails.length ? initial.emails : [""]);
  /* Таймзона ЦЕНТРУ (IANA). Раніше її мовчки перезаписувала зона БРАУЗЕРА при
     кожному «Зберегти» — адмін з іншої країни (або з увімкненим VPN) ламав час
     усієї клініки: від нього залежать «Запізнення», «Уточнити», гарди виклику й
     заборона запису в минуле. Тепер це явне поле; авто-детект — лише як
     початкове значення для НОВОЇ клініки. */
  const [timezone, setTimezone] = useState(initial.timezone || browserTz());

  const [adminName, setAdminName] = useState(initial.adminName || "");
  // Email лише показуємо: адресу входу міняє служба підтримки, не майстер.
  const adminEmail = initial.adminEmail || "";
  /* 0124: логін — друга (а для декого єдина зручна) форма входу, і донедавна
     задати його можна було лише один раз, при реєстрації центру. Там же він
     підставлявся в назву клініки, тож люди вводили випадкове. Тепер редагуємо. */
  const [adminLogin, setAdminLogin] = useState(initial.adminLogin || "");
  const [loginSaved, setLoginSaved] = useState(initial.adminLogin || "");
  const [loginBusy, setLoginBusy] = useState(false);
  const loginNorm = normalizeLogin(adminLogin);
  const loginOk = isValidLogin(loginNorm);
  const loginDirty = loginNorm !== loginSaved;
  const [aPhones, setAPhones] = useState<string[]>([initial.adminPhone || ""]);
  const [aEmails, setAEmails] = useState<string[]>([""]);

  const [equip, setEquip] = useState<EquipItem[]>(
    initial.equip && initial.equip.length
      ? initial.equip
      : [{ id: 1, type: "МРТ", desc: "", room: "Кабінет №1", ...mkSched() }]
  );

  /* ⚠️ КРИТИЧНО (баг с33, «Спершу вимкніть… Кабінет №1» на другому «Зберегти»):
     save() живе в БАТЬКІВСЬКОМУ компоненті й після insert нових кабінетів
     отримує їхні db-id, але форма про них не знала — useState(initial.equip)
     читає initial лише на першому рендері, а router.refresh() state не
     перезасіває. Після першого збереження ряд лишався «новим» (без roomId), і
     наступне «Зберегти» бачило кабінет із БД як «прибраний з форми»: блокер
     «спершу вимкніть», а для вимкненого — ВИДАЛЕННЯ і дубль із новим id.
     Тому батько після інсертів віддає видані id назад через цей ref. */
  useEffect(() => {
    assignRoomIds.current = (assigned) => setEquip((a) => a.map((e) => {
      const hit = assigned.find((x) => String(x.localId) === String(e.id));
      return hit && !e.roomId ? { ...e, roomId: hit.roomId } : e;
    }));
    return () => { assignRoomIds.current = null; };
  }, [assignRoomIds]);

  useEffect(() => {
    const adminPhoneOk = aPhones.some((p) => p.trim() !== "");
    const ok = clinic.trim() !== "" && city.trim() !== "" && adminName.trim() !== "" && adminPhoneOk && equip.length > 0 && equipHoursValid(equip) && equipBreaksValid(equip);
    report(1, !!ok);
    onData({ clinic, city, address, phones, emails, timezone, adminName, adminEmail, adminLogin, aPhones, aEmails, equip });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinic, city, address, phones, emails, timezone, adminName, adminEmail, adminLogin, aPhones, aEmails, equip]);

  function setEq(i: number, k: string, v: string | boolean) { setEquip((a) => a.map((x, j) => (j === i ? { ...x, [k]: v } : x))); }
  function toggleEqDay(i: number, d: number) { setEquip((a) => a.map((x, j) => (j === i ? { ...x, days: x.days.map((v, k) => (k === d ? (v ? 0 : 1) : v)) } : x))); }
  function setEqDay(i: number, di: number, k: string, v: string | boolean) {
    setEquip((a) => a.map((x, j) => (j === i ? { ...x, dayHours: x.dayHours.map((dh, k2) => (k2 === di ? { ...dh, [k]: v } : dh)) } : x)));
  }
  function toggleEqPerDay(i: number, on: boolean) {
    setEquip((a) => a.map((x, j) => {
      if (j !== i) return x;
      if (!on) return { ...x, perDay: false };
      // Засіваємо кожен день годинами й перервами загального графіка (свіжі копії).
      return { ...x, perDay: true, dayHours: Array.from({ length: 7 }, () => ({ start: x.start, end: x.end, breaks: x.breaks.map((b) => ({ ...b })) })) };
    }));
  }
  // Перерви загального графіка (весь тиждень).
  function addEqBreak(i: number) { setEquip((a) => a.map((x, j) => (j === i ? { ...x, breaks: [...x.breaks, defaultBreak(x.breaks, x.start, x.end)] } : x))); }
  function setEqBreak(i: number, bi: number, k: "start" | "end", v: string) { setEquip((a) => a.map((x, j) => (j === i ? { ...x, breaks: x.breaks.map((b, k2) => (k2 === bi ? { ...b, [k]: v } : b)) } : x))); }
  function delEqBreak(i: number, bi: number) { setEquip((a) => a.map((x, j) => (j === i ? { ...x, breaks: x.breaks.filter((_, k2) => k2 !== bi) } : x))); }
  // Перерви окремого дня (режим «свій час для кожного дня»).
  function addEqDayBreak(i: number, di: number) { setEquip((a) => a.map((x, j) => (j === i ? { ...x, dayHours: x.dayHours.map((dh, k2) => (k2 === di ? { ...dh, breaks: [...dh.breaks, defaultBreak(dh.breaks, dh.start, dh.end)] } : dh)) } : x))); }
  function setEqDayBreak(i: number, di: number, bi: number, k: "start" | "end", v: string) { setEquip((a) => a.map((x, j) => (j === i ? { ...x, dayHours: x.dayHours.map((dh, k2) => (k2 === di ? { ...dh, breaks: dh.breaks.map((b, k3) => (k3 === bi ? { ...b, [k]: v } : b)) } : dh)) } : x))); }
  function delEqDayBreak(i: number, di: number, bi: number) { setEquip((a) => a.map((x, j) => (j === i ? { ...x, dayHours: x.dayHours.map((dh, k2) => (k2 === di ? { ...dh, breaks: dh.breaks.filter((_, k3) => k3 !== bi) } : dh)) } : x))); }
  function addEq() { setEquip((a) => [...a, { id: Date.now(), type: "МРТ", desc: "", room: "", ...mkSched() }]); }
  function delEq(i: number) { setEquip((a) => a.filter((_, j) => j !== i)); }

  /* Видалення кабінету — через ПІДТВЕРДЖЕННЯ (раніше ✕ зносив картку миттєво, без
     попередження й без шансу відмінити). Для НАЯВНОГО кабінету (є roomId) спершу
     питаємо базу, чи є в ньому історія: якщо є — видалення блокуємо (інакше save
     усе одно відхилить, але вже після втрати картки, і незрозуміло чому). Перевірка
     best-effort → fail-closed: не вдалось порахувати — не пропускаємо. */
  /* ⚠️ ПРАВИЛО ЗМІНИЛОСЬ 2026-07-28 (міграція 0126, рішення власника). Тут двічі
     стояло інше:
       до 2026-07-27 — блокували всі відкриті записи без огляду на дату;
       з  2026-07-27 — блокували ЛИШЕ майбутні відкриті, минулі просто показували.
     Друге правило й породило проблему: `queue_entries.room_id` має ON DELETE SET
     NULL, тож кабінет із закритою минулою історією видалявся МОВЧКИ, а всі його
     записи лишались у базі без кабінету. У проді так осиротіли 44 записи (чистка —
     supabase/maintenance/2026-07-28_cleanup_roomless_entries.sql).
     ТЕПЕР: кабінет із БУДЬ-ЯКОЮ історією (хоч один рядок у черзі або вейтлісті,
     будь-який статус і дата) не видаляється ніколи. Правильна дія — ВИМКНУТИ його.
     Видалення лишається тільки для кабінету, заведеного помилково, у якому нікого
     ніколи не записували. Справжній рубіж — тригер guard_delete_room (0126);
     тут ми лише пояснюємо це людською мовою до того, як картку буде втрачено. */
  /* 0123: скільки МАЙБУТНІХ активних записів лишиться за кабінетом, який щойно
     вимкнули. Рішення власника — вимикати можна завжди, але з чесним попередженням:
     інакше апарат зникає з форм запису, а про людей, записаних на завтра, ніхто не
     дізнається. Рахуємо ліниво, лише в момент вимкнення. */
  const [offInfo, setOffInfo] = useState<Record<number, { checking: boolean; count: number | null }>>({});
  async function toggleEqActive(i: number, on: boolean) {
    setEq(i, "active", on);
    if (on) { setOffInfo((m) => { const n = { ...m }; delete n[i]; return n; }); return; }
    const roomId = equip[i]?.roomId;
    if (!roomId) { setOffInfo((m) => ({ ...m, [i]: { checking: false, count: 0 } })); return; }  // новий кабінет
    setOffInfo((m) => ({ ...m, [i]: { checking: true, count: null } }));
    try {
      const supabase = createClient();
      // «Сьогодні» — за настінним часом ЦЕНТРУ (канон проєкту), як і в askDelEq.
      const { count, error } = await supabase.from("queue_entries")
        .select("id", { count: "exact", head: true })
        .eq("room_id", roomId).in("status", OPEN_STATUSES)
        .gte("scheduled_date", wallDayKey(timezone || undefined));
      if (error) throw error;
      setOffInfo((m) => ({ ...m, [i]: { checking: false, count: count ?? 0 } }));
    } catch {
      // Не змогли порахувати — попередження лишається, просто без числа.
      setOffInfo((m) => ({ ...m, [i]: { checking: false, count: null } }));
    }
  }

  const [delAsk, setDelAsk] = useState<{
    i: number; name: string; checking: boolean;
    /* 0126: скільки рядків історії за кабінетом — ЧЕРГА, будь-який статус і дата.
       null = порахувати не вдалось (fail-closed: блокуємо). Саме це число, а не
       «майбутні активні», вирішує, можна видаляти чи ні. */
    count: number | null;
    wl: number | null;         // броні вейтліста — теж історія (room_id → SET NULL)
    future?: number;           // з них майбутніх відкритих — лише щоб текст був точнішим
    services?: number;         // власний прайс кабінету (0121) — піде каскадом
    /* 0123: кабінет ЩЕ АКТИВНИЙ у базі → видаляти рано. Перевіряємо саме в базі, а
       не за перемикачем у формі: інакше «вимкнув → одразу видалив → Зберегти»
       проходило б одним збереженням, і двокроковість була б косметикою
       (ревʼю Medium-2). Тригер guard_delete_room тримає те саме правило. */
    stillActive?: boolean;
  } | null>(null);
  async function askDelEq(i: number) {
    const e = equip[i];
    const name = (e.room || e.type || "Кабінет").trim();
    /* Новий кабінет: рядка в БД ще немає, тож ні історії, ні `active` не існує —
       віддаємо явні «порожньо + вимкнено», щоб roomDeleteBlockReason повернув
       null, а не fail-closed на невідомому стані. */
    if (!e.roomId) { setDelAsk({ i, name, count: 0, wl: 0, stillActive: false, checking: false }); return; }
    setDelAsk({ i, name, count: null, wl: null, checking: true });
    try {
      const supabase = createClient();
      // «Сьогодні» — за настінним часом ЦЕНТРУ (правило проекту: лише wallDayKey).
      const today = wallDayKey(timezone || undefined);
      const roomId = e.roomId as string;
      const [all, fut, wl, svc, room] = await Promise.all([
        // ⚠️ БЕЗ фільтрів по статусу й даті — саме в цьому суть правила 0126.
        supabase.from("queue_entries").select("id", { count: "exact", head: true }).eq("room_id", roomId),
        supabase.from("queue_entries").select("id", { count: "exact", head: true })
          .eq("room_id", roomId).in("status", OPEN_STATUSES).gte("scheduled_date", today),
        supabase.from("waitlist_entries").select("id", { count: "exact", head: true }).eq("room_id", roomId),
        supabase.from("services").select("id", { count: "exact", head: true }).eq("room_id", roomId),
        supabase.from("rooms").select("active").eq("id", roomId).maybeSingle(),
      ]);
      /* Помилку ловимо в КОЖНОМУ запиті, зокрема в `room`. Інакше збій саме на
         ньому давав би room.data = null → stillActive = true, і власник бачив би
         «спершу вимкніть кабінет» на кабінеті, який ВЖЕ вимкнено, без кнопки
         «Скасувати» й без шляху вперед (ревʼю с18, Low-7). */
      if (all.error || wl.error || room.error || fut.error || svc.error) {
        throw all.error || wl.error || room.error || fut.error || svc.error;
      }
      setDelAsk((cur) => (cur && cur.i === i
        ? { ...cur, count: all.count ?? 0, wl: wl.count ?? 0, future: fut.count ?? 0, services: svc.count ?? 0,
            stillActive: (room.data as { active?: boolean } | null)?.active !== false, checking: false }
        : cur));
    } catch {
      /* Не змогли перевірити → fail-closed: count/wl лишаються null, і
         roomDeleteBlockReason віддає "unknown". Пропускати «на око» не можна —
         тригер 0126 усе одно відмовить, але вже сирим ROOM_HAS_HISTORY у тості
         «Помилка збереження», причому ПІСЛЯ того, як картку кабінету прибрали
         з форми. */
      setDelAsk((cur) => (cur && cur.i === i
        ? { ...cur, count: null, wl: null, stillActive: undefined, checking: false } : cur));
    }
  }

  return (
    <div className="fade-in">
      {active === "sec-clinic" && (<>
      <h1 className="wiz-h">Профіль клініки</h1>
      <p className="wiz-hsub">Базові дані центру.</p>

      <div className="info-banner" style={{ marginTop: 16 }}>
        <span className="ib-ic" style={{ color: "var(--green)" }}>✓</span>
        <span className="ib-txt"><b>Email підтверджено.</b> Обліковий запис активовано.</span>
      </div>

      <div className="sec-label" style={{ marginTop: 16 }}>Медичний центр</div>
      <div className="form-card reg-card">
        <div className="fld-row">
          <label className="fld"><span className="fld-lab">Назва клініки <Req /></span>
            <input className={"inp" + (clinic.trim() ? "" : " invalid")} value={clinic} onChange={(e) => setClinic(e.target.value)} /></label>
          <span className="fld-spacer" />
        </div>
        <div className="fld-row">
          <label className="fld"><span className="fld-lab">Місто <Req /></span>
            <CitySelect value={city} onChange={setCity} required /></label>
          <label className="fld" style={{ flex: 2 }}><span className="fld-lab">Адреса</span>
            <input className="inp" placeholder="вул., будинок, поверх, індекс" value={address} onChange={(e) => setAddress(e.target.value)} /></label>
        </div>
        <div className="fld-row">
          <label className="fld"><span className="fld-lab">Часовий пояс центру <Req /></span>
            <select className="inp" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {(tzList().includes(timezone) ? tzList() : [timezone, ...tzList()]).map((z) => (
                <option key={z} value={z}>{z}</option>
              ))}
            </select>
            <span className="fld-hint">Зараз у центрі: {tzNow(timezone)}. За цим часом рахуються «Запізнення», «Уточнити» та заборона запису в минуле — не змінюйте, якщо ви в іншій країні за центр.</span>
          </label>
          <span className="fld-spacer" />
        </div>
        <div className="contacts-grid">
          <ContactList label="Телефони" items={phones} setItems={setPhones} ph="+38 0__ ___ __ __" />
          <ContactList label="Email-и" items={emails} setItems={setEmails} type="email" ph="name@clinic.ua" />
        </div>
      </div>

      </>)}

      {active === "sec-admin" && (<>
      <h1 className="wiz-h">Адміністратор</h1>
      <p className="wiz-hsub">Обліковий запис адміністратора центру.</p>
      <div className="form-card reg-card" style={{ marginTop: 16 }}>
        <div className="fld-row">
          <label className="fld">
            <span className="fld-lab">ПІБ адміністратора <Req /></span>
            <input className={"inp" + (adminName.trim() ? "" : " invalid")} placeholder="Прізвище Ім'я По батькові" value={adminName} onChange={(e) => setAdminName(e.target.value)} />
          </label>
          <label className="fld">
            <span className="fld-lab">Email для входу <Req /></span>
            <input className="inp" type="email" value={adminEmail} readOnly />
            {/* Раніше тут писалось «Логін · роль: Адміністратор» — підпис називав
                логіном те, що ним не є, а справжній логін ніде не показувався. */}
            <span className="fld-hint">Роль: Адміністратор. Змінюється у службі підтримки.</span>
          </label>
        </div>
        <div className="fld-row">
          <label className="fld">
            <span className="fld-lab">Логін для входу <Req /></span>
            <input className={"inp" + (loginOk ? "" : " invalid")} value={adminLogin}
              autoComplete="username" placeholder="напр. ivanov"
              onChange={(e) => setAdminLogin(e.target.value)} />
            <span className="fld-hint">{loginOk ? LOGIN_HINT : <span style={{ color: "var(--red)" }}>{LOGIN_HINT}</span>}</span>
          </label>
          <div className="fld">
            <span className="fld-lab">&nbsp;</span>
            {/* Логін зберігається ОКРЕМОЮ кнопкою, а не разом із майстром: його
                міняє службовий роут під service-role (тригер 0064 не пускає
                зміну login з клієнта), і відмова «логін зайнятий» має прийти
                одразу, а не сховатись у загальному «Зберегти». */}
            <button type="button" className="btn btn-secondary"
              disabled={!loginOk || !loginDirty || loginBusy}
              onClick={async () => {
                setLoginBusy(true);
                try {
                  const res = await fetch("/api/account/login", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ login: loginNorm }),
                  });
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok) { notify(data.error || "Не вдалося змінити логін", "error"); return; }
                  setLoginSaved(loginNorm); setAdminLogin(loginNorm);
                  notify("Логін збережено: " + loginNorm, "success");
                } catch {
                  notify("Мережа недоступна — логін не змінено", "error");
                } finally { setLoginBusy(false); }
              }}>
              {loginBusy ? "Зберігаю…" : loginDirty ? "Зберегти логін" : "Логін збережено"}
            </button>
            {/* Логін не входить у загальне «Зберегти» — без цього рядка людина
                редагує поле, тисне «Зберегти» внизу й лишається зі старим
                логіном, ніде не побачивши, що зміна не застосувалась. */}
            {loginDirty && (
              <span className="fld-hint" style={{ color: "var(--orange)" }} role="status" aria-live="polite">
                Логін не збережено — натисніть «Зберегти логін».
              </span>
            )}
          </div>
        </div>
        <div className="contacts-grid">
          <ContactList label="Телефони" items={aPhones} setItems={setAPhones} ph="+38 0__ ___ __ __" required />
          <ContactList label="Email-и" items={aEmails} setItems={setAEmails} type="email" ph="name@example.com" />
        </div>
      </div>

      </>)}

      {active === "sec-equip" && (<>
      <h1 className="wiz-h">Обладнання та кабінети <Req /></h1>
      <p className="wiz-hsub">Апарати центру та їхній графік роботи.</p>
      <div className="form-card" style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
        {equip.map((e, i) => (
          <div key={e.id} className={"equip-block" + (e.active === false ? " equip-off" : "")}>
            <button className="mini-icon equip-block-del" type="button"
              title={equip.length <= 1 ? "Останній кабінет видалити не можна" : "Видалити обладнання"}
              onClick={() => askDelEq(i)}
              disabled={equip.length <= 1}>✕</button>
            <div className="equip-info">
              <div className="equip-info-row">
                <select className="inp equip-type" value={e.type} onChange={(ev) => setEq(i, "type", ev.target.value)}>
                  {MODALITIES.map((m) => <option key={m.code} value={m.label}>{m.label}</option>)}
                </select>
                <input className="inp equip-room2" placeholder="Кабінет / №" value={e.room} onChange={(ev) => setEq(i, "room", ev.target.value)} />
              </div>
              <input className="inp" placeholder="Модель / опис обладнання" value={e.desc} onChange={(ev) => setEq(i, "desc", ev.target.value)} />

              {/* 0123 + 0126. Вимкнення — мʼякий і зворотний крок: кабінет перестає
                  приймати нові записи й зникає з робочих екранів, але прайс, інциденти,
                  привязки радіологів і вся історія лишаються. Для працюючого центру це
                  ЄДИНИЙ спосіб вивести апарат із роботи.
                  Видалення (✕) — незворотний каскад, і воно можливе лише для кабінету
                  ВЖЕ вимкненого (0123) І БЕЗ ЖОДНОГО запису за всю історію (0126), тобто
                  фактично тільки для заведеного помилково. Кнопка ✕ навмисно не
                  гейтиться по `active`: вона disabled лише коли кабінет в центрі
                  останній, а обидві відмови пояснює діалог askDelEq — інакше власник
                  бачив би мертву кнопку без причини. Рубіж у БД — guard_delete_room.
                  Це саме чекбокс, а не кнопка-перемикач: стан несе `checked`, і
                  скрінрідер читає «Кабінет працює, прапорець знято» без суперечності,
                  яку давала пара «мінлива мітка + aria-pressed». */}
              <label className="eq-active-lab">
                <input type="checkbox" checked={e.active !== false}
                  onChange={(ev) => toggleEqActive(i, ev.target.checked)} />
                Кабінет працює
              </label>
              {e.active === false && (
                <div className="ctx-hint orange eq-off-warn" role="status" aria-live="polite">
                  <b>⚠ Кабінет буде вимкнено.</b> Після збереження в нього не можна буде
                  ні записати пацієнта, ні перенести запис, ні забронювати місце в листі
                  очікування.
                  <br />Наявні записи <b>не зникають</b>: їх ведуть, викликають, завершують і
                  рухають по часу в цьому ж кабінеті або переносять в інший. Прайс кабінету,
                  інциденти та привʼязки радіологів зберігаються.
                  {offInfo[i]?.checking
                    ? <><br />Перевіряю майбутні записи…</>
                    : offInfo[i]?.count == null
                    ? null
                    : offInfo[i]!.count! > 0
                    ? <><br /><b>Зараз у кабінеті {offInfo[i]!.count} майбутніх активних записів.</b>{" "}
                        Вони залишаться за ним — перенесіть або скасуйте їх, якщо апарат уже не працює.</>
                    : <><br />Майбутніх активних записів у ньому немає.</>}
                </div>
              )}
            </div>
            <div className="equip-sched">
              <span className="equip-sched-lab">Розклад роботи</span>
              <div className="eq-days">
                {EQ_DAYS.map((d, di) => (
                  <button key={d} type="button" className={"eq-day" + (e.days[di] ? " on" : "")} title={d} onClick={() => toggleEqDay(i, di)}>{d}</button>
                ))}
              </div>

              <label className="eq-perday-lab">
                <input type="checkbox" checked={e.perDay} onChange={(ev) => toggleEqPerDay(i, ev.target.checked)} />
                Свій час для кожного дня
              </label>

              {!e.perDay && (() => {
                const hErr = dayHoursError(e.start, e.end);
                return (
                <>
                  <div className="eq-hours">
                    <input className={"inp tabular eq-time" + (hErr ? " invalid" : "")} type="time" value={e.start} onChange={(ev) => setEq(i, "start", ev.target.value)} />
                    <span className="eq-dash">–</span>
                    <input className={"inp tabular eq-time" + (hErr ? " invalid" : "")} type="time" value={e.end} onChange={(ev) => setEq(i, "end", ev.target.value)} />
                  </div>
                  {hErr && <span className="eq-break-err">{hErr}</span>}
                  <div className="eq-breaks">
                    {e.breaks.map((b, bi) => {
                      const err = breakRowError(e.breaks, bi, e.start, e.end);
                      return (
                        <div className={"eq-break-row" + (err ? " has-err" : "")} key={bi}>
                          <span className="eq-break-tag">Перерва</span>
                          <div className="eq-hours">
                            <input className={"inp tabular eq-time" + (err ? " invalid" : "")} type="time" value={b.start} onChange={(ev) => setEqBreak(i, bi, "start", ev.target.value)} />
                            <span className="eq-dash">–</span>
                            <input className={"inp tabular eq-time" + (err ? " invalid" : "")} type="time" value={b.end} onChange={(ev) => setEqBreak(i, bi, "end", ev.target.value)} />
                          </div>
                          <button className="mini-icon" type="button" title="Прибрати перерву" onClick={() => delEqBreak(i, bi)}>✕</button>
                          {err && <span className="eq-break-err">{err}</span>}
                        </div>
                      );
                    })}
                    <button className="btn btn-ghost btn-sm eq-break-add" type="button" onClick={() => addEqBreak(i)}>＋ Перерва</button>
                  </div>
                </>
                );
              })()}

              {e.perDay && (
                <div className="eq-perday-list">
                  {e.days.some((d) => d) ? (
                    EQ_DAYS.map((d, di) => (e.days[di] ? (
                      <div key={d} className="eq-perday-row">
                        <span className="eq-perday-day">{d}</span>
                        <div className="eq-perday-fields">
                          {(() => { const dhErr = dayHoursError(e.dayHours[di].start, e.dayHours[di].end); return (<>
                          <div className="eq-hours">
                            <input className={"inp tabular eq-time" + (dhErr ? " invalid" : "")} type="time" value={e.dayHours[di].start} onChange={(ev) => setEqDay(i, di, "start", ev.target.value)} />
                            <span className="eq-dash">–</span>
                            <input className={"inp tabular eq-time" + (dhErr ? " invalid" : "")} type="time" value={e.dayHours[di].end} onChange={(ev) => setEqDay(i, di, "end", ev.target.value)} />
                          </div>
                          {dhErr && <span className="eq-break-err">{dhErr}</span>}
                          </>); })()}
                          <div className="eq-breaks">
                            {e.dayHours[di].breaks.map((b, bi) => {
                              const err = breakRowError(e.dayHours[di].breaks, bi, e.dayHours[di].start, e.dayHours[di].end);
                              return (
                                <div className={"eq-break-row" + (err ? " has-err" : "")} key={bi}>
                                  <span className="eq-break-tag">Перерва</span>
                                  <div className="eq-hours">
                                    <input className={"inp tabular eq-time" + (err ? " invalid" : "")} type="time" value={b.start} onChange={(ev) => setEqDayBreak(i, di, bi, "start", ev.target.value)} />
                                    <span className="eq-dash">–</span>
                                    <input className={"inp tabular eq-time" + (err ? " invalid" : "")} type="time" value={b.end} onChange={(ev) => setEqDayBreak(i, di, bi, "end", ev.target.value)} />
                                  </div>
                                  <button className="mini-icon" type="button" title="Прибрати перерву" onClick={() => delEqDayBreak(i, di, bi)}>✕</button>
                                  {err && <span className="eq-break-err">{err}</span>}
                                </div>
                              );
                            })}
                            <button className="btn btn-ghost btn-sm eq-break-add" type="button" onClick={() => addEqDayBreak(i, di)}>＋ Перерва</button>
                          </div>
                        </div>
                      </div>
                    ) : null))
                  ) : (
                    <div className="eq-perday-empty">Оберіть робочі дні вище.</div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        <button className="btn btn-secondary btn-sm add-btn" type="button" onClick={addEq}>＋ Додати обладнання</button>
      </div>

      </>)}

      {active === "sec-price" && (<>
      <h1 className="wiz-h">Послуги та прайс</h1>
      <div className="info-banner" style={{ marginTop: 12 }}>
        <span className="ib-ic" style={{ color: "var(--blue-text)" }}>₴</span>
        <span className="ib-txt">
          <b>Базовий каталог центру</b> — перелік досліджень, тривалості та ціни на модальність.
          Для <b>кожного кабінета</b> ціну/тривалість/склад можна переозначити окремо — оберіть
          кабінет у списку «Налаштувати». Порожні поля кабінета успадковують базовий каталог.
          {rooms.length === 0 && <> <b style={{ color: "var(--orange)" }}>Спершу додайте й збережіть кабінети</b> (крок «Обладнання та кабінети») — тоді зʼявиться налаштування по кабінетах.</>}
        </span>
      </div>
      <div style={{ marginTop: 14 }}>
        <ServicesEditor clinicId={clinicId} services={services} rooms={rooms} roomOverrides={roomOverrides} embedded />
      </div>
      </>)}

      {delAsk && (() => {
        /* Рішення «чому не можна» живе в lib/rooms.ts однією чистою функцією і
           покрите тестами: те саме правило мусить збігатись у трьох місцях —
           тут, у преflight збереження і в тригері guard_delete_room. Тут лише
           перекладаємо вердикт у текст. */
        /* `stillActive` і `rooms.active` — це одне й те саме поле з БД, тож
           передаємо як є: undefined → трактується як «ввімкнений» (fail-closed). */
        const reason = delAsk.checking ? null : roomDeleteBlockReason({
          queue: delAsk.count, waitlist: delAsk.wl, active: delAsk.stillActive,
        });
        const checkFailed = reason === "unknown";
        const hasHistory = reason === "history";
        const stillOn = reason === "active";
        const blocked = reason !== null;
        return (
          <ConfirmDialog
            title={
              delAsk.checking ? "Видалити кабінет?"
                : checkFailed ? "Не вдалося перевірити кабінет"
                : hasHistory  ? "Кабінет не можна видалити"
                : stillOn     ? "Спершу вимкніть кабінет"
                : "Видалити кабінет?"
            }
            text={
              delAsk.checking
                ? <>Перевіряю записи в кабінеті <b>{delAsk.name}</b>…</>
                : checkFailed
                  ? <>Не вдалося перевірити, чи є записи в кабінеті <b>{delAsk.name}</b>. Видалення
                      заблоковано, поки перевірка не пройде: якщо записи є, вони назавжди втратили б
                      кабінет. Спробуйте ще раз — або просто <b>вимкніть</b> кабінет, це безпечно
                      в будь-якому разі.</>
                : hasHistory
                  ? <>
                      У кабінеті <b>{delAsk.name}</b> є історія
                      {!!delAsk.count && <>: <b>{delAsk.count}</b> запис(ів) пацієнтів</>}
                      {!!delAsk.wl && <>{delAsk.count ? " і " : ": "}<b>{delAsk.wl}</b> бронь(і) в списку очікування</>}.
                      {" "}Такий кабінет <b>видалити не можна</b> — разом із ним записи назавжди втратили б
                      привʼязку до апарата: вони зникли б із дошки кабінета, зі звітів по кабінету й із
                      завантаженості, а відновити звʼязок було б неможливо.
                      <br /><br />Те, що зазвичай потрібно, — <b>вимкнути</b> кабінет перемикачем на картці:
                      нових записів він не прийматиме й зникне з робочих екранів, а прайс, історія та
                      привʼязки лишаться цілими.
                      {!!delAsk.future && <><br /><br />Зверніть увагу: <b>{delAsk.future}</b> із них — майбутні активні записи. Їх варто перенести або скасувати, інакше пацієнти прийдуть у кабінет, який уже не працює.</>}
                    </>
                : stillOn
                  ? <>Кабінет <b>{delAsk.name}</b> ще працює. Видалення незворотне, тому спершу
                      <b> вимкніть</b> його перемикачем на картці й <b>збережіть зміни</b> — після цього
                      кабінет можна буде видалити. Часто вимкнення і є тим, що потрібно: кабінет
                      перестає приймати нові записи, а прайс, історія та привʼязки лишаються цілими.</>
                  : <>
                      Кабінет <b>{delAsk.name}</b> буде видалено з центру при збереженні. Скасувати дію потім не можна.
                      {/* Сюди можна потрапити лише з кабінету ВИМКНЕНОГО (0123) і БЕЗ жодного
                          запису (0126) — тобто заведеного помилково. Тому про історію тут
                          говорити нічого: її не існує. */}
                      <br /><br />У ньому <b>немає жодного запису</b> — ні в черзі, ні в списку очікування,
                      тож нічия історія не постраждає.
                      {!!delAsk.services && <><br /><br />Разом із кабінетом <b>назавжди зникне його власний прайс — {delAsk.services} послуг(и)</b>, а також інциденти (поломки/ТО) і привʼязки радіологів до нього.</>}
                    </>
            }
            danger={!blocked}
            busy={delAsk.checking}
            hideCancel={blocked}
            confirmLabel={blocked ? "Зрозуміло" : "Видалити"}
            cancelLabel="Скасувати"
            onClose={() => setDelAsk(null)}
            onConfirm={() => {
              if (delAsk.checking) return;
              if (!blocked) delEq(delAsk.i);
              setDelAsk(null);
            }}
          />
        );
      })()}
    </div>
  );
}

/* ---------- Майстер (контейнер) ---------- */
type SetupRoom = { id: string; modality: string; name: string; apparatus_model?: string | null; active?: boolean | null };
type ServiceRow = Tables<"services">;
type SroRow = Tables<"service_room_overrides">;

export default function SetupWizard({ clinicId, userId, initial, rooms = [], services = [], roomOverrides = [], clinicName, adminName, queuePolicy }: { clinicId: string; userId: string; initial: WizardInitial; rooms?: SetupRoom[]; services?: ServiceRow[]; roomOverrides?: SroRow[]; clinicName?: string; adminName?: string; queuePolicy: QueuePolicyInitial }) {
  const router = useRouter();
  const [activeSection, setActiveSection] = useState("sec-clinic");

  /* 0160: повернення з Google OAuth редіректить на /setup?gcal=<код> —
     людина має опинитись САМЕ в секції резервного копіювання, а не на
     профілі клініки. САМЕ useLayoutEffect (ревʼю с42): passive-ефекти React
     стріляють знизу вгору, і дочірній GoogleCalendarBackupSettings у СВОЄМУ
     useEffect вирізає ?gcal= із URL (щоб F5 не повторював повідомлення) —
     звичайний useEffect батька читав би вже почищений URL і секція не
     перемикалась. Layout-ефекти всього дерева гарантовано йдуть РАНІШЕ
     будь-яких passive-ефектів — батько встигає прочитати параметр. */
  useLayoutEffect(() => {
    if (new URLSearchParams(window.location.search).has("gcal")) {
      setActiveSection("sec-gcal");
    }
  }, []);

  /* Контекстні позначки в майстрі (с28): store монтується ТУТ, бо на /setup
     штатного Sidebar немає — без маунта крапки й ack мовчки не працювали
     (жива перевірка с28). Крапки на пунктах — за мапінгом surfaces у WIZ_NAV.
     ⚠️ Ack тут НЕМАЄ ЖОДНОГО, і це свідомо (ревʼю с28-р3). Каталог у майстрі
     приходить SSR-пропом і оновлюється лише після ВЛАСНОЇ мутації
     (router.refresh) — realtime-підписки на services тут немає. Підтверджувати
     прочитання на такому екрані означало б погасити крапку, показавши знімок
     на момент завантаження сторінки: зміна колеги (або імпорт прайса) зникла б
     непоказаною — пряме порушення правила ТЗ «гасне лише те, що людина реально
     побачила». Крапка в майстрі — ВКАЗІВНИК; гасять її там, де дані живі:
     каталог — на /services (ServicesManager, surface-ack), доступи — у картці
     направника нижче (embedded ReferrersManager, ack по розгортанню). */
  const { index: wizUnreadIx } = useUnreadChanges();

  /* Нижче 480px список кроків — горизонтальна стрічка (WCAG 1.4.10), і активний
     крок легко опиняється за її правим краєм: користувач відкриває майстер на
     кроці 6 і бачить кроки 1–3 без жодної позначки, де він. Доскролюємо його в
     центр — лише в drawer-режимі й з повагою до prefers-reduced-motion. */
  const activeStepRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const el = activeStepRef.current;
    if (!el) return;
    if (!window.matchMedia("(max-width: 480px)").matches) return;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ inline: "center", block: "nearest", behavior: smooth ? "smooth" : "auto" });
  }, [activeSection]);
  const [saving, setSaving] = useState(false);
  const [valid, setValid] = useState<Record<number, boolean>>({});
  const [dirty, setDirty] = useState(false);
  const [exitAsk, setExitAsk] = useState(false);
  const [schedWarnAsk, setSchedWarnAsk] = useState<number | null>(null); // N майбутніх записів поза новим графіком
  const [toasts, push] = useToasts();
  const dataRef = useRef<WizardData | null>(null);
  /* Канал «батько → форма кабінетів»: після insert повертаємо в state форми
     видані db-id (див. коментар біля useState(equip) у StepRegister). */
  const assignRoomIdsRef = useRef<((a: Array<{ localId: number | string; roomId: string }>) => void) | null>(null);
  const savedRef = useRef<string | null>(null); // знімок збережених даних форми

  function report(k: number, ok: boolean) { setValid((v) => (v[k] === ok ? v : { ...v, [k]: ok })); }
  function onData(d: WizardData) {
    dataRef.current = d;
    const snap = JSON.stringify(d);
    if (savedRef.current === null) { savedRef.current = snap; return; } // базовий знімок при першому завантаженні
    setDirty(snap !== savedRef.current);
  }

  async function save(skipSchedWarn = false): Promise<boolean> {
    const d = dataRef.current;
    if (!d || saving) return false;
    setSaving(true);
    const clean = (a: string[]) => a.map((x) => x.trim()).filter(Boolean);
    try {
      /* Невалідний графік (кінець ≤ початок / порожні години / перетин перерв) НЕ
         зберігаємо — інакше сітка слотів зникає мовчки (roomScheduleFor не дасть
         жодного слота). Гейтить УСІ шляхи: і «Зберегти», і «Зберегти й вийти»
         (кнопка виходу valid[1] не перевіряє), і програмний виклик. */
      if (!equipHoursValid(d.equip) || !equipBreaksValid(d.equip)) {
        push("Виправте години або перерви кабінетів — вони підсвічені червоним", "error");
        setSaving(false);
        return false;
      }
      const supabase = createClient();

      /* Таймзона — ЯВНИЙ вибір адміна (поле в профілі центру). Раніше сюди щоразу
         писалась зона БРАУЗЕРА оператора: адмін із іншої країни (або з VPN) мовчки
         ламав час усієї клініки — а від нього залежать «Запізнення», «Уточнити»,
         гарди виклику й заборона запису в минуле. Порожню/невалідну зону не пишемо. */
      const tz = (d.timezone || "").trim();
      const tzValid = !!tz && (() => {
        try { new Intl.DateTimeFormat("uk-UA", { timeZone: tz }); return true; } catch { return false; }
      })();
      if (tz && !tzValid) {
        push("Некоректний часовий пояс центру", "error");
        setSaving(false);
        return false;
      }

      // Поля кабінета для БД (винесено вгору — потрібне і для перевірки нижче).
      const roomFields = (e: EquipItem): TablesInsert<"rooms"> => ({
        clinic_id: clinicId,
        name: (e.room || e.type).trim(),
        modality: modalityCode(e.type),
        apparatus_model: e.desc.trim() || null,
        active: e.active !== false,   // 0123
        schedule: {
          days: e.days, start: e.start, end: e.end,
          // Не зберігаємо некоректні інтервали (кінець ≤ початку / незаповнені).
          breaks: e.breaks.filter((b) => b.start && b.end && b.end > b.start),
          perDay: e.perDay,
          dayHours: e.dayHours.map((dh) => ({ start: dh.start, end: dh.end, breaks: dh.breaks.filter((b) => b.start && b.end && b.end > b.start) })),
        } as unknown as Json,
      });

      /* Попередження ПЕРЕД збереженням: чи є МАЙБУТНІ живі записи, що НЕ вкладаються в
         графік, який зберігаємо (ужали години / додали перерву / закрили день). Не
         блокуємо — питаємо підтвердження (на дошці ці записи підсвітяться «Не за
         графіком»). Осознанні off_schedule не рахуємо. Перевіряємо ДО будь-яких
         записів у БД, тож «Скасувати» не лишає часткових змін. */
      if (!skipSchedWarn) {
        const kept = d.equip.filter((e) => e.roomId);
        if (kept.length) {
          const { data: fut, error: fe } = await supabase
            .from("queue_entries")
            .select("room_id, scheduled_date, scheduled_time, duration_min, off_schedule, status")
            .in("room_id", kept.map((e) => e.roomId as string))
            .gte("scheduled_date", dateKeyOf(new Date()))
            .in("status", ["scheduled", "waiting", "in_progress", "needs_reschedule"]);
          if (fe) throw fe;
          const schedByRoom: Record<string, unknown> = {};
          kept.forEach((e) => { schedByRoom[e.roomId as string] = roomFields(e).schedule; });
          let bad = 0;
          for (const q of (fut || [])) {
            if (q.off_schedule || !q.scheduled_time || !q.scheduled_date) continue;
            const sch = schedByRoom[String(q.room_id)];
            if (!sch) continue;
            const [yy, mm, dd] = String(q.scheduled_date).split("-").map(Number);
            const date = new Date(yy, (mm || 1) - 1, dd || 1);
            const sched = roomScheduleFor(date, String(q.room_id), null, sch);
            const breaks = effectiveRoomBreaks(date, String(q.room_id), sch, null);
            if (offScheduleKind(slotToMin(String(q.scheduled_time)), q.duration_min || 30, sched, breaks)) bad++;
          }
          if (bad > 0) { setSchedWarnAsk(bad); setSaving(false); return false; }
        }
      }

      // Кабінети: оновлюємо наявні за id, додаємо нові, видаляємо лише прибрані.
      // (roomFields визначено вище — потрібне і для перевірки графіка перед збереженням.)
      /* ⚠ Видалення кабінету — НЕ безпечна операція: queue_entries.room_id і
         waitlist_entries.room_id мають ON DELETE SET NULL (0001), тож записи
         пацієнтів лишилися б у базі з room_id = NULL: зникають із дошки кабінету,
         з аналітики по кабінету, і ніхто про це не дізнається (раніше тут був
         просто тост «Зміни збережено»).
         ⚠️ ЦЕЙ БЛОК СТОЇТЬ ПЕРЕД ЗАПИСОМ У clinics/profiles СВІДОМО (ревʼю с18,
         Medium-3). Транзакції тут немає: якщо блокер спрацює після оновлення
         клініки й профілю, власник побачить «не збережено», хоча половина вже
         лягла. Блок нічого від тих апдейтів не потребує — лише clinicId і d.equip.
         ⚠️ КРИТЕРІЙ ЗМІНЕНО 2026-07-28 (0126): блокує БУДЬ-ЯКА історія, а не лише
         майбутні відкриті записи. Старий критерій пропускав кабінет із закритою
         минулою історією — саме так у проді осиротіли 44 записи. Той самий
         критерій у діалозі askDelEq і в тригері guard_delete_room; розійтись їм
         не можна, інакше діалог пропускатиме те, на чому впаде збереження. */
      const { data: existingRooms, error: ere } =
        await supabase.from("rooms").select("id, name, active").eq("clinic_id", clinicId);
      if (ere) throw ere;
      const keptIds = d.equip.map((e) => e.roomId).filter(Boolean) as string[];
      const removedRooms = (existingRooms || []).filter((r) => !keptIds.includes(r.id));
      if (removedRooms.length) {
        /* Рахуємо ЛІЧИЛЬНИКАМИ (head + count), а не вибіркою рядків: `select` без
           ліміту витягнув би в браузер усю історію кабінету, а при виставленому
           db-max-rows ще й збрехав би числом у тості (ревʼю с18, Medium-4). */
        const counts = await Promise.all(removedRooms.map(async (r) => {
          const [q, w] = await Promise.all([
            supabase.from("queue_entries").select("id", { count: "exact", head: true }).eq("room_id", r.id),
            supabase.from("waitlist_entries").select("id", { count: "exact", head: true }).eq("room_id", r.id),
          ]);
          if (q.error || w.error) throw q.error || w.error;
          return { room: r, n: (q.count ?? 0) + (w.count ?? 0) };
        }));

        const withHistory = counts.filter((c) => c.n > 0);
        if (withHistory.length) {
          const list = withHistory.map((c) => `«${c.room.name}» — ${c.n} запис(ів)`).join("; ");
          push("Кабінет з історією видалити не можна: " + list + ". Замість видалення вимкніть кабінет — історія залишиться цілою, а нових записів він не прийматиме.", "error");
          setSaving(false);
          return false;
        }
        /* Другий критерій діалогу — «спершу вимкніть» (0123). Без нього кабінет,
           який хтось увімкнув назад між askDelEq і «Зберегти», доходив би до
           тригера й повертав сирий ROOM_ACTIVE_DELETE у тост (ревʼю с18, Low-6). */
        const stillOn = removedRooms.filter((r) => (r as { active?: boolean | null }).active !== false);
        if (stillOn.length) {
          push("Спершу вимкніть кабінет, потім видаляйте: " + stillOn.map((r) => `«${r.name}»`).join("; ")
            + ". Вимкнення — оборотна дія, видалення — ні.", "error");
          setSaving(false);
          return false;
        }
      }

      const { error: ce } = await supabase
        .from("clinics")
        .update({
          name: d.clinic.trim(),
          city: d.city.trim() || null,
          address: d.address.trim() || null,
          phones: clean(d.phones),
          emails: clean(d.emails),
          ...(tzValid ? { timezone: tz } : {}),
          configured_at: new Date().toISOString(),
        })
        .eq("id", clinicId);
      if (ce) throw ce;

      const { error: pe } = await supabase
        .from("profiles")
        .update({
          full_name: d.adminName.trim() || null,
          phone: (d.aPhones.find((p) => p.trim()) || "").trim() || null,
        })
        .eq("id", userId);
      if (pe) throw pe;

      const keepIds: string[] = [];
      const assigned: Array<{ localId: number | string; roomId: string }> = [];
      for (const e of d.equip) {
        if (e.roomId) {
          const { error: ue } = await supabase.from("rooms").update(roomFields(e)).eq("id", e.roomId);
          if (ue) throw ue;
          keepIds.push(e.roomId);
        } else {
          const { data: ins, error: ie } = await supabase.from("rooms").insert(roomFields(e)).select("id").single();
          if (ie) throw ie;
          if (ins) { keepIds.push(ins.id); assigned.push({ localId: e.id, roomId: ins.id }); }
        }
      }
      /* Видані id — назад у форму, інакше друге «Зберегти» без перезавантаження
         сприйме щойно збережені кабінети як «прибрані» (баг с33). */
      if (assigned.length) assignRoomIdsRef.current?.(assigned);
      /* Прибрані в майстрі кабінети (історії в них уже точно немає — перевірили
         вище). 0123 + 0126: DELETE тут завжди по ВЖЕ вимкненому й ПОРОЖНЬОМУ
         кабінету — кнопка «✕» доступна лише для збереженого active=false без
         жодного запису, — тож тригер guard_delete_room лишається справжнім
         рубежем, а не формальністю, яку клієнт сам собі й обходить. */
      for (const r of removedRooms) {
        const { error: de } = await supabase.from("rooms").delete().eq("id", r.id);
        if (de) throw de;
      }

      savedRef.current = JSON.stringify(d);
      setDirty(false);
      push("Зміни збережено", "success");
      router.refresh(); // підтягнути свіжі rooms/services у крок «Послуги» без ручного перезавантаження
      setSaving(false);
      return true;
    } catch (e) {
      push("Помилка збереження: " + ((e as { message?: string })?.message || String(e)), "error");
      setSaving(false);
      return false;
    }
  }

  function exitSetup() {
    if (saving) return;
    if (dirty) { setExitAsk(true); return; }
    router.push("/queue");
  }
  async function saveAndExit() {
    const ok = await save();
    setExitAsk(false);
    if (ok) router.push("/queue");
  }

  return (
    <div className="wiz">
      <UnreadChangesMount />
      <aside className="wiz-side">
        <div className="wiz-head">
          <span className="wiz-logo"><span className="dot" />RadFlow</span>
          <div className="wiz-sub">{clinicName || "Налаштування та профіль кабінету"}</div>
        </div>
        <div className="wiz-steps">
          {WIZ_NAV.map((s) => {
            const on = activeSection === s.anchor;
            const secMarkers = s.surfaces ? s.surfaces.flatMap((k) => unreadForSurface(wizUnreadIx, k)) : [];
            return (
              <button key={s.label} type="button" className={"wstep wstep-btn" + (on ? " done" : "")} title={s.desc}
                ref={on ? activeStepRef : undefined}
                aria-current={on ? "true" : undefined} onClick={() => setActiveSection(s.anchor as string)}
                style={{ background: on ? "var(--card-hover)" : "none" }}>
                <span className="wstep-num" aria-hidden />
                <span className="wstep-txt">
                  <span className="wstep-title">{s.label}<UnreadDot markers={secMarkers} withCount /></span>
                  <span className="wstep-desc">{s.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="wiz-foot">
          {/* «Вийти» — над рядком «Майстер налаштувань · Підтримка», праворуч. */}
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
            <button className="btn btn-green" onClick={exitSetup} disabled={saving}>Вийти</button>
          </div>
          <div className="wiz-prog-lab">
            <span>Майстер налаштувань</span>
            <a href="mailto:support@radflow.ua?subject=Допомога%20з%20налаштуванням" title="Написати в підтримку">Підтримка</a>
          </div>
        </div>
      </aside>

      <div className="wiz-main">
        <div className="wiz-main-inner">
          {(
            <>
              {/* Кожне вікно налаштувань — окремо; перемикається кружками зліва */}
              <div style={{ display: FORM_SECTIONS.includes(activeSection) ? "block" : "none" }}>
                <StepRegister report={report} onData={onData} initial={initial} active={activeSection} assignRoomIds={assignRoomIdsRef}
                  clinicId={clinicId} services={services} rooms={rooms} roomOverrides={roomOverrides} notify={push} />
              </div>

              {/* 0078 — політика черги при затримці дослідження (лише адмін). */}
              <div className="fade-in" style={{ display: activeSection === "sec-queue" ? "block" : "none" }}>
                <h1 className="wiz-h">Управління чергою</h1>
                <p className="wiz-hsub">Що робити, коли дослідження затягнулося і наїжджає на наступні записи.</p>
                <QueuePolicySettings initial={queuePolicy} />
              </div>

              {/* 0160 — аварійне дзеркало черги в Google Calendar (лише адмін).
                  Самостійний блок: зберігається сам, у dirty майстра не входить. */}
              <div className="fade-in" style={{ display: activeSection === "sec-gcal" ? "block" : "none" }}>
                <h1 className="wiz-h">Резервне копіювання в Google Calendar</h1>
                <p className="wiz-hsub">Аварійна копія черги на випадок недоступності RadFlow.</p>
                <GoogleCalendarBackupSettings />
              </div>

              <div className="fade-in" style={{ display: activeSection === "sec-staff" ? "block" : "none" }}>
                <h1 className="wiz-h">Персонал і доступи</h1>
                <StaffManager embedded clinicId={clinicId} rooms={rooms} clinicName={clinicName} adminName={adminName} />
              </div>

              <div className="fade-in" style={{ display: activeSection === "sec-referrers" ? "block" : "none" }}>
                <h1 className="wiz-h">Лікарі-направники</h1>
                <ReferrersManager embedded clinicId={clinicId} rooms={rooms} clinicName={clinicName} adminName={adminName} />
              </div>

              <div className="fade-in" style={{ display: activeSection === "sec-ceo" ? "block" : "none" }}>
                <h1 className="wiz-h">Керівники (CEO)</h1>
                <CeoManager embedded clinicId={clinicId} clinicName={clinicName} adminName={adminName} />
              </div>
            </>
          )}
        </div>

        <div className="wiz-bar">
          <div className="wiz-bar-inner">
            <div className="wiz-bar-right" style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
              <span className="wiz-cta-wrap" title={!valid[1] ? (() => { const eq = dataRef.current?.equip ?? []; return (!equipHoursValid(eq) || !equipBreaksValid(eq)) ? "Виправте години або перерви кабінетів — вони підсвічені червоним" : "Заповніть назву клініки, місто, ПІБ і телефон адміністратора та хоча б один апарат"; })() : (!dirty ? "Немає незбережених змін" : undefined)}>
                <button className="btn btn-green" onClick={() => save()} disabled={!valid[1] || saving || !dirty}>
                  {saving ? "Зберігаємо…" : "Зберегти"}
                </button>
              </span>
            </div>
          </div>
        </div>
      </div>

      {exitAsk && (
        <div className="overlay" onClick={() => !saving && setExitAsk(false)}>
          <div className="dialog fade-in" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <div className="dlg-head"><div className="dlg-title">Незбережені зміни</div><button className="icon-btn" aria-label="Закрити" onClick={() => setExitAsk(false)} disabled={saving}>✕</button></div>
            <div className="dlg-body">У налаштуваннях є незбережені зміни. Зберегти їх перед виходом?</div>
            <div className="dlg-foot" style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setExitAsk(false)} disabled={saving}>Скасувати</button>
              <button className="btn btn-secondary" onClick={() => { setExitAsk(false); router.push("/queue"); }} disabled={saving}>Вийти без збереження</button>
              <button className="btn btn-green" onClick={saveAndExit} disabled={saving}>{saving ? "Зберігаємо…" : "Зберегти й вийти"}</button>
            </div>
          </div>
        </div>
      )}
      {schedWarnAsk != null && (
        <ConfirmDialog
          title="Записи поза новим графіком"
          text={<>Майбутніх записів пацієнтів, що не вкладаються в графік, який ви зберігаєте (кабінет закритий цього дня, поза годинами роботи або в перерву): <b>{schedWarnAsk}</b>. На дошці черги їх буде підсвічено «⚠ Не за графіком». Зберегти графік усе одно?</>}
          confirmLabel="Зберегти графік"
          cancelLabel="Скасувати"
          busy={saving}
          onClose={() => setSchedWarnAsk(null)}
          onConfirm={() => { setSchedWarnAsk(null); save(true); }}
        />
      )}
      {/* Небезпечна зона — в кінці майстра свідомо: видалення центру не має
          сусідити з полями, які редагують щодня. clinicName — прóпс сторінки;
          порожній буває лише в мить першого налаштування, тоді видаляти ще
          нічого і секцію не показуємо. */}
      {clinicName ? <DangerZone clinicName={clinicName} /> : null}
      <Toasts toasts={toasts} />
    </div>
  );
}
