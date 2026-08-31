/**
 * Поверхня realtime-підписок: що саме може приїхати клієнту (U-61).
 *
 * ЩО ТУТ НАСПРАВДІ. `realtime.apply_rls` політику на подіях DELETE не
 * ОБЧИСЛЮЄ — прочитано з живого тіла функції в проді:
 *
 *     if not is_rls_enabled or action = 'DELETE' then
 *         visible_role_sub_ids = visible_role_sub_ids || subscription_id;
 *
 * тобто рішення «кому доставити» приймає ЛИШЕ фільтр підписки, а
 * `is_visible_through_filters` на порожньому списку фільтрів повертає true.
 * Підписка без фільтра отримує подію про КОЖНЕ видалення в цій таблиці по всій
 * базі.
 *
 * ⚠️ ПЕРША РЕДАКЦІЯ ЦЬОГО ФАЙЛА СТВЕРДЖУВАЛА БІЛЬШЕ — що разом із подією
 * приїжджає ПОВНИЙ старий рядок (ПІБ, телефон, email). Це НЕВІРНО, і ревʼю
 * пакета це показало. Та сама функція знає про діру й ріже `old_record` до
 * колонок первинного ключа, щойно на таблиці ввімкнено RLS:
 *
 *     and ( not is_rls_enabled or (c).is_pkey )
 *       -- if RLS enabled, we can't secure deletes so filter to pkey
 *
 * (у гілці UPDATE такої умови немає — там `old_record` повний, але доставку
 * UPDATE політика перевіряє, тож отримувач і так має право бачити рядок.)
 * RLS увімкнено на всіх 11 таблицях публікації `supabase_realtime` — заміряно,
 * і це тримає нічний `invariants_check` (перевірка №3: жодної таблиці public
 * без RLS).
 *
 * ЩО ЛИШАЄТЬСЯ і заради чого цей сканер: підписка без фільтра — це
 * крос-тенантний оракул «у клініці X о 03:41 видалили 240 рядків» з їхніми
 * id. Вмісту немає, тож це LOW, а не витік PII. Але це поверхня, якої не мало
 * бути, і кожен новий її шматок має зʼявлятись СВІДОМО.
 *
 * ЩО ПЕРЕВІРЯЄТЬСЯ:
 *  1) кожна підписка без фільтра стоїть на таблиці з ЯВНОГО списку дозволених,
 *     і кожен дозвіл має причину, яку перевіряє машина;
 *  2) «no-pii» звіряється з РЕАЛЬНОЮ схемою (`supabase/types.ts`): додали в
 *     `incidents` колонку `patient_phone` — тест червоніє. Ця перевірка тримає
 *     інваріант на випадок, якщо RLS на таблиці колись вимкнуть: тоді обрізка
 *     до PK перестане діяти, і вміст рядка поїде в сокет по-справжньому.
 *
 * ⚠️ Це саме СКАНЕР, а не пін по кількох рядках: наступну підписку без фільтра
 * знаходить він сам, а не наступний аудит. Межа усвідомлена — він бачить лише
 * літеральні `table: "..."` у масиві `subscriptions`, бо всі підписки в проєкті
 * пишуться так (`lib/useRealtimeRefetch.ts` — єдиний вхід у postgres_changes,
 * плюс `lib/useUnreadChanges.tsx`).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["components", "lib", "app"];

/** Колонки, наявність яких робить рядок непридатним для розсилки «всім».
    ⚠️ Список розширено за ревʼю р.2: перша редакція не ловила `claim_token`,
    `invite_token` (секрети), `queue_entries.doctor` (ПІБ направника текстом),
    `actor_hint`, `details` (вільний jsonb) і будь-які `notes`/`comment`.
    Свідома межа: це перевірка ПО ІМЕНАХ, тож колонка з невинною назвою і
    персональним вмістом її обійде. Тому вона й не єдиний бар'єр — вона лише не
    дає мовчки розширити список дозволених. */
const SENSITIVE =
  /^(patient_|contraindications$|indication$|notes?$|comment|description$|details$|hint$|phone|email|full_name$|login$|dob$|birth|token$|secret$|doctor$)/;

/**
 * Дозволені підписки БЕЗ фільтра. Ключ — таблиця, значення — ПІДСТАВА.
 *   "no-pii"   — у рядку немає чутливих колонок. Перевіряється МАШИНОЮ по
 *                `supabase/types.ts`.
 *   "accepted" — свідомо прийнятий борг: фільтр або зрізав би потрібні події,
 *                або потребує колонки, якої в цьому місці немає. Машина тут
 *                перевіряє лише те, що таблиця названа явно; підстава —
 *                РІШЕННЯ ЛЮДИНИ, і кожен новий запис має пройти ревʼю.
 *                ⚠️ Свідомо не вдаю, що ця половина перевіряється: сторож,
 *                який лише СТВЕРДЖУЄ, що щось перевірено, — це рівно та
 *                помилка, через яку цей файл довелось переписувати.
 */
