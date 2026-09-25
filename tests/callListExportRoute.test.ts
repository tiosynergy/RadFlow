/* ===== POST /api/call-list/export — ПОВЕДІНКОВО (с80, Н-16) =====

   Роут викликається по-справжньому, за зразком tests/ceoExportRoute.test.ts:
     • ГЕЙТ — СПРАВЖНІЙ requireRole (lib/apiAuth.ts): сесію віддає двійник
       `auth.getUser`, профіль — таблиця profiles фікстури, ліміт — справжній
       rateLimitOk через RPC `rl_check`;
     • RLS-клієнт сесії — tests/fixtures/fakeSupabase.ts (фільтри, порядок,
       ліміт і стеля db-max-rows — по-справжньому, невідомий метод КИДАЄ). RLS у
       двійнику НЕМАЄ, і фікстура СВІДОМО містить рядки чужого центру, чужого дня
       і «чужих» статусів: область мусить тримати сам роут;
     • service-role — лише два RPC: `rl_check` і `emit_important_event`
       (СПРАВЖНІЙ emitImportantEvent разом із його PII-сторожем). Будь-яке
       `.from()` service-role — порушення: дані роут читає лише RLS-клієнтом.
   Імена й телефони — вигадані. */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { emptyDb, fakeAdminClient, type FakeDb, type Row } from "./fixtures/fakeSupabase";
import { callListExportErrorText, CALL_LIST_EXPORT_ERR, CALL_LIST_EXPORT_HEAD } from "@/lib/callListExport";

const C1 = "c1c1c1c1-0000-4000-8000-000000000001";   // наш центр
const C2 = "c2c2c2c2-0000-4000-8000-000000000002";   // чужий центр
const C3 = "c3c3c3c3-0000-4000-8000-000000000003";   // ненастроєний (майстер не пройдено)
const R1 = "a1a1a1a1-0000-4000-8000-000000000001";
const R2 = "a2a2a2a2-0000-4000-8000-000000000002";   // ВИМКНЕНИЙ кабінет C1
const R3 = "a3a3a3a3-0000-4000-8000-000000000003";   // кабінет C2

const ADMIN = "ad000000-0000-4000-8000-00000000000a";      // адмін C1
const REG = "ad000000-0000-4000-8000-00000000000c";        // реєстратор C1
const RAD = "ad000000-0000-4000-8000-00000000000d";        // радіолог C1
const REF = "f1000000-0000-4000-8000-000000000001";        // направник
const CEO = "ce000000-0000-4000-8000-000000000001";        // керівник
const ADMIN_NOCLINIC = "ad000000-0000-4000-8000-00000000000f";
const REG_NEW = "ad000000-0000-4000-8000-000000000010";    // реєстратор ненастроєного C3
const ADMIN_C2 = "ad000000-0000-4000-8000-000000000011";   // адмін чужого центру
const GHOST = "99990000-0000-4000-8000-000000000001";      // сесія є, профілю немає

const DAY = "2026-09-26";

/* ---------- двійники ---------- */

