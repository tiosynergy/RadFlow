/* U-55 (с49) — читання рядка черги: «не прочитали» ≠ «немає доступу».
 *
 * ЯК ЗНАЙШЛОСЬ. Не читанням коду: сканер `readErrorTrust` навчили таблиці
 * `queue_entries`, і він назвав сім місць. Пʼять із них не звʼязували `error`
 * ВЗАГАЛІ, і `null` від `maybeSingle()` в усіх пʼяти вів в одну гілку —
 * «Немає доступу або запис не знайдено». Тобто транзієнт мережі показувався
 * користувачеві як ВІДМОВА В ДОСТУПІ: діагноз, за яким він піде питати права
 * замість «повторіть». Ще дві були ХИБНИМИ ТРИВОГАМИ — форми, яких сканер не
 * знав (`let q = supabase.from(…)` з очікуванням пізніше).
 *
 * НАЙДОРОЖЧЕ МІСЦЕ — `setQueuePriority`: там читання годує АВТОРИЗАЦІЮ.
 * `const [{ data: profile }, { data: entry }]` не звʼязував жодної помилки, тож
 * збій читання профілю давав `profile = null` → `isAdmin = false` → адмін
 * діставав «Змінювати пріоритет може адміністратор або лікар-направник».
 * Дірки в безпеці не було (fail-CLOSED), але людині казали, що вона не той,
 * ким є, і зрозуміти, що це збій мережі, вона не могла нізвідки.
 *
 * ЩО НЕ ЗМІНИЛОСЬ. Жодне з пʼяти місць не стало ані суворішим, ані мʼякшим:
 * усі як відмовляли, так і відмовляють. Змінився ДІАГНОЗ. А два місця, де
 * читання годує лише атрибуцію журналу, свідомо НЕ зупиняють дію: відмовити
 * користувачеві у виправленні телефона пацієнта через збій читання рядка ДЛЯ
 * ЖУРНАЛУ — гірше за деградовану подію. Але тепер вони не мовчать.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { codeOf } from "./helpers/codeOf";
import { readRow } from "@/lib/readRow";

const ACTIONS = "app/queue/actions.ts";
const code = codeOf(readFileSync(resolve(process.cwd(), ACTIONS), "utf8"));

describe("readRow — три відповіді, перевірені викликом", () => {
  it("помилка читання → не знаємо", () => {
    expect(readRow({ data: null, error: { message: "boom" } }))
      .toEqual({ known: false, reason: "error" });
    /* Помилка ПЕРЕВАЖАЄ над даними: PostgREST може віддати і те, і те. */
    expect(readRow({ data: { id: 1 }, error: { message: "boom" } }))
      .toEqual({ known: false, reason: "error" });
  });

  it("відповіді немає взагалі → не знаємо, а не «немає рядка»", () => {
    expect(readRow(null)).toEqual({ known: false, reason: "error" });
    expect(readRow(undefined)).toEqual({ known: false, reason: "error" });
  });

  it("порожній рядок → missing", () => {
    expect(readRow({ data: null, error: null })).toEqual({ known: false, reason: "missing" });
    expect(readRow({ data: undefined, error: null })).toEqual({ known: false, reason: "missing" });
  });

  it("рядок є → знаємо, і він віддається як є", () => {
    const row = { id: "x", status: "waiting" };
    expect(readRow({ data: row, error: null })).toEqual({ known: true, row });
  });

  it("порожній ОБʼЄКТ — це рядок, а не незнання", () => {
    /* `{}` хибне лише як `!res.data`, тому правило перевіряє саме null/undefined:
       вибірка одного поля з null-значенням дала б `{ referrer_id: null }`, і
       рахувати такий рядок «ненайденим» було б неправдою. */
    expect(readRow({ data: {}, error: null })).toEqual({ known: true, row: {} });
  });
});

