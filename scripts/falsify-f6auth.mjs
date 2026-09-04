// ============================================================
//  Стенд фальсифікації сканера ПОВЕРХНІ АВТОРИЗАЦІЇ (Ф6, пакет 1, с55).
//
//  Сканер зелений із першого прогону — саме тому він тут. Питання те саме:
//  чи ЧЕРВОНІЄ названий тест, коли ламаєш рівно те, що він нібито стереже.
//  Кожна червона позиція називає імʼя сторожа (`expect`).
//
//  ⚠️ ДРУГА РЕДАКЦІЯ (після двох раундів ревʼю). Перша друкувала «13/13
//  адресних» — і це була ПЕРЕОЦІНКА: стенд правив лише ВМІСТ девʼяти файлів,
//  тому два сторожі, які й лікують Ф6-1 («новий екран під новим шляхом»),
//  не адресувались жодною мутацією. Тепер:
//    • є мутації типу `newFile` — стенд СТВОРЮЄ сторінку в дереві;
//    • є мутації самого спека (пін, поле інвентарю) — сторож перевіряється
//      і з боку інвентарю, а не лише з боку продукту;
//    • ручна константа EXPECTED_ADDRESSED ЗНЯТА і замінена ВЛАСТИВІСТЮ:
//      кожне імʼя сторожа з базового прогону мусить бути адресоване хоча б
//      однією червоною мутацією. Зняту мутацію більше не можна погасити
//      підкрученням числа — сторож лишиться неадресованим і стенд впаде;
//    • вердикт звіряє, що названий сторож почервонів У СВОЄМУ спеку
//      (поле `spec` раніше проставлялось і НЕ ЧИТАЛОСЬ).
//
//  ⚠️ Правлю БОЙОВІ файли → try/finally + обробники сигналів.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ у СИРОМУ джерелі.
//  Запуск: node scripts/falsify-f6auth.mjs      Звіт: falsify-f6auth.md
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { verdictOf } from "./lib/falsify-verdict.mjs";

const AS = "tests/authSurface.test.ts";
const FILES = {
  mw: "lib/supabase/middleware.ts",
  rmw: "middleware.ts",
  cl: "app/call-list/page.tsx",
  qb: "app/queue/page.tsx",
  st: "app/staff/page.tsx",
  jr: "app/journal/page.tsx",
  sv: "app/services/page.tsx",
  rf: "app/referral/page.tsx",
  se: "app/search/page.tsx",
  /* с57: RF-2 (гейт піднято над вибіркою) і RF-4 (роль не підставляється). */
  rd: "app/radiologist/page.tsx",
  sb: "components/Sidebar.tsx",
  ty: "supabase/types.ts",
  mg: "supabase/migrations/0001_init.sql",
  rn: "components/RoleNotice.tsx",
  as: AS,
};
const SPECS = [AS];
const OUT = "falsify-f6auth.md";
const REPORT = ".falsify-f6auth.json";

const PAGE_STUB = "export default function Page() {\n  return <div>falsify</div>;\n}\n";

