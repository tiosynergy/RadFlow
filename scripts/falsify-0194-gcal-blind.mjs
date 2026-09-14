// ============================================================
//  Стенд фальсифікації 0194 — перевірка №13 бачить АВАРІЙНО ВИМКНЕНЕ
//  дзеркало GCal (друга половина I-7).
//
//  ЩО ДОВОДИТЬ. Що `tests/gcalSyncOverdue.test.ts` — сторож, а не проза.
//  Кожна мутація псує РІВНО одне місце і мусить дати ЧЕРВОНИЙ тест
//  З НАЗВАНИМ ІМЕНЕМ. Мутація, що червонить «щось», доводить лише наявність
//  тестів, а не те, що вони цілять туди, куди обіцяють.
//
//  ⚠️ ЧОМУ САМЕ ТУТ. Сліпота №13 прожила 11,5 доби і повторилась на другому
//     центрі. У проді від звуження умови назад стереже… ніщо: №13 — це код
//     ВСЕРЕДИНІ сторожа, і «спрощення» предиката не ловиться жодним із 23
//     інваріантів (пін №19 стереже ЧУЖІ функції, не себе). У дереві тримають
//     лише ці тести — тому їхня чутливість тут і міряється.
//
//  ⚠️ Стенд править БОЙОВІ файли під try/finally. `scripts/frag/0194_*.sql`
//     ГЕНЕРОВАНІ (`node scripts/build-0194-reprint.mjs`) — відновлення
//     обовʼязкове, інакше наступний прогін збирача покаже чужий diff, а
//     `db:gate` — md5-дрейф міграції.
//
//  Запуск: node scripts/falsify-0194-gcal-blind.mjs   Звіт: falsify-0194-gcal-blind.md
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf, finishStand } from "./lib/falsify-verdict.mjs";

const FILES = {
  mig: "supabase/migrations/0194_gcal_blind_disable.sql",
  apply: "scripts/frag/0194_apply.sql",
  dryrun: "scripts/frag/0194_dryrun.sql",
  rollback: "scripts/frag/0194_rollback.sql",
  smoke: "supabase/smoke/gcal_sync_overdue_smoke.sql",
  all: "scripts/falsify-all.mjs",
};
const SPECS = [
  "tests/gcalSyncOverdue.test.ts",
  "tests/invariantsCheckedPins.test.ts",
];
const OUT = "falsify-0194-gcal-blind.md";
const REPORT = ".falsify-0194-gcal-blind.json";
// P1–P8 (8), B1–B4 (4), F1–F6 (6), S1–S2 (2), A1 (1), H1 (1) = 22;
// R1 — зелений контроль, у це число НЕ входить.
// ⚠️ ПЕРША РЕДАКЦІЯ ПИСАЛА 21 — я склав той самий перелік і помилився на
//    одиницю. І помилка ЖИЛА, бо B3 мала протухлий якір: 21 адресна з 22 якраз
//    сходилась із оголошеним 21, тобто дві помилки маскували одна одну рівно
//    доти, доки не полагодили якір. Число тепер звіряється (див. shortfall
//    нижче) — без цього звірення обидві так і лишились би непоміченими.
const EXPECTED_RED = 22;
/* ⚠️ ЗЕЛЕНОГО КОНТРОЛЮ ВСЕРЕДИНІ ТІЛА СТОРОЖА НЕМА, і це by design: будь-яка
   правка тіла міняє md5, а тест «накат чекає рівно те тіло, що в дереві»
   виводить md5 З ФАЙЛА — тобто кожна тілесна мутація червонить щонайменше два
   тести. R1 править шапку ПОЗА тілом. Отже адресність тут тримається на
   вимозі «НАЗВАНИЙ тест серед червоних», а не на «червоний рівно один».
   Це знахідка ревʼю, і вона записана, а не замовчана. */

// ── ЯКОРІ. Форма — дзеркало збирача (`SQL_TO` у build-0194-reprint.mjs).
// ⚠️ Пробіл після коми в списку статусів ОБОВʼЯЗКОВИЙ саме тут: проза пакета
//    (MIG_BOUNDS, крок 1) цитує ту саму умову в один рядок і БЕЗ пробілу —
//    тобто якір із пробілом унікальний, а без пробілу спіймав би цитату.
const BR2 = "          or (not g.enabled\n"
  + "              and g.status in ('reauth_required', 'access_lost'))\n";
const STATUSES = "and g.status in ('reauth_required', 'access_lost'))";
const AGE = "                  < now() - interval '30 minutes')\n";
const MARK = "             case when g.enabled then 'стоїть:'\n"
  + "                  else 'відвалилось(' || g.status || '):' end ||\n";
