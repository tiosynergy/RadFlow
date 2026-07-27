"use client";

/* ===== RadFlow — панель рішення при колізії черги =====
   Дослідження в кабінеті затягнулося і наїжджає на наступний запис (детекція —
   collisionFor() у lib/queueStatus.ts, від ФАКТИЧНОГО старту in_progress_at).
   Досі система лише гасила «Викликати в кабінет» — тут вона пропонує вихід.

   Продуктові рішення (Ігор, 2026-07-11):
     • переносимо ТІЛЬКИ наступний запис (Б), а не весь хвіст дня;
     • слот Б шукаємо такий, де він нікого не зачепить (firstFittingSlot) —
       тому каскад не виникає за побудовою;
     • за межі робочого графіка НЕ виштовхуємо: якщо до кінця дня вже не влазить,
       лишається обзвін (call_status = to_recall) або ручний перенос на інший день.

   Зайнятість беремо з RPC room_busy_slots (він уже рахує in_progress за фактичним
   стартом — міграція 0060), а не з дошки: так пропозиція не бреше. */

import { useEffect, useState } from "react";
import { isRoomBookable } from "@/lib/rooms";
import { createClient } from "@/lib/supabase/client";
import { roomScheduleFor, effectiveRoomBreaks, type DayOverride, type Break } from "@/lib/schedule";
import { incidentEffectiveEnd, wallNow, wallMinOfDay, wallInstant, type IncidentLike } from "@/lib/incidents";
import { firstFittingSlot, slotToMin, type BusySpan } from "@/lib/slots";
import { BUFFER_DEFAULT, normBuffer } from "@/lib/studies";
import type { BusyRow } from "@/lib/slotBusy";   // 0074: рядок room_busy_slots — один тип на всіх
import type { CollisionInfo } from "@/lib/queueStatus";

type RoomOpt = { id: string; modality: string; name: string; apparatus_model?: string | null; active?: boolean | null };
type PanelEntry = {
  id: string;
  room_id: string | null;
  scheduled_time: string | null;
  duration_min: number | null;
  buffer_time_min: number | null;
  patient_name: string | null;
};

interface Props {
  entry: PanelEntry;           // запис Б — той, на кого наїжджають
  info: CollisionInfo;
  rooms?: RoomOpt[];
  clinicId?: string | null;
  clinicTz?: string | null;
  date: Date;                  // день дошки (колізія можлива лише сьогодні)
  override?: DayOverride | null;
  incidents?: IncidentLike[];
  onMove: (roomId: string, time: string) => void | Promise<void>;
  onRecall: () => void | Promise<void>;
  onManual: () => void;
}

const pad = (n: number) => String(n).padStart(2, "0");
const dateVal = (d: Date) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const shortName = (n: string | null | undefined) => String(n || "").split(" ").slice(0, 2).join(" ");

type Suggestion = { roomId: string; roomName: string; time: string; sameRoom: boolean };

