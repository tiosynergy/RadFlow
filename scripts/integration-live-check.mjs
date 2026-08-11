/* RadFlow — живий e2e інтеграційного API (фаза 1+2). Ганяє СПРАВЖНІ запити
   до задеплоєного застосунку реальним ключем: довідники, інкрементальний
   синк, увесь ланцюжок вхідних подій і межі контракту.

     node scripts/integration-live-check.mjs \
          --base https://rad-flow-tau.vercel.app \
          --token rfk_… [--entry <uuid тестового запису>] [--yes] [--read-only]

   Навіщо окремо від vitest: юніти перевіряють ЧИСТУ логіку, смоук — БД, а
   між ними лишається шар, який ніхто не перевіряв разом: деплой, ключ,
   скоупи, rate-limit, роут, RPC. Саме там ламається інтеграція на бойовому
   стенді, і ламається тихо (401/404 партнер бачить, а ви — ні).

   ⚠️ Записувальна частина РУХАЄ СТАТУС переданого запису до «done». Тому:
   --entry обов'язковий для неї, запис має бути у статусі scheduled, і
   потрібне явне --yes. Заводьте тестовий запис на майбутню дату й скасуйте
   його після прогону. Без --entry (або з --read-only) виконуються лише
   читання й перевірки меж контракту — вони нічого не змінюють.

   Канон Node-скриптів проєкту: main() виконується безумовно (жодних
   guard-ів по argv[1]), типи — через JSDoc. */

import { parseArgs, isUuid } from "./integration-admin-lib.mjs";

const UUID_ZERO = "00000000-0000-0000-0000-000000000000";

/** @type {{name: string, ok: boolean, note: string}[]} */
const results = [];
let failed = 0;

/** Крок: фіксуємо результат, але НЕ зупиняємо прогін — краще один звіт із
    усіма падіннями, ніж п'ять запусків по одному. */