describe("app/queue/actions.ts — читання рядка черги", () => {
  it("жодного читання queue_entries без звʼязаної помилки", () => {
    /* Головний інваріант пакета. `const { data: cur } = await …from("queue_entries")`
       — рівно та форма, що давала пʼять брехливих діагнозів. */
    expect(code).not.toMatch(/const \{ data: \w+ \} = await supabase[\s\S]{0,80}?\.from\("queue_entries"\)/);
  });

  it("незнання має ВЛАСНУ відповідь, окрему від «немає доступу»", () => {
    expect(code).toMatch(/const ENTRY_UNREADABLE_ERR: QueueActionResult = \{\s*ok: false, error: "Не вдалося прочитати запис/);
    /* Код НЕ "forbidden": це не відмова в доступі, і `ReferralPortal` підмінює
       текст саме для forbidden (урок U-18, ревʼю р1). */
    expect(code).not.toMatch(/"Не вдалося прочитати запис[\s\S]{0,120}?code: "forbidden"/);
  });

  it("за КОЖНИМ розбором одразу стоїть гілка незнання", () => {
    /* ⚠️ Перша редакція рахувала «розборів не менше трьох, гілок не менше, ніж
       розборів» — і мутація, що прибирала ОДНУ пару цілком, лишалась зеленою
       (фальсифікація N08). Рахуємо ПАРИ і вимагаємо РІВНОСТІ: розбір без
       негайної гілки — це обчислення, яке нічого не вирішує (урок U-13). */
    const reads = code.match(/const \w+ = readRow\(await supabase/g) || [];
    /* `if (!X.known` — без закриття дужки: у двох місцях атрибуції журналу
       гілка звужена до `&& X.reason === "error"` (логуємо лише збій, бо
       `missing` там — звичайна відмова доступу і UPDATE однаково дасть 0). */
    const paired = code.match(/const (\w+) = readRow\(await supabase[\s\S]{0,400}?\);\s*if \(!\1\.known/g) || [];
    expect(reads.length, "правило не кличуть у місцях читання рядка").toBeGreaterThanOrEqual(5);
    expect(paired.length, "є розбір БЕЗ негайної гілки незнання").toBe(reads.length);
  });

  it("«не знайдено» лишилось «не знайдено», а не перетворилось на збій", () => {
    /* Антирегрес у зворотний бік: якби обидві причини злились у
       ENTRY_UNREADABLE_ERR, невидимий чужий запис почав би виглядати як
       поломка сервера — і оператор чекав би, поки «полагодять».
       ⚠️ Перша редакція вимагала «не менше трьох» — і злиття однієї пари
       лишалось зеленим (фальсифікація N06). Тепер інваріант самобалансований і
       БЕЗ магічного числа: кожне місце рішення використовує обидві гілки рівно
       по разу, тож кількості мусять збігатися. */
    /* ⚠️ Ревʼю U-55 показало, що лічильники токенів цього НЕ ловлять: якщо
       ПОМІНЯТИ гілки місцями («не знайдено» → ENTRY_UNREADABLE_ERR, а збій →
       «немає доступу»), кількості лишаються 4/4 і сторож мовчить. Пінимо ФОРМУ
       пари в одному виразі: `missing` мусить вести до forbidden-відповіді, а
       все інше — до ENTRY_UNREADABLE_ERR. */
    const pairs = code.match(
      /reason === "missing"\s*\?\s*\{ ok: false, error: "[^"]+", code: "forbidden" \}\s*:\s*ENTRY_UNREADABLE_ERR;/g,
    ) || [];
    const missing = code.match(/reason === "missing"/g) || [];
    expect(pairs.length, "жодної правильно орієнтованої пари причин")
      .toBeGreaterThanOrEqual(4);
    expect(missing.length,
      "є гілка `reason === \"missing\"` поза канонічною парою — причини могли "
      + "злити або поміняти місцями").toBe(pairs.length);
  });
});

describe("app/queue/actions.ts — авторизація не тримається на мовчазному читанні", () => {
  const at = code.indexOf("export async function setQueuePriority");
  const fn = at >= 0 ? code.slice(at, code.indexOf("\nexport ", at + 10)) : "";

  it("тіло дії знайдено", () => {
    expect(fn.length, "setQueuePriority не знайдено — тест застарів").toBeGreaterThan(300);
  });

  it("роль читають через правило, а не через `profile?.role`", () => {
    /* `profile?.role === "admin"` перетворював НЕЗНАННЯ ролі на «не адмін». */
    expect(fn).not.toMatch(/profile\?\.role/);
    expect(fn).toMatch(/const profRead = readRow\(profRes\);/);
    expect(fn).toMatch(/isAdmin = profRead\.known && profRead\.row\.role === "admin"/);
  });

  it("роль питають ЛИШЕ там, де від неї щось залежить", () => {
    /* ⚠️ Найважливіший пін цього файлу — і він зʼявився з РЕВʼЮ, яке спіймало
       МОЮ регресію. Перша редакція обривала дію на `!profRead.known` ДО
       обчислення `isOwnerReferrer`, і направник-власник запису, який раніше
       проходив (роль йому не потрібна), діставав відмову через збій читання
       чужого йому профілю. Порядок тут — не стиль, а поведінка. */
    const owner = fn.indexOf("const isOwnerReferrer =");
    const gate = fn.indexOf("!profRead.known");
    expect(owner, "isOwnerReferrer не знайдено").toBeGreaterThan(-1);
    expect(gate, "гілки незнання ролі немає").toBeGreaterThan(-1);
    expect(gate, "гейт ролі стоїть ПЕРЕД обчисленням власника — регрес для направника")
      .toBeGreaterThan(owner);
    expect(fn).toMatch(/if \(!isOwnerReferrer && !profRead\.known\)/);
  });

  it("незнання ролі ЗУПИНЯЄ дію власним текстом", () => {
    expect(fn).toMatch(/error: "Не вдалося перевірити ваші права/);
    /* І це саме окремий текст, а не «ви не адміністратор». */
    const at2 = fn.indexOf("if (!isOwnerReferrer && !profRead.known)");
    const branch = fn.slice(at2, at2 + 320);
    expect(branch).not.toMatch(/може адміністратор або лікар-направник/);
  });

  it("обидва читання розбираються, і жодне не лишилось «сирим»", () => {
    expect(fn).toMatch(/const \[profRes, entryRes\] = await Promise\.all\(\[/);
    expect(fn).toMatch(/const entryRead = readRow\(entryRes\);/);
    expect(fn).not.toMatch(/\{ data: profile \}|\{ data: entry \}/);
  });
});

describe("app/queue/actions.ts — атрибуція журналу: гучно, але не блокуючи", () => {
  /* Два місця (`updatePatientDetails`, `caseFromEntry`) читають знімок ДО
     мутації лише щоб вибрати сімʼю події. Зупиняти через них дію не можна. */
  it("обидва місця логують КАНОНІЧНИМ іменем події", () => {
    /* ⚠️ Ревʼю U-55: перша редакція завела власний словник (`read.trust` /
       `entry_attribution_*`). Пропуски журналу шукають одним запитом по
       `event = "important_event.skipped"` — і власне імʼя робило б тихо саме
       там, де ми домагаємось гучності (той самий урок, що в U-17). */
    /* ⚠️ Рахуємо ВСЕРЕДИНІ гілок, а не по файлу: код `pre_snapshot_unreadable`
       уже жив у трьох інших місцях (це і є та конвенція, до якої нас повернуло
       ревʼю), тож глобальний лічильник тут нічого не означав би. */
    const branches = [...code.matchAll(
      /if \(!\w+Read\.known && \w+Read\.reason === "error"\) \{\s*logError\(\{([\s\S]{0,320}?)\}\);/g)];
    expect(branches.length, "лог деградованої атрибуції не в обох місцях").toBe(2);
    for (const m of branches) {
      expect(m[1], "імʼя події неканонічне — запит про пропуски його не знайде")
        .toMatch(/event: "important_event\.skipped"/);
      expect(m[1], "код помилки не канонічний").toMatch(/errorCode: "pre_snapshot_unreadable"/);
    }
    expect(code, "власний словник кодів повернувся").not.toMatch(/entry_attribution_/);
  });

  it("логують лише ЗБІЙ, а не звичайну відмову доступу", () => {
    /* `missing` тут — правлять чужий запис; сам UPDATE однаково зачепить 0
       рядків і поверне «немає доступу». Писати про це в лог ПОМИЛОК означало б
       шуміти на кожній такій спробі (`lib/serverLog.ts`: «логуємо ЛИШЕ
       критичне»). */
    const narrowed = code.match(/if \(!\w+Read\.known && \w+Read\.reason === "error"\)/g) || [];
    expect(narrowed.length, "гілка логу не звужена до reason === error").toBe(2);
  });

  it("текст логу не бреше про наслідок", () => {
    /* ⚠️ Ревʼю U-55 спіймало неправду: в `updatePatientDetails` емісія стоїть
       під `if (pre?.clinic_id)`, тож при незнанні події НЕМАЄ ЗОВСІМ — вона не
       «деградує». У `caseFromEntry` подія таки пишеться
       (`clinicId: srcEntry?.clinic_id ?? clinicId`), і там деградує саме
       атрибуція. Тексти мусять розрізняти ці два випадки. */
    expect(code).toMatch(/type=queue\.patient_data_changed — знімок не прочитано, події не буде/);
    expect(code).toMatch(/type=case\.from_entry — знімок не прочитано, атрибуція події деградує/);
  });

  it("і при цьому дію НЕ зупиняє", () => {
    /* Ключова відмінність від пʼяти місць вище: тут після гілки незнання
       виконання ЙДЕ ДАЛІ, а знімок стає null. */
    const hits = code.match(/const \w+ = \w+Read\.known \? \w+Read\.row : null;/g) || [];
    expect(hits.length, "знімок для журналу більше не деградує до null — дія могла стати блокованою")
      .toBeGreaterThanOrEqual(2);
    /* І в цих двох гілках немає жодного `return`.
       ⚠️ Шаблон мусить збігатися з ЧИННОЮ формою гілки (`&& X.reason ===
       "error"`, звуження з ревʼю U-55). Перша редакція шукала голе
       `if (!XRead.known) {` — і після звуження не знаходила НІЧОГО: цикл
       мовчки крутився нуль разів, тобто сторож був декоративним. Тому
       кількість гілок пінимо окремо: нуль збігів — це червоне. */
    const branches = [...code.matchAll(
      /if \(!(\w+Read)\.known && \1\.reason === "error"\) \{\s*logError\(\{[\s\S]{0,420}?\n  \}/g)];
    expect(branches.length, "гілок атрибуції не знайдено — шаблон розʼїхався з кодом").toBe(2);
    for (const m of branches) {
      expect(m[0], "гілка атрибуції зупиняє дію — це регрес").not.toMatch(/return /);
    }
  });
});
