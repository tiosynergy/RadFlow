/**
 * Піни CHECK-constraint-а `clinics_timezone_chk` (міграція 0192, розвилка 9
 * рішень власника — `docs/audit/DECISIONS-2026-09-13-s68.md`).
 *
 * ЩО ЦЕЙ ФАЙЛ СТЕРЕЖЕ І ЧОГО НЕ СТЕРЕЖЕ — названо одразу, бо межа тут вузька:
 *
 *   СТЕРЕЖЕ: узгодженість ШЕСТИ місць, які мусять казати про список поясів
 *   одне й те саме:
 *     1) DDL у міграції (`add constraint`);
 *     2) дайджест `k:clinics` у передруку тієї ж міграції;
 *     3) УМОВА передумови у фрагменті накату (`not in`);
 *     4) ДІАГНОСТИКА тієї ж передумови (підзапит у тексті `raise`);
 *     5) `add constraint` кроку 2 фрагмента;
 *     6) повторне додавання в червоному базисі «в».
 *   Окремо — асерт РЕНДЕРА (`pg_get_constraintdef`), у нього свій тест.
 *   ⚠️ ТУТ СТОЯЛО «ПʼЯТИ», і перелік не збігався з власними асертами файла:
 *   він забував `add constraint` кроку 2 — найважливіше з усіх місць — і
 *   рахував серед «трьох у фрагменті» асерт рендера, який перевіряється
 *   окремо. У пакеті, метод якого «проза мусить дорівнювати коду», це рівно
 *   той дефект, який пакет шукає в інших.
 *
 *   НЕ СТЕРЕЖЕ: стан ПРОДА. Це порівняння файлів між собою. Що в базі
 *   справді стоїть цей constraint, доводить асерт рендера в накаті і
 *   `invariants_check` через гілку `k:` перевірки №23 — не цей тест.
 *
 * ⚠️ ЧОМУ ЦЕ НЕ ПАРАНОЙЯ, А ЗАМІРЯНИЙ КЛАС ВІДМОВИ: дайджест `k:clinics`
 *    порахований із РЕНДЕРА Postgres (`pg_get_constraintdef`) на temp-таблиці.
 *    Додавання четвертого поясу правкою одного рядка DDL лишає дайджест
 *    старим — і №23 червоніє у ПРОДІ, всередині транзакції накату, коли
 *    міняти вже нічого. Цей тест ловить розбіжність у дереві, до накату.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const MIG = readFileSync("supabase/migrations/0192_tz_check_fn_pins.sql", "utf8").replace(/\r/g, "");
const APPLY = readFileSync("scripts/frag/0192_apply.sql", "utf8").replace(/\r/g, "");

/** Заміряний 13.09 дайджест `k:clinics` ПІСЛЯ додавання constraint-а. */
const DIG_AFTER = "5:588baa1ac5d2";
/** Він же ДО — потрібен червоному базису «в» і відкату. */
const DIG_BEFORE = "4:02b846e4eab4";

/**
 * Списки поясів, що СТЕРЕЖУТЬ ЗАПИС: тільки ті, що стоять після
 * `timezone in (` або `timezone not in (`.
 *
 * ⚠️ ПЕРША РЕДАКЦІЯ ЦЬОГО ХЕЛПЕРА БРАЛА ЛЮБИЙ дужковий список рядкових
 *    літералів — і тест упав на ПРОЗІ: коментар кроку 1 міграції називає
 *    ЗАМІРЯНІ живі значення `('Europe/Kiev', 'UTC')`, і це правильний текст,
 *    а не четверте місце списку. Хелпер, що не розрізняє гард і прозу, дає
 *    або хибний червоний (як тут), або тиск «підігнати прозу під регулярку».
 */