const rls: FakeDb = emptyDb();
const who: { user: { id: string } | null } = { user: { id: ADMIN } };
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const adminViolations: string[] = [];
const logs: Array<Record<string, unknown>> = [];
const rl = { allow: true };
const journal: { error: { message: string; code?: string } | null } = { error: null };
/** Вклинитись перед N-м `from(table)` роуту — напр. між сторінками читання. */
const hooks: { onFrom?: (table: string, n: number) => void } = {};
const fromCount: Record<string, number> = {};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = fakeAdminClient(rls);
    return {
      auth: { getUser: async () => ({ data: { user: who.user } }) },
      from: (t: string) => {
        const n = (fromCount[t] = (fromCount[t] ?? 0) + 1);
        hooks.onFrom?.(t, n);
        return c.from(t);
      },
    };
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  isAdminConfigured: () => true,
  createAdminClient: () => ({
    from: (t: string) => {
      adminViolations.push(t);
      throw new Error(`service-role читає «${t}» — роут експорту мусить читати RLS-клієнтом сесії`);
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      /* Журнал «повільний», як мережа (L-2 с79): виклик записується ПІСЛЯ паузи,
         тож емісія без await (fire-and-forget) почервонить тести подій. */
      if (fn === "emit_important_event") await new Promise((r) => setTimeout(r, 20));
      rpcCalls.push({ fn, args: JSON.parse(JSON.stringify(args ?? {})) });
      if (fn === "rl_check") return { data: rl.allow, error: null };
      if (fn === "emit_important_event") return journal.error ? { data: null, error: journal.error } : { data: "ev", error: null };
      throw new Error("невідомий RPC service-role: " + fn);
    },
  }),
}));
vi.mock("@/lib/serverLog", () => ({ logError: (e: Record<string, unknown>) => { logs.push(e); } }));

const { POST } = await import("@/app/api/call-list/export/route");

/* ---------- фікстура ---------- */

const q = (
  id: string, clinic: string, room: string | null, date: string, time: string | null, status: string,
  name: string, phone: string | null, studies: unknown[], call: string | null, callNote: string | null, note: string | null = null
): Row => ({
  id, clinic_id: clinic, room_id: room, scheduled_date: date, scheduled_time: time, status,
  patient_name: name, patient_phone: phone, studies, call_status: call, call_note: callNote, note,
});
const KNEE = [{ type: "МРТ", region: "Коліно" }];
const HEAD_CONTRAST = [{ type: "МРТ", region: "Голова", contrast: true }, { type: "КТ", region: "Контраст ОГК", contrast: true }];
/** Усі ПІБ і телефони фікстури — для перевірки «жодного в журналі й логах». */
const PII = ["Тестенко Олена", "Вигаданий Петро", "Уявна Марія", "Чужий Пацієнт", "Інший День", "Виконаний Запис",
  "Скасований Запис", "Без Часу", "Формула Тест", "+380670000001", "+380670000002", "+380670000003"];

beforeEach(() => {
  who.user = { id: ADMIN };
  rl.allow = true;
  journal.error = null;
  rpcCalls.length = 0; adminViolations.length = 0; logs.length = 0;
  rls.errors = {}; rls.errorsAfter = {}; rls.seen = {}; rls.queries = [];
  rls.maxRows = 1000;   // стеля db-max-rows PostgREST — у КОЖНОМУ тесті, як на проді
  rls.project = true;   // лише вибрані колонки, як PostgREST
  hooks.onFrom = undefined;
  for (const k of Object.keys(fromCount)) delete fromCount[k];
  rls.tables = {
    profiles: [
      { id: ADMIN, clinic_id: C1, role: "admin" },
      { id: REG, clinic_id: C1, role: "registrar" },
      { id: RAD, clinic_id: C1, role: "radiologist" },
      { id: REF, clinic_id: null, role: "referrer" },
      { id: CEO, clinic_id: null, role: "ceo" },
      { id: ADMIN_NOCLINIC, clinic_id: null, role: "admin" },
      { id: REG_NEW, clinic_id: C3, role: "registrar" },
      { id: ADMIN_C2, clinic_id: C2, role: "admin" },
    ],
    clinics: [
      { id: C1, name: "Центр А", configured_at: "2026-01-01T00:00:00Z" },
      { id: C2, name: "Центр Б", configured_at: "2026-01-01T00:00:00Z" },
      { id: C3, name: "Новий центр", configured_at: null },
    ],
    rooms: [
      { id: R1, clinic_id: C1, name: "МРТ-1", active: true },
      { id: R2, clinic_id: C1, name: "КТ-1", active: false },   // ВИМКНЕНИЙ — назва в CSV однаково потрібна
      { id: R3, clinic_id: C2, name: "Чужий кабінет", active: true },
    ],
    queue_entries: [
      /* id «e0» — НАВМИСНО менший за e1/e2, хоча час пізніший (ревʼю с80, M-2): у
         фікстурі порядок id не мусить збігатися з порядком часу, інакше знята
         сортировка роуту лишалась би зеленою. */
      q("e0", C1, R1, DAY, "11:00", "waiting", "Уявна Марія", "+380670000003", KNEE, "to_recall", "після 14:00; уточнити"),
      q("e1", C1, R1, DAY, "09:00", "scheduled", "Тестенко Олена", "+380670000001", KNEE, "confirmed", null),
      q("e2", C1, R2, DAY, "09:00", "scheduled", "Вигаданий Петро", "+380670000002", HEAD_CONTRAST, null, "не бере\nслухавку"),
      q("e4", C2, R3, DAY, "10:00", "scheduled", "Чужий Пацієнт", null, KNEE, "confirmed", null),          // чужий центр
      q("e5", C1, R1, "2026-09-27", "10:00", "scheduled", "Інший День", null, KNEE, null, null),          // інший день
      q("e6", C1, R1, DAY, "08:00", "done", "Виконаний Запис", null, KNEE, "confirmed", null),           // не той статус
      q("e7", C1, R1, DAY, "08:30", "cancelled", "Скасований Запис", null, KNEE, "declined", null),      // не той статус
      q("e8", C1, null, DAY, null, "scheduled", "Без Часу", null, [], "no_answer", null, "Консультація"), // без часу й кабінету
    ],
  };
});

