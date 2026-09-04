/**
 * U-66 — правка картки пацієнта йде ЧЕРЕЗ RPC, а не одним UPDATE звідси.
 *
 * ЩО ТУТ НАСПРАВДІ. `realtime.apply_rls` у гілці UPDATE НЕ ріже `old_record`
 * до первинного ключа (у гілці DELETE ріже — прочитано з живого тіла на
 * проді), а кому доставляти вирішує НОВА версія рядка: і фільтр підписки
 * (`is_visible_through_filters(columns, …)`), і політика RLS (prepared
 * statement будується з `columns`). Тому UPDATE, який ВВОДИТЬ рядок у
 * видимість підписника, вручає йому стан, якого той не мав права читати.
 *
 * ⚠️ ЧОМУ САМЕ RPC, А НЕ ДВА ВИКЛИКИ З КОДУ. Це знахідка ревʼю пакета 29:
 * наївне «спершу дані, потім звʼязок» вірне лише коли старого направника
 * НЕМАЄ. При заміні R1 → R2 перший statement комітиться, поки `referrer_id`
 * ще R1, — і дані НОВОГО пацієнта їдуть СТАРОМУ направнику. Правильний
 * порядок ЗВУЖЕННЯ → ДАНІ → РОЗШИРЕННЯ потребує атомарності, а PostgREST дає
 * транзакцію на запит. Звідси функція БД (міграція 0176).
 *
 * ЩО ПЕРЕВІРЯЄТЬСЯ ТУТ. Не текст файла, а ПОВЕДІНКА: екшен викликається
 * по-справжньому, з двійником Supabase, який пише журнал ВИКЛИКІВ. Порядок
 * трьох statement-ів перевіряє не цей файл, а смоук міграції 0176 — там він
 * знімається з `audit_log`, тобто з факту, а не з наміру.
 *
 * ⚠️ Двійник записує виклик у момент AWAIT, а не в момент побудови, і копіює
 * аргументи. Перша редакція (пакет 29) писала намір і клала обʼєкт за
 * посиланням — ревʼю показало, що так сторож не відрізнив би запит, який
 * побудували й не відправили.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type RpcCall = { fn: string; args: Record<string, unknown> };
const rpcCalls: RpcCall[] = [];
const directUpdates: string[] = [];
/** Черга відповідей RPC: null = успіх за замовчуванням. */
let rpcReply: unknown = null;
let rpcError: { message: string; code?: string } | null = null;

const CLINIC = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ENTRY = "11111111-2222-4333-8444-555555555555";
const NEW_REF = "99999999-8888-4777-8666-555555555555";

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    /* ⚠️ Двійник ЗЛИЙ: будь-який `update` по бойовій таблиці — це те, що
       пакет саме прибрав, тож ми його НЕ реалізуємо мовчки, а записуємо і
       валимо тест нижче. */
    from: (table: string) => {
      const self: Record<string, unknown> = {};
      self.select = () => self;
      self.eq = () => self;
      self.maybeSingle = async () => ({
        data: { referrer_id: "r-old", clinic_id: CLINIC }, error: null,
      });
      self.update = () => { directUpdates.push(table); return self; };
      return self;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args: JSON.parse(JSON.stringify(args ?? {})) });
      if (rpcError) return { data: null, error: rpcError };
      return { data: rpcReply ?? { ok: true, changed: Object.keys(args ?? {}) }, error: null };
    },
  }),
}));
vi.mock("@/lib/importantEvents.server", () => ({ emitImportantEvent: async () => {} }));
vi.mock("@/lib/serverLog", () => ({ logError: () => {} }));

import { updatePatientDetails } from "@/app/queue/actions";

const PII = {
  patient_name: "Новий Пацієнт",
  patient_phone: "+380000000000",
  patient_dob: "1990-01-01",
  patient_sex: "f",
};

beforeEach(() => {
  rpcCalls.length = 0; directUpdates.length = 0;
  rpcReply = null; rpcError = null;
});

