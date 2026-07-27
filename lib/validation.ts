/* ===== RadFlow — валідація на межі (zod). Аудит M-12 =====

   Досі кожен Server Action і кожен API-роут «валідував» вручну: String(body.x || ""),
   Number(x), Array.isArray(...). Наслідки:
     • типи TS на межі нічого не гарантують — клієнт (або протухла вкладка, або
       curl) шле що завгодно, а TablesUpdate<...> у сигнатурі створює хибне відчуття
       безпеки (саме так через updatePatientDetails проходили status / room_id);
     • правила розсипані по файлах і РОЗЇЖДЖАЮТЬСЯ: "HH:MM" ніде не перевірявся,
       тож "8:5" доїжджав до БД, зберігався, але в сітку слотів (ключі "08:05") не
       потрапляв — запис-привид (M-1);
     • сирі помилки Postgres (імена колонок, констрейнтів, таблиць) летіли клієнту (M-14).

   Тут — ЄДИНЕ джерело примітивів і два хелпери межі:
     parseInput(schema, raw)  — для Server Actions (повертає { ok, data } | { ok:false, error, code })
     parseBody/parseJson      — для API-роутів; живуть у lib/validationHttp.ts
                                (окремий модуль: тягне next/server, а цей файл
                                імпортують vitest-тести)

   Контракт помилок (рішення власника): користувачу — ЗАГАЛЬНЕ повідомлення,
   деталі (які поля не пройшли) — у лог сервера. Схема запиту назовні не світиться.

   ВАЖЛИВО: zod тут перевіряє ФОРМУ і МЕЖІ, а нормалізацію чисел, як і раніше,
   робить normDur/normBuffer (кратність 5, клампінг у [5,480] / [0,15]) — щоб
   поведінка для легальних значень не змінилась, а сміття відсікалось. */

import { z } from "zod";
import { normalizeLogin, isValidLogin, LOGIN_HINT } from "@/lib/login";
import { hasBookableStudy, normBuffer, normDur } from "@/lib/studies";

/* ── Примітиви ─────────────────────────────────────────────────────────────── */

export const zUuid = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  "Некоректний ідентифікатор"
);

/** "YYYY-MM-DD" — і формат, і РЕАЛЬНІСТЬ дати ("2026-02-31" не пройде). */
export const zDateKey = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Некоректна дата")
  .refine((s) => {
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, "Некоректна дата");

/* "HH:MM" — рівно дві цифри, 00:00–23:59 (M-1). Раніше формат не перевірявся
   НІДЕ: scheduled_time — вільний text, set_scheduled_at (0035) конкатенує його в
   timestamptz, тож "8:5" ставав 08:05 у БД, але ключа "8:5" немає в сітці слотів
   → запис існує, а в сітці його не видно. */
export const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Некоректний час (HH:MM)");

/* Час СЛОТА запису — на сітці 5 хв (техаудит 2026-07-27, High-1). zTime лишається
   загальним (робочі години й перерви можуть бути будь-якими — їх НЕ звужуємо),
   а слот запису мусить збігатися з сіткою SlotPicker: '09:03', надісланий повз UI
   прямо в Server Action, створював би запис, якого немає в жодній клітинці сітки —
   він «є», займає час, але його не видно. Дзеркало в БД — тригер guard_slot_grid
   (0125). Крок = SLOT_STEP (lib/slots.ts) — міняти парою. */
export const zSlotTime = zTime.refine(
  (v) => Number(v.slice(3, 5)) % 5 === 0,
  "Час слота має бути кратним 5 хвилинам"
);

/** Реальний інстант (ISO). scheduled_at авторитетно перераховує тригер 0035 — тут лише формат. */
export const zIsoInstant = z
  .string()
  .min(1)
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), "Некоректна мітка часу");

export const zName = z.string().trim().min(1, "Вкажіть ПІБ").max(200);
/* 0124: логін — обовʼязковий атрибут КОЖНОГО акаунта й одна з двох форм входу.
   Нормалізуємо тут (trim + нижній регістр), щоб у БД потрапляла єдина форма:
   унікальність і резолв і так по lower(), а «Zast» проти «zast» у списках
   персоналу читається як два різні акаунти. Формат дзеркалить CHECK
   profiles_login_format_chk (0124) і lib/login.ts. */
export const zLogin = z
  .string()
  .transform((s) => normalizeLogin(s))
  .refine((s) => s.length > 0, "Вкажіть логін")
  .refine((s) => isValidLogin(s), LOGIN_HINT);
/** Пароль — той самий мінімум, що був у роутах (8 символів). */
export const zPassword = z.string().min(8, "Пароль мінімум 8 символів").max(200);

/* email/phone — той самий формат, що перевірявся вручну в роутах. */
export const zEmail = z
  .string()
  .trim()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Некоректний email")
  .transform((s) => s.toLowerCase());
