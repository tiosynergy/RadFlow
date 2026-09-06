/* RF-09. Одноразовий токен запрошення більше НЕ читається з таблиці: міграція
   0178 зняла табличний SELECT на `profiles` у клієнтських ролей і повернула
   його поколонково без `invite_token`. Тобто екран знає токен рівно тоді, коли
   САМ його щойно отримав у відповіді роута видачі — і не знає після
   перезавантаження.

   ⚠️ Чому не «просто прибрати колонку з select». Прибирання зламало б обидва
   екрани мовчки: сьогодні кнопка «Скопіювати» живе за рахунок читання таблиці,
   а в `StaffManager` — ВИКЛЮЧНО за його рахунок (там відповідь роута в стан не
   кладеться взагалі). Тому рішення винесене сюди, а не розмазане по JSX.

   ⚠️ І другий, прихований дефект, який це лікує: у `ReferrersManager` токен
   клався прямо в рядок списку — і будь-який наступний realtime-`reload()`
   затирав його разом із рядком. Карта живе ПОРУЧ зі списком, тож перезбір
   списку її не чіпає. */

/** Що показати в картці під полем «пароль ще не задано». */
export type InviteHint =
  | { kind: "none" }                      // пароль уже задано — нічого не показуємо
  | { kind: "link"; token: string }       // токен на руках → посилання + «Скопіювати»
  | { kind: "reissue" };                  // токен виданий раніше → тільки підказка

/** Токени, отримані у ВІДПОВІДЯХ роутів у цій сесії екрана: profileId → token. */
export type FreshTokens = Readonly<Record<string, string>>;

/* Порожній об'єкт-константа: щоб `useState(EMPTY_TOKENS)` не створював нову
   посилання на кожен рендер (той самий клас, що NEVER/SHOWN у useDocumentVisible). */
export const EMPTY_TOKENS: FreshTokens = Object.freeze({});

/** Значення з відповіді роута — довільне: приймаємо лише непорожній рядок. */
export function tokenOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Запам'ятати свіжий токен. Порожнє значення НЕ затирає вже відомий токен:
    відповідь без поля — це «роут не сказав», а не «токена немає». */
export function rememberToken(prev: FreshTokens, profileId: string, value: unknown): FreshTokens {
  const t = tokenOf(value);
  if (!profileId || t === null) return prev;
  if (prev[profileId] === t) return prev;
  return { ...prev, [profileId]: t };
}

/** Забути токен (пароль задано / акаунт видалено) — щоб карта не росла вічно
    і щоб мертвий токен не показувався як живий. */
export function forgetToken(prev: FreshTokens, profileId: string): FreshTokens {
  if (!(profileId in prev)) return prev;
  const next = { ...prev };
  delete next[profileId];
  return next;
}

/** Саме рішення. `passwordSet` приходить із таблиці (колонка дозволена),
    токен — лише з карти. */
export function inviteHint(passwordSet: boolean | null | undefined, fresh: FreshTokens, profileId: string | null | undefined): InviteHint {
  if (passwordSet) return { kind: "none" };
  const t = profileId ? tokenOf(fresh[profileId]) : null;
  return t === null ? { kind: "reissue" } : { kind: "link", token: t };
}

/** Текст підказки, коли токена на руках немає. Один рядок на два екрани —
    щоб копії не розʼїхались. */
export const REISSUE_HINT =
  "🔗 Пароль ще не встановлено. Посилання показуємо лише один раз — щоб передати його знову, натисніть «Скинути пароль» (старе перестане діяти).";
