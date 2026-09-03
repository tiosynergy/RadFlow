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
 * ⚠️ ДРУГА РЕДАКЦІЯ (с55, після двох раундів ревʼю). Перша редакція була
 * зелена і при цьому не тримала чотирьох речей — усі знайдені ревʼю, всі
 * звірені особисто по джерелу:
 *   • пін `/ceo` тримав ПРЕДИКАТ (`const allowed = …`), а не НАСЛІДОК: можна
 *     було зняти `redirect("/queue")` і лишитись зеленим — реєстратор потрапляв
 *     на дашборд керівника. Тепер пін кожного гейта мусить містити наслідок, і
 *     це окрема названа властивість, а не акуратність автора;
 *   • пін доводив НАЯВНІСТЬ підрядка, а не те, що гейт ДОСЯЖНИЙ: обгортка
 *     `if (!process.env.X)` над гейтом лишала його зеленим. Тепер пін кожної
 *     сторінки склеєний із `HEAD` в один НЕПЕРЕРВНИЙ ланцюг від `getUser()`;
 *   • `hasPositive` ловився на `const allowed = new Set(roomIds)` з
 *     `/radiologist` — тобто для НОВОГО екрана (той самий випадок, заради якого
 *     файл написаний) перевірка «є закриваючий позитив» була фальшивою;
 *   • «словник ролей із ENUM бази» звірявся з РУКОПИСНИМ `supabase/types.ts`
 *     (скрипта генерації в проєкті немає — перевірено по `package.json`).
 *     Тепер поруч звіряються МІГРАЦІЇ, тобто розгорнутий артефакт.
 *
 * ⚠️ ЧОГО ЦЕЙ ФАЙЛ НЕ РОБИТЬ. Він не доводить, що гейт ПРАЦЮЄ — компонентних
 * тестів у проєкті немає за задумом, сторінки серверні й ходять у Supabase.
 * Він доводить: (1) кожен роут дерева свідомо віднесений до публічних або до
 * захищених; (2) гейт кожної захищеної сторінки лишився ТИМ САМИМ, стоїть
 * НЕПЕРЕРВНО за перевіркою користувача і закінчується НАСЛІДКОМ; (3) сесійний
 * шар справді користується своїми переліками. Він НЕ інвентаризує
 * `app/api/**` і `/fhir/**` — серверна поверхня авторизації лишається
 * поза цим сторожем і це НАЗВАНА межа, а не пропуск (хвіст Ф6, пакет 2).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { codeOf } from "./helpers/codeOf";

const src = (p: string) => codeOf(readFileSync(resolve(process.cwd(), p), "utf8")).replace(/\s+/g, " ");
const MW = "lib/supabase/middleware.ts";
const ROOT_MW = "middleware.ts";

/* ===== 1. РОУТИ — з ДЕРЕВА, а не з переліку =====
   Папки на `_` Next не робить маршрутами за побудовою — їх пропускаємо. А от
   групи `(name)` і паралельні слоти `@slot` РОЗХОДЯТЬ URL зі шляхом у `app/`:
   мовчки «виправити» це відображенням не можна — після такої правки в
   `PROTECTED` осів би шлях, якого не існує. Тому форма НАЗВАНА окремим тестом
   нижче: зʼявиться — сторож скаже перечитати інвентар руками. */
function routesOf(dir: string, prefix: string, acc: string[]): string[] {
  for (const e of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name.startsWith("_")) continue;
      routesOf(`${dir}/${e.name}`, `${prefix}/${e.name}`, acc);
    } else if (e.name === "page.tsx") acc.push(prefix || "/");
  }
  return acc;
}
const ROUTES = routesOf("app", "", []).sort();

/* ===== 2. PROTECTED / AUTH_PAGES — читаються з ДЖЕРЕЛА middleware =====
   Друга копія переліку в тесті перетворила б сторожа на дзеркало: обидві
   сторони мінялись би однією правкою. Тому парсимо з файлу.
   ⚠️ Два запобіжники, обидва з ревʼю: (а) оголошення мусить бути ОДНЕ —
   інакше `match` мовчки взяв би перше; (б) у масиві мусять бути САМІ ЛІТЕРАЛИ —
   на `[...BASE, "/queue"]` сканер бачив би лише хвіст переліку і мовчав би про
   мертвий запис усередині `BASE` та про `/login`, що туди потрапив. */
