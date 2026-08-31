/**
 * Контекстні позначки непрочитаних змін (0131/0132) — ЧИСТА логіка.
 *
 * ТЗ: CLAUDE_CONTEXTUAL_UNREAD_CHANGES_PROMPT.md. Тут живе все, що можна
 * перевірити vitest-ом без БД і без DOM (компонентних тестів у проєкті досі
 * немає — аудит L-2, тому чим більше логіки тут, тим більше реально покрито):
 *   - таксономія surface_key / field_scope / entity_type / severity —
 *     ДЗЕРКАЛО CHECK-ів міграції 0131 (розбіжність ловить тест);
 *   - індексація пакета позначок і селектори «є непрочитане тут?»;
 *   - агрегація батьківських індикаторів (секція світиться, поки світиться
 *     хоч одна дитина);
 *   - відбір id для підтвердження прочитання зі ЗНІМКА, який реально
 *     відрендерився;
 *   - українські формулювання для доступного імені крапки.
 *
 * Мережа й React — у lib/useUnreadChanges.tsx.
 */

/* ─────────────────────────── Таксономія ─────────────────────────────────
   ⚠️ Ці чотири списки — дзеркало CHECK-обмежень 0131 (ucm_surface_key_chk,
   ucm_field_scope_chk, ucm_entity_type_chk, ucm_severity_chk). Додаєш
   значення сюди — додай і в міграцію, інакше рядок відхилить БД, а тест
   tests/unreadChanges.test.ts впаде ще до того. */

export const SURFACE_KEYS = [
  "queue", "waitlist", "services", "schedule", "rooms",
  "referrals", "cases", "staff", "centers", "incidents",
] as const;

export const FIELD_SCOPES = [
  "record", "schedule", "studies", "patient_data", "status",
  "priority", "catalog", "room_override", "access", "case_step", "incident",
] as const;

export const MARKER_ENTITY_TYPES = [
  "queue_entry", "waitlist_entry", "patient_case", "incident",
  "referral_access", "staff", "service", "room", "schedule_override",
] as const;

export const MARKER_SEVERITIES = ["info", "important", "critical"] as const;

export type SurfaceKey = (typeof SURFACE_KEYS)[number];
export type FieldScope = (typeof FIELD_SCOPES)[number];
export type MarkerEntityType = (typeof MARKER_ENTITY_TYPES)[number];
export type MarkerSeverity = (typeof MARKER_SEVERITIES)[number];

export type ChangeMarker = {
  id: string;
  clinic_id: string;
  event_type: string;
  surface_key: SurfaceKey;
  entity_type: MarkerEntityType;
  entity_id: string;
  field_scope: FieldScope;
  actor_id: string | null;
  actor_role: string;
  subject_referrer_id: string | null;
  room_id: string | null;
  severity: MarkerSeverity;
  changed_fields: string[] | null;
  details: Record<string, unknown> | null;
  created_at: string;
  seen_at: string | null;
  /** 0133: календарний день сутності («YYYY-MM-DD»). Заповнений лише для
      записів черги; лист очікування / каталог / доступи його не мають. */
  subject_date: string | null;
};

/**
 * Стан завантаження. ⚠️ «Помилка» — це НЕ «нуль непрочитаного» (вимога ТЗ):
 * впала мережа — крапки лишаються ті, що були. Окремий стан потрібен саме
 * для того, щоб UI не міг переплутати «порожньо» з «не змогли дізнатись» —
 * той самий клас дефекту, що fail-CLOSED прапорці `*Loaded` у дошках (с24).
 */
export type UnreadStatus = "loading" | "ready" | "error-with-previous-data";

/* ─────────────────────────── Індексація ────────────────────────────────── */

export type UnreadIndex = {
  /** Усі непрочитані, у порядку від найсвіжішої. */
  all: ChangeMarker[];
  bySurface: Map<string, ChangeMarker[]>;
  byEntity: Map<string, ChangeMarker[]>;
  byField: Map<string, ChangeMarker[]>;
  /** 0133: «YYYY-MM-DD» → позначки цього дня (лише поверхня queue). Потрібен
      міні-календарю: він показує МІСЯЦЬ, а дошка вантажить ОДИН день, тож
      вивести день із завантажених даних неможливо (урок с24). */
  byDate: Map<string, ChangeMarker[]>;
};