export const zPhone = z.string().trim().min(1, "Вкажіть телефон").max(32);

/** Необовʼязковий рядок: "" / null / undefined → null; інакше trim + межа довжини. */
export const zOptText = (max = 500) =>
  z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => (typeof v === "string" ? v.trim() : ""))
    .pipe(z.string().max(max))
    .transform((v) => v || null);

/** Дата народження: "YYYY-MM-DD" або порожньо → null. Та сама строгість, що й у
    патчі пацієнта — інакше запис створювався б зі сміттям у patient_dob, а потім
    його не можна було б відредагувати (патч вимагає валідну дату). */
export const zOptDob = z
  .union([zDateKey, z.literal(""), z.null(), z.undefined()])
  .transform((v) => v || null);

/* Межі, які колись були лише в UI. Ліміти навмисно «медично щедрі»: мета — відсікти
   сміття (вік 5000, вага 9999), а не воювати з користувачем. Клієнтські інпути мають
   ті самі max, щоб людина бачила підказку в полі, а не загальний 400. */
export const PATIENT_AGE_MAX = 130;
export const PATIENT_WEIGHT_MAX = 400;
export const zOptAge = z.union([z.number().int().min(0).max(PATIENT_AGE_MAX), z.null(), z.undefined()]).transform((v) => v ?? null);
export const zOptWeight = z.union([z.number().finite().min(0).max(PATIENT_WEIGHT_MAX), z.null(), z.undefined()]).transform((v) => v ?? null);

/** Необовʼязковий email: "" → null. */
export const zOptEmail = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => (typeof v === "string" ? v.trim() : ""))
  .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Некоректний email")
  .transform((v) => (v ? v.toLowerCase() : null));

/** Тривалість дослідження: число в осяжних межах → normDur (кратно 5, [5,480]). */
export const zDuration = z
  .number()
  .finite()
  .positive("Некоректна тривалість")
  .max(600, "Некоректна тривалість")
  .transform((v) => normDur(v));

/** Буфер прибирання: normBuffer клампить у 0/5/10/15. */
export const zBuffer = z.number().finite().min(0).max(60).transform((v) => normBuffer(v));

/** Ціна в грн (ЦІЛЕ 0..1e6) АБО null («не задано» / «успадкувати»).
    ⚠️ БЕЗ z.coerce: `z.coerce.number()` робить Number(null) === 0, через що у
    `z.union([zCoercePrice, z.null()])` null-гілка НЕДОСЯЖНА — явний null
    перетворювався на ціну 0 і затирав реальні ціни (ревью 0116, Blocker B1).
    Для полів, де null значущий, — ТІЛЬКИ ця схема. */
export const PRICE_MAX = 1_000_000; // = CHECK services_price_chk (0107)
export const zPriceNullable = z.number().int().min(0).max(PRICE_MAX).nullable();

export const zPriority = z.enum(["cito", "urgent", "planned"]);
/* ДВІ РІЗНІ СХЕМИ, і плутати їх не можна (0078).

   zQueueStatus     — що клієнт має право ПОСТАВИТИ. 'needs_reschedule' сюди не
                      входить: цей статус означає «слот втрачено через операційну
                      затримку кабінету» і ставиться лише планом затримки (етап 3),
                      разом із записом у queue_delay_events.
                      ⚠️ Це НЕ інваріант: queue_set_status_rpc — SECURITY DEFINER,
                      відкрита для authenticated і приймає будь-яке значення enum.
                      Справжній гард ставиться в 0079 (raise у самій RPC). zod тут —
                      лише перший рубіж, не єдиний.

   zQueueStatusAny  — що можна ОЧІКУВАТИ/ПРОЧИТАТИ (expectedFrom, currentStatus).
                      Тут потрібні ВСІ значення: інакше запис у 'needs_reschedule'
                      неможливо повернути в чергу — будь-який клік по степперу
                      надсилає expectedFrom = поточний статус і падав би на
                      валідації входу («Некоректні дані запиту»). */
export const zQueueStatus = z.enum(["scheduled", "waiting", "in_progress", "done", "no_show", "cancelled", "not_held"]);
export const zQueueStatusAny = z.enum([
  "scheduled", "waiting", "in_progress", "done", "no_show", "cancelled", "not_held", "needs_reschedule",
]);
export const zCallStatus = z.enum(["not_called", "to_recall", "no_answer", "confirmed", "declined"]);

/* ===== 0078 — політика черги при затримці дослідження =====
   Межі ДУБЛЮЮТЬ CHECK у БД (clinics_*_chk). Це не надмірність: zod дає користувачу
   зрозумілу помилку в полі, CHECK — гарантію на випадок прямого API-виклику. */