function listOf(name: string, file: string = MW): string[] {
  const all = [...src(file).matchAll(new RegExp(`const ${name} = \\[([^\\]]*)\\]`, "g"))];
  expect(all.length, `${name} у ${file} оголошено ${all.length} раз(ів) — сканер читає лише перше`).toBe(1);
  const body = all[0][1];
  expect(body.replace(/"[^"]*"|,|\s/g, ""),
    `${name} містить не-літерали — сканер бачить лише частину переліку`).toBe("");
  return (body.match(/"([^"]+)"/g) || []).map((s) => s.replace(/"/g, ""));
}

/* ===== 3. ПУБЛІЧНІ РОУТИ — поіменно і з ПРИЧИНОЮ =====
   Виняток без причини перетворює сторожа на місце, куди тихо додають нове. */
const PUBLIC: Record<string, string> = {
  "/": "лише редірект: залогінений → /queue, інакше → /login; власного вмісту немає",
  "/login": "вхід; у AUTH_PAGES — залогіненого відводить на /queue",
  "/register": "реєстрація центру; у AUTH_PAGES",
  "/set-password": "встановлення пароля за токеном; сесії тут ще немає за побудовою, тому НЕ в PROTECTED і НЕ в AUTH_PAGES",
};

/* ===== 4. ГОЛОВА КОЖНОЇ ЗАХИЩЕНОЇ СТОРІНКИ =====
   Неперервний ланцюг: спитали користувача → відвели анонімного → взяли профіль
   → відвели безпрофільного. Проміжок між `.from("profiles")` і `;` навмисно
   `[^;{}]*`: перелік колонок туди влазить, а ОПЕРАТОР — ні. Тобто вставити
   ранній `return`/`redirect` усередину голови не можна, а дописати колонку в
   `.select()` — можна, і сторож від цього не червоніє. */
const HEAD = /getUser\(\); if \(!user\) redirect\("\/login"\); const \{ data: profile \} = await supabase \.from\("profiles"\)[^;{}]*; if \(!profile\) redirect\("[^"]*"\);/;

/* ===== 5. ІНВЕНТАР ГЕЙТІВ =====
   `may` — хто проходить (звірено ЧИТАННЯМ коду, не сканером: перша редакція
   карти ролей у с55 була знята регексом і виявилась НЕВІРНОЮ на складених
   умовах). Рядки, яких немає в ENUM, — прозаїчні уточнення; тест нижче читає
   лише справжні ролі.
   `closes` — чим закінчується ланцюг:
     "redirect" — є закриваючий позитив із редіректом;
     "render"   — закриваючий позитив, який РЕНДЕРИТЬ пояснення (редірект дав би
                  петлю — див. /setup);
     "NONE"     — лише негативні редіректи, тобто нова роль пройде (Ф6-4).
   `pin` — САМ ГЕЙТ, від першого оператора ланцюга до НАСЛІДКУ включно.
   `apart` — гейт стоїть НЕ впритул до голови (між ними вибірка даних). Це
   послаблення, тому воно поіменне: див. GATE_APART. */
type Gate = { may: string[]; closes: "redirect" | "render" | "NONE"; pin: RegExp; apart?: true; why?: string };

const CHAIN_RAD_REF = 'if \\(profile\\.role === "radiologist"\\) redirect\\("\\/radiologist"\\); if \\(profile\\.role === "referrer"\\) redirect\\("\\/referral"\\); ';
const ADMIN_ONLY = new RegExp(CHAIN_RAD_REF + 'if \\(profile\\.role !== "admin"\\) redirect\\("\\/queue"\\); const clinic = ');

