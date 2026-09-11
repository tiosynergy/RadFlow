/**
 * U-81 — звʼязка «вердикт стенда → код повернення» має ОДИН екземпляр.
 *
 * ЧОМУ ЦЕ ІСНУЄ. Замір с57: код повернення ставив КОЖЕН стенд сам, у 25
 * незалежних копіях хвоста, і одна з них (`falsify-u37`) уже містила ДУБЛЬ.
 * Жоден сторож цих копій не читав.
 *
 * ⚠️ ЧЕСНО ПРО ВАГУ БОРГУ, бо док його перебільшував. `PR-U-74-falsify-verdict`
 *    каже «не перевіряється нічим». Замір по дереву: `falsify-all` має
 *    ЗАПАСНОГО сторожа ще з с52 —
 *    `loudRed = status !== 0 || anchors || notHeld || noRun || verdictRed`,
 *    де `verdictRed` ловить ОБИДВІ форми надрукованого вироку. Тобто головний
 *    режим відмови («хтось зняв process.exitCode») у РЕВІЗІЇ вже закритий.
 *    Лишалось інше, і саме воно тут: стенд, запущений РУКАМИ, судиться лише
 *    кодом повернення; і 25 копій — це 25 місць, де наступна правка
 *    розійдеться мовчки.
 *
 * ⚠️ ГОЛОВНА ПЕРЕВІРКА — ПОВЕДІНКОВА: `finishStand` запускається в підпроцесі,
 *    і міряється РЕАЛЬНИЙ код виходу. Лексика нижче лише не дає звʼязці
 *    розповзтися назад по файлах.
 *
 * ⚠️ ЧОМУ ПІН ПО ХВОСТУ, А НЕ ПО ВСЬОМУ ФАЙЛУ. Перша редакція цього сторожа
 *    шукала `process.exitCode` у всьому тексті — і червоніла на `falsify-0166`,
 *    бо той ОПИСУЄ мутації про цю саму звʼязку, тобто містить її рядки як
 *    ДАНІ. Спроба зняти рядкові літерали регуляркою (а потім і посимвольним
 *    сканером) зробила гірше: шість файлів «втратили» виклик через лапки
 *    всередині лапок і regex-літерали. Токенізувати JS регулярками — відома
 *    пастка, і `tests/helpers/codeOf.ts` прямо про неї попереджає. Тому
 *    звʼязка пінується там, де вона за каноном і живе: у ХВОСТІ файла.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { codeOf } from "./helpers/codeOf";

const DIR = "scripts";
const STANDS = readdirSync(DIR)
  .filter((f) => /^falsify-.*\.mjs$/.test(f) && f !== "falsify-all.mjs")
  .sort();

/** Стенди, що ОПИСУЮТЬ мутації про саму звʼязку: її рядки в них — дані. */
const META = new Set(["falsify-0166.mjs"]);

const codeOfFile = (f: string) => codeOf(readFileSync(`${DIR}/${f}`, "utf8"));
/** Хвіст — останні 12 НЕПОРОЖНІХ рядків коду: за каноном звʼязка живе там. */
const tailOf = (f: string) =>
  codeOfFile(f).split("\n").filter((l) => l.trim()).slice(-12).join("\n");

/** Запускає вираз у ПІДПРОЦЕСІ і повертає його код виходу. */
function exitCodeOf(expr: string): number {
  try {
    execFileSync(process.execPath, ["-e", expr], { stdio: "pipe" });
    return 0;
  } catch (e) {
    const st = (e as { status?: number }).status;
    return typeof st === "number" ? st : -1;
  }
}

const IMPORT_LIB = "./scripts/lib/falsify-verdict.mjs";

