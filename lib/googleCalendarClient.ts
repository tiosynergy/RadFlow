/* ===== RadFlow — Google OAuth/Calendar: серверний клієнт =====

   ЄДИНЕ місце, де живуть HTTP-виклики до Google. OAuth-lifecycle (auth URL,
   PKCE, обмін коду, refresh, revoke) — офіційна google-auth-library
   (OAuth2Client): токени — найнебезпечніша частина, її не пишемо руками.
   Calendar API — чотири прості REST-виклики через fetch: тягти заради них
   монолітний googleapis (~100 МБ, усі API Google) — зайва поверхня.

   ПРАВИЛО ЛОГІВ: жоден токен, code, тіло відповіді Google не повертається
   назовні цього модуля сирим. Помилки — { status, class } (класифікація —
   classifyGoogleError у чистій логіці); текст відповіді читається ЛИШЕ для
   класифікації і далі не йде. */

import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import { classifyGoogleError, type GoogleErrorClass } from "@/lib/googleCalendarBackup";

export const GCAL_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

const CAL_BASE = "https://www.googleapis.com/calendar/v3";
/** Бюджет одного виклику Google: sync має вкластись у maxDuration роуту. */
const FETCH_TIMEOUT_MS = 15_000;

/* ── Конфіг платформи ── */

export function gcalEnv(): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

/** Платформний rollout-перемикач + повнота env. Перемикач НЕ замінює
    clinic-level enabled і live-перевірки — лише ховає фічу до пілота. */
export function isPlatformConfigured(): boolean {
  return process.env.GOOGLE_CALENDAR_BACKUP_AVAILABLE === "true" && gcalEnv() !== null;
}

export function oauthClient(): OAuth2Client {
  const env = gcalEnv();
  if (!env) throw new Error("google_not_configured");
  return new OAuth2Client(env.clientId, env.clientSecret, env.redirectUri);
}

/* ── OAuth lifecycle ── */

export async function makePkce(): Promise<{ verifier: string; challenge: string }> {
  const c = oauthClient();
  const { codeVerifier, codeChallenge } = await c.generateCodeVerifierAsync();
  if (!codeVerifier || !codeChallenge) throw new Error("pkce_generation_failed");
  return { verifier: codeVerifier, challenge: codeChallenge };
}

/** URL авторизації: offline (refresh token) + consent (Google повторно видає
    refresh token ЛИШЕ з prompt=consent — без нього reconnect лишив би нас без
    токена) + PKCE S256. */
export function buildAuthUrl(state: string, codeChallenge: string): string {
  const c = oauthClient();
  return c.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GCAL_SCOPES,
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
  });
}

export type TokenExchange =
  | { ok: true; refreshToken: string | null; accessToken: string }
  | { ok: false; class: GoogleErrorClass };

/** Обмін authorization code → токени. refreshToken може бути null навіть
    при успіху (Google інколи не повертає повторно) — рішення «не затирати
    наявний робочий секрет» ухвалює викликач. */
export async function exchangeCode(code: string, codeVerifier: string): Promise<TokenExchange> {
  const c = oauthClient();
  try {
    const { tokens } = await c.getToken({ code, codeVerifier });
    if (!tokens.access_token) return { ok: false, class: "google_unavailable" };
    return { ok: true, refreshToken: tokens.refresh_token ?? null, accessToken: tokens.access_token };
  } catch (e) {
    return { ok: false, class: classifyAuthError(e) };
  }
}

export type AccessTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; class: GoogleErrorClass };

/** refresh token → свіжий access token (живе лише в памʼяті запиту).
    Таймаут 15с (як calFetch): google-auth-library свого дедлайну не має, а
    з 0161 одна клініка, що зависла на refresh, зʼїдала б бюджет усього
    батча sync-all, не лише свій (ревʼю с42 пакета 6, М-3). Race не скасовує
    сам запит — але звільняє цикл; клас network = retryable. */
export async function refreshAccessToken(refreshToken: string): Promise<AccessTokenResult> {
  const c = oauthClient();
  c.setCredentials({ refresh_token: refreshToken });
  try {
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error("gcal: refresh timeout")), 15_000);
      (t as unknown as { unref?: () => void }).unref?.();
    });
    const { token } = await Promise.race([c.getAccessToken(), timeout]);
    if (!token) return { ok: false, class: "google_unavailable" };
    return { ok: true, accessToken: token };
  } catch (e) {
    if (e instanceof Error && e.message === "gcal: refresh timeout") {
      return { ok: false, class: "network" };
    }
    return { ok: false, class: classifyAuthError(e) };
  }
}

/** Best-effort відкликання (disconnect). Помилка НЕ блокує відключення. */
export async function revokeToken(refreshToken: string): Promise<boolean> {
  try {
    await oauthClient().revokeToken(refreshToken);
    return true;
  } catch {
    return false;
  }
}

/** Помилка бібліотеки → клас. У gaxios-помилок є response.status/data;
    invalid_grant Google повертає з HTTP 400. */
function classifyAuthError(e: unknown): GoogleErrorClass {
  const err = e as { response?: { status?: number; data?: unknown }; message?: string };
  const status = err?.response?.status ?? null;
  const body =
    typeof err?.response?.data === "string"
      ? err.response.data
      : err?.response?.data ? JSON.stringify(err.response.data) : (err?.message ?? "");
  return classifyGoogleError(status, body);
}