export default function CollisionPanel({ entry, info, rooms, clinicId, clinicTz, date, override, incidents = [], onMove, onRecall, onManual }: Props) {
  const [loading, setLoading] = useState(true);
  const [here, setHere] = useState<Suggestion | null>(null);   // той самий кабінет
  const [alt, setAlt] = useState<Suggestion | null>(null);     // паралельний кабінет — лише якщо РАНІШЕ
  const [busyErr, setBusyErr] = useState(false);
  const [pending, setPending] = useState(false);

  const dur = entry.duration_min || 30;
  const buffer = normBuffer(entry.buffer_time_min ?? BUFFER_DEFAULT);
  const curRoom = (rooms || []).find((r) => r.id === entry.room_id);
  const modality = curRoom?.modality;
  const dateStr = dateVal(date);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setBusyErr(false);
    (async () => {
      try {
        const supabase = createClient();
        // Кандидати: свій кабінет + паралельні тієї ж модальності.
        /* 0123: вимкнені кабінети в кандидати не беремо (перенести туди не можна),
           але ПОТОЧНИЙ кабінет лишаємо завжди — зсув усередині нього дозволений. */
        const cands = (rooms || []).filter((r) => r.id === entry.room_id
          || (modality && r.modality === modality && isRoomBookable(r)));
        if (!cands.length) { if (!cancel) { setHere(null); setAlt(null); setBusyErr(true); } return; } // немає даних про кабінети — не «не влазить»

        /* Перерви кабінетів живуть у rooms.schedule (JSONB) — одним запитом.
           H-6: помилку читання НЕ можна ковтати. Порожній schedById → roomScheduleFor
           відкочується на дефолт «Пн–Сб 08:00–18:00», і панель пропонує слот у час,
           коли кабінет закритий або на перерві. Краще чесно сказати «не можу порадити». */
        const schedRes = await supabase.from("rooms").select("id, schedule").in("id", cands.map((r) => r.id));
        if (schedRes.error) throw schedRes.error;
        const schedById: Record<string, unknown> = {};
        ((schedRes.data || []) as Array<{ id: string; schedule?: unknown }>).forEach((r) => { schedById[r.id] = r.schedule ?? null; });

        const nowMin = wallMinOfDay(wallNow(clinicTz || undefined));
        const found = await Promise.all(cands.map(async (r) => {
          const sched = roomScheduleFor(date, r.id, override, schedById[r.id]);
          if (sched.closed) return null;
          const breaks: Break[] = effectiveRoomBreaks(date, r.id, schedById[r.id], override);
          // H-6: `data || []` тут означало «кабінет вільний увесь день» → панель
          // пропонувала слот ПОВЕРХ чужого запису. PostgREST не кидає сам.
          const { data, error: busyError } = await supabase.rpc("room_busy_slots", { p_room: r.id, p_date: dateStr, p_exclude: entry.id });
          if (busyError) throw busyError;
          /* 0074: беремо вікно, ОБРІЗАНЕ по добі (start_min/end_min) — інакше
             «хвіст» дослідження, що почалося вчора й перетнуло опівніч, панель
             не бачила б і пропонувала слот поверх зайнятого кабінету. */
          const busy: BusySpan[] = ((data || []) as BusyRow[])
            .map((b) => {
              if (b.start_min != null && b.end_min != null) return { s: b.start_min, e: b.end_min };
              const s = slotToMin(String(b.scheduled_time ?? ""));
              return { s, e: s + (b.duration_min ?? 30) + normBuffer(b.buffer_time_min ?? BUFFER_DEFAULT) };
            })
            .filter((b) => b.e > b.s);
          /* Простої кабінету (поломка/ТО/аварійна зупинка) — теж зайнятість.
             Час інциденту — «настінний UTC» (як і слоти), тому переводимо у хвилини
             доби ЧЕРЕЗ ДАТУ дошки і клампимо до меж дня: у incidents прилітають і
             заплановані простої на інші дні, і відкриті «до відновлення» зі вчора —
             без клампа вони вирізали б чужі години (або, гірше, не вирізали свої). */
          const dayStart = wallInstant(dateStr, "00:00");
          const DAY = 24 * 60;
          (incidents || []).filter((i) => i.room_id === r.id).forEach((i) => {
            const st = new Date(i.started_at).getTime();
            const en = incidentEffectiveEnd(i);
            if (!isFinite(st) || en <= dayStart || st >= dayStart + DAY * 60000) return; // простій не цього дня
            const s = Math.max(0, Math.round((st - dayStart) / 60000));
            const e = en === Infinity ? DAY : Math.min(DAY, Math.round((en - dayStart) / 60000));
            if (e > s) busy.push({ s, e });
          });
          const slot = firstFittingSlot({
            // Не раніше «зараз» І не раніше, ніж кабінет реально звільниться
            // (room_busy_slots рахує in_progress за плановою тривалістю від
            //  фактичного старту — якщо дослідження перетягує, freeAtMin чесніший).
            fromMin: Math.max(nowMin, r.id === entry.room_id ? info.freeAtMin : 0),
            durMin: dur, bufferMin: buffer,
            schedStartMin: slotToMin(sched.start), schedEndMin: slotToMin(sched.end),
            busy, breaks,
          });
          if (!slot) return null;
          return { roomId: r.id, roomName: r.name, time: slot, sameRoom: r.id === entry.room_id } as Suggestion;
        }));

        if (cancel) return;
        const mine = found.find((f) => f && f.sameRoom) || null;
        // Паралельний кабінет пропонуємо, лише якщо він реально РАНІШЕ (інакше це просто шум).
        const others = found.filter((f): f is Suggestion => !!f && !f.sameRoom).sort((a, b) => slotToMin(a.time) - slotToMin(b.time))[0] || null;
        const better = others && (!mine || slotToMin(others.time) < slotToMin(mine.time)) ? others : null;
        setHere(mine);
        setAlt(better);
      } catch {
        // Транзієнтний збій (рефреш токена / мережа) — не рушимо дошку.
        if (!cancel) { setHere(null); setAlt(null); setBusyErr(true); }
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
    // info.freeAtMin — щоб пропозиція перерахувалась, коли дослідження затягується далі.
  }, [entry.id, entry.room_id, dateStr, clinicId, clinicTz, dur, buffer, modality, info.freeAtMin]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = (fn: () => void | Promise<void>) => async () => {
    if (pending) return;
    setPending(true);
    try { await fn(); } finally { setPending(false); }
  };

  const roomName = curRoom?.name || "Кабінет";
  const noSlot = !loading && !here && !alt;

  return (
    <div className="ctx-hint red" style={{ marginBottom: 8, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: "0.78125rem", lineHeight: 1.5 }}>
        <b>⚠ Накладення.</b> {roomName} звільниться о <b className="tabular">{info.freeAt}</b>
        {info.running.name ? <> — {shortName(info.running.name)} ще ~{info.running.remainMin} хв у кабінеті</> : null}.
        {" "}Запис о <b className="tabular">{entry.scheduled_time}</b> ({dur} хв) не вміщується — наїзд <b>{info.overlapMin} хв</b>.
      </div>

      {loading && <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>⏳ Шукаю найближчий вільний слот…</div>}

      {busyErr && !loading && (
        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Не вдалося порахувати вільний час кабінету — перенесіть вручну.</div>
      )}

      {noSlot && !busyErr && (
        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
          До кінця робочого графіка запис уже не влазить. Лишається обзвін або ручний перенос на інший день —
          за межі графіка кабінету ми нікого не виштовхуємо.
        </div>
      )}

      {!loading && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {here && (
            <button className="btn btn-primary btn-sm" disabled={pending} onClick={run(() => onMove(here.roomId, here.time))}
              title={"Перенести на найближчий слот, де запис вміщується цілком (" + here.roomName + ")"}>
              🗓 Перенести на {here.time}
            </button>
          )}
          {alt && (
            <button className="btn btn-secondary btn-sm" disabled={pending} onClick={run(() => onMove(alt.roomId, alt.time))}
              title="Паралельний кабінет тієї ж модальності — звільниться раніше">
              ⇄ {alt.roomName} · {alt.time}
            </button>
          )}
          <button className="btn btn-secondary btn-sm" disabled={pending} onClick={run(onRecall)}
            title="Позначити на обзвін: пацієнт потрапить у колл-лист">
            ☎ В обзвін
          </button>
          <button className="btn btn-secondary btn-sm" disabled={pending} onClick={onManual} title="Обрати слот вручну (інший день / кабінет)">
            ✎ Змінити вручну
          </button>
        </div>
      )}
    </div>
  );
}