export const entityKey = (entityType: string, entityId: string): string =>
  entityType + ":" + entityId;

export const fieldKey = (entityType: string, entityId: string, scope: string): string =>
  entityType + ":" + entityId + ":" + scope;

const push = (map: Map<string, ChangeMarker[]>, key: string, m: ChangeMarker): void => {
  const cur = map.get(key);
  if (cur) cur.push(m);
  else map.set(key, [m]);
};

/**
 * Один прохід по пакету → три індекси. ТЗ прямо забороняє запит на кожен
 * рядок/картку: дошка на 100 записів інакше дала б 100 запитів до Supabase.
 * Прочитані позначки (seen_at != null) в індекс не потрапляють узагалі.
 */
export function indexMarkers(markers: readonly ChangeMarker[]): UnreadIndex {
  const all = markers
    .filter((m) => m.seen_at == null)
    .slice()
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));

  const bySurface = new Map<string, ChangeMarker[]>();
  const byEntity = new Map<string, ChangeMarker[]>();
  const byField = new Map<string, ChangeMarker[]>();
  const byDate = new Map<string, ChangeMarker[]>();

  for (const m of all) {
    push(bySurface, m.surface_key, m);
    push(byEntity, entityKey(m.entity_type, m.entity_id), m);
    push(byField, fieldKey(m.entity_type, m.entity_id, m.field_scope), m);
    /* У календар пускаємо ЛИШЕ чергу: у листа очікування «бажане вікно», а не
       день, у каталогу дати немає взагалі. Явна перевірка surface, а не просто
       «є subject_date» — щоб майбутнє джерело з датою не засвітило календар
       мовчки. */
    if (m.subject_date && m.surface_key === "queue") push(byDate, m.subject_date, m);
  }
  return { all, bySurface, byEntity, byField, byDate };
}

export const EMPTY_INDEX: UnreadIndex = {
  all: [],
  bySurface: new Map(),
  byEntity: new Map(),
  byField: new Map(),
  byDate: new Map(),
};

/* ─────────────────────────── Селектори ─────────────────────────────────
   Батьківські індикатори ВИВОДЯТЬСЯ з дітей і згасають лише тоді, коли не
   лишилось жодної непрочитаної дитини (вимога ТЗ). Окремого стану для
   секції немає за побудовою — його неможливо розсинхронити. */

export const unreadForSurface = (ix: UnreadIndex, s: SurfaceKey): ChangeMarker[] =>
  ix.bySurface.get(s) ?? [];

export const unreadForEntity = (
  ix: UnreadIndex, entityType: string, entityId: string
): ChangeMarker[] => ix.byEntity.get(entityKey(entityType, entityId)) ?? [];

export const unreadForField = (
  ix: UnreadIndex, entityType: string, entityId: string, scope: FieldScope
): ChangeMarker[] => ix.byField.get(fieldKey(entityType, entityId, scope)) ?? [];

export const hasUnreadSurface = (ix: UnreadIndex, s: SurfaceKey): boolean =>
  (ix.bySurface.get(s)?.length ?? 0) > 0;

export const hasUnreadEntity = (ix: UnreadIndex, entityType: string, entityId: string): boolean =>
  (ix.byEntity.get(entityKey(entityType, entityId))?.length ?? 0) > 0;

export const hasUnreadField = (
  ix: UnreadIndex, entityType: string, entityId: string, scope: FieldScope
): boolean => (ix.byField.get(fieldKey(entityType, entityId, scope))?.length ?? 0) > 0;

/* ── Календар (0133) ──────────────────────────────────────────────────────
   dayKey — «YYYY-MM-DD» у ЛОКАЛЬНИХ полях дати, а не ISO-зріз UTC:
   `scheduled_date` у БД — тип `date` без зони, і саме так його форматує
   міні-календар. `toISOString().slice(0,10)` тут дав би зсув на добу для
   зон на схід від UTC — рівно та помилка, від якої застерігає правило
   «час — лише через wallNow/wallDayKey». */
