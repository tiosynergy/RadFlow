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
 * І ДРУГЕ ДЖЕРЕЛО — гілка `f:` списку №22 `grant_digest` (Н-7, с77). Вона
 * пінить ПОВНИЙ md5 тіла і власника кожної definer-функції, яку може виконати
 * `anon`, — і для чотирьох гейтів RLS (`auth_ceo_clinics`, `auth_is_ceo_of`,
 * `auth_radiologist_case_ok`, `auth_referrer_can_book_room`) це ЄДИНИЙ пін
 * тіла: у №19 їх немає, бо ревʼю 0180 відхилило перенос як дубль гілки `f:`.
 * Замір с77 показав, що поза полем зору лишався не пін, а CI: міграція, яка
 * правила такий гейт без передруку, проходила збірку і червонила №22 лише
 * вночі, на проді. Тепер правка функції з ОБОХ списків ловиться тут. І окремо
 * тримається властивість класу: кожен живий хелпер `auth_*` (у міграціях є
 * `create`, немає пізнішого `drop`) мусить стояти в №19 або в гілці `f:` №22 —
 * інакше його тіло, яке вирішує, що бачить роль, не пінить НІЩО. Відкликання
 * `anon` з такого гейта мовчки виніс би його з `f:` — і цей тест покраснів би
 * з іменем, вимагаючи перенести рядок у №19 тією ж міграцією.
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
 *
 * ФАЛЬСИФІКОВАНО разово (с77, гілка f: №22 і покриття `auth_*`), файли після
 * кожної мутації відновлено й звірено md5:
 *   • `create or replace function public.auth_ceo_clinics()` у пробній 0203 —
 *     червоне «0203_zz_probe.sql [№22 f:]»; `alter function … auth_is_ceo_of(uuid)
 *     owner to` і `drop function … auth_is_ceo_of(uuid)` — так само;
 *   • `comment on function public.auth_ceo_clinics()` — зелене (не правка);
 *   • та сама пробна 0203 при СТАРІЙ поведінці (імена лише з №19) — перевірка
 *     «новіша міграція» ЗЕЛЕНА: саме цю дірку CI і закрито;
 *   • новий `auth_new_gate()` без піна — червоне в покритті з його іменем;
 *   • рядок `f:auth_radiologist_case_ok` прибрано з передруку — червоне в
 *     покритті з іменем (і в `grantDigestInvariant` — лічильник рядків).
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

/** Імена definer-функцій, чиї ТІЛА пінить гілка `f:` списку №22 (Н-7, с77).
 *  Виріз — той самий, що в `grantDigestInvariant.test.ts`: від кроку лічильника
 *  до мітки перевірки, без рядкових коментарів (маркери `/* 0174 *\/` лишаються). */
function grantDigestFnNames(): string[] {
  const code = SRC.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  const at = code.indexOf("'check', 'grant_digest'");
  if (at < 0) throw new Error(`${REPRINT}: у передруку немає мітки grant_digest`);
  const start = code.lastIndexOf("v_n := v_n + 1;", at);
  if (start < 0) throw new Error(`${REPRINT}: перед міткою №22 немає кроку лічильника`);
  const block = code.slice(start, at);
  const names = new Set<string>();
  for (const m of block.matchAll(/^\s*\('f:([a-z0-9_]+)\([^']*\)','[^']*'\),?$/gm)) names.add(m[1]);
  if (names.size < 5) throw new Error(`${REPRINT}: у гілці f: №22 лише ${names.size} рядків — виріз зрушив?`);
  return [...names].sort();
}

const F_NAMES = grantDigestFnNames();

/** Імʼя → у яких списках воно пінується (для діагнозу в повідомленні). */
const PINNED_BY = new Map<string, string[]>();
for (const n of NAMES) PINNED_BY.set(n, ["№19"]);
for (const n of F_NAMES) PINNED_BY.set(n, [...(PINNED_BY.get(n) ?? []), "№22 f:"]);

/** Живі хелпери `auth_*`: останньою подією в історії міграцій є `create`, а не
 *  `drop`. Порядок — файли за іменем, усередині файлу — за позицією. */
