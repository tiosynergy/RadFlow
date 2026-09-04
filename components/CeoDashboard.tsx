"use client";

/* ===== RadFlow — CEO Dashboard (Загальний огляд) =====
   Виконавчий дашборд: KPI, тижневий графік, топ-процедури, завантаженість апаратів.
   Метрики рахуються з queue_entries (період: сьогодні / тиждень / місяць). Realtime. */

import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode, type CSSProperties } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import { wallToday0 } from "@/lib/incidents";
import { modalityLabel, modalityCode, fmtUah } from "@/lib/studies";
import { quickSearchMatch } from "@/lib/quickSearch";
import { useModalA11y } from "@/lib/useModalA11y";
import Sidebar from "@/components/Sidebar";
import LiveClock from "@/components/LiveClock";
import Toast from "@/components/Toast";
import { visibleRooms } from "@/lib/rooms";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null; active?: boolean | null };
type StudyLike = { price?: number; region?: string; contrast?: boolean; type?: string };
type RevenueEntry = { studies?: unknown; note?: string | null; clinic_id?: string | null; room_id?: string | null };

/* Агрегати з БД (міграція 0071). Раніше дашборд тягнув У БРАУЗЕР усі рядки за
   період по всіх центрах — разом із ПІБ і studies (до ~120k рядків у мережі з
   20 центрів) — і рахував KPI в JS. Тепер рахує Postgres, а ПІБ сюди не їде
   взагалі: він потрібен лише в CSV, і той вантажиться за окремим кліком. */
type TotalsRow = { scheduled_date: string; status: string; cnt: number; booked_min: number };
type RoomsRow = { room_id: string; booked_min: number };
/* cnt — позицій (для доходу); first_cnt — записів, де це дослідження ПЕРШЕ
   (старий топ-5 рахував саме по записах, за studies[0]). */
type StudiesRow = { status: string; study_type: string; region: string; contrast: boolean; cnt: number; first_cnt: number; priced_sum: number; unpriced: number; catalog_est_sum: number };

const WK_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
const MON_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
/* «Сьогодні» — за настінним часом ЦЕНТРУ (tz), а не браузера керівника: CEO
   глобальний і може дивитися центр в іншій зоні, де доба вже інша (аудит M-4).
   Для агрегату «Всі центри» єдиної зони не існує — там зона браузера (див. scopeTz). */
function today0(tz?: string) { return wallToday0(tz); }
function dateKey(d: Date) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function fmtShort(d: Date) { return d.getDate() + " " + MON_GEN[d.getMonth()]; }

/* Каталог scoped-центрів для CSV: clinic_id → «modalityCode|region» → ціна/контраст.
   Дзеркалить catalog_est_sum з RPC 0114/0121 (чистий каталог): дохід рахуємо на
   сервері (агрегат), а для рядкового CSV — тут, тією ж логікою, БЕЗ static-фолбэку.
   0121 (room-owned): видимі запису послуги = базові (room_id NULL) + власні кабінету
   запису; власна кабінету має ПРІОРИТЕТ над базовою при дублі імені — дзеркало
   `order by (sv.room_id is not null) desc, sort_order, id` у ceo_kpi_studies.
   (Відоме обмеження, як і в RPC: override-и 0108 тут свідомо не враховуються.) */
type CsvSvc = { price: number; contrastPrice: number | null };
type CsvCatalog = {
  base: Map<string, Map<string, CsvSvc>>;                    // clinic → key → послуга
  room: Map<string, Map<string, Map<string, CsvSvc>>>;       // clinic → room → key → послуга
};
function buildCsvCatalog(rows: { clinic_id: string; modality: string; name: string; price: number; contrast_price: number | null; room_id: string | null }[]): CsvCatalog {
  const cat: CsvCatalog = { base: new Map(), room: new Map() };
  for (const r of rows) {                       // лише активні, впорядковані sort_order, id
    const key = r.modality + "|" + r.name;
    if ((r.room_id ?? null) === null) {
      let inner = cat.base.get(r.clinic_id);
      if (!inner) { inner = new Map(); cat.base.set(r.clinic_id, inner); }
      if (!inner.has(key)) inner.set(key, { price: r.price, contrastPrice: r.contrast_price });  // перша = пріоритетна
    } else {
      let byRoom = cat.room.get(r.clinic_id);
      if (!byRoom) { byRoom = new Map(); cat.room.set(r.clinic_id, byRoom); }
      let inner = byRoom.get(r.room_id as string);
      if (!inner) { inner = new Map(); byRoom.set(r.room_id as string, inner); }
      if (!inner.has(key)) inner.set(key, { price: r.price, contrastPrice: r.contrast_price });
    }
  }
  return cat;
}

/* Дохід запису: збережена ціна (снапшот) виграє; інакше — ціна КАТАЛОГУ центру
   (чистий каталог: лише коли послуга видима запису і price > 0), інакше 0.
   0121: спершу власна послуга кабінету запису, потім базова (пріоритет RPC). */
function entryRevenue(e: RevenueEntry, cat: CsvCatalog): number {
  const s: StudyLike[] = Array.isArray(e.studies) ? (e.studies as StudyLike[]) : [];
  if (!s.length) return 0;
  const roomInner = e.clinic_id && e.room_id ? cat.room.get(e.clinic_id)?.get(e.room_id) : undefined;
  const baseInner = e.clinic_id ? cat.base.get(e.clinic_id) : undefined;
  return s.reduce((sum, x) => {
    if (typeof x.price === "number") return sum + x.price;
    const key = modalityCode(x.type) + "|" + (x.region || "");
    const svc = roomInner?.get(key) ?? baseInner?.get(key);
    /* Ціна каталогу — БЕЗ доплати за контраст: контрастна позиція прайсу має
       власну ціну (4900 проти 2200), доплата рахувала б контраст двічі. Записи
       зі збереженим снапшотом ціни (гілка вище) історію не змінюють. */
    if (svc && svc.price > 0) return sum + svc.price;
    return sum;
  }, 0);
}
function procName(e: RevenueEntry): string {
  const s: StudyLike[] = Array.isArray(e.studies) ? (e.studies as StudyLike[]) : [];
  if (s.length) return (s[0].type || "") + (s[0].region ? " · " + s[0].region : "");
  return e.note || "—";
}