export const calendarDayKey = (d: Date): string =>
  d.getFullYear() + "-" +
  String(d.getMonth() + 1).padStart(2, "0") + "-" +
  String(d.getDate()).padStart(2, "0");

/** ⚠️ clinicId ОБОВʼЯЗКОВИЙ для мультицентрових екранів (ревʼю 0133, M-4).
    Портал направника показує календар ОДНОГО обраного центру, а позначки в
    нього приходять з усіх — без фільтра крапка від центру Б світилась би на
    календарі центру А, і погасити її звідти неможливо. Персоналу центру
    можна не передавати: у нього позначки лише своєї клініки. */
export const unreadForDate = (
  ix: UnreadIndex, dayKey: string, clinicId?: string | null
): ChangeMarker[] => {
  const day = ix.byDate.get(dayKey) ?? [];
  return clinicId ? day.filter((m) => m.clinic_id === clinicId) : day;
};

export const hasUnreadDate = (
  ix: UnreadIndex, dayKey: string, clinicId?: string | null
): boolean => unreadForDate(ix, dayKey, clinicId).length > 0;

const SEVERITY_RANK: Record<MarkerSeverity, number> = { info: 0, important: 1, critical: 2 };

/** Найвища важливість серед позначок (для стилю крапки). */
export function topSeverity(markers: readonly ChangeMarker[]): MarkerSeverity | null {
  let best: MarkerSeverity | null = null;
  for (const m of markers) {
    if (best === null || SEVERITY_RANK[m.severity] > SEVERITY_RANK[best]) best = m.severity;
  }
  return best;
}

/* ────────────────── Підтвердження прочитання (ack) ─────────────────────── */

export type AckScope =
  | { kind: "surface"; surface: SurfaceKey }
  | { kind: "entity"; entityType: string; entityId: string }
  | { kind: "field"; entityType: string; entityId: string; scope: FieldScope };

/**
 * Які саме id підтверджувати. Ключове правило ТЗ: підтверджується ЛИШЕ те,
 * що входило у ВІДРЕНДЕРЕНИЙ знімок.
 *
 * ⚠️ Тому функція приймає `snapshotIds` — набір id, які клієнт реально
 * отримав і показав. Позначка, що приїхала ПІСЛЯ знімка (realtime встиг
 * доставити нову між fetch-ем і кліком), у ньому відсутня і лишається
 * непрочитаною. Це сценарій 1 ТЗ, і без явного знімка він не закривається:
 * «підтвердити все, що зараз в індексі» мовчки з'їдало б свіжу зміну.
 *
 * Порожній результат — легальний і означає «підтверджувати нічого».
 */
export function ackIdsForScope(
  ix: UnreadIndex,
  scope: AckScope,
  snapshotIds: ReadonlySet<string>
): string[] {
  const pool =
    scope.kind === "surface"
      ? unreadForSurface(ix, scope.surface)
      : scope.kind === "entity"
        ? unreadForEntity(ix, scope.entityType, scope.entityId)
        : unreadForField(ix, scope.entityType, scope.entityId, scope.scope);

  return pool.filter((m) => snapshotIds.has(m.id)).map((m) => m.id);
}

/**
 * Знімок = множина id позначок, які прийшли останнім УСПІШНИМ завантаженням.
 * Помилкове завантаження знімок НЕ оновлює (ТЗ: «If loading fails, unread
 * state must remain unchanged»).
 */
export const snapshotIdsOf = (markers: readonly ChangeMarker[]): Set<string> =>
  new Set(markers.map((m) => m.id));

