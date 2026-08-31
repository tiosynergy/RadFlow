/**
 * Вікно простою: клієнт проти живого гарда (F4-5, F4-7, F4-9 — фаза 4 аудиту
 * 2026-08-27).
 *
 * Клас дефекту. Одну й ту саму формулу — «яку частину доби простій блокує» —
 * у проєкті було написано ПʼЯТЬ разів: канон у `lib/incidents.ts`
 * (`incidentMinutesOnDay`, покритий викликом у tests/fhirDay.test.ts) і чотири
 * рукописні копії. Дві копії розійшлися з каноном:
 *
 *  • `incidentSpansFor` (планувальник затримки, СЕРВЕР) читав лише
 *    `status='active'`, тоді як гард `check_not_during_incident` дивиться
 *    `('active','planned')`, і трактував порожній `blocked_until` як «до кінця
 *    доби», тоді як гард — як `'infinity'`. Наслідок не косметичний: план
 *    ставив пацієнта у вікно планового ТО, RPC робив UPDATE, гард піднімав
 *    `INCIDENT` — і транзакція відкочувалась ЦІЛКОМ;
 *  • `CollisionPanel` і `QuickRescheduleButton` округлювали межі `Math.round`,
 *    тоді як канон модуля — початок вниз, кінець вгору. `started_at` у проді НЕ
 *    вирівняний на хвилину, тож `round` зсував початок вікна вперед, і кнопка
 *    «Перенести» пропонувала слот, який сервер відбивав як 23P01.
 *
 * Тому тут ДВА різні сторожі:
 *  1) КОНТРАКТ клієнт↔БД: список статусів витягується з ОСТАННЬОГО визначення
 *     гарда в міграціях і з коду планувальника — і мусить збігатися. Пін по
 *     літералу `('active','planned')` цього б не дав: він лишився б зеленим,
 *     якби майбутня міграція додала гарду третій статус.
 *  2) ЄДИНІСТЬ ФОРМУЛИ: кожен споживач кличе канонічну функцію, і своєї
 *     арифметики хвилин доби ні в кого немає.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { codeOf } from "./helpers/codeOf";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const src = (p: string) => codeOf(read(p));

const MIGRATIONS = "supabase/migrations";
/* Якір — саме СТВОРЕННЯ функції, а не згадка імені: міграції описують функції
   прозою («drop function public.check_not_during_incident()»), і зріз від
   коментаря поїхав би в тіло чужої функції (знахідка ревʼю р.2, LOW). */
const CREATE = /create\s+or\s+replace\s+function\s+public\.check_not_during_incident\s*\(\s*\)/gi;

/** Тіло ОСТАННЬОГО визначення гарда в міграціях (леджер append-only, тож
    найбільший номер файла і є чинним визначенням).
    ⚠️ Долар-тег читаємо з САМОГО тіла, а не припускаємо `$$`. Перша редакція
    шукала кінець як `indexOf("\n$$;")` і при невдачі мовчки йшла далі — тобто
    міграція, написана в стилі `as $function$` (а так написані ВСІ свіжі), була
    б пропущена, і сторож звіряв би клієнт зі СТАРИМ визначенням, лишаючись
    зеленим (знахідка ревʼю р.2, MEDIUM). Тепер невдалий розбір — це падіння з
    названою причиною, а не тиха деградація. */
type ParsedGuard =
  | { kind: "none" }                       // у файлі немає створення гарда
  | { kind: "bad"; why: string }           // створення є, а тіло не розібралось — це ПОМИЛКА
  | { kind: "ok"; body: string };

/** ЧИСТИЙ розбір: остання `create or replace` гарда в тексті міграції.
    Винесено окремо саме тому, що перша редакція мовчки деградувала — тепер
    поведінку розбору можна перевірити ВИКЛИКОМ (див. describe нижче). */
export function parseGuardBody(sql: string): ParsedGuard {
  const hits = [...sql.matchAll(new RegExp(CREATE.source, "gi"))];
  if (!hits.length) return { kind: "none" };
  const at = hits[hits.length - 1].index ?? 0;
  const tag = sql.slice(at).match(/\bas\s+(\$[A-Za-z0-9_]*\$)/i);
  if (!tag) return { kind: "bad", why: "не знайдено долар-тег тіла" };
  const open = sql.indexOf(tag[1], at + (tag.index ?? 0));
  const end = sql.indexOf(tag[1], open + tag[1].length);
  if (end <= open) return { kind: "bad", why: `не знайдено закриття тега ${tag[1]}` };
  const body = sql.slice(at, end);
  if (!/returns\s+trigger/i.test(body)) return { kind: "bad", why: "зріз не схожий на тригерну функцію" };
  return { kind: "ok", body };
}

