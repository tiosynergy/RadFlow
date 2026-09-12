/* Механічна збірка 0190 з 0187: блок передруку + РІВНО дві підстановки.
   Жодного рядка руками — той самий канон, що в 0187 (він збирався з 0185). */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
/* Шляхи — від КОРЕНЯ ПРОЄКТУ, а не хардкодом машини: перша редакція цього
   збирача жила в робочій теці з абсолютним `D:/RadFlowDev/…`, і ревʼю
   справедливо назвало міграцію невідтворюваною з дерева. */
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const MIG = ROOT + "supabase/migrations/";
const FRAG = ROOT + "scripts/frag/";
/* ⚠️ ДЖЕРЕЛО НАЗВАНЕ ЯВНО і звіряється з фактичним останнім передруком:
   ассерт на md5 стереже ФАЙЛ, але не ВИБІР файла (знахідка ревʼю В). */
const SOURCE = "0187_fn_audit_loud.sql";
{
  const { readdirSync } = await import("node:fs");
  const reprints = readdirSync(MIG).filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .filter((f) => /^create or replace function public\.invariants_check/m.test(readFileSync(MIG + f, "utf8")))
    .filter((f) => !f.startsWith("0190_"))
    .sort((a, b) => Number(a.slice(0, 4)) - Number(b.slice(0, 4)));
  const latest = reprints[reprints.length - 1];
  if (latest !== SOURCE) {
    throw new Error(`ЗБІРКА: останній передрук — ${latest}, а збирач читає ${SOURCE}. Оновіть SOURCE свідомо.`);
  }
}
const src = readFileSync(MIG + SOURCE, "utf8");
const nl = src.includes("\r\n") ? "\r\n" : "\n";

const START = "create or replace function public.invariants_check";
const at = src.indexOf(START);
if (at < 0) throw new Error("ЗБІРКА: передруку invariants_check у 0187 немає");
if (src.indexOf(START, at + 1) >= 0) throw new Error("ЗБІРКА: передрук двічі — якір не унікальний");
const CLOSE = nl + "$function$;";
const end = src.indexOf(CLOSE, at);
if (end < 0) throw new Error("ЗБІРКА: передрук не закритий $function$;");
let block = src.slice(at, end + CLOSE.length);

const bodyOf = (b) => {
  const open = b.indexOf("as $function$") + "as $function$".length;
  const close = b.lastIndexOf(nl + "$function$;");
  return b.slice(open, close + nl.length).replace(/\r/g, "");
};

/* ЗЕЛЕНИЙ БАЗИС: тіло з файла мусить збігтися з тим, що стоїть у проді. */
const base = bodyOf(block);
const BASE_MD5 = "95b0b4d2ba635e85c335ff7615c3b0a3";
const BASE_LEN = 111592;
if (md5(base) !== BASE_MD5 || base.length !== BASE_LEN) {
  throw new Error(`ЗБІРКА: блок 0187 НЕ дорівнює проду — ${md5(base)} / ${base.length}, `
    + `очікували ${BASE_MD5} / ${BASE_LEN}. Міграцію не зібрано.`);
}

const count = (hay, needle) => hay.split(needle).length - 1;

/* Підстановка 1 — новий рядок списку, за алфавітом після request_is_client_role. */
const ANCHOR = "      ('request_is_client_role()','9ab7fbaaf5d1e575a28727a94fe0a316',"
  + "'secdef=false;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp')," + nl;
if (count(block, ANCHOR) !== 1) throw new Error(`ЗБІРКА: якір списку зустрічається ${count(block, ANCHOR)} раз(ів)`);
const ADDED = "      ('room_busy_slots(p_room uuid, p_date date, p_exclude uuid)',"
  + "'83ddb89d6b1cd33ae19c8d314d29b73c',"
  + "'secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp')," + nl;

/* Підстановка 1б — РІШЕННЯ про видимість ПІБ ухвалює не `room_busy_slots`,
   а `auth_can_see_slot_details` (знахідка ревʼю Г). Пінити викликача й
   лишити вирішувача — зачинити двері й лишити вікно. За алфавітом іде ПЕРЕД
   auth_clinic_id. */
const ANCHOR_ACS = "      ('auth_clinic_id()','e7630130c3ef5aaa8186d6aa64640168',"
  + "'secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public')," + nl;
const ADDED_ACS = "      ('auth_can_see_slot_details(c uuid)',"
  + "'19fe1040308640b29a5d8b1bb7506873',"
  + "'secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp')," + nl;

/* Підстановка 3 — гілка `extra:`. У №19 її не було: `cur` розширюється по
   ГОЛОМУ імені (`split_part`), але рядок, що є в `cur` і якого немає в
   `expd`, мовчки відкидався. Тобто перевантаження пінованого імені —
   `room_busy_slots(p_room uuid, p_date date)` — проходило повз сторожа, а
   PostgREST розводить перевантаження за НАБОРОМ імен параметрів. У сусідніх
   №22 і №23 гілка `new:` є; тут її бракувало (знахідка ревʼю Г).
   Заміряно 12.09: перевантажень серед 30 імен зараз НЕМАЄ — тобто гілка не
   зробить сторожа червоним на рівному місці. */
