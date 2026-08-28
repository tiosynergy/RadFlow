"use client";

/* ===== RadFlow — Лист очікування (окремий екран) =====
   Пацієнти, що чекають на вільне вікно. Порядок: cito → urgent → planned.
   «Записати» відкриває повну модалку запису з передзаповненням; після
   успішного запису рядок листа отримує status='scheduled' + посилання на
   створений запис. Realtime — таблиця waitlist_entries (0047). */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import UnreadDot from "@/components/UnreadDot";
import { useUnreadChanges, useAckWhenVisible } from "@/lib/useUnreadChanges";
import { unreadForEntity } from "@/lib/unreadChanges";
import Toast from "@/components/Toast";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import Sidebar from "@/components/Sidebar";
import LiveClock from "@/components/LiveClock";
import BookingModal, { type BookingPayload, type BookingPrefill } from "@/components/BookingModal";
import WaitlistModal, { type WaitlistFormOut } from "@/components/WaitlistModal";
import ConfirmDialog from "@/components/ConfirmDialog";
import { scheduleFromWaitlist } from "@/app/queue/actions";
import { addWaitlistEntry, setWaitlistPriority, setWaitlistStatus, updateWaitlistEntry } from "@/app/waitlist/actions";
import { WAITLIST_STATUS_META, compareWaitlist, desiredWindowText } from "@/lib/waitlist";
import { PRIORITY_OPTIONS, PRIORITY_META, type PatientPriority } from "@/lib/priority";
import { setClinicTz, wallToday0 } from "@/lib/incidents";
import type { WaitlistEntry } from "@/supabase/types";
import type { Study } from "@/lib/studies";
import { modalityLabel, modalityKind, isContrastName} from "@/lib/studies";
import type { ServiceLike, RoomOverrideRow } from "@/lib/catalog";
import { formatPhoneSearch, nextPhoneSearchValue } from "@/lib/phone";
import { visibleRooms, residualSet, roomOffLabel } from "@/lib/rooms";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null; active?: boolean | null };
type IncidentRow = { id: string; room_id: string; reason_label: string | null; note: string | null; started_at: string; blocked_until: string | null; status: string };

// Масштабування доски листа (0104+): усі вкладки — серверні сторінки «показати ще».
// waiting сортується СЕРВЕРНО за пріоритетом (enum patient_priority оголошений
// 'cito','urgent','planned' → order by дає саме цей порядок) — cito видно першим
// навіть якщо він за межами першої сторінки (RE_AUDIT 2026-07-18, Medium).
const PAGE = 50;         // розмір сторінки («показати ще»)

const WK = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"];
const MON_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
function fmtFull(d: Date) { return WK[d.getDay()] + ", " + d.getDate() + " " + MON_GEN[d.getMonth()] + " " + d.getFullYear(); }
function dateKey(d: Date) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }

function procLabel(e: { studies?: unknown; note?: string | null }) {
  const s = Array.isArray(e.studies) ? (e.studies as Study[]) : [];
  if (s.length) return s.map((x) => (x.type || "") + (x.region ? " · " + x.region : "") + (x.contrast && !isContrastName(x.region) ? " з контрастом" : "")).join(" + ");
  return e.note || "—";
}

function addedAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return "сьогодні";
  if (days === 1) return "вчора";
  return days + " дн. тому";
}

/* ── Меню дій рядка («⋯»): доступний поповер без бібліотек.
   role=menu/menuitem, закриття по кліку зовні та Escape, фокус — назад на тригер. ── */
function RowMenu({ disabled, onEdit, onRemove }: { disabled?: boolean; onEdit: () => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: Event) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btnRef.current?.focus(); } };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className="wl-menu-wrap" ref={wrapRef}>
      <button ref={btnRef} type="button" className="mini-icon" aria-haspopup="menu" aria-expanded={open} aria-label="Ще дії"
        disabled={disabled} onClick={() => setOpen((o) => !o)}>⋯</button>
      {open && (
        <div className="wl-menu" role="menu" aria-label="Дії із записом">
          <button type="button" role="menuitem" className="wl-menu-item" onClick={() => { setOpen(false); btnRef.current?.focus(); onEdit(); }}>
            <span aria-hidden="true">✎</span> Редагувати
          </button>
          <button type="button" role="menuitem" className="wl-menu-item danger" onClick={() => { setOpen(false); btnRef.current?.focus(); onRemove(); }}>
            <span aria-hidden="true">✕</span> Зняти з листа
          </button>
        </div>
      )}
    </div>
  );
}

interface WaitlistBoardProps {
  clinicId: string;
  /** IANA-зона центру (clinics.timezone) — із сервера, а не з браузера. */
  clinicTz: string;
  rooms?: RoomOpt[];
  /** id вимкнених кабінетів, у яких ЩЕ лишились живі рядки («кабінети-залишки»).
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
  /** с22 (deep-link зі сторінки «Пошук»): стартова вкладка листа. */
  initialTab?: "waiting" | "scheduled" | "removed" | null;
  /** с22: id рядка листа, який розгорнути після завантаження. */
  initialEntry?: string | null;
}

