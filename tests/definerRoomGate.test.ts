/**
 * Статичний сторож пакета 0193 (I-8): кабінетний гейт радіолога в
 * DEFINER-ЧИТАННІ вейтліста.
 *
 * ЧОМУ ВІН ІСНУЄ. Гейт у тілі функції — це ДУБЛЮВАННЯ правила, яке вже стоїть
 * у політиці `waitlist_select`. Дублювання роз'їжджається, і зняти його одним
 * `create or replace` можна МОВЧКИ: жоден із 23 інваріантів цього не побачив
 * би — рівно так діра й прожила від 0104 (написана ДО 0136) до 14.09.2026.
 * У проді від зняття тепер стереже пін №19; ТУТ стережеться те, що в дереві
 * лежить саме той текст, який пінили.
 *
 * ⚠️ ЧОГО ЦЕЙ ФАЙЛ НЕ ДОВОДИТЬ: він читає ТЕКСТ, а не виконує SQL. «Гейт
 *    написаний» ≠ «гейт ріже». Останнє доводиться смоуком
 *    `waitlist_candidates_smoke.sql` (обидва боки: радіолог 0 рядків,
 *    не-радіолог — стільки ж, скільки до правки) і стендом
 *    `scripts/falsify-0193-room-gate.mjs`.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGDIR = resolve(process.cwd(), "supabase/migrations");
const FRAGDIR = resolve(process.cwd(), "scripts/frag");

const MIG = readFileSync(resolve(MIGDIR, "0193_definer_room_gate.sql"), "utf8").replace(/\r/g, "");
const OLD104 = readFileSync(resolve(MIGDIR, "0104_waitlist_candidates_rpc.sql"), "utf8").replace(/\r/g, "");
const OLD105 = readFileSync(resolve(MIGDIR, "0105_waitlist_counts_rpc.sql"), "utf8").replace(/\r/g, "");
const APPLY = readFileSync(resolve(FRAGDIR, "0193_apply.sql"), "utf8").replace(/\r/g, "");
const DRYRUN = readFileSync(resolve(FRAGDIR, "0193_dryrun.sql"), "utf8").replace(/\r/g, "");
const ROLLBACK = readFileSync(resolve(FRAGDIR, "0193_rollback.sql"), "utf8").replace(/\r/g, "");

/* Гейт — ДВА рядки, дзеркало форми політики `waitlist_select`: перший
   диз'юнкт у `(select …)` стає InitPlan і знімає всю дизʼюнкцію один раз на
   запит для кожного, хто не радіолог (інакше DEFINER-хелпер кликався б НА
   КОЖЕН РЯДОК). Тримаємо ТОЧНИЙ текст, бо ним же ріжемо тіло нижче. */
const GATE = "       and ((select public.auth_role()) is distinct from 'radiologist'\n"
  + "            or public.auth_radiologist_room_ok(w.room_id))\n";
const HELPER = "public.auth_radiologist_room_ok(w.room_id)";
const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
const norm = (s: string) => md5(s.replace(/\s+/g, " ").trim());

/** Тіло функції між `as $$` і `$$;` — той самий витяг, що в збирача. */
function body(txt: string, from = 0): string {
  const o = "\nas $$";
  const c = "\n$$;";
  const a = txt.indexOf(o, from);
  const b = txt.indexOf(c, a);
  if (a < 0 || b < 0) throw new Error("межі тіла не знайдено");
  return txt.slice(a + o.length, b + 1);
}

const BODY_NEW_CANDIDATES = body(MIG);
const BODY_NEW_COUNTS = body(MIG, MIG.indexOf("public.waitlist_counts("));
const BODY_OLD_CANDIDATES = body(OLD104);
const BODY_OLD_COUNTS = body(OLD105);

