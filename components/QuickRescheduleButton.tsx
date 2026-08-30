"use client";

/* ===== RadFlow — інлайн «перенос на найближче вільне вікно» (UX-схема §5.5) =====
   Швидка альтернатива модалці «Перенести»: одна кнопка «→ Найближче вільне · HH:MM».
   Слот рахуємо тим самим способом, що CollisionPanel — зайнятість із RPC
   room_busy_slots (авторитетне джерело, in_progress від фактичного старту, 0060) +
   простої (інциденти), далі firstFittingSlot (той самий хелпер). Своя ж запис
   виключається сервером через p_exclude. Сервер валідує ще раз (check_no_overlap):
   якщо слот щойно зайняли — батько покаже помилку й лишить повний модал.
   Рендериться ЛИШЕ для розгорнутого рядка (батько гейтить expandedRow) — тож
   RPC не б'є по всіх рядках дошки. */

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { roomScheduleFromFeed, roomBreaksFromFeed, overridesUnknown, overrideOn, type OverrideFeed, type Break } from "@/lib/schedule";
import { readRoomScheduleRow, roomScheduleReadError } from "@/lib/roomSchedule";
import { incidentEffectiveEnd, incidentsUnknown, roomIncidentsOf, wallNow, wallMinOfDay, wallInstant, type IncidentFeed } from "@/lib/incidents";
import { firstFittingSlot, slotToMin, type BusySpan } from "@/lib/slots";
import { BUFFER_DEFAULT, normBuffer } from "@/lib/studies";
import type { BusyRow } from "@/lib/slotBusy";

type Entry = { id: string; room_id: string | null; duration_min: number | null; buffer_time_min: number | null };

const pad = (n: number) => String(n).padStart(2, "0");
const dateVal = (d: Date) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());

