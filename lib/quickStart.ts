/* ===== RadFlow — швидкий старт: чисті правила перших кроків (с82) =====

   Два різні «перші входи», і в обох людина хоче одного — почати працювати,
   ввівши лише обовʼязкове:

   1. АДМІНІСТРАТОР щойно зареєстрував центр. Доти `/setup` зустрічав його хабом
      із девʼяти секцій без порядку кроків і без фіналу, а обовʼязкове (назва,
      місто, часовий пояс, ПІБ, телефон, хоча б один кабінет) було розкидане між
      трьома секціями. Тут — три кроки: «Центр» → «Кабінети» → «Готово». Правила
      «що обовʼязково» ТІ САМІ, що в `valid[1]` майстра (інакше швидкий старт
      запускав би центр, якого хаб потім не зберіг би), лише порізані по кроках.

   2. ПРИГЛАШЕНИЙ (реєстратор, радіолог, направник, керівник) ставить пароль за
      одноразовим посиланням. Налаштовувати йому нічого; усе, що він втрачав, —
      повторний вхід логіном і паролем, які щойно ввів, і екран без пояснення,
      куди він потрапив. Тут — стартовий шлях ролі та текст привітання.

   Чому це окремий модуль без React: компонентних тестів у проєкті немає (jsdom
   не налаштований), тож усе, що має бути ДОВЕДЕНИМ, живе тут під vitest, а
   компоненти лише кличуть ці функції (сторож — tests/quickStart.test.ts). */

/** Ролі з ENUM `user_role` (supabase/types.ts). */
export type UserRole = "admin" | "radiologist" | "registrar" | "referrer" | "ceo";

/** Стартові екрани ролей — ті самі шляхи, на які розводить `/queue`. */
export type StartPath = "/queue" | "/radiologist" | "/referral" | "/ceo";

/* ЄДИНЕ місце, де роль перекладається у стартовий шлях.
   ⚠️ Клієнт НЕ приймає шлях від сервера — лише роль, і перекладає її сам цією
   функцією. Так у відповіді роута немає значення, яке можна було б підставити
   під редірект (клас open-redirect), а невідома роль веде на дошку, яка сама
   розводить і сама ж відмовляє (`RoleNotice`), — тобто fail-closed. */
export function startPathForRole(role: string | null | undefined): StartPath {
  switch (role) {
    case "radiologist": return "/radiologist";
    case "referrer": return "/referral";
    case "ceo": return "/ceo";
    default: return "/queue";   // admin, registrar і будь-яка невідома роль
  }
}

/** Людська назва ролі (називний відмінок), для привітання і підписів. */
export function roleLabel(role: string | null | undefined): string {
  switch (role) {
    case "admin": return "Адміністратор";
    case "registrar": return "Реєстратор";
    case "radiologist": return "Радіолог";
    case "referrer": return "Лікар-направник";
    case "ceo": return "Керівник";
    default: return "Користувач";
  }
}

/* ---------- Привітання після встановлення пароля ---------- */

/** Що сервер знає про акаунт у момент, коли пароль задано (без ПІІ пацієнтів). */
export type WelcomeContext = {
  role: string | null | undefined;
  fullName?: string | null;
  /** Центр персоналу (admin/registrar/radiologist); у глобальних ролей — null. */
  clinicName?: string | null;
  /** Радіолог: скільки кабінетів йому призначено. null — невідомо (не питали / збій). */
  roomsCount?: number | null;
  /** Направник / керівник: скільки центрів дали активний доступ. null — невідомо. */
  centersCount?: number | null;
};

export type Welcome = {
  title: string;
  /** «Ви увійшли як …» — роль і центр, якщо він є. */
  who: string;
  /** 1–3 речення «що далі», кожне — окремий рядок. */
  next: string[];
  /** Підпис кнопки переходу. */
  cta: string;
  path: StartPath;
};

