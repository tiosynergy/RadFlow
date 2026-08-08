/* ===== Зайнятість слота кабінету (lib/slotOccupancy.ts) =====

   Головний інваріант продукту: критерій «слот зайнятий» у прикладному коді мусить
   збігатися з критерієм у БД. Розсинхрон дає «зелений, але незаписуваний слот» —
   сітка малює час вільним, а тригер відхиляє бронь.

   Саме це знайшов зовнішній аудит 2026-08-07 (H-2a): міграція 0079 додала
   `needs_reschedule` у скіп-листи `check_no_overlap` і `room_busy_slots`, а
   серверний гейт `hasSlotClash` лишився зі старим списком із трьох статусів.
   Ламався головний сценарій каскаду: план затримки → `needs_reschedule` →
   реєстратура садить у звільнений слот іншого пацієнта → «Слот зайнятий».

   Тому тут два види перевірок:
     1) поведінка `slotClashIn` (зокрема: рядок `needs_reschedule` слот НЕ займає);
     2) КОНТРАКТ із SQL — список статусів звіряється з ОСТАННІМ визначенням
        `check_no_overlap` і `room_busy_slots` по всіх міграціях, і з тим, що
        app/queue/actions.ts більше не тримає власних літералів. */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  SLOT_FREE_STATUSES,
  occupiesSlot,
  slotWindowOf,
  slotClashIn,
  type SlotRow,
} from "@/lib/slotOccupancy";
import { wallInstant } from "@/lib/incidents";

const DAY = "2026-08-10";
const row = (over: Partial<SlotRow> & { id: string }): SlotRow => ({
  status: "scheduled",
  scheduled_date: DAY,
  scheduled_time: "10:00",
  duration_min: 30,
  buffer_time_min: 5,
  in_progress_at: null,
  ...over,
});

/** Вікно нового запису: DAY 10:00, 30 хв + 5 хв буфера. */
const startMs = wallInstant(DAY, "10:00");
const endMs = startMs + 35 * 60000;

describe("occupiesSlot — статусний критерій", () => {
  it("живі статуси займають слот", () => {
    ["scheduled", "waiting", "in_progress", "done"].forEach((s) =>
      expect(occupiesSlot(s)).toBe(true)
    );
  });
  it("термінальні й needs_reschedule — не займають", () => {
    SLOT_FREE_STATUSES.forEach((s) => expect(occupiesSlot(s)).toBe(false));
  });
  it("`done` НЕ у списку вільних: поверх завершеного запису час зайнятий", () => {
    expect(SLOT_FREE_STATUSES).not.toContain("done");
  });
});

describe("slotClashIn — перетин вікон", () => {
  it("той самий час, статус scheduled → колізія", () => {
    expect(slotClashIn([row({ id: "a" })], startMs, endMs)).toBe(true);
  });

  /* ГОЛОВНИЙ тест H-2a. */
  it("needs_reschedule ЗВІЛЬНЯЄ слот (0079)", () => {
    expect(slotClashIn([row({ id: "a", status: "needs_reschedule" })], startMs, endMs)).toBe(false);
  });

  it("каскад затримки: усі записи години в needs_reschedule → година вільна", () => {
    const cascade = ["10:00", "10:35", "11:10"].map((t, i) =>
      row({ id: "c" + i, status: "needs_reschedule", scheduled_time: t })
    );
    expect(slotClashIn(cascade, startMs, endMs)).toBe(false);
    // …а варто одному повернутись у scheduled — слот знову зайнятий.
    cascade[0].status = "scheduled";
    expect(slotClashIn(cascade, startMs, endMs)).toBe(true);
  });

  it("решта вільних статусів слот теж не тримають", () => {
    SLOT_FREE_STATUSES.forEach((s) =>
      expect(slotClashIn([row({ id: "a", status: s })], startMs, endMs)).toBe(false)
    );
  });

  it("excludeId: власний рядок при редагуванні не конфліктує сам із собою", () => {
    expect(slotClashIn([row({ id: "self" })], startMs, endMs, { excludeId: "self" })).toBe(false);
  });

  it("сусідні вікна впритул не перетинаються (кінець = початок)", () => {
    // Попередній: 09:20 + 35 хв = рівно 09:55… а наш старт 10:00 → вільно.
    expect(slotClashIn([row({ id: "a", scheduled_time: "09:20" })], startMs, endMs)).toBe(false);
    // 09:30 + 35 = 10:05 → залазить у наше вікно.
    expect(slotClashIn([row({ id: "b", scheduled_time: "09:30" })], startMs, endMs)).toBe(true);
  });

  it("буфер прибирання враховується як зайнятий час", () => {
    // 09:25 + 30 хв = 09:55 (без буфера — вільно), + 5 хв буфера = 10:00 → теж вільно;
    // а з буфером 15 хв кінець 10:10 → колізія.
    expect(slotClashIn([row({ id: "a", scheduled_time: "09:25", buffer_time_min: 5 })], startMs, endMs)).toBe(false);
    expect(slotClashIn([row({ id: "b", scheduled_time: "09:25", buffer_time_min: 15 })], startMs, endMs)).toBe(true);
  });

  it("in_progress рахується від ФАКТИЧНОГО старту, а не від scheduled_time", () => {
    // Записаний на вчора о 08:00, але заведений у кабінет сьогодні о 09:50.
    const late = row({
      id: "late",
      status: "in_progress",
      scheduled_date: "2026-08-09",
      scheduled_time: "08:00",
      in_progress_at: DAY + "T09:50:00.000Z",
    });
    expect(slotClashIn([late], startMs, endMs, { tz: "UTC" })).toBe(true);
    // Той самий рядок, але вже завершений учора о 08:00 — сьогоднішнє вікно вільне.
    expect(
      slotClashIn([{ ...late, status: "done", in_progress_at: null }], startMs, endMs, { tz: "UTC" })
    ).toBe(false);
  });

  it("рядок без duration_min ігнорується (порахувати вікно нема з чого)", () => {
    expect(slotWindowOf(row({ id: "a", duration_min: null }))).toBeNull();
    expect(slotClashIn([row({ id: "a", duration_min: null })], startMs, endMs)).toBe(false);
  });

  it("порожня вибірка — колізій немає", () => {
    expect(slotClashIn([], startMs, endMs)).toBe(false);
  });
});