function latestGuardBody(): { file: string; body: string } {
  const files = readdirSync(resolve(process.cwd(), MIGRATIONS))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let found: { file: string; body: string } | null = null;
  for (const f of files) {
    const parsed = parseGuardBody(read(join(MIGRATIONS, f)));
    if (parsed.kind === "none") continue;
    /* ⚠️ Саме падіння, а не `continue`: пропустити нерозібране визначення —
       означає звіряти клієнт зі СТАРИМ тілом і лишатись зеленим. */
    expect(parsed.kind, `${f}: визначення гарда не розібралось (${parsed.kind === "bad" ? parsed.why : ""})`).toBe("ok");
    found = { file: f, body: (parsed as { kind: "ok"; body: string }).body };   // пізніший файл перезаписує
  }
  expect(found, "визначення гарда в міграціях не знайдено — сторож нижче став би порожнім").not.toBeNull();
  return found as { file: string; body: string };
}

/** Тіло серверного планувальника вікон простою. */
function plannerBody(): string {
  const code = src("app/queue/actions.ts");
  const anchor = "async function incidentSpansFor(";
  expect(code.split(anchor).length - 1, "якір incidentSpansFor не унікальний").toBe(1);
  const at = code.indexOf(anchor);
  const end = code.indexOf("\n}", at);
  expect(end, "кінець incidentSpansFor не знайдено").toBeGreaterThan(at);
  return code.slice(at, end);
}

const listOf = (s: string): string[] =>
  [...s.matchAll(/'([a-z_]+)'|"([a-z_]+)"/g)].map((m) => m[1] ?? m[2]).sort();

describe("Розбір визначення гарда з міграції — перевіряється ВИКЛИКОМ", () => {
  const body = (tag: string) => `
create or replace function public.check_not_during_incident()
returns trigger
language plpgsql
as ${tag}
begin
  if exists (select 1 from public.incidents i
    where i.status in ('active', 'planned')) then
    raise exception 'INCIDENT';
  end if;
  return new;
end;
${tag};
`;

  it("класичний стиль $$ розбирається", () => {
    const r = parseGuardBody(body("$$"));
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" && r.body).toMatch(/i\.status in \('active', 'planned'\)/);
  });

  it("іменований тег $function$ розбирається — саме на ньому ламалась перша редакція", () => {
    /* Усі свіжі міграції проєкту пишуться саме так, тож «пропустити файл» тут
       означало б звіряти клієнт зі старим тілом і не червоніти НІКОЛИ. */
    const r = parseGuardBody(body("$function$"));
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" && r.body).toMatch(/i\.status in \('active', 'planned'\)/);
  });

  it("сама згадка імені у коментарі створенням не вважається", () => {
    expect(parseGuardBody("-- drop function public.check_not_during_incident() колись\n").kind).toBe("none");
  });

  it("створення є, а тіло не читається — це «bad», а не «none»", () => {
    const broken = "create or replace function public.check_not_during_incident()\nreturns trigger\nas $fn$\nbegin end;\n";
    const r = parseGuardBody(broken);
    expect(r.kind, "нерозібране тіло мовчки прикинулось відсутнім").toBe("bad");
  });

  it("останнє створення у файлі перемагає попереднє", () => {
    const two = body("$$") + body("$function$").replace("'planned'", "'planned', 'paused'");
    const r = parseGuardBody(two);
    expect(r.kind === "ok" && r.body).toMatch(/'paused'/);
  });
});

