"use client";

import { useMemo, useState } from "react";
import SlotPicker from "@/components/SlotPicker";
import { useModalA11y } from "@/lib/useModalA11y";
import { useRoomBusy, busyAt, busyTooltip } from "@/lib/slotBusy";
import { buildSlots, slotToMin } from "@/lib/slots";
import { inBreak, overrideOn, roomBreaksFromFeed, roomScheduleFromFeed, type OverrideFeed } from "@/lib/schedule";
import { incidentEffectiveEnd, roomIncidentsOf, wallNow, wallToday0, wallMinOfDay, type IncidentLike, type IncidentFeed } from "@/lib/incidents";
import { modalityShort, modalityKind } from "@/lib/studies";

type Room = {
  id: string;
  name: string;
  modality: string;
  apparatus_model?: string | null;
  schedule?: unknown;
};
type RoomIncident = IncidentLike & { reason_label?: string | null };

type Props = {
  rooms: Room[];
  clinicTz: string;
  incidents: IncidentFeed<RoomIncident>;   // U-11: фід (rows+failed), не голий масив
  overrides: OverrideFeed;                 // U-16: фід (мапа+failed), не гола мапа
  onClose: () => void;
};

const pad = (n: number) => String(n).padStart(2, "0");
const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateFromKey = (v: string) => {
  const [y, m, d] = v.split("-").map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1);
};
/**
 * Read-only карта дня для администратора. Она намеренно использует те же
 * room_busy_slots + SlotPicker, что и перенос: визуальный ответ на вопрос
 * «кабинет свободен?» не должен расходиться с формой записи.
 */
