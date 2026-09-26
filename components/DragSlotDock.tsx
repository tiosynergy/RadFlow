"use client";

/* ===== RadFlow — док «Вільні слоти» під час перетягування (с81) =====
   Зʼявляється у правій панелі дошки, щойно оператор узяв рядок запису мишкою:
   сітка 5-хв слотів ТОГО САМОГО кабінету на день дошки (направнику — на день
   запису), вільні комірки приймають кидок. Це ціль для «перенести на вільний
   слот того ж дня»; інший день — через наведення на календар поруч (там
   відкривається карта дня). Ціль для «того ж дня» тримаємо в панелі, а не в
   списку: список дошки — по всіх кабінетах, і «проміжки» між рядками не є
   вільним часом жодного кабінету.

   Стан слотів — спільний `useDropSlots` (та сама логіка, що в карті дня):
   зайнятість з RPC (без самого запису), графік і перерви з фідів, простої —
   з фіду форм, що ПИШУТЬ (`writeIncidentsFeed` на дошці). Невідомість → сітки
   немає, є причина (`missText`) — стверджувати «вільно» на непрочитаних даних
   не можна (U-11/U-16, той самий клас, що у форм).

   Кидок = дія. Дока не буде, коли тягнути нікуди (немає кабінету) — тоді й
   `draggable` на рядку не ставлять. Помилку сервера показує батько тостом і
   лишає рядок на місці: перенос через `rescheduleQueueEntry` перевіряє все ще
   раз (минуле, графік, перетин, простій). */

import { useState } from "react";
import SlotPicker from "@/components/SlotPicker";
import { useDropSlots } from "@/lib/useDropSlots";
import { dragChipLabel, type DragEntry, type DropTarget } from "@/lib/dragMove";
import type { OverrideFeed } from "@/lib/schedule";
import type { IncidentFeed } from "@/lib/incidents";
import { modalityShort, modalityKind } from "@/lib/studies";

type RoomLike = { id: string; name: string; modality: string; apparatus_model?: string | null; schedule?: unknown };

export default function DragSlotDock({ entry, room, dateKey, dateLabel, clinicId, clinicTz, overrides, incidents, onDrop }: {
  entry: DragEntry;
  room: RoomLike;
  dateKey: string;
  /** Підпис дня людською мовою («26 вересня») — форматує батько (у нього свій `fmtShort`). */
  dateLabel: string;
  clinicId: string | null | undefined;
  clinicTz?: string | null;
  /** `null` = ще довантажується (портал направника читає фіди асинхронно). */
  overrides: OverrideFeed | null;
  incidents: IncidentFeed | null;
  onDrop: (target: DropTarget) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const ds = useDropSlots({
    entry, roomId: room.id, roomSchedule: room.schedule ?? null, dateKey, clinicId, clinicTz,
    overridesFeed: overrides, incidents, enabled: true,
  });
  const drop = async (time: string) => {
    if (busy) return;
    setBusy(true);
    try { await onDrop({ roomId: room.id, dateKey, time }); } finally { setBusy(false); }
  };
  return (
    <div className="rcard drag-dock" aria-busy={busy || ds.loading} role="region" aria-label="Вільні слоти для переносу">
      <h3><span className="hic" aria-hidden="true">⇅</span>Вільні слоти · {dateLabel}</h3>
      <div className="dd-room">
        <span className={"bd-room-kind " + modalityKind(room.modality)}>{modalityShort(room.modality)}</span>
        <b>{room.name}</b>{room.apparatus_model ? <span className="dd-muted"> · {room.apparatus_model}</span> : null}
      </div>
      <div className="dd-chip active" aria-label={"Переносимо: " + dragChipLabel(entry)}>
        <span aria-hidden="true">⇅</span>{dragChipLabel(entry)}
      </div>
      {ds.missText || !ds.trusted ? (
        <div className={"ctx-hint" + (ds.loading ? "" : " red")} style={{ fontSize: "0.75rem" }} role="status">
          {ds.loading ? "⏳ Перевіряємо зайнятість…" : "⚠ " + (ds.missText ?? "Дані про день не завантажились") + " — вільний час не показано. Скористайтесь «🗓 Перенести»."}
        </div>
      ) : ds.closed ? (
        <div className="ctx-hint red" style={{ fontSize: "0.75rem" }} role="status">🚫 Кабінет цього дня не працює — оберіть інший день у календарі нижче.</div>
      ) : ds.slots.length === 0 ? (
        <div className="ctx-hint" style={{ fontSize: "0.75rem" }} role="status">Графік кабінету на цей день порожній.</div>
      ) : (
        <>
          <div className="dd-hint">Відпустіть на зеленому слоті · блок {ds.durMin} хв{ds.bufferMin > 0 ? ` + ${ds.bufferMin} буфер` : ""}. Інший день — наведіть на календар нижче.</div>
          <SlotPicker slots={ds.slots} stateOf={ds.stateOf} value="" onChange={(s) => { void drop(s); }} titleOf={ds.titleOf}
            freeStates={["free"]} spanMin={ds.durMin} bufferMin={ds.bufferMin} dropActive onDropSlot={(s) => { void drop(s); }} />
          <div className="bk-slot-legend">
            <span><span className="lg-dot free" />вільно</span>
            <span><span className="lg-dot tight" />не вміщується</span>
            <span><span className="lg-dot busy" />зайнято</span>
            <span><span className="lg-dot busybuf" />буфер</span>
          </div>
        </>
      )}
    </div>
  );
}