const MUTATIONS = [
  /* ---------- перелік проти дерева ---------- */
  {
    id: "M1", file: "mw", spec: AS, expect: /PROTECTED покриває РІВНО захищені роути/,
    what: "з PROTECTED прибрано /call-list — сесійний шар перестав гейтити дошку обдзвону",
    from: '  "/call-list",\n', to: "",
  },
  {
    id: "M2", file: "mw", spec: AS, expect: /PROTECTED покриває РІВНО захищені роути/,
    what: "у PROTECTED повернувся мертвий запис (Ф6-2)",
    from: '  "/queue",\n', to: '  "/queue",\n  "/incidents",\n',
  },
  {
    id: "M3", file: "mw", spec: AS, expect: /PROTECTED покриває РІВНО захищені роути/,
    what: "у PROTECTED потрапив /login — вхід став недосяжним для незалогіненого",
    from: '  "/setup",\n', to: '  "/setup",\n  "/login",\n',
  },
  {
    id: "M4", file: "mw", spec: AS, expect: /AUTH_PAGES — рівно ті публічні/,
    what: "/set-password дописано в AUTH_PAGES — залогіненого відводить із встановлення пароля",
    from: 'const AUTH_PAGES = ["/login", "/register"];',
    to: 'const AUTH_PAGES = ["/login", "/register", "/set-password"];',
  },
  {
    id: "M15", file: "mw", spec: AS, expect: /сесійний шар справді КОРИСТУЄТЬСЯ своїми переліками/,
    what: "гілку PROTECTED вимкнено на місці — перелік читається, але вже нічого не робить",
    from: "  if (!user && matches(path, PROTECTED)) {",
    to: "  if (false && !user && matches(path, PROTECTED)) {",
  },
  {
    id: "M16", file: "rmw", spec: AS, expect: /сесійний шар справді КОРИСТУЄТЬСЯ своїми переліками/,
    what: 'машинні префікси розширено до "/" — updateSession не викликається взагалі',
    from: 'const MACHINE_PREFIXES = ["/fhir/", "/api/integrations/"];',
    to: 'const MACHINE_PREFIXES = ["/fhir/", "/api/integrations/", "/"];',
  },

  /* ---------- дерево: НОВИЙ ЕКРАН (той самий Ф6-1) ---------- */
  {
    id: "M24", spec: AS, expect: /кожен роут свідомо віднесений/,
    what: "у дереві зʼявилась нова сторінка, якої немає в інвентарі — рівно клас Ф6-1",
    newFile: "app/zz-falsify/page.tsx", content: PAGE_STUB,
  },
  {
    id: "M25", spec: AS, expect: /форма дерева — без груп і паралельних слотів/,
    what: "нова сторінка під route group — URL більше не дорівнює шляху в app/",
    newFile: "app/(zzfalsify)/zz/page.tsx", content: PAGE_STUB,
  },
  {
    id: "M26", file: "as", spec: AS, expect: /інвентар не описує того, чого в дереві немає/,
    what: "в інвентарі публічних зʼявився роут-привид",
    from: '  "/register": "реєстрація центру; у AUTH_PAGES",',
    to: '  "/register": "реєстрація центру; у AUTH_PAGES",\n  "/pricing": "привид",',
  },

  /* ---------- самі гейти ---------- */
  {
    id: "M5", file: "cl", spec: AS, expect: /\/call-list — гейт на місці/,
    what: "Ф6-3 повернена: з дошки обдзвону знято гейт на ceo і порожній clinic_id",
    from: '  if (profile.role === "ceo" || !profile.clinic_id) redirect("/ceo");\n', to: "",
  },
  {
    id: "M6", file: "st", spec: AS, expect: /\/staff — гейт на місці/,
    what: "гейт /staff пустив реєстратора замість адміна",
    from: 'if (profile.role !== "admin") redirect("/queue"); // лише адміністратор',
    to: 'if (profile.role !== "registrar") redirect("/queue"); // лише адміністратор',
  },
  {
    id: "M14", file: "st", spec: AS, expect: /\/staff — гейт на місці/,
    what: "гейт закоментовано — текст у файлі лишився, виконання зникло (перевірка codeOf у ЧЕРВОНИЙ бік)",
    from: '  if (profile.role !== "admin") redirect("/queue"); // лише адміністратор',
    to: '  // if (profile.role !== "admin") redirect("/queue"); // лише адміністратор',
  },
  {
    id: "M23", file: "jr", spec: AS, expect: /\/journal — гейт на місці/,
    what: "знято відвід анонімного — сам виклик getUser() лишився на місці",
    from: '  if (!user) redirect("/login");\n', to: "",
  },
  {
    id: "M17", file: "st", spec: AS, expect: /\/staff — гейт стоїть впритул/,
    what: "над гейтом вставлено ранній вихід — підрядок гейта на місці, виконання вже необовʼязкове",
    from: '  if (!profile) redirect("/login");\n  if (profile.role === "radiologist") redirect("/radiologist");',
    to: '  if (!profile) redirect("/login");\n  if (process.env.NEXT_PUBLIC_OPEN_ADMIN) return null;\n  if (profile.role === "radiologist") redirect("/radiologist");',
  },
  {
    id: "M18", file: "as", spec: AS, expect: /гейт відірваний від голови/,
    what: "з інвентарю знято позначку `apart` — послаблення перестало бути названим",
    /* ⚠️ ПЕРЕЯКОРЕНО в с57. Якір стояв на `/radiologist`, а RF-2 закрито — тієї
       позначки більше немає, і стенд чесно сказав «ЯКІР НЕ УНІКАЛЬНИЙ (0)».
       Це не рот стенда, а наслідок правки продукту: позиція перевіряє
       ВЛАСТИВІСТЬ («послаблення мусить бути названим»), тож стріляє в будь-яке
       живе послаблення — тепер у `/ceo`, чиє відірвання по суті, а не через
       недогляд. */
    from: '    may: ["admin", "ceo", "будь-хто з активним ceo_access"], closes: "redirect", apart: true,',
    to: '    may: ["admin", "ceo", "будь-хто з активним ceo_access"], closes: "redirect",',
  },
  {
    id: "M19", file: "as", spec: AS, expect: /\/ceo — пін доводить НАСЛІДОК/,
    what: 'пін /ceo скорочено до ПРЕДИКАТА — рівно та редакція, що пропускала зняття redirect("/queue")',
    from: '    pin: /const hasCeoAccess = clinicsMap\\.size > 0; const allowed = profile\\.role === "admin" \\|\\| profile\\.role === "ceo" \\|\\| hasCeoAccess; if \\(!allowed\\) \\{ if \\(profile\\.role === "radiologist"\\) redirect\\("\\/radiologist"\\); if \\(profile\\.role === "referrer"\\) redirect\\("\\/referral"\\); redirect\\("\\/queue"\\); \\}/,',
    to: '    pin: /const allowed = profile\\.role === "admin" \\|\\| profile\\.role === "ceo" \\|\\| hasCeoAccess;/,',
  },
  {
    id: "M8", file: "sv", spec: AS, expect: /\/services — гейт на місці/,
    what: "з гейта /services зникла перевірка центру — адмін без клініки проходить",
    from: 'if (profile.role !== "admin" || !profile.clinic_id) redirect("/queue");',
    to: 'if (profile.role !== "admin") redirect("/queue");',
  },
  {
    id: "M9", file: "rf", spec: AS, expect: /\/referral — гейт на місці/,
    what: "«і» замінено на «або» — умова стає тотожно істинною і гейт закривається для ВСІХ, включно з направником",
    from: 'if (profile.role !== "admin" && profile.role !== "referrer") redirect("/queue");',
    to: 'if (profile.role !== "admin" || profile.role !== "referrer") redirect("/queue");',
  },
  {
    id: "M9b", file: "rf", spec: AS, expect: /\/referral — гейт на місці/,
    what: "до гейта порталу дописано реєстратора — гейт СТАВ ШИРШИМ (напрям, якого в першій редакції стенда не було)",
    from: 'if (profile.role !== "admin" && profile.role !== "referrer") redirect("/queue");',
    to: 'if (profile.role !== "admin" && profile.role !== "referrer" && profile.role !== "registrar") redirect("/queue");',
  },
  {
    id: "M10", file: "qb", spec: AS, expect: /\/queue — гейт на місці/,
    what: "з /queue знято відведення керівника — ceo потрапляє на дошку черги",
    from: '  if (profile.role === "ceo") redirect("/ceo"); // керівник — на свій дашборд\n', to: "",
  },
  {
    id: "M21", file: "st", spec: AS, expect: /\/staff — інвентар не називає допущеною роль/,
    what: "нижче гейта дописано відвід адміна — інвентар каже, що адмін проходить, а код його жене",
    from: '  if (clinic && !clinic.configured_at) redirect("/setup");',
    to: '  if (clinic && !clinic.configured_at) redirect("/setup");\n  if (profile.role === "admin") redirect("/queue");',
  },

  /* ---------- закриваючий позитив ---------- */
  {
    id: "M7", file: "jr", spec: AS, expect: /\/journal — заявлений closes збігається з кодом/,
    what: "із /journal знято закриваючий позитив — лишився самий негативний ланцюг",
    from: '  if (profile.role !== "admin") redirect("/queue"); // лише адміністратор\n', to: "",
  },
  {
    id: "M13", file: "se", spec: AS, expect: /\/search — заявлений closes збігається з кодом/,
    what: "із /search знято термінальну гілку — роль поза ланцюгом проходить",
    from: '  } else {\n    redirect("/queue");\n  }', to: "  }",
  },
  {
    id: "M20", file: "qb", spec: AS, expect: /перелік НЕЗАКРИТИХ гейтів/,
    what: "з /queue знято закриваючий позитив — Ф6-4 повернена: шоста роль отримує дошку черги мовчки",
    from: '  if (profile.role !== "admin" && profile.role !== "registrar") {\n    return <RoleNotice title="Доступ обмежено" text="У вашій ролі цей розділ недоступний. Зверніться до адміністратора центру." />;\n  }\n',
    to: "",
  },
  {
    id: "M27", file: "cl", spec: AS, expect: /\/call-list — гейт на місці/,
    what: "текст відмови підмінено дошкою — «render» лишився б зеленим, якби піни не тримали ТЕКСТ",
    from: '    return <RoleNotice title="Доступ обмежено" text="У вашій ролі цей розділ недоступний. Зверніться до адміністратора центру." />;',
    to: '    return <CallListBoard clinicId={profile.clinic_id as string} rooms={[]} entries={[]} />;',
  },

  /* ---------- термінальні екрани (Ф6-5) ---------- */
  {
    id: "M28", file: "rn", spec: AS, expect: /термінальні екрани дають вихід/,
    what: "з екрана-відмови знято кнопку виходу — людина замкнена в петлі (рівно Ф6-5, знайдена на /setup)",
    from: '        <div style={{ marginTop: 20 }}><SignOutButton /></div>\n', to: "",
  },
  {
    id: "M29", spec: AS, expect: /термінальні екрани дають вихід/,
    what: "зʼявився новий повноекранний екран без виходу — саме той напрям, у якому Ф6-5 і просочилась",
    newFile: "components/ZzFalsifyTerminal.tsx",
    content: 'export default function ZzFalsifyTerminal() {\n  return <div style={{ minHeight: "100vh" }}>falsify</div>;\n}\n',
  },

  /* ---------- словник ролей ---------- */
  {
    id: "M11", file: "ty", spec: AS, expect: /словник ролей у гейтах не розійшовся з ENUM/,
    what: "у types.ts зʼявилась шоста роль — інвентар гейтів її не знає",
    from: 'user_role: "admin" | "radiologist" | "registrar" | "referrer" | "ceo"',
    to: 'user_role: "admin" | "radiologist" | "registrar" | "referrer" | "ceo" | "auditor"',
  },
  {
    id: "M22", file: "mg", spec: AS, expect: /словник ролей у гейтах не розійшовся з ENUM/,
    what: "міграція додала роль у БАЗУ, а рукописний types.ts її не наздогнав (Ф6/R9)",
    from: "exception when duplicate_object then null; end $$;\n\ndo $$ begin\n  create type modality",
    to: "exception when duplicate_object then null; end $$;\n\nalter type user_role add value 'auditor';\n\ndo $$ begin\n  create type modality",
  },
  {
    id: "M12", file: "sv", spec: AS, expect: /словник ролей у гейтах не розійшовся з ENUM/,
    what: "опечатка в назві ролі — гейт вимкнено мовчки",
    from: 'if (profile.role !== "admin" || !profile.clinic_id) redirect("/queue");',
    to: 'if (profile.role !== "admln" || !profile.clinic_id) redirect("/queue");',
  },

  /* ---------- ЗЕЛЕНІ ---------- */
  {
    id: "G1", file: "st", green: true,
    /* ⚠️ Позиція переписана після закриття Ф6-4. Попередня вставляла коментар
       у /queue і була б зеленою НЕЗАЛЕЖНО від codeOf, щойно /queue отримав
       справжній позитив — тобто знову стала б наповнювачем (це дефект R10,
       який ревʼю вже одного разу знайшло). Тепер коментар містить ВІДВІД
       адміна: якби codeOf його не зрізав, скан `bounced` побачив би "admin",
       а він у `may` — і сторож «інвентар не називає допущеною роль» почервонів
       би. Зелено тут може бути лише тому, що коментарі зрізаються. */
    what: "над гейтом /staff — КОМЕНТАР із відводом адміна: codeOf його зріже, скан ролей його не побачить",
    from: '  if (profile.role !== "admin") redirect("/queue"); // лише адміністратор',
    to: '  /* приклад із історії: if (profile.role === "admin") redirect("/queue"); */\n  if (profile.role !== "admin") redirect("/queue"); // лише адміністратор',
  },
  {
    id: "G2", file: "jr", green: true,
    what: "гейт переформатовано на два рядки — пін про ЗМІСТ, не про розкладку",
    from: '  if (profile.role !== "admin") redirect("/queue"); // лише адміністратор',
    to: '  if (profile.role !== "admin")\n    redirect("/queue"); // лише адміністратор',
  },
  {
    id: "G3", file: "st", green: true,
    what: "у .select() додано колонку — рутинна правка не сміє червонити сторожа голови",
    from: '.select("clinic_id, full_name, role, clinics(name, configured_at)")',
    to: '.select("clinic_id, full_name, role, phone, clinics(name, configured_at)")',
  },
  {
    id: "G4", green: true,
    what: "приватна папка app/_zz — Next не робить її маршрутом, сканер теж не сміє",
    newFile: "app/_zzfalsify/page.tsx", content: PAGE_STUB,
  },

  /* ---------- с57: RF-2 і RF-4 ---------- */
  {
    id: "M30", file: "rd", spec: AS, expect: /гейт стоїть впритул за перевіркою користувача/,
    what: "RF-2 повернувся: між головою і рольовим гейтом /radiologist знову зʼявилась вибірка",
    from: '  if (profile.role === "referrer") redirect("/referral");',
    to: '  const { data: pre } = await supabase.from("rooms").select("id");\n  void pre;\n  if (profile.role === "referrer") redirect("/referral");',
  },
  {
    id: "M31", file: "se", spec: AS, expect: /імʼя ролі ніколи не стоїть праворуч від/,
    what: "RF-4 повернувся: /search знову підставляє «admin» замість відсутньої ролі",
    from: '  const role = (profile.role as string | null) ?? "";',
    to: '  const role = (profile.role as string) || "admin";',
  },
  {
    /* ⚠️ Регулярка з `'?` (с57): сторож переїхав у `it.each`, і vitest бере імʼя
       пропа в лапки — `'roleKey' — обовʼязковий проп…`. Стара регулярка
       (`roleKey — …`) перестала збігатись, і стенд назвав би це «СТОРОЖА З
       ТАКИМ ІМЕНЕМ НЕМАЄ». Терпимо до обох форм навмисно: імʼя тесту тепер
       складається шаблоном, і його оформлення не наша власність. */
    id: "M32", file: "sb", spec: AS, expect: /roleKey'? — обовʼязковий проп/,
    what: "roleKey знову необовʼязковий — екран без ролі знову збирається",
    from: "  roleKey: string;", to: "  roleKey?: string;",
  },
  {
    id: "M34", file: "sb", spec: AS, expect: /clinicIds'? — обовʼязковий проп/,
    what: "U-65: clinicIds знову необовʼязковий — виклик без центрів знову збирається",
    from: "  clinicIds: string[];", to: "  clinicIds?: string[];",
  },
  {
    /* ДРУГА ПОЛОВИНА того самого сторожа: тип лишається обовʼязковим, а
       повноту гасить ТИПОВЕ ЗНАЧЕННЯ в деструктуризації. Саме цю форму стара
       регулярка піна (`= ["']` — лише рядковий літерал) пропускала для
       проп-масиву: `clinicIds = []` проходило мовчки. */
    id: "M35", file: "sb", spec: AS, expect: /clinicIds'? — обовʼязковий проп/,
    what: "U-65: у clinicIds зʼявилось типове значення `[]` — забутий проп мовчки лишає екран без підписки",
    from: "  roleKey,\n  clinicIds,", to: "  roleKey,\n  clinicIds = [],",
  },
  {
    id: "M33", file: "as", spec: AS, expect: /обхід не порожній/,
    what: "скан RF-4 більше нічого не обходить — обидва його сторожі стали б зеленими на порожнечі",
    from: 'const APP_SRC = ["app", "components", "lib"].flatMap((d) => tsFilesUnder(d));',
    to: "const APP_SRC: string[] = [];",
  },
  {
    id: "G5", file: "sb", green: true,
    what: "легальне порівняння ролі після `||` — сканер fail-open не сміє на нього реагувати",
    from: "  const isAdmin = roleKey === \"admin\";",
    to: "  const isAdmin = roleKey === \"admin\" || roleKey === \"admin\";",
  },
];