/* ── Calendar REST ── */

export type CalRequestError = { ok: false; status: number | null; class: GoogleErrorClass };
export type CalListEntry = {
  id: string;
  summary: string;
  timeZone: string | null;
  accessRole: string;
  primary?: boolean;
};

async function calFetch(
  accessToken: string,
  path: string,
  init?: RequestInit
): Promise<{ ok: true; status: number; json: unknown } | CalRequestError> {
  try {
    const res = await fetch(`${CAL_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) {
      // тіло читаємо ЛИШЕ для класифікації; далі воно не йде
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, class: classifyGoogleError(res.status, text) };
    }
    // 204 (delete) — тіла немає
    const json = res.status === 204 ? null : await res.json().catch(() => null);
    return { ok: true, status: res.status, json };
  } catch {
    return { ok: false, status: null, class: "network" };
  }
}

/** CalendarList: лише календарі, куди МОЖНА писати (minAccessRole=writer —
    фільтр на боці Google; owner теж проходить). */
export async function listWritableCalendars(
  accessToken: string
): Promise<{ ok: true; items: CalListEntry[] } | CalRequestError> {
  const r = await calFetch(accessToken, "/users/me/calendarList?minAccessRole=writer&maxResults=250&showHidden=true");
  if (!r.ok) return r;
  const items = ((r.json as { items?: unknown[] })?.items ?? [])
    .map((it) => {
      const o = it as Record<string, unknown>;
      return {
        id: String(o.id ?? ""),
        summary: String(o.summaryOverride ?? o.summary ?? ""),
        timeZone: typeof o.timeZone === "string" ? o.timeZone : null,
        accessRole: String(o.accessRole ?? ""),
        primary: o.primary === true,
      };
    })
    .filter((c) => c.id && (c.accessRole === "writer" || c.accessRole === "owner"));
  return { ok: true, items };
}

/** Один запис CalendarList — live-перевірка вибраного календаря. */
export async function getCalendarListEntry(
  accessToken: string,
  calendarId: string
): Promise<{ ok: true; entry: CalListEntry } | CalRequestError> {
  const r = await calFetch(accessToken, `/users/me/calendarList/${encodeURIComponent(calendarId)}`);
  if (!r.ok) return r;
  const o = r.json as Record<string, unknown>;
  return {
    ok: true,
    entry: {
      id: String(o.id ?? calendarId),
      summary: String(o.summaryOverride ?? o.summary ?? ""),
      timeZone: typeof o.timeZone === "string" ? o.timeZone : null,
      accessRole: String(o.accessRole ?? ""),
      // с43: та сама форма, що й у listWritableCalendars — щоб обидва читачі
      // CalendarList віддавали однаковий CalListEntry. Місце для майбутньої
      // відмови по особистому календарю — /select, правило там же.
      primary: o.primary === true,
    },
  };
}

export type CalEvent = {
  id: string;
  status: string;
  extendedProperties?: { private?: Record<string, string> };
};

/** Всі НАШІ події календаря (фільтр privateExtendedProperty=clinicId) у
    вікні часу; пагінація до вичерпання. singleEvents не потрібен: ми не
    створюємо recurring. */
export async function listOwnEvents(
  accessToken: string,
  calendarId: string,
  clinicId: string,
  timeMinIso: string,
  timeMaxIso: string
): Promise<{ ok: true; items: CalEvent[] } | CalRequestError> {
  const items: CalEvent[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({
      maxResults: "2500",
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
      showDeleted: "false",
      privateExtendedProperty: `radflowClinicId=${clinicId}`,
    });
    if (pageToken) params.set("pageToken", pageToken);
    const r = await calFetch(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events?${params}`);
    if (!r.ok) return r;
    const o = r.json as { items?: unknown[]; nextPageToken?: string };
    for (const raw of o.items ?? []) {
      const ev = raw as Record<string, unknown>;
      items.push({
        id: String(ev.id ?? ""),
        status: String(ev.status ?? ""),
        extendedProperties: ev.extendedProperties as CalEvent["extendedProperties"],
      });
    }
    pageToken = o.nextPageToken ?? null;
    if (!pageToken) break;
  }
  return { ok: true, items };
}

export async function insertEvent(
  accessToken: string,
  calendarId: string,
  body: unknown
): Promise<{ ok: true } | CalRequestError> {
  const r = await calFetch(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return r.ok ? { ok: true } : r;
}

/** PUT (update), не PATCH: тіло події ПОВНІСТЮ виводиться зі снапшота, тож
    повна заміна безпечна і воскрешає cancelled-подію (status: confirmed). */
export async function updateEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  body: unknown
): Promise<{ ok: true } | CalRequestError> {
  const r = await calFetch(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return r.ok ? { ok: true } : r;
}

export async function deleteEvent(
  accessToken: string,
  calendarId: string,
  eventId: string
): Promise<{ ok: true } | CalRequestError> {
  const r = await calFetch(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
  });
  // 404/410 при delete — уже видалено кимось/раніше: мета досягнута
  if (!r.ok && (r.status === 404 || r.status === 410)) return { ok: true };
  return r.ok ? { ok: true } : r;
}
