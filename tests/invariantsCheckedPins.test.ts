/* Число перевірок `invariants_check` продубльоване у ДЕВʼЯТИ смоуках.
 *
 * Історія, через яку цей сторож зʼявився (с49): 0159 підняв 11 → 12 і оновив
 * свої смоуки; 0161 підняв 12 → 13 і оновив ЛИШЕ свій — пʼять чужих лишились
 * із «очікував 12» і мовчки червоніли місяцями. 0164 підняв 13 → 14 і зробив
 * би шостим; 0166 підняв 14 → 15 (priv_drift) і додав девʼятий смоук.
 * Ловити це має не пильність, а тест.
 *
 * Джерело істини — ОСТАННЯ міграція, що передруковує `invariants_check`
 * (у ній рахуємо кроки `v_n := v_n + 1;`), а не константа в цьому файлі:
 * інакше сторож треба було б правити тим самим рухом, що й смоуки, і він
 * знову нічого б не ловив.
 *
 * ⚠️ с49, ревʼю пакета привілеїв: перша версія цього файлу знала РІВНО ОДНУ
 *    форму піна — `is distinct from N` — і рівно одну форму тексту —
 *    «очікував N» на рядку зі словом `checked`. Тому:
 *      • `change_markers_purge_smoke` («…дає % перевірок замість 15») мав
 *        текст поза наглядом — він міг брехати роками;
 *      • `room_busy_slots_scope_smoke` мав у шапці «checked = 12 (0159)» —
 *        стару неправду, яку ніхто не ловив;
 *      • пін, написаний через `<>` чи `!=`, став би НЕВИДИМИМ, і сторож
 *        мовчки лишився б без роботи — рівно та поломка, від якої він тут.
 *    Звідси три канали нижче: assert / message (вікно після асерта) / text
 *    (будь-який рядок зі словом `checked`).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const MIGDIR = resolve(process.cwd(), "supabase/migrations");
const SMOKEDIR = resolve(process.cwd(), "supabase/smoke");

/** Асерт-форма піна: `(v_x ->> 'checked')::int <порівняння> N`. */
const ASSERT = /'checked'\s*\)\s*::\s*int\s*(?:is\s+distinct\s+from|<>|!=)\s*(\d+)/g;
/** Текстова форма: «очікував(и) N», «замість N», «checked = N». */
const CLAIM = /(?:очікував(?:и)?|замість)\s+(\d+)|checked\s*=\s*(\d+)/g;

type Pin = { file: string; num: number; kind: string; line: number };

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

/** Усі піни числа перевірок у смоуках. */
function pinsInSmokes(): Pin[] {
  const out: Pin[] = [];
  for (const f of readdirSync(SMOKEDIR).filter((x) => x.endsWith(".sql"))) {
    const txt = readFileSync(resolve(SMOKEDIR, f), "utf8");
    const lineOf = (idx: number) => txt.slice(0, idx).split("\n").length;

    for (const m of txt.matchAll(ASSERT)) {
      const at = m.index ?? 0;
      out.push({ file: f, num: Number(m[1]), kind: "assert", line: lineOf(at) });
      /* Текст повідомлення бреше окремо від коду (спіймано в с49 — у трьох
         файлах асерт уже казав 14, а текст усе ще «очікував 12»). Читаємо
         вікно від асерта до кінця цього `if` — там і живе `raise`. */
      const from = at + m[0].length;
      const stop = txt.indexOf("end if;", from);
      const win = txt.slice(from, stop < 0 ? from + 400 : stop);
      for (const c of win.matchAll(CLAIM)) {
        out.push({
          file: f,
          num: Number(c[1] ?? c[2]),
          kind: "message",
          line: lineOf(from + (c.index ?? 0)),
        });
      }
    }

    /* Незалежний канал: будь-який рядок, що згадує `checked`, не має брехати
       числом — навіть коментар у шапці. Обмеження саме на такі рядки не
       випадкове: «очікував N» у смоуках трапляється і про зовсім інші числа
       (migration_ledger_smoke рахує міграції) — перша версія регулярки
       згребла їх усі й дала 17 хибних порушників. */
    txt.split(/\r?\n/).forEach((line, i) => {
      if (!line.includes("checked")) return;
      for (const c of line.matchAll(CLAIM)) {
        out.push({ file: f, num: Number(c[1] ?? c[2]), kind: "text", line: i + 1 });
      }
    });
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
      .toBeGreaterThanOrEqual(18);
    const wrong = pins
      .filter((p) => p.num !== latest.n)
      .map((p) => `${p.file}:${p.line}[${p.kind}]=${p.num}`)
      .sort();
    expect(wrong, `сторож дає ${latest.n} (${latest.file}), а смоуки кажуть інше`)
      .toEqual([]);
  });

  it("кожен смоук, що читає ключ 'checked', має асерт у формі, яку ми розбираємо", () => {
    /* Без цього кроку пін, написаний невідомою формою, просто зник би зі
       списку — і сторож лишився б зеленим, наглядаючи за порожнечею. */
    const pins = pinsInSmokes();
    const withAssert = new Set(pins.filter((p) => p.kind === "assert").map((p) => p.file));
    const readers = readdirSync(SMOKEDIR)
      .filter((x) => x.endsWith(".sql"))
      .filter((x) => readFileSync(resolve(SMOKEDIR, x), "utf8").includes("'checked'"));

    expect(readers.length, "жоден смоук не читає 'checked' — зламався пошук")
      .toBeGreaterThanOrEqual(9);
    expect(
      readers.filter((f) => !withAssert.has(f)).sort(),
      "смоук читає 'checked', але пін не в жодній із відомих форм " +
        "(is distinct from / <> / !=) — його число поза наглядом",
    ).toEqual([]);
  });
});