describe("U-66 — картка пацієнта правиться через RPC 0176", () => {
  it("жодного прямого UPDATE по queue_entries — рівно один виклик функції", async () => {
    const res = await updatePatientDetails(ENTRY, { ...PII, doctor: "Іваненко", referrer_id: NEW_REF });
    expect(res.ok, "екшен мусить відпрацювати успішно").toBe(true);

    expect(directUpdates, [
      "Правка поїхала прямим UPDATE-ом: новий направник отримає old_record із ПОПЕРЕДНІМ пацієнтом.",
      "Порядок ЗВУЖЕННЯ→ДАНІ→РОЗШИРЕННЯ тримає лише RPC 0176 (він же дає атомарність).",
    ].join(" ")).toEqual([]);

    expect(rpcCalls.map((c) => c.fn)).toEqual(["update_patient_details"]);
    expect(rpcCalls[0].args.p_id, "RPC мусить отримати ІДЕНТИФІКАТОР запису").toBe(ENTRY);
  });

  it("дані і звʼязок їдуть РІЗНИМИ аргументами, а не одним патчем", async () => {
    await updatePatientDetails(ENTRY, { ...PII, doctor: "Іваненко", referrer_id: NEW_REF });
    const a = rpcCalls[0].args as { p_data: Record<string, unknown>; p_referrer: Record<string, unknown> };

    /* Рівно ті чотири колонки, що подані. `patient_age` сюди НЕ входить — його
       рахує форма (`calcAge` у PatientEditModal) і в цій фікстурі його немає;
       у продовому патчі він є і поїде тим самим шляхом. */
    expect(Object.keys(a.p_data).sort(), "у p_data не повинно бути ні doctor, ні referrer_id")
      .toEqual(["patient_dob", "patient_name", "patient_phone", "patient_sex"]);
    expect(a.p_referrer, "p_referrer — нерозривна пара").toEqual({
      doctor: "Іваненко", referrer_id: NEW_REF,
    });
  });

  it("патч БЕЗ направника не чіпає звʼязок: p_referrer = null", async () => {
    /* Найчастіший стан прода: правлять телефон, направника не рухали. Тут
       `p_referrer: null` — не «порожня пара», інакше RPC зняв би звʼязок. */
    await updatePatientDetails(ENTRY, { ...PII });
    expect(rpcCalls[0].args.p_referrer).toBeNull();
  });

  it("зняття направника («— не вказано —») їде парою з двох null", async () => {
    await updatePatientDetails(ENTRY, { doctor: null, referrer_id: null });
    const a = rpcCalls[0].args as { p_data: Record<string, unknown>; p_referrer: unknown };
    expect(a.p_data).toEqual({});
    expect(a.p_referrer).toEqual({ doctor: null, referrer_id: null });
  });

  it("половина пари — відмова, а не тихий запис", async () => {
    /* `referrer_id` без `doctor` лишив би імʼя від ПОПЕРЕДНЬОГО направника,
       `doctor` без `referrer_id` — звʼязок від попереднього. Обидва розходження
       вже були в проді (с31, с43), тож пара перевіряється з ОБОХ боків. */
    const only1 = await updatePatientDetails(ENTRY, { ...PII, referrer_id: NEW_REF });
    expect(only1.ok).toBe(false);
    const only2 = await updatePatientDetails(ENTRY, { ...PII, doctor: "Хтось" });
    expect(only2.ok).toBe(false);
    expect(rpcCalls, "до RPC половина пари не має доходити взагалі").toEqual([]);
  });

  it("`ok:false` від функції читається як відмова доступу, а не як успіх", async () => {
    /* RPC на невидимий рядок НЕ кидає — віддає код. Якби екшен дивився лише на
       `error`, відмова мовчки зійшла б за успіх і форма закрилась би. */
    rpcReply = { ok: false, code: "forbidden" };
    const res = await updatePatientDetails(ENTRY, { ...PII });
    expect(res.ok).toBe(false);
    expect(res.ok === false ? res.code : "").toBe("forbidden");
  });

  it("відповідь без поля ok теж НЕ успіх (fail-closed)", async () => {
    rpcReply = {};
    const res = await updatePatientDetails(ENTRY, { ...PII });
    expect(res.ok).toBe(false);
  });
});
