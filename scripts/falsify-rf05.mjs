// ============================================================
//  Стенд фальсифікації пакета 39 (с59): RF-05 — гейт міграцій без fail-open,
//  плюс подія журналу на скидання/встановлення пароля.
//
//  Головне питання стенда: чи ловлять сторожі ПОВЕРНЕННЯ саме тих двох
//  обходів, які жили в гейті місяць (skip-змінна на Vercel; «мʼякий пропуск»
//  без ключів), і чи ловлять вони «подію без сліду» на шляху скидання пароля —
//  зокрема подію ДО запису і токен у details.
//
//  ⚠️ Правлю БОЙОВІ файли → try/finally + обробники сигналів.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ.
//  ⚠️ Базова лінія мусить бути ЗЕЛЕНОЮ.
//
//  Запуск: node scripts/falsify-rf05.mjs   Звіт: falsify-rf05.md (gitignore)
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf, finishStand } from "./lib/falsify-verdict.mjs";

const FILES = {
  lib: "scripts/migration-gate-lib.mjs",
  cli: "scripts/migration-gate.mjs",
  yml: ".github/workflows/gate.yml",
  route: "app/api/staff/password/route.ts",
  journal: "lib/journalText.ts",
};
const SPECS = ["tests/migrationGateEnv.test.ts", "tests/staffPasswordRoute.test.ts", "tests/journal.test.ts"];
const OUT = "falsify-rf05.md";
const REPORT = ".falsify-rf05.json";

/* Блок емісії події в роуті — один рядок-якір для C1/C2. */
const EMIT_BLOCK = "  await emitImportantEvent({\n    clinicId: me.clinic_id,\n    actorId: user.id,\n    eventType: \"staff.access_changed\",\n    entityType: \"staff\",\n    entityId: targetId,\n    details: { action: parsed.data.action === \"reset\" ? \"password_reset\" : \"password_set\", targetRole: target.role },\n  });\n";

