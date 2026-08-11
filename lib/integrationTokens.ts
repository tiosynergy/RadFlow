/* ===== RadFlow — токени інтеграційного API (фаза 1) =====
   ЧИСТІ функції формату/хешу — спільна мова трьох місць:
     • lib/integrationAuth.ts (перевірка Bearer у роутах);
     • scripts/integration-admin-lib.mjs (генерація ключа власником) — мусить
       давати БІТ-В-БІТ той самий хеш (тест звіряє обидві реалізації);
     • integration_keys.key_hash у БД (sha256 hex, канон 0144).
   Секрет ключа ЦІЛИМ рядком (із префіксом 'rfk_') хешується sha256 → hex. */

import crypto from "crypto";

/** Формат токена: rfk_ + 48 hex (24 байти ентропії). */
export const TOKEN_RE = /^rfk_[0-9a-f]{48}$/;
/** Скільки символів токена зберігаємо як key_prefix (відображення/пошук). */
export const TOKEN_PREFIX_LEN = 12;

export function isIntegrationToken(token: string): boolean {
  return typeof token === "string" && TOKEN_RE.test(token);
}

/** sha256 hex ПОВНОГО рядка токена — значення integration_keys.key_hash. */
export function hashIntegrationToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokenPrefix(token: string): string {
  return token.slice(0, TOKEN_PREFIX_LEN);
}

/** Розбір заголовка Authorization → токен або null (без винятків). */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/.exec(header.trim());
  return m ? m[1] : null;
}
