/* RadFlow — зонд: чи приймає Google Calendar API назву зони `Europe/Kyiv`
   (Р74-3, передумова пакета 0202 — фаза 2 таймзон).

     node scripts/gcal-tz-probe.mjs --clinic <uuid> [--tz Europe/Kyiv]
          [--control Europe/Kiev] [--bogus Europe/Kyyiv] [--at 2026-09-17T10:00:00]
          [--keep] [--dry] --yes

   ЩО РОБИТЬ. Бере підключення клініки з google_calendar_connections
   (service_role, як роут sync-all), дістає refresh-токен із Vault тим самим
   RPC gcal_secret_get, оновлює access-токен ТІЄЮ САМОЮ google-auth-library,
   що й lib/googleCalendarClient.ts, і в обраний календар клініки вставляє
   ТРИ події тієї самої форми, що будує buildEventBody (LOCAL dateTime БЕЗ
   офсета + timeZone; канон wall-as-UTC 0035):
     • зонд      — timeZone з --tz (типово Europe/Kyiv);
     • контроль  — timeZone з --control (типово Europe/Kiev — те, що їде сьогодні);
     • негатив   — свідомо хибна назва (--bogus): МУСИТЬ дати 400. Зонд, який
                   неможливо почервонити, — не зонд.
   Кожну прийняту подію читає назад: Google повертає dateTime уже З ОФСЕТОМ —
   саме офсет доводить, що зону не просто «проковтнули», а зрозуміли правильно
   (зонд і контроль мусять дати ОДНАКОВИЙ офсет). Наприкінці події видаляються
   і видалення перевіряється читанням (410/404 або status=cancelled). --keep
   лишає їх у календарі для огляду власником — тоді прибрати руками.

   ЧОГО НЕ РОБИТЬ. БД не змінює. Дзеркало (sync) цих подій не бачить: воно
   фільтрує за privateExtendedProperty radflowClinicId, а зонд цього ключа
   не ставить (ставить radflowTzProbe) — інакше sync прибрав би їх як сироти.

   ПРАВИЛО ЛОГІВ (те саме, що в lib/googleCalendarClient.ts): жоден токен,
   секрет і сире тіло відповіді Google не друкується. Назовні йдуть лише
   HTTP-статус, id події, start/end/timeZone з відповіді та error.message
   Google (для негативу — це і є очікуваний доказ), обрізане до 160 символів.

   ПОТРІБНО в .env.local (лише на машині власника): NEXT_PUBLIC_SUPABASE_URL,
   SUPABASE_SERVICE_ROLE_KEY, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET
   (двох останніх там зазвичай немає — вони живуть у Vercel; refresh без
   client_secret неможливий). Відсутні — названі вголос, без значень.

   --dry: без мережі й БД — друкує тіла подій, які поїхали б. Для ревʼю.

   Канон Node-скриптів проєкту: main() виконується безумовно, типи — JSDoc. */

import { createClient } from "@supabase/supabase-js";
import { OAuth2Client } from "google-auth-library";
import { parseArgs, isUuid, loadEnvLocal } from "./integration-admin-lib.mjs";

const CAL_BASE = "https://www.googleapis.com/calendar/v3";
const FETCH_TIMEOUT_MS = 15_000;
const PROBE_KEY = "radflowTzProbe";

/** @type {{name: string, ok: boolean, note: string}[]} */
const results = [];
let failed = 0;

function check(name, ok, note = "") {
  results.push({ name, ok: Boolean(ok), note });
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${note ? ` — ${note}` : ""}`);
}

function usage(msg) {
  if (msg) console.error(`помилка: ${msg}\n`);
  console.error(
    "вжиток: node scripts/gcal-tz-probe.mjs --clinic <uuid> [--tz Europe/Kyiv] " +
      "[--control Europe/Kiev] [--bogus Europe/Kyyiv] [--at YYYY-MM-DDTHH:MM:SS] [--keep] [--dry] --yes"
  );
  process.exit(2);
}

/** Завтра о 10:00 за настінним часом — рядок БЕЗ офсета (форма buildEventBody). */
function defaultAt() {
  const t = new Date(Date.now() + 24 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T10:00:00`;
}

/** +N хвилин до локального рядка — та сама арифметика, що wallLocalEndOf. */
function plusMinutes(local, minutes) {
  const [datePart, timePart] = local.split("T");
  const [y, mo, d] = datePart.split("-").map(Number);
  const [h, mi, s] = timePart.split(":").map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s) + minutes * 60000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
}

