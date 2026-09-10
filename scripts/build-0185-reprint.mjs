// ============================================================
//  Генератор передруку `invariants_check` для 0185 (№23 schema_digest).
//
//  ⚠️ ЧОМУ ГЕНЕРАТОР, А НЕ РУКИ. Тіло сторожа ~97 КБ. Переписане руками, воно
//     означало б «я не зачепив зайвого, чесне слово». Тут навпаки: блок
//     береться з файла 0184 ДОСЛІВНО, робиться ОДНА заякорена вставка, і вона
//     мусить збігтися РІВНО ОДИН раз — інакше скрипт падає.
//
//  ⚠️ ЗЕЛЕНИЙ БАЗИС ІНСТРУМЕНТА вбудований: скрипт друкує md5 і довжину
//     СТАРОГО тіла (без CR). Вони мусять збігтися з тим, що віддає прод
//     (`11a297318da068f53b113c3d9120e6b8`, 97025). Не збіглись — читач блока
//     або якорі зламані, і НОВОМУ числу вірити не можна теж.
//
//  ⚠️ ТІЛО ГІЛКИ ЖИВЕ В ОКРЕМОМУ ФАЙЛІ `_frag_0185_check23.sql`. Так його
//     можна ревʼювити самостійно, і так він не тоне у 2,5 тисячах рядків.
//
//  ⚠️ ЧИСЛА ПОСТ-АСЕРТУ ВПИСУЄ ЦЕЙ САМИЙ СКРИПТ. У 0184 вони писались рукою —
//     і один правлений коментар усередині функції зробив константу протухлою
//     МОВЧКИ. Заміна ідемпотентна: її можна ганяти скільки завгодно разів.
//
//  Запуск: node scripts/build-0185-reprint.mjs
// ============================================================
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const SRC = "supabase/migrations/0184_rf03b_sched_marker_fanout.sql";
const DST = "supabase/migrations/0185_schema_digest.sql";
/* ⚠️ ФРАГМЕНТ ЖИВЕ ПОЗА `supabase/migrations/`, І ЦЕ НЕ СМАК. Гейт міграцій
   (`readDiskMigrations`) кладе БУДЬ-ЯКИЙ *.sql у тій теці, чиє імʼя не
   `NNNN_*.sql`, у `badNames` — а `planGate` робить із цього failure і
   `process.exit(1)`. Перша редакція клала фрагмент саме туди: тест
   `tests/migrationGate.test.ts` («кривих імен нуль») почервонів одразу, а на
   Vercel `gateEnvDecision` дав би `run` → прод-збірка не зібралась би. Тобто
   пакет зупинив би той самий fail-closed гейт, який проєкт побудував у 39-му
   пакеті, закриваючи RF-05. Тримати фрагмент тут. */
const FRAG = "scripts/frag/0185_check23.sql";
const MARK = "-- <<<INVARIANTS_REPRINT>>>";
const ENDM = "-- <<<END INVARIANTS_REPRINT>>>";

const OLD_MD5 = "11a297318da068f53b113c3d9120e6b8";
const OLD_LEN = 97025;

const die = (m) => { console.error("⛔ " + m); process.exit(1); };
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const noCR = (s) => s.replace(/\r/g, "");

const src = readFileSync(SRC, "utf8");
const eol = src.includes("\r\n") ? "\r\n" : "\n";

/* 1. Витягуємо блок передруку з 0184 — від заголовка до `$function$;` включно. */
const head = src.search(/^create or replace function public\.invariants_check/m);
if (head < 0) die(`у ${SRC} немає передруку invariants_check`);
const tail = src.indexOf("$function$;", head);
if (tail < 0) die("не знайдено кінець тіла ($function$;)");
const block = src.slice(head, tail + "$function$;".length);

/* Тіло — між `as $function$` і фінальним `$function$;`: рівно те, що Postgres
   збереже в prosrc. Саме на ньому рахуються піни. */