const ANCHOR_EXTRA = "        union all" + nl
  + "        -- тригер на auth.users: №17 фільтрує nspname='public' і його не бачить" + nl;
const ADDED_EXTRA = "        union all" + nl
  + "        -- перевантаження пінованого імені: у списку його НЕМАЄ, а двері є." + nl
  + "        -- `cur` розширений по голому імені саме для цієї гілки." + nl
  + "        select 'extra:' || c.fn" + nl
  + "          from cur c" + nl
  + "         where not exists (select 1 from expd e where e.fn = c.fn)" + nl;
/* ⚠️ Перевіряємо саме РЯДОК ПІНА, а не згадку: слово `room_busy_slots`
   зустрічається в передруку і поза списком (перша редакція цієї перевірки
   впала саме на цьому і показала, що згадка ≠ пін). */
if (count(block, "('room_busy_slots(") !== 0) throw new Error("ЗБІРКА: пін room_busy_slots уже в списку");
{
  const lf = block.replace(/\r/g, "").split("\n");
  const where = lf.map((l, i) => [i + 1, l]).filter(([, l]) => String(l).includes("room_busy_slots"));
  console.log("ЗГАДКИ room_busy_slots у передруку 0187:", JSON.stringify(where));
}
block = block.replace(ANCHOR, ANCHOR + ADDED);

for (const [name, a, add] of [["acs", ANCHOR_ACS, ADDED_ACS], ["extra", ANCHOR_EXTRA, ADDED_EXTRA]]) {
  if (count(block, a) !== 1) throw new Error(`ЗБІРКА: якір ${name} зустрічається ${count(block, a)} раз(ів)`);
  /* ⚠️ `extra:` вставляється ПЕРЕД якорем, інакше замість вставки вийшла б
     ЗАМІНА: коментар гілки `auth_trigger:` зник би разом зі своїм `union all`,
     і два select-и злиплися б у синтаксичну помилку. Перша редакція цього
     циклу робила саме так. */
  block = block.replace(a, name === "extra" ? add + a : a + add);
}
if (count(block, "('auth_can_see_slot_details(") !== 1) throw new Error("ЗБІРКА: пін auth_can_see_slot_details не став рівно один раз");
if (count(block, "'extra:'") !== 1) throw new Error("ЗБІРКА: гілка extra: не одна");

/* Скільки рядків у списку — рахуємо ТИМ САМИМ регексом, що й тест. */
const ROW_RE = /^ {6}\('[A-Za-z0-9_]+\([^)]*\)','[0-9a-f]{32}','[^']*'\),?$/gm;
const blockLf = block.replace(/\r/g, "");
const rows = blockLf.match(ROW_RE) || [];

/* Підстановка 2 — стара цифра в коментарі брехала. */
const OLD_N = "Список став 23 функції.";
if (count(block, OLD_N) !== 1) throw new Error(`ЗБІРКА: рядок про кількість зустрічається ${count(block, OLD_N)} раз(ів)`);
block = block.replace(OLD_N, `Список став ${rows.length} функцій.`);

const body = bodyOf(block);
const LEDGER = [
  "", "do $ledger$", "begin",
  "  if not exists (select 1 from public.migration_ledger",
  "                  where name = '0189_room_busy_slots_tz_once.sql') then",
  "    raise exception '0190 потребує 0189 (накатуйте по порядку)';",
  "  end if;",
  "  if exists (select 1 from public.migration_ledger",
  "              where name = '0190_room_busy_slots_pinned.sql') then",
  "    raise exception '0190 вже накатана';",
  "  end if;",
  "end", "$ledger$;", "",
  "-- ============================================================================",
  "-- 1. invariants_check: передрук 0187 + один рядок у списку №19.",
  "-- ============================================================================",
].join(nl);
const REG = [
  "", "-- ============================================================================",
  "-- Самореєстрація (канон 0142) — ОСТАННІЙ statement перед commit",
  "-- ============================================================================",
  "insert into public.migration_ledger (name)",
  "values ('0190_room_busy_slots_pinned.sql')",
  "on conflict (name) do nothing;", "", "commit;",
].join(nl);

const head = readFileSync(FRAG + "0190-head.txt", "utf8").replace(/\r?\n/g, nl).trimEnd();
const tail = readFileSync(FRAG + "0190-tail.txt", "utf8").replace(/\r?\n/g, nl).trimEnd();
const out = [head, "", "begin;", LEDGER, block, REG, tail, ""].join(nl);
writeFileSync(MIG + "0190_room_busy_slots_pinned.sql", out, "utf8");

console.log(JSON.stringify({
  base_md5: md5(base), base_len: base.length,
  new_md5: md5(body), new_len: body.length,
  delta_len: body.length - base.length,
  rows_in_list: rows.length,
  file_bytes: Buffer.byteLength(out, "utf8"),
}, null, 1));
