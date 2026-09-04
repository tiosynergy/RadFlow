/* ===== RadFlow — зайнятість кабінету: спани + тултипи + realtime =====
   Одне джерело правди для всіх сіток слотів (запис / перенос / портал / редактор
   досліджень). Раніше кожна модалка сама ходила в RPC і сама рахувала спани.

   ДЕТАЛІ ЗАЙНЯТОГО СЛОТА (ПІБ, статус, дослідження) приходять із room_busy_slots
   ЛИШЕ адміну та радіологу цього центру — гейт стоїть у SQL (міграція 0062).
   Реєстратор і направник отримують ті самі рядки з NULL у цих полях: RPC свідомо
   обходить RLS (щоб направник бачив зайнятість, не бачачи чужих записів), тож
   вирішувати «кому можна» на клієнті було б небезпечно. Тут ми лише малюємо те,
   що віддав сервер: немає ПІБ — тултип буде коротким. */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import { BUFFER_DEFAULT, normBuffer, isContrastName} from "@/lib/studies";

/** Рядок RPC room_busy_slots. Три останні поля — NULL, якщо ролі не можна їх бачити.
    0074: *_min — вікно зайнятості, ОБРІЗАНЕ по запитаній добі (хвилини від 00:00).
    Саме вони — джерело правди; scheduled_time/duration_min/buffer_time_min лишені
    для сумісності й описують те саме вікно. */
export type BusyRow = {
  scheduled_time: string | null;
  duration_min: number | null;
  buffer_time_min: number | null;
  start_min?: number | null;
  end_study_min?: number | null;
  end_min?: number | null;
  status?: string | null;
  patient_name?: string | null;
  studies?: unknown;
};

/** Зайнятий інтервал у хвилинах доби. s..e — окупація (дослідження + буфер);
    eStudy — кінець самого дослідження (буфер — це прибирання, не процедура).
    Назва відрізняється від BusySpan у lib/slots.ts (там просто {s,e}) навмисно —
    щоб не було двох різних типів з однаковим іменем. */
export type BusyDetailSpan = { s: number; e: number; eStudy: number; row: BusyRow };

const toMin = (t: string | null | undefined) => {
  const p = String(t || "").split(":");
  return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
};
const fmt = (m: number) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");

/* ЖОДНИХ дефолтів «|| 30» і normBuffer() тут (0074). На «хвостовому» рядку
   (дослідження почалося вчора й перетнуло опівніч) duration_min законно дорівнює
   0 — у цю добу зайшов лише буфер, — і `duration_min || 30` намалював би пів
   години зайнятості з повітря. Так само normBuffer() клампить буфер у 0/5/10/15,
   а обрізаний залишок буфера може бути будь-яким (напр. 3 хв). */
export function busySpans(rows: BusyRow[] | null | undefined): BusyDetailSpan[] {
  return (rows || [])
    .map((r) => {
      if (r.start_min != null && r.end_min != null) {
        return { s: r.start_min, e: r.end_min, eStudy: r.end_study_min ?? r.end_min, row: r };
      }
      // Fallback на старий контракт (якщо 0074 ще не накотили на цю БД).
      const s = toMin(r.scheduled_time);
      const eStudy = s + (r.duration_min ?? 30);
      return { s, e: eStudy + normBuffer(r.buffer_time_min ?? BUFFER_DEFAULT), eStudy, row: r };
    })
    .filter((b) => b.e > b.s)
    .sort((a, b) => a.s - b.s);
}

/** Спан, який накриває хвилину min (включно з буфером). */
export function busyAt(spans: BusyDetailSpan[], min: number): BusyDetailSpan | undefined {
  return spans.find((b) => min >= b.s && min < b.e);
}

export const ST_LABEL: Record<string, string> = {
  scheduled: "В черзі",
  waiting: "Очікує",
  in_progress: "В кабінеті",
  done: "Виконано",
};

/** Дослідження записи → «МРТ · Колінний суглоб з контрастом + КТ · Кінцівки». */
export function studiesText(studies: unknown): string {
  const arr = Array.isArray(studies) ? (studies as Array<{ type?: string; region?: string; contrast?: boolean }>) : [];
  if (!arr.length) return "";
  return arr.map((s) => (s.type || "") + (s.region ? " · " + s.region : "") + (s.contrast && !isContrastName(s.region) ? " з контрастом" : "")).join(" + ");
}

/** Тултип зайнятої пʼятихвилинки. Деталі показуються, лише якщо сервер їх віддав
    (admin/radiologist центру) — інакше лишається знеособлене «Зайнято · 13:25–14:35». */