afterEach(() => {
  expect(adminViolations, "service-role читав таблиці — межа має лишатися на RLS").toEqual([]);
});

/* ---------- виклик і розбір ---------- */

async function exportCsv(body: unknown, raw?: string) {
  const res = await POST(new Request("https://x.test/api/call-list/export", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: raw ?? JSON.stringify(body),
  }));
  /* ⚠️ Не res.text(): декодер Fetch ЗРІЗАЄ BOM, і перевірка BOM була б сліпою. */
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) };
}

/** Мінімальний розбір CSV: лапки, подвоєні лапки, `;` і перенос рядка. */
function parseCsv(text: string): string[][] {
  expect(text.charCodeAt(0), "немає BOM — Excel прочитає кирилицю як cp1251").toBe(0xfeff);
  const s = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ";") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows;
}
const dataRows = (text: string) => parseCsv(text).slice(1);

const exportEvents = () => rpcCalls.filter((c) => c.fn === "emit_important_event" && c.args.p_event_type === "patient_data.exported").map((c) => c.args);
const readQueue = () => (rls.queries ?? []).some((x) => x.table === "queue_entries");
const noPiiAnywhere = () => {
  const blob = JSON.stringify(rpcCalls) + JSON.stringify(logs);
  for (const p of PII) expect(blob.includes(p), `ПДн «${p}» потрапили в журнал або лог`).toBe(false);
};

/* =================================================================== */

