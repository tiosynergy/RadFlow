/* ===== RadFlow — feature flags будущих AI-этапов поиска (с22) =====

   Этап 1 (текущий) — ДЕТЕРМИНИРОВАННЫЙ поиск, AI не подключён. Флаги заведены
   заранее (ТЗ §14), выключены по умолчанию и читаются ТОЛЬКО на сервере.
   До утверждения zero-retention/DPA и политики обработки медицинских данных
   включать их нельзя (PII-gate, ТЗ §13.2). Конфигурация провайдера/модели —
   только server-side env, никакой клиентской зависимости от LangChain. */

/** Этап 2: парсер естественного языка в строгие фильтры (LangChain structured output). */
export function aiSearchEnabled(): boolean {
  return process.env.AI_SEARCH_ENABLED === "true";
}

/** Этап 3: read-only AI-ассистент с allowlisted tools. */
export function aiAssistantEnabled(): boolean {
  return process.env.AI_ASSISTANT_ENABLED === "true";
}
