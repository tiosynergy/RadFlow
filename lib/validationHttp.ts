/* ===== RadFlow — межа API-роутів (zod → 400) =====
   Винесено з lib/validation.ts, бо тягне next/server: сам lib/validation.ts
   лишається чистим (його імпортують vitest-тести).

   Контракт помилок (рішення власника): користувачу — ЗАГАЛЬНЕ повідомлення,
   деталі (які поля не пройшли) — у лог сервера. Схема запиту назовні не світиться. */

import { NextResponse } from "next/server";
import type { z } from "zod";
import { INVALID_INPUT_MSG, logIssues } from "@/lib/validation";

type BodyOk<T> = { ok: true; data: T };
type BodyFail = { ok: false; res: NextResponse };

/**
 * Розбір і валідація JSON-тіла роута.
 * @param message  повідомлення користувачу (за замовчуванням загальне).
 *                 Роути з власним текстом (напр. /auth/login) передають своє —
 *                 воно не має розрізняти «немає такого логіна» і «не той пароль».
 */
export async function parseBody<S extends z.ZodTypeAny>(
  where: string,
  req: Request,
  schema: S,
  message: string = INVALID_INPUT_MSG
): Promise<BodyOk<z.infer<S>> | BodyFail> {
  const raw = await req.json().catch(() => ({}));
  return parseJson(where, raw, schema, message);
}

/**
 * Те саме, але тіло вже прочитане. Потрібно там, де роут має розрізняти
 * «ключ відсутній» і «ключ = null» — напр. room_ids (канон 0061):
 * відсутній → грант не чіпаємо; null → «усі кабінети»; [] → 400.
 */
export function parseJson<S extends z.ZodTypeAny>(
  where: string,
  raw: unknown,
  schema: S,
  message: string = INVALID_INPUT_MSG
): BodyOk<z.infer<S>> | BodyFail {
  const res = schema.safeParse(raw);
  if (!res.success) {
    logIssues(where, res.error);
    return { ok: false, res: NextResponse.json({ error: message }, { status: 400 }) };
  }
  return { ok: true, data: res.data };
}