function liveAuthHelpers(): string[] {
  const last = new Map<string, "create" | "drop">();
  for (const f of files) {
    const code = codeOf(readFileSync(resolve(MIGDIR, f), "utf8"));
    const ev: Array<[number, string, "create" | "drop"]> = [];
    for (const m of code.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(auth_[a-z0-9_]+)\s*\(/g)) {
      ev.push([m.index!, m[1], "create"]);
    }
    for (const m of code.matchAll(/drop\s+function\s+(?:if\s+exists\s+)?(?:public\.)?(auth_[a-z0-9_]+)\s*\(/g)) {
      ev.push([m.index!, m[1], "drop"]);
    }
    ev.sort((a, b) => a[0] - b[0]);
    for (const [, name, kind] of ev) last.set(name, kind);
  }
  return [...last].filter(([, k]) => k === "create").map(([n]) => n).sort();
}

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

describe(`№19 і №22 f: — зворотний бік ратчета: міграції новіші за ${REPRINT} не чіпають пінованих функцій`, () => {
  it("список №19 прочитано з останнього передруку", () => {
    expect(NAMES.length).toBeGreaterThanOrEqual(40);
    expect(NAMES).toContain("auth_clinic_id");
    expect(NAMES).toContain("fn_audit");
  });

  it("гілку f: №22 прочитано з того самого передруку (Н-7, с77)", () => {
    // Сама кількість рядків f: пінена в grantDigestInvariant.test.ts; тут —
    // що виріз узагалі щось знайшов і знайшов саме гілку f:, а не t:/s:/c:.
    expect(F_NAMES.length).toBeGreaterThanOrEqual(5);
    expect(F_NAMES).toContain("auth_ceo_clinics");
    for (const n of F_NAMES) expect(n, n).toMatch(/^[a-z0-9_]+$/);
  });

  it("кожен живий хелпер auth_* пінується в №19 або в гілці f: №22 (Н-7, с77)", () => {
    const live = liveAuthHelpers();
    // Нижня межа — щоб порожній скан (зламаний регекс) не зеленів мовчки.
    expect(live.length).toBeGreaterThanOrEqual(10);
    const unpinned = live.filter((n) => !PINNED_BY.has(n));
    expect(
      unpinned,
      `Хелпер auth_* вирішує, що бачить роль, але його тіла не пінить ані №19, ані ` +
        `гілка f: №22. Допишіть рядок у №19 тією ж міграцією, що створила хелпер ` +
        `або зняла з нього EXECUTE для anon (AGENTS.md, «ЦЕНА РАТЧЕТА №19»):\n  ${unpinned.join("\n  ")}`
    ).toEqual([]);
  });

  it("новіші міграції (після останнього передруку) визначено детерміновано", () => {
    for (const f of NEWER) expect(f > REPRINT).toBe(true);
    expect(files.includes(REPRINT)).toBe(true);
  });

  it("жодна новіша міграція не чіпає функцію зі списку №19 чи гілки f: №22 без передруку сторожа", () => {
    const offenders: string[] = [];
    for (const f of NEWER) {
      const code = codeOf(readFileSync(resolve(MIGDIR, f), "utf8"));
      // гранти на ВСІ функції схеми міняють acl кожного рядка списку
      if (/on\s+all\s+functions\s+in\s+schema\s+public/.test(code)) {
        offenders.push(`${f}: grant/revoke on all functions in schema public`);
      }
      for (const [name, lists] of PINNED_BY) {
        const hits = touches(code, name);
        if (hits.length) offenders.push(`${f} [${lists.join(", ")}]: ${hits.join("; ")}`);
      }
    }
    expect(
      offenders,
      `Міграція новіша за ${REPRINT} чіпає функцію, тіло якої пінить сторож (№19 або ` +
        `гілка f: №22), — сторожа треба передрукувати в ТОМУ Ж файлі з новим рядком ` +
        `(AGENTS.md, «ЦЕНА РАТЧЕТА №19», п. 8; «ЦЕНА РАТЧЕТА №22»):\n  ${offenders.join("\n  ")}`
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
