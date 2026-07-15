"use client";

/* ===== RadFlow — вибір слота (крок 5 хв) =====
   Сітка: у рядку 4 півгодинні слоти, кожен поділено на 6 частин по 5 хв
   (4×6 = 24 міні-слоти на рядок = 2 год). Рядків стільки, щоб покрити графік
   роботи кабінету. Дослідження будь-якої тривалості (більше/менше за 30 хв)
   фарбує свої 5-хв слоти.

   БУФЕР ВИДНО ОКРЕМО (2026-07-11). Зайнятість кабінету = тривалість + буфер, але
   раніше і те, і те малювалось однаковим червоним: не було видно, коли САМЕ
   дослідження закінчується, а коли йде прибирання/переукладка. Тепер:
     busy    → суцільний червоний — триває саме дослідження;
     buffer  → червона штриховка   — буфер після чужого запису (кабінет ще зайнятий);
     plan    → зелені межі         — початок і кінець ПЛАНОВАНОГО дослідження;
     planbuf → зелена штриховка    — буфер планованого дослідження (коли кабінет звільниться).

   Решта станів:
     blocked  → .busy  (кабінет на ремонті/ТО);
     break    → .brk   (сіра штриховка — перерва в роботі кабінету);
     tight    → .tight (помаранчевий — не вміщується: запис / кінець графіка / перерва);
     offsched → .offsched (0077 — ПОЗА ГРАФІКОМ: після закриття або в перерву).
                Слот КЛІКАБЕЛЬНИЙ, але вибір веде до діалогу підтвердження —
                тому це «вільний» стан (freeStates), а не .taken;
     past, offhours, closed → .taken (приглушено).
   Кожна модалка передає власний stateOf() — валідація не змінюється. */

import { groupSlots, slotFmt, slotToMin } from "@/lib/slots";

export type SlotStateFn = (slot: string) => string;
export type SlotTitleFn = (slot: string, state: string) => string;

interface Props {
  slots: string[];                 // 5-хв слоти графіка кабінету
  stateOf: SlotStateFn;            // стан слота (логіка модалки)
  value: string;                   // обраний "HH:MM"
  onChange: (slot: string) => void;
  titleOf?: SlotTitleFn;
  freeStates?: string[];           // стани, що вважаються вільними (default ["free"])
  spanMin?: number;                // тривалість планованого дослідження (хв) — для зелених меж
  bufferMin?: number;              // буфер після дослідження — малюємо зеленою штриховкою
  resetKey?: string;               // (не використовується — лишено для сумісності пропсів)
}

export default function SlotPicker({ slots, stateOf, value, onChange, titleOf, freeStates = ["free"], spanMin = 0, bufferMin = 0 }: Props) {
  if (!slots.length) return null;
  const isFree = (st: string) => freeStates.includes(st);
  const blocks = groupSlots(slots); // 30-хв блоки в межах графіка

  // Зелені межі планованого дослідження: перша (початок) і остання (кінець) 5-хв частини.
  const planStart = value || "";
  const startMin = value ? slotToMin(value) : 0;
  const planEnd = value && spanMin > 0 ? slotFmt(startMin + Math.max(0, spanMin - 5)) : planStart;
  // Буфер планованого дослідження: [start+dur, start+dur+buffer) — кабінет ще зайнятий прибиранням.
  const bufFrom = startMin + spanMin;
  const bufTo = bufFrom + Math.max(0, bufferMin);

  return (
    <div className="slot-grid4" role="listbox" aria-label="Вільні слоти (крок 5 хв)">
      {blocks.map((bl) => {
        // 6 рівних частин по 5 хв від початку 30-хв блоку.
        const subs = Array.from({ length: 6 }, (_, i) => slotFmt(bl.startMin + i * 5));
        return (
          <div className="slot-blk" key={bl.key}>
            <span className="slot-blk-lab">{slotFmt(bl.startMin)}</span>
            <div className="slot-blk-cells">
              {subs.map((s) => {
                const st = stateOf(s);
                const free = isFree(st);
                const m = slotToMin(s);
                const plan = !!value && (s === planStart || s === planEnd);
                const planBuf = !!value && bufferMin > 0 && m >= bufFrom && m < bufTo;
                return (
                  <button key={s} type="button"
                    className={"slot"
                      + (value === s ? " sel" : "")
                      + (plan ? " plan" : "")
                      + (!plan && planBuf ? " planbuf" : "")
                      + (!free ? " taken" : "")
                      + (st === "tight" ? " tight" : "")
                      + (st === "offsched" ? " offsched" : "")
                      + (st === "break" ? " brk" : "")
                      + (st === "buffer" ? " busybuf" : "")
                      + ((st === "busy" || st === "blocked") ? " busy" : "")}
                    disabled={!free} onClick={() => onChange(s)}
                    title={titleOf ? titleOf(s, st) : s}
                    /* Стан слота (зайнято/перерва/буфер + інтервал) має бути в
                       ДОСТУПНОМУ імені, а не лише у title= (на тачі тултипа немає,
                       і скрінрідер title не завжди озвучує). */
                    aria-label={titleOf ? titleOf(s, st) : s}>
                    {s.slice(3)}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