export default function QuickRescheduleButton({ entry, clinicTz, date, overrides, incidents, onPick }: {
  entry: Entry;
  clinicTz?: string | null;
  date: Date;
  overrides: OverrideFeed;     // U-16: фід (мапа+failed), не гола строка дня
  incidents: IncidentFeed;     // U-11: фід (rows+failed), не голий масив
  onPick: (time: string) => void | Promise<void>;
}) {
  const [loading, setLoading] = useState(true);
  const [slot, setSlot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const dur = entry.duration_min || 30;
  const buffer = normBuffer(entry.buffer_time_min ?? BUFFER_DEFAULT);
  const dateStr = dateVal(date);
  // Примітив у депсах: сам фід — новий обʼєкт на кожен рендер батька.
  const incidentsFailed = incidentsUnknown(incidents);
  const overridesFailed = overridesUnknown(overrides);
  /* Ревʼю р1 (F6): відбиток ЗМІСТУ графіка цього дня — інакше «прочитали,
     потім адмін закрив день» не перераховувало б кнопку (realtime оновлює
     мапу, прапорець збою при цьому не змінюється). Рядок, не обʼєкт: сам фід
     у депси попадати не має. */
  const overrideKey = overridesFailed ? "?" : JSON.stringify(overrideOn(overrides, dateStr) ?? null);

  useEffect(() => {
    let cancel = false;
    const roomId = entry.room_id;
    if (!roomId) { setLoading(false); setSlot(null); return; }
    /* U-11: простої НЕ прочитались → «найближче вільне вікно» не рахуємо й
       кнопку не показуємо. Голий `[]` на місці збою означав «простоїв немає»,
       і кнопка в один клік переносила пацієнта в кабінет на ремонті. Повний
       модал «Перенести» лишається — там видно, що дані не підтверджені. */
    if (incidentsFailed) { setLoading(false); setSlot(null); return; }
    /* U-16: те саме для особливих графіків дня — і тут ціна вища, ніж деінде.
       Це кнопка В ОДИН КЛІК: порожня мапа на місці збою означала б «звичайний
       день», і кнопка запропонувала б час у кабінеті, закритому санітарним
       днем. Окремою гілкою, а не в парі з простоями: два канали — два гейти,
       щоб кожен був названий і кожен фальсифікувався окремо. */
    if (overridesFailed) { setLoading(false); setSlot(null); return; }
    setLoading(true);
    (async () => {
      try {
        const supabase = createClient();
        const schedRes = await supabase.from("rooms").select("id, schedule").eq("id", roomId).maybeSingle();
        /* U-13: сама лише перевірка `error` пропускала ПОРОЖНІЙ рядок (кабінет
           невидимий за RLS 0139 або видалений) — і кнопка радила час за хардкодом
           «Пн–Сб 08:00–18:00» замість справжнього графіка. Правило спільне. */
        const read = readRoomScheduleRow(schedRes);
        if (!read.known) throw roomScheduleReadError(read.reason);
        const schedule = read.schedule;
        /* Недосяжно, поки живий ранній гейт (той самий фід, те саме замикання) —
           розтяжка на випадок, якщо його колись приберуть; так само, як із
           простоями нижче. */
        const sched = roomScheduleFromFeed(date, roomId, overrides, schedule);
        if (sched === null) throw new Error("overrides-unknown");   // невідомо ≠ звичайний день
        if (sched.closed) { if (!cancel) { setSlot(null); setLoading(false); } return; }
        const breaks: Break[] | null = roomBreaksFromFeed(date, roomId, schedule, overrides);
        if (breaks === null) throw new Error("overrides-unknown");   // порожні перерви ≠ «перерв немає»

        const { data, error } = await supabase.rpc("room_busy_slots", { p_room: roomId, p_date: dateStr, p_exclude: entry.id });
        if (error) throw error;
        const spans: BusySpan[] = ((data || []) as BusyRow[])
          .map((b) => {
            if (b.start_min != null && b.end_min != null) return { s: b.start_min, e: b.end_min };
            const s = slotToMin(String(b.scheduled_time ?? ""));
            return { s, e: s + (b.duration_min ?? 30) + normBuffer(b.buffer_time_min ?? BUFFER_DEFAULT) };
          })
          .filter((b) => b.e > b.s);

        // Простої кабінету (поломка/ТО) — теж зайнятість (кламп до меж доби, як у CollisionPanel).
        const dayStart = wallInstant(dateStr, "00:00");
        const DAY = 24 * 60;
        // Недосяжно, поки живий ранній гейт (те саме замикання) — розтяжка на
        // випадок, якщо його колись приберуть. Ревʼю р2 (F5): лишили свідомо.
        const roomInc = roomIncidentsOf(incidents, roomId);
        if (roomInc === null) throw new Error("incidents-unknown");   // невідомо ≠ вільно
        roomInc.forEach((i) => {
          const st = new Date(i.started_at).getTime();
          const en = incidentEffectiveEnd(i);
          if (!isFinite(st) || en <= dayStart || st >= dayStart + DAY * 60000) return;
          const s = Math.max(0, Math.round((st - dayStart) / 60000));
          const e = en === Infinity ? DAY : Math.min(DAY, Math.round((en - dayStart) / 60000));
          if (e > s) spans.push({ s, e });
        });

        const nowMin = wallMinOfDay(wallNow(clinicTz || undefined));
        const found = firstFittingSlot({
          fromMin: nowMin,
          durMin: dur, bufferMin: buffer,
          schedStartMin: slotToMin(sched.start), schedEndMin: slotToMin(sched.end),
          busy: spans, breaks,
        });
        if (!cancel) { setSlot(found); setLoading(false); }
      } catch {
        // Транзієнтний збій / немає даних — ховаємо інлайн, лишається модал «Перенести».
        if (!cancel) { setSlot(null); setLoading(false); }
      }
    })();
    return () => { cancel = true; };
  }, [entry.id, entry.room_id, dateStr, clinicTz, dur, buffer, incidentsFailed, overridesFailed, overrideKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <span className="btn btn-secondary btn-sm" style={{ flex: "0 0 auto", opacity: 0.6, cursor: "default", whiteSpace: "nowrap" }} aria-busy="true">
        <span className="rf-spin" aria-hidden="true" /> Шукаю вікно…
      </span>
    );
  }
  if (!slot) return null; // немає вікна сьогодні → лишається повний модал «Перенести»

  return (
    <button
      className="btn btn-secondary btn-sm"
      style={{ flex: "0 0 auto", whiteSpace: "nowrap", borderColor: "var(--green)", color: "var(--green)" }}
      disabled={busy}
      title={"Перенести на найближче вільне вікно кабінету о " + slot}
      onClick={async (e) => {
        e.stopPropagation();
        if (busy) return;
        setBusy(true);
        try { await onPick(slot); } finally { setBusy(false); }
      }}
    >
      {busy ? <><span className="rf-spin" aria-hidden="true" /> Переношу…</> : <>→ Найближче вільне · {slot}</>}
    </button>
  );
}
