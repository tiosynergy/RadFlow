/**
 * RF-03b (0184) — позначка про зміну графіка дня для направника.
 *
 * ЩО СТАЛОСЬ. 0183 зняла політику `sched_referrer_read`, а разом із нею —
 * realtime на `schedule_overrides`: Supabase доставляє рядок лише тому, кому
 * його дозволяє RLS. Ціна була названа вголос — до 30 с затримки на тику
 * `pollWhenSubscribedMs`. 0184 повертає миттєвість каналом ПОЗНАЧОК.
 *
 * ЧОМУ ЦЕЙ ФАЙЛ ІСНУЄ. Заміряно на проді 09.09.2026: у тілі
 * `invariants_check` рядок `change_marker_recipients` трапляється НУЛЬ разів
 * (зелений базис тим самим запитом: `sched_override_read` — 3,
 * `handle_new_user` — 5). Тобто нову гілку віяла не тримає ЖОДЕН інваріант
 * бази. Тримає вона, і ось цей файл — єдиний сторож над нею з боку дерева.
 *
 * ⚠️ МЕЖА, НАЗВАНА ВГОЛОС. Перевірки над SQL тут СТАТИЧНІ — vitest у цьому
 *    проєкті ходить у node-середовищі й до БД не дотягується за побудовою
 *    (`vitest.config.ts`, environment: "node"). Поведінкова частина живе в
 *    смоуку самої міграції (розділи 4 і 5), який зве `change_marker_recipients`
 *    на живих даних у ОБИДВА боки і має власний ЗЕЛЕНИЙ БАЗИС
 *    (`scope_kind='entry'` мусить повернути персонал, інакше нуль у
 *    `scope_kind='schedule'` нічого не доводить).
 *    Клієнтська частина нижче — навпаки, ПОВЕДІНКОВА: чисті функції звемо.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { codeOf } from "./helpers/codeOf";
import {
  indexMarkers, markerWhat, markerLabel,
  hasUnreadNav, unreadForNav, unreadForSurface, SURFACE_BY_NAV,
  type ChangeMarker,
} from "@/lib/unreadChanges";
import { schedAckKeyOf } from "@/lib/ackVisibility";

const raw = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
/** ⚠️ `codeOf` знімає коментарі: пояснення в самих екранах не сміють тримати
    сторожа зеленим. Перевіряємо КОД, а не прозу про нього. */
const src = (p: string) => codeOf(raw(p));
/** Те, що в SQL СПРАВДІ виконується. Урок стенда 0183 (мутація A7): сторож,
    який читає весь текст файла, лишається зеленим і тоді, коли робочий
    statement закоментували, — бо в секції ВІДКАТ той самий рядок лежить під
    `--`. Сторож, зелений на знятому запобіжнику, — знятий сторож.
    ⚠️ ПЕРША РЕДАКЦІЯ ЦЬОГО ХЕЛПЕРА ЗНІМАЛА ЛИШЕ РЯДКИ, ЩО ПОЧИНАЮТЬСЯ З `--`,
       і ревʼю слушно назвало це блокером: предикат, обгорнутий У БЛОКОВИЙ
       коментар, і предикат, знешкоджений ХВОСТОВИМ `--` після `and true`,
       обидва лишали пін зеленим, а сам предикат — знятим. У цьому файлі
       блокові коментарі це рідний стиль, тож ризик був не теоретичний.
       Тепер знімаємо ОБИДВІ форми, як `codeOf` робить для TSX. Обидві
       перевірені ПОВЕДІНКОЮ нижче — інструмент теж мусить мати базис. */
export function stripSql(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
}
const liveSql = (p: string) => stripSql(raw(p));

const MIG = "supabase/migrations/0184_rf03b_sched_marker_fanout.sql";

let seq = 0;
function marker(over: Partial<ChangeMarker> = {}): ChangeMarker {
  seq += 1;
  return {
    id: over.id ?? `sm${seq}`,
    clinic_id: "c1",
    event_type: "schedule.override_changed",
    surface_key: "schedule",
    entity_type: "room",
    entity_id: "r1",
    field_scope: "schedule",
    actor_id: "a1",
    actor_role: "admin",
    subject_referrer_id: null,
    room_id: "r1",
    severity: "important",
    changed_fields: null,
    details: null,
    created_at: "2026-09-09T10:00:00.000Z",
    seen_at: null,
    subject_date: null,
    ...over,
  };
}

