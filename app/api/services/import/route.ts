import crypto from "crypto";
import { NextResponse } from "next/server";
import { requireRole } from "@/lib/apiAuth";
import {
  classifyRows, parseAiRows, parseRawRows, safePriceUrl,
  importFileKind, isAiFileKind, IMPORT_MAX_FILE_BYTES, IMPORT_FORMATS_HINT,
  type RawSheetRow,
} from "@/lib/priceImport";
import { docxToText } from "@/lib/docxText";
import { hostResolvesPublic } from "@/lib/ssrfGuard";

/* ===== RadFlow — імпорт прайса: розбір файла (Stage 2, фази 3a+3b) =====
   POST multipart {file} АБО {url} → пересилка в n8n-workflow
   «radflow-price-import» (HMAC-підпис + request_id-nonce):
   • xlsx/csv — детермінований парсинг (Extract From File, без AI);
   • pdf → текст → Grok; docx → текст ТУТ (lib/docxText.ts, kind='text') → Grok;
     url → n8n Fetch Page → Grok. Grok (grok-4.5, structured output) віддає
     сирі рядки {name, modality, price, duration_min, confidence}.

   ⚠️ ФОТО ПРАЙСА (jpg/png/webp → Grok vision) ПРИБРАНО 2026-07-29 за рішенням
   власника. Перелік форматів і ліміт розміру тепер живуть у lib/priceImport.ts
   (importFileKind / IMPORT_MAX_FILE_BYTES) — одне джерело для клієнта й сервера
   і, нарешті, під тестами. Гілка kind='image' у n8n лишилась, але RadFlow її
   більше не надсилає.
   Уся нормалізація і класифікація — тут (lib/priceImport.ts, під vitest):
   AI-рядки НЕ довірені (prompt-injection із документа) — перевалідовуються
   тими самими парсерами; confidence < AI_CONF_MIN → «Нерозпізнані».

   Цей роут НІЧОГО не пише в БД: підтвердження адміна йде окремим Server
   Action importServices → services_import_rpc (0115/0116). PII немає.

   Захист: requireRole(admin + clinic) → rl_check (10 імпортів / 10 хв на
   адміна) → ліміт розміру/типу файла → HMAC в ОБИДВА боки (n8n відповідає
   {body, sig}: sig = HMAC(body), body містить request_id — звірка nonce).
   URL: лише https + не-IP хост (SSRF; дзеркальний гард і в n8n).

   ⚠️ Ліміт файла 4 МБ (НЕ 10 МБ із плану): Vercel обрізає тіло запиту
   serverless-функції на ~4.5 МБ — більший файл не долетить фізично. */

export const dynamic = "force-dynamic";
/* Живий тест 3b: реальна прайс-сторінка (~140 позицій) коштує ~90 с Grok-у навіть
   із reasoning_effort=low — 60 с не вистачає. Hobby із Fluid Compute (увімкнено
   за замовчуванням) дозволяє до 300 с. Якщо деплой відхилить ліміт — увімкнути
   Fluid Compute у Settings → Functions або повернути 60. */
export const maxDuration = 300;

const N8N_TIMEOUT_MS = 30_000;      // детермінована гілка (xlsx/csv)
const N8N_AI_TIMEOUT_MS = 180_000;  // AI-гілка: великий прайс = хвилини LLM-часу
const MAX_RAW_ROWS = 5000; // стеля сирих рядків від n8n (до нормалізації)
const MAX_RESP_BYTES = 20 * 1024 * 1024; // zip-бомба у 4 МБ xlsx розгортається у сотні МБ JSON
const MAX_DOCX_TEXT = 300_000; // символів тексту з docx у n8n (LLM однаково ріже до 150k)

const jerr = (error: string, status: number) => NextResponse.json({ error }, { status });

/* Дзеркало transportProblem із lib/outbox.ts (локально: там функція модульна).
   Прайс — не PII, але підпис без TLS не має сенсу: fail-closed однаково. */
function transportProblem(url: string, secret: string | undefined): string | null {
  if (!secret) return "missing_secret";
  let u: URL;
  try { u = new URL(url); } catch { return "invalid_url"; }
  const localhost = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !localhost) return "insecure_transport";
  return null;
}

// Перелік форматів, ліміт розміру і SSRF-гард URL живуть у lib/priceImport.ts
// (route-файл Next.js не може експортувати довільні функції) і покриті
// tests/priceImport.test.ts + tests/priceImportUrl.test.ts.

const hmac = (secret: string, body: string) =>
  crypto.createHmac("sha256", secret).update(body).digest("hex");