function periodRange(period: string, tz?: string): [Date, Date] {
  const t = today0(tz);
  if (period === "today") return [t, t];
  if (period === "week") { const mon = addDays(t, -((t.getDay() + 6) % 7)); return [mon, addDays(mon, 6)]; }
  const first = new Date(t.getFullYear(), t.getMonth(), 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0);
  return [first, last];
}
function workdaysBetween(a: Date, b: Date): number {
  let n = 0; let d = new Date(a);
  while (d <= b) { if (d.getDay() !== 0) n++; d = addDays(d, 1); }
  return n;
}

/* unknown — дані для відсотка НЕ прийшли. Малюємо «—» і порожнє коло: намальовані
   0% (та ще й червоним) керівник читає як «апарати простоюють». */
function ProgressCircle({ pct, color, unknown = false }: { pct: number; color: string; unknown?: boolean }) {
  const r = 52, c = 2 * Math.PI * r, off = unknown ? c : c * (1 - Math.min(100, pct) / 100);
  return (
    <svg width="130" height="130" viewBox="0 0 130 130">
      <circle cx="65" cy="65" r={r} fill="none" stroke="var(--border)" strokeWidth="10" />
      <circle cx="65" cy="65" r={r} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={off} transform="rotate(-90 65 65)" style={{ transition: "stroke-dashoffset .5s" }} />
      <text x="65" y="64" textAnchor="middle" fontSize="30" fontWeight="700" fill={unknown ? "var(--text-muted)" : "var(--text)"} className="tabular">{unknown ? "—" : pct + "%"}</text>
      <text x="65" y="86" textAnchor="middle" fontSize="11" fill="var(--text-muted)">завантаж.</text>
    </svg>
  );
}

const card = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 20 };

const STATUS_LABEL: Record<string, string> = {
  scheduled: "В черзі", waiting: "Очікує", in_progress: "В кабінеті",
  done: "Виконано", no_show: "Неявка", not_held: "Не відбулося", needs_reschedule: "Потребує переносу", cancelled: "Скасовано",
};
type DrillRow = { date: string; name: string; proc: string; room: string; status: string; rev: number };
/* Клікабельний KPI → drill-down зі списком записів (доступно: role=button + Enter/Space). */
function Drillable({ onOpen, label, style, children }: { onOpen: () => void; label: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <span role="button" tabIndex={0} title={"Показати записи: " + label} style={{ cursor: "pointer", ...style }}
      onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}>
      {children}
    </span>
  );
}

/* Обгортка drill-down-діалогу під загальний modal-контракт (RF-06 аудиту
   с32: діалог мав role="dialog", але без useModalA11y — Tab тікав під
   overlay, Esc не закривав, фокус не повертався на KPI). Окремий компонент,
   а не хук у CeoDashboard: useModalA11y фіксує елемент-тригер під час
   ПЕРШОГО рендера — тож монтуватись він мусить разом із відкриттям вікна,
   коли активний елемент — це ще натиснутий KPI (Drillable). */
function DrillOverlay({ onClose, label, style, children }: {
  onClose: () => void; label: string; style?: CSSProperties; children: ReactNode;
}) {
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="dialog fade-in" style={style} role="dialog" aria-modal="true" aria-label={"Записи: " + label}>
        {children}
      </div>
    </div>
  );
}

type ClinicOpt = { id: string; name: string; timezone?: string | null };

interface CeoDashboardProps {
  clinics: ClinicOpt[];          // центри, доступні цьому користувачу
  clinicName?: string;
  adminName?: string;
  adminRole?: string;
  /** ⚠️ Обовʼязковий, без типового значення — RF-4, с57. Див. Sidebar. */
  roleKey: string;
}

