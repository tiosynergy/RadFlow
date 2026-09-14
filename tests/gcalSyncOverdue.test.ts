/**
 * Статичний сторож пакета 0194 (друга половина I-7): перевірка №13 мусить
 * бачити АВАРІЙНО ВИМКНЕНЕ дзеркало Google Calendar.
 *
 * ЧОМУ ВІН ІСНУЄ. Сліпота №13 була не помилкою предиката, а наслідком
 * інваріанта схеми: `gcal_enabled_invariant_chk` робить `enabled = true`
 * неможливим без `status = 'ready'`, тож шлях фатальної відмови ЗМУШЕНИЙ
 * гасити `enabled` — і рядок виходив з-під `where g.enabled`. Умову
 * розширили другою гілкою; тут стережеться, що в дереві лежить саме той
 * текст, який накатувався, і що гілка не звузилась назад тихою правкою.
 *
 * ⚠️ ЧОГО ЦЕЙ ФАЙЛ НЕ ДОВОДИТЬ: він читає ТЕКСТ, а не виконує SQL. «Гілка
 *    написана» ≠ «гілка червоніє». Останнє доводить зонд у
 *    `scripts/frag/0194_dryrun.sql` (зелений базис на старому тілі + червоний
 *    на новому, обидва на живій БД) і секції f3/f3b/f4/f5/f6 смоука
 *    `supabase/smoke/gcal_sync_overdue_smoke.sql`.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGDIR = resolve(process.cwd(), "supabase/migrations");
const FRAGDIR = resolve(process.cwd(), "scripts/frag");

const MIG = readFileSync(resolve(MIGDIR, "0194_gcal_blind_disable.sql"), "utf8").replace(/\r/g, "");
const APPLY = readFileSync(resolve(FRAGDIR, "0194_apply.sql"), "utf8").replace(/\r/g, "");
const DRYRUN = readFileSync(resolve(FRAGDIR, "0194_dryrun.sql"), "utf8").replace(/\r/g, "");
const ROLLBACK = readFileSync(resolve(FRAGDIR, "0194_rollback.sql"), "utf8").replace(/\r/g, "");
/* ⚠️ Смоук пакета — ОКРЕМИЙ файл, і це не стиль. Секції f3/f4/f5 спершу
   писались у `gcal_pg_cron_smoke.sql` (там живуть f/f2 — перша гілка №13),
   але заміряно 14.09: його секція g2 пінить тіло сторожа на значенні 0185
   (`8871cad0…`) при `0a036d5f…` у проді, тобто той файл не може завершитись
   зеленим із 0186. Обіцянка «живої перевірки» там була б обіцянкою того,
   чого оператор не побачить. */
const SMOKE = readFileSync(resolve(process.cwd(), "supabase/smoke/gcal_sync_overdue_smoke.sql"), "utf8").replace(/\r/g, "");
const FALSIFY_ALL = readFileSync(resolve(process.cwd(), "scripts/falsify-all.mjs"), "utf8").replace(/\r/g, "");

/* ПРЕДСТАН — ЗАМІРЯНО в проді 14.09.2026 12:25 (не переписано з claude/*).
   Якщо збирач колись зіпнеться на інший передрук, це впаде тут, а не в проді. */
const PRE_MD5 = "0a036d5f097fba3a11ca39c0c9885d93";
const PRE_LEN = 120547;

const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

/** Тіло сторожа між `as $function$` і `$function$;` — витяг збирача. */
function guardBody(txt: string): string {
  const o = "\nas $function$";
  const c = "\n$function$;";
  const a = txt.indexOf(o);
  const b = txt.indexOf(c, a);
  if (a < 0 || b < 0) throw new Error("межі тіла сторожа не знайдено");
  return txt.slice(a + o.length, b + 1);
}

