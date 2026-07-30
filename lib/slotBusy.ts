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

import { useState, useEffect, useCallback } from "react";
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
  excludeId?: string | null;
  enabled?: boolean;
}) {
  const { roomId, dateStr, excludeId = null, enabled = true } = opts;
  const [rows, setRows] = useState<BusyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (!enabled || !roomId || !dateStr) { setRows([]); setError(false); setLoading(false); return; }
    try {
      const supabase = createClient();
      const { data, error: rpcErr } = await supabase.rpc("room_busy_slots", {
        p_room: roomId, p_date: dateStr, ...(excludeId ? { p_exclude: excludeId } : {}),
      });
      /* PostgREST не кидає виняток — повертає {data:null, error}. Мовчки взяти
         data||[] означало б показати ЗАЙНЯТИЙ день як «усе вільно» — і дати
         записати пацієнта поверх іншого (від бронювання нас урятував би лише
         тригер check_no_overlap, і то помилкою в лоб). Тому помилку піднімаємо. */
      if (rpcErr) throw rpcErr;
      setRows((data || []) as BusyRow[]);
      setError(false);
    } catch {
      // Транзієнтний збій (рефреш токена / мережа) — модалку не рушимо (конвенція
      // проєкту), але й «усе вільно» не малюємо: піднімаємо error, сітка ховається.
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [roomId, dateStr, excludeId, enabled]);

  // Первинне завантаження робить сам useRealtimeRefetch (callAll при підписці) —
  // тут лише скидаємо стан при зміні кабінету/дати й гасимо вимкнений режим.
  useEffect(() => {
    if (!enabled || !roomId || !dateStr) { setRows([]); setError(false); setLoading(false); return; }
    setLoading(true);
  }, [enabled, roomId, dateStr]);

  useRealtimeRefetch({
    channelName: enabled && roomId && dateStr ? "slots-busy-" + roomId + "-" + dateStr : null,
    subscriptions: [
      { table: "queue_entries", onChange: load },
      { table: "incidents", onChange: load },
    ],
  });

  return { rows, spans: busySpans(rows), loading, error, reload: load };
}