/** Текст привітання за роллю. Усі рядки — українські, без ПІІ пацієнтів. */
export function welcomeFor(ctx: WelcomeContext): Welcome {
  const name = (ctx.fullName ?? "").trim();
  const title = name ? `Готово, ${name}!` : "Готово!";
  const clinic = (ctx.clinicName ?? "").trim();
  const who = roleLabel(ctx.role) + (clinic ? ` центру «${clinic}»` : "");
  const path = startPathForRole(ctx.role);

  switch (ctx.role) {
    case "registrar":
      return {
        title, who, path, cta: "Перейти до дошки черги",
        next: [
          "Ваш екран — Дошка черги: записи пацієнтів, статуси, колл-лист і лист очікування.",
          "Налаштування центру (кабінети, графік, прайс) веде адміністратор.",
        ],
      };
    case "radiologist": {
      const n = ctx.roomsCount;
      const rooms =
        n == null ? "Побачите пацієнтів кабінетів, які призначив адміністратор."
        : n === 0 ? "Кабінети вам ще не призначено — попросіть адміністратора центру, без цього черга буде порожньою."
        : `Вам призначено ${n} ${pluralUk(n, "кабінет", "кабінети", "кабінетів")} — побачите їхніх пацієнтів.`;
      return {
        title, who, path, cta: "Перейти до моєї черги",
        next: ["Ваш екран — «Моя черга»: пацієнти ваших кабінетів, виклик наступного, таймер дослідження.", rooms],
      };
    }
    case "referrer": {
      const n = ctx.centersCount;
      const centers =
        n == null ? "Направлення створюються в центрах, що надали вам доступ."
        : n === 0 ? "Поки жоден центр не надав вам доступ — попросіть його адміністратора або надішліть запит у вкладці «Мої центри»."
        : `Доступ надали ${n} ${pluralUk(n, "центр", "центри", "центрів")} — вони вже у вкладці «Мої центри».`;
      return {
        title, who, path, cta: "Перейти до порталу",
        next: ["Ваш екран — Портал направника: нове направлення, «Мої направлення» і лист очікування.", centers],
      };
    }
    case "ceo": {
      const n = ctx.centersCount;
      const centers =
        n == null ? "Показники — за центрами, до яких вам надано доступ."
        : n === 0 ? "Поки жоден центр не надав вам доступ — попросіть його адміністратора."
        : `Вам відкрито ${n} ${pluralUk(n, "центр", "центри", "центрів")}.`;
      return {
        title, who, path, cta: "Перейти до панелі CEO",
        next: ["Ваш екран — Панель CEO: завантаженість, дохід, виконані дослідження.", centers],
      };
    }
    case "admin":
      return {
        title, who, path, cta: "Перейти до дошки черги",
        next: ["Ваш екран — Дошка черги; налаштування центру — у «Майстрі налаштування»."],
      };
    default:
      return { title, who, path, cta: "Перейти до роботи", next: ["Натисніть кнопку — система сама відкриє ваш екран."] };
  }
}

/** Форма слова для 1 / 2–4 / 5+ (українська). */
export function pluralUk(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(n));
  const m10 = abs % 10, m100 = abs % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/* ---------- Кроки швидкого старту адміністратора ---------- */

export const QS_STEPS = [
  { key: "center", title: "Центр", desc: "Назва, місто, часовий пояс" },
  { key: "rooms", title: "Кабінети", desc: "Апарати та графік роботи" },
  { key: "done", title: "Готово", desc: "Дошка черги працює" },
] as const;
export type QsStep = (typeof QS_STEPS)[number]["key"];

export function qsStepIndex(step: QsStep): number {
  return QS_STEPS.findIndex((s) => s.key === step);
}

/** Відсоток для прогрес-бару: крок 1 → 33, крок 2 → 67, готово → 100. */
export function qsProgress(step: QsStep): number {
  return Math.round(((qsStepIndex(step) + 1) / QS_STEPS.length) * 100);
}

/** Поля кроку «Центр» (підмножина WizardData майстра). */
export type QsCenterData = { clinic: string; city: string; adminName: string; aPhones: string[] };

/** Чого ще не вистачає на кроці «Центр» — у тому порядку, в якому поля стоять на екрані.
    Порожній масив = можна далі. Правила — ті самі, що у `valid[1]` майстра, плюс одне
    СУВОРІШЕ: телефон має бути коректним (`isPhoneOk` — `isValidPhoneUA` з lib/phone),
    а не просто непорожнім. Хаб невалідний номер лише підсвічує; тут він зупиняє
    «Далі», бо адмін щойно ввів його на реєстрації правильно — зіпсувати можна тільки
    правкою на цьому кроці, і сказати про це треба одразу. Суворіше ≠ несумісно:
    те, що пройшло швидкий старт, хаб збереже без змін. */
export function qsCenterMissing(d: QsCenterData, isPhoneOk: (phone: string) => boolean): string[] {
  const out: string[] = [];
  if (!d.clinic.trim()) out.push("назва центру");
  if (!d.city.trim()) out.push("місто");
  if (!d.adminName.trim()) out.push("ПІБ адміністратора");
  const phone = (d.aPhones.find((p) => p.trim() !== "") ?? "").trim();
  if (!phone) out.push("телефон адміністратора");
  else if (!isPhoneOk(phone)) out.push("коректний телефон (+380 XX XXX XX XX)");
  return out;
}

/** Чого не вистачає на кроці «Кабінети». `hoursOk`/`breaksOk` — вердикти
    валідаторів графіка з майстра (вони живуть там, бо тримають і підсвітку полів). */
export function qsRoomsMissing(equipCount: number, hoursOk: boolean, breaksOk: boolean): string[] {
  if (equipCount <= 0) return ["хоча б один кабінет"];
  const out: string[] = [];
  if (!hoursOk) out.push("коректні години роботи");
  if (!breaksOk) out.push("коректні перерви");
  return out;
}

/** «Залишилось: назва центру, місто» — один рядок для підказки під кнопкою. */
export function missingText(missing: string[]): string {
  return missing.length ? "Залишилось: " + missing.join(", ") : "";
}

/* ---------- Глибоке посилання на секцію хаба `/setup?section=…` ---------- */

/** Секція з query — лише з дозволеного переліку (anchor-и WIZ_NAV), інакше null.
    Значення іде в `setActiveSection`, тобто у вибір гілки рендера, — зайвий
    рядок із URL туди потрапити не повинен. */
export function sectionFromSearch(search: string, allowed: readonly string[]): string | null {
  let v: string | null = null;
  try { v = new URLSearchParams(search).get("section"); } catch { return null; }
  if (!v) return null;
  return allowed.includes(v) ? v : null;
}