describe("0193: гейт стоїть в ОБОХ функціях і рівно один раз", () => {
  for (const [name, b] of [
    ["waitlist_candidates_for_slot", BODY_NEW_CANDIDATES],
    ["waitlist_counts", BODY_NEW_COUNTS],
  ] as const) {
    it(`${name}: гейт присутній рівно один раз`, () => {
      expect(b.split(GATE).length - 1, `${name}: гейта немає або він не один`).toBe(1);
    });

    it(`${name}: гейт — ОПЕРАТОР у where-цепочці, а не коментар`, () => {
      /* ⚠️ Без цього тест зеленів би на `-- and public.auth_radiologist_room_ok(...)`.
         Зрізаємо коментарі й дивимось, чи гейт лишився. */
      const code = b.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
      expect(code, `${name}: гейт живе лише в коментарі`).toContain(HELPER);
      expect(code, `${name}: гейт без InitPlan-форми — хелпер кликався б на кожен рядок`)
        .toContain("(select public.auth_role()) is distinct from 'radiologist'");
    });

    it(`${name}: гейт стоїть ПІСЛЯ межі центру, а не замість неї`, () => {
      /* Межа центру — головна; кабінетна її ЗВУЖУЄ. Якщо `clinic_id` зник,
         пакет замінив би одну межу іншою, а не додав другу. */
      const code = b.replace(/--[^\n]*/g, " ");
      const iClinic = code.indexOf("w.clinic_id = v_clinic");
      const iGate = code.indexOf(GATE);
      expect(iClinic, `${name}: межа центру зникла`).toBeGreaterThan(-1);
      expect(iGate, `${name}: гейт не знайдено в коді`).toBeGreaterThan(iClinic);
    });
  }
});

describe("0193: різниця з 0104/0105 — РІВНО один кон'юнкт", () => {
  /* Це та сама властивість, яку доводить збирач, але тут вона перевіряється
     в CI на ФАЙЛАХ у дереві. Якщо хтось «трохи поправить» функцію поруч із
     гейтом, шапка 0193 («один кон'юнкт») стане неправдою — і впаде тут. */
  /* ⚠️ ІМЕНА ТЕСТІВ КАЖУТЬ «нормалізовано», а не «побайтово», і це правка
     після ревʼю: порівняння йде через `norm()`, тобто з нормалізованими
     пробілами. Перша редакція називала це «побайтово» — саме той різновид
     дрібної неправди, проти якого написаний решта пакета. */
  it("waitlist_candidates_for_slot: зняти гейт → нормалізовано = 0104", () => {
    expect(norm(BODY_NEW_CANDIDATES.replace(GATE, ""))).toBe(norm(BODY_OLD_CANDIDATES));
  });

  it("waitlist_counts: зняти гейт → нормалізовано = 0105", () => {
    expect(norm(BODY_NEW_COUNTS.replace(GATE, ""))).toBe(norm(BODY_OLD_COUNTS));
  });

  it("КОНТРОЛЬ: детектор бачить зникнення гейта", () => {
    /* Синтетичний контроль. Без нього обидва тести вище лишились би зеленими
       на функції, з якої гейт ПРИБРАЛИ, — бо «зняти гейт» із тіла без гейта
       нічого не змінює, і порівняння зі старим тілом зійшлося б. */
    const withoutGate = BODY_NEW_CANDIDATES.replace(GATE, "");
    expect(withoutGate.split(GATE).length - 1, "контроль: гейт не зник").toBe(0);
    expect(withoutGate.includes(HELPER), "контроль: хелпер лишився після зрізу").toBe(false);
    expect(norm(withoutGate), "контроль: тіло без гейта дорівнює тілу з гейтом")
      .not.toBe(norm(BODY_NEW_CANDIDATES));
  });
});

