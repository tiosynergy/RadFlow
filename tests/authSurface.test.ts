/**
 * ПОВЕРХНЯ АВТОРИЗАЦІЇ — сторож на те, чого до с55 не стерегло НІЩО (Ф6-1).
 *
 * КЛАС ДЕФЕКТУ. `middleware.ts` гейтить лише АУТЕНТИФІКАЦІЮ: залогінений
 * будь-якої ролі проходить його на будь-який захищений роут. Усе розділення
 * ролей живе в РУКОПИСНИХ гейтах сторінок — по одному на `page.tsx`, кожен зі
 * своїм ланцюжком редіректів, — а перелік захищених шляхів лежить рукописним
 * масивом `PROTECTED`. Прогін по всіх спеках у с55 показав: `PROTECTED`,
 * `lib/supabase/middleware`, ролеві редіректи і `profile.role` не згадувались
 * НІДЕ. Тобто новий екран під новим шляхом не отримував ні гейта входу, ні
 * ролевого, і жоден тест про це не казав.
 *
 * ⚠️ ЦЕ САМЕ ТОЙ КЛАС, який проєкт уже лікував ЧОТИРИ рази (`roomScheduleRead`,
 * `unreadChanges`, сканер U-37, `followToday`), і правило записане в хендофі:
 * «щоразу, коли сторож — це СПИСОК, спитати: а що станеться з тим, чого в
 * списку немає?». Тому тут не перепис, а ВЛАСТИВОСТІ, зняті з дерева і з
 * джерела middleware, у ОБИДВА боки.
 *
 * ⚠️ ЧОГО ЦЕЙ ФАЙЛ НЕ РОБИТЬ. Він не доводить, що гейт ПРАЦЮЄ — компонентних
 * тестів у проєкті немає за задумом, сторінки серверні й ходять у Supabase.
 * Він доводить рівно дві речі: (1) кожен роут дерева свідомо віднесений до
 * публічних або до захищених, і жодна сторона не розійшлась із деревом;
 * (2) гейт кожної захищеної сторінки лишився ТИМ САМИМ, яким його звірили
 * очима, і його зміна — гучна. Це названа межа, а не пропуск.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { codeOf } from "./helpers/codeOf";

const src = (p: string) => codeOf(readFileSync(resolve(process.cwd(), p), "utf8")).replace(/\s+/g, " ");
const MW = "lib/supabase/middleware.ts";

/* ===== 1. РОУТИ — з ДЕРЕВА, а не з переліку ===== */
function routesOf(dir: string, prefix: string, acc: string[]): string[] {
  for (const e of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
    if (e.isDirectory()) routesOf(`${dir}/${e.name}`, `${prefix}/${e.name}`, acc);
    else if (e.name === "page.tsx") acc.push(prefix || "/");
  }
  return acc;
}
const ROUTES = routesOf("app", "", []).sort();

/* ===== 2. PROTECTED / AUTH_PAGES — читаються з ДЖЕРЕЛА middleware =====
   Друга копія переліку в тесті перетворила б сторожа на дзеркало: обидві
   сторони мінялись би однією правкою. Тому парсимо з файлу. */
function listOf(name: string): string[] {
  const m = src(MW).match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  expect(m, `${name} зник із ${MW} — сторож більше нічого не читає`).toBeTruthy();
  return (m![1].match(/"([^"]+)"/g) || []).map((s) => s.replace(/"/g, ""));
}

/* ===== 3. ПУБЛІЧНІ РОУТИ — поіменно і з ПРИЧИНОЮ =====
   Виняток без причини перетворює сторожа на місце, куди тихо додають нове. */
const PUBLIC: Record<string, string> = {
  "/": "лише редірект: залогінений → /queue, інакше → /login; власного вмісту немає",
  "/login": "вхід; у AUTH_PAGES — залогіненого відводить на /queue",
  "/register": "реєстрація центру; у AUTH_PAGES",
  "/set-password": "встановлення пароля за токеном; сесії тут ще немає за побудовою, тому НЕ в PROTECTED і НЕ в AUTH_PAGES",
};

/* ===== 4. ІНВЕНТАР ГЕЙТІВ =====
   `may` — хто проходить (звірено ЧИТАННЯМ коду, не сканером: перша редакція
   карти ролей у с55 була знята регексом і виявилась НЕВІРНОЮ на складених
   умовах).
   `closes` — чим закінчується ланцюг:
     "redirect" — є закриваючий позитив із редіректом;
     "render"   — закриваючий позитив, який РЕНДЕРИТЬ пояснення (редірект дав би
                  петлю — див. /setup);
     "NONE"     — лише негативні редіректи, тобто нова роль пройде (Ф6-4). */
