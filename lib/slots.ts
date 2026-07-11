/* ===== RadFlow — сітка слотів запису =====
   Крок вибору слота — 5 хв (SLOT_STEP). Клінічні тривалості досліджень
   лишаються як є (5-хв кратність). Щоб 288/120 слотів не перетворювали сітку
   на кашу, слоти групуються у 30-хв блоки (SLOT_BLOCK) — акордеон у SlotPicker.

   Занятість/перетини рахує БД (check_no_overlap, tstzrange) та room_busy_slots —
   вони поштучні за timestamptz і НЕ залежать від кроку сітки. Тут лише генерація
   кандидатів для UI. */

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
