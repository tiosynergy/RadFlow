/* ===== Хто бачить дашборд CEO і які центри в його області (с79, Н-10) =====

   ЧИСТЕ правило без БД — для роуту CSV (app/api/ceo/export). До с79 клієнт
   експорту просто брав `clinicIds` із пропсів сторінки /ceo; коли CSV
   переїхав на сервер, роуту знадобилось ТЕ САМЕ правило, що гейтить сторінку.

   ⚠️ ЧОМУ СТОРІНКА НЕ КЛИЧЕ ЦЮ ФУНКЦІЮ. Гейт сторінки пінить сторож
   tests/authSurface.test.ts — він навмисно читає гейт із ДЖЕРЕЛА сторінки
   («закриваючий позитив виводиться з коду, а не оголошується»). Перенести
   правило сюди означало б послабити цього сторожа. Тому сторінка лишилась як
   була, а від розходження двох записів правила стереже ДИФЕРЕНЦІЙНИЙ тест
   (tests/ceoExportRoute.test.ts): він викликає СПРАВЖНЮ сторінку і цю функцію
   на тих самих входах і вимагає однакового вердикту й однакового переліку
   центрів. Правка ролей в одному місці без другого — червоний тест, а не
   тихо розʼїханий файл (урок M-7: сім копій формули `room_ids`).

   Правило (дослівно те, що робить сторінка):
     • центри = активні гранти `ceo_access` цього користувача (у порядку, в
       якому їх віддала БД) + ВЛАСНИЙ центр адміна (адмін бачить дашборд свого
       центру); дубль центру схлопується, позиція лишається першою;
     • бачать: admin, ceo — завжди (CEO без грантів бачить порожній дашборд);
       БУДЬ-ЯКА інша роль — лише з хоча б одним активним грантом (радіолог чи
       реєстратор, який «ще й CEO»; роль при цьому не міняється);
     • адмін із ненастроєним власним центром дашборда не бачить (сторінка веде
       його в майстер /setup) — і роут експорту теж відмовляє. */

export type CeoClinic = { id: string; name: string; timezone: string };

export type CeoAccessInput = {
  role: string | null | undefined;
  /** profiles.clinic_id — власний центр (у персоналу). */
  clinicId: string | null | undefined;
  /** Рядок власного центру (для адміна): назва, зона, чи пройдено майстер. */
  ownClinic?: { name?: string | null; timezone?: string | null; configured_at?: string | null } | null;
  /** Активні гранти ceo_access — у порядку, в якому їх віддала БД. */
  grants: ReadonlyArray<{ clinicId: string | null | undefined; name?: string | null; timezone?: string | null }>;
};

export type CeoAccess =
  | { ok: true; clinics: CeoClinic[] }
  | { ok: false; reason: "forbidden" | "setup" };

export function ceoDashboardAccess(input: CeoAccessInput): CeoAccess {
  // Зона кожного центру потрібна дашборду: «сьогодні»/«тиждень» рахуються за
  // часом ЦЕНТРУ, а не браузера керівника (він може дивитися центр з іншої зони).
  const map = new Map<string, { name: string; timezone: string }>();
  for (const g of input.grants) {
    if (g.clinicId) map.set(g.clinicId, { name: g.name ?? "Центр", timezone: g.timezone || "UTC" });
  }
  // Адмін центру також бачить дашборд свого центру.
  if (input.role === "admin" && input.clinicId) {
    map.set(input.clinicId, { name: input.ownClinic?.name ?? "Центр", timezone: input.ownClinic?.timezone || "UTC" });
  }
  const allowed = input.role === "admin" || input.role === "ceo" || map.size > 0;
  if (!allowed) return { ok: false, reason: "forbidden" };
  // Майстер налаштування — лише для адміна з ненастроєним власним центром.
  if (input.role === "admin" && input.ownClinic && !input.ownClinic.configured_at) return { ok: false, reason: "setup" };
  return { ok: true, clinics: Array.from(map, ([id, c]) => ({ id, name: c.name, timezone: c.timezone })) };
}

/** Зона, за якою рахується «сьогодні»/«цей тиждень»: обраного центру, а при
    «Всі центри» — центру з НАЙМЕНШИМ id. Спільної доби в кількох зонах не
    існує, тож вибір довільний — але він мусить бути однаковим на екрані (KPI)
    і в роуті експорту (CSV), інакше файл описав би не той період, що картки.
    ⚠️ Ревʼю с79 (L-3): до цього бралась «перша» зона, а порядок центрів —
    це порядок рядків ceo_access БЕЗ order by, і сторінка та роут читають їх
    РІЗНИМИ запитами. Найменший id від порядку не залежить; порядок у
    перемикачі центрів (і гейт сторінки) при цьому не змінився. */
export function ceoScopeTz(clinics: ReadonlyArray<{ id: string; timezone?: string | null }>, scope: string): string | undefined {
  const c = scope !== "all"
    ? clinics.find((x) => x.id === scope)
    : clinics.reduce<{ id: string; timezone?: string | null } | undefined>(
        (min, x) => (!min || x.id.toLowerCase() < min.id.toLowerCase() ? x : min),
        undefined
      );
  return c?.timezone || undefined;
}