describe("U-81 — звʼязка «вердикт → код повернення» одна на всі стенди", () => {
  it("стенди знайдено — інакше всі перевірки нижче тримались би на нулі", () => {
    expect(STANDS.length, "у scripts/ не знайдено жодного falsify-*.mjs")
      .toBeGreaterThanOrEqual(25);
  });

  it.each(STANDS)("%s: у хвості рівно один finishStand і жодного process.exitCode", (f) => {
    const tail = tailOf(f);
    const calls = (tail.match(/(?<!\w)finishStand\s*\(/g) || []).length;
    expect(calls, `${f}: викликів finishStand у хвості ${calls}, а має бути рівно один`).toBe(1);
    expect(tail, `${f}: стенд знову ставить код повернення сам`).not.toMatch(/process\s*\.\s*exitCode/);
  });

  it.each(STANDS.filter((f) => !META.has(f)))("%s не ставить код повернення НІДЕ у файлі", (f) => {
    /* ⚠️ META-стенди виключені НАЗВАНО: `falsify-0166` носить рядки цієї
       звʼязки як текст мутацій N56–N60. Його власний хвіст пінить перевірка
       вище — тобто виключення знімає лише ДРУГИЙ, надлишковий канал. */
    expect(codeOfFile(f), `${f}: звʼязка розповзлась поза хвіст`)
      .not.toMatch(/process\s*\.\s*exitCode/);
  });

  it.each(STANDS)("%s імпортує finishStand зі спільної бібліотеки", (f) => {
    expect(codeOfFile(f), `${f}: немає імпорту finishStand`).toMatch(
      /import \{[^}]*\bfinishStand\b[^}]*\} from "\.\/lib\/falsify-verdict\.mjs";/
    );
  });

  it.each(STANDS)("%s веде до finishStand свій ПРОВАЛ, а не константу", (f) => {
    /* Пін проти найтихішого способу зняти сторожа: `ok: true` завжди зелений,
       і жодна перевірка вище цього не побачила б. */
    const m = tailOf(f).match(/finishStand\(\{\s*\n?\s*ok:\s*([^,\n]+)/);
    expect(m, `${f}: не вдалось прочитати аргумент ok у хвості`).not.toBeNull();
    const ok = (m as RegExpMatchArray)[1].trim();
    expect(ok, `${f}: ok — константа, стенд більше не вміє червоніти`)
      .not.toMatch(/^(true|false|1|0)$/);
  });
});

describe("U-81 — сама звʼязка, заміряна ПОВЕДІНКОЮ у підпроцесі", () => {
  const call = (arg: string) =>
    `import(${JSON.stringify(IMPORT_LIB)}).then((m) => { m.finishStand(${arg}); })`;

  it("червоний вердикт дає НЕнульовий код виходу", () => {
    expect(exitCodeOf(call(`{ ok: false, red: "R" }`))).toBe(1);
  });

  it("зелений вердикт дає НУЛЬ", () => {
    expect(exitCodeOf(call(`{ ok: true, red: "R", green: "G" }`))).toBe(0);
  });

  it("зелений НЕ маскує вже виставлений кимось код", () => {
    /* Межа, названа явно: finishStand ставить код лише на червоному і ніколи
       не скидає чужий. Інакше стенд, який упав раніше, «одужав» би підсумком. */
    expect(exitCodeOf(`process.exitCode = 3; ` + call(`{ ok: true, red: "R" }`))).toBe(3);
  });

  it("нечіткий аргумент падає ГУЧНО, а не тихо ставить нуль", () => {
    /* `finishStand(verdict)` замість `finishStand({ok: verdict.ok, red})` —
       найправдоподібніша майбутня помилка: у verdictOf є поле ok, немає red. */
    expect(exitCodeOf(call(`{ ok: false }`))).not.toBe(0);
    expect(exitCodeOf(call(`{ red: "R" }`))).not.toBe(0);
    expect(exitCodeOf(call(`{ ok: "ні", red: "R" }`))).not.toBe(0);
  });

  it("червоний текст справді друкується — інакше запасний сторож falsify-all осліпне", () => {
    /* `falsify-all` рахує `verdictRed` за ТЕКСТОМ виводу. Якби finishStand
       мовчав, ревізія втратила б другий, незалежний канал сигналу.
       ⚠️ Червоний виходить кодом 1, тому execFileSync КИДАЄ — вивід беремо з
       помилки; перша редакція цього піна падала на правильному коді. */
    let out = "";
    try {
      out = execFileSync(
        process.execPath,
        ["-e", `import(${JSON.stringify(IMPORT_LIB)}).then((m)=>{m.finishStand({ok:false,red:"⛔ ВЕРДИКТ: СТЕНД ЧЕРВОНИЙ — зонд"})})`],
        { encoding: "utf8" }
      );
    } catch (e) {
      out = String((e as { stdout?: string }).stdout ?? "");
    }
    expect(out).toContain("⛔ ВЕРДИКТ: СТЕНД ЧЕРВОНИЙ");
  });
});

/* ── с63: смерть САМОЇ ревізії ─────────────────────────────────────────────
   Дірка, яку не закривала перевірка дерева між стендами: вона живе в тому ж
   процесі. Помер один стенд — цикл `falsify-all` побачить брудне дерево,
   назве винуватця й відкотить. Помер САМ прогін — не відпрацює ні `finally`
   стенда, ні цикл, і мутація лишається в бойовому файлі без жодного сліду.
   Заміряно вживу 11.09: обрив мосту до машини вбив `falsify-f346`, і в
   `lib/serverClock.ts` лишилось `if (true)` замість вибору проби з найменшим
   RTT — прод-логіка звірки годинника. Знайшов `git status`, а не інструмент.

   ⚠️ Це сторож ФОРМИ, і межа названа: перевіряється, що механізм мітки в коді
   є і що зняття стоїть на трьох шляхах виходу. Що мітка справді лишається
   після SIGKILL, тестом у node-середовищі не покажеш — це властивість ОС. */
describe("с63 — мертва ревізія лишає гучний слід", () => {
  const all = readFileSync("scripts/falsify-all.mjs", "utf8");

  it("мітка ставиться ПЕРЕД першим стендом, а не на старті процесу", () => {
    /* Порядок — частина правила: мітка на самому старті лишалась би після
       чесної відмови гейтів (брудне дерево, зламані типи), коли жоден бойовий
       файл не мутували, і наступний запуск вимагав би розбиратися з нічим. */
    const mark = all.indexOf("writeFileSync(RUNNING_MARK");
    const loop = all.indexOf("for (const f of files) {");
    const tsc = all.indexOf("npx tsc --noEmit");
    expect(mark, "мітку не ставлять узагалі").toBeGreaterThan(-1);
    expect(mark, "мітку ставлять ДО перевірки типів — лишиться після відмови старту").toBeGreaterThan(tsc);
    expect(mark, "мітку ставлять ПІСЛЯ першого стенда — вікно без сліду лишається").toBeLessThan(loop);
  });

  it("наступний запуск на знайдену мітку НЕ стартує", () => {
    expect(all, "перевірки мітки немає — слід є, а гучності немає")
      .toMatch(/if \(existsSync\(RUNNING_MARK\)\) \{[\s\S]{0,600}?process\.exit\(2\)/);
  });

  it("мітку знімають усі три шляхи виходу, які взагалі можуть її зняти", () => {
    /* Нормальний кінець — і при ЧЕРВОНОМУ підсумку теж: червона ревізія і
       мертва ревізія — різні речі, і плутати їх означало б вимагати ручного
       прибирання після кожного червоного прогону. */
    expect(all, "мітка лишається після нормального завершення").toMatch(/\nclearMark\(\);\nif \(failed/);
    expect(all, "SIGINT не знімає мітку").toMatch(/on\("SIGINT", \(\) => \{ clearMark\(\);/);
    expect(all, "SIGTERM не знімає мітку").toMatch(/on\("SIGTERM", \(\) => \{ clearMark\(\);/);
  });

  it("мітка не доїде до коміта", () => {
    const ignore = readFileSync(".gitignore", "utf8");
    expect(ignore, "мітку не ігнорують — перший же прогін зробить дерево брудним")
      .toMatch(/^\/?\.falsify-\*(\.running)?$|\.falsify-\*\.running/m);
  });
});