describe("гейт: сесія, ліміт, роль, центр — fail-closed", () => {
  it("без сесії — 401, у базу не ходили", async () => {
    who.user = null;
    const r = await exportCsv({ date: DAY });
    expect(r.status).toBe(401);
    expect(readQueue()).toBe(false);
    expect(exportEvents()).toEqual([]);
  });

  it("ліміт — 10 файлів за 10 хв на користувача, власний ключ; понад — 429, черга не читалась", async () => {
    rl.allow = false;
    const r = await exportCsv({ date: DAY });
    expect(r.status).toBe(429);
    const calls = rpcCalls.filter((c) => c.fn === "rl_check");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ p_key: "call_list_export:" + ADMIN, p_max: 10, p_window_seconds: 600 });
    expect(readQueue()).toBe(false);
    expect(exportEvents()).toEqual([]);
  });

  it.each([
    ["радіолог свого ж центру", RAD],
    ["направник", REF],
    ["керівник (CEO)", CEO],
  ])("%s — 403: сторінки обдзвону він не бачить, файла теж", async (_label, uid) => {
    who.user = { id: uid };
    const r = await exportCsv({ date: DAY });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text).error).toBe("Недостатньо прав для експорту");
    expect(readQueue(), "до відмови читали записи черги").toBe(false);
    expect(exportEvents()).toEqual([]);
  });

  it("радіолог із центром — відмова ще й у журнал центру (access.denied, як будь-який чужий роут)", async () => {
    who.user = { id: RAD };
    await exportCsv({ date: DAY });
    const denied = rpcCalls.filter((c) => c.fn === "emit_important_event" && c.args.p_event_type === "access.denied");
    expect(denied).toHaveLength(1);
    expect(denied[0].args).toMatchObject({ p_clinic_id: C1, p_actor_id: RAD, p_details: { path: "/api/call-list/export", reason: "forbidden" } });
  });

  it("адмін без центру — 403, черга не читалась", async () => {
    who.user = { id: ADMIN_NOCLINIC };
    const r = await exportCsv({ date: DAY });
    expect(r.status).toBe(403);
    expect(readQueue()).toBe(false);
  });

  it("сесія без профілю — 403", async () => {
    who.user = { id: GHOST };
    const r = await exportCsv({ date: DAY });
    expect(r.status).toBe(403);
    expect(readQueue()).toBe(false);
  });

  it("реєстратор НЕНАСТРОЄНОГО центру — 403, як і /setup на сторінці; черга не читалась", async () => {
    who.user = { id: REG_NEW };
    const r = await exportCsv({ date: DAY });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text).error).toBe("Спершу завершіть налаштування центру");
    expect(readQueue()).toBe(false);
    expect(logs.some((l) => l.event === "access.denied" && l.errorCode === "clinic_not_configured")).toBe(true);
  });

  it("центр, якого сесія не прочитала, — 403 (fail-closed), а не файл", async () => {
    rls.tables.clinics = rls.tables.clinics.filter((c) => c.id !== C1);
    const r = await exportCsv({ date: DAY });
    expect(r.status).toBe(403);
    expect(readQueue()).toBe(false);
    expect(logs.some((l) => l.event === "access.denied" && l.errorCode === "clinic_unreadable")).toBe(true);
  });

  it("реєстратор свого центру — пускає", async () => {
    who.user = { id: REG };
    const r = await exportCsv({ date: DAY });
    expect(r.status).toBe(200);
    expect(dataRows(r.text)).toHaveLength(4);
  });
});

describe("тіло: лише день, strict", () => {
  it.each([
    ["немає дати", {}],
    ["формат не YYYY-MM-DD", { date: "2026-9-26" }],
    ["неіснуючий день", { date: "2026-02-31" }],
    ["зайвий ключ центру", { date: DAY, clinicId: C2 }],
    ["дата — не рядок", { date: 20260926 }],
  ])("%s — 400, черга не читалась", async (_label, body) => {
    const r = await exportCsv(body);
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text).error).toBe("Некоректний запит експорту");
    expect(readQueue()).toBe(false);
    expect(exportEvents()).toEqual([]);
  });

  it("не JSON — 400", async () => {
    const r = await exportCsv(null, "не json");
    expect(r.status).toBe(400);
    expect(readQueue()).toBe(false);
  });

  it("центр береться з СЕСІЇ: адмін чужого центру отримує СВІЙ день, рядків C1 немає", async () => {
    who.user = { id: ADMIN_C2 };
    const r = await exportCsv({ date: DAY });
    expect(r.status).toBe(200);
    const rows = dataRows(r.text);
    expect(rows.map((x) => x[2])).toEqual(["Чужий Пацієнт"]);
    expect(exportEvents().map((e) => e.p_clinic_id)).toEqual([C2]);
  });
});

