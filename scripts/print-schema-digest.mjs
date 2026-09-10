// ============================================================
//  ПРИЛАД ДО ПЕРЕВІРКИ №23 `schema_digest` (0185).
//
//  ⚠️ НАВІЩО ВІН ІСНУЄ. №23 пінить 84 ключі всередині тіла сторожа. Отже
//     БУДЬ-ЯКА міграція, що додає колонку, constraint, мітку enum або
//     частковий унікальний індекс, зобовʼязана оновити відповідний ключ —
//     інакше сторож червоний. Урок 0141 каже прямо: постійно червоний сторож
//     це видалений сторож. Тому тут ПРИЛАД, а не інструкція «не забудьте».
//
//  ⚠️ ЧОМУ ДРУКУЄ ЗАПИТ, А НЕ РЕЗУЛЬТАТ — назване обмеження, не лінощі.
//     Скрипти проєкту ходять у БД через `createClient` (PostgREST), а він
//     виконує лише RPC і таблиці, не довільний каталожний SQL. Заводити
//     definer-функцію «виконай будь-що» заради зручності — це нова діра,
//     більша за задачу. Тому прилад друкує ГОТОВИЙ ЗАПИТ, який лишається
//     виконати в SQL Editor або через MCP і скопіювати вивід.
//
//  Запуск:
//     node scripts/print-schema-digest.mjs            — запит, що друкує ВСІ
//        84 рядки у форматі `('key','n:md5'),` — просто вставити в `expd`;
//     node scripts/print-schema-digest.mjs queue_entries
//        — запит-ДІАГНОЗ: порядковий список колонок однієї таблиці плюс її
//        constraint-и, enum-и її колонок і унікальні індекси. Саме ним
//        читається `changed:t:queue_entries:40:968b94…->40:a1b2c3…` за
//        хвилину, а не за пів години.
// ============================================================

/* ⚠️ ТЕКСТ CTE НИЖЧЕ — ДОСЛІВНА КОПІЯ гілки №23 із `scripts/frag/0185_check23.sql`,
   включно з пробілами. Це не педантизм: `check-digest-formula-parity.mjs`
   звіряє їх СТРОГИМ порівнянням тексту, а не «на око». Прилад, що рахує не
   те саме, гірший за відсутній — він дає число, якому вірять. Правиш формулу
   в одному місці — правиш в обох і ганяєш звірку. */
const CUR = `with tabs as (
    select c.oid, c.relname::text as obj, c.relkind
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
     where c.relkind in ('r', 'v', 'm', 'p', 'f')
  ), col as (
    select t.obj, t.relkind, a.attnum,
           a.attname::text || ':' || format_type(a.atttypid, a.atttypmod)
             || case when a.attnotnull then '!' else '' end
             || coalesce('=' || pg_get_expr(d.adbin, d.adrelid), '')
             || case when a.attidentity::text = '' then ''
                     else '#' || a.attidentity::text end
             || case when a.attgenerated::text = '' then ''
                     else '@' || a.attgenerated::text end as line
      from tabs t
      join pg_attribute a
        on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
      left join pg_attrdef d
        on d.adrelid = a.attrelid and d.adnum = a.attnum
  ), colagg as (
    select (case when relkind = 'r' then 't:'
                 when relkind = 'v' then 'v:'
                 else relkind::text || ':' end) || obj as key,
           count(*)::text || ':'
             || substr(md5(string_agg(line, ',' order by attnum)), 1, 12) as dig
      from col group by relkind, obj
  ), kon as (
    select 'k:' || rel.relname::text as key,
           co.conname::text || ':' || co.contype::text || ':'
             || pg_get_constraintdef(co.oid) as line
      from pg_constraint co
      join pg_namespace n on n.oid = co.connamespace and n.nspname = 'public'
      join pg_class rel on rel.oid = co.conrelid
      join pg_namespace rn
        on rn.oid = rel.relnamespace and rn.nspname = 'public'
     where rel.relkind in ('r', 'p')
  ), konagg as (
    select key,
           count(*)::text || ':'
             || substr(md5(string_agg(line, ',' order by line)), 1, 12) as dig
      from kon group by key
  ), enu as (
    select 'e:' || t.typname::text as key,
           count(*)::text || ':'
             || substr(md5(string_agg(e.enumlabel::text, ',' order by e.enumsortorder)), 1, 12) as dig
      from pg_type t
      join pg_namespace n on n.oid = t.typnamespace and n.nspname = 'public'
      join pg_enum e on e.enumtypid = t.oid
     group by t.typname
  ), idx as (
    select 'u:' || rel.relname::text as key,
           ic.relname::text || ':' || pg_get_indexdef(i.indexrelid) as line
      from pg_index i
      join pg_class ic on ic.oid = i.indexrelid
      join pg_class rel on rel.oid = i.indrelid
      join pg_namespace n on n.oid = ic.relnamespace and n.nspname = 'public'
     where i.indisunique and rel.relkind in ('r', 'p')
       and not exists (select 1 from pg_constraint c
                        where c.conindid = i.indexrelid)
  ), idxagg as (
    select key,
           count(*)::text || ':'
             || substr(md5(string_agg(line, ',' order by line)), 1, 12) as dig
      from idx group by key
  )
select string_agg('      ('''||key||''','''||dig||'''),', chr(10) order by key) as expd_block,
       count(*) as keys
from (select key,dig from colagg union all select key,dig from konagg
      union all select key,dig from enu union all select key,dig from idxagg) z;`;

const diag = (t) => `-- ДІАГНОЗ по одній таблиці: ${t}
select a.attnum,
       a.attname::text||':'||format_type(a.atttypid,a.atttypmod)
         ||case when a.attnotnull then '!' else '' end
         ||coalesce('='||pg_get_expr(d.adbin,d.adrelid),'')
         ||case when a.attidentity::text='' then '' else '#'||a.attidentity::text end
         ||case when a.attgenerated::text='' then '' else '@'||a.attgenerated::text end as line
  from pg_class c
  join pg_namespace n on n.oid=c.relnamespace and n.nspname='public'
  join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
 where c.relname='${t}' order by a.attnum;

-- constraint-и тієї ж таблиці (гілка k:)
select co.conname::text||':'||co.contype::text||':'||pg_get_constraintdef(co.oid) as line
  from pg_constraint co join pg_class rel on rel.oid=co.conrelid
 where rel.relname='${t}' order by 1;

-- унікальні індекси БЕЗ constraint (гілка u:)
select ic.relname::text||':'||pg_get_indexdef(i.indexrelid) as line
  from pg_index i join pg_class ic on ic.oid=i.indexrelid
  join pg_class rel on rel.oid=i.indrelid
 where rel.relname='${t}' and i.indisunique
   and not exists (select 1 from pg_constraint c where c.conindid=i.indexrelid)
 order by 1;

-- enum-и, на яких стоять колонки цієї таблиці (гілка e:)
select 'e:'||t2.typname::text as key,
       string_agg(e.enumlabel::text, ',' order by e.enumsortorder) as labels
  from pg_class c
  join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
  join pg_type t2 on t2.oid=a.atttypid
  join pg_enum e on e.enumtypid=t2.oid
 where c.relname='${t}' group by t2.typname order by 1;`;

const arg = process.argv[2];
if (arg && !/^[a-z_][a-z0-9_]{0,62}$/i.test(arg)) {
  console.error("⛔ імʼя таблиці мусить бути простим ідентифікатором");
  process.exit(1);
}
console.log(arg ? diag(arg) : CUR);
