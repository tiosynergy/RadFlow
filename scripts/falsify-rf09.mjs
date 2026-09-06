// ============================================================
//  Стенд фальсифікації пакета 37 (с58): RF-09 — токен запрошення.
//
//  Тема: одноразовий токен встановлення пароля перестав бути читаним із
//  таблиці (міграція 0178 зняла табличний SELECT і видала поколонковий
//  allow-list без `invite_token`). Дірa була в ГРАНТІ, а не в екранах — але
//  екрани, які цей грант використовували, зламались би мовчки й повністю:
//  PostgREST відповідає 42501 на ВЕСЬ запит, а не на колонку.
//
//  Головне питання стенда: чи ловлять сторожі саме ТУ регресію, заради якої
//  заведені, — повернення колонки в `select`, збирання переліку колонок із
//  змінної (повз лексичний пін) і повернення токена в рядок списку, де його
//  затирає realtime-`reload()`.
//
//  ⚠️ Правлю БОЙОВІ файли → try/finally + обробники сигналів.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ.
//  ⚠️ Базова лінія мусить бути ЗЕЛЕНОЮ.
//
//  Запуск: node scripts/falsify-rf09.mjs   Звіт: falsify-rf09.md (gitignore)
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf, finishStand } from "./lib/falsify-verdict.mjs";

const FILES = {
  lib: "lib/inviteLink.ts",
  staff: "components/StaffManager.tsx",
  refs: "components/ReferrersManager.tsx",
  route: "app/api/referrers/invite/route.ts",
  ceo: "components/CeoManager.tsx",
};
const SPECS = ["tests/inviteLink.test.ts"];
const OUT = "falsify-rf09.md";
const REPORT = ".falsify-rf09.json";

