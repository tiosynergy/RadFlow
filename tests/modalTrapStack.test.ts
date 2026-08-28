/* Аудит с46, U-8 — вкладене вікно і пастка фокуса батька.
 *
 * `useModalA11y` вішає keydown на DOCUMENT у фазі capture. Коли поверх вікна
 * відкривається вкладене, слухачів стає два на одному вузлі, і stopPropagation
 * їх не розділяє. У `CaseModal` (чотири вкладені вікна, `active` не
 * передавався): Esc у формі переносу закривав ВЕСЬ кейс разом із незбереженими
 * правками, а Tab перехоплювався двічі й замикав фокус на двох елементах —
 * відказ WCAG 2.1.2 рівня A.
 *
 * Правило `active` існувало з с43 і було застосоване в трьох місцях. Ревʼю
 * пакета знайшло, що забули його не в одному компоненті, а в трьох
 * (`CaseModal`, `WaitlistCandidatesModal`, частково `RescheduleModal`). Тому:
 *   • страховка в самому хуку — клавіші обробляє лише верхня пастка;
 *   • контракт стека — handle, а не три вільні функції над числом: узяти й не
 *     покласти, зняти чуже або зняти не в очищенні тепер неможливо як клас;
 *   • сторож нижче — ПЕРЕЛІК усіх власників пастки, а не один компонент,
 *     інакше наступний забутий `active` знову знайдуть через три сесії.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { acquireTrap, activeTraps, resetTraps } from "@/lib/modalTrapStack";
import { codeOf } from "./helpers/codeOf";

beforeEach(() => resetTraps());

describe("modalTrapStack — клавіші обробляє лише верхня пастка", () => {
  it("узяття одразу реєструє: стану «взяв, але не поклав» немає", () => {
    const a = acquireTrap();
    expect(activeTraps().length).toBe(1);
    expect(a.isTop()).toBe(true);
  });

  /* Ключовий кейс U-8: батько відкрив вкладене вікно. Esc має дістатись лише
     дитині, інакше закриється весь кейс із незбереженими правками. */
  it("вкладене вікно перебиває батьківське", () => {
    const parent = acquireTrap();
    const child = acquireTrap();
    expect(child.isTop()).toBe(true);
    expect(parent.isTop()).toBe(false);
  });

  it("після закриття вкладеного головним знову стає батько", () => {
    const parent = acquireTrap();
    const child = acquireTrap();
    child.release();
    expect(parent.isTop()).toBe(true);
  });

  /* Батько може деактивуватись (`active=false`), поки дитина ще відкрита — тобто
     знімати доводиться НЕ з вершини. Три рівні, а не два: на двох «зняти дно» і
     «зняти середину» не відрізняються, і помилка в індексі лишилась би непоміченою. */
  it("зняття СЕРЕДНЬОГО з трьох не чіпає вершину", () => {
    const a = acquireTrap(), b = acquireTrap(), c = acquireTrap();
    b.release();
    expect(activeTraps().length).toBe(2);
    expect(c.isTop()).toBe(true);
    expect(a.isTop()).toBe(false);
  });

  /* StrictMode у dev виконує create → destroy → create; повторне зняття не має
     чіпати чужу пастку, яка вже стала на це місце. Ідемпотентність тут не від
     прапорця, а від зняття за значенням: наївний `pop()` знищив би сусіда, і
     саме це ловить `activeTraps().length`. */
  it("повторний release — no-op, а не зняття сусіда", () => {
    const a = acquireTrap();
    a.release();
    const b = acquireTrap();
    a.release();
    expect(activeTraps().length).toBe(1);
    expect(b.isTop()).toBe(true);
  });

  it("дві пастки не сплутати: release своєї не знімає іншу", () => {
    const a = acquireTrap(), b = acquireTrap();
    a.release();
    expect(activeTraps().length).toBe(1);
    expect(b.isTop()).toBe(true);
  });

  /* ВІДОМА МЕЖА (ревʼю с46 р2 F6, формулювання уточнене в р3 F4). Зависла
     пастка (cleanup не відпрацював) НЕ глушить наступні — ті лягають зверху й
     працюють. Вона глушить того, хто лишився ПІД нею, і назавжди займає місце в
     стеку. Сьогодні недосяжно: release — остання інструкція cleanup, а React
     виконує cleanup через try/catch. Пінуємо саме це, щоб наступний не пішов
     «лікувати» неіснуючий режим глобального відмовляння. */
  it("МЕЖА: зависла пастка глушить того, хто ПІД нею, а не наступних", () => {
    const under = acquireTrap();
    acquireTrap();                     // ніхто не викликав release
    expect(under.isTop()).toBe(false);           // під завислою — замовк
    expect(acquireTrap().isTop()).toBe(true);    // а нова зверху працює
    expect(activeTraps().length).toBe(3);        // зависла лишається в стеку
  });

  it("activeTraps віддає КОПІЮ, а не живий масив", () => {
    const a = acquireTrap();
    (activeTraps() as symbol[]).push(Symbol("чуже"));
    expect(activeTraps().length).toBe(1);
    expect(a.isTop()).toBe(true);
  });

  /* Порожній стек → true свідомо: одиночне вікно, яке чомусь не зареєструвалось,
     має працювати, а не мовчати. Ціна помилки — «Esc спрацював», не клінічна. */
  it("порожній стек не глушить нікого", () => {
    const a = acquireTrap();
    a.release();
    expect(a.isTop()).toBe(true);
  });
});

