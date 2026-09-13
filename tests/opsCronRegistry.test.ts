/**
 * Реєстр фонових задач: `docs/README.md` не має брехати числом про
 * `docs/ops-cron.md`.
 *
 * ЧОМУ ВІН ІСНУЄ. Черга с68, пункт 7: `docs/README.md` казав «реестр фоновых
 * задач (9 штук на 2026-08-24)», а в `cron.job` задач ДЕСЯТЬ — і сам реєстр
 * `ops-cron.md` перелічує теж десять (рядок `gcal-backup-sync` дописала 0161).
 * Тобто протух рівно ОДИН із двох доків, і жоден канал цього не бачив:
 * `invariantsCheckedPins` стежить за числом `checked` у `ops-cron.md`
 * (`LIVE_DOCS`), але не за КІЛЬКІСТЮ ЗАДАЧ, а README не стережеться нічим.
 *
 * ⚠️ ЧОГО ЦЕЙ ФАЙЛ НЕ ДОВОДИТЬ, і межа названа тут, а не в звіті: він звіряє
 *    ДВА ДОКИ МІЖ СОБОЮ, а не з продом. Тести цього проєкту до БД не мають
 *    доступу за побудовою (`vitest.config.ts`, `environment: "node"`), тож
 *    «десять у реєстрі = десять у `cron.job`» лишається ЖИВОЮ перевіркою —
 *    запит у секції «Перевірки» самого `ops-cron.md`. Сюди цей факт приходить
 *    руками, і саме тому реєстр носить дату звірки з продом.
 *    Що ЦЕЙ файл ловить: розходження README ↔ реєстр, тобто рівно той дрейф,
 *    який стався. Додав задачу в реєстр і забув README — червоне поімення.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REGISTRY = "docs/ops-cron.md";
const INDEX = "docs/README.md";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

/** Рядки таблиці «Чинні задачі» — ЛИШЕ вони, і виріз дослівний (якір +
 *  термінатор). Сканувати весь файл не можна: нижче є і таблиця джерел, і
 *  рядок «Знято в с37» про `prune-audit-log`, і приклади SQL — усі вони дали б
 *  хибні задачі. Той самий прийом, що виріз списку №19 у
 *  `guardFnBodiesInvariant.test.ts`. */
function registryJobs(txt: string): string[] {
  const open = "## Чинні задачі";
  const a = txt.indexOf(open);
  if (a < 0) throw new Error(`${REGISTRY}: немає секції «${open}»`);
  const b = txt.indexOf("\n**Знято", a);
  if (b < 0) throw new Error(`${REGISTRY}: таблиця задач не закрита рядком «Знято»`);
  const block = txt.slice(a, b);
  return [...block.matchAll(/^\| `([a-z0-9-]+)` \| `[^`]+` \|/gm)].map((m) => m[1]);
}

describe("реєстр фонових задач — README не бреше числом", () => {
  const registry = read(REGISTRY);
  const index = read(INDEX);
  const jobs = registryJobs(registry);

  /* ⚠️ АНТИВАКУУМ ПЕРШИМ. Без нього «нуль задач = нуль у README» був би
     зеленим, а зламаний парсер виглядав би як порядок. Тест мусить уміти
     сказати, що не перевірив нічого (урок с63 №2). */
  it("виріз таблиці задач НЕПОРОЖНІЙ і містить відомі імена (антивакуум)", () => {
    expect(jobs.length).toBeGreaterThan(5);
    expect(jobs).toContain("invariants");
    expect(jobs).toContain("gcal-backup-sync");
    expect(jobs).toContain("sink-overdue");
  });

  it("імена задач у реєстрі не дублюються", () => {
    expect(new Set(jobs).size).toBe(jobs.length);
  });

  /** ⚠️ ОДИН ВИРІЗ НА ОБА АСЕРТИ, і це правка після ревʼю. Перша редакція
   *  рахувала число регексом по ВСЬОМУ файлу, а «немає дати» перевіряла на
   *  260 символах від ГОЛОЇ фрази — тобто два тести дивились у різні місця, і
   *  негативний асерт міг пройти ВАКУУМНО, якби фраза трапилась вище. Плюс
   *  магічне 260: запас до найближчої честної дати (`TECH_AUDIT_2026-07-27` у
   *  сусідньому пункті) — близько двохсот символів, тож один дописаний абзац
   *  давав ЛОЖНЕ ЧЕРВОНЕ на честному файлі. Тепер межа семантична: від
   *  початку пункту до наступного пункту списку. */
  const README_BULLET = (() => {
    const re = /реестр фоновых задач \(\*\*(\d+) штук\*\*/;
    const m = index.match(re);
    if (!m || m.index === undefined) {
      throw new Error("у README немає числа задач у формі «реестр фоновых задач (**N штук**»");
    }
    /* Від ПОЧАТКУ пункту, а не від місця матчу: інакше в виріз не входить сам
       лінк `ops-cron.md`, і антивакуум нижче не має за що взятись (спіймано
       першим же прогоном цієї редакції). */
    const bulletAt = index.lastIndexOf("\n- ", m.index);
    const rest = index.slice(bulletAt < 0 ? m.index : bulletAt + 1);
    const end = rest.indexOf("\n- ");
    return { count: Number(m[1]), text: end < 0 ? rest : rest.slice(0, end) };
  })();

  it("виріз пункту README непорожній і саме про реєстр (антивакуум)", () => {
    expect(README_BULLET.text.length).toBeGreaterThan(80);
    expect(README_BULLET.text).toContain("ops-cron.md");
  });

  it("число задач у README збігається з реєстром", () => {
    expect(README_BULLET.count).toBe(jobs.length);
  });

  /* Друга сторона тієї ж обіцянки, і на ТОМУ САМОМУ вирізі: README не має
     тримати ВЛАСНУ дату звірки з продом. Дві дати розходяться так само тихо,
     як два числа, і першою протухає копія. Дата живе в реєстрі — там, де її
     оновлює той, хто звіряв. */
  it("README не тримає власної дати звірки з продом", () => {
    expect(README_BULLET.text).not.toMatch(/20\d\d-\d\d-\d\d/);
  });

  it("реєстр тримає дату звірки з продом — це його робота, не README", () => {
    expect(registry).toMatch(/## Чинні задачі \(звірено з продом 20\d\d-\d\d-\d\d/);
  });
});