const MUTATIONS = [
  {
    /* ⚠️ ГОЛОВНА МУТАЦІЯ РІШЕННЯ: «немає токена» знову означає «нічого не
       показувати». Правило на місці, посилання так само не витікає — а адмін
       перестає бачити, що запрошення висить, і не дізнається, як передати
       його ще раз. Саме той дефект, заради якого станів стало три. */
    id: "A1", file: "lib", green: false,
    expect: /«перевидати», а НЕ порожнеча/,
    what: "три стани згорнули назад у два: без токена — порожнеча",
    from: '  return t === null ? { kind: "reissue" } : { kind: "link", token: t };',
    to: '  return t === null ? { kind: "none" } : { kind: "link", token: t };',
  },
  {
    id: "A2", file: "lib", green: false,
    expect: /нічого не показуємо/,
    what: "password_set перестав гасити підказку — мертвий токен показується як живий",
    from: '  if (passwordSet) return { kind: "none" };\n',
    to: "",
  },
  {
    id: "A3", file: "lib", green: false,
    expect: /ЧУЖОГО профілю/,
    what: "токен беруть із карти без ключа профілю — у картку потрапляє чуже посилання",
    from: "  const t = profileId ? tokenOf(fresh[profileId]) : null;",
    to: '  const t = tokenOf(fresh[profileId ?? ""] ?? Object.values(fresh)[0]);',
  },
  {
    id: "A4", file: "lib", green: false,
    expect: /не-рядок — ні/,
    what: "tokenOf вірить будь-якому truthy — об'єкт помилки стає «токеном»",
    from: '  return typeof value === "string" && value.trim() !== "" ? value : null;',
    to: "  return value ? String(value) : null;",
  },
  {
    id: "A5", file: "lib", green: false,
    expect: /порожній і пробільний/,
    what: "пробільний рядок вважається токеном — кнопка копіює порожнє посилання",
    from: '  return typeof value === "string" && value.trim() !== "" ? value : null;',
    to: '  return typeof value === "string" && value !== "" ? value : null;',
  },
  {
    /* Відповідь без поля — це «роут не сказав», а не «токена немає». Мутація
       робить із мовчання стирання: після будь-якої іншої відповіді роута
       свіже посилання зникає з екрана. */
    id: "A6", file: "lib", green: false,
    expect: /НЕ затирає вже відомий/,
    what: "порожнє значення затирає вже відомий токен",
    from: "  if (!profileId || t === null) return prev;",
    to: "  if (!profileId) return prev;\n  if (t === null) { const n = { ...prev }; delete n[profileId]; return n; }",
  },
  {
    id: "A7", file: "lib", green: false,
    expect: /rememberToken.*не мутує попередню карту/s,
    what: "rememberToken пише в попередню карту — React не побачить зміни",
    from: "  return { ...prev, [profileId]: t };",
    to: "  (prev as Record<string, string>)[profileId] = t;\n  return prev;",
  },
  {
    id: "A8", file: "lib", green: false,
    expect: /ТУ САМУ посилання/,
    what: "той самий токен щоразу дає нову карту — зайвий рендер на кожну відповідь",
    from: "  if (prev[profileId] === t) return prev;\n",
    to: "",
  },
  {
    /* ⚠️ Тонка: після ПОВТОРНОГО скидання на сервері живе НОВИЙ токен, старий
       мертвий. Мутація лишає в карті старий — адмін копіює посилання, яке вже
       не працює, і не розуміє чому. */
    id: "A9", file: "lib", green: false,
    expect: /ЗАМІНЮЄ старий/,
    what: "новий токен не замінює старий — копіюється мертве посилання",
    from: "  if (prev[profileId] === t) return prev;",
    to: "  if (prev[profileId]) return prev;",
  },
  {
    id: "A10", file: "lib", green: false,
    expect: /прибирає ключ/,
    what: "forgetToken нічого не забуває",
    from: "  if (!(profileId in prev)) return prev;",
    to: "  return prev;\n  if (!(profileId in prev)) return prev;",
  },
  {
    id: "A11", file: "lib", green: false,
    expect: /згадує «Скинути пароль»/,
    what: "підказка перестала казати, ЯК передати посилання ще раз",
    from: "  \"🔗 Пароль ще не встановлено. Посилання показуємо лише один раз — щоб передати його знову, натисніть «Скинути пароль» (старе перестане діяти).\";",
    to: "  \"🔗 Пароль ще не встановлено.\";",
  },
  {
    id: "A12", file: "lib", green: false,
    expect: /сміття в карті/,
    what: "порожній рядок у карті стає посиланням",
    from: "  const t = profileId ? tokenOf(fresh[profileId]) : null;",
    to: "  const t = profileId ? (fresh[profileId] ?? null) : null;",
  },
  {
    /* ⚠️ САМА РЕГРЕСІЯ, заради якої стенд і заведено: колонку повертають у
       select. Після 0178 це не «зайве поле», а 42501 на весь запит — список
       персоналу стає порожнім, і жоден юніт-тест поведінки цього не побачить,
       бо живої БД у vitest немає. */
    id: "B1", file: "staff", green: false,
    expect: /StaffManager.tsx: КОЖЕН запит до profiles/,
    what: "StaffManager знову просить invite_token у профілів",
    from: '.select("id, login, full_name, email, contact_email, phone, note, password_set, role")',
    to: '.select("id, login, full_name, email, contact_email, phone, note, password_set, invite_token, role")',
  },
  {
    id: "B2", file: "refs", green: false,
    expect: /ReferrersManager.tsx: КОЖЕН запит до profiles/,
    what: "ReferrersManager знову просить invite_token у профілів",
    from: '.select("id, login, full_name, phone, note, password_set")',
    to: '.select("id, login, full_name, phone, note, password_set, invite_token")',
  },
  {
    /* ⚠️ ОБХІД ЛЕКСИЧНОГО ПІНА, названий вголос: перелік колонок збирають зі
       змінної. Пін по тексту `select("…")` осліп би — тому є окремий сторож,
       що вимагає саме рядковий літерал. */
    id: "B3", file: "staff", green: false,
    expect: /StaffManager.tsx: КОЖЕН запит до profiles/,
    what: "перелік колонок зібрано зі змінної — лексичний пін осліп",
    from: 'supabase.from("profiles").select("id, login, full_name, email, contact_email, phone, note, password_set, role")',
    to: 'supabase.from("profiles").select(["id","login","full_name","email","contact_email","phone","note","password_set","invite_token","role"].join(", "))',
  },
  {
    id: "B4", file: "staff", green: false,
    expect: /StaffManager.tsx: токен кладуть у карту в КОЖНОМУ обробнику/,
    what: "StaffManager перестав класти токен на шляху скидання — кнопка «Скопіювати» там не зʼявиться ніколи",
    from: "    setFreshTokens((m) => rememberToken(m, profileId, data.invite_token));",
    to: "",
  },
  {
    /* ⚠️ Повернення ПРИХОВАНОГО дефекту, який 0178 і полікувала: токен кладуть
       у рядок списку, і наступний realtime-`reload()` затирає його разом із
       рядком. Кнопка зникає сама собою, і виглядає це як «глюк». */
    id: "B5", file: "refs", green: false,
    expect: /ReferrersManager.tsx: токен кладуть у карту в КОЖНОМУ обробнику/,
    what: "токен знову кладуть у рядок списку — realtime-reload його затирає",
    from: 'setRows((rs) => rs.map((x) => (x.referrer_id === r.referrer_id ? { ...x, referrer: { ...x.referrer, password_set: false } } : x)));',
    to: 'setRows((rs) => rs.map((x) => (x.referrer_id === r.referrer_id ? { ...x, referrer: { ...x.referrer, password_set: false, invite_token: data.invite_token } } : x)));\n    void r.referrer.invite_token;',
  },
  {
    id: "B6", file: "route", green: false,
    expect: /повертає referrer_id/,
    what: "роут запрошення перестав повертати referrer_id — карті нема ключа, токен нікуди покласти",
    from: "referrer_id: referrerId, invite_token: inviteToken",
    to: "invite_token: inviteToken",
  },
  {
    /* Безпечний зразок у проєкті вже є (RPC ceo_list_for_clinic). Мутація
       відводить CeoManager назад на пряме читання таблиці — тобто відкриває
       RF-09 з іншого боку. */
    id: "B7", file: "ceo", green: false,
    expect: /CeoManager НЕ чіпаємо/,
    what: "CeoManager відводять від RPC назад на пряме читання profiles",
    from: '.rpc("ceo_list_for_clinic"',
    to: '.from("profiles").select("id, invite_token").eq("zz", "ceo_list_for_clinic"',
  },
  {
    /* ⚠️ ТРЕТІЙ ОБХІД, знайдений ревʼю Б (M-1) і НЕ спійманий першою редакцією
       пінів: карту токенів обнуляють у `reload()`. Дефект повертається
       ЦІЛКОМ — `reload()` смикається на кожен фокус вкладки, тож посилання
       зникає через секунду після видачі, — а весь гейт лишався зеленим. */
    id: "B8", file: "staff", green: false,
    expect: /StaffManager.tsx: карту токенів не обнуляють/,
    what: "карту токенів скидають у reload() — посилання зникає через секунду після видачі",
    from: "    setRadRooms(rr || []);",
    to: "    setRadRooms(rr || []);\n    setFreshTokens(EMPTY_TOKENS);",
  },
  {
    id: "B9", file: "refs", green: false,
    expect: /ReferrersManager.tsx: карту токенів не обнуляють/,
    what: "те саме в ReferrersManager: realtime-reload обнуляє карту",
    from: "    setLoading(false);\n  }, [clinicId]);",
    to: "    setFreshTokens(EMPTY_TOKENS);\n    setLoading(false);\n  }, [clinicId]);",
  },
  {
    /* ⚠️ ДРУГИЙ ОБХІД ревʼю Б (M-2): розрив між `from("profiles")` і
       `.select(` через змінну. Лексичний пін першої редакції цього не бачив,
       а страхувальний «хоч один select є» був вдоволений СТАРИМ, чистим
       запитом. Тепер рахуються обидва боки. */
    id: "B10", file: "staff", green: false,
    expect: /StaffManager.tsx: КОЖЕН запит до profiles/,
    what: "другий запит до profiles зібрано в обхід піна — через змінну",
    from: "    const supabase = createClient();\n    const [{ data: profs }, { data: rr }] = await Promise.all([",
    to: "    const supabase = createClient();\n    const q = supabase.from(\"profiles\");\n    const { data: toks } = await q.select(\"id, invite_token\").eq(\"clinic_id\", clinicId);\n    void toks;\n    const [{ data: profs }, { data: rr }] = await Promise.all([",
  },
  {
    /* ⚠️ ПЕРШИЙ ОБХІД ревʼю Б (M-3): шар рендеру не був запінений узагалі —
       підказку прибирають із JSX, лишивши константу імпортованою, і всі
       поведінкові тести зелені. */
    id: "B11", file: "staff", green: false,
    expect: /StaffManager.tsx: підказку «перевидати» справді МАЛЮЮТЬ/,
    what: "підказку прибрали з рендеру — на екрані знову порожнеча",
    from: '                      <div style={{ fontSize: "0.75rem", marginTop: 8, color: "var(--text-muted)" }}>{REISSUE_HINT}</div>',
    to: '                      <div style={{ fontSize: "0.75rem", marginTop: 8, color: "var(--text-muted)" }} title={REISSUE_HINT} />',
  },
  {
    id: "B12", file: "refs", green: false,
    expect: /ReferrersManager.tsx: підказку «перевидати» справді МАЛЮЮТЬ/,
    what: "те саме в ReferrersManager: підказка стала тултипом",
    from: '              return <div style={{ fontSize: "0.75rem", marginTop: 4, color: "var(--text-muted)" }}>{REISSUE_HINT}</div>;',
    to: '              return <div style={{ fontSize: "0.75rem", marginTop: 4, color: "var(--text-muted)" }} title={REISSUE_HINT} />;',
  },
  {
    /* ⚠️ ТРЕТІЙ ШЛЯХ ВИДАЧІ, знайдений ревʼю Б (M-4): «Запросити знову» в
       «Історії» смикає той самий роут і викидає живий токен мовчки. */
    id: "B13", file: "refs", green: false,
    expect: /ReferrersManager.tsx: токен кладуть у карту в КОЖНОМУ обробнику/,
    what: "reinvite перестав класти токен — «Запросити знову» видає посилання й губить його",
    from: "    setFreshTokens((m) => rememberToken(m, String(data.referrer_id ?? \"\"), data.invite_token));\n    notify(\"Запрошення надіслано повторно",
    to: "    notify(\"Запрошення надіслано повторно",
  },
  {
    /* ПОЗИТИВНИЙ КОНТРОЛЬ №3, заведений за MINOR ревʼю Б: винесення переліку
       колонок в іменовану константу — доброякісний рефактор. Пін мусить його
       ПРИЙМАТИ; сторож, що червоніє на нормальну правку, буде знятий
       (урок 0141). */
    id: "T3", file: "refs", green: true,
    what: "перелік колонок винесено в іменовану константу",
    from: '      const { data: profs } = await supabase.from("profiles").select("id, login, full_name, phone, note, password_set").in("id", ids);',
    to: '      const REF_COLS = "id, login, full_name, phone, note, password_set";\n      const { data: profs } = await supabase.from("profiles").select(REF_COLS).in("id", ids);',
  },
  {
    /* ПОЗИТИВНИЙ КОНТРОЛЬ: у select додали ІНШУ дозволену колонку. Сторож
       стереже саме `invite_token`, а не точний перелік — інакше він червонів
       би на кожну нормальну правку і його зняли б (урок 0141). */
    id: "T1", file: "refs", green: true,
    what: "у select направників додано дозволену колонку `city`",
    from: '.select("id, login, full_name, phone, note, password_set")',
    to: '.select("id, login, full_name, phone, note, password_set, city")',
  },
  {
    /* ПОЗИТИВНИЙ КОНТРОЛЬ: перейменування локальної змінної рішення нічого
       не ламає — піни стережуть ІМЕНА експортів і текст запиту, а не форму
       коду навколо. */
    id: "T2", file: "lib", green: true,
    what: "локальну змінну в inviteHint перейменовано",
    from: "  const t = profileId ? tokenOf(fresh[profileId]) : null;\n  return t === null ? { kind: \"reissue\" } : { kind: \"link\", token: t };",
    to: "  const tok = profileId ? tokenOf(fresh[profileId]) : null;\n  return tok === null ? { kind: \"reissue\" } : { kind: \"link\", token: tok };",
  },
];