const bodyOf = (b) => {
  const o = b.indexOf("as $function$");
  if (o < 0) die("у блоці немає `as $function$`");
  return b.slice(o + "as $function$".length, b.lastIndexOf("$function$;"));
};

const oldBody = bodyOf(block);
const ob = noCR(oldBody);
console.log("СТАРЕ тіло (базис інструмента):");
console.log("  довжина без CR:", ob.length, " md5 без CR:", md5(ob));
console.log("  очікується:     ", OLD_LEN, "               ", OLD_MD5);
if (ob.length !== OLD_LEN || md5(ob) !== OLD_MD5) {
  die("БАЗИС ЧЕРВОНИЙ — читач блока або якорі зламані; новому числу вірити не можна");
}

/* 2. Одна заякорена вставка: гілка №23 йде ОДРАЗУ ПІСЛЯ №22 і ПЕРЕД збіркою
      результату. Якір — хвіст обробника винятків №22 разом із його `end;`. */
const ANCHOR = [
  "  /* 0174 */     'check', 'grant_digest', 'offenders',",
  "  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));",
  "  /* 0174 */ end;",
].join(eol);

let frag = readFileSync(FRAG, "utf8");
frag = frag.replace(/\r?\n$/, "");                 // без хвостового перекладу
if (eol === "\r\n") frag = frag.replace(/\r?\n/g, "\r\n");
else frag = frag.replace(/\r\n/g, "\n");

/* Фрагмент мусить бути схожий на гілку, а не на будь-який текст: три дешеві
   перевірки, кожна ловить свій клас помилки склейки. */
if (!frag.includes("v_n := v_n + 1;")) die("у фрагменті немає інкремента v_n — checked не зросте");
if (!frag.includes("'check', 'schema_digest'")) die("у фрагменті немає імені перевірки schema_digest");
if ((frag.match(/'check', 'schema_digest'/g) || []).length !== 2)
  die("імʼя schema_digest мусить бути РІВНО двічі: у гілці і в обробнику винятку");

const n = block.split(ANCHOR).length - 1;
if (n !== 1) die(`якір №22 збігся ${n} раз(ів), а мусить рівно 1`);
const out = block.replace(ANCHOR, ANCHOR + eol + eol + frag);
console.log("  вставлено гілку №23 після №22");

const newBody = bodyOf(out);
const nb = noCR(newBody);
const NEW_MD5 = md5(nb);
const NEW_LEN = nb.length;
console.log("НОВЕ тіло:");
console.log("  довжина без CR:", NEW_LEN, " md5 без CR:", NEW_MD5);
console.log("  приріст:", NEW_LEN - ob.length, "байтів");

/* Дешевий контроль, що вставили саме ОДНУ гілку: `v_n := v_n + 1;` мусить
   стати рівно на один більше, ніж було. */
const cnt = (s) => (s.match(/v_n := v_n \+ 1;/g) || []).length;
if (cnt(nb) !== cnt(ob) + 1)
  die(`інкрементів v_n було ${cnt(ob)}, стало ${cnt(nb)} — мусило стати ${cnt(ob) + 1}`);
console.log(`  інкрементів v_n: ${cnt(ob)} → ${cnt(nb)} (checked стане ${cnt(nb)})`);

/* 3. Вставляємо блок у 0185 між сентинелами (скрипт можна ганяти повторно). */
let dst = readFileSync(DST, "utf8");
if (!dst.includes(MARK)) die(`у ${DST} немає мітки ${MARK}`);
const a = dst.indexOf(MARK);
const b = dst.indexOf(ENDM);
if (b < 0) die(`у ${DST} немає мітки ${ENDM}`);
dst = dst.slice(0, a) + MARK + eol + out + eol + ENDM + dst.slice(b + ENDM.length);

