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

/** Доступне імʼя однієї крапки: ХТО і ЩО змінив, без PII. */
export function markerLabel(m: ChangeMarker): string {
  const who = ACTOR_ROLE_TEXT[m.actor_role] ?? "інший користувач";
  const what = FIELD_SCOPE_TEXT[m.field_scope] ?? "інформація";
  return `Змінено іншим користувачем: ${what} (${who})`;
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

/* ───────────────── Навігація: surface → пункт бокової панелі ─────────────
   Один список замість розкиданих рядків по компонентах (вимога ТЗ
   «Do not scatter raw string values across React components»). */

export const SURFACE_BY_NAV: Record<string, SurfaceKey[]> = {
  queue: ["queue", "incidents"],
  waitlist: ["waitlist"],
  calls: ["queue"],
  services: ["services", "rooms", "schedule"],
  ref: ["referrals"],
  staff: ["staff"],
  centers: ["centers"],
  cases: ["cases"],
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