/**
 * Відбиток УСПІШНО завантаженого списку поверхні — значення для `refreezeKey`
 * (`useAckWhenVisible`, рішення с28).
 *
 * Навіщо окрема функція, а не IIFE в компоненті: постійно видима поверхня
 * гасить рівно те, що застало заморозку, тож правильність ключа — це і є
 * правильність механіки крапок. Компонентних тестів у проєкті немає (аудит
 * L-2), а тут вона перевіряється ВИКЛИКОМ.
 *
 * ⚠️ СОРТУВАННЯ обовʼязкове. Масив на екрані пересортовується сам (у листі
 * очікування рядок зі статусом `waiting` іде наверх), а PostgREST без
 * ORDER BY порядку не гарантує — без сортування «той самий склад» давав би
 * ложні перезаморозки, тобто ack без жодної нової інформації на екрані
 * (ревʼю с28-р1, M-1).
 * ⚠️ `updated_at` у складі відбитка — щоб ключ ловив БУДЬ-ЯКУ показану правку
 * (пріоритет, дані пацієнта, перелік послуг), а не лише статус: у БД його
 * веде тригер `touch_updated_at` (`now()` на КОЖЕН UPDATE), тож він рухається
 * рівно тоді, коли рядок змінився. Рядки без цих полів дають порожній
 * компонент — відбиток лишається валідним, просто грубішим.
 * ⚠️ Поля кодуються через JSON, а не склеюються двокрапкою: склейка робить
 * склад НЕОДНОЗНАЧНИМ (`id="a"`+`status="b:c"` і `id="a:b"`+`status="c"` дають
 * той самий рядок), тобто дві різні поверхні могли б виявитись «тією самою» і
 * перезаморозка не сталась би. Домен сьогодні таких значень не має (uuid і
 * enum), але ключ, правильність якого тримається на формі даних, — це сторож
 * із мовчазною межею.
 */
export function surfaceListFingerprint(
  rows: ReadonlyArray<{ id: string; status?: string | null; updated_at?: string | null }> | null | undefined
): string {
  return (rows ?? [])
    .filter((r) => r && r.id)
    .map((r) => JSON.stringify([r.id, r.status ?? "", r.updated_at ?? ""]))
    .sort()
    .join("|");
}

export type SurfaceRow = { id: string; status?: string | null; updated_at?: string | null };

/**
 * Повний ключ перезаморозки поверхні: відбиток списку ПЛЮС ті позначки, які
 * показаний рядок уже ВІДОБРАЖАЄ.
 *
 * Навіщо друга половина. Позначка і зміна рядка народжуються ОДНІЄЮ
 * транзакцією, але клієнт тягне їх двома незалежними каналами, тож порядок
 * приземлення не визначений:
 *   • позначка прийшла ПЕРШОЮ (рядок ще старий) — перезаморозка не потрібна і
 *     навіть шкідлива: ack погасив би крапку по списку, який ще не оновився
 *     (це дефект F4-3);
 *   • позначка прийшла ДРУГОЮ (рядок уже новий) — відбиток списку змінився
 *     ДО її появи, і без другої половини ключа вона висіла б на актуальному
 *     рядку, поки лікар не піде на іншу вкладку й не повернеться. Клік по вже
 *     активному пункту меню не рятує: `setTab` тим самим значенням не
 *     розмонтовує компонент (знахідка ревʼю р.1).
 *
 * Розрізняє ці два випадки ЧАС: `now()` у транзакції один, тому
 * `user_change_markers.created_at` (default `now()`) і `updated_at` рядка
 * (тригер `touch_updated_at`, теж `now()`) для однієї зміни РІВНІ. Отже
 * `marker.created_at <= row.updated_at` означає «показаний рядок уже містить
 * те, про що позначка», і тільки такі позначки входять у ключ.
 *
 * ⚠️ Порівнюємо мілісекунди через `Date.parse`, а не рядки: PostgREST віддає
 * timestamptz зі ЗМІННОЮ довжиною дробової частини (`…:00+00:00` і
 * `…:00.123456+00:00`), і лексикографічне порівняння тут трималося б на
 * випадковому порядку символів `+` і `.`. Мілісекундне зрізання не шкодить —
 * значення однієї транзакції лишаються рівними.
 * ⚠️ Залишковий випадок, свідомо НЕ закритий: перезаморозка гасить УСЮ
 * поверхню (так влаштований `ackIdsForScope`), тож «дозріла» позначка одного
 * рядка гасить і «недозрілу» позначку іншого, якщо той змінився ОКРЕМОЮ,
 * пізнішою транзакцією і його оновлення ще не приземлилось. Вікно — один
 * дебаунс плюс round-trip; закрити його можна лише звузивши ack до конкретних
 * id, а це вже правка спільного хука.
 */