function tzLists(text: string): string[][] {
  return [...text.matchAll(/timezone\s+(?:not\s+)?in\s*\(\s*('[^)]*?')\s*\)/g)]
    .map((m) => m[1].split(",").map((s) => s.trim().replace(/'/g, "")));
}

describe("0192 clinics_timezone_chk — узгодженість списку поясів", () => {
  it("міграція додає constraint саме з трьома заміряними значеннями", () => {
    expect(MIG).toContain("add constraint clinics_timezone_chk");
    expect(MIG).toContain("check (timezone in ('Europe/Kyiv', 'Europe/Kiev', 'UTC'))");
  });

  it("`Europe/Kiev` У СПИСКУ — це замір прода, не описка", () => {
    /* Із двох живих центрів один сидить на legacy-алиасі. Прибрати його зі
       списку означає завалити `add constraint` на валідації існуючого рядка.
       Зганяння прода з алиаса — задача фази 2 таймзон, і вона названа
       межею 1 у шапці міграції. */
    expect(MIG).toContain("'Europe/Kiev'");
    expect(MIG).toContain("legacy-алиас");
  });

  it("у міграції гард поясів РІВНО один, і він той самий", () => {
    /* Число точне, а не «>= 1», свідомо: другий гард у файлі міграції означав
       би, що список живе у двох місцях, і наступна правка однією рукою
       розсинхронізує їх. Проза, що ЗГАДУЄ пояси, під регулярку не потрапляє —
       див. хелпер вище. */
    const lists = tzLists(MIG);
    expect(lists).toHaveLength(1);
    expect(lists[0]).toEqual(["Europe/Kyiv", "Europe/Kiev", "UTC"]);
  });

  it("у фрагменті накату гардів РІВНО чотири, і всі чотири однакові з міграцією", () => {
    /* Їх саме чотири, і кожен на місці:
         1) УМОВА передумови кроку 0 (`not in`);
         2) ДІАГНОСТИКА тієї ж передумови — підзапит у тексті `raise`, який
            перелічує, ЯКІ саме значення випали. Дублювання тут свідоме:
            умова і діагностика мусять дивитись на один список, інакше
            оператор прочитає «щось не так» без «що саме»;
         3) `add constraint` кроку 2;
         4) повторне додавання в червоному базисі «в».
       ⚠️ Число точне. Перша редакція цього тесту чекала три і впала — і це
          правильна відмова: вона змусила ПЕРЕЛІЧИТИ місця, а не підняти
          межу до «>= 3» і перестати їх бачити. */
    const lists = tzLists(APPLY);
    expect(lists).toHaveLength(4);
    for (const l of lists) expect(l).toEqual(["Europe/Kyiv", "Europe/Kiev", "UTC"]);
  });

  it("асерт РЕНДЕРА в накаті несе ті самі три значення в тому самому порядку", () => {
    /* Дайджест `k:clinics` порахований із рендера Postgres, а не з тексту
       DDL. Якщо рендер розійдеться — №23 почервоніє в проді. */
    expect(APPLY).toContain(
      "CHECK ((timezone = ANY (ARRAY[''Europe/Kyiv''::text, ''Europe/Kiev''::text, ''UTC''::text])))",
    );
  });

  it("передрук у ТІЙ САМІЙ міграції несе НОВИЙ дайджест k:clinics", () => {
    expect(MIG).toContain(`('k:clinics','${DIG_AFTER}')`);
    /* Старий дайджест у передруку означав би, що DDL додано, а пін №23 — ні:
       рівно та відмова, через яку ця міграція взагалі одна, а не дві. */
    expect(MIG).not.toContain(`('k:clinics','${DIG_BEFORE}')`);
  });

  it("червоний базис «в» адресує ОБИДВА дайджести в правильному напрямку", () => {
    /* Без напрямку базис сумісний із «№23 червоніє на будь-що». */
    expect(APPLY).toContain(`changed:k:clinics:${DIG_AFTER}->${DIG_BEFORE}`);
  });

  it("червоний базис «б» доводить, що CHECK ПРОПУСКАЄ законне значення", () => {
    /* Constraint, що відкидає ВСЕ, задовольнив би базис «а» («ловить
       описку»). Без «б» пара базисів не розрізняє сторожа і глухі двері. */
    expect(APPLY).toContain("ЧЕРВОНИЙ БАЗИС (б) НЕ СПРАЦЮВАВ");
    expect(APPLY).toContain("update public.clinics set timezone = 'Europe/Kyiv' where id = v_id");
  });

  it("базис «б» ПОВЕРТАЄ заміряне значення, а не лишає прод правленим", () => {
    /* Це прод. Before-образ живе у `v_tz`, правка адресує один id, і
       повернення перевіряється окремим читанням. */
    expect(APPLY).toContain("update public.clinics set timezone = v_tz where id = v_id");
    expect(APPLY).toContain("не повернуто вихідний timezone");
  });

  it("накат вимагає роль-грантора postgres (інакше revoke у базисі «д» — no-op)", () => {
    expect(APPLY).toContain("current_user <> 'postgres'");
  });

  it("базис «а» звіряє ІМʼЯ constraint-а, що спрацював, а не лише клас помилки", () => {
    /* ⚠️ `when check_violation then null` доводить лише «ЯКИЙСЬ check на
       `clinics` відкинув рядок». Їх там ЧОТИРИ (cascade, overlap,
       delay_policy і наш), тож будь-який інший задовольнив би базис при
       мертвому `clinics_timezone_chk`. Знайшло ревʼю. */
    expect(APPLY).toContain("get stacked diagnostics v_con = constraint_name");
    expect(APPLY).toContain("v_con is distinct from 'clinics_timezone_chk'");
    expect(APPLY).toContain("спрацював ЧУЖИМ constraint-ом");
  });

  it("накат вимагає РІВНО пʼять функцій на пʼять нових імен", () => {
    /* ⚠️ Перша редакція асерту рахувала `having count(*) <> 1` — і на
       ВІДСУТНЬОМУ імені не спрацьовувала взагалі: нуль рядків не утворює
       групи. Тобто «перевантажень немає» проходило й тоді, коли функції
       немає зовсім. Знайшло ревʼю. */
    expect(APPLY).toContain("<> 5 then");
    expect(APPLY).toContain("перевантаження або відсутність");
  });

  it("бюджет часу стоїть ЗОВНІ do-блоку, бо всередині він інертний", () => {
    /* ⚠️ ЗАМІРЯНО 13.09: `set_config('statement_timeout', …, true)` усередині
       `do` не перезбирає таймер — він армується на старті команди, а весь
       блок є ОДНОЮ командою. Проба: ambient 1s + set_config 30s + sleep(3)
       → 57014. Тобто 0185/0190/0191 оголошували бюджет, якого не мали. */
    const iSet = APPLY.indexOf("set statement_timeout = '5min';");
    const iDo = APPLY.indexOf("do $apply$");
    expect(iSet, "немає statement_timeout зовні блоку").toBeGreaterThan(-1);
    expect(iSet, "statement_timeout мусить стояти ДО do-блоку").toBeLessThan(iDo);
    /* ⚠️ Шукаємо ВИКОНУВАНУ форму (`perform set_config(...)`), а не підрядок
       `set_config('statement_timeout'`: шапка фрагмента ЦИТУЄ пробу, якою
       інертність і доведено, тож голий підрядок червонив би на власному
       поясненні. Перша редакція цього рядка так і зробила — базова лінія
       стенда стала червоною, і це той самий клас, що урок с65 у
       `stoppedIncidents`: пін, який ламає чесний коментар, — шум. */
    expect(APPLY, "старий інертний виклик лишився всередині блоку")
      .not.toContain("perform set_config('statement_timeout'");
  });

  it("коментар на constraint їде в ПРОД, а не лише у файл міграції", () => {
    /* ⚠️ Ревʼю знайшло, що `comment on constraint` жив ТІЛЬКИ у файлі
       міграції, а в прод їде фрагмент — тобто constraint приїхав би без
       коментаря, і не побачило б цього НІЩО: гілка `k:` перевірки №23
       дайджестить `conname|contype|constraintdef`, коментарі туди не входять.
       Тепер він у фрагменті, і саме ПІСЛЯ базисів: базис «в» робить
       `drop constraint`, який зніс би коментар, поставлений раніше. */
    expect(APPLY).toContain("comment on constraint clinics_timezone_chk on public.clinics is");
    const iComment = APPLY.indexOf("comment on constraint clinics_timezone_chk");
    const iBasisV = APPLY.indexOf("alter table public.clinics drop constraint clinics_timezone_chk");
    expect(iBasisV).toBeGreaterThan(-1);
    expect(iComment, "коментар стоїть ДО базису «в» — той drop зніс би його молча")
      .toBeGreaterThan(iBasisV);
    expect(APPLY, "фрагмент не звіряє, що коментар справді став")
      .toContain("obj_description(oid, 'pg_constraint')");
  });

  it("текст коментаря в міграції і у фрагменті — той самий", () => {
    /* Два місця, один текст: інакше файл документує стан, якого в базі немає. */
    const body = (t: string) => {
      const a = t.indexOf("'Список свідомий: властивості немає");
      const b = t.indexOf("0192.';", a);
      if (a < 0 || b < 0) throw new Error("текст коментаря не знайдено");
      return t.slice(a, b).replace(/\s+/g, " ");
    };
    expect(body(APPLY)).toBe(body(MIG));
  });

  it("коментар називає межу NULL, якої CHECK не ловить", () => {
    /* Заміряно: `null in (…)` дає NULL, а CHECK порушенням вважає лише FALSE.
       Тобто NULL цей constraint ПРОПУСКАЄ — тримає його окремий `not null`.
       Межа мусить стояти і в шапці, і в коментарі на самому constraint-і:
       читач у базі бачить тільки другий. */
    expect(MIG).toContain("NULL цей CHECK НЕ ловить");
    expect(APPLY).toContain("NULL цей CHECK НЕ ловить");
    expect(MIG).toContain("CHECK НЕ ЛОВИТЬ NULL");
  });

  it("шапка міграції називає межу: CHECK не стереже ЧИТАННЯ", () => {
    /* Найдорожча з названих меж: якщо tzdata викине `Europe/Kiev`, constraint
       лишиться зеленим (його не перевіряють повторно), а `at time zone` у
       розписанні почне падати. Прибрати цю межу з шапки = збрехати про те,
       що куплено за цю міграцію. */
    expect(MIG).toContain("CHECK стереже ЗНАЧЕННЯ, а не ЧИТАННЯ");
  });
});