/* 4. Числа пост-асерту — теж машиною. Обидві заміни мусять збігтись рівно раз. */
const subOnce = (text, re, repl, name) => {
  const m = text.match(re);
  if (!m || m.length !== 1) die(`заміна «${name}» збіглась ${m ? m.length : 0} раз(ів), а мусить 1`);
  return text.replace(re, repl);
};
/* ⚠️ ГРУПА ОБОВʼЯЗКОВА. Перша редакція мала `'[0-9a-f]{32}|@@GUARD_MD5@@'`
   БЕЗ дужок — а `|` має найнижчий пріоритет і різав УВЕСЬ патерн навпіл.
   Друга гілка збігалась із хвостом `@@GUARD_MD5@@';`, підстановка давала
   `c_md5 constant text := 'c_md5 constant text := '<md5>';`, і `do $post$`
   ставав синтаксично невалідним. Лічильник збігів був 1 — тому `die` мовчав,
   а скрипт друкував ✅. */
dst = subOnce(dst, /c_md5 constant text := '(?:[0-9a-f]{32}|@@GUARD_MD5@@)';/g,
  `c_md5 constant text := '${NEW_MD5}';`, "c_md5");
dst = subOnce(dst, /c_len constant int {2}:= \d+;/g,
  `c_len constant int  := ${NEW_LEN};`, "c_len");

/* ⚠️ ПЕРЕВІРЯЄМО ВИХІД, А НЕ ЛИШЕ ВХІД. Саме цього бракувало: `subOnce`
   рахував збіги ПЕРЕД заміною і був зелений на зіпсованому результаті.
   Тепер рядок мусить мати канонічну форму ПІСЛЯ підстановки. */
for (const [re, name] of [
  [new RegExp(`^  c_md5 constant text := '${NEW_MD5}';$`, "m"), "c_md5"],
  [new RegExp(`^  c_len constant int  := ${NEW_LEN};$`, "m"), "c_len"],
]) {
  if (!re.test(dst)) die(`після заміни рядок ${name} не має канонічної форми — файл зіпсовано`);
}

writeFileSync(DST, dst, "utf8");
/* 5. ПІН `g` СМОУКУ — теж машиною. Досі скрипт рахував лише одне з двох чисел
      (`g2`, тіло без CR), а нормалізований `g` знімався руками живим запитом.
      Несиметрія коштувала проєкту неточності: коментар у смоуку сам зізнається,
      що провенанс пінa описаний заміром, якого не робили. Формула — рівно та,
      що в `gcal_pg_cron_smoke.sql`: зняти блокові коментарі, зняти рядкові,
      схлопнути пробіли, обрізати. ЗЕЛЕНИЙ БАЗИС ПРИЛАДУ: та сама формула на
      СТАРОМУ тілі мусить дати `673861da14838e8a21c5365cb91572ce`. */
/* ⚠️ БЕЗ `trim()`. Смоук робить рівно три `regexp_replace` і НЕ обрізає краї;
   тіло починається з переводу рядка, який схлопується у ПРОБІЛ, і цей пробіл
   входить у дайджест. Перша редакція тут мала `.trim()` — прилад дав
   `ef35116c…` замість `673861da…` і сам себе зупинив на відомій відповіді. */
const norm = (s) => s
  .replace(/\/\*[\s\S]*?\*\//gs, " ")
  .replace(/--[^\n]*/g, " ")
  .replace(/\s+/g, " ");
const G_OLD = md5(norm(ob));
const G_NEW = md5(norm(nb));
console.log("\nПіни смоуку:");
console.log("  g  (нормалізований) базис 0184:", G_OLD, G_OLD === "673861da14838e8a21c5365cb91572ce" ? "✔ збігся" : "⛔ НЕ ЗБІГСЯ");
if (G_OLD !== "673861da14838e8a21c5365cb91572ce")
  die("прилад для `g` червоний на відомій відповіді — новому g вірити не можна");
console.log("  g  (нормалізований) для 0185:  ", G_NEW);
console.log("  g2 (тіло без CR)    для 0185:  ", NEW_MD5, "довжина", NEW_LEN);

console.log(`\n✅ Блок (${out.length} байтів) і піни ${NEW_MD5} / ${NEW_LEN} вписано у ${DST}.`);
