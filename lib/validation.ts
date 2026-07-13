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
import { normBuffer, normDur } from "@/lib/studies";

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

/** Реальний інстант (ISO). scheduled_at авторитетно перераховує тригер 0035 — тут лише формат. */
export const zIsoInstant = z
  .string()
  .min(1)
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), "Некоректна мітка часу");

export const zName = z.string().trim().min(1, "Вкажіть ПІБ").max(200);
export const zLogin = z.string().trim().min(1, "Вкажіть логін").max(64);
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

export const zPriority = z.enum(["cito", "urgent", "planned"]);
export const zQueueStatus = z.enum(["scheduled", "waiting", "in_progress", "done", "no_show", "cancelled", "not_held"]);
export const zCallStatus = z.enum(["not_called", "to_recall", "no_answer", "confirmed", "declined"]);

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