describe("0184: підпис крапки не бреше про неіснуючий запис", () => {
  /* `field_scope='schedule'` уже мав значення «дата, час або кабінет» — це про
     рядок ЧЕРГИ. Взявши те саме значення для графіка дня, ми отримали б підпис
     про запис, якого не існує. Розрізняє їх ПОВЕРХНЯ. */
  it("поверхня schedule дає підпис про графік, а не про запис", () => {
    expect(markerWhat(marker())).toBe("графік центру");
  });

  /* ⚠️ ДАТА І КАБІНЕТ У ПІДПИСІ — це лікування блокера, знайденого ревʼю
     (лінза «досвід живої людини»): ack на цій поверхні поверхневий, тож
     крапка гасне на відкритті БУДЬ-ЯКОГО дня. Крапка без дати гасла раніше,
     ніж людина встигала дізнатись, ЩО змінилось, — і новина зникала
     назавжди (журналу в направника немає, ретенція чистить лише прочитане). */
  it("підпис несе ДАТУ, коли вона в позначці є", () => {
    expect(markerWhat(marker({ subject_date: "2026-09-12" }))).toBe("графік центру на 12.09");
  });

  it("підпис розрізняє кабінет і центр за якорем деталей", () => {
    expect(markerWhat(marker({ details: { roomId: "r1" }, subject_date: "2026-09-12" })))
      .toBe("графік кабінету на 12.09");
  });

  it("зняття особливого графіка має ВЛАСНИЙ підпис", () => {
    expect(markerWhat(marker({ event_type: "schedule.override_cleared", subject_date: "2026-09-12" })))
      .toBe("особливий графік центру на 12.09 знято");
  });

  it("зіпсована дата підпис не ламає (fail-soft)", () => {
    expect(markerWhat(marker({ subject_date: "12/09/2026" }))).toBe("графік центру");
  });

  it("рядок ЧЕРГИ з тим самим field_scope підпису НЕ змінив (регресія)", () => {
    const q = marker({ surface_key: "queue", entity_type: "queue_entry", field_scope: "schedule" });
    expect(markerWhat(q)).not.toBe("графік центру");
    expect(markerWhat(q)).toBe("дата, час або кабінет");
  });

  it("markerLabel обгортає новий текст і називає роль", () => {
    expect(markerLabel(marker({ subject_date: "2026-09-12" }))).toBe(
      "Змінено іншим користувачем: графік центру на 12.09 (адміністратор)",
    );
  });
});

describe("0184: крапка світиться на пункті, куди веде ack", () => {
  it("SURFACE_BY_NAV.new веде рівно на schedule", () => {
    expect(SURFACE_BY_NAV.new).toEqual(["schedule"]);
  });

  it("unreadForNav('new') бере позначку графіка — ПОВЕДІНКОЮ, не регуляркою", () => {
    const ix = indexMarkers([marker()]);
    expect(hasUnreadNav(ix, "new")).toBe(true);
    expect(unreadForNav(ix, "new")).toHaveLength(1);
    expect(unreadForSurface(ix, "schedule")).toHaveLength(1);
  });

  it("чужа поверхня на цей пункт НЕ світить (негативний контроль)", () => {
    const ix = indexMarkers([marker({ surface_key: "queue", entity_type: "queue_entry" })]);
    expect(hasUnreadNav(ix, "new")).toBe(false);
    expect(unreadForNav(ix, "new")).toEqual([]);
  });

  it("прочитана позначка пункт не світить", () => {
    const ix = indexMarkers([marker({ seen_at: "2026-09-09T11:00:00.000Z" })]);
    expect(hasUnreadNav(ix, "new")).toBe(false);
  });

  /* Рішення `indexMarkers` — «у календар пускаємо ЛИШЕ чергу» — свідоме, з
     власним коментарем «щоб майбутнє джерело з датою не засвітило календар
     мовчки». 0184 і є те саме майбутнє джерело: воно НЕСЕ subject_date.
     Пін тримає рішення від тихого розширення в обидва боки. */
  it("календар позначкою графіка НЕ світиться, хоч дата в ній є", () => {
    const ix = indexMarkers([marker({ subject_date: "2026-09-12" })]);
    expect(ix.byDate.size).toBe(0);
  });

  it("а черга з датою календар світить (базис: перевірка вище не порожня)", () => {
    const ix = indexMarkers([
      marker({ surface_key: "queue", entity_type: "queue_entry", subject_date: "2026-09-12" }),
    ]);
    expect(ix.byDate.size).toBe(1);
  });
});