/* ── Контракт із БД ─────────────────────────────────────────────────────────
   Якби ці перевірки існували в сесії 0079, дефект H-2a не дожив би до коміту.

   ⚠️ Читаємо НЕ файл 0079, а ОСТАННЄ визначення функції по ВСІХ міграціях
   (ревʼю пакета, р.1). Міграції незмінні: тест, прибитий до 0079, лишався б
   зеленим після того, як 0135+ переозначила б функцію з іншим списком — тобто
   саме той дрейф, який він нібито ловить, і пройшов би повз. */
const MIG_DIR = join(process.cwd(), "supabase", "migrations");

/** Прибрати SQL-коментарі: інакше `-- раніше було: status not in (...)` у тілі
    функції (а стиль проєкту — писати діф до попередньої редакції) дав би
    ложно-КРАСНИЙ контракт (ревʼю р.2). */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * Тіло ОСТАННЬОГО оголошення функції `public.<name>` серед усіх міграцій.
 *
 * ⚠️ Три пастки, на які цей парсер уже наступав (ревʼю р.2):
 *  1) шукати тільки `create or replace` — мало: `room_busy_slots` двічі міняла
 *     сигнатуру і перевизначалась парою `drop function` + `create function`
 *     (0062, 0074). Тому `create (or replace )?function`.
 *  2) `name` без `(` матчить і `check_no_overlap_v2` — перевірявся б не той обʼєкт.
 *  3) тіло не завжди в `$$`: свіжі міграції (0103+) пишуть `$function$`, як
 *     віддає pg_get_functiondef. Долар-тег читаємо з самого заголовка.
 */
function lastFunctionBody(name: string): { file: string; body: string } {
  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
  const head = new RegExp("create\\s+(?:or\\s+replace\\s+)?function\\s+public\\." + name + "\\s*\\(", "gi");
  let hit: { file: string; body: string } | null = null;
  for (const f of files) {
    const sql = readFileSync(join(MIG_DIR, f), "utf8");
    let at = -1;
    for (const m of sql.matchAll(head)) at = m.index ?? at;
    if (at === -1) continue;
    const tag = /\$([A-Za-z_]*)\$/.exec(sql.slice(at));
    if (!tag) throw new Error("Не знайшов долар-тег тіла " + name + " у " + f);
    const open = at + (tag.index ?? 0) + tag[0].length;
    const close = sql.indexOf(tag[0], open);
    if (close === -1) throw new Error("Не знайшов закриття " + tag[0] + " для " + name + " у " + f);
    hit = { file: f, body: stripSqlComments(sql.slice(open, close)) };
  }
  if (!hit) throw new Error("Функцію " + name + " не знайдено в жодній міграції");
  return hit;
}

/** Множина статусів із кожного `… status not in (...)` у тілі функції. */
function skipListsIn(body: string): string[][] {
  const out: string[][] = [];
  const re = /\bstatus\s+not\s+in\s*\(([^)]*)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    out.push(
      m[1]
        .split(",")
        .map((x) => x.trim().replace(/^'|'$/g, ""))
        .filter(Boolean)
        .sort()
    );
  }
  return out;
}

