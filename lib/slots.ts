/* ===== RadFlow — сітка слотів запису =====
   Крок вибору слота — 5 хв (SLOT_STEP). Клінічні тривалості досліджень
   лишаються як є (5-хв кратність). Щоб 288/120 слотів не перетворювали сітку
   на кашу, слоти групуються у 30-хв блоки (SLOT_BLOCK) — акордеон у SlotPicker.

   Занятість/перетини рахує БД (check_no_overlap, tstzrange) та room_busy_slots —
   вони поштучні за timestamptz і НЕ залежать від кроку сітки. Тут лише генерація
   кандидатів для UI. */

import { overlapsBreak, type Break } from "./schedule";

export const SLOT_STEP = 5;    // хв — крок вибору слота (раніше 30)
export const SLOT_BLOCK = 30;  // хв — розмір згорнутого блоку акордеона

/** "HH:MM" → хвилини від 00:00. */
export function slotToMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** хвилини від 00:00 → "HH:MM". */
export function slotFmt(min: number): string {
  return String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0");
}

/** Список слотів у [startMin, endMin) з кроком step, вирівняний по кроку. */
export function buildSlots(startMin: number, endMin: number, step: number = SLOT_STEP): string[] {
  const out: string[] = [];
  if (!(endMin > startMin)) return out;
  const s0 = Math.ceil(startMin / step) * step;
  for (let m = s0; m < endMin; m += step) out.push(slotFmt(m));
  return out;
}

/** Скільки ще досліджень поточної тривалості реально вміщується у день.
    Жадібна укладка зліва направо: ставимо запис у найраніший вільний слот,
    далі стрибаємо за його зайнятість (тривалість + буфер). На відміну від
    «к-сті вільних 5-хв позицій» (вони перетинаються і кратно завищують число),
    це та цифра, яка потрібна реєстратурі. */
export function countFit(
  slots: string[],
  isFreeSlot: (slot: string) => boolean,
  occMin: number
): number {
  if (!slots.length || occMin <= 0) return 0;
  let count = 0;
  let nextFreeMin = -1;
  for (const s of slots) {
    const m = slotToMin(s);
    if (m < nextFreeMin) continue;   // ще всередині щойно «поставленого» запису
    if (!isFreeSlot(s)) continue;
    count++;
    nextFreeMin = m + occMin;        // наступний запис — не раніше кінця цього + буфер
  }
  return count;
}

export interface BusySpan { s: number; e: number } // хв доби: зайнятість кабінету (уже з буфером)

/** Найраніша 5-хв позиція ≥ fromMin, куди запис влазить ЦІЛКОМ:
      • саме дослідження (durMin) до кінця графіка і не в перерву;
      • дослідження + буфер (occupancy) не перетинає жодну зайнятість кабінету.
    Використовується панеллю колізій: коли дослідження затягнулося, наступний
    запис їде не «на дельту», а в перший слот, де він нікого не зачепить — тому
    каскад не виникає за побудовою. null — до кінця графіка вже не влазить
    (тоді рішення одне: обзвін). busy має приходити з room_busy_slots (RPC уже
    рахує окупацію in_progress від фактичного старту — міграція 0060). */
export function firstFittingSlot(opts: {
  fromMin: number;
  durMin: number;
  bufferMin: number;
  schedStartMin: number;
  schedEndMin: number;
  busy: BusySpan[];
  breaks?: Break[];
  step?: number;
}): string | null {
  const { fromMin, durMin, schedStartMin, schedEndMin, busy } = opts;
  const breaks = opts.breaks || [];
  const step = Math.max(1, opts.step ?? SLOT_STEP);              // 0 → нескінченний цикл
  const buffer = Math.max(0, Number(opts.bufferMin) || 0);       // NaN мовчки пропустив би зайнятість
  if (!(durMin > 0) || !(schedEndMin > schedStartMin)) return null;
  const from = Math.max(fromMin, schedStartMin);
  for (let s = Math.ceil(from / step) * step; s + durMin <= schedEndMin; s += step) {
    if (overlapsBreak(s, durMin, breaks)) continue;
    const occEnd = s + durMin + buffer;
    if (busy.some((b) => s < b.e && b.s < occEnd)) continue;
    return slotFmt(s);
  }
  return null;
}

export interface SlotBlock {
  key: number;       // startMin блоку (для React key/стану)
  startMin: number;  // початок 30-хв блоку
  endMin: number;    // кінець 30-хв блоку
  label: string;     // "HH:MM–HH:MM"
  slots: string[];   // 5-хв слоти всередині
}

/** Згрупувати 5-хв слоти у 30-хв блоки для акордеона. */
export function groupSlots(slots: string[], block: number = SLOT_BLOCK): SlotBlock[] {
  const map = new Map<number, string[]>();
  for (const s of slots) {
    const k = Math.floor(slotToMin(s) / block) * block;
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(s);
  }
  return Array.from(map.keys())
    .sort((a, b) => a - b)
    .map((k) => ({ key: k, startMin: k, endMin: k + block, label: slotFmt(k) + "–" + slotFmt(k + block), slots: map.get(k)! }));
}