const editsOf = (m) => m.edits ?? [{ file: m.file, from: m.from, to: m.to }];

for (const m of MUTATIONS) {
  const eds = editsOf(m);
  const bad =
    (!m.green && !m.expect) ? "мутація мусить червоніти, але не називає сторожа (`expect`)"
    : (m.green && m.expect) ? "`expect` у рядку, який МУСИТЬ лишитись зеленим — сторожа тут не буває"
    : (m.expect && /\|/.test(m.expect.source)) ? "у регулярці `|` — вона зламає таблицю звіту"
    : (m.edits && (m.file || m.from || m.to)) ? "змішані форми: є `edits` і водночас `file`/`from`/`to`"
    : eds.some((e) => !e.file || !FILES[e.file] || typeof e.from !== "string" || typeof e.to !== "string")
      ? "правка без файлу з FILES або без from/to"
    : new Set(eds.map((e) => e.file)).size !== eds.length ? "дві правки в один файл у межах мутації"
    : null;
  if (bad) {
    console.error(`⛔ ІНВЕНТАР БРЕШЕ: ${m.id} — ${bad}. Стенд НЕ прогнано.`);
    process.exit(1);
  }
}

/* ⚠️ Кількість адресних мутацій — КОНСТАНТА, а не підрахунок на льоту: інакше
   найдешевший спосіб «полагодити» стенд — зняти позицію разом зі сторожем, і
   слідів не лишиться. Зменшити можна лише свідомо, правкою цього рядка.
   с58, пакет 37: A1–A12 — чисте рішення (три стани, tokenOf, карта токенів),
   B1–B7 — поверхня (select без колонки, літеральність переліку, токен із
   відповіді роута, ключ referrer_id, CeoManager на RPC).
   ⚠️ B8–B13 заведені ПІСЛЯ ревʼю Б, яке пробило перші піни ТРИЧІ: обнулення
   карти в `reload()` (B8/B9), розрив `from`↔`select` через змінну (B10),
   непінований шар рендеру (B11/B12) і третій, забутий шлях видачі `reinvite`
   (B13). Жодна з них не «докинута для числа» — кожна відповідає названій
   ревʼю дірці, і кожна була ЗЕЛЕНОЮ до правки пінів.
   Плюс три позитивні контролі T1, T2, T3 (T3 — за MINOR ревʼю: іменована
   константа з переліком колонок мусить лишатись зеленою). */