/** Тіло події — та сама форма, що buildEventBody: dateTime без офсета + timeZone. */
function probeBody(kind, tz, startLocal) {
  return {
    summary: `RadFlow tz-probe [${kind}] ${tz}`,
    description: `Зонд Р74-3: перевірка назви зони «${tz}». Видаляється скриптом; якщо лишилась — можна видалити.`,
    start: { dateTime: startLocal, timeZone: tz },
    end: { dateTime: plusMinutes(startLocal, 15), timeZone: tz },
    transparency: "transparent",
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { [PROBE_KEY]: kind } },
  };
}

/** Офсет із dateTime відповіді Google ('2026-09-17T10:00:00+03:00' → '+03:00'). */
function offsetOf(dateTime) {
  const m = /([+-]\d{2}:\d{2}|Z)$/.exec(String(dateTime ?? ""));
  return m ? m[1] : "(без офсета)";
}

/** Витяг лише безпечних полів події з відповіді Google. */
function viewOf(json) {
  const o = json && typeof json === "object" ? json : {};
  return {
    id: typeof o.id === "string" ? o.id : null,
    status: typeof o.status === "string" ? o.status : null,
    start: o.start && typeof o.start === "object" ? { dateTime: o.start.dateTime ?? null, timeZone: o.start.timeZone ?? null } : null,
    end: o.end && typeof o.end === "object" ? { dateTime: o.end.dateTime ?? null, timeZone: o.end.timeZone ?? null } : null,
  };
}

/** Лише error.message з тіла помилки Google, обрізане; сире тіло далі не йде. */
function errorMessageOf(text) {
  try {
    const j = JSON.parse(text);
    const m = j?.error?.message;
    return typeof m === "string" ? m.slice(0, 160) : `(без message, ${String(text).length} байт)`;
  } catch {
    return `(не JSON, ${String(text).length} байт)`;
  }
}

