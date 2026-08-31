// ============================================================
//  Стенд фальсифікації пакета Ф4-2 (секунди у дзеркалі гарда 0129, с50).
//
//  Головне питання: чи ЧЕРВОНІЮТЬ сторожі, якщо повернути хвилинне усічення —
//  тобто рівно той дефект, заради якого писався пакет; і чи не червоніють вони
//  від нешкідливих правок (інакше їх знімуть при першому ж рефакторі).
//
//  ⚠️ Правлю БОЙОВІ файли → try/finally + обробники сигналів.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ.
//  ⚠️ Базова лінія мусить бути ЗЕЛЕНОЮ.
//
//  Запуск: node scripts/falsify-f4-2.mjs      Звіт: falsify-f4-2.md (gitignore)
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

/* Файл міграції НЕ захардкоджений (ревʼю Б, MEDIUM): сторож бере ОСТАННЮ
   міграцію, що створює RPC, і стенд мусить правити рівно її — інакше після
   появи 0150 мутації M8-M11 перестали б доставати до артефакта і стенд видав
   би чотири фальшиві «сторож не тримає». */
const MIGDIR = "supabase/migrations";
const RPC_CREATE = /create\s+(?:or\s+replace\s+)?function\s+(?:public\s*\.\s*)?"?queue_set_status_rpc"?\s*\(/i;
const latestMig = readdirSync(MIGDIR).filter((f) => f.endsWith(".sql")).sort()
  .filter((f) => RPC_CREATE.test(readFileSync(`${MIGDIR}/${f}`, "utf8"))).pop();
if (!latestMig) { console.error("не знайдено міграцію з queue_set_status_rpc"); process.exit(2); }

const FILES = {
  qs: "lib/queueStatus.ts",
  inc: "lib/incidents.ts",
  test: "tests/lateCallGuardMirror.test.ts",
  mig: `${MIGDIR}/${latestMig}`,
};
const NEW_SPEC = "tests/lateCallGuardMirror.test.ts";
const SPECS = [NEW_SPEC, "tests/queueStatus.test.ts"];
const OUT = "falsify-f4-2.md";
const REPORT = ".falsify-f4-2.json";

const MUTATIONS = [
  // ---------- має ЧЕРВОНІТИ ----------
  {
    id: "M1", file: "qs", green: false,
    what: "повернуто хвилинне усічення «зараз» — САМ дефект Ф4-2",
    from: "  const nowMsOfDay = wallMsOfDay(nowMs);",
    to: "  const nowMsOfDay = wallMinOfDay(nowMs) * 60000;",
  },
  {
    id: "M2", file: "qs", green: false,
    what: "знято слак на розрядність — кінець вікна знову fail-open",
    from: " + callWindowMinutes(p) * 60000 + CALL_WINDOW_CLOCK_SLACK_MS;",
    to: " + callWindowMinutes(p) * 60000;",
  },
  {
    id: "M3", file: "qs", green: false,
    what: "права межа стала включною — блокує слот, якого сервер не блокує",
    from: "    .filter((x) => x.s >= nowMsOfDay && x.s < endMsOfDay)",
    to: "    .filter((x) => x.s >= nowMsOfDay && x.s <= endMsOfDay)",
  },
  {
    id: "M4", file: "qs", green: false,
    what: "ліва межа стала суворою — слот рівно на «зараз» проскакує",
    from: "    .filter((x) => x.s >= nowMsOfDay && x.s < endMsOfDay)",
    to: "    .filter((x) => x.s > nowMsOfDay && x.s < endMsOfDay)",
  },
  {
    id: "M5", file: "qs", green: false,
    what: "секунди у scheduled_time знову відкидаються (старий toMin)",
    from: "  return (h || 0) * 3600000 + (m || 0) * 60000 + (s || 0) * 1000;",
    to: "  return (h || 0) * 3600000 + (m || 0) * 60000;",
  },
  {
    id: "M6", file: "qs", green: false,
    what: "слак виріс до хвилини — клієнт гасить кнопку там, де сервер дозволяє",
    from: "export const CALL_WINDOW_CLOCK_SLACK_MS = 1000;",
    to: "export const CALL_WINDOW_CLOCK_SLACK_MS = 60000;",
  },
  {
    id: "M7", file: "qs", green: false,
    what: "з allow-листа клієнта зник waiting — розсинхрон із гардом",
    from: '(e.status === "scheduled" || e.status === "waiting") && e.scheduled_time)',
    to: '(e.status === "scheduled") && e.scheduled_time)',
  },
  {
    id: "M8", file: "mig", green: false,
    what: "гард зробив праву межу включною — контракт змінився, клієнт має дізнатись",
    from: "         and q.scheduled_at <  v_end",
    to: "         and q.scheduled_at <= v_end",
  },
  {
    id: "M9", file: "mig", green: false,
    what: "гард змінив дефолт буфера з 5 на 10",
    from: "    v_end    := v_actual + make_interval(mins => v_dur + coalesce(v_buf, 5));",
    to: "    v_end    := v_actual + make_interval(mins => v_dur + coalesce(v_buf, 10));",
  },
  {
    id: "M10", file: "mig", green: false,
    what: "гард почав усікати «зараз» до хвилини — тоді правильним є СТАРЕ порівняння",
    from: "    v_actual := (now() at time zone v_tz) at time zone 'utc';",
    to: "    v_actual := date_trunc('minute', (now() at time zone v_tz) at time zone 'utc');",
  },
  {
    id: "M11", file: "mig", green: false,
    what: "гард додав третій статус — пін по літералу цього б не побачив",
    from: "         and q.status in ('scheduled', 'waiting')\n         and q.scheduled_at is not null",
    to: "         and q.status in ('scheduled', 'waiting', 'needs_reschedule')\n         and q.scheduled_at is not null",
  },
  {
    id: "M12", file: "test", green: false,
    what: "розбір міграції знову деградує тихо: нерозібране тіло = «немає»",
    from: '  if (end <= open) return { kind: "bad", why: `не знайдено закриття тега ${tag[1]}` };',
    to: '  if (end <= open) return { kind: "none" };',
  },
  // ---- дірки, знайдені ревʼю Б: кожна колись проходила повз сторожа ----
  {
    id: "M13", file: "qs", green: false,
    what: "клієнт перестав виключати САМ запис — пацієнт блокує сам себе",
    from: "e.room_id === p.room_id && e.id !== p.id && (e.status",
    to: "e.room_id === p.room_id && (e.status",
  },
  {
    id: "M14", file: "qs", green: false,
    what: "слак знято, а праву межу зроблено включною — на секундній сітці підміна непомітна",
    from: "  const endMsOfDay = nowMsOfDay + callWindowMinutes(p) * 60000 + CALL_WINDOW_CLOCK_SLACK_MS;\n  const next = entries",
    to: "  const endMsOfDay = nowMsOfDay + callWindowMinutes(p) * 60000 + CALL_WINDOW_CLOCK_SLACK_MS * 0;\n  const next = entries",
  },
  {
    id: "M15", file: "qs", green: false,
    what: "до фільтра дописано зайву умову — статуси ті самі, а блокує клієнт менше",
    from: '(e.status === "scheduled" || e.status === "waiting") && e.scheduled_time)',
    to: '(e.status === "scheduled" || e.status === "waiting") && e.call_status !== "called" && e.scheduled_time)',
  },
  {
    id: "M16", file: "qs", green: false,
    what: "у вікно виклику повернувся normBuffer — воно перестало дзеркалити coalesce(v_buf, …)",
    from: "  return (p.duration_min || 30) + Math.max(0, p.buffer_time_min ?? BUFFER_DEFAULT);",
    to: "  return (p.duration_min || 30) + normBuffer(p.buffer_time_min ?? BUFFER_DEFAULT);",
  },
  {
    id: "M17", file: "qs", green: false,
    what: "дефолт «зараз» підмінено на Date.now() — настінний канон загублено",
    from: "  entries: Array<{ id: string; room_id: string | null; status: string; scheduled_time: string | null; patient_name?: string | null }>,\n  nowMs: number = wallNow()",
    to: "  entries: Array<{ id: string; room_id: string | null; status: string; scheduled_time: string | null; patient_name?: string | null }>,\n  nowMs: number = Date.now()",
  },
  {
    id: "M18", file: "inc", green: false,
    what: "wallMsOfDay почав усікати до хвилини — половина дзеркала мертва",
    from: "  return (\n    d.getUTCHours() * 3600000 +\n    d.getUTCMinutes() * 60000 +\n    d.getUTCSeconds() * 1000 +\n    d.getUTCMilliseconds()\n  );",
    to: "  return (d.getUTCHours() * 60 + d.getUTCMinutes()) * 60000;",
  },
  {
    id: "M19", file: "mig", green: false,
    what: "усічення додано ДРУГИМ присвоєнням v_actual — попередній сторож читав лише перше",
    from: "    v_actual := (now() at time zone v_tz) at time zone 'utc';",
    to: "    v_actual := (now() at time zone v_tz) at time zone 'utc';\n    v_actual := date_trunc('minute', v_actual);",
  },
  {
    id: "M20", file: "mig", green: false,
    what: "усічення перенесено з v_actual у v_end — жоден сторож цього не бачив",
    from: "    v_end    := v_actual + make_interval(mins => v_dur + coalesce(v_buf, 5));",
    to: "    v_end    := date_trunc('minute', v_actual + make_interval(mins => v_dur + coalesce(v_buf, 5)));",
  },
  {
    id: "M21", file: "mig", green: false,
    what: "до ширини вікна дописано + interval '10 min' — регекс по make_interval цього не ловив",
    from: "    v_end    := v_actual + make_interval(mins => v_dur + coalesce(v_buf, 5));",
    to: "    v_end    := v_actual + make_interval(mins => v_dur + coalesce(v_buf, 5)) + interval '10 min';",
  },
  {
    id: "M22", file: "mig", green: false,
    what: "ліва межа гарда зсунута на хвилину — регекс без правого якоря був зелений",
    from: "         and q.scheduled_at >= v_actual",
    to: "         and q.scheduled_at >= v_actual + interval '1 minute'",
  },
  {
    id: "M23", file: "mig", green: false,
    what: "третій статус доданий ЧЕРЕЗ or — порівняння першого in (…) було зеленим",
    from: "         and q.status in ('scheduled', 'waiting')\n         and q.scheduled_at is not null",
    to: "         and (q.status in ('scheduled', 'waiting') or q.status in ('needs_reschedule'))\n         and q.scheduled_at is not null",
  },
  /* ДВІ правки одночасно — і це принципово. Сама по собі зміна форми create
     контракту не міняє, тож зелений результат нічого не довів би. Разом зі
     зсувом межі мутація доводить, що якір ВПІЗНАВ нову форму: якби не впізнав,
     `latestRpcBody` мовчки взяв би 0129, чиї умови збігаються з очікуваними,
     і сторож лишився б зеленим при зміненому контракті. */
  {
    id: "M24", file: "mig", green: false,
    what: "RPC пересоздано БЕЗ «or replace» і з включною правою межею",
    edits: [
      { from: "create or replace function public.queue_set_status_rpc(", to: "create function public.queue_set_status_rpc(" },
      { from: "         and q.scheduled_at <  v_end", to: "         and q.scheduled_at <= v_end" },
    ],
  },
  {
    id: "M25", file: "mig", green: false,
    what: "гілку (б) переписано через perform/found — якір «if exists (» переїхав би на гілку (а)",
    edits: [
      { from: "    if exists (\n      select 1\n        from public.queue_entries q\n       where q.room_id = v_room\n         and q.id <> p_id\n         and q.status in ('scheduled', 'waiting')",
        to: "    perform 1\n        from public.queue_entries q\n       where q.room_id = v_room\n         and q.id <> p_id\n         and q.status in ('scheduled', 'waiting')" },
      { from: "         and q.scheduled_at <  v_end\n    ) then", to: "         and q.scheduled_at <  v_end;\n    if found then" },
    ],
  },
  // ---------- має лишатись ЗЕЛЕНИМ ----------
  /* ⚠️ Перша редакція перейменовувала ЛИШЕ оголошення, лишаючи
     `return next || null;` — це не рефактор, а ReferenceError: увесь прогін
     червонів, і зонд «безпечної правки» нічого не доводив (ревʼю Б, HIGH;
     підтверджено самим стендом — T1 стояв ⛔). Перейменовуємо ОБИДВА місця. */
  {
    id: "T1", file: "qs", green: true,
    what: "перейменовано локальну змінну в lateCallClash (обидва місця)",
    edits: [
      { from: "  const next = entries", to: "  const soonest = entries" },
      { from: "  return next || null;", to: "  return soonest || null;" },
    ],
  },
  {
    id: "T2", file: "qs", green: true,
    what: "ширину вікна винесено в проміжну змінну (та сама формула)",
    from: "  const endMsOfDay = nowMsOfDay + callWindowMinutes(p) * 60000 + CALL_WINDOW_CLOCK_SLACK_MS;",
    to: "  const winMs = callWindowMinutes(p) * 60000;\n  const endMsOfDay = nowMsOfDay + winMs + CALL_WINDOW_CLOCK_SLACK_MS;",
  },
  {
    id: "T3", file: "qs", green: true,
    what: "перейменовано параметр розбору часу слота",
    from: "function slotMsOfDay(t: string): number {\n  const [h, m, s] = String(t).split(\":\").map(Number);",
    to: "function slotMsOfDay(raw: string): number {\n  const [h, m, s] = String(raw).split(\":\").map(Number);",
  },
  {
    id: "T4", file: "mig", green: true,
    what: "у гарді прибрано подвійний пробіл перед v_end (форматування)",
    from: "         and q.scheduled_at <  v_end",
    to: "         and q.scheduled_at < v_end",
  },
  {
    id: "T5", file: "mig", green: true,
    what: "у гарді переставлено статуси місцями — контракт порівнює МНОЖИНИ",
    from: "         and q.status in ('scheduled', 'waiting')\n         and q.scheduled_at is not null",
    to: "         and q.status in ('waiting', 'scheduled')\n         and q.scheduled_at is not null",
  },
  {
    id: "T6", file: "mig", green: true,
    what: "змінено коментар над гілкою — текст не є контрактом",
    from: "    -- (б) Наступні слоти: старт у вікні [v_actual, v_end). Порівняння в каноні",
    to: "    -- (б) Наступні слоти: старт у напіввідкритому вікні. Порівняння в каноні",
  },
  {
    id: "T7", file: "mig", green: true,
    what: "у гарді переписано відступи умов — контракт нормалізує пробіли",
    from: "         and q.scheduled_at is not null\n         and q.scheduled_at >= v_actual",
    to: "         and q.scheduled_at is not null\n           and q.scheduled_at >=   v_actual",
  },
  {
    id: "T8", file: "inc", green: true,
    what: "wallMsOfDay записано одним рядком — та сама арифметика",
    from: "  return (\n    d.getUTCHours() * 3600000 +\n    d.getUTCMinutes() * 60000 +\n    d.getUTCSeconds() * 1000 +\n    d.getUTCMilliseconds()\n  );",
    to: "  return d.getUTCHours() * 3600000 + d.getUTCMinutes() * 60000 + d.getUTCSeconds() * 1000 + d.getUTCMilliseconds();",
  },
];

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

/* ⚠️ Прогін, який НЕ ВІДБУВСЯ (репортер не віддав JSON — помилка збірки чи
   збору тестів), раніше рахувався за «сторож спіймав» (ревʼю Б, MEDIUM). Для
   мутацій у самому тест-файлі це прямий ризик: синтаксично зіпсована заміна
   давала б ✅ з чужої причини. Тепер це окремий стан `crashed`.
   Крім того рахуємо, ЯКИЙ спек почервонів: стенд перевіряє НОВИЙ сторож, а не
   те, що щось десь у проєкті впало. */
function run() {
  if (existsSync(REPORT)) unlinkSync(REPORT);
  spawnSync("npx", ["vitest", "run", ...SPECS, "--reporter=json", `--outputFile.json=${REPORT}`],
    { shell: true, stdio: "ignore" });
  if (!existsSync(REPORT)) return { crashed: true, ok: false, red: [], redInNew: [] };
  let r;
  try { r = JSON.parse(readFileSync(REPORT, "utf8")); }
  catch { return { crashed: true, ok: false, red: [], redInNew: [] }; }
  const red = [], redInNew = [];
  for (const f of r.testResults || []) {
    const isNew = String(f.name || "").replace(/\\/g, "/").endsWith(NEW_SPEC);
    for (const a of f.assertionResults || []) {
      if (a.status === "passed") continue;
      red.push(a.title);
      if (isNew) redInNew.push(a.title);
    }
  }
  return { crashed: false, ok: r.success === true && red.length === 0, red, redInNew, total: r.numTotalTests };
}

const lines = [];
try {
  const base = run();
  lines.push(`# Стенд фальсифікації Ф4-2 — секунди у дзеркалі гарда 0129 (с50)\n`);
  lines.push(`**БАЗОВА ЛІНІЯ:** ${base.ok ? "ЗЕЛЕНА" : "ЧЕРВОНА"} (${base.total} тестів)\n`);
  if (!base.ok) {
    lines.push(`\n⛔ Базова лінія червона — стенд НІЧОГО не доводить. Червоні: ${base.red.join(", ")}\n`);
  } else {
    lines.push(`\nМіграція під мутацією: \`${latestMig}\` (обрана так само, як її обирає сторож).\n`);
    lines.push(`\n| # | мутація | очікування | факт | вердикт |`);
    lines.push(`|---|---|---|---|---|`);
    for (const m of MUTATIONS) {
      const path = FILES[m.file];
      const src = readFileSync(path, "utf8");
      const edits = m.edits ?? [{ from: m.from, to: m.to }];
      let mutated = src, bad = "";
      for (const e of edits) {
        const n = mutated.split(e.from).length - 1;
        if (n !== 1) { bad = `ЯКІР НЕ УНІКАЛЬНИЙ (${n}): ${e.from.slice(0, 40)}…`; break; }
        mutated = mutated.replace(e.from, () => e.to);
      }
      if (bad) { lines.push(`| ${m.id} | ${m.what} | — | ${bad} | ⛔ відхилено |`); continue; }
      writeFileSync(path, mutated);
      const res = run();
      writeFileSync(path, src);
      const wantRed = !m.green;
      if (res.crashed) {
        // Прогін не відбувся — це НЕ «сторож спіймав», а зіпсована мутація.
        lines.push(`| ${m.id} | ${m.what} | ${wantRed ? "ЧЕРВОНЕ" : "ЗЕЛЕНЕ"} | прогін не відбувся | ⛔ мутація зламала збірку |`);
        continue;
      }
      const gotRed = !res.ok;
      // Для «червоних» мало покраснеть будь-чому: червоніти мусить НОВИЙ сторож.
      const heldByNew = !wantRed || res.redInNew.length > 0;
      const verdict = wantRed === gotRed
        ? (heldByNew ? "✅" : "⚠️ спіймав ЧУЖИЙ спек, не новий сторож")
        : "⛔ СТОРОЖ НЕ ТРИМАЄ";
      const fact = gotRed
        ? res.redInNew.concat(res.redInNew.length < res.red.length ? [`(+${res.red.length - res.redInNew.length} в іншому спеку)`] : [])
            .map((t) => (t.startsWith("(+") ? t : `«${t}»`)).join("; ")
        : "усе зелене";
      lines.push(`| ${m.id} | ${m.what} | ${wantRed ? "ЧЕРВОНЕ" : "ЗЕЛЕНЕ"} | ${fact} | ${verdict} |`);
    }
  }
} finally {
  restore();
  if (existsSync(REPORT)) unlinkSync(REPORT);
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nЗвіт: ${OUT}. Файли відновлено.`);
}
