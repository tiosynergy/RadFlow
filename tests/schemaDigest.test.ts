/**
 * Піни перевірки №23 `schema_digest` (міграція 0185).
 *
 * ⚠️ ПІНИМО МІГРАЦІЮ, А НЕ ФРАГМЕНТ. У прод їде саме вона; фрагмент
 *    `scripts/frag/0185_check23.sql` — вхід генератора. Окремий тест нижче
 *    вимагає, щоб фрагмент був ДОСЛІВНОЮ частиною міграції, інакше правка
 *    фрагмента мовчки розійшлась би з тим, що накатано.
 *
 * ⚠️ ПІНИ ПО МІСЦЮ, А НЕ ПО ПРИСУТНОСТІ. Урок с61: стенд лишався зеленим,
 *    бо шуканий рядок жив ще й у смоуку тієї ж міграції. Тому кожен пін
 *    береться зі ЗРІЗУ конкретного CTE, а не з усього файла.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const MIG = readFileSync("supabase/migrations/0185_schema_digest.sql", "utf8");
const FRAG = readFileSync("scripts/frag/0185_check23.sql", "utf8");

/** Зріз гілки №23 — від її заголовка до закриття блока. */
function branch(): string {
  // ⚠️ Кінець зрізу — за збіркою результату, а НЕ за рядком-закриттям
  //    обгортки: маркер риштувань спільний для ВСІХ перевірок (конвенція
  //    0174), тож шукати по ньому означало б зупинитись на чужому кінці.
  // ⚠️ І коментар тут РЯДКОВИЙ свідомо: JS-блок-коментарі НЕ вкладаються,
  //    і згадка маркера всередині `/*…*/` закрила б коментар достроково —
  //    саме так перша редакція цього рядка розвалила весь файл (TS1127).
  const a = MIG.indexOf("  -- 23. ФОРМА СХЕМИ");
  const b = MIG.indexOf("  v_res := jsonb_build_object(", a);
  if (a < 0 || b < 0) throw new Error("гілку №23 не знайдено в 0185 — піни нижче безпредметні");
  return MIG.slice(a, b);
}

/**
 * Зріз одного CTE `<name> [(cols)] as ( … )` з балансуванням дужок.
 * ⚠️ Список колонок у дужках ОБОВʼЯЗКОВИЙ у патерні: `expd(key, dig) as (values …)`
 *    оголошено саме так, і перша редакція цього хелпера його не бачила —
 *    тест упав на збірці describe, тобто ГУЧНО. Мовчазний варіант («не
 *    знайшли — пропустили пін») був би гіршим за відсутній тест.
 */
function cte(text: string, name: string): string {
  /* ⚠️ `with` у переліку роздільників теж обовʼязковий: ПЕРШИЙ CTE (`tabs`)
     стоїть після `with`, а не після `(` чи `,`. Друга редакція цього хелпера
     його не бачила і пін по `tabs` мовчки шукав не там. */
  const m = text.match(new RegExp(`(?:[(,]|\\bwith)\\s*${name}\\s*(?:\\([^)]*\\))?\\s+as\\s*\\(`));
  if (!m || m.index === undefined) throw new Error(`CTE ${name} не знайдено`);
  let i = m.index + m[0].length;
  let depth = 1;
  let out = "";
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) break; }
    out += ch;
    i++;
  }
  if (depth !== 0) throw new Error(`CTE ${name}: дужки не збалансовані`);
  return out;
}

const B = branch();

