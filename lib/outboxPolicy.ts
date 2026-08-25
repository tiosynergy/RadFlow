/* ===== RadFlow — політики доставки outbox (чиста логіка, без I/O) =====
   Винесено з lib/outbox.ts, щоб рішення були покриті vitest-ом
   (tests/outboxPolicy.test.ts), а сам воркер лишався тонким.

   Дві політики — відповідь на аудит 2026-08-23 (H-1, M-3):

   1. СЛУЖБОВІ integration.*-події не летять партнеру.
      `integration.emit_failed` (0145) — сигнал МОНІТОРИНГУ про те, що тригер
      емісії впав (fail-open за дизайном). У контракті v1
      (docs/integration-api-v1.md) такого типу події немає, а в payload —
      текст SQL-помилки. Воркер маршрутизував його як звичайну `integration.*`
      і слав у вебхук клініки. Тепер — ack із поміткою; факт лишається в
      event_outbox (30 днів, prune-outbox) і його ловить сторож
      (`invariants_check`, перевірка 11 — 0157).

   2. ВИМКНЕНИЙ вебхук не спалює retry-бюджет.
      Було: `webhook_disabled` → mark_failed → attempts++ → після 10 спроб
      (≈4 год backoff) подія йшла в DLQ, хоча ендпоінт не був несправний —
      вікно обслуговування RIS довше за пів робочого дня ховало події в dead.
      Тепер: поки події менше DISABLED_DEFER_MAX_MS — відкладаємо
      `next_attempt_at` без attempts++ (той самий прийом, що deferredN8nIds
      з ревʼю с34); старше — як раніше, mark_failed → DLQ. Стеля потрібна:
      нових подій під вимкнений вебхук тригер 0145 НЕ емітує (гейт по
      w.enabled), але ті, що ВЖЕ лежали в outbox на момент вимкнення, без
      стелі перезаймали б кожен батч вічно і жили б у backlog-алертах —
      «вимкнули назавжди» має закінчуватись DLQ, а не шумом (ревʼю 0157).
      Крок відкладання — 30 хв: батч 50 × хвилинний cron = 1500 рядків
      однієї клініки, перш ніж відкладені повернуться в голову FIFO і
      почнуть голодом глушити решту (той самий клас, що с34). */

/** Типи `integration.*`, які НЕ є частиною партнерського контракту. */
export const INTERNAL_INTEGRATION_EVENTS: ReadonlySet<string> = new Set([
  "integration.emit_failed",
]);

export function isInternalIntegrationEvent(eventType: string): boolean {
  return INTERNAL_INTEGRATION_EVENTS.has(eventType);
}

/** Скільки подія може чекати на re-enable вебхука без спалення спроб. */
export const DISABLED_DEFER_MAX_MS = 72 * 60 * 60_000;
/** На скільки відкладати наступну спробу, поки вебхук вимкнений.
    Це і є затримка доставки після re-enable (гірший випадок). */
export const DISABLED_DEFER_STEP_MS = 30 * 60_000;

export type DisabledWebhookAction = "defer" | "fail";

/**
 * Що робити з integration.*-подією, чий вебхук вимкнений.
 * @param createdAt ISO created_at рядка outbox
 * @param nowMs     поточний час (мс), параметром — для тестів
 */
export function disabledWebhookAction(createdAt: string, nowMs: number): DisabledWebhookAction {
  const created = Date.parse(createdAt);
  // Нечитабельний created_at — не маскуємо: поводимось як «стара» подія,
  // тобто через mark_failed, де дефект стане видимим у DLQ.
  if (!Number.isFinite(created)) return "fail";
  return nowMs - created < DISABLED_DEFER_MAX_MS ? "defer" : "fail";
}
