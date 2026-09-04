/* Статичний сторож 0175: у `profiles` немає типових значень, що роздають права.
 *
 * ЧОМУ ВІН ІСНУЄ. Замір на проді 04.09.2026: `role user_role not null default
 * 'admin'::user_role` і `approved boolean not null default true`. Тобто рядок,
 * вставлений БЕЗ ролі, мовчки ставав адміністратором, а без `approved` —
 * одразу підтвердженим. Аудит Ф6 назвав це RF-4; код-половину закрито в
 * пакеті 26, схемну — міграцією 0175.
 *
 * ⚠️ ЧОГО ЦЕЙ ФАЙЛ НЕ ДОВОДИТЬ: він читає ТЕКСТ передрука, а не виконує SQL.
 *    «Перевірка написана» ≠ «перевірка ловить» — останнє доводить зонд із
 *    відкотом на проді (рецепт у шапці 0175) і смоук.
 *
 * ⚠️ Джерело — ОСТАННІЙ передрук, а не файл 0175 за іменем (урок с47/с55).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const MIGDIR = resolve(process.cwd(), "supabase/migrations");

function latestReprint(): { fn: string; file: string } {
  const files = readdirSync(MIGDIR).filter((f) => f.endsWith(".sql")).sort();
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

const { fn: SRC, file: FILE } = latestReprint();

/* ⚠️ ВІКНО САМОЇ ПЕРЕВІРКИ, а не весь передрук (урок 0172: пін, знятий по
   всьому тілу, ловився на легальному коді сусідньої перевірки і був
   хибно-зеленим). Межі — від кроку лічильника перед нею до її звіту.
   ⚠️ ЛІНИВО, а не на рівні модуля: якщо перевірку прибрати з передрука, кидок
   із верхнього рівня повалив би ВЕСЬ файл ще до збору тестів — стенд отримав
   би «червоне з порожньою таблицею», тобто не зміг би назвати сторожа. Тепер
   падає кожен тест окремо і зі своїм іменем. */
function block20(): string {
  const at = SRC.indexOf("'check', 'profiles_defaults', 'offenders', to_jsonb(v_tmp)");
  if (at < 0) throw new Error(`${FILE}: перевірки profiles_defaults у передруку немає`);
  const from = SRC.lastIndexOf("  v_n := v_n + 1;", at);
  return SRC.slice(from, at + 200);
}

describe(`0175 — у profiles немає fail-open дефолтів (${FILE})`, () => {
  it("перевірка є в передруку і звітує у канонічній формі", () => {
    expect(SRC).toContain("'check', 'profiles_defaults', 'offenders', to_jsonb(v_tmp)");
  });

  it("дивиться саме на ДЕФОЛТИ саме таблиці profiles", () => {
    /* Без `pg_attrdef` перевірка міряла б щось інше; без прибитої таблиці —
       поїхала б по всій схемі і стала б вічно червоною. */
    expect(block20()).toContain("join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum");
    expect(block20()).toContain("a.attrelid = 'public.profiles'::regclass");
  });

  it("виняток — РІВНО дві колонки, і обидві fail-CLOSED", () => {
    /* Головний пін файлу. Розширити виняток — найдешевший спосіб тихо
       повернути дірку: `role` у списку означає «дефолт на ролі дозволений».
       `created_at` (now()) і `password_set` (false — «без пароля, доки не
       поставили») нікому прав не дають. */
    expect(block20()).toContain(
      "and a.attname <> all (array['created_at', 'password_set']);");
    const names = [...block20().matchAll(/array\[((?:'[a-z_]+'(?:,\s*)?)+)\]/g)]
      .flatMap((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
    expect(names.sort(), `${FILE}: склад винятку змінився`).toEqual(["created_at", "password_set"]);
  });

  it("offender несе САМ дефолт, а не лише імʼя колонки", () => {
    /* «На profiles зʼявився дефолт» без виразу змушує чергувальника лізти в
       каталог; з виразом червоне одразу каже, ЩО саме повернулось. */
    expect(block20()).toContain("'default:profiles.' || a.attname || '->'");
    expect(block20()).toContain("pg_get_expr(d.adbin, d.adrelid)");
  });

  it("прибрані колонки відсіяні — інакше сторож червонів би від привидів", () => {
    expect(block20()).toContain("a.attnum > 0 and not a.attisdropped");
  });

  /* ⚠️ DDL ЖИВЕ НЕ В «ОСТАННЬОМУ ПЕРЕДРУКУ», А В СВОЇЙ МІГРАЦІЇ, і шукати його
     треба саме так. Перша редакція цих двох тестів читала файл ОСТАННЬОГО
     передрука — і зламалась би ТИХО при першій же наступній міграції, що
     передруковує сторожа: DDL там немає і не буде (міграції append-only), а
     сьогодні обидва файли збігаються, тож дефект був би невидимий до того дня.
     Тому файл ЗНАХОДИТЬСЯ за вмістом, а не передбачається — і «рівно один»
     теж пін: два `drop default` у різних міграціях означали б, що дефолт
     повертали між ними. */
  const ddlFiles = readdirSync(MIGDIR).filter((f) => f.endsWith(".sql")).filter((f) =>
    /alter table public\.profiles alter column role\s+drop default;/
      .test(readFileSync(resolve(MIGDIR, f), "utf8")));

  it("міграція справді ЗНІМАЄ обидва дефолти, а не лише стереже їх", () => {
    /* Сторож без DDL був би декларацією: перевірка червоніла б на проді з
       першого ж прогону. */
    expect(ddlFiles, "міграції, що знімає дефолт із profiles.role, немає — або їх кілька")
      .toHaveLength(1);
    const mig = readFileSync(resolve(MIGDIR, ddlFiles[0]), "utf8");
    expect(mig).toContain("alter table public.profiles alter column approved drop default;");
  });

  it("секція ВІДКАТУ повертає рівно те, що знято", () => {
    expect(ddlFiles).toHaveLength(1);
    const mig = readFileSync(resolve(MIGDIR, ddlFiles[0]), "utf8");
    const at = mig.indexOf("=== ВІДКАТ ===");
    expect(at, `${ddlFiles[0]}: секції відкату немає`).toBeGreaterThan(0);
    const tail = mig.slice(at);
    expect(tail).toContain("alter column role     set default 'admin'::user_role;");
    expect(tail).toContain("alter column approved set default true;");
  });
});
