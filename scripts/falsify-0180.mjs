// ============================================================
//  Стенд фальсифікації пакета 40 (с59): перевірка №22 grant_digest (RF-04).
//
//  Головне питання стенда: чи ловлять сторожі САМЕ ті обходи, якими жила
//  перша редакція №22 і які знайшли два ревʼю — захардкожені ролі, зниклий
//  `is_grantable`, гілка f: без власника й повного md5, знешкоджене
//  порівняння дайджестів, підмінений маркер fail-loud.
//
//  ⚠️ Правлю БОЙОВИЙ файл міграції → try/finally + обробники сигналів.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ.
//  ⚠️ Базова лінія мусить бути ЗЕЛЕНОЮ.
//  ⚠️ Міграція вже накатана і заштампована `db:gate`: стенд ОБОВʼЯЗКОВО
//     відновлює файл, інакше наступний `db:gate:check` побачить md5-дрейф.
//
//  Запуск: node scripts/falsify-0180.mjs   Звіт: falsify-0180.md (gitignore)
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf, finishStand } from "./lib/falsify-verdict.mjs";

const FILES = { mig: "supabase/migrations/0180_grant_digest.sql" };
const SPECS = [
  "tests/grantDigestInvariant.test.ts",
  "tests/invariantsCheckedPins.test.ts",
  "tests/invariantsFailLoud.test.ts",
  "tests/guardFnBodiesInvariant.test.ts",
];
const OUT = "falsify-0180.md";
const REPORT = ".falsify-0180.json";

const MUTATIONS = [
  {
    /* САМ ОБХІД, знайдений ревʼю А: роль-портал, видана через
       `grant portal to anon`, стає невидимою сторожу. */
    id: "A1", file: "mig", green: false,
    expect: /ролі НЕ хардкодом/,
    what: "ролі знову захардкожені парою anon/authenticated",
    from: "     where a.rolname = 'authenticator' and g.rolname <> 'service_role'\n    union all\n    select 'PUBLIC'",
    to: "     where a.rolname in ('anon', 'authenticated')\n    union all\n    select 'PUBLIC'",
  },
  {
    id: "A2", file: "mig", green: false,
    expect: /WITH GRANT OPTION/,
    what: "grant option зник із табличного дайджесту (`grant … with grant option` невидимий)",
    from: "           string_agg(t.priv || case when t.grantable then '*' else '' end,\n                      ',' order by t.priv, t.grantable) as dig",
    to: "           string_agg(t.priv, ',' order by t.priv, t.grantable) as dig",
  },
  {
    id: "A3", file: "mig", green: false,
    expect: /WITH GRANT OPTION/,
    what: "grant option зник із колонкового дайджесту",
    from: "           count(*)::text || ':' || substr(md5(string_agg(cc.col\n             || case when cc.grantable then '*' else '' end, ',' order by cc.col)), 1, 12)",
    to: "           count(*)::text || ':' || substr(md5(string_agg(cc.col, ',' order by cc.col)), 1, 12)",
  },
  {
    id: "A4", file: "mig", green: false,
    expect: /гілка f: пінить ВЛАСНИКА/,
    what: "гілка f: більше не пінить власника (alter function … owner to невидимий)",
    from: "           || '|' || pg_get_userbyid(p.proowner)\n           || '|' || md5(replace(p.prosrc, chr(13), ''))",
    to: "           || '|' || md5(replace(p.prosrc, chr(13), ''))",
  },
  {
    id: "A5", file: "mig", green: false,
    expect: /гілка f: пінить ВЛАСНИКА/,
    what: "md5 тіла anon-функції усічено до 48 біт (урок с56 забуто)",
    from: "           || '|' || md5(replace(p.prosrc, chr(13), ''))\n      from pg_proc p",
    to: "           || '|' || substr(md5(replace(p.prosrc, chr(13), '')), 1, 12)\n      from pg_proc p",
  },
  {
    id: "A6", file: "mig", green: false,
    expect: /changed: каже очікуване/,
    what: "changed: більше не каже ОЧІКУВАНЕ — offender о 03:50 не читається без другого запиту",
    from: "    select 'changed:' || c.key || ':' || e.dig || '->' || c.dig as what",
    to: "    select 'changed:' || c.key || '->' || c.dig as what",
  },
  {
    id: "A7", file: "mig", green: false,
    expect: /порівняння дайджестів не знешкоджене константою/,
    what: "порівняння дайджестів знешкоджене константою (перевірка тримається лише на лічильнику)",
    from: "      from cur c join expd e on e.key = c.key\n     where e.dig <> c.dig",
    to: "      from cur c join expd e on e.key = c.key\n     where e.dig <> c.dig and false",
  },
  {
    id: "A8", file: "mig", green: false,
    expect: /чотири гілки на місці/,
    what: "секвенції випали з набору (relkind без 'S')",
    from: "     where c.relkind in ('r','p','v','m','f','S')",
    to: "     where c.relkind in ('r','p','v','m','f')",
  },
  {
    id: "A9", file: "mig", green: false,
    expect: /джерело — КАТАЛОГ/,
    what: "джерелом знову стала information_schema (яка не показує MAINTAIN)",
    from: "      cross join lateral aclexplode(att.attacl) a\n      left join pg_roles r on r.oid = a.grantee",
    to: "      cross join lateral (select g2.privilege_type::text as privilege_type, false as is_grantable\n                            from information_schema.column_privileges g2 limit 1) a\n      left join pg_roles r on r.oid = att.attrelid",
  },
  {
    id: "A10", file: "mig", green: false,
    expect: /рівно 69 ключів/,
    what: "один ключ тихо зник зі списку очікуваного",
    from: "      ('s:maintenance_runs_id_seq:anon','SELECT,UPDATE,USAGE'),\n",
    to: "",
  },
  {
    id: "A11", file: "mig", green: false,
    expect: /рівно 69 ключів/,
    what: "ключ у списку продубльовано (69 рядків, 68 різних)",
    from: "      ('t:audit_log:anon','REFERENCES,SELECT,TRIGGER'),\n      ('t:audit_log:authenticated','REFERENCES,SELECT,TRIGGER'),",
    to: "      ('t:audit_log:anon','REFERENCES,SELECT,TRIGGER'),\n      ('t:audit_log:anon','REFERENCES,SELECT,TRIGGER'),",
  },
  {
    id: "A12", file: "mig", green: false,
    expect: /рівно ті 11 функцій/,
    what: "у списку f: усічений дайджест тіла (пін приймає 48 біт)",
    from: "      ('f:auth_ceo_clinics()','PUBLIC|postgres|05c87b00121560f1f6fd77a9b37c9c8a'),",
    to: "      ('f:auth_ceo_clinics()','PUBLIC|postgres|05c87b001215'),",
  },
  {
    /* Дефект, який ревʼю Б спіймало ДО накату: власний маркер ламає
       tests/invariantsFailLoud.test.ts, і один із його асертів проходить
       ВИПАДКОВО — тобто структура зламана, а сторож частково зелений. */
    id: "A13", file: "mig", green: false,
    expect: /кожна перевірка, крім уже обгорнутої 0172, має свою обгортку/,
    what: "маркер fail-loud підмінено на власний /* 0180 */ (перша редакція пакета 40)",
    from: "  v_n := v_n + 1;\n  /* 0174 */ begin\n  v_tmp := null;\n  with roles as (",
    to: "  v_n := v_n + 1;\n  /* 0180 */ begin\n  v_tmp := null;\n  with roles as (",
  },
  {
    id: "A14", file: "mig", green: false,
    expect: /перевірка загорнута у власний fail-loud/,
    what: "перевірка без обробника винятків — виняток у ній валить УВЕСЬ сторож мовчки",
    from: "  /* 0174 */ exception when others then\n  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(\n  /* 0174 */     'check', 'grant_digest', 'offenders',\n  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));\n  /* 0174 */ end;",
    to: "  end;",
  },
  {
    id: "A15", file: "mig", green: false,
    expect: /кожен пін у смоуках дорівнює цьому числу/,
    what: "крок лічильника зник — checked лишається 21 при 22 перевірках",
    from: "  v_n := v_n + 1;\n  /* 0174 */ begin\n  v_tmp := null;\n  with roles as (",
    to: "  /* 0174 */ begin\n  v_tmp := null;\n  with roles as (",
  },
  /* ---------------- T: позитивні контролі ---------------- */
  {
    id: "T1", file: "mig", green: true,
    what: "порядок двох рядків у списку очікуваного переставлено",
    from: "      ('s:event_outbox_id_seq:anon','SELECT,UPDATE,USAGE'),\n      ('s:event_outbox_id_seq:authenticated','SELECT,UPDATE,USAGE'),",
    to: "      ('s:event_outbox_id_seq:authenticated','SELECT,UPDATE,USAGE'),\n      ('s:event_outbox_id_seq:anon','SELECT,UPDATE,USAGE'),",
  },
  {
    id: "T2", file: "mig", green: true,
    what: "коментар усередині блоку переписано",
    from: "  --     Чотири гілки, один список offenders, ключ несе тип:",
    to: "  --     Чотири гілки (t/s/c/f), один список offenders, ключ несе тип:",
  },
];

