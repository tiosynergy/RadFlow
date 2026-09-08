import crypto from "crypto";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { logError } from "@/lib/serverLog";

// Витягуємо IP клієнта із заголовків проксі (Vercel ставить x-forwarded-for).
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

/* Ключ лімітера з КОРИСТУВАЦЬКОГО вводу (логін, email) — лише у вигляді хеша.
   Інакше довжину й вміст ключа задає атакувальник: rate_limits.key — primary key,
   і мільйон спроб із випадковими логінами = мільйон рядків (плюс роздування PK).
   А rl_check при деградації fail-open — тобто лімітер вимкнув би сам себе.
   Фіксовані 32 hex-символи + прибирання за cron (supabase/cron_jobs.sql). */
export function rlKey(prefix: string, raw: string): string {
  const h = crypto.createHash("sha256").update(raw.trim().toLowerCase()).digest("hex").slice(0, 32);
  return `${prefix}:${h}`;
}

/* ===== Поведінка при ВІДМОВІ САМОГО лімітера (RF-02 хвіст, пакет 43) =====

   Що було. `rateLimitOk` повертав `true` на будь-яку відмову — немає
   service-role, помилка RPC, виняток — і робив це МОВЧКИ. Аудит називає це
   fail-open, і це правда, але діагноз неповний: сам по собі fail-open на
   вході захисний (падіння бази не має замикати вхід усім). Справжній дефект
   у тому, що впалий лімітер НЕВІДРІЗНЯЛЬНИЙ від робочого — жодного сліду.

   Тому тут ДВІ речі, а не одна:
     • `onFailure` — рішення приймає ВИКЛИКАЧ, бо ціна різна. Для входу
       доступність важливіша (`"open"`). Для шляхів, де лімітер — ЄДИНИЙ
       захист (перебір логінів, lookup токена), краще 429, ніж тихо
       відкритий перебір (`"closed"`).
     • слід у структурному лозі В ОБОХ випадках. ⚠️ Не в журнал важливих
       подій: подія там вимагає клініки й актора, а лімітер падає саме там,
       де їх ще немає (pre-auth). І не на кожен виклик — падіння лімітера
       зазвичай масове, тож пишемо через власний дешевий throttle у памʼяті
       процесу, інакше перший же збій зробить лог непридатним. */
export type RlFailure = "open" | "closed";

/* Throttle слідів: не частіше ніж раз на 60 с на КЛЮЧ-ПРЕФІКС. У памʼяті
   процесу — навмисно: писати в БД про те, що БД недоступна, безглуздо. */
const lastLogged = new Map<string, number>();
function logOnce(prefix: string, reason: string, decision: RlFailure): void {
  const now = Date.now();
  const prev = lastLogged.get(prefix) ?? 0;
  if (now - prev < 60_000) return;
  lastLogged.set(prefix, now);
  logError({
    event: "ratelimit.unavailable",
    errorCode: reason,
    message: `prefix=${prefix} decision=${decision}`,
  });
}

/**
 * Перевірка обмеження частоти через БД (fixed-window, функція `rl_check`).
 * Повертає TRUE, якщо запит ДОЗВОЛЕНО.
 * @param onFailure що робити, коли САМ лімітер недоступний:
 *        `"open"` — пропустити (доступність важливіша: вхід, внутрішні
 *        лічильники); `"closed"` — відмовити (лімітер тут єдиний захист).
 */
export async function rateLimitOk(
  key: string,
  max: number,
  windowSeconds: number,
  onFailure: RlFailure = "open"
): Promise<boolean> {
  const prefix = key.split(":")[0] ?? "unknown";
  const fallback = onFailure === "open";
  if (!isAdminConfigured()) {
    logOnce(prefix, "no_service_role", onFailure);
    return fallback;
  }
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("rl_check", {
      p_key: key,
      p_max: max,
      p_window_seconds: windowSeconds,
    });
    if (error) {
      logOnce(prefix, "rpc_error", onFailure);
      return fallback;
    }
    return data !== false;
  } catch {
    logOnce(prefix, "exception", onFailure);
    return fallback;
  }
}