/* ===== Сторожі підключення ===== */
const src = (p: string) => codeOf(readFileSync(resolve(process.cwd(), p), "utf8"));

/* Рекурсивний обхід (ревʼю с46 р3, F5): плаский readdirSync по одній теці не
   побачив би діалог, доданий у підтеку або в app/**. Підтек сьогодні немає —
   обхід задає межу на майбутнє. */
function walkAll(rel: string, exts: string[] = [".tsx", ".ts"]): string[] {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdirSync(resolve(process.cwd(), rel), { withFileTypes: true }) as never;
  } catch { return []; }
  return entries.flatMap((e) =>
    e.isDirectory() ? walkAll(rel + "/" + e.name, exts)
      : exts.some((x) => e.name.endsWith(x)) ? [rel + "/" + e.name] : [],
  );
}

describe("useModalA11y — страховка вбудована і `active` не скасований", () => {
  const hook = src("lib/useModalA11y.ts");

  /* Спокуса після цієї правки: «стек тепер усе вирішує, active зайвий». Обидва
     способи його прибрати (видалити ранній вихід або підняти acquireTrap вище
     нього) повертають U-8 цілком, тож сторожимо і наявність, і ПОРЯДОК. */
  it("ранній вихід по active стоїть ДО взяття пастки", () => {
    /* Приймаємо і голий `return;`, і блок із ним (там тепер живе позначка
       wasDeactivatedRef). Але саме ВИХІД: `if (!active) doSomething();` без
       return цим не проходить. */
    const EARLY_EXIT = /if\s*\(\s*!active\s*\)\s*(return;|\{[^}]*return;[^}]*\})/;
    expect(hook).toMatch(EARLY_EXIT);
    const gate = hook.search(EARLY_EXIT);
    const acquire = hook.indexOf("acquireTrap(");
    expect(acquire).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(acquire);
    expect(hook).toMatch(/\}\s*,\s*\[\s*active\s*\]\s*\)/);   // ефект переграється на active
  });

  /* release мусить жити в ОЧИЩЕННІ. Виклик одразу після acquire дав би завжди
     порожній стек → isTop() завжди true → страховка вимкнена, тести зелені. */
  it("release живе в очищенні ефекту, а не одразу після взяття", () => {
    const acquire = hook.indexOf("acquireTrap(");
    const listen = hook.indexOf('document.addEventListener("keydown"');
    expect(listen).toBeGreaterThan(acquire);
    expect(hook.slice(acquire, listen)).not.toContain("release(");
    expect(hook.slice(listen)).toMatch(/return\s*\(\)\s*=>\s*\{[\s\S]*?\.release\(\)/);
  });

  /* Не «десь є рядок з isTop», а саме РАННІЙ ВИХІД, і саме до гілки Escape.
     `&& false`, `if (…) e.preventDefault()` чи порожнє тіло цим не проходять. */
  it("мовчить, коли зверху інша пастка — раннім виходом ДО обробки Escape", () => {
    const guard = hook.search(/if\s*\(\s*!\w+\.isTop\(\)\s*\)\s*return;/);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(hook.indexOf('e.key === "Escape"'));
    expect(hook.match(/\.isTop\(/g)?.length).toBe(1);   // рівно один ужиток
  });

  /* Регресія, внесена цим же пакетом (ревʼю р1): ефект тепер переграється при
     закритті вкладеного вікна, і безумовний focus() смикав би фокус у шапку. */
  it("не смикає фокус при ПОВЕРНЕННІ після вкладеного вікна", () => {
    expect(hook).toMatch(/contains\(document\.activeElement\)/);
    /* І тільки при поверненні: без цього прапорця правка мовчки змінила б і
       перше відкриття (autoFocus застосовується ДО пасивних ефектів) — ревʼю р3. */
    expect(hook).toMatch(/wasDeactivatedRef\.current\s*=\s*true;\s*return;/);
    expect(hook).toMatch(/if\s*\(\s*returningFromNested\s*&&\s*focusedInside\s*\)/);
  });
});

/* Усі компоненти з ВЛАСНОЮ пасткою, які малюють вкладений діалог. Конвенція
   єдина: `const nestedOpen = <щось відкрито>` (диз'юнкція!) і виклик хука з
   `!nestedOpen`. Так сторож не залежить ні від імені першого аргументу
   (`onClose` / `requestClose`), ні від форматування виклику, ні від дженерика. */