function check(name, ok, note = "") {
  results.push({ name, ok: Boolean(ok), note });
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${note ? ` — ${note}` : ""}`);
}

/** @returns {Promise<{status: number, body: any, text: string}>} */
async function call(base, token, path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null; // не JSON — лишаємо text для діагностики
  }
  return { status: res.status, body, text };
}

/** Тіло події: source_event_id унікальний на КОЖЕН прогін, інакше другий
    запуск отримав би duplicate замість applied і звіт брехав би. */
function eventBody(runId, n, event, extra = {}) {
  return JSON.stringify({ event, source_event_id: `E2E-${runId}-${n}`, ...extra });
}

/** Копіювання з термінала регулярно тягне лапки, пробіли й BOM, а PowerShell
    ще й ріже рядок на переносі. Прибираємо це мовчки — і показуємо, ЩО саме
    дійшло, якщо все одно не збіглось (без цього діагноз — вгадування). */
function cleanArg(v) {
  return String(v ?? "").trim().replace(/^["']|["']$/g, "").replace(/^﻿/, "").trim();
}

/** Токен у логах — лише префікс: решта не має світитись у скріншотах. */
function maskToken(t) {
  return t.length <= 12 ? t : `${t.slice(0, 12)}…(${t.length} символів)`;
}

async function main() {
  const { opts } = parseArgs(["run", ...process.argv.slice(2)]);
  const base = cleanArg(opts.base).replace(/\/+$/, "");
  // Змінна середовища — обхід для оболонок, які ламають довгий аргумент.
  const token = cleanArg(opts.token === true ? "" : opts.token) || cleanArg(process.env.RADFLOW_TOKEN);
  const entry = opts.entry && opts.entry !== true ? cleanArg(opts.entry) : null;
  const readOnly = opts["read-only"] === true || !entry;

  if (!/^https:\/\//.test(base)) {
    console.error(`--base: https-URL застосунку, напр. https://rad-flow-tau.vercel.app (отримав «${base}»)`);
    process.exit(2);
  }
  if (!/^rfk_[0-9a-f]{48}$/i.test(token)) {
    console.error(
      `--token: очікую rfk_<48 hex> (видається key:create).\n` +
      `  отримав: ${token ? maskToken(token) : "порожньо"}\n` +
      `  довжина: ${token.length} (треба 52)\n` +
      (token && !token.startsWith("rfk_") ? "  немає префікса rfk_ — схоже, скопійовано не весь рядок\n" : "") +
      (/[^\x20-\x7E]/.test(token) ? "  у рядку є невидимі символи — вставте токен вручну\n" : "") +
      `  альтернатива, якщо оболонка ріже аргумент:\n` +
      `    $env:RADFLOW_TOKEN="rfk_…"; node scripts/integration-live-check.mjs --base … --entry … --yes`
    );
    process.exit(2);
  }
  if (entry && !isUuid(entry)) {
    console.error(`--entry: uuid запису черги (отримав «${entry}»)`);
    process.exit(2);
  }

  const runId = `${Date.now().toString(36)}`;
  console.log(`\nRadFlow live check → ${base}\nrun ${runId}${readOnly ? " (лише читання)" : ""}\n`);

  /* ── Довідники ─────────────────────────────────────────────────────────── */
  const rooms = await call(base, token, "/api/integrations/v1/rooms");
  check("GET /rooms → 200", rooms.status === 200, `статус ${rooms.status}`);
  const roomList = rooms.body?.rooms ?? [];
  check("/rooms віддає timezone клініки", typeof rooms.body?.timezone === "string",
    `timezone=${rooms.body?.timezone}`);
  check("/rooms віддає кабінети", roomList.length > 0, `кабінетів ${roomList.length}`);
  check("/rooms має paging.has_more", typeof rooms.body?.paging?.has_more === "boolean");

  const roomId = roomList[0]?.room_id;
  if (roomId) {
    const svc = await call(base, token, `/api/integrations/v1/services?room_id=${roomId}`);
    check("GET /services?room_id → 200", svc.status === 200, `статус ${svc.status}`);
    const list = svc.body?.services ?? [];

    /* Порожній зріз по кабінету — НЕ дефект: у каталозі клініки може не бути
       жодної послуги його модальності (RadFlow дозволяє заводити запис із
       довільним переліком досліджень, каталог із чергою не зчеплений). Раніше
       тут стояв жорсткий ассерт і він падав на живій клініці з двома МРТ-
       кабінетами й каталогом із CT/XRAY/MAMMO/US. Тому перевіряємо КАТАЛОГ
       клініки (base), а зріз по кабінету лише повідомляємо. */
    const baseSvc = await call(base, token, "/api/integrations/v1/services?room_id=base");
    check("GET /services?room_id=base → 200", baseSvc.status === 200, `статус ${baseSvc.status}`);
    const baseList = baseSvc.body?.services ?? [];
    check("послуги каталогу мають стабільний code",
      baseList.length === 0 || baseList.every((s) => Boolean(s.code)),
      baseList.length === 0
        ? "каталог клініки порожній — перевіряти нічого"
        : `базових послуг ${baseList.length}, приклад ${baseList[0].code}`);
    console.log(`  note  зріз по кабінету «${roomList[0]?.name}» (${roomList[0]?.modality}): ` +
      `послуг ${list.length}${list.length === 0
        ? " — у каталозі немає послуг цієї модальності (не помилка)"
        : `, приклад ${list[0].code}`}`);
    check("прайс НЕ віддається (комерційна інформація)",
      [...list, ...baseList].every((s) => !("price" in s) && !("price_uah" in s)));

    const badRoom = await call(base, token, `/api/integrations/v1/services?room_id=${UUID_ZERO}`);
    check("чужий/неіснуючий кабінет → 404", badRoom.status === 404, `статус ${badRoom.status}`);

    const slots = await call(base, token, `/api/integrations/v1/slots?room_id=${roomId}`);
    check("GET /slots → 200", slots.status === 200, `статус ${slots.status}`);
    check("/slots віддає дні з вільними вікнами", Array.isArray(slots.body?.days),
      `днів ${slots.body?.days?.length ?? 0}`);
  }

  /* ── Синк записів ──────────────────────────────────────────────────────── */
  const appts = await call(base, token, "/api/integrations/v1/appointments?limit=5");
  check("GET /appointments → 200", appts.status === 200, `статус ${appts.status}`);
  const sample = appts.body?.appointments?.[0];
  check("режим A: персональних даних у видачі немає",
    !sample || !["patient_name", "patient_phone", "patient_dob", "patient_email"]
      .some((k) => k in sample),
    sample ? `полів ${Object.keys(sample).length}` : "записів немає");

  /* ── Межі контракту (нічого не змінюють) ───────────────────────────────── */
  const target = entry ?? UUID_ZERO;
  const evPath = (id) => `/api/integrations/v1/appointments/${id}/events`;

  const clinical = await call(base, token, evPath(target), {
    method: "POST",
    body: eventBody(runId, "x1", "arrived", { report: "висновок дослідження" }),
  });
  check("клінічне поле в тілі → 400", clinical.status === 400,
    `статус ${clinical.status}`);
  check("400 називає зайве поле", String(clinical.body?.error ?? "").includes("report"),
    String(clinical.body?.error ?? "").slice(0, 80));

  const noTz = await call(base, token, evPath(target), {
    method: "POST",
    body: eventBody(runId, "x2", "arrived", { at: "2026-08-12T10:31:00" }),
  });
  check("at без часової зони → 400", noTz.status === 400, `статус ${noTz.status}`);

  const ghost = await call(base, token, evPath(UUID_ZERO), {
    method: "POST",
    body: eventBody(runId, "x3", "arrived"),
  });
  check("подія на неіснуючий запис → 404 not_found",
    ghost.status === 404 && ghost.body?.result === "not_found",
    `статус ${ghost.status}, result ${ghost.body?.result}`);

  const noAuth = await fetch(`${base}/api/integrations/v1/rooms`);
  check("без ключа → 401", noAuth.status === 401, `статус ${noAuth.status}`);

  /* ── Ланцюжок подій (ЗМІНЮЄ статус) ────────────────────────────────────── */
  if (!readOnly) {
    if (opts.yes !== true) {
      console.error("\nЗаписувальна частина змінить статус запису до «done». " +
        "Додайте --yes, коли передаєте ТЕСТОВИЙ запис.");
      process.exit(2);
    }

    const arrived = await call(base, token, evPath(entry), {
      method: "POST", body: eventBody(runId, 1, "arrived"),
    });
    check("arrived → 200 applied, статус waiting",
      arrived.status === 200 && arrived.body?.result === "applied"
        && arrived.body?.status === "waiting",
      `статус ${arrived.status}, result ${arrived.body?.result}, ` +
      `${arrived.body?.previous_status} → ${arrived.body?.status}`);

    const again = await call(base, token, evPath(entry), {
      method: "POST", body: eventBody(runId, 1, "arrived"),
    });
    check("повтор того самого source_event_id → 200 duplicate",
      again.status === 200 && again.body?.result === "duplicate",
      `статус ${again.status}, result ${again.body?.result}`);

    const reused = await call(base, token, evPath(entry), {
      method: "POST", body: eventBody(runId, 1, "started"),
    });
    check("той самий ключ під іншу подію → 409 reused",
      reused.status === 409 && reused.body?.result === "reused",
      `статус ${reused.status}, result ${reused.body?.result}`);

    const finished = await call(base, token, evPath(entry), {
      method: "POST", body: eventBody(runId, 2, "finished", { accession: `E2E-${runId}` }),
    });
    check("finished через ступеньку → 200 applied, waiting → done",
      finished.status === 200 && finished.body?.result === "applied"
        && finished.body?.status === "done",
      `result ${finished.body?.result}, ${finished.body?.previous_status} → ${finished.body?.status}`);
    check("accession прив'язано", finished.body?.accession_bound === true,
      `accession_bound=${finished.body?.accession_bound}`);

    const back = await call(base, token, evPath(entry), {
      method: "POST", body: eventBody(runId, 3, "arrived"),
    });
    check("рух назад → 200 noop, статус цілий",
      back.status === 200 && back.body?.result === "noop" && back.body?.status === "done",
      `result ${back.body?.result}, статус ${back.body?.status}`);
  }

  /* ── Підсумок ──────────────────────────────────────────────────────────── */
  console.log(`\n${failed === 0 ? "LIVE_OK" : "LIVE_FAIL"}: перевірок ${results.length}, ` +
    `провалено ${failed}`);
  if (!readOnly) {
    console.log("Тестовий запис лишився у статусі «Виконано» — скасуйте або видаліть його.");
  }
  process.exit(failed === 0 ? 0 : 1);
}

await main();
