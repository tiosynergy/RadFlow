/* ===== RadFlow — логін як єдиний ідентифікатор входу (0124) =====

   Логін обовʼязковий для ВСІХ ролей і глобально унікальний (profiles.login,
   унікальний індекс по lower(login) з 0013). Увійти можна логіном або email —
   /api/auth/login розрізняє їх за наявністю «@». Виняток — радіолог: у нього
   службова адреса ВИПАДКОВА (rad.<hex>@radiologist.radflow.local), її не знає
   ні він, ні адмін, і вивести її з логіна не можна — тож фактичний вхід у
   нього лише за логіном (див. randomRadiologistEmail нижче).

   Чому нормалізація живе тут, а не в кожному роуті:
   - логін із «@» неможливо використати для входу взагалі — /api/auth/login
     вважає такий рядок email і навіть не питає резолвер;
   - службова адреса направника й CEO будується з логіна, і два різні логіни,
     що «схлопуються» в один рядок (напр. «Др. Іванов» і «др іванов»), давали б
     один email — другий createUser падав би на «Email вже використовується»,
     хоча логін вільний. Раніше кожен роут санітизував логін власним виразом;
   - регістр: зберігаємо в нижньому, бо унікальність і резолв і так по lower(),
     а «Zast» проти «zast» у списках персоналу читається як два різні акаунти. */

/** Один припустимий формат логіна для всіх ролей. */
export const LOGIN_MIN = 3;
export const LOGIN_MAX = 64;
const LOGIN_RE = /^[a-z0-9._-]+$/;

/** Технічні домени для ролей без власної пошти. */
export const RADIOLOGIST_EMAIL_DOMAIN = "radiologist.radflow.local";
export const REFERRER_EMAIL_DOMAIN = "referrer.radflow.local";
export const CEO_EMAIL_DOMAIN = "ceo.radflow.local";

/** trim + нижній регістр. Єдина форма, у якій логін потрапляє в БД. */
export function normalizeLogin(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/** Чи придатний логін: латиниця/цифри/._-, 3–64, без крайових роздільників. */
export function isValidLogin(login: string): boolean {
  if (login.length < LOGIN_MIN || login.length > LOGIN_MAX) return false;
  if (!LOGIN_RE.test(login)) return false;
  // Крайові «.», «-», «_» ламають ліву частину службової адреси й дають
  // логіни, що візуально не відрізняються («ivanov.» проти «ivanov»).
  if (/^[._-]/.test(login) || /[._-]$/.test(login)) return false;
  return true;
}

/** Людський текст помилки — однаковий на клієнті й на сервері. */
export const LOGIN_HINT =
  "Логін: латинські літери, цифри, крапка, дефіс, підкреслення; від 3 до 64 символів, без крапки чи дефіса на початку й у кінці.";

/** Службова адреса для ролі без власної пошти. Логін має бути валідним. */
export function technicalEmail(login: string, domain: string): string {
  return normalizeLogin(login) + "@" + domain;
}

/* Службова адреса РАДІОЛОГА — випадкова, а НЕ похідна від логіна.

   Спокуса зробити <login>@radiologist.radflow.local велика (одноманітно з
   направниками), але вона коштує трьох окремих проблем:

   1. Адреса стає вгадуваною. Логін радіолога бачить кожен адмін у списку
      персоналу, тож «вхід лише за логіном» тримався б на тому, що ніхто не
      здогадається скласти адресу і піти з нею повз наш /api/auth/login прямо
      в GoTrue (у браузера є anon-ключ, ендпойнт публічний).
   2. Зміна логіна вимагала б синхронно міняти auth.users.email і profiles.email.
      Атомарності між Auth API і базою немає: збій між двома викликами лишає
      радіолога, який НЕ МОЖЕ увійти взагалі — логін новий, адреса стара.
   3. Перейменування звільняє логін, але лишає стару адресу зайнятою — і
      наступний акаунт із цим логіном падає на «Email вже використовується».

   Випадкова адреса знімає всі три: вона нікому не відома, не залежить від
   логіна і не потребує оновлення при перейменуванні. */
export function randomRadiologistEmail(): string {
  const rnd = crypto.randomUUID().replace(/-/g, "");
  return "rad." + rnd + "@" + RADIOLOGIST_EMAIL_DOMAIN;
}

/** Чи є адреса службовою (будь-який із наших внутрішніх доменів). */
export function isTechnicalEmail(email: string | null | undefined): boolean {
  return typeof email === "string" && /\.radflow\.local$/i.test(email.trim());
}

/* Запасний логін для акаунта, створеного повз наші форми (напр. через
   Supabase Dashboard): беремо ліву частину email. Використовується і в БД —
   тримай синхронно з public.login_from_email() у 0124. */
export function loginFromEmail(email: string): string {
  const local = normalizeLogin(email).split("@")[0] || "";
  // Порядок важливий: спершу ріжемо до 64, і ЛИШЕ ПОТІМ знімаємо крайові
  // роздільники. Навпаки — зріз міг лишити «.» в кінці, і запасний логін не
  // проходив би власний CHECK (весь signUp падав би на «Database error»).
  const cleaned = local.replace(/[^a-z0-9._-]+/g, "").slice(0, LOGIN_MAX)
    .replace(/^[._-]+|[._-]+$/g, "");
  if (cleaned.length >= LOGIN_MIN) return cleaned;
  return ("user" + cleaned).slice(0, LOGIN_MAX).replace(/[._-]+$/g, "");
}