const UNFILTERED_ALLOWED: Record<string, "accepted" | "no-pii"> = {
  /* ⚠️ Ключ — «файл:таблиця», а не просто таблиця (стенд фальсифікації, S5).
     Підстава завжди прив'язана до МІСЦЯ: «сітці зайнятості потрібні події про
     запис, що поїхав з кабінету» нічого не каже про підписку в іншому файлі.
     Зі списком по таблиці зняття фільтра в порталі лишалось зеленим. */

  /* Сітка зайнятості: запис МІНЯЄ кабінет, а фільтр у UPDATE звіряється з
     НОВИМ рядком — `room_id=eq.` проковтнув би подію «пацієнта перенесли
     звідси», і звільнений слот висів би зайнятим до тику полінгу.
     `clinic_id=eq.` зрізав би поверхню й нічого потрібного не втратив (клініку
     запис не міняє), але клініки в пропах хука немає — U-65. */
  "lib/slotBusy.ts:queue_entries": "accepted",
  /* Бейдж листа в сайдбарі: `clinic_id=eq.` підійшов би так само, але сайдбар
     клініки в пропах не має, а тягнути її через усі сторінки заради LOW —
     окремий пакет (U-65). */
  "components/Sidebar.tsx:waitlist_entries": "accepted",
  /* Каталог центрів направника: підписки покривають УСІ авторизовані центри, а
     фільтр postgres_changes уміє лише одну рівність. Звузити можна биндингом на
     центр (як у CeoDashboard) — теж U-65. Тут підстава сильніша: у рядках цих
     таблиць немає чутливих колонок, і це звіряється зі схемою. */
  "components/ReferralPortal.tsx:rooms": "no-pii",
  "components/ReferralPortal.tsx:services": "no-pii",
  "components/ReferralPortal.tsx:service_room_overrides": "no-pii",
};

/** Таблиця з ключа «файл:таблиця». */
const tableOf = (key: string): string => key.slice(key.indexOf(":") + 1);

type Sub = { file: string; line: number; table: string; filtered: boolean };

/** Маска коментарів по ОРИГІНАЛЬНОМУ тексту: 1 — символ усередині коментаря.
    Потрібна замість `codeOf` тому, що `codeOf` схлопує блок коментаря в один
    пробіл — і номери рядків у повідомленні сторожа їхали на сотні рядків
    (у цьому файлі було −283; знахідка ревʼю р.2). Тут текст лишається як є. */
function commentMask(src: string): Uint8Array {
  const mask = new Uint8Array(src.length);
  let i = 0;
  while (i < src.length) {
    if (src[i] === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? src.length : e + 2;
      mask.fill(1, i, end); i = end; continue;
    }
    if (src[i] === "/" && src[i + 1] === "/" && src[i - 1] !== ":") {
      const e = src.indexOf("\n", i);
      const end = e < 0 ? src.length : e;
      mask.fill(1, i, end); i = end; continue;
    }
    i++;
  }
  return mask;
}

function scanSubs(): Sub[] {
  const out: Sub[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) {
        if (e !== "node_modules" && e !== ".next") walk(p);
        continue;
      }
      if (!/\.tsx?$/.test(e)) continue;
      const src = readFileSync(p, "utf8");
      const mask = commentMask(src);
      /* ⚠️ Якір — `table:` У БУДЬ-ЯКОМУ місці обʼєкта, а не одразу після `{`
         (знахідка ревʼю р.2, HIGH). Перша редакція вимагала `{ table:` і через
         це НЕ БАЧИЛА ні `{ event, schema, table }` (рівно форма
         `lib/useUnreadChanges.tsx`), ні `{ filter, table, onChange }` — тобто
         підписка без фільтра, написана з іншим порядком ключів, лишалась
         невидимою при зеленому тесті. Тепер від якоря йдемо НАЗОВНІ до
         охоплюючої `{` і вперед до її пари. */
      const re = /\btable:\s*"([a-z_]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        if (mask[m.index]) continue;                       // згадка в коментарі
        let depth = 0, start = -1;
        for (let i = m.index; i >= 0; i--) {
          if (mask[i]) continue;
          if (src[i] === "}") depth++;
          else if (src[i] === "{") { if (depth === 0) { start = i; break; } depth--; }
        }
        if (start < 0) continue;
        depth = 0;
        let end = -1;
        for (let i = start; i < src.length; i++) {
          if (mask[i]) continue;
          if (src[i] === "{") depth++;
          else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end < 0) continue;
        const body = src.slice(start, end);
        const inCode = (re2: RegExp) => {
          re2.lastIndex = 0;
          let mm: RegExpExecArray | null;
          while ((mm = re2.exec(body)) !== null) if (!mask[start + mm.index]) return true;
          return false;
        };
        /* Розрізняємо підписку і будь-який інший обʼєкт із ключем `table`
           (напр. union-тип у `app/api/clinic/delete-request`). */
        if (!inCode(/\bonChange\s*:/g) && !inCode(/\bschema\s*:/g)) continue;
        /* ⚠️ «Є слово filter» — недостатньо (ревʼю р.2, HIGH): `filter: undefined`
           і `...(cid ? { filter: … } : {})` теж містять його, а фільтра в
           рантаймі може не бути. Спред усередині обʼєкта підписки робить склад
           невідомим — рахуємо як БЕЗ фільтра (fail-closed). */
        /* ⚠️ `\s*` СЕРЕДИНІ lookahead, а не перед ним. Перша редакція писала
           `/filter\s*:\s*(?!undefined\b)/` — і `filter: undefined` її
           задовольняв: `\s*` відкочувався на нуль пробілів, lookahead дивився
           на « undefined» і негативна умова проходила. Стенд фальсифікації
           (мутація S3) це й показав. */
        const hasSpread = inCode(/\.\.\./g);
        const filtered = !hasSpread && inCode(/\bfilter\s*:(?!\s*undefined\b)/g);
        out.push({
          file: p.slice(ROOT.length + 1).replace(/\\/g, "/"),
          line: src.slice(0, m.index).split("\n").length,
          table: m[1],
          filtered,
        });
      }
    }
  };
  for (const d of SCAN_DIRS) walk(resolve(ROOT, d));
  return out;
}