export default function RoomDayOverviewModal({ rooms, clinicTz, incidents, overrides, onClose }: Props) {
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  const [roomId, setRoomId] = useState(() => rooms[0]?.id || "");
  const [day, setDay] = useState(() => dateKey(wallToday0(clinicTz)));
  const [selectedSlot, setSelectedSlot] = useState("");

  const room = rooms.find((r) => r.id === roomId) || null;
  const date = useMemo(() => dateFromKey(day), [day]);
  /* U-16: `null` = особливі графіки дня не прочитались. Порожня мапа на місці
     збою означала б «особливих днів немає», і день, закритий ЛИШЕ через
     override, малювався б повною сіткою вільних слотів — на екрані, який
     МУСИТЬ збігатися з формою запису. Той самий клас, що U-11, інший канал. */
  const schedule = roomScheduleFromFeed(date, roomId, overrides, room?.schedule ?? null);
  const overridesFailed = schedule === null;
  const breaks = roomBreaksFromFeed(date, roomId, room?.schedule ?? null, overrides) || [];
  const { spans, loading, error, reload } = useRoomBusy({ roomId, dateStr: day, enabled: !!roomId });
  /* Примітиви в депсах: сам `schedule` — новий обʼєкт на кожен рендер.
     Невідомий графік дає порожню сітку так само, як зачинений день: показувати
     її нема з чого, а гілка-банер нижче все одно перехоплює цей стан. */
  const dayClosed = !!schedule?.closed;
  const dayStart = schedule?.start ?? "";
  const dayEnd = schedule?.end ?? "";
  const slots = useMemo(
    () => (overridesFailed || dayClosed ? [] : buildSlots(slotToMin(dayStart), slotToMin(dayEnd))),
    [overridesFailed, dayClosed, dayStart, dayEnd],
  );
  // Настінний час клініки як хвилини доби. wallNow(tz) уже повертає wall-as-UTC,
  // тож БЕРЕМО wallMinOfDay (UTC-поля), а НЕ форматуємо ще раз у clinicTz —
  // інакше зсув таймзони застосовувався б ДВІЧІ (13:42 ставало 16:42, і всі
  // слоти до 16:40 хибно позначались «Цей час уже минув»).
  const nowMin = wallMinOfDay(wallNow(clinicTz));
  const isToday = day === dateKey(wallToday0(clinicTz));
  /* U-11: null = простої не прочитались. Ця карта — read-only відповідь на
     питання «кабінет вільний?», і вона мусить збігатися з формою запису;
     порожній масив на місці збою малював би ремонт вільним часом. */
  const roomIncidents = roomIncidentsOf(incidents, roomId);
  const incidentsFailed = roomIncidents === null;

  const incidentAt = (min: number) => {
    const instant = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(min / 60), min % 60);
    return (roomIncidents || []).find((i) => instant >= new Date(i.started_at).getTime() && instant < incidentEffectiveEnd(i));
  };
  const stateOf = (slot: string) => {
    const min = slotToMin(slot);
    // Страховка на випадок, якщо гілку-банер колись приберуть: невідомо ≠ вільно.
    if (incidentsFailed) return "blocked";
    if (overridesFailed) return "blocked";
    if (incidentAt(min)) return "blocked";
    const busy = busyAt(spans, min);
    if (busy) return min >= busy.eStudy ? "buffer" : "busy";
    if (inBreak(min, breaks)) return "break";
    // SlotPicker already has a neutral muted style for `tight`; in this read-only
    // screen it denotes elapsed time rather than an insufficient booking duration.
    if (isToday && min < nowMin) return "tight";
    return "free";
  };
  const titleOf = (slot: string, state: string) => {
    const min = slotToMin(slot);
    if (state === "blocked") {
      const incident = incidentAt(min);
      return `Кабінет недоступний${incident?.reason_label ? ` · ${incident.reason_label}` : ""}`;
    }
    if (state === "busy" || state === "buffer") {
      const busy = busyAt(spans, min);
      return busy ? (state === "buffer" ? `Буфер після дослідження\n${busyTooltip(busy)}` : busyTooltip(busy)) : "Зайнято";
    }
    if (state === "break") {
      const brk = inBreak(min, breaks);
      return brk ? `Перерва · ${brk.start}–${brk.end}` : "Перерва";
    }
    if (state === "tight") return "Цей час уже минув";
    return `Вільно · ${slot}`;
  };

  const occupiedMin = spans.reduce((sum, s) => sum + (s.e - s.s), 0);

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog fade-in" style={{ maxWidth: 620 }} ref={dialogRef} role="dialog" aria-modal="true" aria-label="Зайнятість кабінету">
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--blue-bg)", color: "var(--blue-text)" }}>▦</span>Зайнятість кабінету</div>
          <button className="icon-btn" onClick={onClose} aria-label="Закрити">✕</button>
        </div>
        <div className="dlg-body">
          <div className="ctx-hint blue" style={{ fontSize: "0.8125rem" }}>
            Карта дня оновлюється автоматично. Зайнятий час включає дослідження та буфер прибирання.
          </div>

          <div className="fld" style={{ marginTop: 14 }}>
            <span className="fld-lab">Кабінет</span>
            <div className="bd-rooms">
              {rooms.map((r) => (
                <button key={r.id} type="button" className={"bd-room" + (r.id === roomId ? " active" : "")}
                  onClick={() => { setRoomId(r.id); setSelectedSlot(""); }} title={r.apparatus_model ? `${r.name} · ${r.apparatus_model}` : r.name}>
                  <span className={"bd-room-kind " + modalityKind(r.modality)}>{modalityShort(r.modality)}</span>
                  <span className="bd-room-meta"><span className="bd-room-name">{r.name}</span><span className="bd-room-model">{r.apparatus_model || ""}</span></span>
                </button>
              ))}
            </div>
          </div>

          <div className="fld-row" style={{ alignItems: "end" }}>
            <label className="fld" style={{ maxWidth: 200 }}><span className="fld-lab">Дата</span>
              <input className="inp tabular" type="date" value={day} onChange={(e) => { setDay(e.target.value); setSelectedSlot(""); }} />
            </label>
            <div className="fld" style={{ paddingBottom: 8 }}>
              <span className="fld-lab">Режим дня</span>
              {/* U-16: не стверджуємо ані «працює», ані «не працює», поки не
                  прочитали особливі графіки — обидва варіанти були б вигадкою. */}
              <b>{!schedule ? "Не завантажено" : schedule.closed ? "Кабінет не працює" : `${schedule.start}–${schedule.end}`}</b>
              {schedule?.custom && <span style={{ marginLeft: 6, color: "var(--blue-text)", fontSize: "0.75rem" }}>особливий графік</span>}
            </div>
          </div>

          {/* U-16: гілка невідомості — ПЕРША. Раніше першим стояв `schedule.closed`,
              а він порахований із мапи, якої могло не бути: при збої читання
              екран спокійно казав «не працює» або малював повну сітку вільних
              слотів. Порядок тут — частина правила, а не оформлення. */}
          {overridesFailed ? (
            <div className="ctx-hint red">⚠ Не вдалося завантажити особливі графіки дня — режим роботи кабінету невідомий. Вільний час не показано. Оновіть сторінку.</div>
          ) : schedule.closed ? (
            <div className="ctx-hint red">🚫 {room?.name || "Кабінет"} не працює цього дня{overrideOn(overrides, day)?.label ? ` · ${overrideOn(overrides, day)?.label}` : ""}.</div>
          ) : (error || incidentsFailed) ? (
            /* U-11: збій простоїв ховає сітку так само, як збій зайнятості —
               інакше карта показала б «вільно» там, де кабінет на ремонті. */
            <div className="ctx-hint red">⚠ Не вдалося завантажити {error && incidentsFailed ? "зайнятість і простої" : error ? "зайнятість" : "простої"} кабінету. Вільний час не показано.
              {error && <button type="button" className="btn btn-secondary btn-sm" style={{ marginLeft: 6 }} onClick={reload}>Спробувати ще раз</button>}
              {!error && incidentsFailed && <span style={{ marginLeft: 6 }}>Оновіть сторінку.</span>}
            </div>
          ) : loading ? (
            <div className="ctx-hint" style={{ padding: "22px 0", textAlign: "center", color: "var(--text-muted)" }}>⏳ Завантаження зайнятості…</div>
          ) : (
            <>
              <div className="bk-busy-list" style={{ marginTop: 4 }}>
                <span className="bk-busy-lab">За день:</span>
                <span className="bk-busy-chip">{spans.length} записів</span>
                <span className="bk-busy-chip">зайнято {occupiedMin} хв</span>
                {breaks.map((b) => <span className="bk-busy-chip" key={`${b.start}-${b.end}`}>перерва {b.start}–{b.end}</span>)}
              </div>
              <div className="fld" style={{ marginTop: 12 }}>
                <span className="fld-lab">Сітка дня · крок 5 хв</span>
                <SlotPicker slots={slots} stateOf={stateOf} value={selectedSlot} onChange={setSelectedSlot} titleOf={titleOf} freeStates={["free"]} />
              </div>
              <div className="bk-slot-legend">
                <span><span className="lg-dot free" />вільно</span>
                <span><span className="lg-dot busy" />дослідження</span>
                <span><span className="lg-dot busybuf" />буфер</span>
                {breaks.length > 0 && <span><span className="lg-dot brk" />перерва</span>}
                {(roomIncidents || []).length > 0 && <span><span className="lg-dot busy" />простій / ТО</span>}
                {isToday && <span><span className="lg-dot tight" />час минув</span>}
              </div>
              {selectedSlot && <div className="ctx-hint blue" style={{ marginTop: 10 }}>Обрано {selectedSlot} · {titleOf(selectedSlot, stateOf(selectedSlot))}</div>}
            </>
          )}
        </div>
        <div className="dlg-foot"><span style={{ fontSize: "0.75rem", color: "var(--text-faint)", marginRight: "auto" }}>Дані оновлюються при зміні черги або інциденту.</span><button className="btn btn-primary" onClick={onClose}>Готово</button></div>
      </div>
    </div>
  );
}