export default function CeoDashboard({ clinics, clinicName, adminName, adminRole, roleKey }: CeoDashboardProps) {
  const [period, setPeriod] = useState("today");
  // scope: "all" — агрегат по всіх доступних центрах, або конкретний clinic_id.
  const [scope, setScope] = useState<string>(clinics.length === 1 ? clinics[0].id : "all");
  const [rooms, setRooms] = useState<RoomOpt[]>([]);
  const [totals, setTotals] = useState<TotalsRow[]>([]);        // період (KPI)
  const [weekTotals, setWeekTotals] = useState<TotalsRow[]>([]); // поточний тиждень (графік)
  const [roomRows, setRoomRows] = useState<RoomsRow[]>([]);
  const [studyRows, setStudyRows] = useState<StudiesRow[]>([]);
  const [loading, setLoading] = useState(true);
  /* U-7 (с46): останній прохід reload() НЕ завершився. Прапорець постійний (тост
     зникає, цифри лишаються) і має рівно одне призначення — не давати ПОХІДНИМ
     нулям виглядати як факт: «0% завантаж.», «Кабінетів немає» тощо. Знімається
     тільки повним успішним проходом. */
  const [dataErr, setDataErr] = useState(false);
  /* Покоління завантаження (той самий приймач, що в lib/slotBusy — аудит H-3A).
     reload() перестворюється при зміні періоду/scope і запускається негайно, тож
     проходи ПЕРЕКРИВАЮТЬСЯ. Без покоління пізній успіх старого проходу знімав би
     dataErr і малював чужий період без банера — тобто рівно те, від чого
     прапорець і поставлено (ревʼю пакета, знахідка 3). */
  const genRef = useRef(0);
  /* Ключ даних, які ЗАРАЗ на екрані. При збої показувати старі цифри можна лише
     якщо вони про той самий scope/період: інакше кабінети центру А стоятимуть
     під назвою центру Б (ревʼю пакета, знахідка 2).
     Тримаємо і в ref, і в стані: ref потрібен логіці reload() (він не
     перестворюється на зміну ключа й бачив би застигле значення), стан — рендеру,
     бо від нього залежить, чи можна взагалі називати цифри. */
  const loadedKeyRef = useRef<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const markLoaded = (k: string | null) => { loadedKeyRef.current = k; setLoadedKey(k); };
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* roomsById — ПОВНИЙ перелік, включно з вимкненими: за ним резолвиться назва
     кабінету в CSV і в drill-down. Це рядки ЗАПИСІВ, а не список кабінетів. */
  const roomsById = useMemo(() => { const m: Record<string, RoomOpt> = {}; rooms.forEach((r) => { m[r.id] = r; }); return m; }, [rooms]);

  /* ===== Вимкнені кабінети на дашборді: ділимо оперативне й історичне =====
     ОПЕРАТИВНЕ (сайдбар, «Завантаженість», смужки по апаратах) рахуємо БЕЗ
     вимкнених: виведений з експлуатації апарат тримав би в знаменнику 8 годин
     на день, яких фізично немає, і завантаженість центру виглядала б нижчою,
     ніж вона є, — рівно тоді, коли керівник дивиться, чи не пора докупити апарат.
     ІСТОРИЧНЕ (дохід, кількість виконаних, топ-процедури, тижневий графік, CSV,
     drill-down) лишається ПОВНИМ: воно рахується агрегатами БД по queue_entries і
     кабінети там не фільтруються взагалі. Інакше вимкнення апарата заднім числом
     зменшило б торішній дохід — цифри, які вже пішли у звіти.
     Залишків («вимкнено · N») тут не рахуємо: у scope може бути 20 центрів у
     різних зонах, і це були б 20 додаткових запитів на кожен рефетч. Спрацьовує
     документований fail-closed із lib/rooms.ts — видимими лишаються активні. */
  const visRooms = useMemo(() => visibleRooms(rooms), [rooms]);
  const [drill, setDrill] = useState<{ statuses: string[] | null; label: string } | null>(null);
  const [drillRows, setDrillRows] = useState<DrillRow[] | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);
  // с22: швидкий пошук у read-only drill-списку (еквівалент дневної черги CEO) —
  // фільтрує ЛИШЕ вже завантажені рядки, порядок не змінює, нікуди не пишеться.
  const [drillQuery, setDrillQuery] = useState("");
  useEffect(() => { setDrillQuery(""); }, [drill]);

  /* Зона, за якою рахується «сьогодні»/«цей тиждень»: обраного центру, а при
     «Всі центри» — ПЕРШОГО доступного. Спільної доби в кількох зонах не існує,
     тож вибір довільний — але він має бути ДЕТЕРМІНОВАНИМ: якщо лишити undefined,
     wallToday0() впаде на singleton setClinicTz(), а там може лежати зона центру
     з попереднього екрана (клієнтська навігація /queue → /ceo). */
  const scopeTz = useMemo(() => {
    const c = scope !== "all" ? clinics.find((x) => x.id === scope) : clinics[0];
    return c?.timezone || undefined;
  }, [scope, clinics]);

  const clinicIds = useMemo(
    () => (scope === "all" ? clinics.map((c) => c.id) : [scope]),
    [scope, clinics]
  );

  /* Зріз, який зараз ОБРАНО. Один вираз і для reload(), і для рендера — інакше
     дві копії ключа розійдуться, і «свіжість» почне брехати. */
  const dataKey = useMemo(() => scope + "|" + period + "|" + clinicIds.join(","), [scope, period, clinicIds]);

  function notify(msg: string, type = "info") { setToast({ msg, type }); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), type === "error" ? 6000 : 3000); }

  const [from, to] = periodRange(period, scopeTz);

  const reload = useCallback(async () => {
    const key = dataKey;
    const gen = ++genRef.current;
    const stale = () => gen !== genRef.current;   // нас обігнав новіший прохід
    /* Збій: старі цифри лишаємо на екрані ЛИШЕ якщо вони про цей самий зріз —
       інакше стираємо, бо «застарілі» й «від іншого центру» це різні речі. */
    const failed = () => {
      if (stale()) return;
      if (loadedKeyRef.current !== key) {
        markLoaded(null);
        setRooms([]); setTotals([]); setWeekTotals([]); setRoomRows([]); setStudyRows([]);
      }
      setDataErr(true);
      notify("Не вдалося оновити показники — спробуйте оновити сторінку", "error");
    };
    if (clinicIds.length === 0) {
      markLoaded(key);   // «центрів немає» — теж повноцінна відповідь про цей зріз
      setRooms([]); setTotals([]); setWeekTotals([]); setRoomRows([]); setStudyRows([]); setDataErr(false); setLoading(false); return;
    }
    // Транзиентний мережевий збій (напр. оновлення токена Supabase) не повинен
    // валити UI неперехопленим reject — realtime/focus-рефетч підхопить дані пізніше.
    try {
      const supabase = createClient();
      const [f, t] = periodRange(period, scopeTz);
      const wk = today0(scopeTz); const mon = addDays(wk, -((wk.getDay() + 6) % 7));
      // scope="all" → усі доступні центри (RPC однаково ріже по auth_ceo_clinics()).
      const p_clinics = scope === "all" ? null : [scope];

      const rres = await supabase
        .from("rooms")
        .select("id, name, modality, apparatus_model, active")   // active — для поділу «оперативне / історичне», див. visRooms
        .in("clinic_id", clinicIds);
      /* U-7 (с46): помилка цього читання РАНІШЕ НАВІТЬ НЕ ЗВ'ЯЗУВАЛАСЬ — брали
         тільки data. При збої (RLS, мережа, оновлення токена) rdata=null →
         setRooms([]) → visRooms=[] → capacityMin=0 → «0% завантаж.» ЧЕРВОНИМ і
         «Кабінетів немає». Керівник читав збій читання як факт «апарати
         простоюють». Це той самий клас, що RPC нижче, і тут він голосніший:
         рішення про закупівлю/зміни приймають саме за цією цифрою. */
      if (rres.error) { failed(); return; }
      if (stale()) return;
      setRooms(rres.data || []);

      // Агрегати рахує БД (0071): у браузер їдуть десятки рядків замість десятків тисяч.
      const weekSame = period === "week";   // період уже дорівнює тижню — не питаємо двічі
      const [tot, wtot, rms, sts] = await Promise.all([
        supabase.rpc("ceo_kpi_totals",  { p_from: dateKey(f), p_to: dateKey(t), p_clinics }),
        weekSame
          ? Promise.resolve(null)
          : supabase.rpc("ceo_kpi_totals", { p_from: dateKey(mon), p_to: dateKey(addDays(mon, 6)), p_clinics }),
        supabase.rpc("ceo_kpi_rooms",   { p_from: dateKey(f), p_to: dateKey(t), p_clinics }),
        supabase.rpc("ceo_kpi_studies", { p_from: dateKey(f), p_to: dateKey(t), p_clinics }),
      ]);

      // Помилку RPC НЕ ковтаємо: інакше дашборд мовчки покаже нулі (напр. якщо
      // міграція не накатана або немає гранту) — і це виглядатиме як «немає роботи».
      if (tot.error || rms.error || sts.error || (wtot && wtot.error)) { failed(); return; }
      if (stale()) return;

      setTotals((tot.data || []) as TotalsRow[]);
      setWeekTotals(((weekSame ? tot.data : wtot?.data) || []) as TotalsRow[]);
      setRoomRows((rms.data || []) as RoomsRow[]);
      setStudyRows((sts.data || []) as StudiesRow[]);
      markLoaded(key);
      setDataErr(false);   // повний успішний прохід — і лише він знімає прапорець
    } catch (e) {
      // Неперехоплений транзієнт — той самий шлях, що й явні гілки помилок вище.
      failed();
      console.warn("CEO dashboard reload failed (буде повтор):", e);
    } finally {
      if (!stale()) setLoading(false);
    }
  }, [clinicIds, period, scope, scopeTz, dataKey]);

  // Спинер при первой загрузке/смене набора центров.
  useEffect(() => { setLoading(true); }, [clinicIds]);

  // Перерасчёт при смене периода/scope.
  useEffect(() => { reload(); }, [reload]);

  // TD-3: единый realtime-паттерн — подписка на каждый доступный центр.
  useRealtimeRefetch({
    channelName: clinicIds.length ? "ceo-" + scope : null,
    // debounceKey СПІЛЬНИЙ: усі підписки ведуть в один reload, і без нього сплеск
    // у 20 центрах давав до 20 повних перезавантажень дашборда підряд.
    subscriptions: clinicIds.flatMap((cid) => [
      { table: "queue_entries" as const, filter: "clinic_id=eq." + cid, onChange: reload, debounceKey: "ceo-reload" },
      // 0086: rooms — reload сам перечитує кабінети (.from("rooms")), тож той самий
      // reload оновить назви/кількість апаратів; router тут не потрібен.
      { table: "rooms" as const, filter: "clinic_id=eq." + cid, onChange: reload, debounceKey: "ceo-reload" },
    ]),
  });

  const scopeName = scope === "all" ? "Всі центри" : (clinics.find((c) => c.id === scope)?.name || clinicName || "");

  /* KPI — з агрегатів БД (0071). Формули ті самі, що були в JS. */
  const sumBy = (rows: TotalsRow[], pred: (r: TotalsRow) => boolean) =>
    rows.reduce((s, r) => (pred(r) ? s + r.cnt : s), 0);

  const total = sumBy(totals, () => true);
  const done = sumBy(totals, (r) => r.status === "done");
  const noShow = sumBy(totals, (r) => r.status === "no_show");
  const notHeld = sumBy(totals, (r) => r.status === "not_held");
  const active = sumBy(totals, (r) => ["scheduled", "waiting", "in_progress"].includes(r.status));

  const _t0 = today0(scopeTz);
  const workdays = Math.max(1, workdaysBetween(from, to < _t0 ? to : _t0));
  const capacityMin = visRooms.length * 480 * workdays;
  /* Ефективна зайнятість = тривалість + буфер (буфер теж споживає ємність кабінету);
     неявка / «не відбулося» кабінет не займали.
     Рахуємо по ceo_kpi_rooms (roomRows), а не по totals: лише так із чисельника
     можна прибрати ХВИЛИНИ ВИМКНЕНИХ кабінетів — інакше їх ємності вже немає в
     знаменнику, а хвилини лишились, і коло показувало б 100% на рівному місці.
     Набір статусів у обох RPC однаковий (0079: cancelled/needs_reschedule ріже
     ceo_kpi_totals, no_show/not_held — фільтр нижче).

     ⚠️ АЛЕ цифра МОЖЕ помітно змінитись, і применшувати це не можна: ceo_kpi_rooms
     не бачить записів із room_id IS NULL, а на проді станом на 2026-07 таких було
     37 із 95 на тій самій популяції, що рахують обидва RPC (≈2215 хв).
     Такий запис не займає ЖОДНОГО апарата,
     тож у завантаженість кабінетів він і не мав входити — але керівник, який
     пам'ятає стару цифру, прочитає падіння як баг. Тому нижче ми показуємо
     «N хв без кабінету» окремим рядком, а не ховаємо різницю.
     Ця ж сума живить смужки «по апаратах» нижче. */
  const bookedMin = visRooms.reduce((s, r) => s + (roomRows.find((x) => x.room_id === r.id)?.booked_min || 0), 0);
  /* Хвилини, які НЕ лягли в жоден видимий кабінет: записи без room_id + вимкнені
     кабінети. Показуємо їх явно — інакше знаменник і чисельник «не сходяться»
     з рештою дашборда, і це виглядає як втрата даних. */
  const bookedMinAll = totals.reduce((s, r) => (["no_show", "not_held"].includes(r.status) ? s : s + (r.booked_min || 0)), 0);
  const unroomedMin = Math.max(0, bookedMinAll - bookedMin);
  const util = capacityMin ? Math.min(100, Math.round((bookedMin / capacityMin) * 100)) : 0;
  /* U-7: похідне число можна показувати як ФАКТ лише тоді, коли дані, з яких воно
     порахувалося, справді прийшли І описують ОБРАНИЙ зріз. Інакше «0%» червоним
     читається як «апарати простоюють», «Записи 0» — як «сьогодні порожньо», а
     «0 ₴» — як «доходу немає»; хоча це був збій читання.
     Жива перевірка на проді показала, чому одного `utilKnown` мало: коло чесно
     стало «—», а поруч лишились «Записи 0» і «Дохід 0 ₴» — той самий дефект,
     просто в сусідніх картках. Прапорець один на ВСІ похідні числа екрана.
     Коли дані є і вони про цей самий зріз (не оновились, але свої) — цифри
     лишаються: про несвіжість каже банер, а стирати робочі числа нема за що. */
  const dataFresh = loadedKey === dataKey;
  const utilKnown = dataFresh;
  const utilColor = util > 70 ? "var(--green)" : util >= 50 ? "var(--orange)" : "var(--red)";

  /* Дохід — лише по 'done'. БД (RPC 0114) віддає суму ЗБЕРЕЖЕНИХ цін (снапшот) +
     оцінку позицій без ціни ПО КАТАЛОГУ центру (catalog_est_sum, чистий каталог:
     послуга з price > 0; інакше 0). Хардкод-довідник прибрано. */
  const doneStudies = studyRows.filter((r) => r.status === "done");
  const revenue = doneStudies.reduce((s, r) => s + Number(r.priced_sum || 0) + Number(r.catalog_est_sum || 0), 0);
  // «Точний» дохід = у всіх позицій збережена ціна І немає виконаних записів БЕЗ
  // досліджень (у старому entryFullyPriced такий запис теж робив підсумок оцінковим).
  const doneWithStudies = doneStudies.filter((r) => r.cnt > 0);
  const doneWithoutStudies = doneStudies.some((r) => r.cnt === 0 && r.first_cnt > 0);
  const revenueExact = doneWithStudies.length > 0 && !doneWithoutStudies && doneWithStudies.every((r) => r.unpriced === 0);

  /* тижневий графік: total + неявки по днях (Пн–Нд) */
  const wk = today0(scopeTz); const mon = addDays(wk, -((wk.getDay() + 6) % 7));
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(mon, i));
  const weekData = weekDays.map((d) => {
    const k = dateKey(d);
    const rows = weekTotals.filter((r) => r.scheduled_date === k);
    return {
      d,
      total: rows.reduce((s, r) => s + r.cnt, 0),
      noShow: rows.reduce((s, r) => (r.status === "no_show" || r.status === "not_held" ? s + r.cnt : s), 0),
    };
  });
  const maxBar = Math.max(1, ...weekData.map((x) => x.total));

  /* Топ-5 процедур — по ЗАПИСАХ (перше дослідження), як і раніше: first_cnt.
     Якби рахували по позиціях (cnt), запис із двома дослідженнями давав би дві
     одиниці в різні бакети — цифри б «попливли» проти старого дашборда. */
  const procMap: Record<string, number> = {};
  studyRows.forEach((r) => {
    if (!r.first_cnt) return;
    const n = r.study_type
      ? r.study_type + (r.region ? " · " + r.region : "")
      : "—";   // запис без досліджень
    procMap[n] = (procMap[n] || 0) + r.first_cnt;
  });
  const topProcs = Object.entries(procMap).sort((a, b) => b[1] - a[1]).slice(0, 5);

  /* завантаженість по апаратах */
  const minsByRoom: Record<string, number> = {};
  roomRows.forEach((r) => { if (r.room_id) minsByRoom[r.room_id] = r.booked_min || 0; });
  const roomUtil = visRooms.map((r) => {
    const mins = minsByRoom[r.id] || 0;
    const cap = 480 * workdays;
    return { name: r.name, kind: modalityLabel(r.modality), pct: cap ? Math.min(100, Math.round((mins / cap) * 100)) : 0, color: r.modality === "MRI" ? "var(--blue-text)" : "var(--orange)" };
  });

  const [exporting, setExporting] = useState(false);

  /* CSV — ЄДИНЕ місце, де CEO потрібні рядки з ПІБ. Тому вантажимо їх ЛИШЕ тут,
     за явним кліком, а не на кожен рефетч дашборда (раніше ПІБ + studies їхали
     в браузер постійно, разом із realtime-перезавантаженнями). */
  async function exportCsv() {
    if (exporting) return;
    setExporting(true);
    try {
      const supabase = createClient();
      const [f, t] = periodRange(period, scopeTz);   // той самий період, що й у KPI
      const { data, error } = await supabase
        .from("queue_entries")
        .select("status, studies, room_id, scheduled_date, patient_name, note, clinic_id")
        .in("clinic_id", clinicIds)
        .neq("status", "cancelled")
        .gte("scheduled_date", dateKey(f))
        .lte("scheduled_date", dateKey(t))
        .order("scheduled_date", { ascending: true })
        .limit(5000);
      if (error) { notify("Не вдалося сформувати експорт — спробуйте ще раз", "error"); return; }

      // Каталог scoped-центрів для оцінки позицій без снапшот-ціни (як catalog_est_sum
      // у RPC 0114). Впорядковано active desc → перша послуга name=region пріоритетна.
      const { data: svc } = await supabase
        .from("services")
        .select("clinic_id, modality, name, price, contrast_price, room_id") // 0121: room_id — пріоритет власної послуги кабінету запису
        .in("clinic_id", clinicIds)
        .eq("active", true)                              // лише активний каталог (як RPC 0114 / buildCatalog)
        .order("sort_order").order("id");
      const csvCatalog = buildCsvCatalog((svc || []) as { clinic_id: string; modality: string; name: string; price: number; contrast_price: number | null; room_id: string | null }[]);

      const head = ["Дата", "Пацієнт", "Процедура", "Кабінет", "Статус", "Дохід"];
      const rows = (data || []).map((e) => [
        e.scheduled_date,
        e.patient_name,
        procName(e as RevenueEntry),
        (e.room_id ? roomsById[e.room_id] : null)?.name || "",
        e.status,
        entryRevenue(e as RevenueEntry, csvCatalog),
      ]);
      // Захист від CSV-інʼєкції: значення, що починаються з = + - @, екрануємо апострофом.
      const safe = (c: unknown) => { let v = String(c == null ? "" : c); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
      const csv = [head, ...rows].map((r) => r.map(safe).join(";")).join("\n");
      const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "ceo-" + period + ".csv"; a.click(); URL.revokeObjectURL(url);
      notify("Експортовано у CSV" + ((data?.length ?? 0) >= 5000 ? " (перші 5000 записів)" : ""), "success");
    } finally {
      setExporting(false);
    }
  }

  /* Drill-down: клік по KPI → список записів за той самий період (переиспользує
     запит exportCsv + ту саму оцінку доходу). Клієнтський — без нового RPC/міграції.
     RLS ceo_access вже пускає CEO до цих записів (як і CSV-експорт). */
  async function openDrill(statuses: string[] | null, label: string) {
    setDrill({ statuses, label });
    setDrillRows(null);
    setDrillLoading(true);
    try {
      const supabase = createClient();
      const [f, t] = periodRange(period, scopeTz);
      let q = supabase
        .from("queue_entries")
        .select("status, studies, room_id, scheduled_date, patient_name, note, clinic_id")
        .in("clinic_id", clinicIds)
        .gte("scheduled_date", dateKey(f))
        .lte("scheduled_date", dateKey(t));
      q = statuses ? q.in("status", statuses as ("scheduled" | "waiting" | "in_progress" | "done" | "no_show" | "not_held" | "needs_reschedule" | "cancelled")[]) : q.neq("status", "cancelled");
      const { data, error } = await q.order("scheduled_date", { ascending: true }).limit(1000);
      if (error) { notify("Не вдалося завантажити список — спробуйте ще раз", "error"); return; }
      const { data: svc } = await supabase
        .from("services")
        .select("clinic_id, modality, name, price, contrast_price, room_id") // 0121: room_id — пріоритет власної послуги кабінету запису
        .in("clinic_id", clinicIds).eq("active", true).order("sort_order").order("id");
      const cat = buildCsvCatalog((svc || []) as { clinic_id: string; modality: string; name: string; price: number; contrast_price: number | null; room_id: string | null }[]);
      setDrillRows(((data || []) as Array<RevenueEntry & { scheduled_date: string; patient_name: string | null; room_id: string | null; status: string }>).map((e) => ({
        date: e.scheduled_date,
        name: e.patient_name || "—",
        proc: procName(e),
        room: (e.room_id ? roomsById[e.room_id] : null)?.name || "—",
        status: e.status,
        rev: entryRevenue(e, cat),
      })));
    } finally {
      setDrillLoading(false);
    }
  }

  const PERIODS = [{ k: "today", l: "Сьогодні" }, { k: "week", l: "Цей тиждень" }, { k: "month", l: "Цей місяць" }];
  const periodLabel = period === "today" ? fmtShort(from) : fmtShort(from) + " – " + fmtShort(to);

  return (
    <div className="app">
      {/* Сайдбар — робочий список кабінетів (див. visRooms вище). */}
      {/* ⚠️ `clinics`, а НЕ `clinicIds` (U-65): бейдж листа рахує ВСІ центри
          керівника незалежно від вибраного зрізу, тож і підписки мають бути на
          всі. Передати сюди `clinicIds` (звужений `scope`) означало б, що при
          виборі одного центру лічильник по решті мовчки застигає. */}
      <Sidebar clinicName={scopeName} adminName={adminName} adminRole={adminRole} roleKey={roleKey} clinicIds={clinics.map((c) => c.id)} rooms={visRooms} activeNav="ceo" />
      <div className="main">
        <header className="topbar">
          <div className="tb-title">
            <span className="tic">📊</span>
            <div><h1>Дашборд — Загальний огляд</h1><div className="date">{scopeName} · {periodLabel} · <LiveClock tz={scopeTz} /></div></div>
          </div>
          <div className="tb-right">
            {clinics.length > 1 && (
              <select className="inp" style={{ width: "auto", minWidth: 160 }} value={scope} onChange={(e) => { setScope(e.target.value); setDrill(null); }} title="Оберіть центр">
                <option value="all">Всі центри ({clinics.length})</option>
                {clinics.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            <div className="bk-seg">
              {PERIODS.map((p) => <button key={p.k} className={"bk-seg-btn" + (period === p.k ? " active" : "")} onClick={() => { setPeriod(p.k); setDrill(null); }}>{p.l}</button>)}
            </div>
            <button className="btn btn-secondary" onClick={exportCsv} disabled={exporting} aria-busy={exporting}>
              {exporting ? "Готуємо…" : "↧ Експортувати CSV"}
            </button>
          </div>
        </header>

        <div className="content" style={{ overflowY: "auto", padding: "22px" }}>
          {loading ? (
            <div className="empty"><div className="et">Завантаження…</div></div>
          ) : (
            <>
              {/* Постійний банер (U-7): тост живе 6 с, а цифри лишаються на екрані.
                  Керівник має бачити, що показники не свіжі, у будь-який момент. */}
              {dataErr && (
                <div className="ctx-hint red" style={{ fontSize: "0.8125rem", marginBottom: 14 }}>
                  ⚠ Показники не оновились — на екрані можуть бути неповні або застарілі дані. Оновіть сторінку.
                </div>
              )}
              {/* KPI row */}
              <div className="ceo-kpi-row">
                <div style={card}>
                  <div style={{ fontSize: "0.8125rem", color: "var(--text-muted)", marginBottom: 12 }}>Записи · {PERIODS.find((p) => p.k === period)?.l.toLowerCase()}</div>
                  {/* Кожне з цих чисел — похідне від тих самих даних, що й коло.
                      Без гейта «Записи 0» читається як «сьогодні порожньо». */}
                  <div style={{ fontSize: "2.5rem", fontWeight: 700 }} className="tabular"><Drillable label="Усі записи" onOpen={() => openDrill(null, "Усі записи")}>{dataFresh ? total : "—"}</Drillable></div>
                  <div style={{ display: "flex", gap: 16, marginTop: 14, flexWrap: "wrap" }}>
                    <Drillable label="Виконано" onOpen={() => openDrill(["done"], "Виконано")} style={{ fontSize: "0.8125rem" }}><b style={{ color: "var(--green)" }} className="tabular">{dataFresh ? done : "—"}</b> <span style={{ color: "var(--text-muted)" }}>виконано</span></Drillable>
                    <Drillable label="Неявка" onOpen={() => openDrill(["no_show"], "Неявка")} style={{ fontSize: "0.8125rem" }}><b style={{ color: "var(--red)" }} className="tabular">{dataFresh ? noShow : "—"}</b> <span style={{ color: "var(--text-muted)" }}>неявка</span></Drillable>
                    <Drillable label="Не відбулося" onOpen={() => openDrill(["not_held"], "Не відбулося")} style={{ fontSize: "0.8125rem" }}><b style={{ color: "var(--orange)" }} className="tabular">{dataFresh ? notHeld : "—"}</b> <span style={{ color: "var(--text-muted)" }}>не відбулося</span></Drillable>
                    <Drillable label="В процесі" onOpen={() => openDrill(["scheduled", "waiting", "in_progress"], "В процесі")} style={{ fontSize: "0.8125rem" }}><b style={{ color: "var(--blue-text)" }} className="tabular">{dataFresh ? active : "—"}</b> <span style={{ color: "var(--text-muted)" }}>в процесі</span></Drillable>
                  </div>
                </div>

                <div style={{ ...card, display: "flex", alignItems: "center", gap: 18 }}>
                  <ProgressCircle pct={util} color={utilKnown ? utilColor : "var(--border)"} unknown={!utilKnown} />
                  <div>
                    <div style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>Завантаженість</div>
                    <div style={{ fontSize: "0.8125rem", color: "var(--text-muted)", marginTop: 8 }}>
                      {utilKnown ? <>{visRooms.length} апаратів · {workdays} роб. дн.</> : <>Дані не завантажились</>}
                    </div>
                    {utilKnown && unroomedMin > 0 && (
                      <div style={{ fontSize: "0.75rem", color: "var(--text-faint)", marginTop: 4 }}
                        title="Записи без призначеного кабінету (і кабінетів, виведених з експлуатації) не займають апарат, тому в завантаженість не входять">
                        + {unroomedMin} хв поза кабінетами
                      </div>
                    )}
                    <div style={{ fontSize: "0.78125rem", color: utilKnown ? utilColor : "var(--text-muted)", marginTop: 6, fontWeight: 600 }}>
                      {utilKnown ? (util > 70 ? "Висока" : util >= 50 ? "Помірна" : "Низька") : "—"}
                    </div>
                  </div>
                </div>

                <div style={card}>
                  <div style={{ fontSize: "0.8125rem", color: "var(--text-muted)", marginBottom: 12 }}>{revenueExact ? "Дохід · виконані" : "Дохід (частково оцінка) · виконані"}</div>
                  <div style={{ fontSize: "2.125rem", fontWeight: 700, color: dataFresh ? "var(--green)" : "var(--text-muted)" }} className="tabular"><Drillable label="Дохід · виконані" onOpen={() => openDrill(["done"], "Дохід · виконані")}>{dataFresh ? fmtUah(revenue) : "—"}</Drillable></div>
                  <div style={{ fontSize: "0.78125rem", color: "var(--text-muted)", marginTop: 12 }}>
                    {dataFresh ? <>За цінами довідника досліджень · {done} виконаних</> : <>Дані не завантажились</>}
                  </div>
                </div>
              </div>

              {/* Chart + sidebar */}
              <div className="ceo-chart-row">
                <div style={card}>
                  <div style={{ fontSize: "0.875rem", fontWeight: 600, marginBottom: 4 }}>Дослідження за тиждень</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: 16 }}>Стовпці — всього, червоні позначки — зрив (неявка + не відбулося)</div>
                  {/* Сім нулів на графіку — теж твердження («тиждень порожній»). */}
                  {!dataFresh && <div className="ctx-hint" style={{ fontSize: "0.78125rem" }}>Дані не завантажились — оновіть сторінку.</div>}
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 10, height: 180, paddingTop: 10, visibility: dataFresh ? "visible" : "hidden" }}>
                    {weekData.map((x, i) => (
                      <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                        <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", fontWeight: 600 }} className="tabular">{x.total}</div>
                        <div style={{ width: "100%", display: "flex", alignItems: "flex-end", justifyContent: "center", height: 130, position: "relative" }}>
                          {(() => { const barH = x.total ? Math.max(4, Math.round((x.total / maxBar) * 130)) : 0; return (<>
                          <div style={{ width: 26, height: barH + "px", background: "var(--blue-line)", borderRadius: "6px 6px 0 0" }} />
                          {x.noShow > 0 && <div title={x.noShow + " не відбулось"} style={{ position: "absolute", bottom: barH + 2, width: 10, height: 10, borderRadius: "50%", background: "var(--red)" }} />}
                        </>); })()}
                        </div>
                        <div style={{ fontSize: "0.6875rem", color: "var(--text-muted)" }}>{WK_SHORT[i]}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <div style={card}>
                    <div style={{ fontSize: "0.875rem", fontWeight: 600, marginBottom: 12 }}>Топ-5 процедур</div>
                    {topProcs.length === 0 ? <div style={{ fontSize: "0.78125rem", color: "var(--text-muted)" }}>{dataFresh ? "Немає даних" : "Дані не завантажились — оновіть сторінку"}</div> : topProcs.map(([n, c], i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "6px 0", borderTop: i ? "1px solid var(--border)" : "none", fontSize: "0.8125rem" }}>
                        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n}</span>
                        <b className="tabular" style={{ color: "var(--blue-text)" }}>{c}</b>
                      </div>
                    ))}
                  </div>
                  <div style={card}>
                    <div style={{ fontSize: "0.875rem", fontWeight: 600, marginBottom: 12 }}>Завантаженість по апаратах</div>
                    {/* «Кабінетів немає», «всі вимкнено» і «дані не прийшли» — ТРИ різні
                        ситуації. Третя раніше зливалася з першою (U-7): при збої читання
                        rooms=[] і керівник бачив «Кабінетів немає» як факт. */}
                    {roomUtil.length === 0 ? <div style={{ fontSize: "0.78125rem", color: "var(--text-muted)" }}>{!dataFresh ? "Дані не завантажились — оновіть сторінку" : rooms.length > 0 ? "Усі кабінети вимкнено" : "Кабінетів немає"}</div> : roomUtil.map((r, i) => (
                      <div key={i} style={{ marginBottom: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.78125rem", marginBottom: 4 }}>
                          <span>{r.name} <span style={{ color: "var(--text-muted)" }}>{r.kind}</span></span>
                          <b className="tabular" style={{ color: r.color }}>{r.pct}%</b>
                        </div>
                        <div style={{ height: 6, background: "var(--bg-elevated)", borderRadius: 4 }}><div style={{ width: r.pct + "%", height: "100%", background: r.color, borderRadius: 4 }} /></div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {drill && (
        <DrillOverlay onClose={() => setDrill(null)} label={drill.label}
          style={{ maxWidth: 860, width: "92vw", maxHeight: "86vh", display: "flex", flexDirection: "column" }}>
            <div className="dlg-head">
              <div className="dlg-title">{drill.label} · {periodLabel}{drillRows ? ` · ${drillRows.length}` : ""}</div>
              <button className="icon-btn" aria-label="Закрити" onClick={() => setDrill(null)}>✕</button>
            </div>
            <div className="dlg-body" style={{ overflow: "auto" }}>
              {drillLoading ? (
                <div className="ctx-hint" style={{ textAlign: "center", padding: "22px 0", color: "var(--text-muted)" }}>⏳ Завантаження…</div>
              ) : !drillRows || drillRows.length === 0 ? (
                <div className="ctx-hint">Немає записів за цей період.</div>
              ) : (() => {
                const tdS: CSSProperties = { padding: "6px 8px", borderBottom: "1px solid var(--border)", verticalAlign: "top" };
                const thS: CSSProperties = { textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: "0.6875rem", textTransform: "uppercase", position: "sticky", top: 0, background: "var(--card)" };
                // с22: швидкий пошук — той самий спільний предикат, що на дошках
                // (прізвище з будь-якого місця; телефону в drill немає — лише ПІБ/процедура).
                const visRows = drillQuery.trim()
                  ? drillRows.filter((r) => quickSearchMatch(drillQuery, { patient_name: r.name, patient_phone: null }, r.proc))
                  : drillRows;
                return (
                  <>
                    <div className="search" style={{ marginBottom: 8 }}>
                      <span className="si" aria-hidden="true">⌕</span>
                      <input aria-label="Пошук за прізвищем" placeholder="Пошук за прізвищем…" value={drillQuery} onChange={(e) => setDrillQuery(e.target.value)} />
                    </div>
                    {visRows.length === 0 ? <div className="ctx-hint">Нічого не знайдено — змініть запит.</div> : (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
                      <thead><tr>{["Дата", "Пацієнт", "Процедура", "Кабінет", "Статус", "Дохід"].map((h) => <th key={h} style={thS}>{h}</th>)}</tr></thead>
                      <tbody>
                        {visRows.map((r, i) => (
                          <tr key={i}>
                            <td style={{ ...tdS, whiteSpace: "nowrap" }} className="tabular">{r.date}</td>
                            <td style={tdS}>{r.name}</td>
                            <td style={tdS}>{r.proc}</td>
                            <td style={tdS}>{r.room}</td>
                            <td style={tdS}>{STATUS_LABEL[r.status] || r.status}</td>
                            <td style={{ ...tdS, whiteSpace: "nowrap" }} className="tabular">{r.rev ? fmtUah(r.rev) : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    )}
                    {drillRows.length >= 1000 && <div className="ctx-hint" style={{ marginTop: 8 }}>Показано перші 1000 записів — звузьте період або скористайтесь «Експортувати CSV» для повного списку.</div>}
                  </>
                );
              })()}
            </div>
            <div className="dlg-foot" style={{ display: "flex", justifyContent: "flex-end" }}><button className="btn btn-primary" onClick={() => setDrill(null)}>Готово</button></div>
        </DrillOverlay>
      )}
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
