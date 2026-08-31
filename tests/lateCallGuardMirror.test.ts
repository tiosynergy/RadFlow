/**
 * Пізній виклик: клієнт проти живого гарда 0129 (Ф4-2 — фаза 4 аудиту
 * 2026-08-27).
 *
 * Клас дефекту. `lateCallClash` — дзеркало гілки (б) `queue_set_status_rpc`:
 *   v_actual := (now() at time zone tz) at time zone 'utc';
 *   v_end    := v_actual + make_interval(mins => v_dur + coalesce(v_buf, 5));
 *   q.scheduled_at >= v_actual and q.scheduled_at < v_end  → ACTUAL_OVERLAP
 * Сервер порівнює timestamptz (мікросекунди), клієнт рахував у ХВИЛИНАХ доби
 * через `wallMinOfDay`, який усікає секунди ВНИЗ. Усічення зсувало ОБИДВІ межі
 * вікна, і кожна давала свою розбіжність:
 *
 *  • кінець — клієнт блокував МЕНШЕ за сервер. О 10:30:30 виклик на 30+5 хв
 *    займає кабінет до 11:05:30, і слот 11:05 сервер відхиляє; клієнт же
 *    рахував вікно до 11:05 рівно і показував виклик ДОЗВОЛЕНИМ. Оператор
 *    натискав кнопку і отримував помилку сервера — fail-open у дзеркалі гарда,
 *    і саме він є причиною правки;
 *  • початок — клієнт блокував БІЛЬШЕ. Слот 10:30 о 10:30:30 для гарда вже в
 *    минулому (`scheduled_at >= v_actual` хибне), а клієнт бачив 630 >= 630 і
 *    вішав ЖОРСТКИЙ блок «наїде на наступного» до кінця хвилини.
 *
 * Тому тут ДВА різні сторожі:
 *  1) КОНТРАКТ клієнт↔БД: межі, дефолт буфера і список статусів витягуються з
 *     ОСТАННЬОГО визначення RPC у міграціях. Пін по літералу лишався б зеленим,
 *     якби майбутня міграція зробила праву межу включною або змінила дефолт.
 *  2) ПОВЕДІНКА: обидві межі перевіряються ВИКЛИКОМ на секундних краях —
 *     регекс по коду не довів би, що вердикт змінився.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { lateCallClash, callWindowMinutes, CALL_WINDOW_CLOCK_SLACK_MS } from "@/lib/queueStatus";
import { CLOCK_WORST_ERROR_MS } from "@/lib/serverClock";
import { BUFFER_DEFAULT } from "@/lib/studies";
import { setClinicTz, wallInstant } from "@/lib/incidents";
import { codeOf } from "./helpers/codeOf";

beforeAll(() => setClinicTz("UTC"));

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const MIGRATIONS = "supabase/migrations";

/* Якір — саме СТВОРЕННЯ функції. Ім'я `queue_set_status_rpc` зустрічається в
   міграціях ще двічі в інших ролях — `drop function if exists public.…` і
   `grant execute on function public.…`, — і зріз від них поїхав би в чуже
   тіло або в порожнечу (та сама пастка, що в incidentPlannerMirror).
   `or replace`, схема і лапки — НЕОБОВʼЯЗКОВІ (ревʼю Б, HIGH): 0129 сама
   робить `drop` + пересоздание, тож майбутнє `create function public.…` без
   `or replace` жорсткий якір просто не побачив би, `latestRpcBody` пішов би
   далі по `continue`, і весь блок «контракт» звіряв би клієнт зі СТАРОЮ
   міграцією, лишаючись зеленим. */