/** Колонки Row-типу таблиці з `supabase/types.ts` — з балансуванням дужок. */
function rowColumns(table: string): string[] {
  const types = readFileSync(resolve(ROOT, "supabase/types.ts"), "utf8");
  const anchor = new RegExp("\\n\\s*" + table + ":\\s*\\{").exec(types);
  expect(anchor, `таблиці ${table} немає в supabase/types.ts`).not.toBeNull();
  const from = (anchor as RegExpExecArray).index;
  const rowAt = types.indexOf("Row: {", from);
  expect(rowAt, `у ${table} не знайдено Row`).toBeGreaterThan(from);
  let depth = 0, i = types.indexOf("{", rowAt), end = -1;
  for (; i < types.length; i++) {
    if (types[i] === "{") depth++;
    else if (types[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  expect(end, `у ${table} не зійшлись дужки Row`).toBeGreaterThan(rowAt);
  const body = types.slice(rowAt, end);
  return [...body.matchAll(/^\s*([a-z_]+)\??\s*:/gm)].map((m) => m[1]).filter((c) => c !== "Row");
}

describe("U-61 — жодної підписки без фільтра, крім явно дозволених", () => {
  const subs = scanSubs();

  it("сканер узагалі щось знайшов (інакше всі перевірки нижче порожні)", () => {
    expect(subs.length, "жодної підписки не знайдено — сканер зламався").toBeGreaterThan(30);
    expect(subs.filter((s) => s.filtered).length, "жодної фільтрованої підписки").toBeGreaterThan(20);
  });

  it("кожна підписка БЕЗ фільтра стоїть у явному списку — і саме в СВОЄМУ файлі", () => {
    const bad = subs.filter((s) => !s.filtered && !(`${s.file}:${s.table}` in UNFILTERED_ALLOWED));
    expect(bad.map((s) => `${s.file}:${s.line} → ${s.table}`), [
      "Підписка без фільтра отримує подію про КОЖНЕ видалення в цій таблиці по всій базі",
      "(RLS на DELETE не обчислюється — U-61). Додай фільтр — або внеси",
      "«файл:таблиця» в UNFILTERED_ALLOWED з підставою.",
    ].join(" ")).toEqual([]);
  });

  it("підстава «no-pii» звіряється зі СХЕМОЮ, а не з пам'яттю", () => {
    for (const [key, reason] of Object.entries(UNFILTERED_ALLOWED)) {
      if (reason !== "no-pii") continue;
      const table = tableOf(key);
      const sensitive = rowColumns(table).filter((c) => SENSITIVE.test(c));
      expect(sensitive, `у таблиці ${table} зʼявились чутливі колонки — підписка без фільтра (${key}) більше не безпечна`)
        .toEqual([]);
    }
  });

  it("PII-таблиця не може прикинутись «no-pii», а сама SENSITIVE не могла зіпсуватись", () => {
    /* Прямий захист від найдешевшого способу «полагодити» червоний тест:
       переписати підставу замість того, щоб додати фільтр. Друга половина —
       контроль самої регулярки: якщо вона перестане ловити явні PII-таблиці,
       перевірка вище стане тавтологією. */
    for (const t of ["queue_entries", "waitlist_entries", "patient_cases", "profiles"]) {
      const sensitive = rowColumns(t).filter((c) => SENSITIVE.test(c));
      expect(sensitive.length, `${t} раптом виглядає як таблиця без PII — перевір SENSITIVE`).toBeGreaterThan(0);
    }
  });

  it("список підстав не роздувся мовчки", () => {
    /* Кожен новий запис у списку — це шматок крос-тенантної поверхні, доданий
       свідомо. Тест не забороняє його додати, але змушує зробити це ЯВНО,
       разом із ревʼю цього рядка. */
    expect(Object.keys(UNFILTERED_ALLOWED).sort()).toEqual([
      "components/ReferralPortal.tsx:rooms",
      "components/ReferralPortal.tsx:service_room_overrides",
      "components/ReferralPortal.tsx:services",
      "components/Sidebar.tsx:waitlist_entries",
      "lib/slotBusy.ts:queue_entries",
    ]);
  });
});
