/**
 * Статичний сторож ЗВОРОТНОГО боку ратчета №19 (борг с74-Б2; ритуал №19 в
 * `AGENTS.md`, блок «ЦЕНА РАТЧЕТА №19», пункт 8).
 *
 * ЩО ЛОВИТЬ. Міграція, НОВІША за останній передрук `invariants_check`, чіпає
 * функцію зі списку №19 — тіло (`create or replace`, drop+create, якірна правка
 * через `pg_get_functiondef` за `proname = '…'`), `alter function` (owner,
 * `set`, security, volatility), `grant`/`revoke` на функцію чи на всі функції
 * схеми — і НЕ передруковує сторожа в тому ж файлі. До цього тесту CI цього не
 * бачив: `PINNED` у `guardFnBodiesInvariant.test.ts` тримає ПІДПИСИ, а не md5,
 * гейт звіряє самопін лише з тілом у тому ж файлі — забута перепечатка
 * червонила №19 уже на ПРОДІ, нічним кроном `invariants`.
 *
 * ДЖЕРЕЛО СПИСКУ — рядки №19 з тіла ОСТАННЬОГО передруку (не дубль `PINNED`):
 * саме вони і є «список», а рівність дубля з ними доводить сусідній тест.
 *
 * ⚠️ ЧОГО НЕ ДОВОДИТЬ. Читає ТЕКСТ міграцій, а не виконує SQL: правка через
 *    динамічний SQL зі склеєним імʼям (`execute 'alter function ' || v_name`)
 *    повз нього пройде. Це прийнята межа статичного сторожа; живий рубіж —
 *    сам №19 на проді.
 *
 * ⚠️ `comment on function` свідомо НЕ вважається правкою: коментар не входить
 *    ні в md5 тіла, ні в `attrs` (secdef, vol, owner, lang, cfg, acl).
 *
 * ФАЛЬСИФІКОВАНО разово (с75): тимчасова міграція `0203_zz_probe.sql` з
 * `alter function public.auth_clinic_id() owner to postgres;` — червоне з
 * іменем файлу і функції; без неї — зелене. Стенд не заводиться: `EXPECTED_STANDS`
 * пінить кількість, а властивість одна і проста.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const MIGDIR = resolve(process.cwd(), "supabase/migrations");

const files = readdirSync(MIGDIR).filter((f) => f.endsWith(".sql")).sort();

/** Код без коментарів (обидві форми — урок с66, ревʼю Ф-1), у нижньому регістрі. */
const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .toLowerCase();

/** Останній передрук — той самий пошук, що в `guardFnBodiesInvariant.test.ts`. */
function latestReprint(): { fn: string; file: string } {
  let best = { fn: "", file: "" };
  for (const f of files) {
    const txt = readFileSync(resolve(MIGDIR, f), "utf8");
    const at = txt.search(/^create or replace function public\.invariants_check/m);
    if (at < 0) continue;
    const end = txt.indexOf("\n$function$;", at);
    if (end < 0) throw new Error(`${f}: передрук не закритий "$function$;"`);
    best = { fn: txt.slice(at, end), file: f };
  }
  if (!best.fn) throw new Error("НЕ ЗНАЙДЕНО жодного передруку invariants_check");
  return best;
}

const { fn: SRC, file: REPRINT } = latestReprint();

/** Імена функцій зі списку №19 — з рядків `('sig','md5','attrs')` блоку №19. */
function pinnedNames(): string[] {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  const at = code.indexOf("'check', 'guard_fn_bodies'");
  if (at < 0) throw new Error(`${REPRINT}: у передруку немає мітки guard_fn_bodies`);
  const start = code.lastIndexOf("v_n := v_n + 1;", at);
  if (start < 0) throw new Error(`${REPRINT}: перед міткою №19 немає кроку лічильника`);
  const block = code.slice(start, at);
  const names = new Set<string>();
  for (const m of block.matchAll(/\('([a-z0-9_]+)\([^']*\)','[0-9a-f]{32}','[^']*'\)/g)) names.add(m[1]);
  if (names.size < 40) throw new Error(`${REPRINT}: у блоці №19 лише ${names.size} рядків — виріз зрушив?`);
  return [...names].sort();
}