const PREFIX = "      select left(g.clinic_id::text, 8) || ':' ||\n";

// ⚠️ Рядок піна №19 БЕРЕТЬСЯ З ФАЙЛА, а не переписується сюди: у ньому md5,
//    якого я не маю права вгадувати. Якщо розбір не знайде рядка — стенд
//    скаже про це вголос, а не тихо пропустить мутацію.
const MIGTXT = readFileSync(FILES.mig, "utf8");
const PIN_LINE = (MIGTXT.match(/^ *\('waitlist_counts\([^\n]*\n/m) || [])[0];
if (!PIN_LINE) {
  console.error("⛔ у міграції не знайдено рядка піна №19 для waitlist_counts — мутація P8 неможлива");
  process.exit(2);
}

// ⚠️ Рядок HOWTO з очікуваними md5/довжиною — З ФАЙЛА, і його УНІКАЛЬНІСТЬ
//    міряється тут-таки: мутація H1 доводить «проза протухла» лише якщо число
//    в файлі одне. Друге входження зробило б мутацію застосованою, а тест —
//    зеленим, тобто стенд рапортував би про сторожа, якого немає.
const HOWTO_LINE = (MIGTXT.match(/-- очікування: [0-9a-f]{32} \/ \d+/) || [])[0];
const NEW_LEN_STR = HOWTO_LINE ? (HOWTO_LINE.match(/\/ (\d+)$/) || [])[1] : null;
if (!HOWTO_LINE || !NEW_LEN_STR) {
  console.error("⛔ у міграції не знайдено рядка «-- очікування: <md5> / <len>» — мутація H1 неможлива");
  process.exit(2);
}
if (MIGTXT.split(NEW_LEN_STR).length - 1 !== 1) {
  console.error(`⛔ довжина ${NEW_LEN_STR} трапляється у файлі міграції ${MIGTXT.split(NEW_LEN_STR).length - 1} раз(ів), а не один — мутація H1 нічого не довела б`);
  process.exit(2);
}

const MUTATIONS = [
  {
    id: "P1", file: "mig", green: false,
    what: "другу гілку прибрано зовсім (повернення до сліпоти 0193)",
    expect: /умова ловить рівно два аварійні статуси/,
    from: BR2, to: "",
  },
  {
    id: "P2", file: "mig", green: false,
    what: "зі списку статусів прибрано access_lost",
    expect: /умова ловить рівно два аварійні статуси/,
    from: STATUSES, to: "and g.status in ('reauth_required'))",
  },
  {
    id: "P3", file: "mig", green: false,
    what: "у список статусів додано not_connected (гілка (b) шумить)",
    /* ⚠️ Найправдоподібніша «поліпшувальна» правка наступного читача: «а
       давайте ловити й відключені». Саме вона зробила б перевірку постійно
       червоною на свідомо відключеному центрі — і сторожа знову перестали б
       читати. */
    expect: /умова ловить рівно два аварійні статуси/,
    from: STATUSES, to: "and g.status in ('reauth_required', 'access_lost', 'not_connected'))",
  },
  {
    id: "P4", file: "mig", green: false,
    what: "другу гілку закоментовано (лишилась як проза)",
    /* ⚠️ Найтихіша правка: grep знаходить умову, SQL її не виконує. Рівно на
       цьому тримається правило «детектор ріже коментарі ПЕРШОЮ дією». */
    expect: /умова ловить рівно два аварійні статуси/,
    from: BR2,
    to: "       -- or (not g.enabled\n"
      + "       --     and g.status in ('reauth_required', 'access_lost'))\n",
  },
  {
    id: "P5", file: "mig", green: false,
    what: "поріг першої гілки зсунуто з 30 хвилин на 5",
    /* Пакет РОЗШИРЮЄ №13. Якщо перша гілка попутно «поліпшиться», шапка
       («перша гілка БЕЗ ЗМІН») стане неправдою. */
    expect: /перша гілка лишилась недоторканою/,
    from: AGE, to: "                  < now() - interval '5 minutes')\n",
  },
  {
    id: "P6", file: "mig", green: false,
    what: "мітку гілки перенесено ПЕРЕД префікс clinic_id",
    /* ⚠️ Мовчазна поломка смоука `gcal_pg_cron_smoke.sql` (f/f2): він шукає
       порушників як `o like left(clinic_id::text, 8) || ':%'`, і після такої
       правки не знайшов би нікого — сказавши «чисто». */
    expect: /мітка гілки стоїть ПІСЛЯ префікса clinic_id/,
    from: PREFIX + MARK,
    to: "      select case when g.enabled then 'стоїть:'\n"
      + "                  else 'відвалилось(' || g.status || '):' end ||\n"
      + "             left(g.clinic_id::text, 8) || ':' ||\n",
  },
  {
    id: "P7", file: "mig", green: false,
    what: "текст мітки змінено (`відвалилось(` → `впало(`)",
    /* Мітка — контракт із смоуком f3 і з очима оператора: саме по ній він
       відрізняє «стоїть» від «відвалилось». */
    expect: /мітка гілки стоїть ПІСЛЯ префікса clinic_id/,
    from: "                  else 'відвалилось(' || g.status || '):' end ||\n",
    to: "                  else 'впало(' || g.status || '):' end ||\n",
  },
  {
    id: "P8", file: "mig", green: false,
    what: "з списку №19 прибрано один пін (waitlist_counts)",
    expect: /у списку №19 рівно 40 підписів/,
    from: PIN_LINE, to: "",
  },
];

// ⚠️ БЛОК ВІДНОВЛЕННЯ ДАНИХ у dryrun бере́ться З ФАЙЛА, а не переписується
//    сюди: він трапляється ДВІЧІ і побайтово однаковий, тож якір робиться
//    унікальним СУСІДНІМ текстом, а не переписуванням дванадцяти рядків
//    руками (перша спроба саме так і збиралась — і це був би ще один шанс
//    внести розбіжність між стендом і бойовим файлом).
const DRYTXT = readFileSync(FILES.dryrun, "utf8");
/* ⚠️ Якір бере́ться по рядку `set enabled = b.enabled`, а НЕ по голові
   `update public.google_calendar_connections g`: голова в стимулу й у
   відновлення ОДНАКОВА, тож перша редакція регулярки зачепилась за стимул і
   нежадібно дотяглась до `end if;` ВІДНОВЛЕННЯ — тобто матч накрив обидва
   блоки разом із асертом між ними і став унікальним. Стенд це й сказав
   («не знайдено ДВА однакові блоки»), замість тихо пропустити мутацію. */
const RESTORE = (DRYTXT.match(/ {6}update public\.google_calendar_connections g\n {9}set enabled = b\.enabled[\s\S]*?\n {6}end if;\n/) || [])[0];
const AFTER_RESTORE1 = "  end;\n  -- <<< DRYRUN-ONLY\n\n  -- 6. ПІДСТАНОВКИ";
if (!RESTORE || DRYTXT.split(RESTORE).length - 1 !== 2) {
  console.error("⛔ у dryrun не знайдено ДВА однакові блоки відновлення — мутація F4 неможлива");
  process.exit(2);
}

MUTATIONS.push(
  {
    id: "B1", file: "mig", green: false,
    what: "з прози №13 прибрано імʼя CHECK-а (причина сліпоти)",
    /* Без імені наступний читач знову вирішить, що то був недогляд предиката,
       і «спростить» умову назад — рівно те, від чого пакет і страхує. */
    expect: /причина сліпоти названа в прозі саме як інваріант схеми/,
    from: "  --          gcal_enabled_invariant_chk CHECK (((NOT enabled) OR ((status =\n",
    to: "  --          (той самий CHECK, деталі в шапці міграції)\n",
  },
  {
    id: "B2", file: "mig", green: false,
    what: "дослівну цитату CHECK-а замінено переказом",
    /* ⚠️ Це ТА САМА правка, яку я зробив у першій редакції пакета і яку
       довелось знімати: формула рівносильна, але слово «ЗАМІРЯНО» над
       переказом — неправда рівно там, куди читач прийде за зразком. */
    expect: /причина сліпоти названа в прозі саме як інваріант схеми/,
    from: "  --            AND (access_role = ANY (ARRAY['writer'::text, 'owner'::text])))))\n",
    to: "  --            AND access_role IN ('writer','owner')\n",
  },
  {
    id: "B3", file: "mig", green: false,
    what: "додано 24-й інкремент v_n (нова перевірка замість розширення №13)",
    /* ⚠️ Якір — ОСТАННІЙ рядок прози №13 плюс інкремент одразу за ним. Він
       переїхав, коли ревʼю переписало межі М-1/М-4, і стенд це показав
       («ЯКІР НЕ УНІКАЛЬНИЙ (0)») замість того, щоб тихо не застосуватись. */
    expect: /checked лишається 23/,
    from: "  --        при кожному передруку.\n  v_n := v_n + 1;",
    to: "  --        при кожному передруку.\n  v_n := v_n + 1;\n  v_n := v_n + 1;",
  },
  {
    id: "F1", file: "apply", green: false,
    what: "накат звіряє предстан із ЧУЖИМ md5",
    expect: /предстан у накаті — заміряний 0193, а не чуже число/,
    from: "if md5(v_src) is distinct from '0a036d5f097fba3a11ca39c0c9885d93' then",
    to: "if md5(v_src) is distinct from '00000000000000000000000000000000' then",
  },
  {
    id: "F2", file: "rollback", green: false,
    what: "відкат не знімає рядка леджера",
    /* Найнебезпечніший різновид «відкату»: тіло повернулось, запис лишився —
       і гейт червоний В ОБИДВА БОКИ при, здавалося б, успішному відкаті. */
    expect: /відкат — дзеркало накату по САМИХ ПАРАХ/,
    from: "  delete from public.migration_ledger where name = '0194_gcal_blind_disable.sql';\n",
    to: "",
  },
  {
    id: "F3", file: "rollback", green: false,
    what: "у зворотних парах змінено текст, який вони шукають",
    /* Пари відкату мусять БУТИ парами накату навпаки. Одна зміна тексту — і
       відкат тихо не знайде якоря вже в проді, посеред транзакції. */
    expect: /відкат — дзеркало накату по САМИХ ПАРАХ/,
    from: "             case when g.enabled then 'стоїть:'\n",
    to: "             case when g.enabled then 'працює:'\n",
  },
  {
    id: "F4", file: "dryrun", green: false,
    what: "у зонді прибрано ПЕРШЕ відновлення даних",
    expect: /у dryrun кожен стимул має відновлення/,
    from: RESTORE + AFTER_RESTORE1, to: AFTER_RESTORE1,
  },
  {
    id: "F5", file: "dryrun", green: false,
    what: "зелений базис зонда обеззброєно (асерт завжди хибний)",
    /* Без зеленого базису «почервоніло після накату» не відрізнити від
       «червоніло й до нього» — тобто зонд перестає бути фальсифікацією. */
    expect: /dryrun несе ОБА базиси/,
    from: "    if v_off is not null then\n      raise exception '0194-зонд: ЗЕЛЕНИЙ БАЗИС",
    to: "    if false then\n      raise exception '0194-зонд: ЗЕЛЕНИЙ БАЗИС",
  },
  {
    id: "S1", file: "smoke", green: false,
    what: "у смоуку вихолощено АСЕРТ секції f4 (негативний контроль)",
    /* ⚠️ Перша редакція мутації різала ЗАГОЛОВОК секції — і це доводило лише
       те, що тест бачить коментар. Ревʼю показало: код секції при цьому
       лишався, а весь смоук можна було випотрошити, лишивши заголовки, і тест
       не помітив би. Тепер ріжеться сам асерт. */
    expect: /обіцяні секції смоука існують і мають ЖИВІ асерти/,
    from: "    raise exception 'SMOKE_FAIL f4: `ready` зі знятою галочкою став порушником — гілка (b) шумить: %', v_off;\n",
    to: "    null;\n",
  },
  {
    id: "A1", file: "all", green: false,
    what: "EXPECTED_STANDS розійшовся з числом у HOWTO",
    expect: /HOWTO обіцяє 40 стендів/,
    from: "const EXPECTED_STANDS = 40;", to: "const EXPECTED_STANDS = 41;",
  },
  {
    id: "H1", file: "mig", green: false,
    what: "у HOWTO протухла довжина нового тіла",
    /* ⚠️ Рядок і число БЕРУТЬСЯ З ФАЙЛА (див. HOWTO_LINE вище), а не
       переписуються сюди: перша редакція захардкодила «123887» і спиралась на
       коментар «трапляється рівно один раз» — при тому, що унікальність
       перевірялась лише у ЯКОРЯ, а не у самого числа. Ревʼю назвало це
       вгадуванням; тепер унікальність міряється на старті. */
    expect: /називає ті самі md5 і довжину/,
    from: HOWTO_LINE, to: HOWTO_LINE.replace(NEW_LEN_STR, "120547"),
  },
  {
    id: "B4", file: "mig", green: false,
    what: "з прози прибрано ПОПЕРЕДЖЕННЯ про необоротність «Відключити»",
    /* ⚠️ Це найдорожча знахідка ревʼю: перша редакція прози В ТІЛІ СТОРОЖА
       називала єдиним виходом дію, що відкликає токен у Google і видаляє
       секрет із Vault. Мутація стереже, щоб попередження не зникло знову. */
    expect: /проза називає ОБИДВА виходи з червоного/,
    from: "  --             це НЕОБОРОТНО — `revokeToken` відкликає токен у Google і\n",
    to: "  --             це штатний шлях — `revokeToken` прибирає доступ і\n",
  },
  {
    id: "F6", file: "dryrun", green: false,
    what: "зелений базис обеззброєно ТИХО (`and false` при живому літералі)",
    /* ⚠️ Знахідка ревʼю: F5 ловила ЛІТЕРАЛ `if v_off is not null then`, тож
       дописане ` and false` лишило б тест зеленим. Тобто вимірювалась
       чутливість до однієї конкретної опечатки, а не властивість «базис
       озброєний». */
    expect: /dryrun несе ОБА базиси/,
    from: "    if v_off is not null then\n      raise exception '0194-зонд: ЗЕЛЕНИЙ БАЗИС",
    to: "    if v_off is not null and false then\n      raise exception '0194-зонд: ЗЕЛЕНИЙ БАЗИС",
  },
  {
    id: "S2", file: "smoke", green: false,
    what: "зі смоука вирізано АСЕРТ секції f6 (перша гілка)",
    /* Секцію f6 додало ревʼю: поведінково ПЕРШУ гілку не перевіряв ніхто.
       Мутація стереже, щоб її не вихолостили до заголовка. */
    expect: /обіцяні секції смоука існують і мають ЖИВІ асерти/,
    from: "    raise exception 'SMOKE_FAIL f6: перша гілка НЕ ловить увімкнене дзеркало зі старим синком (або мітка не та): %', v_off;\n",
    to: "    null;\n",
  },
  {
    id: "R1", file: "mig", green: true,
    what: "РЕФАКТОРНИЙ КОНТРОЛЬ: уточнено слово в шапці, що нічим не пінеться",
    /* ⚠️ Без зеленої мутації стенд не відрізняє «тести цілять точно» від
       «тести червоніють на будь-якій правці файла». */
    expect: /./,
    from: "--  Максимальний ЗАСТОСОВАНИЙ на момент написання — 0193.",
    to: "--  Максимальний ЗАСТОСОВАНИЙ на момент написання — 0193 (перевірено).",
  },
);

// ---------------------------------------------------------------------------
const ORIG = Object.fromEntries(Object.entries(FILES).map(([k, p]) => [p, readFileSync(p, "utf8")]));
function restore() { for (const [p, txt] of Object.entries(ORIG)) writeFileSync(p, txt); }
function editsOf(m) {
  const eds = [{ file: m.file, from: m.from, to: m.to }];
  if (m.extra) eds.push(m.extra);
  return eds;
}
process.on("SIGINT", () => { restore(); process.exit(130); });
process.on("SIGTERM", () => { restore(); process.exit(143); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(2); });

function run() {
  if (existsSync(REPORT)) unlinkSync(REPORT);
  spawnSync("npx", ["vitest", "run", ...SPECS, "--reporter=json", `--outputFile.json=${REPORT}`],
    { shell: true, stdio: "ignore" });
  if (!existsSync(REPORT)) return { crashed: true, ok: false, red: [], all: [] };
  let r;
  try { r = JSON.parse(readFileSync(REPORT, "utf8")); }
  catch { return { crashed: true, ok: false, red: [], all: [] }; }
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
  lines.push(`# Стенд фальсифікації 0194 — №13 бачить аварійно вимкнене дзеркало GCal\n`);
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
      restore();
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
  /* ⚠️ EXPECTED_RED ТЕПЕР СУДИТЬ, А НЕ ПРИКРАШАЄ ЗВІТ (знахідка ревʼю).
     Доти це число лише друкувалось: `verdictOf` дивиться на рядки таблиці, а
     `addressedOk` ні на що не впливав — тобто переведення будь-якої мутації в
     `green: true` давало «20/21 адресних» і ЗЕЛЕНИЙ стенд. Найтихіший спосіб
     погасити сторожа — зробити його вимогу необовʼязковою. */
  const shortfall = addressedOk !== EXPECTED_RED;
  if (shortfall) {
    lines.push(`\n⛔ **АДРЕСНИХ МУТАЦІЙ ${addressedOk}, А ОГОЛОШЕНО ${EXPECTED_RED}.** Стенд доводить менше, ніж обіцяє: або мутацію перевели в зелену, або сторож не спрацював названим імʼям.`);
  }
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nЗвіт: ${OUT}. Файли відновлено.`);
  finishStand({
    ok: Boolean(verdict.ok) && !shortfall,
    red: "\n⛔ ВЕРДИКТ: СТЕНД ЧЕРВОНИЙ — причина в таблиці вище.",
  });
}
