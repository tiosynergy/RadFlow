/* RadFlow — чиста логіка адмін-CLI інтеграцій (фаза 1).
   БД не чіпає — її імпортують тести (tests/integrationAdmin.test.ts) і CLI
   (scripts/integration-admin.mjs, який безумовно виконує main() — канон
   проєкту: жодних main-guard по argv[1]).

   Формат токена/хешу МУСИТЬ біт-в-біт збігатися з lib/integrationTokens.ts —
   тест звіряє обидві реалізації на спільних векторах. */

import crypto from "node:crypto";

export const TOKEN_RE = /^rfk_[0-9a-f]{48}$/;
export const TOKEN_PREFIX_LEN = 12;
export const ALLOWED_SCOPES = ["slots:read", "appointments:read", "events:write"];

/** Новий секрет ключа: rfk_ + 48 hex (24 байти ентропії). Показується ОДИН раз. */
export function generateToken() {
  return "rfk_" + crypto.randomBytes(24).toString("hex");
}

/** sha256 hex ПОВНОГО рядка токена — integration_keys.key_hash. */
export function hashToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokenPrefix(token) {
  return token.slice(0, TOKEN_PREFIX_LEN);
}

/** Секрет вебхука: 64 hex (32 байти) — проходить CHECK length>=32 у 0145. */
export function generateWebhookSecret() {
  return crypto.randomBytes(32).toString("hex");
}

/** 'a,b , c' → масив валідних скоупів; невідомий скоуп → Error (fail-closed). */
export function parseScopes(csv) {
  const scopes = String(csv || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!scopes.length) throw new Error("порожній список скоупів");
  for (const s of scopes) {
    if (!ALLOWED_SCOPES.includes(s)) {
      throw new Error(`невідомий скоуп «${s}» (дозволені: ${ALLOWED_SCOPES.join(", ")})`);
    }
  }
  return [...new Set(scopes)];
}

/** URL вебхука: лише https (дзеркало CHECK-а integration_webhooks_url_chk). */
export function validateWebhookUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw new Error("невалідний URL");
  }
  if (u.protocol !== "https:") throw new Error("вебхук мусить бути https://");
  return u.toString();
}

export function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ""));
}

/** Розбір argv виду: <команда> --ключ значення … → { cmd, opts }. */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new Error(`очікував --опцію, отримав «${a}»`);
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      opts[key] = true; // прапорець без значення
    } else {
      opts[key] = next;
      i++;
    }
  }
  return { cmd: cmd || "help", opts };
}
