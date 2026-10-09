/* ===== RadFlow — прапорець оператора платформи в app_metadata (0206, с84) =====

   Оператор платформи — акаунт `auth.users` БЕЗ профілю і без `user_role`
   (lib/platformAuth.ts). Для МАРШРУТИЗАЦІЇ в middleware (куди вести з `/`, з
   `/login`, з клінічних сторінок) бази під рукою немає — там лише `getUser()`.
   Тому сервер ставить акаунту `app_metadata.platform = 'operator'` (ставить
   ЛИШЕ service-role через auth.admin; клієнт може правити тільки user_metadata).

   ⚠️ ЦЕ НЕ АВТОРИЗАЦІЯ. Доступ до даних контуру дає РЯДОК `platform_operators`
   на сервері (`requirePlatformOperator`); прапорець лише вибирає стартовий екран.
   Розійшлись (прапорець є, рядка немає / вимкнений) — сторінка `/platform`
   і кожен роут відмовляють, а маршрут веде в тупик без даних.

   Файл без важких імпортів свідомо: middleware виконується в edge-рантаймі. */

export const PLATFORM_HOME = "/platform";
export const PLATFORM_CLAIM_KEY = "platform";
export const PLATFORM_CLAIM_VALUE = "operator";
/** Значення app_metadata для акаунта оператора (ставити при створенні/увімкненні). */
export const PLATFORM_APP_METADATA_ON = { [PLATFORM_CLAIM_KEY]: PLATFORM_CLAIM_VALUE } as const;
/** Значення app_metadata при вимкненні — ключ лишається, значення знімається. */
export const PLATFORM_APP_METADATA_OFF = { [PLATFORM_CLAIM_KEY]: null } as const;

type ClaimUser = { app_metadata?: Record<string, unknown> | null } | null | undefined;

/** Чи несе акаунт прапорець оператора (маршрутизація, не права). */
export function isOperatorByClaim(user: ClaimUser): boolean {
  const meta = user?.app_metadata;
  return !!meta && meta[PLATFORM_CLAIM_KEY] === PLATFORM_CLAIM_VALUE;
}