const MUTATIONS = [
  /* ---------------- A: рішення (чиста функція) ---------------- */
  {
    /* САМ ОБХІД №1: skip-змінна на Vercel знову пропускає збірку. */
    id: "A1", file: "lib", green: false,
    expect: /RADFLOW_SKIP_MIGRATION_GATE=1 → fail/,
    what: "на Vercel skip-змінна знову дає skip (fail-open №1 повернувся)",
    from: '    if (skip) {\n      return { action: "fail", message:\n        "[migration-gate] ВІДМОВА: RADFLOW_SKIP_MIGRATION_GATE=1 у збірці Vercel — "',
    to: '    if (skip) {\n      return { action: "skip", message:\n        "[migration-gate] ВІДМОВА: RADFLOW_SKIP_MIGRATION_GATE=1 у збірці Vercel — "',
  },
  {
    /* САМ ОБХІД №2: без ключів на Vercel — мʼякий пропуск. */
    id: "A2", file: "lib", green: false,
    expect: /без ключів → fail/,
    what: "на Vercel без ключів знову «мʼякий пропуск» (fail-open №2 повернувся)",
    from: '    if (!hasKeys) {\n      return { action: "fail", message:\n        "[migration-gate] ВІДМОВА: у збірці Vercel немає',
    to: '    if (!hasKeys) {\n      return { action: "skip", message:\n        "[migration-gate] ВІДМОВА: у збірці Vercel немає',
  },
  {
    id: "A3", file: "lib", green: false,
    expect: /RADFLOW_GATE_NO_DB=1 → fail/,
    what: "на Vercel RADFLOW_GATE_NO_DB=1 пропускає збірку",
    from: '    if (noDb) {\n      return { action: "fail", message:\n        "[migration-gate] ВІДМОВА: RADFLOW_GATE_NO_DB=1 у збірці Vercel — "',
    to: '    if (noDb) {\n      return { action: "skip", message:\n        "[migration-gate] ВІДМОВА: RADFLOW_GATE_NO_DB=1 у збірці Vercel — "',
  },
  {
    /* Поза Vercel без ключів — мовчазний пропуск без явного noDb (старий
       «мʼякий пропуск» у --build). */
    id: "A4", file: "lib", green: false,
    expect: /без явного noDb → fail/,
    what: "поза Vercel без ключів у --build — пропуск без явного RADFLOW_GATE_NO_DB",
    from: "    if (buildMode && noDb) {",
    to: "    if (buildMode) {",
  },
  {
    id: "A5", file: "lib", green: false,
    expect: /skip БЕЗ --build/,
    what: "skip-змінна обходить і db:gate / db:gate:check (не лише --build)",
    from: "  if (skip) {\n    if (!buildMode) {",
    to: "  if (skip) {\n    if (false && !buildMode) {",
  },
  {
    /* Порядок гілок на Vercel: ключі перевіряються ПЕРШИМИ — повідомлення
       про відмову називає ключі, а не skip; оператор шукає не ту змінну. */
    id: "A6", file: "lib", green: false,
    expect: /skip \+ noDb \+ без ключів разом/,
    what: "на Vercel гілки перевіряються після ключів: відмова називає ключі, а не skip",
    from: "  if (vercel) {\n    if (skip) {",
    to: "  if (vercel) {\n    if (!hasKeys) return { action: \"fail\", message: \"[migration-gate] ВІДМОВА: немає SUPABASE_SERVICE_ROLE_KEY\" };\n    if (skip) {",
  },
  {
    /* Vercel «з ключами» вважає себе локальною збіркою — skip знову дає WARN
       і exit 0 у проді (перша редакція A6; стенд с59 показав, що це ловить
       саме тест на skip, а не комбінований). */
    id: "A7", file: "lib", green: false,
    expect: /RADFLOW_SKIP_MIGRATION_GATE=1 → fail \(раніше — WARN і exit 0\)/,
    what: "Vercel з ключами йде локальною гілкою: skip зі своїми ключами прослизає",
    from: "  if (vercel) {\n    if (skip) {",
    to: "  if (vercel && !hasKeys) {\n    if (skip) {",
  },
  /* ---------------- B: CLI ---------------- */
  {
    /* CLI ігнорує fail — рішення є, дії немає. */
    id: "B1", file: "cli", green: false,
    expect: /дія fail → process\.exit\(1\)/,
    what: "CLI не виходить із кодом 1 на fail",
    from: '  if (decision.action === "fail") {\n    console.error(decision.message);\n    process.exit(1);\n  }',
    to: '  if (decision.action === "fail") {\n    console.error(decision.message);\n  }',
  },
  {
    /* Повернення старого раннього return-у ПЕРЕД рішенням. */
    id: "B2", file: "cli", green: false,
    expect: /рівно один return/,
    what: "старий ранній return на skip-змінну повернувся ПЕРЕД рішенням",
    from: "  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;\n  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;\n  const decision",
    to: '  if (process.env.RADFLOW_SKIP_MIGRATION_GATE === "1") {\n    console.warn("skip");\n    return;\n  }\n  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;\n  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;\n  const decision',
  },
  {
    /* VERCEL читається не з тієї змінної — на Vercel рішення «поза Vercel». */
    id: "B3", file: "cli", green: false,
    expect: /VERCEL — з process\.env\.VERCEL/,
    what: "vercel визначається за іншою змінною — прод-збірка вважає себе локальною",
    from: '    vercel: process.env.VERCEL === "1",',
    to: '    vercel: process.env.RADFLOW_VERCEL === "1",',
  },
  {
    id: "B4", file: "yml", green: false,
    expect: /gate\.yml називає пропуск явно/,
    what: "CI прибрав явний RADFLOW_GATE_NO_DB (з новим гейтом CI просто червоніє — але пін мусить це сказати)",
    from: '        env:\n          # CI без секретів: пропуск ЯВНИЙ, лог каже «БЕЗ ЗВІРКИ» (RF-05, с59).\n          RADFLOW_GATE_NO_DB: "1"\n',
    to: "",
  },
  /* ---------------- C: подія на скидання пароля ---------------- */
  {
    id: "C1", file: "route", green: false,
    expect: /reset: 200.*подія password_reset/,
    what: "подію на скидання пароля прибрали — гучний шлях знову без сліду",
    from: EMIT_BLOCK,
    to: "",
  },
  {
    /* Подія ДО запису: при відмові updateUserById журнал каже «скинуто». */
    id: "C2", file: "route", green: false,
    expect: /подія password_reset ПІСЛЯ запису/,
    what: "подія емітиться ДО оновлення пароля/profiles (ПЕРЕНЕСЕНО, не продубльовано — ревʼю А)",
    edits: [
      { file: "route", from: EMIT_BLOCK, to: "" },
      { file: "route",
        from: "  const { error: uErr } = await admin.auth.admin.updateUserById(targetId, { password: newPass });",
        to: EMIT_BLOCK + "  const { error: uErr } = await admin.auth.admin.updateUserById(targetId, { password: newPass });" },
    ],
  },
  {
    /* Ревʼю А: подія ПІСЛЯ profiles, але ДО auth — при відмові GoTrue журнал
       каже «скинуто», а старий пароль живий. */
    id: "C11", file: "route", green: false,
    expect: /GoTrue відмовив → 400/,
    what: "auth-запис перенесено ПІСЛЯ profiles і події: відмова GoTrue лишає подію «скинуто»",
    edits: [
      { file: "route",
        from: "  const { error: uErr } = await admin.auth.admin.updateUserById(targetId, { password: newPass });\n  if (uErr) return NextResponse.json({ error: safeDbError(\"api/staff/password\", uErr) }, { status: 400 });\n",
        to: "" },
      { file: "route",
        from: "  return NextResponse.json({ ok: true, invite_token: inviteToken });",
        to: "  const { error: uErr } = await admin.auth.admin.updateUserById(targetId, { password: newPass });\n  if (uErr) return NextResponse.json({ error: safeDbError(\"api/staff/password\", uErr) }, { status: 400 });\n  return NextResponse.json({ ok: true, invite_token: inviteToken });" },
    ],
  },
  {
    /* Ревʼю А: подія в центр ЦІЛІ — для CEO це NULL, подія мовчки губиться. */
    id: "C12", file: "route", green: false,
    expect: /У ЦЕНТРІ АДМІНА/,
    what: "clinicId події — з профілю цілі (NULL для CEO: подія губиться)",
    from: "    clinicId: me.clinic_id,\n    actorId: user.id,",
    to: "    clinicId: target.clinic_id,\n    actorId: user.id,",
  },
  {
    /* Ревʼю А: гейт гранту CEO — сам шлях RF-09. */
    id: "C8", file: "route", green: false,
    expect: /CEO без гранту взагалі → 403/,
    what: "CEO авторизується без гранту (if (link) знято)",
    from: '    if (link) authorized = true;\n  } else if (target.role === "referrer") {',
    to: '    authorized = true;\n  } else if (target.role === "referrer") {',
  },
  {
    id: "C9", file: "route", green: false,
    expect: /CEO грант відкликано → 403/,
    what: "грант CEO рахується і відкликаний (status не звіряється)",
    from: '      .eq("ceo_id", targetId)\n      .eq("clinic_id", me.clinic_id as string)\n      .eq("status", "active")',
    to: '      .eq("ceo_id", targetId)\n      .eq("clinic_id", me.clinic_id as string)',
  },
  {
    id: "C10", file: "route", green: false,
    expect: /reset: 200.*ПІСЛЯ запису/,
    what: "update profiles без .eq(\"id\") — токен і password_set=false лягають УСІМ",
    from: '.update({ password_set: passwordSet, invite_token: inviteToken }).eq("id", targetId);',
    to: '.update({ password_set: passwordSet, invite_token: inviteToken });',
  },
  {
    /* Токен у details — PII/секрет у журналі, який читає CEO. */
    id: "C3", file: "route", green: false,
    expect: /без токена в details/,
    what: "свіжий токен потрапляє в details події",
    from: "details: { action: parsed.data.action === \"reset\" ? \"password_reset\" : \"password_set\", targetRole: target.role },\n  });\n\n  return NextResponse.json",
    to: "details: { action: parsed.data.action === \"reset\" ? \"password_reset\" : \"password_set\", targetRole: target.role, token: inviteToken },\n  });\n\n  return NextResponse.json",
  },
  {
    id: "C4", file: "route", green: false,
    expect: /пароль НЕ в details/,
    what: "новий пароль потрапляє в details події",
    from: "details: { action: parsed.data.action === \"reset\" ? \"password_reset\" : \"password_set\", targetRole: target.role },\n  });\n\n  return NextResponse.json",
    to: "details: { action: parsed.data.action === \"reset\" ? \"password_reset\" : \"password_set\", targetRole: target.role, pw: newPass },\n  });\n\n  return NextResponse.json",
  },
  {
    /* Дефект, який поведінковий тест зловив у першій редакції пакета: `user`
       не деструктуровано з гейта → ReferenceError на кожному запиті. */
    id: "C5", file: "route", green: false,
    expect: /reset: 200/,
    what: "user не взято з gate — роут падає ReferenceError на кожному виклику (перша редакція пакета 39)",
    from: "  const { user, me } = gate;",
    to: "  const { me } = gate;",
  },
  {
    id: "C6", file: "route", green: false,
    expect: /персонал ЧУЖОГО центру → 403/,
    what: "авторизація реєстратора/радіолога без перевірки центру",
    from: '  if ((target.role === "radiologist" || target.role === "registrar")\n      && target.clinic_id === me.clinic_id) {',
    to: '  if ((target.role === "radiologist" || target.role === "registrar")) {',
  },
  {
    id: "C7", file: "journal", green: false,
    expect: /скинув пароль керівника\/направника\/співробітника/,
    what: "журнал не розрізняє скидання пароля — показує «змінив доступ співробітника»",
    from: '      if (action === "password_reset" || action === "password_set") {',
    to: '      if (false && (action === "password_reset" || action === "password_set")) {',
  },
  {
    /* Ревʼю Б: роль цілі в заголовку — CEO знову «співробітник». */
    id: "C13", file: "journal", green: false,
    expect: /скинув пароль керівника/,
    what: "заголовок ховає роль цілі: пароль КЕРІВНИКА скинуто як «співробітника»",
    from: '        const whose = tr === "ceo" ? "керівника" : tr === "referrer" ? "направника" : "співробітника";',
    to: '        const whose = tr === "referrer" ? "направника" : "співробітника";',
  },
  /* ---------------- B (продовження): піни CLI, ревʼю А ---------------- */
  {
    /* Однорядковий ранній вихід ДО рішення — старий пін «один return у рядку»
       його не бачив. */
    id: "B5", file: "cli", green: false,
    expect: /ДО виклику gateEnvDecision немає ЖОДНОГО return/,
    what: "однорядковий `if (…) return;` перед рішенням (невидимий для піна «рівно один return»)",
    from: "  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;\n  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;\n  const decision",
    to: '  if (process.env.VERCEL_ENV === "production") return;\n  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;\n  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;\n  const decision',
  },
  {
    /* Ключі «чесним словом»: рішення завжди бачить ключі, без них — падіння
       на createClient (fail-closed випадково, не за задумом). */
    id: "B6", file: "cli", green: false,
    expect: /усі шість входів рішення/,
    what: "hasUrl/hasKey: true — ключі не з env",
    from: "    hasUrl: Boolean(url),\n    hasKey: Boolean(key),",
    to: "    hasUrl: true,\n    hasKey: true,",
  },
  /* ---------------- T: позитивні контролі ---------------- */
  {
    id: "T1", file: "lib", green: true,
    what: "локальну змінну hasKeys перейменовано",
    from: "  const hasKeys = Boolean(hasUrl && hasKey);",
    to: "  const keysOk = Boolean(hasUrl && hasKey);\n  const hasKeys = keysOk;",
  },
  {
    id: "T2", file: "route", green: true,
    what: "поля details переставлено місцями",
    from: "details: { action: parsed.data.action === \"reset\" ? \"password_reset\" : \"password_set\", targetRole: target.role },",
    to: "details: { targetRole: target.role, action: parsed.data.action === \"reset\" ? \"password_reset\" : \"password_set\" },",
  },
];