async function calFetch(accessToken, path, init) {
  const res = await fetch(`${CAL_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, message: errorMessageOf(text) };
  }
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  return { ok: true, status: res.status, json };
}

async function insertProbe(accessToken, calendarId, body) {
  return calFetch(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function getEvent(accessToken, calendarId, eventId) {
  return calFetch(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
}

async function deleteEvent(accessToken, calendarId, eventId) {
  return calFetch(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
  });
}

async function main() {
  const { cmd, opts } = parseArgs(["probe", ...process.argv.slice(2)]);
  if (cmd !== "probe") usage();
  const clinicId = String(opts.clinic ?? "");
  const tz = String(opts.tz ?? "Europe/Kyiv");
  const control = String(opts.control ?? "Europe/Kiev");
  const bogus = String(opts.bogus ?? "Europe/Kyyiv");
  const at = String(opts.at ?? defaultAt());
  const keep = opts.keep === true;
  const dry = opts.dry === true;

  if (!isUuid(clinicId)) usage("--clinic мусить бути uuid клініки");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(at)) usage("--at у формі YYYY-MM-DDTHH:MM:SS (без офсета)");
  if (new Set([tz, control, bogus]).size !== 3) usage("--tz, --control і --bogus мусять відрізнятись");

  const kinds = [
    { kind: "probe", tz, expect: "accept" },
    { kind: "control", tz: control, expect: "accept" },
    { kind: "bogus", tz: bogus, expect: "reject" },
  ];

  if (dry) {
    console.log("dry: тіла подій, які поїхали б у Google (без мережі й БД):");
    for (const k of kinds) console.log(JSON.stringify(probeBody(k.kind, k.tz, at), null, 2));
    return;
  }
  if (opts.yes !== true) usage("зонд ПИШЕ в календар клініки (три події, потім видаляє) — потрібне явне --yes");

  loadEnvLocal();
  const need = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`бракує в .env.local: ${missing.join(", ")} (значення НЕ потрібно нікому показувати — лише покласти у файл на машині власника)`);
    process.exit(2);
  }

  // ── підключення клініки (service_role, як sync-all) ──
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: conn, error: connErr } = await admin
    .from("google_calendar_connections")
    .select("status, enabled, calendar_id, calendar_summary, access_role, refresh_secret_id")
    .eq("clinic_id", clinicId)
    .maybeSingle();
  if (connErr) throw new Error(`читання підключення: ${connErr.message}`);
  if (!conn) throw new Error("у клініки немає рядка google_calendar_connections");
  console.log(`календар: «${conn.calendar_summary ?? "?"}», status=${conn.status}, role=${conn.access_role ?? "?"}, enabled=${conn.enabled}`);
  if (conn.status !== "ready" || !conn.calendar_id || !conn.refresh_secret_id) {
    throw new Error(`підключення не ready або без календаря/секрета — зондувати нічого (status=${conn.status})`);
  }
  const calendarId = conn.calendar_id;

  // ── refresh → access (секрети живуть лише тут, у памʼяті) ──
  const { data: refreshToken, error: secErr } = await admin.rpc("gcal_secret_get", { p_id: conn.refresh_secret_id });
  if (secErr || !refreshToken) throw new Error(`читання секрета: ${secErr?.message ?? "порожньо"}`);
  const oauth = new OAuth2Client(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET);
  oauth.setCredentials({ refresh_token: refreshToken });
  let accessToken;
  try {
    const r = await oauth.getAccessToken();
    accessToken = r.token;
  } catch (e) {
    const status = e?.response?.status ?? "?";
    throw new Error(`refresh access-токена не вдався (HTTP ${status}); значення не друкуємо`);
  }
  if (!accessToken) throw new Error("refresh повернув порожній access-токен");

  // ── чим Google сам підписує зону календаря ──
  const cal = await calFetch(accessToken, `/calendars/${encodeURIComponent(calendarId)}`);
  check("calendars.get", cal.ok, cal.ok ? `timeZone календаря = ${cal.json?.timeZone ?? "(не вказано)"}` : `HTTP ${cal.status}: ${cal.message}`);

  // ── вставки ──
  /** @type {{kind: string, tz: string, id: string, ins: any}[]} */
  const inserted = [];
  const offsets = {};
  for (const k of kinds) {
    const r = await insertProbe(accessToken, calendarId, probeBody(k.kind, k.tz, at));
    if (k.expect === "reject") {
      check(`insert [${k.kind}] ${k.tz} → відхилено`, !r.ok && r.status === 400, r.ok ? `ПРИЙНЯТО (HTTP ${r.status}) — зонд не вміє червоніти` : `HTTP ${r.status}: ${r.message}`);
      if (r.ok && r.json?.id) inserted.push({ kind: k.kind, tz: k.tz, id: r.json.id, ins: viewOf(r.json) });
      continue;
    }
    if (!r.ok) {
      check(`insert [${k.kind}] ${k.tz}`, false, `HTTP ${r.status}: ${r.message}`);
      continue;
    }
    const v = viewOf(r.json);
    offsets[k.kind] = offsetOf(v.start?.dateTime);
    check(`insert [${k.kind}] ${k.tz}`, true, `HTTP ${r.status}, id=${v.id}, start=${v.start?.dateTime} tz=${v.start?.timeZone}, end=${v.end?.dateTime}`);
    if (v.id) inserted.push({ kind: k.kind, tz: k.tz, id: v.id, ins: v });
  }

  // ── читання назад ──
  for (const it of inserted) {
    const r = await getEvent(accessToken, calendarId, it.id);
    if (!r.ok) {
      check(`get [${it.kind}]`, false, `HTTP ${r.status}: ${r.message}`);
      continue;
    }
    const v = viewOf(r.json);
    const same = v.start?.dateTime === it.ins.start?.dateTime && v.start?.timeZone === it.ins.start?.timeZone;
    check(`get [${it.kind}]`, same && v.status === "confirmed", `status=${v.status}, start=${v.start?.dateTime} tz=${v.start?.timeZone}`);
  }

  // ── вердикт по офсетах ──
  if (offsets.probe && offsets.control) {
    check(
      `офсет [probe] ${tz} = офсет [control] ${control}`,
      offsets.probe === offsets.control && offsets.probe !== "(без офсета)",
      `${offsets.probe} vs ${offsets.control}`
    );
  } else {
    check("офсети зонда і контролю", false, "одна зі вставок не прийнята — порівнювати нічого");
  }

  // ── прибирання ──
  if (keep) {
    console.log(`--keep: ${inserted.length} подій лишено в календарі «${conn.calendar_summary}» — прибрати руками: ${inserted.map((i) => i.id).join(", ")}`);
  } else {
    for (const it of inserted) {
      const d = await deleteEvent(accessToken, calendarId, it.id);
      const gone = d.ok || d.status === 404 || d.status === 410;
      if (!gone) {
        check(`delete [${it.kind}]`, false, `HTTP ${d.status}: ${d.message} — прибрати руками: ${it.id}`);
        continue;
      }
      const g = await getEvent(accessToken, calendarId, it.id);
      const confirmedGone = (!g.ok && (g.status === 404 || g.status === 410)) || (g.ok && viewOf(g.json).status === "cancelled");
      check(`delete [${it.kind}] підтверджено читанням`, confirmedGone, g.ok ? `status=${viewOf(g.json).status}` : `HTTP ${g.status}`);
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  console.log(`\nпідсумок: ${okCount}/${results.length} ok, ${failed} FAIL — ${failed ? "GCAL_TZ_PROBE FAIL" : "GCAL_TZ_PROBE PASS"}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`зонд перервано: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