/* ⚠️ КОД, А НЕ ФАЙЛ. Це не стиль, а лікування конкретної хвороби: у цьому
   домі асерт уже чотири рази зеленів (або червонів) на ВЛАСНОМУ пояснювальному
   коментарі — проза пакета цитує і предикат, і обидва статуси, і md5. Тому
   кожна перевірка «чи є в коді» ріже коментарі ПЕРШОЮ дією. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

const BODY = guardBody(MIG);
const BODY_CODE = stripComments(BODY);
const APPLY_CODE = stripComments(APPLY);
const DRYRUN_CODE = stripComments(DRYRUN);
const ROLLBACK_CODE = stripComments(ROLLBACK);

const count = (hay: string, needle: string) => hay.split(needle).length - 1;

describe("0194: друга гілка №13 — КОД, а не коментар", () => {
  it("умова ловить рівно два аварійні статуси", () => {
    expect(count(BODY_CODE, "or (not g.enabled"), "другої гілки немає або вона не одна").toBe(1);
    expect(count(BODY_CODE, "and g.status in ('reauth_required', 'access_lost'))"),
      "список статусів не той, що обіцяє шапка").toBe(1);
    /* І симетрично: у ПРЕДИКАТІ не має бути станів із таблиці «НЕ offender».
       Вони названі у прозі — тому дивимось саме на код. */
    for (const st of ["not_connected", "connected_no_calendar"]) {
      expect(BODY_CODE, `стан ${st} потрапив у предикат — гілка (b) шумітиме`).not.toContain(st);
    }
    expect(count(BODY_CODE, "g.status in ("), "умов по статусу більше однієї").toBe(1);
  });

  it("перша гілка лишилась недоторканою", () => {
    /* Пакет РОЗШИРЮЄ умову, а не підміняє її. Якщо перша гілка зникне,
       «увімкнене, але не синкається» перестане ловитись — а це і є те, для
       чого №13 писалась у 0161. */
    expect(count(BODY_CODE, "coalesce(g.last_sync_at, g.connected_at, g.created_at)"),
      "відліку першої гілки немає або він не один").toBe(1);
    expect(count(BODY_CODE, "interval '30 minutes'"), "порогу першої гілки немає").toBe(1);
    expect(count(BODY_CODE, "(g.enabled\n"), "гілки (a) по прапорцю немає").toBe(1);
  });

  it("стара однорядкова умова зникла як оператор", () => {
    expect(BODY_CODE, "стара умова `where g.enabled` лишилась — підстановка не спрацювала")
      .not.toContain("\n       where g.enabled\n");
  });

  it("мітка гілки стоїть ПІСЛЯ префікса clinic_id", () => {
    /* ⚠️ Це не косметика. Смоук `gcal_pg_cron_smoke.sql` (секції f/f2) шукає
       порушників як `o like left(clinic_id::text, 8) || ':%'`. Якщо мітку
       колись перенесуть ПЕРЕД префікс, ті дві секції протухнуть МОВЧКИ:
       offender-ів просто не знайдеться, і смоук скаже «чисто». */
    const iPrefix = BODY_CODE.indexOf("left(g.clinic_id::text, 8) || ':'");
    const iMark = BODY_CODE.indexOf("case when g.enabled then 'стоїть:'");
    expect(iPrefix, "префікс clinic_id зник — смоук f/f2 протухне").toBeGreaterThan(-1);
    expect(iMark, "мітки гілки немає").toBeGreaterThan(iPrefix);
    expect(count(BODY_CODE, "'відвалилось(' || g.status || '):'"),
      "мітка аварійної гілки не та, що в смоуку f3").toBe(1);
  });

  it("причина сліпоти названа в прозі саме як інваріант схеми", () => {
    /* Єдина перевірка, що ЧЕКАЄ коментар: проза №13 мусить нести CHECK, через
       який сліпота була неминучою. Без неї наступний читач знову вирішить, що
       то був недогляд предиката, і «спростить» умову назад. */
    expect(BODY, "проза №13 не називає gcal_enabled_invariant_chk").toContain("gcal_enabled_invariant_chk");
    /* ⚠️ ПРОБІЛ ПІСЛЯ КОМИ ТУТ — ЧАСТИНА ЦИТАТИ. `pg_get_constraintdef` віддає
       `ARRAY['writer'::text, 'owner'::text]`, і перша редакція прози прибрала
       цей пробіл заради ширини рядка, лишивши слово «ДОСЛІВНО». Ревʼю зміряло
       і показало розбіжність — тобто пакет, який лікує пересказ під виглядом
       заміру, сам його й ніс. Тест тепер пінить саме продову форму. */
    expect(BODY, "проза не цитує CHECK дослівно (звірено з pg_get_constraintdef)")
      .toContain("(access_role = ANY (ARRAY['writer'::text, 'owner'::text])))))");
  });

  it("проза називає ОБИДВА виходи з червоного, і безпечний — першим", () => {
    /* ⚠️ Найдорожча знахідка ревʼю: перша редакція писала «вихід рівно один —
       Відключити», а `disconnect/route.ts` відкликає токен у Google і видаляє
       секрет із Vault. Тобто проза В ТІЛІ СТОРОЖА гнала адміна в НЕОБОРОТНУ
       дію там, де досить перепідключення (обидва реальні виходи в проді 14.09
       були саме перепідключенням). Зняти таку пораду після накату коштувало б
       окремого пакета — тому вона пінеться. */
    expect(BODY, "проза не називає перепідключення виходом").toContain("connected_no_calendar");
    expect(BODY, "проза не попереджає про необоротність «Відключити»").toContain("НЕОБОРОТНО");
    expect(BODY, "проза не називає revokeToken").toContain("revokeToken");
    expect(BODY, "у прозі лишилось «вихід рівно один»").not.toContain("вихід із червоного\n  --        рівно один");
    const iReconnect = BODY.indexOf("«Підключити» знову");
    const iDisconnect = BODY.indexOf("«Відключити»");
    expect(iReconnect, "безпечного виходу в прозі немає").toBeGreaterThan(-1);
    expect(iReconnect, "необоротний вихід названий ПЕРШИМ").toBeLessThan(iDisconnect);
  });
});