describe("0184: ack існує РІВНО там, куди веде пункт меню", () => {
  const portal = src("components/ReferralPortal.tsx");
  const sidebar = src("components/ReferrerSidebar.tsx");

  /** Витягуємо САМЕ той виклик, а не «десь у файлі є ці слова»: пін по
      ПРИСУТНОСТІ ловився дев'ять разів за сесії 58–59. */
  /* ⚠️ Без прапорця `s`: `[^;]` і так збігається з переводом рядка, а сам
     прапорець заборонений цільовим рівнем TS у цьому проєкті — це впіймав
     tsc, якого vitest не бачить (урок пакета 39). */
  const ACK_CALL = /useAckWhenVisible\(\s*[^;]*?surface:\s*"schedule"[^;]*?\);/;

  it("ReferralPortal має ack для поверхні schedule", () => {
    expect(ACK_CALL.test(portal), "виклику ack для schedule немає").toBe(true);
  });

  it("у ЦЬОГО виклику є третій аргумент — ключ перезаморозки", () => {
    /* Без refreezeKey заморозка береться один раз, і позначка, що прилетіла
       пізніше, не гасне до F5 — рівно борг поверхні `services`. Пін по МІСЦЮ:
       дивимось усередину знайденого виклику, а не по всьому файлу. */
    const call = portal.match(ACK_CALL);
    expect(call, "виклик не знайдено").toBeTruthy();
    expect(/schedAckKey/.test(call![0]), "третього аргументу немає").toBe(true);
  });

  it("екран будує ключ спільною функцією, а не інлайном", () => {
    /* Інлайновий ключ можна було вихолостити (викинути `override`), і всі
       лексичні піни лишались зеленими — пін тримав лише ІМʼЯ змінної.
       Тепер ключ це чиста функція, і її поведінка прибита нижче. */
    expect(/schedAckKey\s*=\s*useMemo\([^;]*schedAckKeyOf\(\{[^;]*override,[^;]*loadFailed: slotsErr/.test(portal)).toBe(true);
  });

  it("ack не спрацьовує без центру, без КАБІНЕТУ і при помилці", () => {
    /* `roomId` тут не косметика: без обраного кабінету на екрані про графік
       не сказано нічого (сітка й усі три вердикти заперті на `roomId`), а
       крапки поверхні вже гасяться. Знахідка другого ревʼю. */
    const call = portal.match(ACK_CALL);
    expect(/!!centerId\s*&&\s*!!roomId\s*&&\s*!slotsErr\s*&&\s*!slotsLoading/.test(call![0])).toBe(true);
  });

  it("ReferrerSidebar питає позначки для пункту 'new'", () => {
    expect(/key === "new"\s*\?\s*unreadForNav\(unreadIx,\s*"new"\)/.test(sidebar)).toBe(true);
  });

  it("сторож розрізняє дві форми (перевірка ПОВЕДІНКОЮ інструмента)", () => {
    /* Без цього обидві регулярки могли б бути зламані й мовчазно зеленими —
       рівно та пастка, за яку переписали readErrorTrust. */
    expect(ACK_CALL.test('useAckWhenVisible({ kind: "surface", surface: "schedule" }, ok, k);')).toBe(true);
    expect(ACK_CALL.test('useAckWhenVisible({ kind: "surface", surface: "waitlist" }, ok, k);')).toBe(false);
  });
});

describe("0184: віяло в базі — аудиторію звужено, а не розширено", () => {
  const sql = liveSql(MIG);

  it("базис: у файлі є що читати", () => {
    expect(sql.length).toBeGreaterThan(2000);
    expect(/change_marker_recipients/.test(sql)).toBe(true);
  });

  it("інструмент stripSql знімає ОБИДВІ форми коментарів (перевірка ПОВЕДІНКОЮ)", () => {
    /* Без цього самі пони нижче могли б бути обійдені знешкодженням предиката
       коментарем — рівно блокер, знайдений ревʼю. */
    expect(stripSql("and pr.approved").includes("pr.approved")).toBe(true);   // базис
    expect(stripSql("/* and pr.approved */").includes("pr.approved")).toBe(false);
    expect(stripSql("and true  -- pr.approved").includes("pr.approved")).toBe(false);
    expect(stripSql("  -- and pr.approved").includes("pr.approved")).toBe(false);
    expect(stripSql("/* multi\n and pr.approved\n */").includes("pr.approved")).toBe(false);
  });

  /* ⚠️ Кожен зріз мусить ЗНАЙТИ свої межі. Без цих асертів перейменування CTE
     (звичайний рефактор) перетворює `slice(indexOf(a), indexOf(b))` з
     indexOf === -1 на «майже весь файл», і пін по МІСЦЮ мовчки вироджується
     назад у пін по ПРИСУТНОСТІ — тобто стає слабшим, ніж у день написання,
     і про це не червоніє ніщо. Знахідка ревʼю. */
  const boundedSlice = (from: string, to: string) => {
    const a = sql.indexOf(from);
    const b = sql.indexOf(to);
    /* ⚠️ `throw`, а не `expect`: цей хелпер зветься і на етапі збирання
       describe (для `fanout`), а `expect` поза тестом вітест не приймає. */
    if (a < 0) throw new Error(`0184: межа зрізу не знайдена: ${from}`);
    if (b <= a) throw new Error(`0184: межа зрізу не знайдена або переставлена: ${to}`);
    return sql.slice(a, b);
  };

  it("веяло прибите до СВОЄЇ клініки", () => {
    /* Без цього предиката віяло віддає активних підтверджених направників
       УСІХ клінік: RLS позначок тримається на recipient_id, не на клініці.
       Кросс-тенантний сигнал — той самий клас, що U-61 і 0177. */
    expect(/ra\.clinic_id = p_clinic/.test(boundedSlice("sched_referrers as (", "select distinct s.id"))).toBe(true);
  });

  /** Кожен виклик емітера окремим шматком: пін по МІСЦЮ, а не «десь у файлі». */
  const emitBlocks = sql.split("perform public.emit_change_markers(").slice(1);

  it("викликів емітера рівно два — денний і кабінетний", () => {
    /* Третій, ніким не прибитий виклик інакше додається мовчки. */
    expect(emitBlocks).toHaveLength(2);
  });

  it.each([0, 1])("виклик емітера #%i несе саме ті аргументи, від яких залежить аудиторія", (i) => {
    /* ⚠️ Найтихіша з усіх мутацій: `p_scope_kind => 'entry'` розвертає
       аудиторію на персонал (непогасима крапка) і лишає направника без
       нічого — а всі клієнтські тести будують позначку РУКАМИ і про це не
       знають. Знахідка ревʼю. */
    const b = emitBlocks[i].slice(0, emitBlocks[i].indexOf(");"));
    expect(/p_surface\s*=>\s*'schedule'/.test(b), "p_surface").toBe(true);
    expect(/p_scope_kind\s*=>\s*'schedule'/.test(b), "p_scope_kind").toBe(true);
    expect(/p_field_scope\s*=>\s*'schedule'/.test(b), "p_field_scope").toBe(true);
    expect(/p_entity_type\s*=>\s*'room'/.test(b), "p_entity_type").toBe(true);
    expect(/p_room_relevant\s*=>\s*false/.test(b), "p_room_relevant").toBe(true);
    expect(/p_subject_date\s*=>\s*v_row\.override_date/.test(b), "p_subject_date").toBe(true);
  });

  it("денна новина рахується по ДЕННИХ полях, а не по tg_op", () => {
    /* `v_day := true` безумовно на INSERT розсилав дневну крапку всім
       направникам центру навіть коли змінився графік ОДНОГО кабінету —
       ослаблена версія діри, яку закрила 0183a. Знахідка ревʼю. */
    expect(/v_day\s*:=\s*true/.test(sql)).toBe(false);
    expect(/coalesce\(new\.all_closed, false\) or new\.label is not null/.test(sql)).toBe(true);
    expect(/coalesce\(old\.all_closed, false\) or old\.label is not null/.test(sql)).toBe(true);
  });

  it("CTE віяла існує І підключений до union", () => {
    /* Оголосити CTE й забути додати його в union — мутація, яка лишає файл
       правдоподібним, а функцію без жодного нового отримувача. */
    expect(/sched_referrers as \(/.test(sql)).toBe(true);
    expect(/union select id from sched_referrers/.test(sql)).toBe(true);
  });

  /** ⚠️ ЗРІЗ САМОГО CTE, а не весь файл. Це не педантизм: перша редакція цих
      трьох перевірок пінила ПРИСУТНІСТЬ рядка у файлі — і стенд (мутація A2)
      показав, що зняти `and pr.approved` із віяла можна МОВЧКИ, бо той самий
      рядок є у смоуку розділу 4 тієї ж міграції. Пін по присутності замість
      піна по МІСЦЮ — та сама помилка, що ловилась дев'ять разів у с58–59. */
  const fanout = boundedSlice("sched_referrers as (", "select distinct s.id");

  it("базис: зріз CTE віяла не порожній", () => {
    expect(fanout.length).toBeGreaterThan(200);
    expect(/from public\.referral_access ra/.test(fanout)).toBe(true);
  });

  it("віяло тримається на АКТИВНОМУ гранті", () => {
    expect(/ra\.status = 'active'/.test(fanout)).toBe(true);
  });

  it("непідтверджений направник в аудиторію не входить", () => {
    /* Він на портал не потрапляє взагалі (app/referral/page.tsx), отже
       погасити крапку не може ЖОДНОЮ дією. */
    expect(/pr\.approved/.test(fanout)).toBe(true);
  });

  it("фільтр по грантах кабінетів на місці — це і є RF-03", () => {
    expect(/ra\.room_ids is null/.test(fanout)).toBe(true);
    expect(/p_room = any \(ra\.room_ids\)/.test(fanout)).toBe(true);
  });

  /* ⚠️ ПІН НА ТОЧНИЙ ТЕКСТ ПРЕДИКАТА, а не на присутність його шматків.
     Знахідка ревʼю, і вона б'є в саму серцевину: усі перевірки вище шукають
     ПІДРЯДОК, тому `ra.status = 'active'` → `(ra.status = 'active' or
     ra.status = 'revoked')` і `pr.approved` → `(pr.approved or pr.role =
     'referrer')` проходять МОВЧКИ — літерал на місці, аудиторія розширена.
     Стенд цього класу теж не бачив: усі його мутації були ВИДАЛЕННЯМ.
     Розширення предиката — найприродніша правка «щоб іще й такі отримували»,
     і саме її треба зробити неможливою тихо.
     ⚠️ Порівнюємо по нормалізованих пробілах і без коментарів, тож
        переформатування цей пін НЕ червонить (урок 0141: пін, що червоніє на
        нешкідливому рефакторі, буде знятий). Червонить тільки зміна СМИСЛУ. */
  it("предикат віяла збігається ДОСЛІВНО — розширення через OR не пройде", () => {
    const where = fanout.slice(fanout.indexOf("where p_scope_kind")).replace(/\s+/g, " ").trim();
    expect(where).toBe(
      "where p_scope_kind = 'schedule' and ra.clinic_id = p_clinic and ra.status = 'active' " +
      "and pr.approved and (p_room is null or ra.room_ids is null or p_room = any (ra.room_ids)) )",
    );
  });

  it("персонал виключений із scope_kind='schedule'", () => {
    const staff = boundedSlice("with staff as (", "rads as (");
    expect(staff.length).toBeGreaterThan(100);
    expect(/p_scope_kind <> 'schedule'/.test(staff)).toBe(true);
  });

  it("радіолог виключений теж — fail-closed проти майбутнього емітера", () => {
    const rads = boundedSlice("rads as (", "referrer as (");
    expect(rads.length).toBeGreaterThan(100);
    expect(/p_scope_kind <> 'schedule'/.test(rads)).toBe(true);
  });

  it("тригер на schedule_overrides створено", () => {
    expect(
      /create trigger trg_zz_change_markers\s+after insert or update or delete on public\.schedule_overrides/
        .test(sql),
    ).toBe(true);
  });

  it("EXECUTE у клієнтських ролей знято (пастка 0122)", () => {
    expect(/revoke all on function public\.tg_change_markers_sched_override\(\) from anon, authenticated;/.test(sql)).toBe(true);
  });

  it("якір — кабінет або клініка, а НЕ рядок графіка", () => {
    /* Позначка не сміє переживати сутність, на яку вказує (0150/0164/0165).
       Рядок особливого графіка ВИДАЛЯЮТЬ, і саме видалення є новиною. */
    expect(/p_entity_type\s*=>\s*'room'/.test(sql)).toBe(true);
    expect(/p_entity_type\s*=>\s*'schedule_override'/.test(sql)).toBe(false);
  });

  it("ключ rooms перевіряється регуляркою, а не кастується наосліп", () => {
    /* У проді ВЖЕ лежать ключі видалених кабінетів — голий k::uuid поклав би
       тригер, а з ним і будь-яку правку графіка (урок 0183). */
    expect(/\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/.test(sql)).toBe(true);
  });
});

describe("0184: ключ перезаморозки — ПОВЕДІНКА, а не текст в екрані", () => {
  const base = {
    clinicId: "c1",
    date: "2026-09-12",
    roomId: "r1",
    override: { all_closed: false, label: null, rooms: { r1: { start: "08:00" } } },
    loadFailed: false,
  };

  it("збій читання виводить ключ у порожній рядок", () => {
    /* Інакше ми стверджували б «людина побачила поточний графік» там, де
       читання впало і сітка схована. */
    expect(schedAckKeyOf({ ...base, loadFailed: true })).toBe("");
  });

  it("однаковий вхід — однаковий ключ (інакше перезаморозка щорендера)", () => {
    expect(schedAckKeyOf(base)).toBe(schedAckKeyOf({ ...base }));
  });

  /* ⚠️ ЦЕНТРАЛЬНА ПЕРЕВІРКА ПАКЕТА з боку клієнта. Викидання `override` з
     ключа — мутація, яку лексичний пін не бачив: ім'я змінної на місці, а
     перезаморозки більше немає, і крапка не гасне до F5. */
  it("зміна САМОГО ГРАФІКА міняє ключ", () => {
    const changed = { ...base, override: { ...base.override, all_closed: true } };
    expect(schedAckKeyOf(changed)).not.toBe(schedAckKeyOf(base));
  });

  it("поява особливого графіка там, де його не було, міняє ключ", () => {
    expect(schedAckKeyOf({ ...base, override: null })).not.toBe(schedAckKeyOf(base));
  });

  it.each([
    ["дата", { date: "2026-09-13" }],
    ["кабінет", { roomId: "r2" }],
    ["центр", { clinicId: "c2" }],
  ])("перехід на інший %s міняє ключ", (_n, patch) => {
    expect(schedAckKeyOf({ ...base, ...patch })).not.toBe(schedAckKeyOf(base));
  });

  it("відсутній центр дає СТАБІЛЬНИЙ непорожній ключ, а не порожній", () => {
    /* Порожній рядок зарезервований за «читання впало». Якби `clinicId: null`
       теж давав "", ці два стани були б нерозрізненні, і заморозка поводилась
       би однаково там, де сенс протилежний. */
    const k = schedAckKeyOf({ ...base, clinicId: null });
    expect(k).not.toBe("");
    expect(k).toBe(schedAckKeyOf({ ...base, clinicId: null }));
    expect(k).not.toBe(schedAckKeyOf(base));
  });
});