const NAMES = pinnedNames();
const NEWER = files.filter((f) => f > REPRINT);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Що саме в тексті міграції вважається правкою функції `name`. */
function touches(code: string, name: string): string[] {
  const hits: string[] = [];
  const n = esc(name);
  // create [or replace] / alter / drop [if exists] / grant … on / revoke … on  FUNCTION name(
  for (const m of code.matchAll(new RegExp(`function\\s+(?:if\\s+exists\\s+)?(?:public\\.)?${n}\\s*\\(`, "g"))) {
    const before = code.slice(Math.max(0, m.index! - 40), m.index!);
    if (/comment\s+on\s*$/.test(before)) continue; // коментар — не правка
    hits.push(`function ${name}(…) @${m.index}`);
  }
  // якірна правка через каталог (стиль 0199): proname = 'name' / proname in ('name', …)
  if (new RegExp(`proname\\s*=\\s*'${n}'`).test(code)) hits.push(`proname = '${name}'`);
  if (new RegExp(`proname\\s+in\\s*\\([^)]*'${n}'`).test(code)) hits.push(`proname in (… '${name}' …)`);
  // явний regprocedure на підпис
  if (new RegExp(`'(?:public\\.)?${n}\\([^']*\\)'::regprocedure`).test(code)) hits.push(`'${name}(…)'::regprocedure`);
  return hits;
}

describe(`№19 — зворотний бік ратчета: міграції новіші за ${REPRINT} не чіпають функцій зі списку`, () => {
  it("список №19 прочитано з останнього передруку", () => {
    expect(NAMES.length).toBeGreaterThanOrEqual(40);
    expect(NAMES).toContain("auth_clinic_id");
    expect(NAMES).toContain("fn_audit");
  });

  it("новіші міграції (після останнього передруку) визначено детерміновано", () => {
    for (const f of NEWER) expect(f > REPRINT).toBe(true);
    expect(files.includes(REPRINT)).toBe(true);
  });

  it("жодна новіша міграція не чіпає функцію зі списку №19 без передруку сторожа", () => {
    const offenders: string[] = [];
    for (const f of NEWER) {
      const code = codeOf(readFileSync(resolve(MIGDIR, f), "utf8"));
      // гранти на ВСІ функції схеми міняють acl кожного рядка списку
      if (/on\s+all\s+functions\s+in\s+schema\s+public/.test(code)) {
        offenders.push(`${f}: grant/revoke on all functions in schema public`);
      }
      for (const name of NAMES) {
        const hits = touches(code, name);
        if (hits.length) offenders.push(`${f}: ${hits.join("; ")}`);
      }
    }
    expect(
      offenders,
      `Міграція новіша за ${REPRINT} чіпає функцію зі списку №19 — сторожа треба ` +
        `передрукувати в ТОМУ Ж файлі (AGENTS.md, «ЦЕНА РАТЧЕТА №19», п. 8):\n  ${offenders.join("\n  ")}`
    ).toEqual([]);
  });

  it("детектор бачить кожну форму правки (самоперевірка на синтетичному тексті)", () => {
    const name = NAMES[0];
    const forms = [
      `create or replace function public.${name}() returns void as $$ $$ language sql;`,
      `create function ${name}(p uuid) returns void as $$ $$ language sql;`,
      `alter function public.${name}() owner to postgres;`,
      `alter function public.${name}() set search_path = public;`,
      `drop function if exists public.${name}();`,
      `grant execute on function public.${name}() to authenticated;`,
      `revoke all on function ${name}() from anon;`,
      `select pg_get_functiondef(p.oid) from pg_proc p where p.proname = '${name}';`,
      `select 1 from pg_proc p where p.proname in ('x', '${name}');`,
      `select pg_get_functiondef('public.${name}()'::regprocedure);`,
    ];
    for (const f of forms) expect(touches(codeOf(f), name), f).not.toEqual([]);
    // а це — НЕ правка
    for (const f of [
      `comment on function public.${name}() is 'x';`,
      `select public.${name}();`,
      `create policy p on t using (public.${name}() = clinic_id);`,
      `-- create or replace function public.${name}()`,
      `/* alter function public.${name}() owner to x */`,
    ]) expect(touches(codeOf(f), name), f).toEqual([]);
  });
});