const editsOf = (m) => m.edits ?? [{ file: m.file, from: m.from, to: m.to }];

for (const m of MUTATIONS) {
  const eds = editsOf(m);
  const bad =
    (!m.green && !m.expect) ? "мутація мусить червоніти, але не називає сторожа (`expect`)"
    : (m.green && m.expect) ? "`expect` у рядку, який МУСИТЬ лишитись зеленим — сторожа тут не буває"
    : (m.expect && /\|/.test(m.expect.source)) ? "у регулярці `|` — вона зламає таблицю звіту"
    : null;
  if (bad) {
    console.error(`⛔ ІНВЕНТАР БРЕШЕ: ${m.id} — ${bad}. Стенд НЕ прогнано.`);
    process.exit(1);
  }
  for (const e of eds) {
    if (!e.file || !FILES[e.file] || typeof e.from !== "string" || typeof e.to !== "string") {
      console.error(`⛔ ІНВЕНТАР БРЕШЕ: ${m.id} — правка без файлу з FILES або без from/to.`);
      process.exit(1);
    }
  }
}

/* Кількість адресних мутацій — КОНСТАНТА (урок U-80г). A1 ролі, A2/A3 grant
   option, A4/A5 гілка f:, A6 читабельність offender-а, A7 знешкоджене
   порівняння, A8 секвенції, A9 information_schema, A10/A11/A12 список
   очікуваного, A13 маркер fail-loud, A14 обробник, A15 лічильник. */
const EXPECTED_RED = 15;
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
  lines.push(`# Стенд фальсифікації пакета 40 — №22 grant_digest (RF-04)\n`);
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
      const cur = {};
      for (const e of eds) {
        const base2 = cur[e.path] ?? e.src;
        cur[e.path] = base2.replace(e.from, () => e.to);
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