const EXPECTED_RED = 25;
const redCount = MUTATIONS.filter((m) => !m.green).length;
if (redCount !== EXPECTED_RED) {
  console.error(`⛔ ІНВЕНТАР БРЕШЕ: адресних мутацій ${redCount}, а очікується ${EXPECTED_RED}. `
    + "Якщо позицію знято свідомо — поправте EXPECTED_RED разом із нею. Стенд НЕ прогнано.");
  process.exit(1);
}

const orig = {};
for (const [k, p] of Object.entries(FILES)) orig[k] = readFileSync(p, "utf8");
let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  for (const [k, p] of Object.entries(FILES)) writeFileSync(p, orig[k]);
}
process.on("SIGINT", () => { restore(); process.exit(130); });
process.on("SIGTERM", () => { restore(); process.exit(143); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(2); });

function run() {
  if (existsSync(REPORT)) unlinkSync(REPORT);
  spawnSync("npx", ["vitest", "run", ...SPECS, "--reporter=json", `--outputFile.json=${REPORT}`],
    { shell: true, stdio: "ignore" });
  if (!existsSync(REPORT)) return { crashed: true, ok: false, red: [] };
  let r;
  try { r = JSON.parse(readFileSync(REPORT, "utf8")); }
  catch { return { crashed: true, ok: false, red: [] }; }
  const red = [], all = [];
  for (const f of r.testResults || []) {
    for (const a of f.assertionResults || []) {
      const n = a.fullName || a.title;
      all.push(n);
      if (a.status !== "passed") red.push(n);
    }
  }
  return { crashed: false, ok: r.success === true && red.length === 0, red, all, total: r.numTotalTests };
}