const CREATE = /create\s+(?:or\s+replace\s+)?function\s+(?:public\s*\.\s*)?"?queue_set_status_rpc"?\s*\(/gi;

type ParsedRpc =
  | { kind: "none" }                       // у файлі немає створення RPC
  | { kind: "bad"; why: string }           // створення є, а тіло не розібралось — це ПОМИЛКА
  | { kind: "ok"; body: string };

/** ЧИСТИЙ розбір: останнє `create or replace` RPC у тексті міграції.
    Долар-тег читаємо з САМОГО тіла: 0129 написана як `$$`, 0109 — як
    `$function$`. Припущення про `$$` пропустило б новіші файли, і сторож
    звіряв би клієнт зі СТАРИМ тілом, лишаючись зеленим. */
export function parseRpcBody(sql: string): ParsedRpc {
  const hits = [...sql.matchAll(new RegExp(CREATE.source, "gi"))];
  if (!hits.length) return { kind: "none" };
  const at = hits[hits.length - 1].index ?? 0;
  const tag = sql.slice(at).match(/\bas\s+(\$[A-Za-z0-9_]*\$)/i);
  if (!tag) return { kind: "bad", why: "не знайдено долар-тег тіла" };
  const open = sql.indexOf(tag[1], at + (tag.index ?? 0));
  const end = sql.indexOf(tag[1], open + tag[1].length);
  if (end <= open) return { kind: "bad", why: `не знайдено закриття тега ${tag[1]}` };
  const body = sql.slice(at, end);
  if (!/returns\s+table/i.test(body)) return { kind: "bad", why: "зріз не схожий на RPC (немає returns table)" };
  /* Тег міг знайтись у КОМЕНТАРІ над тілом (ревʼю Б, MEDIUM): рядок
     «-- тіло як у 0129 (там воно відкрите as $$)» дав би `open` у коментарі,
     `end` — на справжньому відкритті тіла, і зріз звівся б до самого
     заголовка. Заголовок проходить `returns table`, тож розбір повернув би
     «ok» з порожнім тілом — сторожі нижче стали б вакуумними.
     Тіло plpgsql зобовʼязане мати begin і завершуватись на end. */
  if (!/\bbegin\b/i.test(body)) return { kind: "bad", why: "у зрізі немає begin — тег знайдено не там" };
  if (!/\bend\s*;?\s*$/i.test(body.trimEnd())) return { kind: "bad", why: "зріз не завершується на end" };
  return { kind: "ok", body };
}

/** Тіло ОСТАННЬОГО визначення RPC у міграціях (леджер append-only, тож
    найбільший номер файла і є чинним визначенням). */
function latestRpcBody(): { file: string; body: string } {
  const files = readdirSync(resolve(process.cwd(), MIGRATIONS))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let found: { file: string; body: string } | null = null;
  for (const f of files) {
    const parsed = parseRpcBody(read(join(MIGRATIONS, f)));
    if (parsed.kind === "none") continue;
    /* ⚠️ Саме падіння, а не `continue`: пропустити нерозібране визначення —
       означає звіряти клієнт зі СТАРИМ тілом і лишатись зеленим. */
    expect(parsed.kind, `${f}: визначення RPC не розібралось (${parsed.kind === "bad" ? parsed.why : ""})`).toBe("ok");
    found = { file: f, body: (parsed as { kind: "ok"; body: string }).body };   // пізніший файл перезаписує
  }
  expect(found, "визначення queue_set_status_rpc у міграціях не знайдено — сторожі нижче стали б порожніми").not.toBeNull();
  return found as { file: string; body: string };
}

/** Гілка (б) — та сама, що дзеркалить lateCallClash. Гілка (а) —
    ACTUAL_OVERLAP_BUSY (сидить in_progress) — має СВІЙ вигляд і своє дзеркало
    (`room_busy`); зріз до неї не дотягується саме тому, що якір — власний
    exists гілки (б), а не спільний `v_actual`. */
function overlapBranch(): { file: string; text: string } {
  const g = latestRpcBody();
  /* Якір мусить бути УНІКАЛЬНИМ: якби `ACTUAL_OVERLAP:` трапився ще й у
     коментарі, зріз ліг би не на ту гілку і мовчки перевіряв не те.
     `ACTUAL_OVERLAP_BUSY:` під цей якір не підпадає — двокрапка після
     `_BUSY`, а не після `OVERLAP`. */
  expect(g.body.split("ACTUAL_OVERLAP:").length - 1, `${g.file}: якір ACTUAL_OVERLAP: не унікальний`).toBe(1);
  const at = g.body.indexOf("ACTUAL_OVERLAP:");
  expect(at, `${g.file}: у тілі RPC немає гілки ACTUAL_OVERLAP`).toBeGreaterThan(0);
  const from = g.body.lastIndexOf("if exists (", at);
  expect(from, `${g.file}: не знайдено початок гілки ACTUAL_OVERLAP`).toBeGreaterThan(0);
  const text = g.body.slice(from, at);
  /* ⚠️ `lastIndexOf` МІГ БИ тихо переїхати на гілку (а) (ревʼю Б, MEDIUM):
     достатньо переписати гілку (б) через `perform 1 … ; if found then` — і
     зріз охопив би ОБИДВІ гілки, а всі перевірки нижче лишились би зеленими,
     бо потрібні їм рядки є в (б). Тому зріз мусить містити РІВНО один запит
     до queue_entries і не містити гілки (а). */
  expect(text.split("from public.queue_entries").length - 1,
    `${g.file}: зріз гілки охопив не один запит — гілку (б) переписали, і якір поїхав`).toBe(1);
  expect(text, `${g.file}: у зріз потрапила гілка (а) ACTUAL_OVERLAP_BUSY`).not.toMatch(/ACTUAL_OVERLAP_BUSY/);
  return { file: g.file, text };
}

/** Умови WHERE гілки, нормалізовані: пробіли стиснуто, вміст `in (...)`
    відсортовано (щоб перестановка статусів лишалась зеленою). */
function branchConditions(text: string): string[] {
  const w = text.indexOf("where");
  expect(w, "у гілці немає where").toBeGreaterThan(0);
  const stop = text.indexOf(") then", w);
  expect(stop, "не знайдено кінець умови гілки").toBeGreaterThan(w);
  return text.slice(w + "where".length, stop)
    .split(/\band\b/)
    .map((c) => c.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((c) => c.replace(/in\s*\(([^)]*)\)/i, (_m, list: string) =>
      "in (" + list.split(",").map((s) => s.trim()).sort().join(", ") + ")"));
}

/** Праву частину присвоєння змінної в тілі, з вимогою ЄДИНОСТІ присвоєння.
    Перша редакція брала `match` (перше входження) — і другий рядок
    `v_actual := date_trunc('minute', v_actual);` пройшов би повз сторожа
    (ревʼю Б, HIGH). */
function soleAssignment(body: string, name: string, file: string): string {
  const all = [...body.matchAll(new RegExp(`\\b${name}\\s*:=\\s*([^;]+);`, "g"))];
  expect(all.length, `${file}: очікувалось РІВНО одне присвоєння ${name}, знайдено ${all.length}`).toBe(1);
  return all[0][1].replace(/\s+/g, " ").trim();
}

/* Сам розбір теж перевіряємо ВИКЛИКОМ: сторож, який мовчки не знайшов тіла,
   гірший за відсутній — він зелений завжди. */
describe("parseRpcBody — розбір визначення RPC із міграції", () => {
  const body = (tag: string) => `
create or replace function public.queue_set_status_rpc(
  p_id uuid, p_status queue_status
) returns table(updated boolean, current_status queue_status)
language plpgsql security definer as ${tag}
begin
  if exists (select 1 from public.queue_entries q
             where q.scheduled_at >= v_actual and q.scheduled_at < v_end)
  then raise exception 'ACTUAL_OVERLAP: виклик зараз перекриє наступний запис';
  end if;
end;
${tag};
`;

  it("класичний стиль $$ розбирається", () => {
    const r = parseRpcBody(body("$$"));
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" && r.body).toMatch(/scheduled_at <\s*v_end/);
  });

  it("іменований тег $function$ розбирається", () => {
    const r = parseRpcBody(body("$function$"));
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" && r.body).toMatch(/scheduled_at <\s*v_end/);
  });

  it("drop і grant створенням не вважаються", () => {
    const noise =
      "drop function if exists public.queue_set_status_rpc(uuid, queue_status);\n" +
      "grant execute on function public.queue_set_status_rpc(uuid) to authenticated;\n";
    expect(parseRpcBody(noise).kind, "зріз від drop/grant поїхав би в чуже тіло").toBe("none");
  });

  it("створення є, а тіло не читається — це «bad», а не «none»", () => {
    const broken = "create or replace function public.queue_set_status_rpc(p_id uuid)\nas $function$\nbegin\n";
    expect(parseRpcBody(broken).kind, "нерозібране тіло мовчки прикинулось відсутнім").toBe("bad");
  });

  it("останнє створення у файлі перемагає попереднє", () => {
    const two = body("$$") + body("$function$").replace("< v_end", "<= v_end");
    const r = parseRpcBody(two);
    expect(r.kind === "ok" && r.body).toMatch(/<=\s*v_end/);
  });
});

describe("Ф4-2 — контракт: що саме порівнює гард 0129", () => {
  /* Пін по ПОВНОМУ набору умов, а не по окремих регексах (ревʼю Б, HIGH).
     Регекс `/q\.scheduled_at\s*>=\s*v_actual/` лишався зеленим на
     `>= v_actual + interval '1 minute'` і на доданій умові
     `q.scheduled_at <> v_actual` — тобто на правках, які реально зсувають
     межі. Леджер append-only: обраний файл більше не змінюється, тож пін по
     набору не «крихкий» — він спрацює рівно тоді, коли НОВА міграція
     перепише гілку, і саме тоді людина мусить перечитати дзеркало. */
  it("умови гілки — рівно ті, що дзеркалить клієнт", () => {
    const b = overlapBranch();
    expect(branchConditions(b.text), `${b.file}: умови гілки ACTUAL_OVERLAP змінились — перечитайте lateCallClash`)
      .toEqual([
        "q.room_id = v_room",
        "q.id <> p_id",
        "q.status in ('scheduled', 'waiting')",
        "q.scheduled_at is not null",
        "q.scheduled_at >= v_actual",
        "q.scheduled_at < v_end",
      ]);
  });

  /* Обидва присвоєння пінимо ЦІЛКОМ і вимагаємо єдиності. Три різні правки
     проходили повз попередню редакцію (ревʼю Б, HIGH): другий рядок
     `v_actual := date_trunc(...)`; усічення, перенесене в `v_end`; і
     `+ interval '10 min'`, дописаний після make_interval. */
  it("гард рахує вікно від «зараз» без усічення і без добавок", () => {
    const g = latestRpcBody();
    expect(soleAssignment(g.body, "v_actual", g.file),
      `${g.file}: v_actual рахується інакше — клієнтське мс-порівняння більше не дзеркало`)
      .toBe("(now() at time zone v_tz) at time zone 'utc'");
    expect(soleAssignment(g.body, "v_end", g.file),
      `${g.file}: ширина або межа вікна змінилась — перечитайте callWindowMinutes і слак`)
      .toBe("v_actual + make_interval(mins => v_dur + coalesce(v_buf, 5))");
  });

  it("дефолт буфера в гарді збігається з клієнтським", () => {
    const g = latestRpcBody();
    const iv = soleAssignment(g.body, "v_end", g.file)
      .match(/coalesce\(v_buf,\s*(\d+)\)/);
    expect(iv, `${g.file}: формула вікна виклику не знайдена`).not.toBeNull();
    expect(Number((iv as RegExpMatchArray)[1]), `${g.file}: дефолт буфера в БД розійшовся з BUFFER_DEFAULT`)
      .toBe(BUFFER_DEFAULT);
    // Той самий дефолт у клієнта — саме через ?? (0 має лишатись нулем, а не ставати 5).
    expect(callWindowMinutes({ duration_min: 30, buffer_time_min: null })).toBe(30 + BUFFER_DEFAULT);
    expect(callWindowMinutes({ duration_min: 30, buffer_time_min: 0 })).toBe(30);
    /* Гард бере `coalesce(v_buf, 5)` СИРИМ. Якби клієнт почав нормалізувати
       буфер через normBuffer (клампить у 15), при буфері 20 його вікно стало б
       на 5 хв коротшим за серверне — fail-open на межі (ревʼю Б, MEDIUM).
       CHECK 0045 таких значень сьогодні не пускає, але зв'язок «клієнт не
       нормалізує» тримався ЛИШЕ коментарем. */
    expect(callWindowMinutes({ duration_min: 30, buffer_time_min: 20 }),
      "у вікно виклику повернувся normBuffer — воно перестало дзеркалити coalesce(v_buf, …)").toBe(50);
  });

  it("список статусів гарда збігається з клієнтським фільтром", () => {
    const b = overlapBranch();
    const inGuard = b.text.match(/q\.status\s+in\s*\(([^)]*)\)/);
    expect(inGuard, `${b.file}: не знайдено фільтр статусів гілки`).not.toBeNull();
    const guardStatuses = (inGuard as RegExpMatchArray)[1]
      .split(",").map((s) => s.trim().replace(/^'|'$/g, "")).filter(Boolean).sort();
    /* Клієнтський список беремо з КОДУ, а не з літерала в тесті: інакше
       розширення гарда третім статусом лишило б сторожа зеленим. */
    const client = codeOf(read("lib/queueStatus.ts"));
    const at = client.indexOf("export function lateCallClash");
    const fn = client.slice(at, client.indexOf("\n}", at));
    const clientStatuses = [...fn.matchAll(/e\.status\s*===\s*"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(clientStatuses, `${b.file}: allow-лист клієнта і гарда розійшлись`).toEqual(guardStatuses);
  });
});

describe("Ф4-2 — поведінка lateCallClash на секундних краях вікна", () => {
  const P = { id: "b", room_id: "r1", duration_min: 30, buffer_time_min: 5 };  // вікно 35 хв
  const at = (t: string, sec = 0) => wallInstant("2026-07-13", t) + sec * 1000;
  const slot = (time: string, id = "c") =>
    [{ id, room_id: "r1", status: "scheduled", scheduled_time: time, patient_name: "Іваненко І." }];

  /* ГОЛОВНИЙ випадок правки: до неї клієнт рахував вікно до 11:05 РІВНО і
     віддавав null, а сервер відхиляв виклик ACTUAL_OVERLAP. */
  it("слот РІВНО на кінці вікна — блок (сервер його відхиляє)", () => {
    expect(lateCallClash(P, slot("11:05"), at("10:30"))).toMatchObject({ time: "11:05" });
  });

  it("той самий кінець, але «зараз» усередині хвилини — теж блок", () => {
    // 10:30:30 + 35 хв = 11:05:30 → слот 11:05 усередині вікна навіть без слака.
    expect(lateCallClash(P, slot("11:05"), at("10:30", 30))).toMatchObject({ time: "11:05" });
  });

  it("слот за хвилину ПІСЛЯ кінця — вільно (слак не з'їдає цілу хвилину)", () => {
    expect(lateCallClash(P, slot("11:06"), at("10:30"))).toBeNull();
    // Через 59 с вікно тягнеться до 11:05:59, слак додає ~3 с → 11:06:02, тож
    // слот 11:06 уже всередині (див. наступний тест). Беремо 11:07.
    expect(lateCallClash(P, slot("11:07"), at("10:30", 59))).toBeNull();
  });

  /* ⚠️ U-70: слак став ДВОСТОРОННІМ і виріс до CLOCK_WORST_ERROR_MS + 1000, бо
     `wallNow` перейшов на виміряний годинник і може ПЕРЕСТРИБНУТИ сервер.
     Ці тести пінують обидві межі саме на ширині слака. */
  it("права межа розширена на слак: слот, який сервер ЩЕ блокує", () => {
    // 10:30:59 + 35 хв = 11:05:59; серверне «зараз» могло бути на ~3 с пізніше,
    // тобто його вікно тягнеться за 11:06 — блокуємо.
    expect(lateCallClash(P, slot("11:06"), at("10:30", 59))).toMatchObject({ time: "11:06" });
  });

  it("ліва межа розширена на слак: слот, який щойно минув", () => {
    /* Головна причина двостороннього слака. Клієнтський годинник тепер може
       ВИПЕРЕДЖАТИ сервер: о 10:31:01 за клієнтом сервер може бути на 10:30:59,
       і слот 10:31 для нього ще попереду. Без лівого слака клієнт вважав би
       його минулим і мовчав — fail-open. */
    expect(lateCallClash(P, slot("10:31"), at("10:31", 1))).toMatchObject({ time: "10:31" });
    // А за межами слака слот справді минулий — мовчимо.
    expect(lateCallClash(P, slot("10:31"), at("10:31", 5))).toBeNull();
  });

  /* ⚠️ ОПЕРАТОРИ НА САМИХ МЕЖАХ (знахідка ревʼю Б, HIGH: жоден тест не стояв
     РІВНО на межі, тож підміна `>=` на `>` зліва і `<` на `<=` справа лишалась
     зеленою — а це рівно та пара мутацій, що робить дзеркало fail-open).
     Обидві межі беруться ІЗ КОНСТАНТИ, а не з підібраних секунд: інакше зміна
     слака зробила б тести або беззмістовними, або червоними без дефекту. */
  const atMs = (t: string, ms: number) => wallInstant("2026-07-13", t) + ms;
  const SLACK = CALL_WINDOW_CLOCK_SLACK_MS;

  it("ЛІВА межа включна: слот рівно на `зараз − слак` ще блокує", () => {
    // Слот 10:31:00; «зараз» = 10:31:00 + слак → startMsOfDay РІВНО на слоті.
    expect(lateCallClash(P, slot("10:31"), atMs("10:31", SLACK)), "ліва межа стала виключною (`>=` → `>`)")
      .toMatchObject({ time: "10:31" });
    // На мілісекунду пізніше слот уже за межею — і це ЄДИНИЙ вхід, що
    // відрізняє включну межу від виключної.
    expect(lateCallClash(P, slot("10:31"), atMs("10:31", SLACK + 1))).toBeNull();
  });

  it("ПРАВА межа виключна: слот рівно на `кінець + слак` уже вільний", () => {
    // Вікно 10:30:00 + 35 хв = 11:05:00; права межа = 11:05:00 + слак.
    expect(lateCallClash(P, slot("11:05:03.125"), at("10:30")), "права межа стала включною (`<` → `<=`)")
      .toBeNull();
    expect(lateCallClash(P, slot("11:05:03.124"), at("10:30"))).toMatchObject({ time: "11:05:03.124" });
    // Пін самого числа: якщо слак зміниться, ці два слоти треба перерахувати.
    expect(SLACK, "слак змінився — перерахуйте слоти в тесті правої межі").toBe(3125);
  });

  /* Другий бік того самого усічення: слот у поточній хвилині, але вже в
     минулому. Гард його не бачить (`>= v_actual` хибне), а клієнт вішав
     жорсткий блок «наїде на наступного» до кінця хвилини. */
  it("слот у поточній хвилині, але вже минув — вільно", () => {
    expect(lateCallClash(P, slot("10:30"), at("10:30", 30))).toBeNull();
  });

  it("слот рівно на «зараз» — блок (ліва межа включна, як у гарді)", () => {
    expect(lateCallClash(P, slot("10:30"), at("10:30"))).toMatchObject({ time: "10:30" });
  });

  /* Гард виключає сам запис (`q.id <> p_id`), і клієнт зобов'язаний теж:
     на дошці `entries` — увесь день, включно з тим, кого викликають. Без цієї
     умови пацієнт, чий власний слот потрапляє у вікно виклику, вічно блокував
     би САМ СЕБЕ повідомленням «наїде на наступного» — тобто рівно сценарій
     «запізнився → все ж прийшов → виклик», заради якого й писався lateCallClash.
     Жоден тест цього не перевіряв (ревʼю Б, HIGH): у всіх фікстурах p у
     масив не клали. */
  it("сам запис, що викликається, себе не блокує", () => {
    const self = [{ id: P.id, room_id: "r1", status: "waiting", scheduled_time: "10:45", patient_name: "Він сам" }];
    expect(lateCallClash(P, self, at("10:30"))).toBeNull();
  });

  it("однофамілець з іншим id блокує — це не «будь-який запис ігноруємо»", () => {
    const other = [{ id: "other", room_id: "r1", status: "waiting", scheduled_time: "10:45", patient_name: "Він сам" }];
    expect(lateCallClash(P, other, at("10:30"))).toMatchObject({ time: "10:45" });
  });
});

describe("Ф4-2 — секунди у самому scheduled_time", () => {
  const P = { id: "b", room_id: "r1", duration_min: 30, buffer_time_min: 5 };
  const at = (t: string, sec = 0) => wallInstant("2026-07-13", t) + sec * 1000;

  /* CHECK-у на формат 'HH:MM' у БД немає (перевірено на проді 31.08: 96/96
     рядків у 'HH:MM', обмеження відсутнє) — формат тримає лише кастом тригер
     `set_scheduled_at`, а він приймає і 'HH:MM:SS'. Старий `toMin` брав
     [h, m] і секунду відкидав: гард порівнював 11:00:59, клієнт — 11:00. */
  it("порядок «найближчий наступний» рахується з секундами", () => {
    const entries = [
      { id: "late", room_id: "r1", status: "scheduled", scheduled_time: "11:00:59", patient_name: "Пізніший" },
      { id: "early", room_id: "r1", status: "scheduled", scheduled_time: "11:00:00", patient_name: "Раніший" },
    ];
    expect(lateCallClash(P, entries, at("10:30")), "секунда в даних зламала вибір найближчого")
      .toMatchObject({ time: "11:00:00", name: "Раніший" });
  });

  it("секунда виводить слот за межу вікна — і клієнт це бачить", () => {
    // Вікно 10:30:00 + 35 хв + слак ~3 с = до 11:05:03.125. Слот 11:05:30 — поза ним.
    expect(lateCallClash(P, [{ id: "c", room_id: "r1", status: "scheduled", scheduled_time: "11:05:30" }], at("10:30")))
      .toBeNull();
    // А о 10:30:30 вікно тягнеться до 11:05:31 — той самий слот уже всередині.
    expect(lateCallClash(P, [{ id: "c", room_id: "r1", status: "scheduled", scheduled_time: "11:05:30" }], at("10:30", 30)))
      .toMatchObject({ time: "11:05:30" });
  });

  /* Дробова секунда — єдиний вхід, що РОЗРІЗНЯЄ слак і оператор порівняння
     (ревʼю Б, LOW): на посекундно вирівняних даних пара «слак + `<`» і пара
     «без слака + `<=`» дають однакові вердикти скрізь, тож усі попередні
     перевірки лишались би зеленими після такої підміни. Тут вікно
     10:30:00 + 35 хв дає межу 11:05:00; зі слаком воно тягнеться до
     11:05:03.125, і слот 11:05:00.5 всередині — а без слака з `<=` він поза.
     Заразом це пін обіцянки коментаря slotMsOfDay про '10:35:30.5' і сторож
     проти округлення секунд угору. */
  it("дробова секунда слота розрізняє слак і межу", () => {
    const half = [{ id: "c", room_id: "r1", status: "scheduled", scheduled_time: "11:05:00.5" }];
    expect(lateCallClash(P, half, at("10:30")), "слот на пів секунди всередині вікна не побачено")
      .toMatchObject({ time: "11:05:00.5" });
  });
});

describe("Ф4-2 — арифметика вікна не роздвоїлась", () => {
  const client = codeOf(read("lib/queueStatus.ts"));
  const fnOf = (name: string) => {
    const anchor = `export function ${name}`;
    expect(client.split(anchor).length - 1, `якір ${anchor} не унікальний`).toBe(1);
    const at = client.indexOf(anchor);
    return client.slice(at, client.indexOf("\n}", at));
  };

  /* Сторож ДОДАТКОВИЙ до викликів вище: він не доводить вердикту, але ловить
     повернення хвилинного усічення в дзеркало гарда — правку, після якої
     тести-краї впали б не одразу, а лише на «зручних» секундах. */
  it("lateCallClash не має власної хвилинної арифметики", () => {
    const fn = fnOf("lateCallClash");
    expect(fn, "у дзеркало гарда повернулось усічення до хвилини").not.toMatch(/wallMinOfDay/);
    expect(fn, "ширина вікна порахована на місці, а не через callWindowMinutes").toMatch(/callWindowMinutes\(/);
    expect(fn, "невизначеність «зараз» перестала закладатись у кінець вікна")
      .toMatch(/CALL_WINDOW_CLOCK_SLACK_MS/);
  });

  /* Слак ВИРАХУВАНИЙ із найгіршої помилки застосованого зсуву, а не вписаний
     числом: інакше зміна будь-якого порога годинника нечутно зробила б його
     замалим. Виріс би він до хвилини — клієнт блокував би цілий слот, якого
     сервер не блокує, і жорстка кнопка «Викликати» гасла б без причини.

     ⚠️ САМЕ ТУТ ЖИЛА ПОМИЛКА U-70 (знахідка ревʼю Б, HIGH): перша редакція
     писала `CLOCK_MAX_RTT_MS / 2 + 1000` і забувала, що зсув, менший за
     `CLOCK_MIN_APPLY_MS`, ОБНУЛЯЄТЬСЯ — тобто справжній зсув до секунди
     лишається невиправленим і додається до похибки вимірювання. Тест був
     зеленим, бо повторював ту саму формулу. Тепер він звіряється з
     `CLOCK_WORST_ERROR_MS`, де доданки перелічені поіменно, і додатково
     перевіряє, що права межа накрита. */
  it("слак виведений із найгіршої помилки годинника, а не вписаний", () => {
    expect(CALL_WINDOW_CLOCK_SLACK_MS).toBe(CLOCK_WORST_ERROR_MS + 1000);
    /* Права межа інтервалу T − N: найгірша помилка зсуву ПЛЮС усічення до
       секунди в wallNow. Слак не сміє бути меншим — саме на цій межі жив
       fail-open першої редакції. */
    expect(CALL_WINDOW_CLOCK_SLACK_MS, "слак не накриває праву межу помилки «зараз»")
      .toBeGreaterThanOrEqual(CLOCK_WORST_ERROR_MS + 1000);
    expect(CALL_WINDOW_CLOCK_SLACK_MS, "слак з'їдає більше секунд, ніж пояснено").toBeLessThan(5000);
  });

  it("слак кладеться на ОБИДВІ межі вікна", () => {
    const fn = fnOf("lateCallClash");
    expect(fn, "ліву межу лишили без слака — клієнт попереду сервера мовчить")
      .toMatch(/nowMsOfDay - CALL_WINDOW_CLOCK_SLACK_MS/);
    expect(fn, "праву межу лишили без слака").toMatch(/\+ CALL_WINDOW_CLOCK_SLACK_MS/);
  });

  /* Жоден тест не кличе lateCallClash БЕЗ nowMs, тож підміна дефолту на
     `Date.now()` лишалась би зеленою — а в проді це зсунуло б дзеркало на
     цілу зону клініки (ревʼю Б, MEDIUM). Настінний канон живе тільки в
     wallNow: перевіряємо саме дефолт сигнатури. */
  it("дефолт «зараз» — настінний wallNow, а не Date.now", () => {
    expect(fnOf("lateCallClash"), "дефолт nowMs перестав бути wallNow()")
      .toMatch(/nowMs\s*:\s*number\s*=\s*wallNow\(\)/);
  });

  /* Фільтр записів пінимо ЦІЛКОМ. Порівняння самих лише СПИСКІВ СТАТУСІВ
     (тест вище) лишалось би зеленим, якби до фільтра дописали ще одну умову —
     напр. `&& e.call_status !== "called"`: статуси ті самі, а клієнт блокує
     менше за гард (ревʼю Б, HIGH). Умови гарда пінуються симетрично в
     «умови гілки — рівно ті, що дзеркалить клієнт». */
  it("фільтр записів — рівно умови гарда, без додаткових", () => {
    const fn = fnOf("lateCallClash");
    const line = fn.split("\n").find((l) => l.includes(".filter((e)"));
    expect(line, "не знайдено фільтр записів у lateCallClash").toBeTruthy();
    expect(String(line).replace(/\s+/g, " ").trim(),
      "фільтр записів змінився — звірте його з умовами гілки гарда")
      .toBe('.filter((e) => e.room_id === p.room_id && e.id !== p.id && (e.status === "scheduled" || e.status === "waiting") && e.scheduled_time)');
  });
});
