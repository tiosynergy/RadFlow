"use client";

/* ===== RadFlow — CEO Dashboard (Загальний огляд) =====
   Виконавчий дашборд: KPI, тижневий графік, топ-процедури, завантаженість апаратів.
   Метрики рахуються з queue_entries (період: сьогодні / тиждень / місяць). Realtime. */

import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode, type CSSProperties } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import { wallToday0 } from "@/lib/incidents";
import { modalityLabel, modalityCode, CONTRAST_SURCHARGE } from "@/lib/studies";
import Sidebar from "@/components/Sidebar";
import LiveClock from "@/components/LiveClock";
import Toast from "@/components/Toast";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null };
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
function fmtUah(n: number) { return String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₴"; }

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
    if (svc && svc.price > 0) return sum + svc.price + (x.contrast ? (svc.contrastPrice ?? CONTRAST_SURCHARGE) : 0);
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

function ProgressCircle({ pct, color }: { pct: number; color: string }) {
  const r = 52, c = 2 * Math.PI * r, off = c * (1 - Math.min(100, pct) / 100);
  return (
    <svg width="130" height="130" viewBox="0 0 130 130">
      <circle cx="65" cy="65" r={r} fill="none" stroke="var(--border)" strokeWidth="10" />
      <circle cx="65" cy="65" r={r} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={off} transform="rotate(-90 65 65)" style={{ transition: "stroke-dashoffset .5s" }} />
      <text x="65" y="64" textAnchor="middle" fontSize="30" fontWeight="700" fill="var(--text)" className="tabular">{pct}%</text>
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

type ClinicOpt = { id: string; name: string; timezone?: string | null };

interface CeoDashboardProps {
  clinics: ClinicOpt[];          // центри, доступні цьому користувачу
  clinicName?: string;
  adminName?: string;
  adminRole?: string;
  roleKey?: string;
}

export default function CeoDashboard({ clinics, clinicName, adminName, adminRole, roleKey = "admin" }: CeoDashboardProps) {
  const [period, setPeriod] = useState("today");
  // scope: "all" — агрегат по всіх доступних центрах, або конкретний clinic_id.
  const [scope, setScope] = useState<string>(clinics.length === 1 ? clinics[0].id : "all");
  const [rooms, setRooms] = useState<RoomOpt[]>([]);
  const [totals, setTotals] = useState<TotalsRow[]>([]);        // період (KPI)
  const [weekTotals, setWeekTotals] = useState<TotalsRow[]>([]); // поточний тиждень (графік)
  const [roomRows, setRoomRows] = useState<RoomsRow[]>([]);
  const [studyRows, setStudyRows] = useState<StudiesRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roomsById = useMemo(() => { const m: Record<string, RoomOpt> = {}; rooms.forEach((r) => { m[r.id] = r; }); return m; }, [rooms]);
  const [drill, setDrill] = useState<{ statuses: string[] | null; label: string } | null>(null);
  const [drillRows, setDrillRows] = useState<DrillRow[] | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);

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

  function notify(msg: string, type = "info") { setToast({ msg, type }); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), type === "error" ? 6000 : 3000); }

  const [from, to] = periodRange(period, scopeTz);

  const reload = useCallback(async () => {
    if (clinicIds.length === 0) { setRooms([]); setTotals([]); setWeekTotals([]); setRoomRows([]); setStudyRows([]); setLoading(false); return; }
    // Транзиентний мережевий збій (напр. оновлення токена Supabase) не повинен
    // валити UI неперехопленим reject — realtime/focus-рефетч підхопить дані пізніше.
    try {
      const supabase = createClient();
      const [f, t] = periodRange(period, scopeTz);
      const wk = today0(scopeTz); const mon = addDays(wk, -((wk.getDay() + 6) % 7));
      // scope="all" → усі доступні центри (RPC однаково ріже по auth_ceo_clinics()).
      const p_clinics = scope === "all" ? null : [scope];

      const { data: rdata } = await supabase
        .from("rooms")
        .select("id, name, modality, apparatus_model")
        .in("clinic_id", clinicIds);
      setRooms(rdata || []);

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
      if (tot.error || rms.error || sts.error || (wtot && wtot.error)) {
        notify("Не вдалося оновити показники — спробуйте оновити сторінку", "error");
        return;
      }

      setTotals((tot.data || []) as TotalsRow[]);
      setWeekTotals(((weekSame ? tot.data : wtot?.data) || []) as TotalsRow[]);
      setRoomRows((rms.data || []) as RoomsRow[]);
      setStudyRows((sts.data || []) as StudiesRow[]);
    } catch (e) {
      console.warn("CEO dashboard reload failed (буде повтор):", e);
    } finally {
      setLoading(false);
    }
  }, [clinicIds, period, scope, scopeTz]);

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
  const capacityMin = (rooms || []).length * 480 * workdays;
  // Ефективна зайнятість = тривалість + буфер (буфер теж споживає ємність кабінету);
  // неявка / «не відбулося» кабінет не займали.
  const bookedMin = totals.reduce(
    (s, r) => (r.status !== "no_show" && r.status !== "not_held" ? s + (r.booked_min || 0) : s), 0);
  const util = capacityMin ? Math.min(100, Math.round((bookedMin / capacityMin) * 100)) : 0;
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
  const roomUtil = (rooms || []).map((r) => {
    const mins = minsByRoom[r.id] || 0;
    const cap = 480 * workdays;
    return { name: r.name, kind: modalityLabel(r.modality), pct: cap ? Math.min(100, Math.round((mins / cap) * 100)) : 0, color: r.modality === "MRI" ? "var(--blue)" : "var(--orange)" };
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
      <Sidebar clinicName={scopeName} adminName={adminName} adminRole={adminRole} roleKey={roleKey} rooms={rooms} activeNav="ceo" />
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
              {/* KPI row */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
                <div style={card}>
                  <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>Записи · {PERIODS.find((p) => p.k === period)?.l.toLowerCase()}</div>
                  <div style={{ fontSize: 40, fontWeight: 700 }} className="tabular"><Drillable label="Усі записи" onOpen={() => openDrill(null, "Усі записи")}>{total}</Drillable></div>
                  <div style={{ display: "flex", gap: 16, marginTop: 14, flexWrap: "wrap" }}>
                    <Drillable label="Виконано" onOpen={() => openDrill(["done"], "Виконано")} style={{ fontSize: 13 }}><b style={{ color: "var(--green)" }} className="tabular">{done}</b> <span style={{ color: "var(--text-muted)" }}>виконано</span></Drillable>
                    <Drillable label="Неявка" onOpen={() => openDrill(["no_show"], "Неявка")} style={{ fontSize: 13 }}><b style={{ color: "var(--red)" }} className="tabular">{noShow}</b> <span style={{ color: "var(--text-muted)" }}>неявка</span></Drillable>
                    <Drillable label="Не відбулося" onOpen={() => openDrill(["not_held"], "Не відбулося")} style={{ fontSize: 13 }}><b style={{ color: "var(--orange)" }} className="tabular">{notHeld}</b> <span style={{ color: "var(--text-muted)" }}>не відбулося</span></Drillable>
                    <Drillable label="В процесі" onOpen={() => openDrill(["scheduled", "waiting", "in_progress"], "В процесі")} style={{ fontSize: 13 }}><b style={{ color: "var(--blue)" }} className="tabular">{active}</b> <span style={{ color: "var(--text-muted)" }}>в процесі</span></Drillable>
                  </div>
                </div>

                <div style={{ ...card, display: "flex", alignItems: "center", gap: 18 }}>
                  <ProgressCircle pct={util} color={utilColor} />
                  <div>
                    <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Завантаженість</div>
                    <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 8 }}>{(rooms || []).length} апаратів · {workdays} роб. дн.</div>
                    <div style={{ fontSize: 12.5, color: utilColor, marginTop: 6, fontWeight: 600 }}>{util > 70 ? "Висока" : util >= 50 ? "Помірна" : "Низька"}</div>
                  </div>
                </div>

                <div style={card}>
                  <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>{revenueExact ? "Дохід · виконані" : "Дохід (частково оцінка) · виконані"}</div>
                  <div style={{ fontSize: 34, fontWeight: 700, color: "var(--green)" }} className="tabular"><Drillable label="Дохід · виконані" onOpen={() => openDrill(["done"], "Дохід · виконані")}>{fmtUah(revenue)}</Drillable></div>
                  <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 12 }}>За цінами довідника досліджень · {done} виконаних</div>
                </div>
              </div>

              {/* Chart + sidebar */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16, marginTop: 16 }}>
                <div style={card}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Дослідження за тиждень</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16 }}>Стовпці — всього, червоні позначки — зрив (неявка + не відбулося)</div>
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 10, height: 180, paddingTop: 10 }}>
                    {weekData.map((x, i) => (
                      <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                        <div style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 600 }} className="tabular">{x.total}</div>
                        <div style={{ width: "100%", display: "flex", alignItems: "flex-end", justifyContent: "center", height: 130, position: "relative" }}>
                          {(() => { const barH = x.total ? Math.max(4, Math.round((x.total / maxBar) * 130)) : 0; return (<>
                          <div style={{ width: 26, height: barH + "px", background: "var(--blue)", borderRadius: "6px 6px 0 0" }} />
                          {x.noShow > 0 && <div title={x.noShow + " не відбулось"} style={{ position: "absolute", bottom: barH + 2, width: 10, height: 10, borderRadius: "50%", background: "var(--red)" }} />}
                        </>); })()}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{WK_SHORT[i]}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <div style={card}>
                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Топ-5 процедур</div>
                    {topProcs.length === 0 ? <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Немає даних</div> : topProcs.map(([n, c], i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "6px 0", borderTop: i ? "1px solid var(--border)" : "none", fontSize: 13 }}>
                        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n}</span>
                        <b className="tabular" style={{ color: "var(--blue)" }}>{c}</b>
                      </div>
                    ))}
                  </div>
                  <div style={card}>
                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Завантаженість по апаратах</div>
                    {roomUtil.length === 0 ? <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Кабінетів немає</div> : roomUtil.map((r, i) => (
                      <div key={i} style={{ marginBottom: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
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
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setDrill(null); }}>
          <div className="dialog fade-in" style={{ maxWidth: 860, width: "92vw", maxHeight: "86vh", display: "flex", flexDirection: "column" }} role="dialog" aria-modal="true" aria-label={"Записи: " + drill.label}>
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
                const thS: CSSProperties = { textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", position: "sticky", top: 0, background: "var(--card)" };
                return (
                  <>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead><tr>{["Дата", "Пацієнт", "Процедура", "Кабінет", "Статус", "Дохід"].map((h) => <th key={h} style={thS}>{h}</th>)}</tr></thead>
                      <tbody>
                        {drillRows.map((r, i) => (
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
                    {drillRows.length >= 1000 && <div className="ctx-hint" style={{ marginTop: 8 }}>Показано перші 1000 записів — звузьте період або скористайтесь «Експортувати CSV» для повного списку.</div>}
                  </>
                );
              })()}
            </div>
            <div className="dlg-foot" style={{ display: "flex", justifyContent: "flex-end" }}><button className="btn btn-primary" onClick={() => setDrill(null)}>Готово</button></div>
          </div>
        </div>
      )}
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