type Gate = { may: string[]; closes: "redirect" | "render" | "NONE"; pin: RegExp; why?: string };
const GATES: Record<string, Gate> = {
  "/queue": {
    may: ["admin", "registrar"], closes: "NONE",
    why: "Ф6-4: закриваючого позитива немає — шоста роль отримала б дошку черги. Текст екрана-відмови ще не затверджений власником; поки тримаємо як НАЗВАНИЙ виняток, а не як норму.",
    pin: /if \(profile\.role === "radiologist"\) redirect\("\/radiologist"\); if \(profile\.role === "referrer"\) redirect\("\/referral"\); if \(profile\.role === "ceo"\) redirect\("\/ceo"\);/,
  },
  "/call-list": {
    may: ["admin", "registrar"], closes: "NONE",
    why: "Ф6-4, те саме. Ф6-3 (гейт на ceo і порожній clinic_id) закрито в с55.",
    pin: /if \(profile\.role === "referrer"\) redirect\("\/referral"\); if \(profile\.role === "ceo" \|\| !profile\.clinic_id\) redirect\("\/ceo"\);/,
  },
  "/waitlist": {
    may: ["admin", "registrar"], closes: "NONE",
    why: "Ф6-4, те саме; ceo і порожній clinic_id відводяться.",
    pin: /if \(profile\.role === "ceo" \|\| !profile\.clinic_id\) redirect\("\/ceo"\);/,
  },
  "/ceo-admin": { may: ["admin"], closes: "redirect", pin: /if \(profile\.role !== "admin"\) redirect\("\/queue"\);/ },
  "/journal": { may: ["admin"], closes: "redirect", pin: /if \(profile\.role !== "admin"\) redirect\("\/queue"\);/ },
  "/referrers": { may: ["admin"], closes: "redirect", pin: /if \(profile\.role !== "admin"\) redirect\("\/queue"\);/ },
  "/staff": { may: ["admin"], closes: "redirect", pin: /if \(profile\.role !== "admin"\) redirect\("\/queue"\);/ },
  "/services": {
    may: ["admin"], closes: "redirect",
    pin: /if \(profile\.role !== "admin" \|\| !profile\.clinic_id\) redirect\("\/queue"\);/,
  },
  "/referral": {
    may: ["admin", "referrer"], closes: "redirect",
    pin: /if \(profile\.role !== "admin" && profile\.role !== "referrer"\) redirect\("\/queue"\);/,
  },
  "/radiologist": {
    may: ["admin", "radiologist"], closes: "redirect",
    pin: /\} else if \(profile\.role !== "admin"\) \{ redirect\("\/queue"\); \}/,
  },
  "/ceo": {
    may: ["admin", "ceo", "будь-хто з активним ceo_access"], closes: "redirect",
    pin: /const allowed = profile\.role === "admin" \|\| profile\.role === "ceo" \|\| hasCeoAccess;/,
  },
  "/search": {
    may: ["admin", "registrar", "radiologist", "referrer", "ceo"], closes: "redirect",
    pin: /\} else \{ redirect\("\/queue"\); \}/,
  },
  "/setup": {
    may: ["admin"], closes: "render",
    why: "редірект на /queue дав би петлю: ненастроєний /queue веде назад на /setup",
    pin: /if \(profile\.role !== "admin"\) \{ return \(/,
  },
};

/* Єдине місце, де «незакритий гейт» дозволений — і воно мусить збігатися з
   інвентарем ТОЧНО, інакше новий негативний ланцюг просочиться мовчки. */
const OPEN_BY_DESIGN = ["/call-list", "/queue", "/waitlist"];

describe("поверхня авторизації — перелік проти дерева", () => {
  it("кожен роут свідомо віднесений: або публічний, або з гейтом", () => {
    const unclassified = ROUTES.filter((r) => !(r in PUBLIC) && !(r in GATES));
    expect(unclassified,
      "нова сторінка зʼявилась у дереві і не віднесена ні до публічних, ні до захищених — саме так екран і потрапляє в прод без гейта").toEqual([]);
  });

  it("інвентар не описує того, чого в дереві немає", () => {
    const ghosts = [...Object.keys(PUBLIC), ...Object.keys(GATES)].filter((r) => !ROUTES.includes(r));
    expect(ghosts, "інвентар описує неіснуючий роут — сторож охороняє порожнечу").toEqual([]);
  });

  it("PROTECTED покриває РІВНО захищені роути — в обидва боки", () => {
    const PROTECTED = listOf("PROTECTED");
    const covered = (r: string) => PROTECTED.some((p) => r === p || r.startsWith(p + "/"));
    /* ⚠️ Ф6-2: до с55 тут лежали `/board-app` і `/incidents` — шляхи без
       сторінок. Мертвий запис нешкідливий сам по собі; шкідливо, що розходження
       нікому не було видно. */
    const dead = PROTECTED.filter((p) => !ROUTES.some((r) => r === p || r.startsWith(p + "/")));
    expect(dead, "PROTECTED називає шлях, якого в дереві немає").toEqual([]);
    const unguarded = Object.keys(GATES).filter((r) => !covered(r));
    expect(unguarded, "захищена сторінка не покрита PROTECTED — на неї пустить БЕЗ сесії").toEqual([]);
    const publicInProtected = Object.keys(PUBLIC).filter((r) => r !== "/" && covered(r));
    expect(publicInProtected, "публічний роут потрапив у PROTECTED — вхід або встановлення пароля стануть недосяжними").toEqual([]);
  });

  it("AUTH_PAGES — рівно ті публічні, що відводять залогіненого", () => {
    const AUTH_PAGES = listOf("AUTH_PAGES");
    expect(AUTH_PAGES.slice().sort(), "склад AUTH_PAGES змінився — перевірте, що /set-password свідомо лишився поза ним").toEqual(["/login", "/register"]);
  });
});

describe("поверхня авторизації — самі гейти", () => {
  it.each(Object.entries(GATES))("%s — гейт на місці і той самий", (route, gate) => {
    const s = src(`app${route}/page.tsx`);
    expect(s, `гейт ${route} змінився або зник — хто саме тепер проходить, ніхто не звіряв`).toMatch(gate.pin);
    /* Сторінка без перевірки користувача — це відкритий екран незалежно від
       ролевих редіректів нижче. */
    expect(s, `${route} перестала питати користувача`).toMatch(/getUser\(\)/);
  });

  /* ⚠️ ЗАКРИВАЮЧИЙ ПОЗИТИВ ВИВОДИТЬСЯ З ДЖЕРЕЛА, А НЕ ОГОЛОШУЄТЬСЯ.
     Перша редакція цього файлу тримала `closes` полем інвентарю — і це був
     сторож-декларація: досить було зняти позитив і поправити `pin`, щоб
     `closes: "redirect"` лишився брехнею, якої ніхто не бачить. Тепер факт
     береться з коду, а інвентар лише ЗАЯВЛЯЄ його; розходження — червоне.
     Три форми позитива, усі три реальні в дереві: `role !== "…"`,
     `const allowed = …` (/ceo) і термінальний `} else { redirect(…) }`
     (/search). */
  const hasPositive = (s: string) =>
    /profile\.role !== "/.test(s) || /const allowed = /.test(s) || /\} else \{ redirect\(/.test(s);

  it.each(Object.entries(GATES))("%s — заявлений closes збігається з кодом", (route, gate) => {
    expect(hasPositive(src(`app${route}/page.tsx`)),
      `інвентар заявляє closes="${gate.closes}", а код каже інше — сторож перетворився на декларацію`)
      .toBe(gate.closes !== "NONE");
  });

  it("перелік НЕЗАКРИТИХ гейтів — рівно названі винятки", () => {
    /* ⚠️ Це і є ліки від Ф6-4: новий екран із самим лише негативним ланцюгом
       мусить або отримати закриваючий позитив, або бути НАЗВАНИМ тут разом із
       причиною. Мовчки просочитись він не може. */
    const open = Object.keys(GATES).filter((r) => !hasPositive(src(`app${r}/page.tsx`))).sort();
    expect(open, "зʼявився новий екран без закриваючого позитива — або закрийте гейт, або назвіть виняток із причиною").toEqual(OPEN_BY_DESIGN);
    for (const r of OPEN_BY_DESIGN) {
      expect(GATES[r].why, `виняток ${r} лишився без причини`).toBeTruthy();
    }
  });

  it("словник ролей у гейтах не розійшовся з ENUM бази", () => {
    /* Джерело істини — згенеровані типи `supabase/types.ts`, тобто зліпок
       ENUM `user_role` із прода. Міграція, що додасть роль, червонить цей
       рядок — і тоді інвентар доведеться перечитати, а не «доповнити». */
    const t = readFileSync(resolve(process.cwd(), "supabase/types.ts"), "utf8");
    const m = t.match(/user_role:\s*([^\n;]+)/);
    expect(m, "user_role зник із supabase/types.ts").toBeTruthy();
    const enumRoles = (m![1].match(/"([a-z_]+)"/g) || []).map((s) => s.replace(/"/g, "")).sort();
    expect(enumRoles, "склад ролей у базі змінився — перечитайте інвентар гейтів").toEqual(
      ["admin", "ceo", "radiologist", "referrer", "registrar"]);
    const named = new Set<string>();
    for (const r of Object.keys(GATES)) {
      for (const x of src(`app${r}/page.tsx`).match(/profile\.role (?:===|!==) "([a-z_]+)"/g) || []) {
        named.add(x.replace(/.*"([a-z_]+)"/, "$1"));
      }
    }
    const strangers = [...named].filter((r) => !enumRoles.includes(r));
    expect(strangers, "гейт порівнює роль з рядком, якого немає в ENUM — опечатка вимикає гейт мовчки").toEqual([]);
  });
});
