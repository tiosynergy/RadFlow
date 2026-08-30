/* Число перевірок `invariants_check` продубльоване у ВОСЬМИ смоуках.
 *
 * Історія, через яку цей сторож зʼявився (с49): 0159 підняв 11 → 12 і оновив
 * свої смоуки; 0161 підняв 12 → 13 і оновив ЛИШЕ свій — пʼять чужих лишились
 * із «очікував 12» і мовчки червоніли місяцями. 0164 підняв 13 → 14 і зробив
 * би шостим. Ловити це має не пильність, а тест.
 *
 * Джерело істини — ОСТАННЯ міграція, що передруковує `invariants_check`
 * (у ній рахуємо кроки `v_n := v_n + 1;`), а не константа в цьому файлі:
 * інакше сторож треба було б правити тим самим рухом, що й смоуки, і він
 * знову нічого б не ловив.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const MIGDIR = resolve(process.cwd(), "supabase/migrations");
const SMOKEDIR = resolve(process.cwd(), "supabase/smoke");

/** Скільки перевірок у найсвіжішому передруку сторожа. */
function checksInLatestReprint(): { n: number; file: string } {
  const files = readdirSync(MIGDIR).filter((f) => f.endsWith(".sql")).sort();
  let best = { n: 0, file: "" };
  for (const f of files) {
    const txt = readFileSync(resolve(MIGDIR, f), "utf8");
    const at = txt.indexOf("create or replace function public.invariants_check");
    if (at < 0) continue;
    const end = txt.indexOf("\n$function$;", at);
    expect(end, `${f}: не знайшли кінець тіла invariants_check`).toBeGreaterThan(at);
    const body = txt.slice(at, end);
    best = { n: (body.match(/v_n := v_n \+ 1;/g) || []).length, file: f };
  }
  return best;
}

/** Усі піни числа перевірок у смоуках: файл → знайдені числа. */
function pinsInSmokes(): Array<{ file: string; num: number; kind: string }> {
  const out: Array<{ file: string; num: number; kind: string }> = [];
  for (const f of readdirSync(SMOKEDIR).filter((x) => x.endsWith(".sql"))) {
    const txt = readFileSync(resolve(SMOKEDIR, f), "utf8");
    /* Форма піна: `(v_x ->> 'checked')::int is distinct from N`. */
    for (const m of txt.matchAll(/'checked'\)::int is distinct from (\d+)/g)) {
      out.push({ file: f, num: Number(m[1]), kind: "assert" });
    }
    /* І текст повідомлення: він бреше окремо від коду (спіймано в с49 —
       у трьох файлах асерт уже казав 14, а текст усе ще «очікував 12»).
       ⚠️ Тільки рядки, де поруч стоїть саме `checked`: «очікував N» у смоуках
       трапляється і про зовсім інші числа (migration_ledger_smoke рахує
       міграції) — перша версія регулярки згребла їх усі й дала 17 хибних
       порушників. */
    for (const line of txt.split(/\r?\n/)) {
      if (!line.includes("checked")) continue;
      const m = line.match(/очікував (\d+)/);
      if (m) out.push({ file: f, num: Number(m[1]), kind: "message" });
    }
  }
  return out;
}

describe("число перевірок invariants_check однакове скрізь", () => {
  const latest = checksInLatestReprint();

  it("остання міграція, що передруковує сторожа, знайдена і рахує перевірки", () => {
    expect(latest.file, "жодна міграція не передруковує invariants_check").not.toBe("");
    /* Антитавтологія: зламаний парсер дав би 0 і всі піни «не збіглись би»
       однаково — тобто тест перестав би відрізняти правду від поломки. */
    expect(latest.n, `${latest.file}: перевірок не знайдено`).toBeGreaterThanOrEqual(10);
  });

  it("кожен пін у смоуках дорівнює цьому числу", () => {
    const pins = pinsInSmokes();
    /* Антитавтологія №2: якби регулярка перестала знаходити піни, тест був би
       зеленим на порожньому списку — рівно те, від чого він і захищає. */
    expect(pins.length, "пінів не знайдено — зламався розбір смоуків")
      .toBeGreaterThanOrEqual(10);
    const wrong = pins
      .filter((p) => p.num !== latest.n)
      .map((p) => `${p.file}[${p.kind}]=${p.num}`)
      .sort();
    expect(wrong, `сторож дає ${latest.n} (${latest.file}), а смоуки кажуть інше`)
      .toEqual([]);
  });
});