const orig = {};
for (const [k, p] of Object.entries(FILES)) orig[k] = readFileSync(p, "utf8");
const created = new Set();
let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  for (const [k, p] of Object.entries(FILES)) writeFileSync(p, orig[k]);
  for (const p of created) { try { rmSync(p, { recursive: true, force: true }); } catch { /* нічого */ } }
  created.clear();
}
process.on("SIGINT", () => { restore(); process.exit(130); });
process.on("SIGTERM", () => { restore(); process.exit(143); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(2); });

/* Для newFile: створити каталог і файл; прибрати рівно те, що створили.
   `top` — найвищий каталог, якого ДО мутації не існувало: саме його і зносимо,
   інакше після «app/(zzfalsify)/zz/page.tsx» лишиться порожня «(zzfalsify)». */
function addFile(rel, content) {
  const parts = rel.split("/");
  let top = null, cur = "";
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur ? `${cur}/${parts[i]}` : parts[i];
    if (!existsSync(cur) && top === null) top = cur;
  }
  mkdirSync(dirname(rel), { recursive: true });
  writeFileSync(rel, content);
  return top ?? rel;
}

function run() {
  if (existsSync(REPORT)) unlinkSync(REPORT);
  spawnSync("npx", ["vitest", "run", ...SPECS, "--reporter=json", `--outputFile.json=${REPORT}`],
    { shell: true, stdio: "ignore", timeout: 10 * 60 * 1000 });
  if (!existsSync(REPORT)) return { crashed: true, ok: false, redBySpec: {}, red: [], all: [] };
  let r;
  try { r = JSON.parse(readFileSync(REPORT, "utf8")); }
  catch { return { crashed: true, ok: false, redBySpec: {}, red: [], all: [] }; }
  const red = [], redBySpec = {}, all = [];
  for (const f of r.testResults || []) {
    const name = String(f.name || "").replace(/\\/g, "/");
    for (const a of f.assertionResults || []) {
      all.push(a.fullName || a.title);
      if (a.status === "passed") continue;
      const full = a.fullName || a.title;
      red.push(full);
      for (const s of SPECS) if (name.endsWith(s)) (redBySpec[s] ??= []).push(full);
    }
  }
  return { crashed: false, ok: r.success === true && red.length === 0, red, redBySpec, all, total: r.numTotalTests };
}