const editsOf = (m) => m.edits ?? [{ file: m.file, from: m.from, to: m.to }];

for (const m of MUTATIONS) {
  const eds = editsOf(m);
  const bad =
    (!m.green && !m.expect) ? "мутація мусить червоніти, але не називає сторожа (`expect`)"
    : (m.green && m.expect) ? "`expect` у рядку, який МУСИТЬ лишитись зеленим — сторожа тут не буває"
    : (m.expect && /\|/.test(m.expect.source)) ? "у регулярці `|` — вона зламає таблицю звіту"
    : eds.some((e) => !e.file || !FILES[e.file] || typeof e.from !== "string" || typeof e.to !== "string")
      ? "правка без файлу з FILES або без from/to"
    : null;
  if (bad) {
    console.error(`⛔ ІНВЕНТАР БРЕШЕ: ${m.id} — ${bad}. Стенд НЕ прогнано.`);
    process.exit(1);
  }
}

/* Кількість адресних мутацій — КОНСТАНТА (урок U-80г). A1–A7 — рішення
   (обидва повернуті fail-open, noDb на Vercel, мовчазний пропуск, обхід
   db:gate, порядок гілок, Vercel-з-ключами як локальна); B1–B6 — CLI і CI
   (B5 однорядковий ранній return, B6 ключі «чесним словом» — ревʼю А);
   C1–C13 — подія журналу (зникла, до запису, токен/пароль у details,
   ReferenceError, авторизація персоналу; ревʼю А: C8–C10 гейт гранту CEO і
   update без .eq, C11 auth після події, C12 clinicId цілі; ревʼю Б: C13 роль
   цілі в заголовку). */
const EXPECTED_RED = 26;
const redCount = MUTATIONS.filter((m) => !m.green).length;
if (redCount !== EXPECTED_RED) {
  console.error(`⛔ ІНВЕНТАР БРЕШЕ: адресних мутацій ${redCount}, а очікується ${EXPECTED_RED}. Стенд НЕ прогнано.`);
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
  lines.push(`# Стенд фальсифікації пакета 39 — RF-05 (гейт без fail-open) + подія на скидання пароля\n`);
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
      /* Кілька правок в ОДНОМУ файлі — послідовно, на поточному тексті (інакше
         друга правка затирає першу). Якорі перевірено на оригіналі вище. */
      const cur = {};
      for (const e of eds) {
        const base = cur[e.path] ?? e.src;
        if (base.split(e.from).length - 1 !== 1) throw new Error(`${m.id}: якір ${JSON.stringify(e.from.slice(0, 40))} не унікальний після попередньої правки`);
        cur[e.path] = base.replace(e.from, () => e.to);
      }
      for (const [p, txt] of Object.entries(cur)) writeFileSync(p, txt);
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
