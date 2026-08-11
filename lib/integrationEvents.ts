/* ===== RadFlow — вхідні події RIS: чистий контракт (фаза 2) =====
   Розбір і валідація тіла POST /appointments/{id}/events, мапінг результату
   RPC integration_apply_status (0146) у HTTP і переклад помилок БД у СТАБІЛЬНІ
   машинні коди. Чиста логіка — під vitest; БД і Next тут не згадуються. */

/** Події, які RadFlow приймає ззовні. Клінічного контенту серед них немає і
    не буде: це факти руху пацієнта, а не дані дослідження. */
export const INBOUND_EVENTS = ["arrived", "started", "finished"] as const;
export type InboundEvent = (typeof INBOUND_EVENTS)[number];

/** Статус, у який веде подія (дзеркало ланцюжка 0146). */
export const EVENT_TARGET: Record<InboundEvent, "waiting" | "in_progress" | "done"> = {
  arrived: "waiting",
  started: "in_progress",
  finished: "done",
};

/** Результати RPC (0146) → HTTP.
    200: applied | duplicate | noop — повтор і застаріла подія НЕ помилка,
         інакше RIS ретраїтиме вічно.
    409: conflict | busy | reused | rejected_busy — стан заважає ЗАРАЗ,
         повтор пізніше має сенс.
    422: rejected — доменний гард, ретрай не лікує.
    404: not_found. */
export const RESULT_HTTP: Record<string, number> = {
  applied: 200,
  duplicate: 200,
  noop: 200,
  conflict: 409,
  busy: 409,
  reused: 409,
  rejected_busy: 409,
  rejected: 422,
  not_found: 404,
};

/** Дозволені ключі тіла. ALLOWLIST, не denylist: контракт закритий, і саме це
    робить «клінічний вміст не приймається» технічною межею, а не обіцянкою
    (denylist з 14 імен обходився б `mrn`, `birth_date`, вкладеністю тощо). */
export const ALLOWED_BODY_KEYS = ["event", "source_event_id", "at", "accession"] as const;

/** Тіло понад 8 КБ — не наш контракт (перевірка в БАЙТАХ, не в code units). */
export const MAX_BODY_BYTES = 8 * 1024;
export function overBodyLimit(raw: string): boolean {
  // Буфер тут зайвий: рахуємо utf-8 довжину вручну, щоб модуль лишався чистим
  let bytes = 0;
  for (const ch of raw) {
    const c = ch.codePointAt(0) ?? 0;
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    if (bytes > MAX_BODY_BYTES) return true;
  }
  return false;
}

export type ParsedInbound = {
  event: InboundEvent;
  sourceEventId: string;
  at: string | null;
  accession: string | null;
};

export type ParseResult =
  | { ok: true; value: ParsedInbound }
  | { ok: false; error: string };

const MAX_ID_LEN = 200;
/* Суворий ISO-8601 з ОБОВʼЯЗКОВОЮ зоною: без неї Date.parse трактує рядок як
   локальний час сервера — та сама подія лягала б у журнал по-різному в тестах
   (TZ=Europe/Kyiv) і на Vercel (UTC). Заодно відсікає «Aug 12, 2026» і «2026». */
const ISO_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?([Zz]|[+-]\d{2}:\d{2})$/;
/* Ключ ідемпотентності — друкований ASCII без керуючих символів: \0  у
   тексті дав би 22P05 з БД (500 замість чесного 400). */
const SID_RE = /^[\x20-\x7E]+$/;
/* Для accession не вимагаємо ASCII (у клініки може бути свій формат), але
   керуючі символи — та сама пастка 22P05, тож відсікаємо їх окремо. */
const CTRL_RE = /[\u0000-\u001F\u007F]/;

/** Розбір тіла запиту. Fail-closed: усе, що не розпізнано ЯВНО, — 400 із
    конкретним текстом (інтегратор має бачити, що саме не так). */
