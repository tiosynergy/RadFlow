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

/** Скоупи «звичайного» партнера: читає розклад і записи, шле статуси.
    Явний список, а не ALLOWED_SCOPES: коли з'явиться четвертий скоуп, він не
    має тихо потрапити всім партнерам. */
export const PARTNER_SCOPES = ["appointments:read", "slots:read", "events:write"];

/** Вивід перенаправлено (у файл, у пайп), а не в термінал?
    11.08.2026 саме так секрети й поїхали в публічний репозиторій: вивід
    key:create зберегли у файл поруч із проєктом. Тому секрети друкуємо ЛИШЕ
    в живий термінал; для автоматизації є явний прапорець.
    @param {{isTTY?: boolean}|undefined} stream */
export function isRedirected(stream) {
  return !stream?.isTTY;
}

/** Команда буфера обміну для платформи. Навіщо: 11.08.2026 токен тричі
    пройшов через сторонній канал, бо надрукований на екрані секрет
    копіюється РАЗОМ із корисним виводом. Те, чого немає на екрані,
    переслати неможливо.
    @returns {{cmd: string, args: string[]}|null} null — платформа невідома */
export function clipboardCommand(platform) {
  if (platform === "win32") return { cmd: "clip", args: [] };
  if (platform === "darwin") return { cmd: "pbcopy", args: [] };
  if (platform === "linux") return { cmd: "xclip", args: ["-selection", "clipboard"] };
  return null;
}

/** Маска секрету для екрана: досить, щоб звірити «той самий рядок?», і
    недосить, щоб ним скористались зі скріншота. */
export function maskSecret(s) {
  const v = String(s ?? "");
  return v.length <= 12 ? "…" : `${v.slice(0, 12)}…${v.length} символів`;
}

/** Пам'ятка партнеру — БЕЗ секретів, її можна переслати як є.
    Секрет і пам'ятка друкуються окремими блоками свідомо: коли токен
    вклеєний у корисний текст, зберігають увесь текст разом із токеном. */
export function partnerBrief({ baseUrl, clinicName, keyId, scopes, webhookUrl }) {
  const b = String(baseUrl || "").replace(/\/+$/, "");
  const lines = [
    `RadFlow Integration API v1 — доступ для «${clinicName}»`,
    ``,
    `Базовий URL: ${b}`,
    `Автентифікація: заголовок  Authorization: Bearer <ТОКЕН>`,
    `Скоупи ключа: ${scopes.join(", ")}`,
    `Ідентифікатор ключа (не секрет, для листування): ${keyId}`,
    ``,
    `Ендпоінти:`,
    `  GET  ${b}/api/integrations/v1/rooms`,
    `  GET  ${b}/api/integrations/v1/services?room_id=<uuid|base>`,
    `  GET  ${b}/api/integrations/v1/slots?room_id=<uuid>&date_from=&date_to=`,
    `  GET  ${b}/api/integrations/v1/appointments?updated_since=&after_id=`,
    `  POST ${b}/api/integrations/v1/appointments/{id}/events`,
    ``,
    `Перевірка доступу однією командою:`,
    `  curl -H "Authorization: Bearer <ТОКЕН>" ${b}/api/integrations/v1/rooms`,
    ``,
    `Подія виконання (лише факти руху пацієнта):`,
    `  {"event":"arrived|started|finished","source_event_id":"<унікальний id>",`,
    `   "at":"2026-08-12T10:31:00+03:00","accession":"ACC-123"}`,
    `  200 applied|duplicate|noop — прийнято; 409 — стан заважає зараз,`,
    `  повторіть пізніше; 422 — гард, ретрай не допоможе; 404 — запису немає.`,
    `  Повтор із тим самим source_event_id безпечний (дедуп на нашому боці).`,
    ``,
    `Межа продукту: канал приймає РІВНО чотири поля вище. Персональні та`,
    `клінічні дані (ПІБ, телефон, дата народження, висновки, зображення) не`,
    `передаються і не приймаються — такі запити відхиляються з 400.`,
  ];
  if (webhookUrl) {
    lines.push(
      ``,
      `Зворотний канал: RadFlow шле POST на ${webhookUrl} при кожній зміні`,
      `запису. Перевіряйте підпис X-RadFlow-Signature (HMAC-SHA256 від сирого`,
      `тіла секретом вебхука), дедуплікуйте за Idempotency-Key, застосовуйте`,
      `подію лише якщо її (updated_at, seq) новіші за збережені.`
    );
  }
  lines.push(``, `Повний контракт: docs/integration-api-v1.md`);
  return lines.join("\n");
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