/** Читає тіло відповіді зі стелею байтів (M2: небуферизований .json() на відповіді
    від zip-бомби клав би serverless-функцію по памʼяті ще до зрізу рядків). */
async function readBodyCapped(resp: Response, maxBytes: number): Promise<string | null> {
  const reader = resp.body?.getReader();
  if (!reader) {
    const text = await resp.text();
    return Buffer.byteLength(text, "utf8") > maxBytes ? null : text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { void reader.cancel(); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(req: Request) {
  const gate = await requireRole(["admin"], {
    needClinic: true,
    forbidden: "Імпорт прайса виконує адміністратор центру",
    rateLimit: { key: "svc_import", max: 10, windowSeconds: 600 },
  });
  if (!gate.ok) return gate.res;

  const url = process.env.N8N_IMPORT_WEBHOOK_URL;
  const secret = process.env.IMPORT_WEBHOOK_SECRET;
  if (!url) return jerr("Імпорт не налаштовано: задайте N8N_IMPORT_WEBHOOK_URL", 501);
  const problem = transportProblem(url, secret);
  if (problem) {
    console.error(`[services/import] зупинено (${problem}): перевірте IMPORT_WEBHOOK_SECRET / https`);
    return jerr("Імпорт не налаштовано на сервері", 501);
  }

  // ---- Вхід: файл АБО посилання (3b) + опційний кабінет (0121, room-owned) ----
  let form: FormData;
  try { form = await req.formData(); } catch { return jerr("Очікується multipart із файлом або посиланням", 400); }
  const file = form.get("file");
  const urlField = form.get("url");
  // 0121: room_id задано → превʼю рахує diff проти ВЛАСНИХ послуг кабінету
  // (services.room_id = кабінет) — саме цей набір оновлює services_import_rpc у
  // кабінетному режимі (on conflict по partial-індексу кабінету; optimistic-lock
  // 0119 теж у межах набору). База в кабінетному імпорті НЕ торкається, тож diff
  // проти неї дав би хибні «зміни» і масовий stale.
  const roomField = form.get("room_id");
  let roomId: string | null = null;
  if (typeof roomField === "string" && roomField.trim()) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(roomField.trim())) {
      return jerr("Некоректний кабінет", 400);
    }
    roomId = roomField.trim();
    // Кабінет мусить належати центру адміна (дзеркало BAD_INPUT-гейта RPC).
    const { data: roomRow, error: roomErr } = await gate.supabase
      .from("rooms").select("id").eq("id", roomId).eq("clinic_id", gate.me.clinic_id).maybeSingle();
    if (roomErr) return jerr("Не вдалося перевірити кабінет", 500);
    if (!roomRow) return jerr("Кабінет не знайдено в цьому центрі", 400);
  }

  const requestId = crypto.randomUUID();
  // Поля payload у n8n: kind + file_b64 (файли) / text (docx уже витягнуто) / url.
  let payload: Record<string, unknown>;
  let aiKind = false; // AI-гілка повільніша — інший таймаут

  if (typeof urlField === "string" && urlField.trim()) {
    const safe = safePriceUrl(urlField.trim());
    if (!safe) return jerr("Дайте пряме https-посилання на сторінку з прайсом", 400);
    // SSRF: синтаксичний гард не резолвить DNS — домен може вказувати на приватну
    // адресу. Резолвимо тут (fail-closed), поки n8n «Fetch Page» ще не сходив.
    if (!(await hostResolvesPublic(new URL(safe).hostname))) {
      return jerr("Хост посилання недоступний або вказує на внутрішню адресу", 400);
    }
    aiKind = true;
    payload = { kind: "url", url: safe, filename: "" };
  } else {
    if (!(file instanceof File)) return jerr("Додайте файл прайса або посилання", 400);
    const kind = importFileKind(file.name || "");
    if (!kind) return jerr(IMPORT_FORMATS_HINT, 415);
    if (file.size === 0) return jerr("Файл порожній", 400);
    if (file.size > IMPORT_MAX_FILE_BYTES) return jerr("Файл завеликий (до 4 МБ)", 413);

    const buf = Buffer.from(await file.arrayBuffer());
    if (kind === "docx") {
      // docx → плоский текст ТУТ (n8n docx не вміє, а Grok приймає текст).
      const text = await docxToText(buf);
      if (!text || text.length < 20) {
        return jerr("У документі не знайшлося тексту — перевірте файл або надішліть pdf чи таблицю", 422);
      }
      aiKind = true;
      payload = { kind: "text", text: text.slice(0, MAX_DOCX_TEXT), filename: file.name };
    } else {
      aiKind = isAiFileKind(kind);
      payload = { kind, filename: file.name, file_b64: buf.toString("base64") };
    }
  }

  // ---- RadFlow → n8n (HMAC-підпис тіла; ts — проти нескінченного replay) ----
  const body = JSON.stringify({
    request_id: requestId,
    clinic_id: gate.me.clinic_id,
    ts: Date.now(),
    ...payload,
  });

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-RadFlow-Signature": "sha256=" + hmac(secret as string, body),
      },
      body,
      signal: AbortSignal.timeout(aiKind ? N8N_AI_TIMEOUT_MS : N8N_TIMEOUT_MS),
    });
  } catch (e) {
    const timeout = e instanceof Error && e.name === "TimeoutError";
    return jerr(
      timeout
        ? (aiKind ? "AI-розбір не встиг за 3 хвилини — спробуйте менший файл або ще раз" : "Розбір файла не встиг за 30 с — спробуйте ще раз")
        : "Сервіс розбору недоступний",
      502);
  }
  if (!resp.ok) {
    console.error(`[services/import] n8n HTTP ${resp.status}`);
    return jerr("Не вдалося розібрати файл — перевірте формат або додайте позиції вручну", 502);
  }

  // ---- n8n → RadFlow: {body, sig}; sig = HMAC(body); body = {request_id, rows} ----
  const respText = await readBodyCapped(resp, MAX_RESP_BYTES).catch(() => null);
  if (respText == null) return jerr("Файл розгортається завеликим — спростіть таблицю", 422);
  let envelope: unknown;
  try { envelope = JSON.parse(respText); } catch { return jerr("Некоректна відповідь сервісу розбору", 502); }
  const env = envelope as { body?: unknown; sig?: unknown };
  if (typeof env?.body !== "string" || typeof env?.sig !== "string") {
    return jerr("Некоректна відповідь сервісу розбору", 502);
  }
  const expected = hmac(secret as string, env.body);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(env.sig, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.error("[services/import] невірний підпис відповіді n8n");
    return jerr("Підпис відповіді не пройшов перевірку", 502);
  }

  let resPayload: { request_id?: unknown; rows?: unknown; ai?: unknown };
  try { resPayload = JSON.parse(env.body); } catch { return jerr("Некоректна відповідь сервісу розбору", 502); }
  if (resPayload.request_id !== requestId) return jerr("Відповідь не відповідає запиту (nonce)", 502);
  if (!Array.isArray(resPayload.rows)) return jerr("Сервіс розбору не знайшов таблиці у файлі", 422);
  const totalRaw = (resPayload.rows as unknown[]).length;
  const raw = (resPayload.rows as unknown[])
    .slice(0, MAX_RAW_ROWS)
    .filter((r): r is RawSheetRow => !!r && typeof r === "object" && !Array.isArray(r));

  // ---- Нормалізація + класифікація проти каталогу центру (RLS-клієнт) ----
  // AI-прапор беремо з ПІДПИСАНОГО тіла n8n (не з нашого aiKind): гілку обрав n8n.
  const ai = resPayload.ai === true;
  const parsed = ai ? parseAiRows(raw) : parseRawRows(raw);
  const truncated = parsed.truncated || totalRaw > MAX_RAW_ROWS;
  // 0121: diff у МЕЖАХ НАБОРУ, який оновлюватиме RPC — база (room_id IS NULL)
  // або власні послуги кабінету (room_id = X). Змішування наборів давало б
  // невірну класифікацію та хибний optimistic-lock (0119).
  let svcQuery = gate.supabase
    .from("services")
    .select("id, name, modality, price, duration_min, active, updated_at") // updated_at — версія для 0119 optimistic-lock
    .eq("clinic_id", gate.me.clinic_id);
  svcQuery = roomId ? svcQuery.eq("room_id", roomId) : svcQuery.is("room_id", null);
  const { data: services, error } = await svcQuery;
  if (error) return jerr("Не вдалося прочитати каталог центру", 500);

  const classified = classifyRows(parsed.rows, services ?? []);
  return NextResponse.json({
    ok: true,
    preview: {
      rows: classified,
      skipped: parsed.skipped,
      columns: parsed.columns,
      totalRaw,
      truncated, // L8: «розібрали не все» показуємо явно, а не мовчки
      ai,        // 3b: розібрано AI — UI показує пересторогу «перевірте уважно»
    },
  });
}