const GATES: Record<string, Gate> = {
  "/queue": {
    may: ["admin", "registrar"], closes: "NONE",
    why: "Ф6-4: закриваючого позитива немає — шоста роль отримала б дошку черги. Текст екрана-відмови ще не затверджений власником; поки тримаємо як НАЗВАНИЙ виняток, а не як норму.",
    pin: new RegExp(CHAIN_RAD_REF + 'if \\(profile\\.role === "ceo"\\) redirect\\("\\/ceo"\\); const clinic = '),
  },
  "/call-list": {
    may: ["admin", "registrar (лише з непорожнім clinic_id)"], closes: "NONE",
    why: "Ф6-4, те саме. Ф6-3 (гейт на ceo і порожній clinic_id) закрито в с55.",
    pin: new RegExp(CHAIN_RAD_REF + 'if \\(profile\\.role === "ceo" \\|\\| !profile\\.clinic_id\\) redirect\\("\\/ceo"\\); const clinic = '),
  },
  "/waitlist": {
    may: ["admin", "registrar (лише з непорожнім clinic_id)"], closes: "NONE",
    why: "Ф6-4, те саме; ceo і порожній clinic_id відводяться.",
    pin: new RegExp(CHAIN_RAD_REF + 'if \\(profile\\.role === "ceo" \\|\\| !profile\\.clinic_id\\) redirect\\("\\/ceo"\\); const clinic = '),
  },
  "/ceo-admin": { may: ["admin"], closes: "redirect", pin: ADMIN_ONLY },
  "/journal": { may: ["admin"], closes: "redirect", pin: ADMIN_ONLY },
  "/referrers": { may: ["admin"], closes: "redirect", pin: ADMIN_ONLY },
  "/staff": { may: ["admin"], closes: "redirect", pin: ADMIN_ONLY },
  "/services": {
    may: ["admin (лише з непорожнім clinic_id)"], closes: "redirect",
    pin: /if \(profile\.role !== "admin" \|\| !profile\.clinic_id\) redirect\("\/queue"\); const clinic = /,
  },
  "/referral": {
    may: ["admin", "referrer"], closes: "redirect",
    pin: /if \(profile\.role === "radiologist"\) redirect\("\/radiologist"\); if \(profile\.role !== "admin" && profile\.role !== "referrer"\) redirect\("\/queue"\); if \(profile\.role === "referrer" && !profile\.approved\) \{ return <Notice/,
  },
  "/radiologist": {
    may: ["admin", "radiologist"], closes: "redirect", apart: true,
    why: "ролева гілка стоїть НИЖЧЕ вибірки `rooms` (RF-2): до відводу сторінка вже сходила в базу за кабінетами центру. Шкоди сьогодні немає — вибірка йде під RLS користувача, — але гейт має піднятись; тримаємо як названий борг.",
    pin: /\} else if \(profile\.role === "referrer"\) \{ redirect\("\/referral"\); \} else if \(profile\.role !== "admin"\) \{ redirect\("\/queue"\); \}/,
  },
  "/ceo": {
    may: ["admin", "ceo", "будь-хто з активним ceo_access"], closes: "redirect", apart: true,
    why: "гейт спирається на `ceo_access`, тому стоїть після вибірки звʼязків — інакше немає з чим порівнювати.",
    pin: /const hasCeoAccess = clinicsMap\.size > 0; const allowed = profile\.role === "admin" \|\| profile\.role === "ceo" \|\| hasCeoAccess; if \(!allowed\) \{ if \(profile\.role === "radiologist"\) redirect\("\/radiologist"\); if \(profile\.role === "referrer"\) redirect\("\/referral"\); redirect\("\/queue"\); \}/,
  },
  "/search": {
    may: ["admin", "registrar", "radiologist", "referrer", "ceo"], closes: "redirect", apart: true,
    why: "сторінка гілкується за роллю на ЧОТИРИ різні набори даних; термінальний `else` — і є гейт.",
    pin: /\} else \{ redirect\("\/queue"\); \} return \( <SearchScreen/,
  },
  "/setup": {
    may: ["admin"], closes: "render",
    why: "редірект на /queue дав би петлю: ненастроєний /queue веде назад на /setup",
    /* ⚠️ Текст відмови — усередині піна навмисно (ревʼю): без нього досить було
       підмінити JSX на `<SetupWizard/>`, і «render» лишався б зеленим, тобто
       відмова тихо ставала б допуском. Проміжок — НЕ `[\s\S]{0,300}`, а вікно,
       яке НЕ ВМІЄ перестрибнути чужий `</h1>`: рівно на цьому класі («вікно
       зловило сусіда») цієї ж сесії вже спіймали два мої піни. */
    pin: new RegExp(CHAIN_RAD_REF + 'if \\(profile\\.role !== "admin"\\) \\{ return \\((?:(?!<\\/h1>)[\\s\\S]){0,300}>Центр ще не налаштовано<\\/h1>'),
  },
};

