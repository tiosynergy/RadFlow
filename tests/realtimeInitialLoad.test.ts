/**
 * U-62/Д2 і Д5 — первинний `callAll` не робить холостої роботи.
 *
 * ЗАМІР, ЩО ЗАВІВ ЦЕЙ ФАЙЛ (с57):
 *   • у `QueueBoard`, `CallListBoard`, `RadiologistBoard`, `WaitlistBoard` і
 *     `ReferralPortal` є підписки, чий `onChange` — рівно `router.refresh()`.
 *     Сторінку щойно віддав сервер, тож на маунті це RSC-перезавантаження
 *     НІЧОГО не оновлює. У кожної свій ключ дебаунса, тож маунт дошки давав
 *     до ТРЬОХ таких перезавантажень;
 *   • `WaitlistBoard` на маунті кликав `reload()`, `loadIncidents()` і
 *     `loadCounts()` ПО ДВА РАЗИ — власні `useEffect` плюс первинний `callAll`.
 *
 * ⚠️ ЧОМУ ЦЕ СТОРОЖ, А НЕ РАЗОВА ПРАВКА. `skipInitial` легко забути на новій
 *    підписці — і холоста робота повернеться мовчки, бо екран виглядатиме
 *    правильно. Тому правило перевіряється по дереву, а не памʼяттю.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { codeOf } from "./helpers/codeOf";

const BOARDS = [
  "components/CallListBoard.tsx",
  "components/QueueBoard.tsx",
  "components/RadiologistBoard.tsx",
  "components/ReferralPortal.tsx",
  "components/WaitlistBoard.tsx",
  "components/ReferrersManager.tsx",
  "components/CeoDashboard.tsx",
  "components/CaseModal.tsx",
  "components/Sidebar.tsx",
  "lib/slotBusy.ts",
];

const src = (p: string) => codeOf(readFileSync(resolve(process.cwd(), p), "utf8"));

/** Рядок-підписка, чий onChange робить РІВНО router.refresh(). */
const PURE_REFRESH = /onChange:\s*\(\)\s*=>\s*router\.refresh\(\)\s*(,|\})/;

describe("U-62/Д2 — чистий router.refresh() не робиться на маунті", () => {
  it.each(BOARDS)("%s: кожна така підписка має skipInitial", (f) => {
    const bad = src(f)
      .split("\n")
      .filter((l) => PURE_REFRESH.test(l) && !l.includes("skipInitial"))
      .map((l) => l.trim().slice(0, 90));
    expect(bad, `${f}: підписки з холостим первинним refresh без skipInitial`).toEqual([]);
  });

  it("сумарно таких підписок рівно стільки, скільки заміряно", () => {
    /* Пін на ЧИСЛО: нова дошка з такою підпискою має змусити прочитати цей
       файл, а не тихо поповнити список. */
    const n = BOARDS.reduce(
      (acc, f) => acc + src(f).split("\n").filter((l) => PURE_REFRESH.test(l)).length,
      0
    );
    expect(n, "число підписок із чистим router.refresh() змінилось").toBe(14);
  });
});

describe("U-62/Д5 — WaitlistBoard не вантажить двічі", () => {
  const wl = src("components/WaitlistBoard.tsx");

  it("усі підписки листа позначені skipInitial", () => {
    /* Лист — єдиний випадок, де первинний callAll не робить НІЧОГО: усе
       вантажать власні ефекти. Якщо тут зʼявиться підписка без skipInitial,
       подвійне завантаження повернеться. */
    const subs = wl.split("\n").filter((l) => /^\s*\{\s*table:\s*"/.test(l));
    expect(subs.length, "склад підписок листа змінився").toBe(5);
    for (const l of subs) {
      expect(l, `підписка листа без skipInitial: ${l.trim().slice(0, 80)}`).toContain("skipInitial");
    }
  });

  it("первинне завантаження лишилось за власними ефектами", () => {
    /* ⚠️ НАЙВАЖЛИВІШИЙ ПІН ФАЙЛА. Якщо ці ефекти прибрати, а підписки лишити
       з `skipInitial`, лист відкриється ПОРОЖНІМ і чекатиме першої події —
       рівно та регресія, яку `skipInitial` робить можливою. */
    expect(wl, "зник ефект первинного reload/loadIncidents")
      .toMatch(/useEffect\(\(\) => \{ reload\(\); loadIncidents\(\); \}, \[reload, loadIncidents\]\);/);
    expect(wl, "зник ефект первинного loadCounts")
      .toMatch(/useEffect\(\(\) => \{ loadCounts\(\); \}, \[loadCounts\]\);/);
  });
});

describe("U-62 — сам механізм пропуску", () => {
  const hook = src("lib/useRealtimeRefetch.ts");

  it("первинний виклик позначений initial, і він один", () => {
    const initial = (hook.match(/callAll\(\{\s*initial:\s*true\s*\}\)/g) || []).length;
    expect(initial, "первинних викликів callAll має бути рівно один").toBe(1);
  });

  it("решта викликів callAll — без initial", () => {
    /* Поллінг, повернення у вкладку, звірка після обриву і оновлення токена
       мусять кликати ВСІ підписки: там дані справді могли протухнути. */
    const all = (hook.match(/callAll\(/g) || []).length;
    const plain = (hook.match(/callAll\(\)/g) || []).length;
    expect(all - plain, "зайвий виклик із initial").toBe(1);
    expect(plain, "виклики без initial зникли").toBeGreaterThanOrEqual(4);
  });

  it("пропуск стоїть ДО дедуплікації за ключем", () => {
    /* Інакше пропущена підписка «зʼїдала» б спільний debounceKey і глушила
       сусідку, яка на маунті потрібна (у порталі ключ `rsc` спільний). */
    const body = hook.slice(hook.indexOf("const callAll"), hook.indexOf("const scheduleDebounced"));
    const iSkip = body.indexOf("skipInitial");
    const iSeen = body.indexOf("seen.has(key)");
    expect(iSkip).toBeGreaterThan(-1);
    expect(iSeen).toBeGreaterThan(-1);
    expect(iSkip, "перевірка skipInitial переїхала ПІСЛЯ дедуплікації").toBeLessThan(iSeen);
  });
});