describe("F4-5 — планувальник затримки дзеркалить гард check_not_during_incident", () => {
  it("список статусів простою в клієнті збігається зі списком у гарді", () => {
    const guard = latestGuardBody();
    const inGuard = guard.body.match(/i\.status\s+in\s*\(([^)]*)\)/);
    expect(inGuard, `у ${guard.file} не знайдено фільтр статусів гарда`).not.toBeNull();
    const guardStatuses = listOf((inGuard as RegExpMatchArray)[1]);
    expect(guardStatuses.length, "розбір списку статусів гарда дав порожньо").toBeGreaterThan(0);

    const planner = plannerBody();
    const inClient = planner.match(/\.in\("status",\s*\[([^\]]*)\]\)/);
    expect(inClient, "планувальник не звужує вибірку списком статусів").not.toBeNull();
    const clientStatuses = listOf((inClient as RegExpMatchArray)[1]);

    expect(clientStatuses, `клієнт і гард (${guard.file}) розійшлися у статусах простою`)
      .toEqual(guardStatuses);
    /* Той самий дефект іншими словами: одиничний .eq не може дзеркалити список. */
    expect(planner, "повернувся .eq(\"status\") — список гарда ширший за один статус")
      .not.toMatch(/\.eq\("status"/);
  });

  it("гард трактує порожній blocked_until як «до відновлення», і клієнт не має свого фолбека", () => {
    const guard = latestGuardBody();
    expect(guard.body, `у ${guard.file} зник coalesce(blocked_until,'infinity') — контракт змінився`)
      .toMatch(/coalesce\(i\.blocked_until,\s*'infinity'/);
    const planner = plannerBody();
    /* «До кінця доби» — саме той фолбек, що розходився з 'infinity'.
       ⚠️ Перелік написань, а не одне: ревʼю р.2 показало, що пін на `3600e3`
       обходиться тим самим числом іншими словами (86400000, 864e5,
       24*60*60*1000). У тілі цієї функції жодне з них законним не буває. */
    expect(planner, "у планувальнику знову зʼявився власний фолбек кінця доби")
      .not.toMatch(/3600e3|864e5|86400000|24\s*\*\s*(3600|60\s*\*\s*60)|1440/);
    expect(planner, "планувальник рахує вікно не канонічною функцією")
      .toMatch(/incidentMinutesOnDay\(/);
  });
});

/** Зріз між якорями з перевіркою унікальності — щоб пін дивився саме туди, де
    жила рукописна формула, а не «десь у файлі». */
function sliceOf(file: string, from: string, to: string): string {
  const code = src(file);
  expect(code.split(from).length - 1, `${file}: якір «${from}» не унікальний`).toBe(1);
  const at = code.indexOf(from);
  const end = code.indexOf(to, at + from.length);
  expect(end, `${file}: не знайдено кінець зрізу`).toBeGreaterThan(at);
  return code.slice(at, end);
}

describe("F4-7 — формула хвилин простою одна на всіх", () => {
  /* Канон (`lib/incidents.ts::incidentMinutesOnDay`) перевіряється ВИКЛИКОМ у
     tests/fhirDay.test.ts: межі вниз/вгору, порожній blocked_until до кінця
     доби, обрізання по добі. Тут — лише те, що споживачі кличуть саме його.
     ⚠️ Пін дивиться в ЗРІЗ, а не у весь файл, і не залежить від імен змінних
     (обидві слабкості назвало ревʼю р.2): у файлі на 3000 рядків «канон десь
     викликається» доводить рівно нічого, а прив'язка до `dayStart|day0`
     обходилась перейменуванням. */
  const SITES: Array<[string, string, string]> = [
    ["app/queue/actions.ts", "async function incidentSpansFor(", "\n}"],
    ["components/CollisionPanel.tsx", "roomInc.forEach((i) => {", "});"],
    ["components/QuickRescheduleButton.tsx", "roomInc.forEach((i) => {", "});"],
    ["components/QueueBoard.tsx", "function incidentWorkMinutes(", "\n}"],
  ];
  for (const [f, from, to] of SITES) {
    it(`${f}: кличе канонічну функцію і не має своєї арифметики хвилин`, () => {
      const part = sliceOf(f, from, to);
      expect(part, "канонічна функція не викликається").toMatch(/incidentMinutesOnDay\(/);
      /* Рукописна формула впізнається за діленням на 60000 під округленням —
         незалежно від того, як названо опорну північ. */
      expect(part, "повернулась власна формула хвилин доби")
        .not.toMatch(/Math\.(round|floor|ceil)\([^;]*\/\s*60000/);
    });
  }

  it("BreakdownModal бере кінець чужого простою каноном, а не своїм тернарником", () => {
    /* Шоста копія: на нечитабельному blocked_until вона давала NaN, і перевірка
       перетину простоїв мовчки пропускала накладання (ревʼю р.1). */
    const code = src("components/BreakdownModal.tsx");
    const own = code.match(/blocked_until \? new Date\(o\.blocked_until\)/g) ?? [];
    expect(own.length, "повернувся власний розрахунок кінця простою").toBe(0);
    expect((code.match(/incidentEffectiveEnd\(o\)/g) ?? []).length, "обидві перевірки перетину мають кликати канон").toBe(2);
  });
});

describe("F4-9 — лічильник листа в сайдбарі: збій читання ≠ нуль", () => {
  it("помилка читання перевіряється і не перетворюється на 0", () => {
    const code = src("components/Sidebar.tsx");
    const at = code.indexOf("const loadWaitCount = useCallback(");
    expect(at, "loadWaitCount не знайдено").toBeGreaterThan(-1);
    const body = code.slice(at, code.indexOf("}, []);", at));
    expect(body, "error не деструктурується — PostgREST не кидає, і catch не спрацює")
      .toMatch(/const \{ count, error \} = await supabase/);
    expect(body, "після помилки лічильник усе одно записується")
      .toMatch(/if \(error\) return;\s*\n?\s*setWaitCount\(count \?\? 0\);/);
  });
});