/* Єдине місце, де «незакритий гейт» дозволений — і воно мусить збігатися з
   інвентарем ТОЧНО, інакше новий негативний ланцюг просочиться мовчки. */
const OPEN_BY_DESIGN = ["/call-list", "/queue", "/waitlist"];
/* Сторінки, де гейт відірваний від голови вибіркою даних. Теж поіменно. */
const GATE_APART = ["/ceo", "/radiologist", "/search"];

describe("поверхня авторизації — перелік проти дерева", () => {
  it("форма дерева — без груп і паралельних слотів", () => {
    expect(ROUTES.filter((r) => /[()@]/.test(r)),
      "у дереві зʼявилась route group або паралельний слот — URL більше не дорівнює шляху в app/; перечитайте PROTECTED та інвентар РУКАМИ, а не вписуйте шлях зі скобками").toEqual([]);
  });

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
    /* ⚠️ Формулювання виправлене за ревʼю: анонімного відведе і сама сторінка
       (`if (!user) redirect("/login")` — це HEAD, він стережеться нижче). Що
       справді втрачається — ешелон: повернення `?redirect=` після входу і те,
       що сторінка лишається ЄДИНИМ гейтом. */
    expect(unguarded, "захищена сторінка випала з PROTECTED — сесійний шар її більше не гейтить: зникає повернення ?redirect= і сторінка лишається єдиним гейтом").toEqual([]);
    const publicInProtected = Object.keys(PUBLIC).filter((r) => r !== "/" && covered(r));
    expect(publicInProtected, "публічний роут потрапив у PROTECTED — вхід або встановлення пароля стануть недосяжними").toEqual([]);
  });

  it("AUTH_PAGES — рівно ті публічні, що відводять залогіненого", () => {
    const AUTH_PAGES = listOf("AUTH_PAGES");
    expect(AUTH_PAGES.slice().sort(), "склад AUTH_PAGES змінився — перевірте, що /set-password свідомо лишився поза ним").toEqual(["/login", "/register"]);
  });

  /* ⚠️ Знахідка ревʼю: обидва переліки читались, але ніде не перевірялось, що
     middleware ними КОРИСТУЄТЬСЯ. Чотири однорядкові правки лишали сканер
     зеленим і вимикали сесійний шар: `if (false && …)`, зрізане префіксне
     зіставлення, `MACHINE_PREFIXES` розширений до "/", сторінковий шлях
     дописаний у виключення `config.matcher`. Кореневий `middleware.ts` до
     цього не читався сканером узагалі. */
  it("сесійний шар справді КОРИСТУЄТЬСЯ своїми переліками", () => {
    const s = src(MW);
    expect(s, "PROTECTED більше не питається — незалогіненого перестало відводити на вхід")
      .toMatch(/if \(!user && matches\(path, PROTECTED\)\) \{ const url = request\.nextUrl\.clone\(\); url\.pathname = "\/login"; url\.searchParams\.set\("redirect", path\); return NextResponse\.redirect\(url\); \}/);
    expect(s, "AUTH_PAGES більше не питається — залогіненого перестало відводити зі входу")
      .toMatch(/if \(user && matches\(path, AUTH_PAGES\)\) \{ const url = request\.nextUrl\.clone\(\); url\.pathname = "\/queue"; return NextResponse\.redirect\(url\); \}/);
    expect(s, "префіксне зіставлення зрізане — /queue/щось перестав бути захищеним")
      .toMatch(/return list\.some\(\(p\) => path === p \|\| path\.startsWith\(p \+ "\/"\)\);/);
    expect(listOf("MACHINE_PREFIXES", ROOT_MW).slice().sort(),
      "машинні префікси змінились — розширення до \"/\" вимикає сесійний шар цілком").toEqual(["/api/integrations/", "/fhir/"]);
    const mm = src(ROOT_MW).match(/matcher: \[ "([^"]+)",? \]/);
    expect(mm, "config.matcher зник із кореневого middleware.ts").toBeTruthy();
    expect(mm![1], "перелік винятків matcher змінився — сторінковий шлях міг випасти із сесійного шару")
      .toBe("/((?!_next/static|_next/image|favicon.ico|board|.*\\\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map)$).*)");
  });
});

