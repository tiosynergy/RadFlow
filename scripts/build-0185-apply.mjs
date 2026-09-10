// ============================================================
//  Збирає КОМПАКТНИЙ скрипт накату 0185 для каналу MCP.
//
//  ⚠️ НАВІЩО. Файл міграції — 152 КБ, і 97 із них це тіло, яке В ПРОДІ ВЖЕ
//     СТОЇТЬ (редакція 0184). Гнати їх через канал ще раз — це не лише дорого,
//     це зайва поверхня для помилки переносу. Тому сюди їде ЛИШЕ нова гілка
//     (~15 КБ), а нове тіло збирається НА ПРОДІ з поточного плюс вставка.
//
//  ⚠️ ЧОМУ ЦЕ БЕЗПЕЧНО: правильність доводить не акуратність переносу, а
//     ДВА асерти md5 — предстану (мусить бути рівно 0184) і результату
//     (мусить побайтно збігтися з тілом ІЗ ФАЙЛА, яке порахував
//     `build-0185-reprint.mjs`). Зібралось інакше — транзакція падає.
//
//  ⚠️ ДВА РЕЖИМИ:
//     node scripts/build-0185-apply.mjs        → сухий прогін (МАРКЕР ВІДКОТУ)
//     node scripts/build-0185-apply.mjs --live → бойовий накат (без маркера)
//     Маркер відкоту — НЕ оформлення зонда, це його ЄДИНА відмінність від
//     накату (урок с61 №1, оплачений тим, що функція поїхала в прод поза
//     міграцією).
//
//  Вихід: scripts/frag/0185_apply.sql
// ============================================================
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const die = (m) => { console.error("⛔ " + m); process.exit(1); };
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const noCR = (s) => s.replace(/\r/g, "");

const LIVE = process.argv.includes("--live");
const MIG = "supabase/migrations/0185_schema_digest.sql";
const FRAG = "scripts/frag/0185_check23.sql";
const OUT = "scripts/frag/0185_apply.sql";

const OLD_MD5 = "11a297318da068f53b113c3d9120e6b8";

/* Тіло-еталон беремо З ФАЙЛА МІГРАЦІЇ — того самого, який пінить `db:gate`. */
const mig = readFileSync(MIG, "utf8");
const at = mig.search(/^create or replace function public\.invariants_check/m);
if (at < 0) die("у міграції немає передруку");
const o = mig.indexOf("as $function$", at) + "as $function$".length;
const e = mig.indexOf("$function$;", o);
const NEW_BODY = noCR(mig.slice(o, e));
const NEW_MD5 = md5(NEW_BODY);
const NEW_LEN = NEW_BODY.length;

/* Гілка — LF, бо в проді `cr_count = 0`, і ми не хочемо його зіпсувати. */
const branch = noCR(readFileSync(FRAG, "utf8")).replace(/\n$/, "");

/* Якір — хвіст обробника №22 разом із його `end;`. Той самий, що в генераторі
   передруку: якщо вони розійдуться, зібране тіло не зійдеться по md5. */
const ANCHOR = [
  "  /* 0174 */     'check', 'grant_digest', 'offenders',",
  "  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));",
  "  /* 0174 */ end;",
].join("\n");

/* ⚠️ ЗЕЛЕНИЙ БАЗИС ЗБІРНИКА: та сама операція, виконана ТУТ над тілом 0184 з
   файла 0184, мусить дати рівно NEW_MD5. Якщо ні — на прод іти не можна. */
const src84 = readFileSync("supabase/migrations/0184_rf03b_sched_marker_fanout.sql", "utf8");
const a84 = src84.search(/^create or replace function public\.invariants_check/m);
const o84 = src84.indexOf("as $function$", a84) + "as $function$".length;
const e84 = src84.indexOf("$function$;", o84);
const OLD_BODY = noCR(src84.slice(o84, e84));
if (md5(OLD_BODY) !== OLD_MD5) die(`тіло 0184 з файла дає ${md5(OLD_BODY)}, а прод — ${OLD_MD5}`);
if (OLD_BODY.split(ANCHOR).length - 1 !== 1) die("якір у тілі 0184 не унікальний");
const SIM = OLD_BODY.replace(ANCHOR, ANCHOR + "\n\n" + branch);
if (md5(SIM) !== NEW_MD5)
  die(`СИМУЛЯЦІЯ ЗБІРКИ дала ${md5(SIM)} замість ${NEW_MD5} — на прод НЕ йдемо`);
