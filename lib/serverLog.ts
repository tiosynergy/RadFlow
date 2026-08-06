/**
 * Structured server log для критичних помилок (§7 ТЗ логування).
 * ОДИН server-only хелпер: JSON-сумісний рядок у stderr (Vercel це збирає).
 *
 * Логуємо ЛИШЕ критичне: неуспішну мутацію, неочікуване виключення, відмову
 * в доступі, помилку cron/зовнішньої інтеграції, dead-outbox, збій запису
 * важливої події. НЕ логуємо успіхи, PII і секрети.
 *
 * Поля — фіксований allowlist (§7): event, requestId, actorId, clinicId,
 * entityId, errorCode + очищений message. Довільних обʼєктів НЕ приймаємо —
 * саме так PII і затікає в логи.
 */

type LogErrorInput = {
  /** Машиночитане імʼя події, напр. "important_event.write_failed". */
  event: string;
  requestId?: string | null;
  actorId?: string | null;
  clinicId?: string | null;
  entityId?: string | null;
  errorCode?: string | null;
  /** Текст помилки — БУДЕ очищений від email/довгих цифр/токенів. */
  message?: string | null;
};

/**
 * Прибирає з тексту помилки те, що схоже на PII або секрети:
 * email, послідовності ≥7 цифр (телефони), Bearer/JWT-подібні токени,
 * key=value із секретними іменами. Обрізає до 500 символів.
 */
export function scrubLogText(raw: string): string {
  return raw
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [token]")
    .replace(/\beyJ[A-Za-z0-9._-]{10,}/g, "[jwt]")
    .replace(/\b(api[_-]?key|secret|password|token)\s*[=:]\s*\S+/gi, "$1=[hidden]")
    .replace(/\d{7,}/g, "[digits]")
    .slice(0, 500);
}

/** Критична помилка → один JSON-рядок у stderr. Ніколи не кидає. */
export function logError(input: LogErrorInput): void {
  try {
    const entry = {
      level: "error" as const,
      at: new Date().toISOString(),
      event: input.event,
      requestId: input.requestId ?? null,
      actorId: input.actorId ?? null,
      clinicId: input.clinicId ?? null,
      entityId: input.entityId ?? null,
      errorCode: input.errorCode ?? null,
      message: input.message ? scrubLogText(input.message) : null,
    };
    console.error(JSON.stringify(entry));
  } catch {
    // Лог не має права валити операцію — навіть на битому вході.
    console.error('{"level":"error","event":"logError.serialize_failed"}');
  }
}