export default function WaitlistBoard({ clinicId, clinicTz, rooms, residualRoomIds, residualRoomCounts, services, roomOverrides, clinicName, adminName, adminRole, roleKey = "admin", initialTab = null, initialEntry = null }: WaitlistBoardProps) {
  /* Зона центру — синхронно, до першого рендера. Раніше вона прилітала клієнтським
     fetch уже після монтування, і wallNow() у BookingModal, відкритій із листа
     очікування, встигав порахувати «зараз» за браузером (минулі слоти — вибірні). */
  if (typeof window !== "undefined") setClinicTz(clinicTz);

  const router = useRouter();   // 0086: зміни кабінетів (rooms — SSR-проп) підхоплюємо через router.refresh

  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  /* U-2: покоління завантаження і зріз, до якого належать рядки на екрані.
     Дати тут немає, але вкладка/модальність/пошук — це такий самий зріз, і
     показувати під однією вкладкою рядки іншої так само неправда. */
  const genRef = useRef(0);
  const loadedKeyRef = useRef<string | null>(null);
  /* Ключ ПОТОЧНОГО зрізу для протухлих замикань. genRef рахує порядок видачі, а
     не актуальність: `reload` живе в замиканнях обробників (запис із листа,
     зміна статусу/пріоритету), тож замикання старої вкладки може бути ВИДАНЕ
     пізніше за свіжий reload — і тоді воно виграє гонку за власним лічильником.
     Той самий висновок, що H-3 у QueueBoard. */
  const scopeRef = useRef("");
  // H-6: збій завантаження ≠ «лист порожній» / «простоїв немає».
  const [entriesErr, setEntriesErr] = useState(false);
  const [incidentsErr, setIncidentsErr] = useState(false);
  // с22: deep-link «Пошук» → відкриваємо вкладку статусу знайденого рядка і розгортаємо його.
  const [filter, setFilter] = useState<"waiting" | "scheduled" | "removed">(initialTab || "waiting");
  const [roomView, setRoomView] = useState("all"); // фільтр сайдбара: кабінет → модальність
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(initialEntry || null);
  /* Контекстні позначки листа очікування (ревʼю р2, H-3new): точка на
     рядку, ack — лише для РОЗГОРНУТОГО рядка з успішними даними. */
  const { index: unreadIx } = useUnreadChanges();
  /* ⚠️ Через useAckWhenVisible, а НЕ власним ефектом по unreadIx (ревʼю
     пакета №4, р2). Власний ефект перевзводився на КОЖНУ зміну пулу і гасив
     ЖИВИЙ індекс — тобто відтворював рівно той High-дефект с28, заради якого
     зʼявилась заморозка знімка: позначка, що прилетіла при вже розгорнутому
     рядку, гасла сама за ~2 с, не показавшись. Плюс він жив поза механікою
     ретрою (ackFailGen у депсах не було), тож невдалий ack лишав крапку до
     ручного згортання. */
  useAckWhenVisible(
    expandedId ? { kind: "entity", entityType: "waitlist_entry", entityId: expandedId } : null,
    !!expandedId,
  );
  const [addOpen, setAddOpen] = useState(false);
  const [editFor, setEditFor] = useState<WaitlistEntry | null>(null);
  const [bookFor, setBookFor] = useState<WaitlistEntry | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<WaitlistEntry | null>(null);
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [toast, setToast] = useState<{ msg: string; type: string; action?: { label: string; onAction: () => void } } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Рядок із запитом «у польоті»: кнопки цього рядка вимкнені (busy-стан).
  const [busyId, setBusyId] = useState<string | null>(null);
  // Вступна підказка ховається назавжди (localStorage), фільтр-банер не чіпаємо.
  const [hintHidden, setHintHidden] = useState(false);

  /* Масштабування (0104+): доска більше НЕ тягне select("*") усієї історії центру.
     Активна вкладка вантажиться серверно (status + модальність + пошук), лічильники —
     окремими COUNT-запитами, історичні вкладки — сторінками («показати ще»). */
  const [counts, setCounts] = useState({ waiting: 0, cito: 0, urgent: 0, scheduled: 0, removed: 0 });
  // Лічильники не оновились (RPC-збій) — числа на екрані можуть бути застарілими.
  const [countsErr, setCountsErr] = useState(false);
  const [qDebounced, setQDebounced] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [hasMore, setHasMore] = useState(false);
  // Фільтр за кабінетом із сайдбара: рядок листа не привʼязаний до кабінету, тому
  // фільтруємо за МОДАЛЬНІСТЮ обраного кабінету (МРТ/КТ/УЗД…). Порожня модальність — теж показуємо.
  /* Резолв обраного кабінету — за ПОВНИМ списком: користувач міг залишитись на
     кабінеті-залишку, а нам треба лише його модальність для фільтра. */
  const viewRoom = roomView === "all" ? null : (rooms || []).find((r) => r.id === roomView) || null;
  const viewMod = viewRoom?.modality ?? null;
  // Ключ поточного зрізу — пишемо в рендері, читаємо з протухлих замикань reload().
  scopeRef.current = clinicId + "|" + filter + "|" + (viewMod || "") + "|" + qDebounced.trim();

  /* Списки кабінетів (сайдбар) — активні + вимкнені із залишками. */
  const residual = useMemo(() => residualSet(residualRoomIds), [residualRoomIds]);
  const visRooms = useMemo(() => visibleRooms(rooms, residual), [rooms, residual]);
  const offNote = (roomId: string): string | null => {
    const r = (rooms || []).find((x) => x.id === roomId);
    return r && r.active === false ? roomOffLabel(residualRoomCounts?.[roomId]) : null;
  };
  useEffect(() => {
    try { setHintHidden(localStorage.getItem("rf_waitlist_hint_hidden") === "1"); } catch { /* ignore */ }
  }, []);

  function hideHint() {
    setHintHidden(true);
    try { localStorage.setItem("rf_waitlist_hint_hidden", "1"); } catch { /* ignore */ }
  }

  const canEditPriority = roleKey === "admin";

  function notify(msg: string, type = "success", action?: { label: string; onAction: () => void }) {
    setToast({ msg, type, action });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    // Тост із дією (Undo) живе довше, щоб встигнути натиснути.
    toastTimer.current = setTimeout(() => setToast(null), action ? 6000 : 3000);
  }

  /* Записати кандидата в чергу можна лише коли ДАНІ ПРО ПРОСТОЇ надійні: сітка
     слотів у BookingModal ховає заблоковані кабінети саме за incidents, і при збої
     завантаження (порожній масив) кабінет на ремонті виглядав би вільним. */
  function openBooking(p: WaitlistEntry) {
    if (incidentsErr) {
      notify("Дані про простої не оновились — спершу оновіть сторінку, інакше можна записати в заблокований кабінет", "error");
      loadIncidents();
      return;
    }
    setBookFor(p);
  }

  const statusesFor = (f: "waiting" | "scheduled" | "removed"): ("waiting" | "scheduled" | "cancelled" | "expired")[] =>
    f === "waiting" ? ["waiting"] : f === "scheduled" ? ["scheduled"] : ["cancelled", "expired"];

  const reload = useCallback(async () => {
    /* U-2: guard покоління. Вкладку і пошук перемикають швидко, тож запити
       ПЕРЕКРИВАЮТЬСЯ — і без покоління пізніша відповідь СТАРІШОГО запиту
       перезаписувала б рядки: під вкладкою «Записані» цілком могли опинитись
       ті, хто очікує. Дати в цьому екрані немає (тому половина початкового
       формулювання U-2 хибна), але зріз є — вкладка + модальність + пошук. */
    /* Ключ БЕЗ limit: «Показати ще» лише подовжує той самий список, і при збої
       догрузки стирати вже показані рядки не можна. */
    const key = clinicId + "|" + filter + "|" + (viewMod || "") + "|" + qDebounced.trim();
    if (key !== scopeRef.current) return;   // протухле замикання — ДО ++genRef
    const gen = ++genRef.current;
    const stale = () => gen !== genRef.current;
    const failed = () => {
      if (stale()) return;
      if (loadedKeyRef.current !== key) { loadedKeyRef.current = null; setEntries([]); setHasMore(false); }
      setEntriesErr(true);
    };
    try {
      const supabase = createClient();
      let q = supabase
        .from("waitlist_entries")
        .select("*")
        .eq("clinic_id", clinicId)
        .in("status", statusesFor(filter));
      // Модальність (сайдбар) і пошук — СЕРВЕРНО, а не фільтром у браузері.
      if (viewMod) q = q.or(`modality.is.null,modality.eq.${viewMod}`);
      // Телефоноподібний запит приводимо до канонічного «+380 XX XXX XX XX» лише
      // ДЛЯ ПОШУКУ (інпут лишається raw — Backspace/редагування ПІБ не ламаються).
      const s = formatPhoneSearch(qDebounced.trim()).replace(/[%,()\\]/g, " ").trim();
      if (s) q = q.or(`patient_name.ilike.%${s}%,patient_phone.ilike.%${s}%`);
      // waiting — СЕРВЕРНИЙ порядок cito→urgent→planned (порядок оголошення enum
      // patient_priority, звірено з БД) → давність; історичні вкладки — за updated_at.
      // Обидва — сторінками limit («Показати ще»): раніше waiting обрізався стелею
      // 300 за created_at, і cito за нею взагалі не потрапляв на дошку.
      q = filter === "waiting"
        ? q.order("priority_level", { ascending: true }).order("created_at", { ascending: true }).limit(limit)
        : q.order("updated_at", { ascending: false }).limit(limit);
      const { data, error } = await q;
      // H-6: без перевірки error збій виглядав як «Лист порожній» — і кандидатів,
      // що чекають слота, ніхто не бачив.
      if (error) { failed(); return; }
      if (stale()) return;
      setEntries(data || []);
      setHasMore((data?.length || 0) >= limit);
      loadedKeyRef.current = key;
      setEntriesErr(false);
    } catch { failed(); }
    finally { if (!stale()) setLoading(false); }
  }, [clinicId, filter, viewMod, qDebounced, limit]);

  // Лічильники StatsBar/вкладок — один RPC waitlist_counts (0105) по всіх статусах
  // незалежно від активної вкладки (з модальність-фільтком).
  const loadCounts = useCallback(async () => {
    try {
      const supabase = createClient();
      // Один RPC (0105) замість п'яти паралельних COUNT: без сплеску запитів/503
      // (StrictMode-дублі в dev їх 503-или) і без тихого застарівання лічильників.
      const { data, error } = await supabase.rpc("waitlist_counts", { p_modality: viewMod });
      // RE_AUDIT Low: раніше error ковтався мовчки, і на екрані застигали СТАРІ
      // числа без жодної ознаки — тепер ненав'язливий індикатор «не оновились».
      if (error) { setCountsErr(true); return; }
      const c = data?.[0];
      if (c) setCounts({
        waiting: c.waiting || 0, cito: c.cito || 0, urgent: c.urgent || 0,
        scheduled: c.scheduled || 0, removed: c.removed || 0,
      });
      setCountsErr(false);
    } catch { setCountsErr(true); }
  }, [viewMod]);

  // Дебаунс пошуку (серверний ilike) + скидання пагінації при зміні фільтра/модальності/пошуку.
  useEffect(() => { const t = setTimeout(() => setQDebounced(query), 300); return () => clearTimeout(t); }, [query]);
  useEffect(() => { setLimit(PAGE); }, [filter, viewMod, qDebounced]);
  useEffect(() => { loadCounts(); }, [loadCounts]);
  // Мутації оновлюють і рядки активної вкладки, і лічильники (realtime продублює без лагу).
  const refresh = useCallback(() => { reload(); loadCounts(); }, [reload, loadCounts]);

  const loadIncidents = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("incidents")
        .select("id, room_id, reason_label, note, started_at, blocked_until, status")
        .eq("clinic_id", clinicId).in("status", ["active", "planned"]);
      if (error) { setIncidentsErr(true); return; }   // «простоїв немає» — небезпечна брехня і тут
      setIncidents(data || []);
      setIncidentsErr(false);
    } catch { setIncidentsErr(true); }
  }, [clinicId]);

  /* Спінер — на зміну ЗРІЗУ, а не лише клініки (U-2). Guard покоління лагодить
     ПОРЯДОК відповідей, але не детермінований проміжок «вкладку перемкнули —
     відповідь ще не прийшла»: без цього рядки «Очікують» повний круговий раз
     малювались під активною вкладкою «Записані», ще й із кнопкою «Додати в
     чергу», якої в записаних не буває.
     `qDebounced` свідомо НЕ в списку: пошук фільтрує той самий зріз, і гасити
     список на кожен склад введеного слова — гірше за коротку неточність. */
  useEffect(() => { setLoading(true); }, [clinicId, filter, viewMod]);
  useEffect(() => { reload(); loadIncidents(); }, [reload, loadIncidents]);

  // TD-3: єдиний realtime-патерн — лист миттєво синхронний в усіх ролях.
  useRealtimeRefetch({
    channelName: clinicId ? "waitlist-" + clinicId : null,
    subscriptions: [
      /* Залишок може триматись САМЕ вейтліст-броню (residualOffRooms рахує обидві
         таблиці) — тож знята остання бронь мусить прибрати кабінет зі списку без
         перезавантаження сторінки. */
      { table: "waitlist_entries", filter: "clinic_id=eq." + clinicId,
        onChange: () => { reload(); loadCounts(); if ((residualRoomIds?.length ?? 0) > 0) router.refresh(); } },
      { table: "incidents", filter: "clinic_id=eq." + clinicId, onChange: loadIncidents },
      // 0086: rooms — SSR-проп; додавання/зміна модальності/видалення кабінету долітає
      // до відкритого листа через перечитування серверних пропів (інакше стале-фільтри
      // кабінетів і allowedModalities у WaitlistModal/BookingModal до ручного refresh).
      { table: "rooms", filter: "clinic_id=eq." + clinicId, onChange: () => router.refresh() },
      // Каталог послуг/цін (0107/0108) — SSR-проп у форми листа; зміна адміном → оновити.
      { table: "services", filter: "clinic_id=eq." + clinicId, onChange: () => router.refresh() },
      { table: "service_room_overrides", filter: "clinic_id=eq." + clinicId, onChange: () => router.refresh() },
    ],
  });

  async function onAdd(w: WaitlistFormOut) {
    const res = await addWaitlistEntry({
      roomId: w.roomId,
      name: w.name, phone: w.phone, email: w.email, dob: w.dob, sex: w.sex, age: w.age, weight: w.weight,
      priorityLevel: w.priorityLevel, studies: w.studies, durationMin: w.durationMin, bufferTimeMin: w.bufferTimeMin,
      desiredDateFrom: w.desiredDateFrom, desiredDateTo: w.desiredDateTo,
      desiredTimeFrom: w.desiredTimeFrom, desiredTimeTo: w.desiredTimeTo, note: w.note,
    });
    if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
    setAddOpen(false);
    notify("Додано до листа очікування: " + w.name, "success");
    refresh();
  }

  // Повертає ТЕКСТ помилки — BookingModal покаже його в собі (тост тонув під оверлеєм).
  async function saveBooking(b: BookingPayload) {
    const wl = bookFor;
    if (!wl) return null;
    const [hh, mm] = b.time.split(":").map(Number);
    const at = new Date(b.date.getFullYear(), b.date.getMonth(), b.date.getDate(), hh, mm).toISOString();
    // Атомарно: спершу застовплюємо кандидата (CAS waiting→scheduled), лише
    // переможець створює запис — два адміністратори не задвоять пацієнта.
    const res = await scheduleFromWaitlist(wl.id, {
      roomId: b.roomId, referrerId: b.referrerId ?? (wl.referrer_id || null),
      name: b.name, phone: b.phone || null, email: b.email ?? null,
      dob: b.dob || null, sex: b.gender || null, age: b.age || null, weight: b.weight ?? null,
      hasContra: !!b.hasContra, priorityLevel: b.priority,
      studies: b.studies || [], doctor: b.doctor ?? null, notes: b.notes ?? null, durationMin: b.dur, bufferTimeMin: b.buffer,
      scheduledDate: dateKey(b.date), scheduledTime: b.time, scheduledAt: at,
      offSchedule: b.offSchedule,   // 0077
    });
    if (!res.ok) {
      // stale = кандидата саме зараз записує інший оператор → запис НЕ створено.
      return (res.code === "slot_taken" || res.code === "slot_unavailable")
        ? "Слот щойно зайняли — оберіть інший час"
        : res.code === "incident" ? "Кабінет у простої (поломка/ТО) у цей час — оберіть інший слот або день"
        : res.code === "stale" ? "Кандидата вже записує інший оператор — оновіть лист"
        : res.error;
    }
    notify("Записано зі списку очікування: " + b.name + " · " + b.time, "success");
    setBookFor(null);
    refresh();
    return null;   // запис створено — модалку закриває батько
  }

  // Редагування даних пацієнта/досліджень/вікна в місці ухвалення рішення.
  async function onEditSave(w: WaitlistFormOut) {
    const p = editFor;
    if (!p) return;
    const res = await updateWaitlistEntry(p.id, {
      patient_name: w.name, patient_phone: w.phone, patient_email: w.email,
      patient_dob: w.dob, patient_sex: w.sex, patient_age: w.age, patient_weight: w.weight,
      studies: w.studies, duration_min: w.durationMin, buffer_time_min: w.bufferTimeMin,
      desired_date_from: w.desiredDateFrom, desired_date_to: w.desiredDateTo,
      desired_time_from: w.desiredTimeFrom, desired_time_to: w.desiredTimeTo,
      note: w.note, room_id: w.roomId,
    });
    if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
    setEditFor(null);
    notify("Запис листа оновлено", "success");
    refresh();
  }

  async function restore(p: WaitlistEntry) {
    setBusyId(p.id);
    try {
      const res = await setWaitlistStatus(p.id, "waiting");
      if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
      notify("Повернено в очікування", "success");
      refresh();
    } finally { setBusyId(null); }
  }
  // Мʼяке зняття + Undo в тості (замість блокуючого підтвердження).
  async function remove(p: WaitlistEntry) {
    setBusyId(p.id);
    try {
      const res = await setWaitlistStatus(p.id, "cancelled");
      if (!res.ok) { notify("Помилка: " + res.error, "error"); return; }
      notify("Знято з листа очікування", "info", { label: "Скасувати", onAction: () => restore(p) });
      refresh();
    } finally { setBusyId(null); }
  }
  async function setPrio(p: WaitlistEntry, v: PatientPriority) {
    if (p.priority_level === v) return;
    setEntries((es) => es.map((e) => (e.id === p.id ? { ...e, priority_level: v } : e))); // оптимістично
    setBusyId(p.id);
    try {
      const res = await setWaitlistPriority(p.id, v);
      if (!res.ok) { notify("Помилка: " + res.error, "error"); refresh(); return; }
      notify("Пріоритет: " + PRIORITY_META[v].label, "success");
    } finally { setBusyId(null); }
  }

  // Активна вкладка вже відфільтрована (status + модальність + пошук) І відсортована
  // серверно (waiting: пріоритет enum → давність). Клієнтський compareWaitlist —
  // лише стабілізація тієї ж формули на завантаженій сторінці (realtime-патчі
  // могли б підмішати рядок до наступного reload); порядок ідентичний серверному.
  const filtered = useMemo(
    () => (filter === "waiting" ? [...entries].sort(compareWaitlist) : entries),
    [entries, filter]
  );

  const tabs = [
    { key: "waiting" as const, label: "Очікують", ct: counts.waiting },
    { key: "scheduled" as const, label: "Записані", ct: counts.scheduled },
    { key: "removed" as const, label: "Зняті", ct: counts.removed },
  ];

  const stats = [
    { lab: "В очікуванні", val: counts.waiting, color: "var(--green)" },
    { lab: "CITO", val: counts.cito, color: "var(--red)" },
    { lab: "Терміново", val: counts.urgent, color: "var(--orange)" },
    { lab: "Записано", val: counts.scheduled, color: "var(--blue-text)" },
  ];

  const bookPrefill: BookingPrefill | null = bookFor ? {
    name: bookFor.patient_name, phone: bookFor.patient_phone, email: bookFor.patient_email,
    dob: bookFor.patient_dob, gender: bookFor.patient_sex, weight: bookFor.patient_weight,
    priority: bookFor.priority_level, notes: bookFor.note, buffer: bookFor.buffer_time_min,
    studies: Array.isArray(bookFor.studies) ? (bookFor.studies as Study[]) : [],
  } : null;

  return (
    <div className="app">
      <Sidebar clinicName={clinicName} adminName={adminName} adminRole={adminRole} roleKey={roleKey} rooms={visRooms} roomNoteOf={offNote}
        activeNav="waitlist" activeRoom={roomView} onSelectRoom={setRoomView} />
      <div className="main">
        <header className="topbar">
          <div className="tb-title">
            <span className="tic">⏳</span>
            <div>
              <h1>Лист очікування</h1>
              <div className="date">{fmtFull(wallToday0(clinicTz))} · <LiveClock tz={clinicTz} /></div>
            </div>
          </div>
          <div className="tb-right">
            <button className="btn btn-primary" onClick={() => setAddOpen(true)}>＋ Додати пацієнта</button>
          </div>
        </header>
        <div className="content-full">
          <div className="page-max">
            {!hintHidden && (
              <div className="info-banner">
                <span className="ib-ic" aria-hidden="true">⏳</span>
                <span className="ib-txt"><b>Лист очікування</b> — пацієнти, що чекають на вільне вікно. Коли слот звільняється (скасування, неявка), запишіть підходящого пацієнта кнопкою «Записати». Порядок: CITO → Терміново → Планово.</span>
                <button type="button" className="mini-icon" style={{ flexShrink: 0 }} aria-label="Сховати підказку" onClick={hideHint}>✕</button>
              </div>
            )}

            <div className="stats" role="status">
              {stats.map((s) => (
                <div className="stat" key={s.lab}>
                  <div className="lab">{s.lab}</div>
                  <div className="val tabular" style={{ color: s.color, opacity: countsErr ? 0.55 : 1 }}>{s.val}</div>
                </div>
              ))}
            </div>
            {countsErr && (
              <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.78125rem", color: "var(--text-muted)", margin: "2px 0 6px" }}>
                <span aria-hidden="true">⚠</span>
                <span>Лічильники не оновились — цифри можуть бути застарілими.</span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={loadCounts}>↻ Оновити</button>
              </div>
            )}

            {viewRoom && (
              <div className="info-banner" style={{ padding: "8px 14px" }}>
                <span className="ib-ic">{modalityLabel(viewRoom.modality)}</span>
                <span className="ib-txt">
                  Фільтр за кабінетом <b>{viewRoom.name}</b>: показано пацієнтів модальності {modalityLabel(viewRoom.modality)} (лист не привʼязаний до конкретного кабінету).
                </span>
                <button className="btn btn-secondary btn-sm" style={{ flexShrink: 0 }} onClick={() => setRoomView("all")}>✕ Зняти фільтр</button>
              </div>
            )}

            <div className="qctrl">
              <div className="pills">
                {tabs.map((t) => (
                  <button key={t.key} className={"pill" + (filter === t.key ? " active" : "")} onClick={() => setFilter(t.key)}>
                    {t.label}<span className="ct">({t.ct})</span>
                  </button>
                ))}
              </div>
              <div className="spacer" />
              <div className="search"><span className="si">⌕</span>
                <input placeholder="Пошук…" value={query} onChange={(e) => setQuery(nextPhoneSearchValue(query, e.target.value))} />
              </div>
            </div>

            <div className="wlhead wl-queue">
              <div /><div>Пацієнт</div><div>Дослідження</div><div>Бажане вікно</div><div style={{ textAlign: "right" }}>Дії</div>
            </div>
            {/* Збій ДОГРУЗКИ («Показати ще») лишав рядки на екрані — і не показував
                нічого: єдиний банер про entriesErr стояв під `filtered.length === 0`,
                тож кнопка просто виглядала зламаною. */}
            {entriesErr && filtered.length > 0 && (
              <div className="inc-banner fade-in" style={{ borderColor: "var(--red)" }} role="alert">
                <span className="inc-banner-ic">⚠</span>
                <div className="inc-banner-txt">
                  <div className="inc-banner-title">Лист не оновився</div>
                  <div className="inc-banner-sub">На екрані — попередні рядки цього ж зрізу, частина могла не завантажитись.</div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => { refresh(); loadIncidents(); }}>↻ Оновити</button>
              </div>
            )}
            {loading ? (
              <div className="empty"><div className="et">Завантаження…</div></div>
            ) : entriesErr && filtered.length === 0 ? (
              <div className="empty"><div className="ei">⚠</div><div className="et">Лист не завантажився</div>
                <div className="es">Це не означає, що він порожній — оновіть сторінку</div>
                <button className="btn btn-secondary btn-sm" style={{ marginTop: 10 }} onClick={() => { refresh(); loadIncidents(); }}>↻ Оновити</button>
              </div>
            ) : filtered.length === 0 ? (
              <div className="empty"><div className="ei">⏳</div><div className="et">Лист порожній</div><div className="es">{(!qDebounced.trim() && !viewMod) ? "Додайте пацієнта, що чекає на вільне вікно" : "Змініть фільтр або пошук"}</div></div>
            ) : (
              <div className="clrows">
                {filtered.map((p) => {
                  const expanded = expandedId === p.id;
                  const m = PRIORITY_META[p.priority_level];
                  const stMeta = WAITLIST_STATUS_META[p.status];
                  const busy = busyId === p.id;
                  const boundRoom = p.room_id ? (rooms || []).find((r) => r.id === p.room_id) : null;
                  return (
                    <div className={"clrow-wrap" + (expanded ? " open" : "")} key={p.id}>
                      <div className="wlrow wl-queue">
                        <button className="cl-exp-btn" onClick={() => setExpandedId((x) => (x === p.id ? null : p.id))}
                          title={expanded ? "Згорнути" : "Розгорнути"} aria-label={expanded ? "Згорнути деталі" : "Розгорнути деталі"} aria-expanded={expanded}>
                          <UnreadDot markers={unreadForEntity(unreadIx, "waitlist_entry", p.id)} /><span className={"cl-chev" + (expanded ? " open" : "")} aria-hidden="true">›</span>
                        </button>
                        <div className="wl-pat">
                          <button className="cl-name cl-name-btn wl-name" onClick={() => setExpandedId((x) => (x === p.id ? null : p.id))}>
                            {p.priority_level !== "planned" && p.status === "waiting" && <span className={"prio-tag " + m.tone}>{m.short}</span>}
                            {p.status !== "waiting" && <span className="badge" style={{ marginRight: 6 }}>{stMeta.label}</span>}
                            {p.status === "waiting" ? (
                              <span onClick={(e) => { e.stopPropagation(); setEditFor(p); }}
                                style={{ cursor: "pointer", textDecorationLine: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 3 }}
                                title="Редагувати дані пацієнта та дослідження">{p.patient_name}</span>
                            ) : p.patient_name}
                          </button>
                          <div className="wl-meta">
                            {p.patient_phone && <a className="tel" href={"tel:" + (p.patient_phone || "").replace(/\s/g, "")} title="Подзвонити пацієнту" aria-label={"Подзвонити пацієнту: " + (p.patient_phone || "")}><span aria-hidden="true">☎</span> {p.patient_phone}</a>}
                            <span>Додано: {addedAgo(p.created_at)}</span>
                            {boundRoom && <span title="Жорстка прив'язка до кабінету">Каб.: {boundRoom.name}</span>}
                          </div>
                        </div>
                        <div className="wl-proc-cell">
                          <div className="wl-proc-main">
                            <span className={"wl-mod " + modalityKind(p.modality)}>{modalityLabel(p.modality)}</span>
                            <span className="cl-proc">{procLabel(p)}</span>
                          </div>
                          <div className="wl-proc-du">{p.duration_min} хв + буфер {p.buffer_time_min} хв</div>
                        </div>
                        <div className="wl-win" title="Бажане вікно для підбору слота">{desiredWindowText(p)}</div>
                        <div className="cl-actions">
                          {/* Дії згорнутого рядка; у розгорнутому — в картці (без дублю «дії»). */}
                          {p.status === "waiting" && !expanded && (
                            <>
                              <button className="btn btn-green btn-sm" disabled={busy} aria-busy={busy} onClick={() => openBooking(p)}>{busy ? "…" : "Додати в чергу"}</button>
                              <RowMenu disabled={busy} onEdit={() => setEditFor(p)} onRemove={() => setConfirmRemove(p)} />
                            </>
                          )}
                          {(p.status === "cancelled" || p.status === "expired") && (
                            <button className="btn btn-secondary btn-sm" disabled={busy} aria-busy={busy} onClick={() => restore(p)}>{busy ? "…" : "↩ Повернути"}</button>
                          )}
                        </div>
                      </div>
                      {expanded && (
                        <div className="cl-detail fade-in">
                          <div className="cld-grid">
                            <div className="cld-item cld-item-full"><span className="cld-lab">Пацієнт (ПІБ)</span><span className="cld-val cld-name">
                              {p.status === "waiting" ? (
                                <span onClick={() => setEditFor(p)}
                                  style={{ cursor: "pointer", textDecorationLine: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 3 }}
                                  title="Редагувати дані пацієнта та дослідження">{p.patient_name}</span>
                              ) : p.patient_name}
                            </span></div>
                            <div className="cld-item"><span className="cld-lab">Вік</span><span className="cld-val">{p.patient_age != null ? p.patient_age + " р." : "—"}</span></div>
                            <div className="cld-item"><span className="cld-lab">Модальність</span><span className="cld-val"><span className={"cld-type " + modalityKind(p.modality)}>{modalityLabel(p.modality)}</span></span></div>
                            <div className="cld-item cld-item-full"><span className="cld-lab">Дослідження</span><span className="cld-val cld-val-wrap">{procLabel(p)} · {p.duration_min} хв + буфер {p.buffer_time_min} хв</span></div>
                            <div className="cld-item"><span className="cld-lab">Телефон</span><span className="cld-val"><a className="tel" href={"tel:" + (p.patient_phone || "").replace(/\s/g, "")}>{p.patient_phone}</a></span></div>
                            <div className="cld-item"><span className="cld-lab">Бажане вікно</span><span className="cld-val">{desiredWindowText(p)}</span></div>
                            <div className="cld-item"><span className="cld-lab">Кабінет</span><span className="cld-val">{boundRoom ? boundRoom.name : "Будь-який (за модальністю)"}</span></div>
                            {p.note && <div className="cld-item cld-item-full"><span className="cld-lab">Нотатка</span><span className="cld-val cld-val-wrap">{p.note}</span></div>}
                          </div>
                          {p.status === "waiting" && (
                            <div className="cld-actions" style={{ justifyContent: "space-between" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <span className="cld-lab">Пріоритет:</span>
                                <div className="prio-seg" role="radiogroup" aria-label="Пріоритет пацієнта">
                                  {PRIORITY_OPTIONS.map((pv) => {
                                    const pm = PRIORITY_META[pv];
                                    return (
                                      <button key={pv} type="button" role="radio" aria-checked={p.priority_level === pv}
                                        className={"prio-seg-btn " + pm.tone + (p.priority_level === pv ? " active" : "")}
                                        disabled={!canEditPriority || busy}
                                        title={canEditPriority ? pm.desc : "Змінювати пріоритет може адміністратор або лікар-направник"}
                                        onClick={() => canEditPriority && setPrio(p, pv)}>
                                        {pm.short}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                              {/* Місце ухвалення рішення: одна група дій (у рядку кнопки сховані, поки картку розгорнуто). */}
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <button className="btn btn-green btn-sm" disabled={busy} aria-busy={busy} onClick={() => openBooking(p)}>{busy ? "…" : "Додати в чергу"}</button>
                                <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setEditFor(p)}><span aria-hidden="true">✎</span> Редагувати</button>
                                <button className="btn btn-secondary btn-sm" style={{ color: "var(--red)" }} disabled={busy} onClick={() => setConfirmRemove(p)}><span aria-hidden="true">✕</span> Зняти з листа</button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {hasMore && (
              <div style={{ textAlign: "center", marginTop: 12 }}>
                <button className="btn btn-secondary btn-sm" onClick={() => setLimit((l) => l + PAGE)}>Показати ще</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {addOpen && <WaitlistModal rooms={rooms} clinicTz={clinicTz} services={services} roomOverrides={roomOverrides} onClose={() => setAddOpen(false)} onSave={onAdd} />}
      {editFor && <WaitlistModal rooms={rooms} clinicTz={clinicTz} services={services} roomOverrides={roomOverrides} initial={editFor} onClose={() => setEditFor(null)} onSave={onEditSave} />}
      {confirmRemove && (
        <ConfirmDialog title="Зняти з листа очікування"
          text={<>Зняти <b style={{ color: "var(--text)" }}>{confirmRemove.patient_name}</b> з листа очікування? Запис перейде на вкладку «Зняті» — його можна буде повернути.</>}
          confirmLabel="Зняти з листа" danger busy={busyId === confirmRemove.id}
          onConfirm={async () => { const p = confirmRemove; setConfirmRemove(null); await remove(p); }}
          onClose={() => setConfirmRemove(null)} />
      )}
      {bookFor && (
        <BookingModal rooms={rooms} clinicId={clinicId} clinicTz={clinicTz} incidents={incidents} services={services} roomOverrides={roomOverrides} prefill={bookPrefill}
          onClose={() => setBookFor(null)} onSave={saveBooking} />
      )}

      <div role="status" aria-live="polite">
        <Toast toast={toast} onDismiss={() => setToast(null)} />
      </div>
    </div>
  );
}