console.log("✔ базис збірника: та сама вставка на тілі 0184 відтворює", NEW_MD5, `(${NEW_LEN})`);

const q = (s) => s.replace(/\$/g, "$"); // жодних $-тегів усередині гілки немає — перевірено нижче
for (const tag of ["$apply$", "$branch$", "$anchor$"]) {
  if (branch.includes(tag)) die(`гілка містить ${tag} — доларове лапкування зламається`);
}

const tail = LIVE
  ? "  raise notice '0185 НАКАТАНО: md5 % len % checked 23', v_md5, v_len;"
  : "  -- ⚠️ МАРКЕР ВІДКОТУ. Прибирається ЛИШЕ прапорцем --live.\n" +
    "  raise exception 'RB:0185 СУХИЙ ПРОГІН OK — md5 % len % checked 23', v_md5, v_len;";

const sql = `-- ${LIVE ? "БОЙОВИЙ НАКАТ" : "СУХИЙ ПРОГІН (з маркером відкоту)"} 0185 — згенеровано build-0185-apply.mjs
do $apply$
declare
  v_def text; v_body text; v_new text; v_head text;
  v_md5 text; v_len int; v_res jsonb; v_hits int;
  v_anchor constant text := $anchor$${ANCHOR}$anchor$;
  v_branch constant text := $branch$${branch}$branch$;
begin
  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then raise exception '0185: invariants_check(p_write boolean) не знайдено'; end if;

  -- 1. ПРЕДСТАН: у проді мусить стояти рівно 0184
  if md5(replace(v_body, chr(13), '')) is distinct from '${OLD_MD5}' then
    raise exception '0185: предстан НЕ 0184 (%) — передрук наосліп заборонено',
      md5(replace(v_body, chr(13), ''));
  end if;

  -- 2. ЯКІР рівно один раз
  v_hits := (length(v_body) - length(replace(v_body, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then raise exception '0185: якір №22 трапляється % раз(ів)', v_hits; end if;

  -- 3. ЗБІРКА і асерт результату проти тіла З ФАЙЛА
  v_new := replace(v_body, v_anchor, v_anchor || chr(10) || chr(10) || v_branch);
  v_md5 := md5(replace(v_new, chr(13), ''));
  v_len := length(replace(v_new, chr(13), ''));
  if v_md5 <> '${NEW_MD5}' or v_len <> ${NEW_LEN} then
    raise exception '0185: зібране тіло % / % — очікували ${NEW_MD5} / ${NEW_LEN}', v_md5, v_len;
  end if;

  -- 4. Заміна тіла, атрибути беремо з каталогу (не переписуємо рукою)
  v_head := left(v_def, position('$function$' in v_def) + 9);
  execute v_head || v_new || '$function$';

  -- 5. Сторож зелений ТУТ, у цій же транзакції
  v_res := public.invariants_check(false);
  if coalesce((v_res ->> 'ok')::boolean, false) is not true then
    raise exception '0185: сторож червоний одразу після передруку: %', v_res ->> 'failed';
  end if;
  if (v_res ->> 'checked')::int <> 23 then
    raise exception '0185: checked = %, а мусить стати 23', v_res ->> 'checked';
  end if;

  -- 6. ДРУГИЙ ЗАМІР — уже з КАТАЛОГУ, а не зі змінної. «Успіх» не доказ.
  select md5(replace(p.prosrc, chr(13), '')), length(replace(p.prosrc, chr(13), ''))
    into v_md5, v_len
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_md5 <> '${NEW_MD5}' or v_len <> ${NEW_LEN} then
    raise exception '0185: у каталозі % / % — передрук не той', v_md5, v_len;
  end if;

  -- 7. Самореєстрація
  insert into public.migration_ledger (name) values ('0185_schema_digest.sql')
    on conflict (name) do nothing;

${tail}
end
$apply$;
`;

writeFileSync(OUT, sql, "utf8");
console.log(`✅ ${LIVE ? "БОЙОВИЙ" : "СУХИЙ"} скрипт (${sql.length} байтів) → ${OUT}`);
