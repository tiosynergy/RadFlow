# n8n workflow `radflow-price-import` — експорт для аудиту

Довідковий (redacted) експорт n8n-workflow, що обслуговує імпорт прайса
(`POST /api/services/import`, фази 3a детермінована + 3b AI). Комітиться в репо,
щоб workflow можна було **рев'ювати й версіонувати разом із кодом** — раніше він
жив лише в n8n Cloud і не піддавався аудиту.

- Інстанс: n8n **Cloud** (`tio-synergy.app.n8n.cloud`) — зовнішній managed-SaaS,
  **без мережевого шляху** в приватну мережу RadFlow / Supabase / metadata хмари.
- Workflow id: `ikpUa5PZ1QWQy8oH`. Production URL — HMAC-гейтований (див. нижче).

## Файли

| Файл | Що це |
|---|---|
| `radflow-price-import.workflow.json` | Importable експорт (redacted). Збирається білдером із `nodes/*.js`. |
| `nodes/verify-and-decode.js` | Code-нода: HMAC-перевірка + анти-replay + kind-роутинг + **SSRF-regex-гард URL**. |
| `nodes/sign-response.js` | Code-нода: підпис відповіді HMAC (`{body, sig}`, прапор `ai`). |
| `nodes/build-ai-request.js` | Code-нода: збирає запит до Grok (structured output, анти-injection системний промпт). |
| `nodes/parse-ai-rows.js` | Code-нода: відповідь Grok → сирі рядки (нормалізація — на боці RadFlow). |
| `build-export.mjs` | Збирає `.workflow.json` із `nodes/*.js` (єдине джерело істини Code-нод) + падає, якщо лишився живий секрет. |

Оновити експорт після правки нод: `node automation/n8n/build-export.mjs`.

## ⚠️ Секрет (HMAC)

`IMPORT_WEBHOOK_SECRET` **редаговано** на `REPLACE_ME_IMPORT_SECRET` у двох Code-нодах
(`verify-and-decode.js`, `sign-response.js`). У живому workflow це реальний секрет із
Vercel env (n8n Cloud блокує `$env`, тому він — константа в нодах). **Ніколи не комітити
реальний секрет.** При ротації міняти В ОБОХ нодах + Vercel env + `.env.local`.
Білдер (`build-export.mjs`) кидає помилку, якщо в зібраному JSON лишився 64-hex.

## Потік і рубежі захисту

```
Webhook → Verify & Decode → Route Kind ─┬─ xlsx → Extract XLSX ─┐
                                        ├─ csv  → Extract CSV  ─┤→ Sign Response → Respond
                                        ├─ pdf  → Extract PDF ─┐ │
                                        ├─ image ───────────────┤ │
                                        ├─ text ────────────────┼─ Build AI Request → Call Grok → Parse AI Rows ┘
                                        └─ url  → Fetch Page  ──┘
```

- **HMAC в обидва боки** (`X-RadFlow-Signature: sha256=…`); `timingSafeEqual`;
  обчислений HMAC **ніколи** не потрапляє в текст помилки (оракул підпису).
- **Анти-replay:** `ts ± 5 хв`.
- **SSRF (URL-режим):** три рубежі —
  1. `safePriceUrl` у RadFlow (синтаксис: лише https, не IP-літерал/localhost/.local/IPv6);
  2. **`hostResolvesPublic` у RadFlow** (`lib/ssrfGuard.ts`, 3b hardening) — резолвить DNS
     і відмовляє, якщо будь-яка адреса приватна/зарезервована (fail-closed);
  3. regex-дзеркало в `Verify & Decode` (n8n-пісочниця не має `dns`/`url`);
  4. **`Fetch Page`: редиректи ВИМКНЕНО** (`followRedirects: false`), timeout 15 с.

  Залишковий ризик (свідомий): DNS-rebinding TOCTOU — `Fetch Page` резолвить хост
  повторно за секунди після кроку 2. Повний pin-резолв у пісочниці n8n Cloud недоступний;
  разом із вимкненими редиректами вікно експлуатації вузьке, а доступ гейтований
  адміном центру + rate-limit 10/10 хв.
- **AI не довірений:** системний промпт позначає вміст як ДАНІ (анти-injection),
  structured output (json_schema strict); фінальна перевалідація — `parseAiRows`
  у RadFlow (`AI_CONF_MIN`, межі цін/тривалостей, дедуп), рядки НЕ пред-відмічені в UI.

## Re-import у n8n

1. n8n → Workflows → Import from File → `radflow-price-import.workflow.json`.
2. У `Verify & Decode` і `Sign Response` замінити `REPLACE_ME_IMPORT_SECRET` на реальний
   `IMPORT_WEBHOOK_SECRET` (той самий, що у Vercel env).
3. У `Call Grok` переобрати credential «xAi account» (`xAiApi`).
4. Save → Publish. Production URL webhook звірити з `N8N_IMPORT_WEBHOOK_URL` у Vercel.

> Цей файл — знімок для аудиту; джерело істини живого workflow — інстанс n8n Cloud.
> Після будь-якої правки в редакторі n8n онови експорт білдером і закоміть.