export function parseInboundEvent(body: unknown): ParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "очікую JSON-об'єкт" };
  }
  const b = body as Record<string, unknown>;

  const unknown = Object.keys(b).filter(
    (k) => !(ALLOWED_BODY_KEYS as readonly string[]).includes(k)
  );
  if (unknown.length) {
    return {
      ok: false,
      error:
        `невідомі поля: ${unknown.join(", ")}. Дозволені: ${ALLOWED_BODY_KEYS.join(", ")}. ` +
        `Канал приймає лише факти руху пацієнта — персональні й клінічні дані не передавати`,
    };
  }

  const event = b.event;
  if (typeof event !== "string" || !(INBOUND_EVENTS as readonly string[]).includes(event)) {
    return { ok: false, error: `event: одне з ${INBOUND_EVENTS.join(" | ")}` };
  }

  const sid = b.source_event_id;
  if (typeof sid !== "string" || sid.trim().length === 0) {
    return { ok: false, error: "source_event_id: непорожній рядок (ключ ідемпотентності)" };
  }
  if (sid.length > MAX_ID_LEN) {
    return { ok: false, error: `source_event_id: до ${MAX_ID_LEN} символів` };
  }
  /* Перевіряємо СИРИЙ рядок, не обрізаний: trim() зняв би \n/\t по краях і
     ключ ідемпотентності «очистився» б мовчки — а це саме той рядок, за яким
     RIS потім шукатиме свою подію. Пробіли всередині дозволені (0x20). */
  if (!SID_RE.test(sid)) {
    return { ok: false, error: "source_event_id: лише друковані ASCII-символи" };
  }

  let at: string | null = null;
  if (b.at !== undefined && b.at !== null) {
    if (typeof b.at !== "string" || !ISO_RE.test(b.at) || Number.isNaN(Date.parse(b.at))) {
      return { ok: false, error: "at: ISO-8601 з часовою зоною, напр. 2026-08-12T10:31:00+03:00" };
    }
    at = new Date(Date.parse(b.at)).toISOString();
  }

  let accession: string | null = null;
  if (b.accession !== undefined && b.accession !== null) {
    if (typeof b.accession !== "string" || b.accession.trim().length === 0) {
      return { ok: false, error: "accession: непорожній рядок або null" };
    }
    if (b.accession.length > MAX_ID_LEN) {
      return { ok: false, error: `accession: до ${MAX_ID_LEN} символів` };
    }
    if (CTRL_RE.test(b.accession)) {
      return { ok: false, error: "accession: без керуючих символів" };
    }
    accession = b.accession.trim();
  }

  return {
    ok: true,
    value: { event: event as InboundEvent, sourceEventId: sid.trim(), at, accession },
  };
}

/* ===== Помилки БД → стабільний машинний код ===== */

export type DbErrorMap = { status: number; reason: string; retryable: boolean };

/** Переклад SQLSTATE у контракт API. Сирий текст БД назовні НЕ виходить
    (він містить імена констрейнтів, uuid чужих сутностей і внутрішні
    таймстемпи) — його місце в серверному лозі. */
export function mapDbError(code: string | undefined, message?: string): DbErrorMap {
  const m = message ?? "";
  switch (code) {
    // «двоє в кабінеті» / перетин вікон — стан заважає ЗАРАЗ, повтор має сенс
    case "23505":
    case "23P01":
      return { status: 409, reason: "room_busy", retryable: true };
    // запис щойно змінили (CASE_STALE) — транзієнт
    case "55000":
      return { status: 409, reason: "stale", retryable: true };
    case "22023":
      return { status: 400, reason: "bad_request", retryable: false };
    case "23514":
      return { status: 422, reason: "domain_guard", retryable: false };
    case "P0001":
      // Будь-який raise exception з БД. Розрізняємо лише те, що самі кидаємо.
      if (m.startsWith("INTEGRATION_EVENT")) {
        return { status: 400, reason: "bad_request", retryable: false };
      }
      if (m.startsWith("STATUS_TRANSITION")) {
        return { status: 422, reason: "illegal_transition", retryable: false };
      }
      return { status: 422, reason: "domain_guard", retryable: false };
    default:
      return { status: 500, reason: "server_error", retryable: true };
  }
}

/** Людський текст відповіді за результатом RPC. */
export function resultMessage(result: string): string {
  switch (result) {
    case "applied": return "Статус застосовано";
    case "duplicate": return "Подію вже приймали (ідемпотентний повтор)";
    case "noop": return "Запис уже в цьому або пізнішому стані";
    case "conflict": return "Поточний стан запису не приймає цю подію";
    case "busy": return "У кабінеті вже є пацієнт — повторіть пізніше";
    case "reused": return "source_event_id уже використано для іншої події";
    case "rejected_busy": return "Кабінет зайнятий — повторіть пізніше";
    case "rejected": return "Доменний гард не пропустив зміну";
    case "not_found": return "Запис не знайдено";
    default: return "Невідомий результат";
  }
}