describe("0193: список №19 і проза, яку пакет виправляє", () => {
  const guardBody = (() => {
    const o = "\nas $function$";
    const c = "\n$function$;";
    const a = MIG.indexOf(o);
    return MIG.slice(a + o.length, MIG.indexOf(c, a) + 1);
  })();

  it("у списку рівно 40 рядків", () => {
    const rows = guardBody.match(/\('[a-z_]+\([^)]*\)','[0-9a-f]{32}','secdef=/g) || [];
    expect(rows.length).toBe(40);
  });

  it("обидва підписи в списку, з md5 тіл із цього ж файла", () => {
    for (const [sig, b] of [
      ["waitlist_candidates_for_slot(p_room uuid, p_date date, p_time_min integer)", BODY_NEW_CANDIDATES],
      ["waitlist_counts(p_modality text)", BODY_NEW_COUNTS],
    ] as const) {
      expect(guardBody, `${sig}: підпису немає у списку`).toContain(`('${sig}','${norm(b)}',`);
    }
  });

  it("проза більше НЕ каже «22 підписи» як твердження", () => {
    /* ⚠️ Перевіряється ФОРМА ТВЕРДЖЕННЯ, а не фраза: заміна свідомо ЦИТУЄ
       старий текст («до 0193 тут стояло «22 підписи»…»), тож сама фраза в
       тілі лишається. Перша редакція цього асерта в збирачі на ній і
       спіткнулась. */
    expect(guardBody).not.toContain("ЩО ПІНИМО (22 підписи");
    expect(guardBody).toContain("ЩО ПІНИМО (сьогодні 40 підписів");
  });

  it("борг 0192 названий прямо, а не замовчаний", () => {
    /* Пакет виправляє чужу (мою ж) недоробку. Якщо виправлення є, а згадки
       про причину немає — наступний читач вважатиме, що так і було. */
    expect(guardBody).toContain("ДЖЕРЕЛО ІСТИНИ ПРО СКЛАД");
    expect(guardBody).toContain("0192 оновила");
  });
});

describe("0193: фрагменти накату/відкату", () => {
  it("statement_timeout стоїть ЗОВНІ блоку do", () => {
    /* ⚠️ ШУКАЄМО В КОДІ, А НЕ В ТЕКСТІ. Перша редакція брала
       `f.indexOf("set statement_timeout")` — і потрапляла в ПОЯСНЮВАЛЬНИЙ
       КОМЕНТАРІЙ («`set statement_timeout` СТОЇТЬ ЗОВНІ БЛОКУ…»), який стоїть
       на 3 рядки вище самого оператора. Через це мутація «перенести бюджет
       усередину do» лишала тест ЗЕЛЕНИМ: коментар нікуди не дівався, і
       позиція першого входження була все ще до `do`. Стенд (F1) це показав. */
    for (const [name, f] of [["apply", APPLY], ["dryrun", DRYRUN], ["rollback", ROLLBACK]] as const) {
      const code = f.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
      const iSet = code.indexOf("set statement_timeout");
      const iDo = code.indexOf("do $apply$");
      expect(iSet, `${name}: немає бюджету часу як ОПЕРАТОРА`).toBeGreaterThan(-1);
      expect(iDo, `${name}: немає блоку do`).toBeGreaterThan(-1);
      expect(iSet, `${name}: statement_timeout усередині do — він там ІНЕРТНИЙ`).toBeLessThan(iDo);
      /* І окремо: усередині блоку його бути НЕ МУСИТЬ узагалі. */
      expect(code.slice(iDo), `${name}: бюджет часу перевстановлюють усередині do`)
        .not.toContain("set_config('statement_timeout'");
    }
  });

  it("накат несе ЧЕРВОНІ базиси: гейта немає ДО і є ПІСЛЯ", () => {
    const code = APPLY.replace(/--[^\n]*/g, " ");
    expect(code, "немає червоного базису «гейт уже стоїть»").toContain("гейт уже стоїть");
    expect(code, "немає зеленого базису «гейт не став»").toContain("гейт не став");
  });

  it("накат звіряє ЧИСЛО функцій, а не having count", () => {
    /* ⚠️ Перевіряється ВЛАСТИВІСТЬ, а не форматування. Перша редакція цього
       асерта шукала `))) <> 2 then` — тобто вгадувала кількість дужок — і
       впала на `])) <> 2 then`. Урок 0192 («having count(*) <> 1 на
       ВІДСУТНЬОМУ імені не спрацьовує взагалі: нуль рядків не утворює групи»)
       стосується того, ЩО порівнюють, а не того, як розставлені дужки. */
    /* ⚠️ І ДРУГИЙ УРОК, уже третій раз у цій сесії: заборонену конструкцію
       треба шукати в КОДІ, а не в тексті файла. Фрагмент СВІДОМО цитує
       анти-патерн у коментарі («Звіряється ЧИСЛО, а не `having count(*)
       <> 1`…»), тож перевірка по сирому тексту червоніла на власному
       поясненні. Те саме вже ловило детектор гейта вище і асерт «22 підписи»
       у збирачі. */
    const code = APPLY.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
    expect(code, "немає порівняння з числом 2").toContain("<> 2 then");
    expect(code, "використано having count — на відсутньому імені воно сліпе")
      .not.toContain("having count");
  });

  it("накат доводить склейку на ЧИННОМУ стані до передруку", () => {
    const iProve = APPLY.indexOf("склейка не відтворює functiondef");
    const iExec = APPLY.indexOf("execute v_head || v_new");
    expect(iProve).toBeGreaterThan(-1);
    expect(iProve, "склейка доводиться ПІСЛЯ передруку — це нічого не доводить").toBeLessThan(iExec);
  });

  it("після рядка леджера очікується РІВНО ledger_md5", () => {
    expect(APPLY).toContain("очікувався РІВНО ledger_md5");
  });

  it("dryrun відкочує транзакцію навмисно", () => {
    expect(DRYRUN).toContain("DRYRUN_0193_ROLLBACK");
    expect(APPLY, "накат не має відкочувати сам себе").not.toContain("DRYRUN_0193_ROLLBACK");
  });

  it("відкат повертає ОБА тіла і тіло сторожа", () => {
    expect(ROLLBACK).toContain("тіла не повернулись");
    expect(ROLLBACK).toContain("гейт лишився в тілі");
    expect(ROLLBACK).toContain("зворотні пари дали");
  });

  it("відкат називає ДВІ законні гілки стану сторожа", () => {
    /* Після відкату №7 може бути і зеленим, і червоним — залежно від того,
       ганяли `db:gate` після накату чи ні. Фрагмент, що допускає будь-який
       порушник, не перевіряє нічого; фрагмент, що вимагає ok:true, впав би
       на законному стані. */
    expect(ROLLBACK).toContain("ДВІ ЗАКОННІ ГІЛКИ");
    expect(ROLLBACK).toContain("ledger_md5");
  });

  it("відкат несе ОКРЕМИЙ запит після commit", () => {
    expect(ROLLBACK).toContain("НЕ ДОВОДИТЬ ВІДКАТУ");
    expect(ROLLBACK).toContain("ОКРЕМИМ запитом");
  });
});

describe("0193: dryrun ≡ накат (окрім навмисного відкату)", () => {
  /* ⚠️ Додано після ревʼю. `0193_dryrun.sql` — єдиний файл, яким оператор
     знижує ризик накату, і до цієї правки його тримали ДВА асерти: наявність
     рядка `DRYRUN_0193_ROLLBACK` і позиція `statement_timeout`. Його DDL, його
     md5-константи й базиси не звірялись НІ З ЧИМ. Dry run, що розійшовся з
     накатом, друкує «усе добре» й дає зелене світло стану, якого накат не
     утворить. */
  const strip = (s: string) =>
    s.split("\n")
      .filter((l) => !l.includes("0193_apply.sql") && !l.includes("0193_dryrun.sql"))
      .filter((l) => !l.includes("DRYRUN") && !l.includes("транзакцію відкочено навмисно"))
      .join("\n").trim();

  it("тіла фрагментів сходяться рядок у рядок", () => {
    expect(strip(DRYRUN)).toBe(strip(APPLY));
  });

  it("dryrun НЕ втратив ані рядка леджера, ані асерта на нього", () => {
    /* Dry run, який не доходить до вставки, не доводить найтоншого місця. */
    expect(DRYRUN).toContain("insert into public.migration_ledger");
    expect(DRYRUN).toContain("очікувався РІВНО ledger_md5");
  });

  it("dryrun завершується відкотом, а накат — ні", () => {
    expect(DRYRUN).toContain("DRYRUN_0193_ROLLBACK");
    expect(APPLY, "накат не має відкочувати сам себе").not.toContain("DRYRUN_0193_ROLLBACK");
  });
});

describe("0193: ВІДКАТ несе правильну начинку, а не лише правильні слова", () => {
  /* ⚠️ Додано після ревʼю — це була найбільша дірка покриття. Тести перевіряли
     в `0193_rollback.sql` пʼять РЯДКІВ ТЕКСТУ і жодного разу — його payload.
     Відкат із підміненими md5 (на нові замість предстану) перетворюється на
     no-op, який стверджує стан ПІСЛЯ накату і рапортує `ROLLBACK_OK`: тести
     зелені, стенд зелений, `db:gate` зелений — а дізнаєшся в проді, усередині
     червоного вікна. */
  const PRE_CAND = "64cc243f5bc52c7a157bd3c610e9ff69";
  const PRE_CNT = "cc2c999dff6ad82b9a8687443fad64ba";
  const PRE_GUARD = "58f496e7efa1a502dde4b6621fe3c2ae";

  it("відкат відновлює ТІЛА 0104/0105, а не щось схоже", () => {
    for (const [tag, oldBody, name] of [
      ["$ddl_a$", BODY_OLD_CANDIDATES, "waitlist_candidates_for_slot"],
      ["$ddl_b$", BODY_OLD_COUNTS, "waitlist_counts"],
    ] as const) {
      const a = ROLLBACK.indexOf(tag);
      const b = ROLLBACK.indexOf(tag, a + tag.length);
      expect(a, `${name}: секції ${tag} у відкаті немає`).toBeGreaterThan(-1);
      expect(b, `${name}: секція ${tag} не закрита`).toBeGreaterThan(a);
      const payload = ROLLBACK.slice(a + tag.length, b);
      const o = "\nas $$";
      const bodyInRollback = payload.slice(payload.indexOf(o) + o.length, payload.lastIndexOf("\n$$;") + 1);
      expect(norm(bodyInRollback), `${name}: відкат кладе НЕ тіло 0104/0105`).toBe(norm(oldBody));
      expect(bodyInRollback.includes(HELPER), `${name}: у тілі відкату лишився гейт`).toBe(false);
    }
  });

  it("відкат цілить у ПРЕДСТАН, а не в стан після накату", () => {
    /* ⚠️ ПЕРЕВІРЯЄМО КОД, А НЕ ФАЙЛ. Перша редакція робила
       `expect(ROLLBACK).toContain(PRE_CAND)` — і стенд (V1) показав, що це
       нічого не тримає: кожен предстан у фрагменті стоїть ДВІЧІ (в асерті й у
       післякомітному коментарі), тож підміна в АСЕРТІ лишала тест зеленим на
       комментарі. Це вже четвертий раз у цьому пакеті, коли перевірка по
       сирому тексту ловить власну прозу замість коду. */
    const code = ROLLBACK.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
    expect(code, "асерт відкату не цілить у предстан candidates").toContain(PRE_CAND);
    expect(code, "асерт відкату не цілить у предстан counts").toContain(PRE_CNT);
    expect(code, "асерт відкату не цілить у предстан сторожа").toContain(PRE_GUARD);
    /* ⚠️ СИМЕТРИЧНОЇ ПЕРЕВІРКИ «у коді відкату немає md5 ПІСЛЯ накату» ТУТ
       НЕМА, і це не забудькуватість. Перша редакція її додала — і впала на
       ЧИСТІЙ базовій лінії, тобто на правильному фрагменті. Причина:
       зворотні пари підстановок (`v_from`) МУСЯТЬ містити НОВИЙ текст,
       включно з новими md5 у рядках списку №19, — інакше вони не знайдуть,
       що замінювати. Плюс окремий асерт «у проді зараз мусить лежати 0193»
       законно тримає новий md5 сторожа. Заборона була б забороною на те, без
       чого відкат не працює. Те, що дійсно треба тримати, тримають
       `PRE_*` вище і перевірка НАЧИНКИ в тесті поруч. */
  });

  it("післякомітний блок відкату несе ТІ САМІ числа і прогін сторожа", () => {
    const tailAt = ROLLBACK.indexOf("НЕ ДОВОДИТЬ ВІДКАТУ");
    expect(tailAt, "немає післякомітного блоку").toBeGreaterThan(-1);
    const tail = ROLLBACK.slice(tailAt);
    for (const v of [PRE_GUARD, PRE_CAND, PRE_CNT]) {
      expect(tail, `у післякомітному блоці немає ${v}`).toContain(v);
    }
    expect(tail, "післякомітний блок не просить прогнати сторожа")
      .toContain("invariants_check(false)");
    expect(tail, "лічильник леджера замість перевірки ІМЕНІ")
      .toContain("where name = '0193_definer_room_gate.sql'");
  });
});