describe("0185 №23 schema_digest — форма гілки", () => {
  it("фрагмент є ДОСЛІВНОЮ частиною міграції (генератор не розійшовся з входом)", () => {
    const f = FRAG.replace(/\r\n/g, "\n").replace(/\n$/, "");
    expect(MIG.replace(/\r\n/g, "\n")).toContain(f);
  });

  it("колонки сортуються по attnum, а НЕ по тексту рядка", () => {
    /* Сортування по тексту дало б ТОЙ САМИЙ дайджест на `drop column note` +
       `add column note text` — тобто знищення даних лишилось би зеленим. */
    const c = cte(B, "colagg");
    expect(c).toContain("string_agg(line, ',' order by attnum)");
    expect(c).not.toContain("order by line");
  });

  it("рядок колонки несе тип, NOT NULL, DEFAULT, identity і generated", () => {
    const c = cte(B, "col");
    expect(c).toContain("format_type(a.atttypid, a.atttypmod)");
    expect(c).toContain("a.attnotnull");
    expect(c).toContain("pg_get_expr(d.adbin, d.adrelid)");
    expect(c).toContain("a.attidentity::text");
    expect(c).toContain("a.attgenerated::text");
  });

  it("гілка enum існує і сортує мітки по enumsortorder", () => {
    /* Без цієї гілки `alter type queue_status add value` проходив МОВЧКИ:
       `format_type` віддає лише імʼя типу, а `pg_enum` не читав ніхто. */
    const c = cte(B, "enu");
    expect(c).toContain("pg_enum");
    expect(c).toContain("order by e.enumsortorder");
  });

  it("гілка унікальних індексів існує і ВИКЛЮЧАЄ ті, що підпирають constraint", () => {
    /* Частковий унікальний індекс НЕ може бути constraint-ом, тому гілка `k:`
       його не бачить ніколи — а це сам бізнес-інваріант (0017/0018). */
    const c = cte(B, "idx");
    expect(c).toContain("i.indisunique");
    expect(c).toContain("pg_get_indexdef(i.indexrelid)");
    expect(c).toContain("c.conindid = i.indexrelid");
  });

  it("охоплені relkind r,v,m,p,f — секційна таблиця чи matview не зникає мовчки", () => {
    const c = cte(B, "tabs");
    expect(c).toContain("c.relkind in ('r', 'v', 'm', 'p', 'f')");
  });

  it("cur склеює РІВНО чотири джерела", () => {
    const c = cte(B, "cur");
    for (const src of ["colagg", "konagg", "enu", "idxagg"]) expect(c).toContain(src);
    expect((c.match(/union all/g) || []).length).toBe(3);
  });

  it("offenders мають усі три префікси", () => {
    for (const p of ["'changed:'", "'new:'", "'missing:'"]) expect(B).toContain(p);
  });

  it("обробник винятку НЕ глотає помилку, а пише raised: у offenders", () => {
    /* Той самий клас, що борг «fn_audit глотає БУДЬ-ЯКУ помилку»: мовчазний
       обробник перетворив би зламану перевірку на зелену. */
    expect(B).toContain("'raised:' || sqlstate");
    expect(B).not.toMatch(/exception\s+when\s+others\s+then\s+null/);
  });
});

describe("0185 №23 — набір пінів expd", () => {
  const expd = cte(B, "expd");
  const keys = [...expd.matchAll(/\('([a-z]:[a-z0-9_]+)','(\d+):([0-9a-f]{12})'\)/g)].map((m) => m[1]);

  it("рівно 84 ключі, і всі різні", () => {
    expect(keys.length).toBe(84);
    expect(new Set(keys).size).toBe(84);
  });

  it("розклад по префіксах: 33 t: + 1 v: + 33 k: + 10 e: + 7 u:", () => {
    const by = (p: string) => keys.filter((k) => k.startsWith(p)).length;
    expect({ t: by("t:"), v: by("v:"), k: by("k:"), e: by("e:"), u: by("u:") })
      .toEqual({ t: 33, v: 1, k: 33, e: 10, u: 7 });
  });

  it("ключі відсортовані — інакше наступний передрук дасть шумний diff", () => {
    expect(keys).toEqual([...keys].sort());
  });

  it("названі в шапці enum-и справді запінені", () => {
    for (const e of ["e:queue_status", "e:user_role"]) expect(keys).toContain(e);
  });

  it("названі в шапці бізнес-інваріанти-індекси справді запінені", () => {
    for (const u of ["u:queue_entries", "u:incidents"]) expect(keys).toContain(u);
  });
});

describe("0185 — обвʼязка міграції", () => {
  it("передрук наосліп заборонено: є асерт тіла 0184 ДО правки", () => {
    expect(MIG).toContain("передрук наосліп заборонено");
    expect(MIG).toContain("'11a297318da068f53b113c3d9120e6b8'");
  });

  it("пост-асерт вимагає checked = 23", () => {
    expect(MIG).toMatch(/\(v ->> 'checked'\)::int <> 23/);
  });

  it("пошук функції звужено сигнатурою — перегрузка не зробить асерт брехливим", () => {
    expect(MIG).toContain("pg_get_function_identity_arguments(p.oid) = 'p_write boolean'");
  });

  it("самореєстрація — ОСТАННІЙ statement перед commit (канон 0142)", () => {
    const ins = MIG.lastIndexOf("insert into public.migration_ledger");
    const com = MIG.indexOf("\ncommit;", ins);
    expect(ins).toBeGreaterThan(0);
    expect(com).toBeGreaterThan(ins);
    expect(MIG.slice(ins, com)).not.toMatch(/^\s*(do|create|alter|update|delete)\b/im);
  });
});