export function surfaceRefreezeKey(
  rows: ReadonlyArray<SurfaceRow> | null | undefined,
  surfaceMarkers: readonly ChangeMarker[]
): string {
  const shownAt = new Map<string, number>();
  for (const r of rows ?? []) {
    if (!r || !r.id) continue;
    shownAt.set(r.id, r.updated_at ? Date.parse(r.updated_at) : NaN);
  }
  const settled = surfaceMarkers
    .filter((m) => {
      const shown = shownAt.get(m.entity_id);
      if (shown === undefined || !Number.isFinite(shown)) return false;
      const born = Date.parse(m.created_at);
      return Number.isFinite(born) && born <= shown;
    })
    .map((m) => m.id)
    .sort()
    .join(",");
  return surfaceListFingerprint(rows) + "#" + settled;
}

/* ─────────────────────── Українські формулювання ───────────────────────── */

const FIELD_SCOPE_TEXT: Record<FieldScope, string> = {
  record: "запис",
  schedule: "дата, час або кабінет",
  studies: "перелік послуг",
  patient_data: "дані пацієнта",
  status: "статус",
  priority: "пріоритет",
  catalog: "каталог послуг",
  room_override: "ціни кабінету",
  access: "доступ до центру",
  case_step: "етап комплексного дослідження",
  incident: "простій кабінету",
};

const ACTOR_ROLE_TEXT: Record<string, string> = {
  admin: "адміністратор",
  registrar: "реєстратор",
  radiologist: "радіолог",
  referrer: "лікар-направник",
  ceo: "керівник",
  system: "система",
};

/* Scope `schedule` покриває пʼять колонок (дзеркало списку в тригері 0132),
   і назвати їх усі одним текстом чесно не виходить: жива перевірка с28
   показала, що зміна САМОЇ тривалості (направник додав дослідження) давала
   крапку «дата, час або кабінет» — жодне з трьох не мінялось. Тому текст
   виводимо з `changed_fields`; згортання накопичує обʼєднання полів за всі
   непобачені правки, тож перелік лишається чесним і для згорнутої крапки.
   Порожній/невідомий список → загальний фолбек (старі позначки, майбутні
   поля). Порядок — фіксований, як у тригері. */
const SCHEDULE_FIELD_TEXT: ReadonlyArray<readonly [string, string]> = [
  ["scheduled_date", "дата"],
  ["scheduled_time", "час"],
  ["room_id", "кабінет"],
  ["duration_min", "тривалість"],
  ["buffer_time_min", "буфер"],
];

export function scheduleScopeText(changed: readonly string[] | null | undefined): string {
  if (!changed || !changed.length) return FIELD_SCOPE_TEXT.schedule;
  const parts = SCHEDULE_FIELD_TEXT.filter(([f]) => changed.includes(f)).map(([, t]) => t);
  return parts.length ? parts.join(", ") : FIELD_SCOPE_TEXT.schedule;
}

/** ЩО саме змінилось — без «хто» і без обгортки. Винесено, щоб груповий підпис
 *  міг перелічити напрями змін, не розбираючи готове речення рядковими
 *  операціями (с48, U-30). */
export function markerWhat(m: ChangeMarker): string {
  return m.field_scope === "schedule"
    ? scheduleScopeText(m.changed_fields)
    : FIELD_SCOPE_TEXT[m.field_scope] ?? "інформація";
}

/** Доступне імʼя однієї крапки: ХТО і ЩО змінив, без PII. */
export function markerLabel(m: ChangeMarker): string {
  const who = ACTOR_ROLE_TEXT[m.actor_role] ?? "інший користувач";
  return `Змінено іншим користувачем: ${markerWhat(m)} (${who})`;
}

/**
 * Доступне імʼя ГРУПИ крапок (картка, секція, пункт навігації).
 * ⚠️ Крапка не має передавати стан лише кольором (WCAG 1.4.1 і правило
 * проекту «статус — глифом І кольором»), тому текст обовʼязковий, а не
 * «на всяк випадок».
 */
