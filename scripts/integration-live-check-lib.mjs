/* RadFlow — чиста логіка звірки busy у live-check (урок C-2 аудиту 23.08).

   У с36 живий прогін давав 39/39 LIVE_OK, а /slots публікував зайняті слоти
   як вільні: RPC room_busy_slots під service_role віддавав 0 рядків. Зонди
   перевіряли ФОРМУ відповіді (200, є days[]), а не ЗМІСТ. Тут — дзеркало
   lib/integrationContract.ts (busyRowsToIntervals + fmt) на чистому JS,
   щоб live-check міг звірити busy з роуту з рядками RPC, отриманими тим
   самим контекстом (service_role). Дублювання свідоме: .mjs не імпортує TS,
   а тест tests/liveCheck.test.ts тримає обидві копії в одному ряду.

   Канон Node-скриптів проєкту: типи — через JSDoc. */

/** @typedef {{ s: number, e: number }} Interval */

/** Обʼєднання інтервалів (перетин або дотик → один). Дзеркало mergeIntervals.
    @param {Interval[]} list @returns {Interval[]} */
export function mergeIntervals(list) {
  const sorted = list.filter((i) => i.e > i.s).slice().sort((a, b) => a.s - b.s);
  /** @type {Interval[]} */
  const out = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.s <= last.e) last.e = Math.max(last.e, cur.e);
    else out.push({ ...cur });
  }
  return out;
}

/** Рядки room_busy_slots → обʼєднані інтервали (хвилини доби). Дзеркало
    busyRowsToIntervals: start_min/end_min — джерело правди (0074), fallback
    на старий контракт БЕЗ дефолтів «|| 30».
    @param {Array<{start_min?: number|null, end_min?: number|null, scheduled_time?: string|null,
                   duration_min?: number|null, buffer_time_min?: number|null}>} rows
    @returns {Interval[]} */
export function busyRowsToIntervals(rows) {
  const toMin = (t) => {
    const p = String(t).split(":");
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  };
  return mergeIntervals((rows || []).flatMap((r) => {
    if (r.start_min != null && r.end_min != null) return [{ s: r.start_min, e: r.end_min }];
    if (!r.scheduled_time) return [];
    const s = toMin(r.scheduled_time);
    return [{ s, e: s + (r.duration_min ?? 0) + (r.buffer_time_min ?? 0) }];
  }));
}

/** Хвилини доби → "HH:MM" (1440 → "24:00", як у роуті). @param {number} m */
export function minToHHMM(m) {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Інтервали → форма роуту {start, end}. @param {Interval[]} list */
export function fmtIntervals(list) {
  return list.map((i) => ({ start: minToHHMM(i.s), end: minToHHMM(i.e) }));
}

/** Порівняння busy роуту з очікуваним: той самий набір пар start/end у тому
    самому порядку (роут віддає merged-інтервали відсортованими).
    @param {Array<{start: string, end: string}>} api
    @param {Array<{start: string, end: string}>} expected
    @returns {{ok: boolean, note: string}} */
export function compareBusy(api, expected) {
  const key = (l) => (l || []).map((i) => `${i.start}-${i.end}`).join(",");
  const a = key(api), b = key(expected);
  if (a === b) return { ok: true, note: `${expected.length} інтервал(ів): ${b || "порожньо"}` };
  return { ok: false, note: `роут [${a || "порожньо"}] ≠ БД [${b || "порожньо"}]` };
}

/** Дні кабінету за спаданням зайнятості (ties — пізніша дата перша): рядки
    queue_entries з scheduled_date. Для вибору дня, на якому звірка не буде
    вакуумною. @param {Array<{scheduled_date: string|null}>} rows @returns {string[]} */
export function busiestDays(rows) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const r of rows || []) {
    if (!r.scheduled_date) continue;
    counts.set(r.scheduled_date, (counts.get(r.scheduled_date) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((x, y) => y[1] - x[1] || (y[0] < x[0] ? -1 : y[0] > x[0] ? 1 : 0))
    .map(([d]) => d);
}