describe("файл: область, порядок, колонки", () => {
  it("лише свій центр, лише цей день, лише scheduled/waiting; порядок — за часом, рівні — за id, без часу — в кінці", async () => {
    const r = await exportCsv({ date: DAY });
    expect(r.status).toBe(200);
    const all = parseCsv(r.text);
    expect(all[0]).toEqual([...CALL_LIST_EXPORT_HEAD]);
    expect(all.slice(1).map((x) => x[2])).toEqual(["Тестенко Олена", "Вигаданий Петро", "Уявна Марія", "Без Часу"]);
    // Фільтри — у ЗАПИТІ, а не лише на виході (двійник без RLS: інакше пройшов би чужий центр).
    const seen = rls.seen.queue_entries as { filters: string[] };
    expect(seen.filters).toEqual(expect.arrayContaining(["eq:clinic_id", "eq:scheduled_date", "in:status"]));
  });

  it("колонки: дата, час, ПІБ, телефон, процедура, кабінет (і вимкнений), підпис статусу, нотатка", async () => {
    const r = await exportCsv({ date: DAY });
    const rows = dataRows(r.text);
    /* Телефон з «+» — з апострофом: провідний «+» Excel читає як початок виразу
       (цифровий номер — як ЧИСЛО: до с80 «+380670000001» ставав 3,8E+11), а
       номер користувач вводить довільно (zPhone без шаблону, до 32 символів) —
       «+HYPERLINK(…)» у полі телефону — реальний вектор. Цифри тепер цілі, а
       видимий апостроф — названа ціна (docs/audit/PR-s80-call-list-export.md §3). */
    expect(rows[0]).toEqual([DAY, "09:00", "Тестенко Олена", "'+380670000001", "МРТ · Коліно", "МРТ-1", "Підтверджено", ""]);
    // Контраст: «з контрастом» лише там, де назва сама його не каже; вимкнений кабінет — з назвою;
    // порожній статус — «Ще не дзвонили»; перевод рядка в нотатці — пробіл (один запис = один рядок файлу).
    expect(rows[1]).toEqual([DAY, "09:00", "Вигаданий Петро", "'+380670000002", "МРТ · Голова з контрастом + КТ · Контраст ОГК", "КТ-1", "Ще не дзвонили", "не бере слухавку"]);
    // `;` усередині клітинки — законний (клітинка в лапках), не ріже колонку.
    expect(rows[2]).toEqual([DAY, "11:00", "Уявна Марія", "'+380670000003", "МРТ · Коліно", "МРТ-1", "Передзвонити", "після 14:00; уточнити"]);
    /* Без досліджень — «—», як на дошці (ревʼю с80, L-2): вільний текст `note`
       бронювання у файл НЕ йде, хоча в рядку він є («Консультація»). Без кабінету
       і без часу — порожньо. */
    expect(rows[3]).toEqual([DAY, "", "Без Часу", "", "—", "", "Не відповідає", ""]);
    expect(r.text).not.toContain("Консультація");
  });

  it("формули екрановано: ПІБ, телефон, нотатка з = + - @ TAB CR — з апострофом", async () => {
    rls.tables.queue_entries = [
      q("f1", C1, R1, DAY, "09:00", "scheduled", "=HYPERLINK(\"http://x\";\"клік\")", "+380670000001", KNEE, null, "@SUM(1)"),
      q("f2", C1, R1, DAY, "09:05", "scheduled", "Формула Тест", "-1+1", KNEE, null, "\t=1+1"),
      q("f3", C1, R1, DAY, "09:10", "scheduled", "Формула Тест", null, KNEE, null, "\r\n=1+1"),
    ];
    const r = await exportCsv({ date: DAY });
    const rows = dataRows(r.text);
    expect(rows[0][2]).toBe("'=HYPERLINK(\"http://x\";\"клік\")");
    expect(rows[0][3]).toBe("'+380670000001");   // телефон з «+» — теж формула для Excel
    expect(rows[0][7]).toBe("'@SUM(1)");
    expect(rows[1][3]).toBe("'-1+1");
    expect(rows[1][7]).toBe("' =1+1");   // провідний TAB: апостроф першим, сам TAB — пробіл (L-1 с80)
    expect(rows[2][7]).toBe("' =1+1");
  });

  /* Ревʼю с80, L-1 — замір у LibreOffice: файл, відкритий із КОМОЮ як роздільником
     (наш — `;`) і з «Evaluate formulas», губив межі лапок, і хвіст ПІБ після коми
     ставав живою формулою. ПІБ і телефон вводить і направник — зовнішня сторона. */
  it("знак формули після коми всередині ПІБ/телефону/нотатки — теж з апострофом", async () => {
    rls.tables.queue_entries = [
      q("k1", C1, R1, DAY, "09:00", "scheduled", "Іванов,=2+3", "+380670000001, +380670000002", KNEE, null, "дзвонити,\t@SUM(1)"),
    ];
    const r = await exportCsv({ date: DAY });
    const row = dataRows(r.text)[0];
    expect(row[2]).toBe("Іванов,'=2+3");
    expect(row[3]).toBe("'+380670000001, '+380670000002");
    expect(row[7]).toBe("дзвонити, '@SUM(1)");
  });

  it("заголовки: text/csv, імʼя файлу з дня, no-store, число рядків", async () => {
    const r = await exportCsv({ date: DAY });
    expect(r.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(r.headers.get("Content-Disposition")).toBe(`attachment; filename="call-list-${DAY}.csv"`);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(r.headers.get("X-Export-Rows")).toBe("4");
  });

  it("порожній день — лише заголовок, події в журналі немає, кабінети не читались", async () => {
    const r = await exportCsv({ date: "2026-10-10" });
    expect(r.status).toBe(200);
    expect(parseCsv(r.text)).toEqual([[...CALL_LIST_EXPORT_HEAD]]);
    expect(r.headers.get("X-Export-Rows")).toBe("0");
    expect(exportEvents()).toEqual([]);
    expect((rls.queries ?? []).some((x) => x.table === "rooms")).toBe(false);
  });
});

describe("сторінки під стелею db-max-rows (урок M-1 с79)", () => {
  const bulk = (n: number, prefix = "b") =>
    Array.from({ length: n }, (_, i) => {
      const id = `${prefix}${String(i).padStart(5, "0")}`;
      const t = String(8 + Math.floor(i / 60) % 12).padStart(2, "0") + ":" + String((i % 12) * 5).padStart(2, "0");
      return q(id, C1, R1, DAY, t, "scheduled", "Пацієнт " + i, null, KNEE, null, null);
    });

  it("2500 записів дня за стелі 1000 — у файлі всі 2500, жодного дубля", async () => {
    rls.tables.queue_entries = bulk(2500);
    const r = await exportCsv({ date: DAY });
    expect(r.status).toBe(200);
    const rows = dataRows(r.text);
    expect(rows).toHaveLength(2500);
    expect(new Set(rows.map((x) => x[2])).size).toBe(2500);
    expect((rls.queries ?? []).filter((x) => x.table === "queue_entries").length).toBeGreaterThanOrEqual(3);
    expect(exportEvents()[0].p_details).toEqual({ source: "call_list", rows: 2500, format: "csv", scheduledDate: DAY });
  });

  it("запис, скасований МІЖ сторінками, не забирає із собою сусіда (keyset, а не offset)", async () => {
    rls.tables.queue_entries = bulk(1500);
    hooks.onFrom = (t, n) => {
      if (t === "queue_entries" && n === 2) {
        // Між першою і другою сторінкою скасували запис із першої сторінки.
        const row = rls.tables.queue_entries.find((x) => x.id === "b00010");
        if (row) row.status = "cancelled";
      }
    };
    const r = await exportCsv({ date: DAY });
    const names = new Set(dataRows(r.text).map((x) => x[2]));
    // Вже прочитаний b00010 лишається (снапшоту між сторінками немає), а b01000 — перший другої сторінки — на місці.
    expect(names.has("Пацієнт 1000")).toBe(true);
    expect(names.size).toBe(1500);
  });

  it("зламана стеля сервера (по 1 рядку) — запобіжник MAX_PAGES: 500 і слід, а не тихо обрізаний файл", async () => {
    rls.tables.queue_entries = bulk(70);
    rls.maxRows = 1;
    const r = await exportCsv({ date: DAY });
    expect(r.status).toBe(500);
    expect(JSON.parse(r.text).error).toBe(CALL_LIST_EXPORT_ERR);
    expect(logs.some((l) => l.event === "call_list.export_failed" && l.errorCode === "pagination_overflow")).toBe(true);
    expect(exportEvents()).toEqual([]);
  });
});

describe("журнал — подія patient_data.exported, fail-OPEN, без ПДн", () => {
  it("одна подія в журнал центру з РЯДКІВ: число рядків, джерело call_list, формат csv, актор — сесія", async () => {
    const r = await exportCsv({ date: DAY });
    expect(r.status).toBe(200);
    const ev = exportEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      p_clinic_id: C1, p_actor_id: ADMIN, p_event_type: "patient_data.exported",
      p_entity_type: "staff", p_entity_id: ADMIN,
    });
    // details — рівно чотири ключі (день файлу — ревʼю с80, L-3), жодного зайвого.
    expect(ev[0].p_details).toEqual({ source: "call_list", rows: 4, format: "csv", scheduledDate: DAY });
    noPiiAnywhere();
  });

  it("журнал впав — файл однаково віддано, збій не мовчить (important_event.write_failed)", async () => {
    journal.error = { message: "boom", code: "XX000" };
    const r = await exportCsv({ date: DAY });
    expect(r.status).toBe(200);
    expect(dataRows(r.text)).toHaveLength(4);
    expect(logs.some((l) => l.event === "important_event.write_failed")).toBe(true);
    noPiiAnywhere();
  });

  it.each([
    ["clinics"],
    ["queue_entries"],
    ["rooms"],
  ])("збій читання «%s» — 500 загальною фразою, слід без ПДн, події немає", async (table) => {
    rls.errors[table] = { message: "permission denied for table " + table };
    const r = await exportCsv({ date: DAY });
    expect(r.status).toBe(500);
    expect(JSON.parse(r.text).error).toBe(CALL_LIST_EXPORT_ERR);
    expect(logs.some((l) => l.event === "call_list.export_failed" && String(l.message).startsWith("step=" + table))).toBe(true);
    expect(exportEvents()).toEqual([]);
    noPiiAnywhere();
  });
});

describe("текст відмови для тосту (callListExportErrorText)", () => {
  it("401 — сесія скінчилась (повтор не допоможе); 429 — гальмо; 403/400 — безпечна фраза роуту; решта — загальна", () => {
    expect(callListExportErrorText(401, { error: "Не авторизовано" })).toBe("Сесія завершилась — увійдіть знову");
    expect(callListExportErrorText(429, null)).toMatch(/Забагато вивантажень/);
    expect(callListExportErrorText(403, { error: "Спершу завершіть налаштування центру" })).toBe("Спершу завершіть налаштування центру");
    expect(callListExportErrorText(403, null)).toBe("Недостатньо прав для експорту");
    expect(callListExportErrorText(400, { error: "Некоректний запит експорту" })).toBe("Некоректний запит експорту");
    expect(callListExportErrorText(403, { error: "x".repeat(161) })).toBe("Недостатньо прав для експорту");
    expect(callListExportErrorText(500, { error: "stack trace…" })).toBe(CALL_LIST_EXPORT_ERR);
  });
});