export function unreadGroupLabel(markers: readonly ChangeMarker[]): string {
  const n = markers.length;
  if (n === 0) return "";
  if (n === 1) return markerLabel(markers[0]);
  return `Є непрочитані зміни: ${n}`;
}

/**
 * Імʼя крапки, що показує ЧИСЛО (пункт навігації, шапка секції) — с48, U-30.
 *
 * ⚠️ Чому окремо від `unreadGroupLabel`. Коли на екрані видно цифру, підпис
 * мусить починатися з того ж, що й цифра, інакше бейдж «1» читається як
 * лічильник СУТНОСТЕЙ — рівно так, як «Лист очікування 1» поруч. Власник саме
 * на цьому й спіткнувся: червона позначка не була розпізнана як «непрочитана
 * чужа правка».
 *
 * Далі — ЩО саме змінилось. На пункті навігації це єдине місце, де людина може
 * дізнатись причину, не переходячи на дошку, тож хвіст додаємо і для однієї
 * позначки, і для кількох (для кількох — перелік НАПРЯМІВ без повторів,
 * не більше трьох, інакше підпис перетворюється на абзац).
 *
 * ⚠️ Це СВІДОМА відмінність від MiniCalendar, а не «той самий принцип» — так
 * було написано в першій версії коментаря, і ревʼю справедливо назвало це
 * підміною. Календар навмисно НЕ називає напрям: `markerWhat` описує блок поля
 * («перелік послуг»), якого в контексті ДНЯ не існує. Пункт навігації —
 * протилежний випадок: він веде саме на ту дошку, де цей блок є, тож назвати
 * напрям тут корисно, а не збиває.
 */
export function unreadNavLabel(markers: readonly ChangeMarker[]): string {
  const n = markers.length;
  if (n === 0) return "";
  const head = `Є непрочитані зміни: ${n}`;
  if (n === 1) return `${head} — ${markerLabel(markers[0])}`;
  /* ⚠️ Роздільник — « · », а НЕ кома (ревʼю р2). `markerWhat` для scope
     `schedule` сам повертає рядок із комами («дата, час або кабінет»), тож
     кома між напрямами зливалась із комами ВСЕРЕДИНІ напряму: «дата, час,
     кабінет, тривалість» читалось як чотири напрями і збігалося з підписом
     зовсім іншого стану. « · » уже вживається як роздільник напрямів у
     MiniCalendar — беремо той самий. */
  const order = { critical: 0, important: 1, info: 2 } as const;
  const whats = [...new Set(
    [...markers]
      .sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3))
      .map(markerWhat),
  )];
  return `${head} — ${whats.slice(0, 3).join(" · ")}${whats.length > 3 ? " …" : ""}`;
}

/* ───────────────── Навігація: surface → пункт бокової панелі ─────────────
   Один список замість розкиданих рядків по компонентах (вимога ТЗ
   «Do not scatter raw string values across React components»). */

export const SURFACE_BY_NAV: Record<string, SurfaceKey[]> = {
  queue: ["queue", "incidents"],
  waitlist: ["waitlist"],
  ref: ["referrals"],
  centers: ["centers"],
  /* с42: прибрано мертві ключі calls/services/staff/cases — жоден Sidebar їх не
     питав (перевірено грепом unreadForNav/hasUnreadNav), а «крапка на пункті
     без крапки» вводила в оману при читанні карти. Невідомий ключ і далі дає
     false/[] — новий пункт навігації додається сюди, а не рядком у компоненті. */
};

export function hasUnreadNav(ix: UnreadIndex, navKey: string): boolean {
  const surfaces = SURFACE_BY_NAV[navKey];
  if (!surfaces) return false;
  return surfaces.some((s) => hasUnreadSurface(ix, s));
}

export function unreadForNav(ix: UnreadIndex, navKey: string): ChangeMarker[] {
  const surfaces = SURFACE_BY_NAV[navKey];
  if (!surfaces) return [];
  return surfaces.flatMap((s) => unreadForSurface(ix, s));
}