describe("поверхня авторизації — самі гейти", () => {
  it.each(Object.entries(GATES))("%s — гейт на місці і той самий", (route, gate) => {
    const s = src(`app${route}/page.tsx`);
    expect(s, `гейт ${route} змінився або зник — хто саме тепер проходить, ніхто не звіряв`).toMatch(gate.pin);
    /* ⚠️ Було `toMatch(/getUser\(\)/)` — це доводило ВИКЛИК, а не відвід
       анонімного: рядок `if (!user) redirect("/login")` можна було зняти, і
       сторож мовчав (ревʼю). Тепер голова стережеться цілком і НЕПЕРЕРВНО. */
    expect(s, `${route}: перевірка користувача розірвана — між getUser() і відводом анонімного зʼявився оператор`).toMatch(HEAD);
  });

  /* ⚠️ ГОЛОВНЕ ЛІКИ ВІД «ПІН — ЦЕ ПРОСТО ПІДРЯДОК».
     `toMatch(pin)` сам по собі не каже нічого про ДОСЯЖНІСТЬ: обгортка
     `if (!process.env.OPEN_ADMIN)` над гейтом лишає підрядок на місці. Тому для
     сторінок, де гейт іде впритул за головою, звіряється СКЛЕЄНИЙ ланцюг —
     будь-яка вставка між ними рве збіг. Сторінки, де гейт відірваний вибіркою
     даних, названі в GATE_APART з причиною. */
  it.each(Object.entries(GATES).filter(([, g]) => !g.apart))("%s — гейт стоїть впритул за перевіркою користувача", (route, gate) => {
    const joined = new RegExp(HEAD.source + " " + gate.pin.source);
    expect(src(`app${route}/page.tsx`),
      `між перевіркою користувача і гейтом ${route} щось вставили — гейт більше не обовʼязково виконується`).toMatch(joined);
  });

  it("гейт відірваний від голови — рівно названі сторінки", () => {
    const apart = Object.entries(GATES).filter(([, g]) => g.apart).map(([r]) => r).sort();
    expect(apart, "новий екран поставив гейт нижче вибірки даних — або підніміть гейт, або назвіть виняток із причиною").toEqual(GATE_APART);
    for (const r of GATE_APART) expect(GATES[r].why, `виняток ${r} лишився без причини`).toBeTruthy();
  });

  /* ⚠️ ЛІКИ ВІД R1: пін, що закінчується на ПРЕДИКАТІ, — не сторож.
     Саме так і було з `/ceo`: пін тримав `const allowed = …`, а зняття
     `redirect("/queue")` під ним лишало все зеленим. Властивість знімається з
     самого регексу, тому діє і на кожен майбутній роут. */
  it.each(Object.entries(GATES))("%s — пін доводить НАСЛІДОК, а не лише умову", (route, gate) => {
    const p = gate.pin.source;
    expect(p.includes("redirect\\(") || p.includes("return \\(") || p.includes("return <"),
      `пін ${route} не містить наслідку (redirect/return) — його можна лишити цілим, знявши сам відвід`).toBe(true);
  });

  /* ⚠️ ЗАКРИВАЮЧИЙ ПОЗИТИВ ВИВОДИТЬСЯ З ДЖЕРЕЛА, А НЕ ОГОЛОШУЄТЬСЯ.
     Перша редакція цього файлу тримала `closes` полем інвентарю — і це був
     сторож-декларація. Тепер факт береться з коду, а інвентар лише ЗАЯВЛЯЄ його.
     ⚠️ ЧЕСНА МЕЖА (ревʼю): для десяти з тринадцяти роутів пін ДОСЛІВНО містить
     те, що шукає `hasPositive`, тож там ці два тести не можуть розійтись —
     незалежна інформація лишається на трьох `NONE`-роутах і на кожному
     МАЙБУТНЬОМУ роуті, чий пін позитива не містить. Це і є той випадок, заради
     якого файл написаний.
     ⚠️ Форми навмисно привʼязані до РОЛІ: `/const allowed = /` без привʼязки
     ловився на `const allowed = new Set(roomIds)` з `/radiologist` — тобто для
     нового екрана перевірка була фальшива. Форма з аллоулистом додана, щоб
     правильна правка (`ALLOWED_ROLES.includes(profile.role)`) не червоніла і не
     виштовхувала автора назад в ідіому `!==`. Локальний псевдонім
     (`const role = profile.role; … role !== "x"`) сюди НЕ входить свідомо: така
     сторінка почервоніє і піде в названі винятки — сторож падає в закритий бік. */
  const hasPositive = (s: string) =>
    /profile\.role !== "/.test(s) ||
    /const allowed = [^;]*profile\.role/.test(s) ||
    /\} else \{ redirect\(/.test(s) ||
    /\.includes\(profile\.role[^)]*\)\) redirect\(/.test(s);

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

  /* ⚠️ Поле `may` було чистою прозою: ревʼю показало, що мутація, яка міняє
     склад тих, хто проходить, лишає підпис під іншим кодом. Половина
     властивості фальсифікована: роль, ЗАЯВЛЕНА як допущена, не сміє
     відводитись у ланцюзі тієї ж сторінки. Друга половина (гейт СТАВ ШИРШИМ,
     ніж каже `may`) регексом не знімається — це названа межа. */
  it.each(Object.entries(GATES))("%s — інвентар не називає допущеною роль, яку код відводить", (route, gate) => {
    const s = src(`app${route}/page.tsx`);
    const bounced = new Set((s.match(/profile\.role === "([a-z_]+)"\) redirect\(/g) || [])
      .map((x) => x.replace(/.*"([a-z_]+)".*/, "$1")));
    for (const r of gate.may) {
      expect(bounced.has(r), `${route}: інвентар каже, що ${r} проходить, а код його відводить`).toBe(false);
    }
  });

  it("словник ролей у гейтах не розійшовся з ENUM бази", () => {
    /* ⚠️ ВИПРАВЛЕНО ЗА РЕВʼЮ. Раніше тут стояло «джерело істини — ЗГЕНЕРОВАНІ
       типи supabase/types.ts». Це була неправда: скрипта генерації типів у
       `package.json` немає (є `db:gate`, `gen:schedule-contract`), а сам файл
       містить рукописні коментарі з номерами міграцій. Тобто `alter type
       user_role add value` на проді лишав би сканер зеленим, а шоста роль уже
       проходила б три `NONE`-гейти. Тому поруч звіряються МІГРАЦІЇ — розгорнутий
       артефакт. Вимірювання с55 (03.09.2026): прод, міграції і types.ts дають
       ті самі пʼять ролей. */
    const t = readFileSync(resolve(process.cwd(), "supabase/types.ts"), "utf8");
    const m = t.match(/user_role:\s*([^\n;]+)/);
    expect(m, "user_role зник із supabase/types.ts").toBeTruthy();
    const enumRoles = (m![1].match(/"([a-z_]+)"/g) || []).map((s) => s.replace(/"/g, "")).sort();
    expect(enumRoles, "склад ролей у types.ts змінився — перечитайте інвентар гейтів").toEqual(
      ["admin", "ceo", "radiologist", "referrer", "registrar"]);

    const dir = resolve(process.cwd(), "supabase/migrations");
    const sql = readdirSync(dir).filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(resolve(dir, f), "utf8")).join("\n");
    const created = (sql.match(/create type user_role as enum \(([^)]*)\)/)?.[1].match(/'([a-z_]+)'/g) || [])
      .map((s) => s.replace(/'/g, ""));
    expect(created.length, "у міграціях не знайдено create type user_role — сканер звіряє порожнечу").toBeGreaterThan(0);
    const added = (sql.match(/alter type user_role add value '([a-z_]+)'/g) || [])
      .map((s) => s.replace(/.*'([a-z_]+)'.*/, "$1"));
    expect([...created, ...added].sort(),
      "міграції додали роль, а supabase/types.ts не переписано — файл рукописний, автоматично він не наздожене базу").toEqual(enumRoles);

    /* Опечатка в назві ролі вимикає гейт мовчки. Скан бере і `profile.role`, і
       локальний псевдонім `role` (/search тримає гейт саме через нього). */
    const named = new Set<string>();
    for (const r of Object.keys(GATES)) {
      for (const x of src(`app${r}/page.tsx`).match(/\brole (?:===|!==) "([a-z_]+)"/g) || []) {
        named.add(x.replace(/.*"([a-z_]+)"/, "$1"));
      }
    }
    const strangers = [...named].filter((r) => !enumRoles.includes(r));
    expect(strangers, "гейт порівнює роль з рядком, якого немає в ENUM — опечатка вимикає гейт мовчки").toEqual([]);
  });
});