describe("0194: число перевірок і пін №19 не зачеплені", () => {
  it("checked лишається 23", () => {
    expect(count(BODY_CODE, "v_n := v_n + 1;"), "число перевірок змінилось — це вже інший пакет").toBe(23);
  });

  it("у списку №19 рівно 40 підписів", () => {
    const m = BODY.match(/\('[a-z_]+\([^)]*\)','[0-9a-f]{32}','secdef=/g) || [];
    expect(m.length, "пакет зачепив список №19").toBe(40);
  });
});

describe("0194: фрагменти узгоджені з файлом міграції", () => {
  it("накат чекає рівно те тіло, що лежить у дереві", () => {
    /* md5 НЕ захардкоджений: він ВИВЕДЕНИЙ із файла міграції, а потім
       шукається у фрагменті. Так тест ловить головну біду передруків —
       фрагмент, зібраний з ІНШОЇ редакції тіла, ніж та, що в дереві. */
    expect(APPLY_CODE, "накат чекає не те тіло, що в дереві").toContain(md5(BODY));
    expect(APPLY_CODE, "накат чекає не ту довжину").toContain(String(BODY.length));
  });

  it("предстан у накаті — заміряний 0193, а не чуже число", () => {
    expect(APPLY_CODE, "накат не звіряє предстан із 0193").toContain(PRE_MD5);
    expect(APPLY_CODE, "накат не звіряє довжину предстану").toContain(String(PRE_LEN));
  });

  it("відкат — дзеркало накату по САМИХ ПАРАХ, а не на слово", () => {
    /* Беремо блоки масивів дослівно: `v_from` відкату мусить БУТИ `v_to`
       накату, і навпаки. Це сильніше за «чи є там новий текст»: ловить і
       зміну порядку, і втрату однієї пари.
       ⚠️ І чого тут НЕМА навмисно: асерту «у відкаті не має бути md5 нового
          тіла». У 0193 я такий написав — і він упав на чистому фрагменті,
          бо зворотні пари ЗОБОВʼЯЗАНІ містити новий текст: саме його вони
          шукають. Перевіряти треба НАПРЯМОК, а не присутність. */
    /* ⚠️ Пробіли в оголошенні ВИРІВНЯНІ (`v_to   constant`), тож пошук
       підрядком із одним пробілом не знаходив масив — і тест падав на «немає
       масиву v_to» замість того, щоб порівняти пари. Спіймано першим же
       прогоном; шукаємо регуляркою, терпимою до вирівнювання. */
    const arr = (txt: string, name: string) => {
      const re = new RegExp(`v_${name} +constant text\\[\\] := array\\[`);
      const m = txt.match(re);
      expect(m, `у фрагменті немає масиву v_${name}`).not.toBeNull();
      const i = (m as RegExpMatchArray).index as number;
      const j = txt.indexOf("\n  ];", i);
      return txt.slice(i + (m as RegExpMatchArray)[0].length, j);
    };
    expect(arr(ROLLBACK, "from"), "v_from відкату ≠ v_to накату").toBe(arr(APPLY, "to"));
    expect(arr(ROLLBACK, "to"), "v_to відкату ≠ v_from накату").toBe(arr(APPLY, "from"));
    expect(ROLLBACK_CODE, "відкат не повертає тіло до 0193").toContain(PRE_MD5);
    expect(ROLLBACK_CODE, "відкат не знімає рядка леджера")
      .toContain("delete from public.migration_ledger where name = '0194_gcal_blind_disable.sql'");
  });

  it("dryrun ≡ накат після зняття DRYRUN-ділянок", () => {
    /* ТЕ САМЕ правило, що в збирача, і воно мусить бути ТОЧНИМ: ділянка
       ріжеться разом із власними переводами рядків, на її місце не ставиться
       нічого. Перша редакція правила підставляла "\n" — і різниця виїхала на
       один зайвий перевід рядка (збирач це й поймав). */
    const stripDry = (s: string) => s
      .split("\n").slice(1).join("\n")
      .replace(/\n *-- >>> DRYRUN-ONLY:[\s\S]*?\n *-- <<< DRYRUN-ONLY\n/g, "");
    expect(stripDry(DRYRUN), "dryrun і накат розійшлись не лише зондом").toBe(stripDry(APPLY));
  });
});

describe("0194: зонд живе ТІЛЬКИ в dryrun і завжди прибирає за собою", () => {
  it("накат не торкається даних", () => {
    /* Накат — це передрук тіла, і більше нічого. Якщо в ньому колись
       з'явиться `update` таблиці зʼєднань, це вже міграція даних, а вона
       вимагає іншого ритуалу (явний список id і образи «до»). */
    expect(APPLY_CODE, "у накаті з'явилась правка даних").not.toContain("update public.google_calendar_connections");
    expect(APPLY_CODE, "у накаті лишився зонд").not.toContain("_p0194_before");
    expect(APPLY_CODE, "у накаті лишився маркер dryrun").not.toContain("DRYRUN-ONLY");
    expect(APPLY_CODE, "у накаті лишився навмисний відкат").not.toContain("DRYRUN_0194_ROLLBACK");
    expect(count(APPLY_CODE, "invariants_check(false)"),
      "накат кличе сторожа не двічі — крок 9 або 11 зник").toBe(2);
  });

  it("у dryrun кожен стимул має відновлення", () => {
    /* Зонд править ЖИВІ рядки (PK — clinic_id з FK на clinics, тож
       синтетичний рядок вимагав би синтетичної клініки). Транзакція завжди
       відкочується, але це НЕ підстава лишати стимул без відновлення:
       відкат — властивість транзакції, а не властивість фрагмента. */
    const mut = count(DRYRUN_CODE, "set enabled = false,");
    const res = count(DRYRUN_CODE, "set enabled = b.enabled, status = b.status, last_error_code = b.last_error_code");
    expect(mut, "стимулів у зонді не два").toBe(2);
    expect(res, "відновлень не стільки, скільки стимулів").toBe(mut);
    expect(count(DRYRUN_CODE, "0194-зонд: дані НЕ повернулись"),
      "відновлення не перевіряється запитом після кожного стимулу").toBe(2);
  });

  it("dryrun несе ОБА базиси — зелений і червоний", () => {
    expect(DRYRUN, "немає зеленого базису (сліпота на старому тілі)").toContain("ЗЕЛЕНИЙ БАЗИС");
    expect(DRYRUN, "немає червоного базису (ловля на новому тілі)").toContain("ЧЕРВОНИЙ БАЗИС");
    expect(DRYRUN_CODE, "зелений базис не асертить МОВЧАННЯ старого тіла")
      .toContain("if v_off is not null then");
    expect(DRYRUN_CODE, "червоний базис не асертить ЛОВЛЮ нового тіла")
      .toContain("if v_off is null then");
    expect(count(DRYRUN_CODE, "invariants_check(false)"),
      "dryrun кличе сторожа не чотири рази — базис або крок зник").toBe(4);
    /* ⚠️ І ВЛАСТИВІСТЬ, А НЕ ЛИШЕ ЛІТЕРАЛ. Ревʼю показало дірку: асерти вище
       ловлять `if v_off is not null then` як ТЕКСТ, тож обеззброїти базис
       можна було б, лишивши текст на місці — `if v_off is not null and false`.
       Тому окремо: у виконуваному коді зонда не має бути жодної константної
       заглушки. */
    for (const off of ["if false", " and false", "or true", "1 = 0"]) {
      expect(DRYRUN_CODE, `у зонді стоїть константна заглушка «${off}» — базис обеззброєно`)
        .not.toContain(off);
    }
    /* ⚠️ ДЕВʼЯТЬ — ЗМІРЯНО, а не пораховано в голові: перша редакція цього
       рядка чекала сім (я порахував асерти й забув два обробники блокувань і
       перевірку «в таблиці нема рядків»). Тест сам і показав. Розклад: по
       кожному зонду — обробник lock_timeout, асерт базису, асерт відновлення
       (6), плюс у червоному ще два (кількість порушників і мітка) і один
       спільний «нема рядків». */
    expect(count(DRYRUN_CODE, "raise exception '0194-зонд"),
      "асертів зонда не девʼять — один зняли").toBe(9);
  });
});

describe("0194: проза пакета не бреше числами", () => {
  it("ЯК НАКАТУВАТИ називає ті самі md5 і довжину, що й фрагменти", () => {
    expect(MIG, "у HOWTO не те md5 нового тіла").toContain(md5(BODY));
    expect(MIG, "у HOWTO не та довжина нового тіла").toContain(String(BODY.length));
    expect(MIG, "у секції ВІДКАТ не те md5 предстану").toContain(PRE_MD5);
    expect(MIG, "у секції ВІДКАТ не та довжина предстану").toContain(String(PRE_LEN));
  });

  it("обіцяні секції смоука існують і мають ЖИВІ асерти", () => {
    /* ⚠️ Перша редакція перевіряла лише наявність ЗАГОЛОВКА секції (і ще
       `MIG.toContain("f3")` — двосимвольний підрядок, який у файлі на 165 КБ
       трапляється випадково в будь-якому hex-md5). Тобто смоук можна було
       випотрошити повністю, лишивши коментарі, і тест лишався б зеленим.
       Знахідка ревʼю; тепер пінеться і заголовок, і сам асерт, і стимул. */
    expect(MIG, "HOWTO обіцяє живу перевірку не тим файлом")
      .toContain("supabase/smoke/gcal_sync_overdue_smoke.sql");
    for (const s of ["f3", "f3b", "f4", "f5", "f6"]) {
      expect(SMOKE, `смоук не має секції ${s}`).toContain(`0194: ${s})`);
      expect(SMOKE, `секція ${s} без асерта — заголовок без перевірки`)
        .toContain(`SMOKE_FAIL ${s}:`);
    }
    /* стимули: обидва аварійні статуси і обидва «не offender»-стани */
    for (const st of ["'reauth_required'", "'access_lost'", "'not_connected'"]) {
      expect(SMOKE, `смоук не ставить стимул ${st}`).toContain(`status = ${st}`);
    }
    expect(SMOKE, "смоук не перевіряє ПЕРШУ гілку (увімкнене, але стоїть)")
      .toContain("last_sync_at = now() - interval '2 hours'");
    expect(count(SMOKE, "invariants_check(false)"),
      "у смоуку не шість прогонів сторожа — секція зникла або додалась").toBe(6);
    expect(SMOKE, "смоук не відновлює дані").toContain("ключові поля НЕ повернулись");
  });

  it("аудит-док пакета існує — на нього посилається інструкція відкату", () => {
    /* ⚠️ Посилання на `docs/audit/PR-0194-gcal-blind.md` стоїть У ТІЛІ файла
       міграції (секція ВІДКАТУ називає його ЄДИНИМ джерелом актуальних чисел),
       а сам файл писався б «потім». Ревʼю показало, що «потім» — це рівно той
       спосіб, яким посилання протухають; тому існування доку пінеться. */
    expect(MIG, "міграція не посилається на аудит-док").toContain("docs/audit/PR-0194-gcal-blind.md");
    expect(existsSync(resolve(process.cwd(), "docs/audit/PR-0194-gcal-blind.md")),
      "аудит-док пакета не створено, а інструкція відкату шле читача саме в нього").toBe(true);
  });

  it("HOWTO обіцяє 40 стендів — і їх справді 40", () => {
    expect(MIG, "HOWTO не називає числа стендів").toContain("falsify-all.mjs` (40)");
    expect(FALSIFY_ALL, "EXPECTED_STANDS не 40").toContain("EXPECTED_STANDS = 40");
  });
});