const TRAP_OWNERS: Array<{ file: string; gates: string[] }> = [
  { file: "components/CaseModal.tsx", gates: ["askCancel", "reschedStep", "editStudiesStep", "addOpen"] },
  { file: "components/BookingModal.tsx", gates: ["addDoc", "editDoc", "askClose"] },
  { file: "components/PatientEditModal.tsx", gates: ["addDoc", "editDoc"] },
  { file: "components/RescheduleModal.tsx", gates: ["showMove", "showMoveLoading", "askClose"] },
  { file: "components/WaitlistCandidatesModal.tsx", gates: ["bookFor"] },
];

describe.each(TRAP_OWNERS)("$file — пастка глушиться вкладеним вікном", ({ file, gates }) => {
  const code = src(file);
  const gateExpr = code.match(/const nestedOpen\s*=([^;]*);/)?.[1] ?? "";

  /* Звіряємо МНОЖИНУ операндів, а не підрядки (ревʼю с46 р3, F1): `toContain`
     проходив на `showMove`, якого в гейті вже немає, — його «знаходив» префікс
     слова `showMoveLoading`. Тобто головний сторож пакета пропускав саме ту
     регресію, заради якої писався. Заразом ця перевірка поглинає і заборону
     `&&`, і підрахунок `||`: зайвий операнд або злиплий вираз дадуть інший
     набір. */
  it("nestedOpen — диз'юнкція РІВНО з тих вікон, що є в компоненті", () => {
    expect(gateExpr.trim()).not.toBe("");
    expect(gateExpr).not.toMatch(/&&/);
    expect(gateExpr).not.toMatch(/\b(true|false)\b/);
    const operands = gateExpr.split("||").map((s) => s.replace(/[!()\s]/g, "")).filter(Boolean);
    expect(operands.slice().sort()).toEqual([...gates].sort());
  });

  it("хук отримує саме !nestedOpen", () => {
    expect(code).toMatch(/useModalA11y[^(]*\(\s*\w+\s*,\s*!nestedOpen\s*\)/);
  });
});

/* Найважливіший сторож пакета: він знаходить НАСТУПНОГО порушника сам.
   Правило `active` тричі застосували руками і тричі ж забули в інших місцях —
   тому список власників не пишеться вручну, а звіряється з кодом. */
describe("правило active — нових порушників немає", () => {
  const files = [...walkAll("components", [".tsx"]), ...walkAll("app", [".tsx"])];
  const codeByFile = new Map(files.map((f) => [f, src(f)]));
  /* Компонент «з пасткою» = сам КЛИЧЕ useModalA11y. Імʼя = імʼя файлу.
     ⚠️ Дженерик стоїть між іменем і дужкою (`useModalA11y<HTMLDivElement>(`),
     тож підрядок "useModalA11y(" не збігається ні з ким — перша версія цього
     сторожа мовчала на порожньому списку. Ловить сама себе тест нижче. */
  const CALLS_HOOK = /useModalA11y\s*(<[^>]*>)?\s*\(/;
  const trapComponents = files.filter((f) => CALLS_HOOK.test(codeByFile.get(f) as string));

  const nameOf = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1).replace(".tsx", "");

  it("кожен, хто малює ЧУЖУ пастку всередині своєї, є в TRAP_OWNERS", () => {
    const owners = new Set(TRAP_OWNERS.map((o) => o.file));
    const violators: string[] = [];
    for (const f of trapComponents) {
      const code = codeByFile.get(f) as string;
      const nested = trapComponents.filter((o) => o !== f && code.includes("<" + nameOf(o)));
      if (nested.length && !owners.has(f)) violators.push(f + " → " + nested.map(nameOf).join(", "));
    }
    expect(violators).toEqual([]);
  });

  it("TRAP_OWNERS не містить зайвих (список не протух)", () => {
    for (const o of TRAP_OWNERS) expect(trapComponents).toContain(o.file);
  });
});

/* Контракт стека тримається на тому, ЗВІДКИ його кличуть (ревʼю с46 р3, F6/F7).
   `acquireTrap()` реєструє НЕГАЙНО, тож виклик у тілі компонента або в обробнику
   назавжди засмітив би стек. А `resetTraps()` — глобальний вимикач розділення
   вікон: один виклик у застосунку повертає U-8 цілком. */
describe("modalTrapStack — контракт використання", () => {
  const all = [...walkAll("lib"), ...walkAll("components"), ...walkAll("app")];

  it("acquireTrap кличе ЛИШЕ хук", () => {
    const callers = all.filter((f) => f !== "lib/modalTrapStack.ts" && /acquireTrap\s*\(/.test(src(f)));
    expect(callers).toEqual(["lib/useModalA11y.ts"]);
  });

  it("resetTraps і activeTraps у застосунку не викликаються", () => {
    for (const f of all) {
      if (f === "lib/modalTrapStack.ts") continue;
      expect(src(f)).not.toMatch(/\b(resetTraps|activeTraps)\s*\(/);
    }
  });
});