export const zQueueDelayPolicy = z.enum(["manual", "cascade_shift", "reschedule_conflicts"]);
/** Поріг спрацювання сценарію (хв): кратний кроку сітки, 5..120. */
export const zOverlapThreshold = z.number().int().min(5).max(120)
  .refine((v) => v % 5 === 0, { message: "Поріг має бути кратним 5 хв" });
/** Стеля каскаду: захист від «зсунули 300 записів одним кліком». */
export const zMaxCascade = z.number().int().min(1).max(100);
/** Причина винятку графіка (0078): обовʼязкова і НЕ порожня — це аудит рішення людини. */
export const zExceptionReason = z.string().trim().min(3).max(500);
export const zExceptionKind = z.enum(["after_hours", "break"]);

/* studies (JSONB). Невідомі ключі zod ВІДКИДАЄ (strip) — у БД їде рівно те, що
   ми знаємо (частково закриває L-2: JSONB без валідації). */
export const zStudy = z.object({
  type: z.string().max(40).optional(),
  region: z.string().max(160).optional(),
  contrast: z.boolean().optional(),
  dur: z.number().finite().min(0).max(600).optional(),
  price: z.number().finite().min(0).max(1_000_000).nullable().optional(),
});
export const zStudies = z.array(zStudy).max(20, "Забагато досліджень в одному записі");

/** Склад для НОВОЇ записи / зміни складу: ті самі межі, що zStudies, ПЛЮС вимога
    ≥1 дослідження з каталожною модальністю (не порожній тип, не «Інше»/OTHER).
    Інакше modalityFromStudies мовчки класифікував би запис як MRI. DB-тригери
    (0088/0090) навмисно лишаються мʼякими до порожнього складу заради легасі —
    гард НОВИХ записів живе тут, на межі Server Action (додати параметр не можна). */
export const zStudiesRequired = zStudies.refine(hasBookableStudy, {
  message: "Додайте щонайменше одне дослідження з валідним типом",
});

/* room_ids гранта направника (канон 0061):
     null / відсутній  = УСІ кабінети центру;
     непорожній масив  = підмножина;
     ПОРОЖНІЙ масив    = помилка (а НЕ «усі»!) — саме так «зняти всі галочки»
                         колись ВІДКРИВАЛО доступ до всіх кабінетів. */
export const zRoomIdsGrant = z
  .union([z.array(zUuid), z.null(), z.undefined()])
  .refine((v) => !(Array.isArray(v) && v.length === 0), "Оберіть хоча б один кабінет (або залиште «усі кабінети»)")
  .transform((v) => (Array.isArray(v) ? Array.from(new Set(v)) : null));

/** Масовий список id (обдзвін): унікальні UUID, стеля — щоб один виклик не слав десятки тисяч id. */
export const MASS_UPDATE_CAP = 500;
export const zIdList = z
  .array(zUuid)
  .max(MASS_UPDATE_CAP, "Забагато записів за один раз")
  .transform((v) => Array.from(new Set(v)));

/* ── Межа: Server Actions ──────────────────────────────────────────────────── */

const INVALID_INPUT = "Некоректні дані запиту";

export const INVALID_INPUT_MSG = INVALID_INPUT;

export type ParseFail = { ok: false; error: string; code: "generic" };
export type ParseOk<T> = { ok: true; data: T };

/** Деталі — у лог сервера, користувачу — загальне повідомлення (рішення власника + M-14). */
export function logIssues(where: string, err: z.ZodError): void {
  const details = err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  console.warn(`[validation] ${where}: ${details}`);
}

/** Валідація входу Server Action. Повертає готову відповідь у контракті дій. */
export function parseInput<S extends z.ZodTypeAny>(
  where: string,
  schema: S,
  raw: unknown
): ParseOk<z.infer<S>> | ParseFail {
  const res = schema.safeParse(raw);
  if (!res.success) {
    logIssues(where, res.error);
    return { ok: false, error: INVALID_INPUT, code: "generic" };
  }
  return { ok: true, data: res.data };
}

/* Межа API-роутів (parseBody / parseJson) живе в lib/validationHttp.ts — вона
   тягне next/server, а цей модуль лишається чистим (його імпортують тести). */

/* ── M-14: сирі помилки БД не летять клієнту ───────────────────────────────── */

/**
 * Помилка Postgres → безпечний текст + запис у лог.
 * Раніше клієнту віддавали error.message: імена таблиць, колонок і констрейнтів
 * (розвідка схеми) + англомовний SQL посеред українського UI.
 * Наші власні тригери кидають вже локалізовані повідомлення — їх класифікують
 * викликачі (mapBookingError / classifyError) ДО цього хелпера; сюди доходить
 * лише те, що показувати не можна.
 */
export function safeDbError(where: string, err: { code?: string; message?: string } | null | undefined): string {
  console.error(`[db] ${where}: ${err?.code ?? ""} ${err?.message ?? ""}`.trim());
  return "Не вдалося виконати операцію — спробуйте ще раз";
}