const sorted = [...SLOT_FREE_STATUSES].sort();

describe("контракт: скіп-лист статусів збігається з БД", () => {
  /* check_no_overlap рахує СУСІДІВ по цьому списку; окремий, ПʼЯТИЕЛЕМЕНТНИЙ
     список (`new.status in (…, 'done', …)`) — це гейт «чи бронює сам новий рядок»,
     і він навмисно інший. Тому перевіряємо саме `... status not in (...)`. */
  it("check_no_overlap: список сусідів дослівно = SLOT_FREE_STATUSES", () => {
    const { file, body } = lastFunctionBody("check_no_overlap");
    const lists = skipListsIn(body);
    expect(lists.length, "у " + file + " не знайдено жодного `status not in (...)`").toBeGreaterThan(0);
    lists.forEach((l) => expect(l, "розбіжність у " + file).toEqual(sorted));
  });

  it("room_busy_slots: сітка занятості звільняє рівно ті самі статуси", () => {
    const { file, body } = lastFunctionBody("room_busy_slots");
    const lists = skipListsIn(body);
    expect(lists.length, "у " + file + " не знайдено жодного `status not in (...)`").toBeGreaterThan(0);
    lists.forEach((l) => expect(l, "розбіжність у " + file).toEqual(sorted));
  });

  it("гейт «новий рядок» = SLOT_FREE_STATUSES + `done`, і це не помилка", () => {
    /* Два різні питання в одній функції, і плутати їх не можна:
         `new.status in (…)`  — «чи бронює слот САМ новий рядок» (тут є `done`:
                                завершене дослідження нікого не витісняє);
         `q.status not in (…)`— «які СУСІДИ займають час» (тут `done` немає:
                                поверх завершеного о 10:00 другого не садимо).
       Перевіряємо перший список ТОЧНО, а не підрядком `'done'` (ревʼю р.2):
       підрядок проходив би від будь-якої згадки в тілі. */
    const { file, body } = lastFunctionBody("check_no_overlap");
    const lists: string[][] = [];
    const re = /(?<!not\s)\bstatus\s+in\s*\(([^)]*)\)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      lists.push(m[1].split(",").map((x) => x.trim().replace(/^'|'$/g, "")).filter(Boolean).sort());
    }
    const want = [...SLOT_FREE_STATUSES, "done"].sort();
    expect(lists.length, "у " + file + " не знайдено `new.status in (...)`").toBeGreaterThan(0);
    lists.forEach((l) => expect(l, "гейт «новий рядок» у " + file + " розійшовся").toEqual(want));
  });

  it("hasSlotClash не тримає власних літералів статусів", () => {
    const body = hasSlotClashBody();
    expect(body).toContain("SLOT_FREE_STATUSES");
    /* ⚠️ Перевіряємо СЛОВО, а не рядок у лапках (ревʼю р.2): точний повтор H-2a
       виглядає як `.not("status","in","(cancelled,no_show,not_held)")` — лапка
       там стоїть перед дужкою, тож `toContain('"cancelled"')` його не бачив, а
       `toContain("SLOT_FREE_STATUSES")` проходив із сусіднього КОМЕНТАРЯ.
       Тобто тест, написаний рівно проти H-2a, пропускав H-2a.
       Коментарі й сам рядок із назвою константи з тіла прибираємо. */
    const code = body
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ")
      .replace(/SLOT_FREE_STATUSES[^\n]*/g, " ");
    SLOT_FREE_STATUSES.forEach((st) =>
      expect(code, "статус " + st + " зашитий літералом").not.toMatch(new RegExp("\\b" + st + "\\b"))
    );
  });

  it("hasSlotClash повертає третій стан на помилці вибірки (fail-CLOSED, H-2b)", () => {
    const body = hasSlotClashBody();
    expect(body).toContain("if (error)");
    expect(body).toContain("ok: false");
  });
});

/** Тіло hasSlotClash як текст (межі функції перевіряємо явно, а не slice(0,-1)). */
function hasSlotClashBody(): string {
  const src = readFileSync(join(process.cwd(), "app", "queue", "actions.ts"), "utf8");
  const at = src.indexOf("async function hasSlotClash");
  expect(at, "hasSlotClash не знайдено — тест застарів").toBeGreaterThan(-1);
  const end = src.indexOf("\n}\n", at);
  expect(end, "не знайдено кінець тіла hasSlotClash").toBeGreaterThan(at);
  return src.slice(at, end);
}