/* Імена, що їх `it.each` розмножує по роутах, зводяться до ОДНОГО сторожа:
   інакше властивість «кожен сторож адресований» вимагала б тринадцяти мутацій
   на кожен each-блок. Зрізаємо перший токен «/route — » де б він не стояв —
   так форма не залежить від того, чим репортер зʼєднує describe і it. */
const labelOf = (full) => String(full).replace(/\/[a-z-]+ — /, "");

let addressedOk = 0;
let baseAll = [];
let baseOk = false;
const lines = [];
try {
  const base = run();
  baseAll = base.all;
  baseOk = base.ok;
  lines.push(`# Стенд фальсифікації сканера поверхні авторизації (Ф6, с55, редакція 2)\n`);
  lines.push(`**БАЗОВА ЛІНІЯ:** ${base.ok ? "ЗЕЛЕНА" : "ЧЕРВОНА"} (${base.total} тестів)\n`);
  if (!base.ok) {
    lines.push(`\n⛔ Базова лінія червона — стенд НІЧОГО не доводить. Червоні: ${base.red.join(", ")}\n`);
  } else {
    lines.push(`\n| # | мутація | очікування | факт | вердикт |`);
    lines.push(`|---|---|---|---|---|`);
    for (const m of MUTATIONS) {
      let path = null, s = null, top = null;
      if (m.newFile) {
        if (existsSync(m.newFile)) { lines.push(`| ${m.id} | ${m.what} | — | ФАЙЛ УЖЕ ІСНУЄ: ${m.newFile} | ⛔ відхилено |`); continue; }
        top = addFile(m.newFile, m.content);
        created.add(top);
      } else {
        path = FILES[m.file];
        s = readFileSync(path, "utf8");
        const n = s.split(m.from).length - 1;
        if (n !== 1) { lines.push(`| ${m.id} | ${m.what} | — | ЯКІР НЕ УНІКАЛЬНИЙ (${n}): ${m.from.slice(0, 46)}… | ⛔ відхилено |`); continue; }
        writeFileSync(path, s.replace(m.from, () => m.to));
      }
      const res = run();
      if (m.newFile) { rmSync(top, { recursive: true, force: true }); created.delete(top); }
      else writeFileSync(path, s);
      const wantRed = !m.green;
      if (res.crashed) { lines.push(`| ${m.id} | ${m.what} | ${wantRed ? "ЧЕРВОНЕ" : "ЗЕЛЕНЕ"} | прогін не відбувся | ⛔ мутація зламала збірку |`); continue; }
      const gotRed = !res.ok;
      /* ⚠️ Названий сторож мусить почервоніти У СВОЄМУ спеку. До редакції 2
         поле `spec` проставлялось і не читалось: звірка йшла по ВСІХ червоних,
         тобто «ЧУЖИЙ спек» не міг статись у принципі. */
      const ownRed = (res.redBySpec[m.spec] || []);
      const missedName = wantRed && gotRed && m.expect && !ownRed.some((t) => m.expect.test(t));
      const noSuchGuard = missedName && !base.all.some((t) => m.expect.test(t));
      const verdict = noSuchGuard ? "⛔ СТОРОЖА З ТАКИМ ІМЕНЕМ НЕМАЄ (дефект стенда)"
        : missedName ? "⛔ ЧУЖИЙ спек"
        : wantRed !== gotRed ? "⛔ СТОРОЖ НЕ ТРИМАЄ" : "✅";
      if (verdict === "✅" && wantRed && m.expect) addressedOk++;
      const fact = gotRed ? res.red.map((t) => `«${t}»`).slice(0, 3).join("; ") : "усе зелене";
      lines.push(`| ${m.id} | ${m.what} | ${wantRed ? "ЧЕРВОНЕ" : "ЗЕЛЕНЕ"} | ${fact} | ${verdict} |`);
    }
  }
} finally {
  restore();
  if (existsSync(REPORT)) unlinkSync(REPORT);
  const verdict = verdictOf(lines, MUTATIONS.length);

  /* ⚠️ ВЛАСТИВІСТЬ ЗАМІСТЬ КОНСТАНТИ (знахідка ревʼю).
     Раніше тут стояло `EXPECTED_ADDRESSED: 13` і звірялось із лічильником,
     виведеним із ТОГО САМОГО масиву мутацій, — самозгодженість, а не перевірка:
     зняту мутацію гасили правкою числа. Тепер покриття рахується по ІМЕНАХ
     сторожів із базового прогону: новий `it` у спеку без своєї мутації
     лишається неадресованим і валить стенд. */
  const declared = MUTATIONS.filter((m) => m.expect && !m.green).length;
  const labels = [...new Set(baseAll.map(labelOf))];
  const coveredLabels = new Set();
  for (const m of MUTATIONS) {
    if (m.green || !m.expect) continue;
    for (const n of baseAll) if (m.expect.test(n)) coveredLabels.add(labelOf(n));
  }
  const uncovered = labels.filter((l) => !coveredLabels.has(l));
  const addressedBad = baseOk && addressedOk !== declared;

  lines.push(`\n## ПІДСУМОК: ${addressedOk}/${declared} адресних (названий сторож почервонів у СВОЄМУ спеку); сторожів у спеку ${labels.length}, з них без власної мутації ${uncovered.length}`);
  if (uncovered.length) lines.push(`\n⛔ СТОРОЖІ БЕЗ МУТАЦІЇ (нічим не фальсифіковані):\n${uncovered.map((l) => `* ${l}`).join("\n")}`);
  lines.push(`\n${verdict.summary}`);
  if (!verdict.ok || addressedBad || uncovered.length) lines.push(`\n**ВЕРДИКТ: ⛔ СТЕНД ЧЕРВОНИЙ**`);
  writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  console.log(lines.join("\n"));
  if (!verdict.ok || addressedBad || uncovered.length) process.exitCode = 1;
}