export function busyTooltip(b: BusyDetailSpan): string {
  const lines: string[] = [];
  const buf = b.e - b.eStudy;
  lines.push("Зайнято · " + fmt(b.s) + "–" + fmt(b.eStudy) + (buf > 0 ? " (+" + buf + " хв буфер)" : ""));
  const st = b.row.status ? (ST_LABEL[b.row.status] || b.row.status) : null;
  if (st) lines.push("Статус: " + st);
  if (b.row.patient_name) lines.push("Пацієнт: " + b.row.patient_name);
  const proc = studiesText(b.row.studies);
  if (proc) lines.push(proc);
  return lines.join("\n");
}

/* ===== Хук: зайнятість кабінету на дату + realtime =====
   Realtime — через спільний lib/useRealtimeRefetch (конвенція TD-3): будь-яка
   зміна queue_entries/incidents перезавантажує зайнятість, поки модалка відкрита.
   Увага: realtime-події ходять під RLS, тож НАПРАВНИК події по чужих записах не
   отримає — для нього сітка оновиться при refetch по focus/visibility. Персонал
   (RLS бачить усі записи клініки) отримує оновлення миттєво. */
export function useRoomBusy(opts: {
  roomId: string | null | undefined;
  dateStr: string;
  /* ⚠️ КЛЮЧ ОБОВʼЯЗКОВИЙ, значення — може бути порожнім (U-65, с57). Це той
     самий прийом, що з `clock` у Г1-F: обовʼязковість ТИПУ змушує tsc
     перелічити всі місця виклику, а не мене — згадати їх. Порожнє значення
     не «знімає фільтр», а вимикає підписку ЦІЛКОМ (див. channelName): краще
     без realtime, ніж без фільтра. */
  clinicId: string | null | undefined;
  excludeId?: string | null;
  enabled?: boolean;
}) {
  const { roomId, dateStr, clinicId, excludeId = null, enabled = true } = opts;
  const [rows, setRows] = useState<BusyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  /* Аудит 2026-08-06 H-3A: лічильник поколінь (правило проєкту з с24 — «два
     запити в одному reload — це гонка», тут воно нарешті застосоване і до
     цього хука). Без нього при швидкій зміні кабінету/дати ВІДПОВІДЬ СТАРОГО
     запиту могла завершитись пізніше нового і перезаписати rows/error/loading —
     сітка показувала зайнятість ЧУЖОГО кабінету або чужої дати, а перехід
     loading true→false помічав уже НОВИЙ roomDateKey як «свіжий» (BookingModal
     звіряє свіжість саме за цим переходом). Кожна зміна scope і кожен виклик
     load() підвищують покоління; відповідь чужого покоління ігнорується цілком. */
  const genRef = useRef(0);

  const load = useCallback(async () => {
    const gen = ++genRef.current;
    if (!enabled || !roomId || !dateStr) { setRows([]); setError(false); setLoading(false); return; }
    try {
      const supabase = createClient();
      const { data, error: rpcErr } = await supabase.rpc("room_busy_slots", {
        p_room: roomId, p_date: dateStr, ...(excludeId ? { p_exclude: excludeId } : {}),
      });
      if (gen !== genRef.current) return; // відповідь чужого scope/покоління
      /* PostgREST не кидає виняток — повертає {data:null, error}. Мовчки взяти
         data||[] означало б показати ЗАЙНЯТИЙ день як «усе вільно» — і дати
         записати пацієнта поверх іншого (від бронювання нас урятував би лише
         тригер check_no_overlap, і то помилкою в лоб). Тому помилку піднімаємо. */
      if (rpcErr) throw rpcErr;
      setRows((data || []) as BusyRow[]);
      setError(false);
    } catch {
      if (gen !== genRef.current) return;
      // Транзієнтний збій (рефреш токена / мережа) — модалку не рушимо (конвенція
      // проєкту), але й «усе вільно» не малюємо: піднімаємо error, сітка ховається.
      setError(true);
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }, [roomId, dateStr, excludeId, enabled]);

  // Первинне завантаження робить сам useRealtimeRefetch (callAll при підписці) —
  // тут скидаємо стан при зміні scope: старі spans чужого кабінету/дати не
  // показуються ані кадру, а відповіді старого покоління вже інвалідовані.
  useEffect(() => {
    genRef.current++;
    if (!enabled || !roomId || !dateStr) { setRows([]); setError(false); setLoading(false); return; }
    setRows([]);
    setError(false);
    setLoading(true);
  }, [enabled, roomId, dateStr, excludeId]);

  useRealtimeRefetch({
    /* excludeId — частина scope (ревʼю с26 L-3): його зміна бампає покоління й
       чистить стан, тож БЕЗ переподписки (callAll → load) ніхто не завантажив би
       нові дані до повільного тика. Сьогодні всі споживачі тримають excludeId
       константним на маунт — це страховка від майбутнього in-place свопа. */
    /* ⚠️ `clinicId` — теж умова каналу (U-65). Без клініки фільтр нижче був би
       брехнею (`clinic_id=eq.undefined`), а зняти його — означало б повернути
       крос-тенантний оракул. Тож без клініки підписки НЕМАЄ ЗОВСІМ: сітка
       оновиться при відкритті модалки і по focus/visibility. Заміряно: усі
       чотири місця виклику клініку мають, тож у житті ця гілка не вмикається —
       вона fail-CLOSED на майбутнє. */
    channelName: enabled && roomId && dateStr && clinicId
      ? "slots-busy-" + roomId + "-" + dateStr + (excludeId ? "-x" + excludeId : "")
      : null,
    subscriptions: [
      /* Спільний debounceKey (ревʼю с26 L-4): обидві таблиці ведуть в ОДИН load —
         без ключа callAll кликав би його двічі на кожен тик/маунт/фокус.
         ⚠️ Фільтри тут РІЗНІ, і різниця свідома (U-61).
         `incidents` — `room_id=eq.`: на подіях DELETE `realtime.apply_rls`
         політику не обчислює, тож рішення «кому доставити» приймає лише фільтр
         підписки; без нього сітка ловила б факт кожного видалення простою в
         УСІЙ базі. `roomId` тут гарантовано непорожній: без нього
         `channelName` = null.
         ⚠️ Межа цього фільтра, названа ревʼю: сьогодні простій між кабінетами
         не «переїжджає» — `BreakdownModal` рекеїть секцію по `roomId` і віддає
         в `onSave` той самий кабінет. Але RPC `submit_incident_rpc` зміну
         `room_id` ДОЗВОЛЯЄ. Зʼявиться контрол «перенести простій в інший
         кабінет» — і `room_id=eq.` проковтне подію «поїхав звідси» (в UPDATE
         фільтр звіряється з НОВИМ рядком), а звільнений слот провисить
         зайнятим до 30-секундного тика. Тобто цей фільтр тримається на
         поведінці UI, а не на інваріанті БД.
         `queue_entries` — `clinic_id=eq.`, і саме ЦЕЙ фільтр, а не `room_id`
         (U-65 закрито в с57). Запис кабінет МІНЯЄ, а в UPDATE фільтр звіряється
         з НОВИМ рядком, тож `room_id=eq.` проковтнув би подію «пацієнта
         перенесли ЗВІДСИ» і звільнений слот висів би зайнятим до тику полінгу.
         Клініку ж запис НЕ міняє в жодному шляху, тож `clinic_id=eq.` не ріже
         нічого потрібного — і водночас закриває те, заради чого U-65 і заведено:
         без фільтра сюди прилітав ФАКТ і ЧАС кожного видалення запису в УСІЙ
         базі, тобто крос-тенантний оракул ідентифікаторів.
         ⚠️ Вмісту рядка не віддавав і раніше: `apply_rls` ріже `old_record` до
         первинного ключа — У ГІЛЦІ DELETE, — щойно на таблиці ввімкнено RLS
         (`and ( not is_rls_enabled or (c).is_pkey )`), а RLS увімкнено на всіх
         таблицях публікації (стереже перевірка №3). Тобто закрито саме оракул,
         а не витік вмісту — і це різні речі.
         ⚠️ Уточнення с57 (U-66): у гілці UPDATE обрізки НЕМАЄ. Тут це нічого не
         міняє — сітка підписана по клініці, а `clinic_id` записи не міняють,
         тож увести рядок у видимість цієї підписки нічим. Але сама фраза «ріже
         old_record» без «у гілці DELETE» — неправда, і в трьох місцях проєкту
         вона стояла саме так. */
      { table: "queue_entries", filter: "clinic_id=eq." + clinicId, onChange: load, debounceKey: "busy" },
      { table: "incidents", filter: "room_id=eq." + roomId, onChange: load, debounceKey: "busy" },
    ],
    /* Аудит H-3B: realtime під RLS не доставляє направнику зміни ЧУЖИХ записів —
       при здоровому сокеті його відкрита сітка застарівала б безстроково. Рідкий
       тикер оновлює зайнятість і при SUBSCRIBED; вмикаємо для ВСІХ ролей: модалка
       з сіткою відкрита недовго, один RPC на пів хвилини — дешевша страховка,
       ніж клієнтське визначення ролі. */
    pollWhenSubscribedMs: 30_000,
  });

  return { rows, spans: busySpans(rows), loading, error, reload: load };
}