const lines = [];
let addressedOk = 0;
try {
  const base = run();
  lines.push(`# Стенд фальсифікації пакета 37 — RF-09 (токен запрошення більше не читається з таблиці)\n`);
  lines.push(`**БАЗОВА ЛІНІЯ:** ${base.ok ? "ЗЕЛЕНА" : "ЧЕРВОНА"} (${base.total} тестів)\n`);
  if (!base.ok) {
    lines.push(`\n⛔ Базова лінія червона — стенд НІЧОГО не доводить. Червоні: ${base.red.join(", ")}\n`);
  } else {
    lines.push(`\n| # | мутація | очікування | факт | вердикт |`);
    lines.push(`|---|---|---|---|---|`);
    for (const m of MUTATIONS) {
      const eds = editsOf(m).map((e) => ({ ...e, path: FILES[e.file], src: readFileSync(FILES[e.file], "utf8") }));
      const dead = eds.find((e) => e.src.split(e.from).length - 1 !== 1);
      if (dead) {
        const n = dead.src.split(dead.from).length - 1;
        lines.push(`| ${m.id} | ${m.what} | — | ЯКІР НЕ УНІКАЛЬНИЙ (${n}) у ${dead.path} | ⛔ відхилено |`);
        continue;
      }
      for (const e of eds) writeFileSync(e.path, e.src.replace(e.from, () => e.to));
      const res = run();
      for (const e of eds) writeFileSync(e.path, e.src);
      const wantRed = !m.green;
      if (res.crashed) {
        lines.push(`| ${m.id} | ${m.what} | ${wantRed ? "ЧЕРВОНЕ" : "ЗЕЛЕНЕ"} | прогін не відбувся | ⛔ мутація зламала збірку |`);
        continue;
      }
      const gotRed = !res.ok;
      const fact = gotRed ? res.red.map((t) => `«${t}»`).join("; ") : "усе зелене";
      const missed = wantRed && gotRed && !res.red.some((t) => m.expect.test(t));
      const noSuchGuard = missed && !res.all.some((t) => m.expect.test(t));
      const verdict = noSuchGuard ? "⛔ СТОРОЖА З ТАКИМ ІМЕНЕМ НЕМАЄ (дефект стенда)"
        : missed ? "⛔ ЧУЖИЙ спек"
        : (wantRed === gotRed ? "✅" : "⛔ СТОРОЖ НЕ ТРИМАЄ");
      if (verdict === "✅" && wantRed) addressedOk++;
      const want = wantRed ? `ЧЕРВОНЕ: ${m.expect.source}` : "ЗЕЛЕНЕ";
      lines.push(`| ${m.id} | ${m.what} | ${want} | ${fact} | ${verdict} |`);
    }
  }
} finally {
  restore();
  if (existsSync(REPORT)) unlinkSync(REPORT);
  const verdict = verdictOf(lines, MUTATIONS.length);
  lines.push(`\n${verdict.summary}`);
  lines.push(`\n## ПІДСУМОК: ${addressedOk}/${EXPECTED_RED} адресних, ${MUTATIONS.length - EXPECTED_RED} рефакторних`);
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nЗвіт: ${OUT}. Файли відновлено.`);
  finishStand({
    ok: !(!verdict.ok),
    red: "\n⛔ ВЕРДИКТ: СТЕНД ЧЕРВОНИЙ — причина в таблиці вище.",
  });
}
