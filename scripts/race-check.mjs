/* RadFlow — харнес живої конкурентності (беклог №1, хвіст с32; сценарії
   «кабінет» і «CAS» — с42). Чиста логіка і вердикти — race-check-lib.mjs
   (під vitest).

     node scripts/race-check.mjs plan                      # нічого не пише
     node scripts/race-check.mjs run --run                 # ПИШЕ в прод: слот
     node scripts/race-check.mjs run --run --n 4 --room <uuid>
     node scripts/race-check.mjs room --run                # ПИШЕ: гонка за кабінет
     node scripts/race-check.mjs cas --run                 # ПИШЕ: паралельний CAS
     node scripts/race-check.mjs waitlist --run            # ПИШЕ: гонка за кандидата
     node scripts/race-check.mjs cleanup --run             # аварійне прибирання

   ЧОТИРИ СЦЕНАРІЇ — чотири РІЗНІ гаранти, і плутати їх не можна:
     run  — двоє пишуться в ОДИН слот     → тригер `check_no_overlap` (0064), 23P01;
     room — двох заводять в ОДИН кабінет  → унікальний індекс
            `queue_one_in_progress_per_room` (0018), 23505;
     cas  — двоє міняють статус ОДНОГО запису → `for update` + звірка
            `p_expected` всередині `queue_set_status_rpc` (0075), БЕЗ винятку:
            невдаха отримує `updated=false` і статус переможця;
     waitlist — двоє записують ОДНОГО кандидата листа → УМОВНИЙ UPDATE
            (`where … status='waiting'`) всередині `schedule_from_waitlist_rpc`,
            55000 `WAITLIST_STALE`. ⚠️ Гарант тут написаний РУКАМИ в тілі
            функції, а не породжений двигуном, як 23P01/23505 — тому зняття
            однієї умови в `where` не дало б жодної помилки БД, лише двох
            переможців. Це єдиний сценарій, де гарант можна вимкнути мовчки.

   ⚠️ Пише в ПРОД (dev і prod — одна БД). Без `--run` жодного запису:
   `plan` лише знаходить придатний слот і друкує намір. Прибирання йде за
   ЯВНИМ списком id, згенерованих ДО пострілу (правило с14).

   ⚠️ Службова роль ОБХОДИТЬ RLS, але НЕ обходить тригери й індекси — а
   гаранти сценаріїв `run` і `room` саме там. Тому харнес перевіряє рівно ті
   рубежі, що працюють у проді. Чого він НЕ перевіряє: прав доступу.

   ⚠️ CAS — інша річ: `queue_set_status_rpc` службову роль НЕ пускає взагалі
   (`auth_clinic_id()` = NULL → 42501 «FORBIDDEN: запис не знайдено»; звірено
   живим зондом у с42). Тому сценарію `cas` потрібен ЖИВИЙ токен персоналу в
   змінній оточення `RADFLOW_USER_JWT` — без неї він чесно йде в SKIP, а не
   вдає перевірку. Токен харнес НЕ друкує і НЕ пише в лог.

   ЯК ДІСТАТИ ТОКЕН. Застосунок на `@supabase/ssr` (lib/supabase/client.ts),
   тож сесія лежить у COOKIE, а не в localStorage — шукати там марно.
   Кука зветься `sb-<ref>-auth-token`, може бути порізана на `.0`, `.1`, а
   значення часто з префіксом `base64-`. Одним рухом — у консолі вкладки
   застосунку (DevTools → Console; за потреби спершу набрати `allow pasting`):

     (() => {
       const raw = document.cookie.split('; ')
         .filter(c => /^sb-.*-auth-token(\.\d+)?=/.test(c))
         .sort((a, b) => a.localeCompare(b))
         .map(c => decodeURIComponent(c.slice(c.indexOf('=') + 1)))
         .join('');
       const s = JSON.parse(raw.startsWith('base64-') ? atob(raw.slice(7)) : raw);
       copy(s.access_token);
       console.log('довжина', s.access_token.length,
                   '· діє до', new Date((s.expires_at ?? 0) * 1000).toLocaleTimeString());
     })()

   `copy()` — хелпер DevTools: токен опиниться в буфері обміну, у консоль
   він НЕ друкується (лише довжина і час протухання).

   Канон Node-скриптів проєкту: split lib+CLI, main() виконується безумовно. */

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { parseArgs, isUuid, loadEnvLocal } from "./integration-admin-lib.mjs";
import {
  FIXTURE_NAME, FIXTURE_DUR_MIN, FIXTURE_BUF_MIN,
  MODALITY_STUDY_TYPE, buildFixture, clinicDay, CAS_FROM, CAS_TO,
  buildWaitlistFixture, buildWaitlistBooking,
  verdictSlotRace, verdictControl, verdictInProgressRace, verdictCas,
  verdictWaitlistRace,
} from "./race-check-lib.mjs";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Потрібні NEXT_PUBLIC_SUPABASE_URL і SUPABASE_SERVICE_ROLE_KEY (.env.local)");
    process.exit(2);
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Кабінет для прогону: або явний `--room`, або перший АКТИВНИЙ кабінет із
    модальністю, для якої є чинна позиція каталогу. Data-driven, бо перший-
    ліпший кабінет може бути зайнятий севом (урок с26). */
async function pickRoom(db, roomOpt) {
  const { data: rooms, error } = await db
    .from("rooms")
    .select("id, name, modality, clinic_id, active, clinics(id, name, timezone)")
    .eq("active", true);
  if (error) throw new Error(`не читаються кабінети: ${error.message}`);
  const usable = (rooms || []).filter((r) => MODALITY_STUDY_TYPE[r.modality]);
  if (roomOpt) {
    if (!isUuid(roomOpt)) throw new Error(`--room «${roomOpt}» не uuid`);
    const hit = usable.find((r) => r.id === roomOpt);
    if (!hit) throw new Error(`кабінет ${roomOpt} не активний або має модальність без канонічного типу`);
    return hit;
  }
  if (!usable.length) throw new Error("немає жодного активного кабінету з придатною модальністю");
  return usable[0];
}

/** Позиція складу, ВИДИМА в цьому кабінеті. Дзеркалить умову видимості з
    `check_studies_active_catalog` (0121 + оверрайди 0108): базова послуга
    центру, не прихована override-ом кабінету, АБО власна послуга кабінету.
    Беремо з БД, а не з константи — інакше перший же редагований каталог
    зробив би харнес червоним «через гонку». */
async function pickStudy(db, room) {
  const type = MODALITY_STUDY_TYPE[room.modality];
  const { data: svc, error } = await db
    .from("services")
    .select("id, name, price, room_id")
    .eq("clinic_id", room.clinic_id).eq("modality", room.modality).eq("active", true)
    .or(`room_id.is.null,room_id.eq.${room.id}`)
    .order("sort_order", { ascending: true });
  if (error) throw new Error(`не читається каталог: ${error.message}`);
  if (!svc?.length) throw new Error(`у кабінеті «${room.name}» немає активних послуг ${room.modality}`);

  const { data: ovr, error: oErr } = await db
    .from("service_room_overrides")
    .select("service_id").eq("room_id", room.id).eq("active", false);
  if (oErr) throw new Error(`не читаються оверрайди кабінету: ${oErr.message}`);
  const hidden = new Set((ovr || []).map((o) => o.service_id));

  const pick = svc.find((s) => s.room_id === room.id || !hidden.has(s.id));
  if (!pick) throw new Error(`усі послуги ${room.modality} приховані в кабінеті «${room.name}»`);
  return { dur: FIXTURE_DUR_MIN, type, price: pick.price ?? 0, region: pick.name, contrast: false };
}

/** Один постріл. Час МІРЯЄМО навколо самого запиту — на цих числах тримається
    доказ одночасності, тому вони не «діагностика», а частина вердикту. */
async function fire(db, row) {
  const startedAt = Date.now();
  const { error } = await db.from("queue_entries").insert(row);
  const finishedAt = Date.now();
  return {
    id: row.id, startedAt, finishedAt,
    ok: !error,
    sqlstate: error?.code ?? "",
    message: error?.message ?? "",
  };
}

/** Пошук ПРИДАТНИХ слотів: пробні вставки з негайним видаленням.

    Чому пробами, а не читанням графіка: до `trg_no_overlap` стоять 15 інших
    BEFORE-гардів (графік, перерва, інцидент, сітка, минуле, модальність) —
    відтворювати їх у JS означало б завести другу реалізацію правил, яка
    неминуче розійдеться з БД. Провалена вставка не лишає сліду взагалі:
    транзакція відкочується, а `fn_audit` — AFTER-тригер.

    Чому СПИСОК, а не один слот. Контрольному сценарію потрібні РІЗНІ
    придатні слоти. Перша редакція брала базовий слот і зсувала його на
    30 хв × i — і при --n 8 від 10:00 упиралась у перерву 13:00–14:00:
    контроль падав із вердиктом «фікстура непридатна», хоча непридатним був
    сам спосіб вибору. Кандидати рознесені на годину, тож вікна
    зайнятості (dur+buf = 25 хв) не перетинаються за побудовою. */
async function findSlots(db, room, study, { days, times, count, cleanupIds }) {
  const tried = [];
  const found = [];
  const tz = room.clinics?.timezone || "UTC";
  for (const d of days) {
    const day = clinicDay(tz, d);
    for (const time of times) {
      const id = randomUUID();
      const row = buildFixture({
        id, clinicId: room.clinic_id, roomId: room.id, day, time, label: "проба", study,
      });
      /* id реєструємо ДО пострілу, а не після успіху. Провалена вставка не
         лишає сліду, зате УСПІШНА проба, яку не вдалося прибрати, заблокує
         РЕАЛЬНИЙ слот — і `finally` про неї не дізнається, якщо покласти
         реєстрацію після `cleanup`. Повторне видалення — безпечний no-op. */
      cleanupIds.push(id);
      const r = await fire(db, row);
      if (!r.ok) { tried.push(`${day} ${time}: ${r.sqlstate}`); continue; }
      await cleanup(db, [id]);
      found.push({ day, time });
      if (found.length >= count) return { slots: found, tried };
    }
  }
  if (found.length >= 2) return { slots: found, tried };
  throw new Error(`придатних слотів знайдено ${found.length} (треба ≥2). Спроби:\n  ${tried.join("\n  ")}`);
}

/** Прибирання за ЯВНИМ списком id (правило с14 — жодних «усе, що підходить
    під критерій»).

    Порядок навмисний: спершу записи, потім позначки. Незнятий запис блокує
    РЕАЛЬНИЙ слот у проді; незнята позначка — лише фантомна червона крапка
    (наступали в с37). Якщо впаде другий крок, шкода менша.

    ⚠️ `user_change_markers` не має FK на `queue_entries` (саме це чинила
    0150), тому каскад їх НЕ прибере — тільки руками. */
async function cleanup(db, ids) {
  if (!ids.length) return { entries: null, markers: null };
  const e = await db.from("queue_entries").delete().in("id", ids);
  const m = await db.from("user_change_markers").delete().in("entity_id", ids);
  return { entries: e.error?.message ?? null, markers: m.error?.message ?? null };
}

/** Прибирання рядків ЛИСТА ОЧІКУВАННЯ — окремою функцією, а не параметром
    `cleanup`, свідомо: id черги й id листа живуть у РІЗНИХ таблицях, і одна
    спільна функція з прапорцем рано чи пізно видалила б не там. Списки теж
    окремі (`cleanupIds` / `waitlistIds`).

    ⚠️ `scheduled_entry_id` знімати не треба: FK
    `waitlist_entries_scheduled_entry_id_fkey` — `ON DELETE SET NULL`
    (заміряно `pg_get_constraintdef` 10.09.2026, не припущено). Саме тому
    порядок у прибиранні ЗВОРОТНИЙ до інтуїції: спершу ПРОЧИТАТИ
    `scheduled_entry_id`, і лише потім видаляти. Видаливши рядок черги
    першим, ми власноруч обнулили б єдиний слід, яким шукається запис,
    створений у пострілі з ВТРАЧЕНОЮ відповіддю. */
async function cleanupWaitlist(db, ids) {
  if (!ids.length) return { entries: null, markers: null };
  const e = await db.from("waitlist_entries").delete().in("id", ids);
  const m = await db.from("user_change_markers").delete().in("entity_id", ids);
  return { entries: e.error?.message ?? null, markers: m.error?.message ?? null };
}

/** Те саме для листа очікування: «delete не повернув помилки» ≠ «прибрано».
    Окремий рахунок, бо змішаний із чергою він приховав би, ЯКА саме таблиця
    лишила слід. */
async function verifyCleanWaitlist(db, ids) {
  if (!ids.length) return { entriesLeft: 0, markersLeft: 0 };
  const e = await db.from("waitlist_entries").select("id").in("id", ids);
  const m = await db.from("user_change_markers").select("id").in("entity_id", ids);
  return {
    entriesLeft: e.error ? `?(${e.error.message})` : (e.data?.length ?? 0),
    markersLeft: m.error ? `?(${m.error.message})` : (m.data?.length ?? 0),
  };
}

/** Перевірка, що прибрано СПРАВДІ (а не «delete не повернув помилки»).
    Урок с36: успіх без перевірки — припущення, не факт. */
async function verifyClean(db, ids) {
  // Падіння ДО першого пострілу лишає список порожнім — `.in("id", [])`
  // йшов би в PostgREST ні за чим і міг дати помилку замість чесного нуля.
  if (!ids.length) return { entriesLeft: 0, markersLeft: 0 };
  const e = await db.from("queue_entries").select("id").in("id", ids);
  const m = await db.from("user_change_markers").select("id").in("entity_id", ids);
  return {
    entriesLeft: e.error ? `?(${e.error.message})` : (e.data?.length ?? 0),
    markersLeft: m.error ? `?(${m.error.message})` : (m.data?.length ?? 0),
  };
}

/** Контрольний сценарій: ті самі N пострілів, але в РІЗНІ придатні слоти.
    Без нього «одна удача з N» не відрізнити від «фікстура зламана і N−1
    впали б у будь-якому разі». Контроль доводить, що самі постріли
    проходять, а отже відмови в основному сценарії спричинені САМЕ
    конкуренцією. Той самий клас сторожа, що «ворожий payload мусить
    пробивати ІМЕННО правило» (с25). */
async function runControl(db, { room, study, slots, cleanupIds }) {
  const rows = slots.map((s, i) => buildFixture({
    id: randomUUID(), clinicId: room.clinic_id, roomId: room.id,
    day: s.day, time: s.time, label: `контроль-${i + 1}`, study,
  }));
  rows.forEach((r) => cleanupIds.push(r.id));
  const outcomes = await Promise.all(rows.map((r) => fire(db, r)));
  await cleanup(db, rows.map((r) => r.id));
  return { outcomes, verdict: verdictControl(outcomes) };
}

/** Сценарій «кабінет»: N пацієнтів у РІЗНИХ слотах одного кабінету
    одночасно заводять у кабінет (`status → in_progress`).

    Чому на рівні таблиці, а не через RPC: фізичний інваріант «у кабінеті
    один пацієнт» тримає унікальний частковий індекс 0018 — він спрацює
    незалежно від того, хто пише (роут, RPC, PostgREST, майбутній n8n).
    Перевірки самого RPC (0129, фактичне вікно) цей сценарій НЕ зачіпає —
    їх стереже сценарій `cas` і клієнтський lateCallClash.

    ⚠️ Слоти РІЗНІ навмисно: інакше другу фікстуру не дав би вставити
    `check_no_overlap`, і ми ганяли б гонку з одним учасником. */
async function runRoomRace(db, { room, study, slots, n, cleanupIds }) {
  const rows = slots.slice(0, n).map((s, i) => buildFixture({
    id: randomUUID(), clinicId: room.clinic_id, roomId: room.id,
    day: s.day, time: s.time, label: `кабінет-${i + 1}`, study,
  }));
  rows.forEach((r) => cleanupIds.push(r.id));

  // Підготовка — ПОСЛІДОВНО: тут гонки немає, і збій вставки має бути видно
  // окремо від гонки (інакше «фікстура не лягла» виглядало б як її результат).
  for (const r of rows) {
    const ins = await fire(db, r);
    if (!ins.ok) {
      await cleanup(db, rows.map((x) => x.id));
      throw new Error(`фікстуру ${r.scheduled_date} ${r.scheduled_time} не вставлено: ${ins.sqlstate} ${ins.message}`);
    }
  }

  const outcomes = await Promise.all(rows.map(async (r) => {
    const startedAt = Date.now();
    const { error } = await db.from("queue_entries")
      .update({ status: "in_progress", in_progress_at: new Date().toISOString() })
      .eq("id", r.id);
    return {
      id: r.id, startedAt, finishedAt: Date.now(),
      ok: !error, sqlstate: error?.code ?? "", message: error?.message ?? "",
    };
  }));

  /* Прибирання: спершу знімаємо in_progress, потім видаляємо. Прямий delete
     теж спрацював би, але залишений in_progress (якщо delete впаде) блокує
     РЕАЛЬНИЙ кабінет — і на дошці наступного дня це «незавершене
     дослідження» (0018/с24). Дешева страховка на випадок часткового збою. */
  await db.from("queue_entries").update({ status: "scheduled", in_progress_at: null })
    .in("id", rows.map((r) => r.id));
  await cleanup(db, rows.map((r) => r.id));
  return { outcomes, verdict: verdictInProgressRace(outcomes) };
}

/** Сценарій «CAS»: N паралельних `queue_set_status_rpc` на ОДНОМУ записі з
    `p_expected`. Виняткiв тут не має бути взагалі: переможець отримує
    `updated=true`, решта — `updated=false` і СТАТУС ПЕРЕМОЖЦЯ (доказ, що
    після `for update` рядок перечитано, а не взято зі старого знімка).

    Фікстуру створює службова роль, а стріляє КОРИСТУВАЦЬКИЙ клієнт: RPC
    службову роль не пускає. */
async function runCas(db, user, { room, study, slot, n, cleanupIds }) {
  const row = buildFixture({
    id: randomUUID(), clinicId: room.clinic_id, roomId: room.id,
    day: slot.day, time: slot.time, label: "cas", study,
  });
  cleanupIds.push(row.id);
  const ins = await fire(db, row);
  if (!ins.ok) throw new Error(`фікстуру CAS не вставлено: ${ins.sqlstate} ${ins.message}`);

  const outcomes = await Promise.all(Array.from({ length: n }, async () => {
    const startedAt = Date.now();
    const { data, error } = await user.rpc("queue_set_status_rpc", {
      p_id: row.id, p_status: CAS_TO, p_expected: CAS_FROM,
    });
    const r = Array.isArray(data) ? data[0] : data;
    return {
      id: row.id, startedAt, finishedAt: Date.now(),
      ok: !error,
      updated: r?.updated ?? null,
      currentStatus: r?.current_status ?? r?.currentStatus ?? null,
      sqlstate: error?.code ?? "", message: error?.message ?? "",
    };
  }));

  await cleanup(db, [row.id]);
  return { outcomes, verdict: verdictCas(outcomes, { target: CAS_TO }) };
}

/** КОНТРОЛЬ саме для сценарію «лист очікування»: N паралельних
    `schedule_from_waitlist_rpc` на N РІЗНИХ кандидатах у N РІЗНИХ слотів.

    ⚠️ ЧОМУ СПІЛЬНОГО `runControl` ТУТ НЕ ВИСТАЧАЄ (знахідка ревʼю Б, с62).
    Він вставляє рядки черги НАПРЯМУ службовою роллю. Це інший клієнт, інший
    транспорт, інші таблиці й інші гарди. Тобто висновок «ті N−1 відмов
    спричинені конкуренцією» він НЕ ліцензує: не показано, що кожен із тих
    викликів пройшов би НАОДИНЦІ. У `run`/`room` така ліцензія є саме тому,
    що контроль — ТА САМА операція в різні слоти.

    Що доводить цей контроль, і кожен пункт тут потрібен:
      • токен персоналу справді приймається, а RPC доступна цій ролі;
      • фікстура листа валідна (modality ↔ склад, клініка, дефолт статусу);
      • `p_booking` несе всі колонки, яких вимагає вставка кроку 2;
      • КОРИСТУВАЦЬКИЙ клієнт справді стріляє паралельно (`windowsOverlap`).

    ⚠️ Кандидатів і слотів рівно `n`, а не `slots.length`: спільний контроль
    брав `slots.length`, і при `--n 8` з двома придатними слотами вісім
    пострілів «контролювались» двома. */
async function runWaitlistControl(db, user, { room, study, slots, n, cleanupIds, waitlistIds }) {
  const use = slots.slice(0, n);
  if (use.length < n) {
    return { outcomes: [], verdict: { verdict: "FAIL", reason: `придатних слотів ${use.length}, а контролю треба ${n}` } };
  }
  const rows = use.map((_, i) => buildWaitlistFixture({
    id: randomUUID(), clinicId: room.clinic_id, modality: room.modality,
    study, label: `лист-контроль-${i + 1}`,
  }));
  for (const r of rows) {
    waitlistIds.push(r.id);
    const ins = await db.from("waitlist_entries").insert(r);
    if (ins.error) throw new Error(`контрольну фікстуру листа не вставлено: ${ins.error.code} ${ins.error.message}`);
  }

  const outcomes = await Promise.all(rows.map(async (r, i) => {
    const booking = buildWaitlistBooking({
      roomId: room.id, day: use[i].day, time: use[i].time, study,
    });
    const startedAt = Date.now();
    const { data, error } = await user.rpc("schedule_from_waitlist_rpc", {
      p_waitlist_id: r.id, p_booking: booking,
    });
    const entryId = typeof data === "string" ? data : null;
    return {
      id: entryId || r.id, entryId,
      startedAt, finishedAt: Date.now(),
      ok: !error, sqlstate: error?.code ?? "", message: error?.message ?? "",
    };
  }));
  for (const o of outcomes) if (o.entryId) cleanupIds.push(o.entryId);

  /* ⚠️ ПРИБИРАЄМО ЗА СОБОЮ ОДРАЗУ, а не в `finally` — і це не оптимізація, а
     ПОМИЛКА, знайдена ПЕРШИМ ЖЕ живим прогоном (с62). Контроль створює РЕАЛЬНІ
     записи черги в тих самих слотах, які потім бере гонка. Поки вони висіли до
     кінця прогону, обидва постріли гонки отримували `23P01 OVERLAP` від тригера
     0064 — тобто сценарій падав на СВОЇХ ЖЕ фікстурах.

     Вердикт при цьому не збрехав: він сказав «кандидата не записав НІХТО —
     фікстура або слот непридатні» і назвав SQLSTATE. Саме так і має поводитись
     драбинка — але прогін не доводив нічого. Той самий порядок, що в
     `runControl` і `runRace`: створив → вистрілив → прибрав.

     Порядок усередині теж важливий: спершу дочитати звʼязок (FK
     `on delete set null`), потім видалити чергу, потім лист. */
  const link = await db.from("waitlist_entries")
    .select("scheduled_entry_id").in("id", rows.map((r) => r.id));
  if (!link.error) {
    for (const r of link.data || []) {
      if (r.scheduled_entry_id && !cleanupIds.includes(r.scheduled_entry_id)) {
        cleanupIds.push(r.scheduled_entry_id);
      }
    }
  }
  const ids = outcomes.map((o) => o.entryId).filter(Boolean)
    .concat((link.data || []).map((r) => r.scheduled_entry_id).filter(Boolean));
  if (ids.length) await cleanup(db, [...new Set(ids)]);
  await cleanupWaitlist(db, rows.map((r) => r.id));

  return { outcomes, verdict: verdictControl(outcomes) };
}

/** Сценарій «лист очікування»: N паралельних `schedule_from_waitlist_rpc` на
    ОДНОМУ кандидаті.

    Гарант — умовний UPDATE усередині RPC (`where … status = 'waiting'`):
    рівно один застовплює кандидата, решта отримують `55000 WAITLIST_STALE`.
    Фікстуру створює службова роль, стріляє КОРИСТУВАЦЬКИЙ клієнт — RPC
    службову роль не пускає (`auth_clinic_id()` = NULL → 28000).

    ⚠️ ВСІ N стріляють в ОДИН слот, і це безпечно саме через порядок кроків у
    RPC: застовплення (крок 1) стоїть ПЕРЕД вставкою (крок 2), тож до вставки
    доходить лише переможець. Розводити слоти було б помилкою — це замаскувало б
    зняття умови `status='waiting'`: з різними слотами обидва пройшли б і
    вердикт лишився б зеленим.

    ⚠️ НАЗВАНА МЕЖА (ревʼю Б, с62): при знятій умові `status='waiting'` обидва
    проходять крок 1, і «рівно одного переможця» тут утримає вже НЕ той гарант,
    що перевіряється, а тригер 0064 на спільному слоті — другий отримає 23P01.
    Вердикт це побачить (`невдахи впали НЕ через гонку` → FAIL), тобто дефект
    не сховається; але формулювання говоритиме про непридатну фікстуру, а не
    про зняте застовплення. Єдиний прямий свідок кроку 1 — SQLSTATE невдахи.

    ⚠️ ID ЗАПИСУ ЧЕРГИ НАПЕРЕД НЕВІДОМИЙ — його повертає RPC. Тому список
    прибирання поповнюється ПІСЛЯ пострілу, і саме тут харнес може лишити
    слід: якщо відповідь загубилась у мережі, транзакція вже закомічена, а id
    у нас немає. Єдиний слід — `waitlist_entries.scheduled_entry_id`, і ми
    ЗАВЖДИ дочитуємо його з БД, а не покладаємось на повернене значення.
    Це не перестраховка: без цього кроку втрачена відповідь лишила б у проді
    справжнє бронювання на робочому слоті. */
async function runWaitlistRace(db, user, { room, study, slot, n, cleanupIds, waitlistIds }) {
  const wl = buildWaitlistFixture({
    id: randomUUID(), clinicId: room.clinic_id, modality: room.modality,
    study, label: "лист",
  });
  waitlistIds.push(wl.id);
  const ins = await db.from("waitlist_entries").insert(wl);
  if (ins.error) throw new Error(`фікстуру листа не вставлено: ${ins.error.code} ${ins.error.message}`);

  const booking = buildWaitlistBooking({
    roomId: room.id, day: slot.day, time: slot.time, study,
  });

  const outcomes = await Promise.all(Array.from({ length: n }, async () => {
    const startedAt = Date.now();
    const { data, error } = await user.rpc("schedule_from_waitlist_rpc", {
      p_waitlist_id: wl.id, p_booking: booking,
    });
    return {
      id: typeof data === "string" ? data : wl.id,
      entryId: typeof data === "string" ? data : null,
      startedAt, finishedAt: Date.now(),
      ok: !error,
      sqlstate: error?.code ?? "",
      message: error?.message ?? "",
    };
  }));

  // Повернені id — у прибирання ДО будь-яких перевірок.
  for (const o of outcomes) if (o.entryId) cleanupIds.push(o.entryId);

  /* Дочитуємо звʼязок ЗАВЖДИ. Дві причини, і друга важливіша за першу:
       • це окрема перевірка кроку 3 RPC («звʼязок проставлено в тій самій
         транзакції») — вердикт гонки про неї нічого не знає;
       • це ЄДИНИЙ спосіб знайти запис, створений пострілом із втраченою
         відповіддю. */
  const link = await db.from("waitlist_entries")
    .select("status, scheduled_entry_id").eq("id", wl.id).maybeSingle();
  const linkedId = link.data?.scheduled_entry_id ?? null;
  if (linkedId && !cleanupIds.includes(linkedId)) cleanupIds.push(linkedId);

  return {
    outcomes,
    verdict: verdictWaitlistRace(outcomes),
    link: {
      status: link.error ? `?(${link.error.message})` : (link.data?.status ?? null),
      entryId: linkedId,
      matchesWinner: outcomes.some((o) => o.entryId && o.entryId === linkedId),
    },
  };
}

/** Основний сценарій: N пострілів в ОДИН слот. */
async function runRace(db, { room, study, slot, n, cleanupIds }) {
  const rows = Array.from({ length: n }, (_, i) => buildFixture({
    id: randomUUID(), clinicId: room.clinic_id, roomId: room.id,
    day: slot.day, time: slot.time, label: `гонка-${i + 1}`, study,
  }));
  rows.forEach((r) => cleanupIds.push(r.id));
  const outcomes = await Promise.all(rows.map((r) => fire(db, r)));
  await cleanup(db, rows.map((r) => r.id));
  return { outcomes, verdict: verdictSlotRace(outcomes) };
}

const DAYS = [7, 8, 9, 10, 11, 12, 13, 14];
const TIMES = ["10:00", "11:00", "15:00", "16:00"];

function printOutcomes(title, outcomes) {
  const t0 = Math.min(...outcomes.map((o) => o.startedAt));
  console.log(`  ${title}:`);
  for (const o of outcomes) {
    const verdict = o.ok ? "УДАЧА " : `ВІДМОВА ${o.sqlstate}`;
    console.log(`    +${String(o.startedAt - t0).padStart(4)} мс  ${String(o.finishedAt - o.startedAt).padStart(5)} мс  ${verdict}` +
      (o.ok ? "" : `  ${o.message.slice(0, 70)}`));
  }
}

/** CAS друкуємо ІНАКШЕ: тут «відмова» — не виняток, а `updated=false` плюс
    побачений статус. Спільний принтер приховав би саме те, на чому тримається
    вердикт. */
function printCasOutcomes(title, outcomes) {
  const t0 = Math.min(...outcomes.map((o) => o.startedAt));
  console.log(`  ${title}:`);
  for (const o of outcomes) {
    const verdict = !o.ok ? `ВИНЯТОК ${o.sqlstate}`
      : o.updated ? "ОНОВИВ  " : `не оновив (бачить «${o.currentStatus ?? "?"}»)`;
    console.log(`    +${String(o.startedAt - t0).padStart(4)} мс  ${String(o.finishedAt - o.startedAt).padStart(5)} мс  ${verdict}` +
      (o.ok ? "" : `  ${o.message.slice(0, 70)}`));
  }
}

/** Клієнт від імені ЖИВОГО користувача: RPC перевіряє `auth_clinic_id()`, а
    в службової ролі його немає. Токен читаємо з оточення й НІКОЛИ не друкуємо
    (правило проєкту: токен у переписці = негайний відкликаний токен). */
function userClient(jwt) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("Потрібні NEXT_PUBLIC_SUPABASE_URL і NEXT_PUBLIC_SUPABASE_ANON_KEY");
  /* ⚠️ ДРУКУЄМО МЕТАДАНІ ТОКЕНА — і НІКОЛИ жодного його фрагмента.
     Привід (с62): перший прогін `cas` упав з `PGRST301 No suitable key or
     wrong key type`, і діагностика стала гаданням, бо ніхто не знав, ЯКИМ
     алгоритмом підписано токен. Проєкт переведено на асиметричні ключі
     (`alg: ES256` + `kid`); токен, підписаний ЛЕГАСІ-секретом (`HS256`),
     PostgREST більше не перевіряє. Один рядок нижче відрізняє «токен не той»
     від «харнес зламаний» ДО пострілу, а не після. */
  try {
    const h = JSON.parse(Buffer.from(jwt.split(".")[0], "base64url").toString("utf8"));
    const b = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    const left = b.exp ? Math.round((b.exp * 1000 - Date.now()) / 60000) : "?";
    console.log(`Токен: alg=${h.alg}${h.kid ? " kid=є" : " kid=НЕМАЄ"} · role=${b.role}`
      + ` · лишилось ~${left} хв`);
    if (h.alg !== "ES256") {
      console.log(`  ⚠️ Очікується ES256 (проєкт на асиметричних ключах). ${h.alg}`
        + " PostgREST відхилить: PGRST301 «No suitable key or wrong key type».");
    }
  } catch { console.log("Токен: заголовок не розібрався — це не схоже на JWT"); }
  return createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

/** Гард ПЕРЕД першим записом для сценаріїв із живим токеном: центр токена
    мусить збігатися з центром обраного кабінету.

    ⚠️ ЦЕ НЕ ПЕДАНТИЗМ — це заміряна пастка (с62). `pickRoom` без `--room`
    бере ПЕРШИЙ активний кабінет із придатною модальністю, а він може лежати
    в ІНШОМУ центрі: у проді таких центрів два, і перший у вибірці — тестовий
    `titenkosmokeCLINIC`, тоді як сесія персоналу майже завжди в `Medicom`.
    Фікстура ляже в центр кабінету, а RPC звіряє центр ТОКЕНА — і поверне
    `42501 WAITLIST_NOT_FOUND` / `FORBIDDEN`. Вердикт при цьому чесно скаже
    «невдахи впали НЕ через гонку», тобто дефекту не сховає, але діагноз
    пошле шукати помилку в гарді, якого ніхто не ламав.

    Питаємо ту саму функцію, якою користується сама RPC (`auth_clinic_id()`,
    EXECUTE є в `authenticated`) — не декодуємо токен і не вигадуємо
    паралельного джерела правди. */
async function assertTokenClinicMatches(user, room) {
  const { data, error } = await user.rpc("auth_clinic_id");
  if (error) {
    /* Не блокуємо: якщо читання впало, справжня причина зʼясується на першому
       ж пострілі, а глушити прогін через діагностику — гірше, ніж попередити. */
    console.log(`⚠️ не вдалося звірити центр токена (${error.code || ""} ${error.message}) — прогін триває`);
    return;
  }
  if (!data) {
    throw new Error(
      "токен не належить персоналу центру: auth_clinic_id() = NULL.\n" +
      "  Так виглядає прострочений токен або сесія направника — RPC такий виклик не пустить.");
  }
  if (data !== room.clinic_id) {
    throw new Error(
      `центр ТОКЕНА і центр КАБІНЕТА різні — RPC відмовить 42501, і це виглядатиме як дефект гарда.\n` +
      `  кабінет «${room.name}» → центр ${room.clinic_id} (${room.clinics?.name ?? "?"})\n` +
      `  токен персоналу      → центр ${data}\n` +
      "  Виберіть кабінет свого центру: --room <uuid>");
  }
}

/** Гард перед записом у ПРОД: якщо в клініки є УВІМКНЕНИЙ вебхук, фікстури
    поїдуть партнеру (тригер 0145 емітить події на кожну зміну запису).
    Прибирання черги подій харнес не робить свідомо — видаляти чужі рядки
    outbox небезпечніше, ніж не стріляти зовсім. */
async function assertNoLiveWebhook(db, clinicId) {
  const { data, error } = await db.from("integration_webhooks")
    .select("id, enabled").eq("clinic_id", clinicId).eq("enabled", true);
  if (error) throw new Error(`не читаються вебхуки клініки: ${error.message}`);
  if (data?.length) {
    throw new Error(
      "у клініки УВІМКНЕНО вебхук інтеграції — фікстури харнеса пішли б партнеру.\n" +
      "  Вимкніть вебхук на час прогону або оберіть іншу клініку (--room <uuid> іншого центру).");
  }
}

/** Кабінет має бути ВІЛЬНИЙ: якщо в ньому вже є `in_progress`, перший же
    постріл сценарію «кабінет» упаде на 23505 — і гонка виглядала б як
    провал, хоча вона просто не відбулася. */
async function assertRoomFree(db, roomId) {
  const { data, error } = await db.from("queue_entries")
    .select("id, patient_name, scheduled_date").eq("room_id", roomId).eq("status", "in_progress");
  if (error) throw new Error(`не читається стан кабінету: ${error.message}`);
  if (data?.length) {
    throw new Error(
      `у кабінеті вже є пацієнт (${data.length}, від ${data[0].scheduled_date}) — гонка за кабінет неможлива.\n` +
      "  Дочекайтесь завершення дослідження або вкажіть інший кабінет: --room <uuid>");
  }
}

/** Аварійне прибирання за іменем-маркером фікстури.

    ⚠️ ДВІ ТАБЛИЦІ, і це не симетрія заради симетрії. Сценарій `waitlist`
    лишає слід у `waitlist_entries`, і поки тут стояла лише черга, «Залишків
    фікстур немає» було б ХИБНОЮ заявою: рядок листа лишався б назавжди, а
    команда рапортувала б чисто. Це той самий клас, що вже коштував проєкту
    кілька разів — перелік місць вужчий за дерево.

    ⚠️ Порядок той самий, що у `finally`: спершу дочитати `scheduled_entry_id`
    (FK `on delete set null`), потім видаляти. Інакше запис, створений
    пострілом і не привʼязаний до імені-маркера, лишився б у проді. */
async function cmdCleanup(db, write) {
  const q = await db
    .from("queue_entries").select("id, patient_name, scheduled_date, scheduled_time")
    .like("patient_name", `${FIXTURE_NAME}%`);
  if (q.error) throw new Error(`не читаються залишки черги: ${q.error.message}`);
  const w = await db
    .from("waitlist_entries").select("id, patient_name, status, scheduled_entry_id")
    .like("patient_name", `${FIXTURE_NAME}%`);
  if (w.error) throw new Error(`не читаються залишки листа очікування: ${w.error.message}`);

  const qRows = q.data || [];
  const wRows = w.data || [];
  if (!qRows.length && !wRows.length) { console.log("Залишків фікстур немає."); return; }

  if (qRows.length) {
    console.log(`Черга — ${qRows.length}:`);
    qRows.forEach((r) => console.log(`  ${r.id}  ${r.patient_name}  ${r.scheduled_date} ${r.scheduled_time}`));
  }
  if (wRows.length) {
    console.log(`Лист очікування — ${wRows.length}:`);
    wRows.forEach((r) => console.log(`  ${r.id}  ${r.patient_name}  ${r.status}`
      + (r.scheduled_entry_id ? `  → запис ${r.scheduled_entry_id}` : "")));
  }
  if (!write) { console.log("\nБез --run нічого не видалено."); return; }

  const ids = qRows.map((r) => r.id);
  for (const r of wRows) {
    if (r.scheduled_entry_id && !ids.includes(r.scheduled_entry_id)) {
      ids.push(r.scheduled_entry_id);
      console.log(`  дочитано запис ${r.scheduled_entry_id} за звʼязком із листа`);
    }
  }
  await cleanup(db, ids);
  const left = await verifyClean(db, ids);
  console.log(`Черга прибрана. Лишилось: записів ${left.entriesLeft}, позначок ${left.markersLeft}.`);

  const wIds = wRows.map((r) => r.id);
  if (wIds.length) {
    await cleanupWaitlist(db, wIds);
    const leftW = await verifyCleanWaitlist(db, wIds);
    console.log(`Лист прибраний. Лишилось: рядків ${leftW.entriesLeft}, позначок ${leftW.markersLeft}.`);
  }
}

async function main() {
  loadEnvLocal();
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const write = opts.run === true;
  const n = Math.max(2, Math.min(8, Number(opts.n) || 2));
  const db = adminClient();

  if (cmd === "help" || opts.help) {
    console.log("race-check.mjs plan | run --run [--n 2..8] [--room <uuid>] | room --run | cas --run | waitlist --run | cleanup [--run]");
    console.log("  run  — двоє в ОДИН слот (тригер 0064)");
    console.log("  room — двох в ОДИН кабінет (унікальний індекс 0018)");
    console.log("  cas  — двоє міняють статус ОДНОГО запису (for update у 0075).");
    console.log("  waitlist — двоє записують ОДНОГО кандидата листа очікування");
    console.log("         (умовний UPDATE у schedule_from_waitlist_rpc → 55000 WAITLIST_STALE).");
    console.log("         cas і waitlist потребують RADFLOW_USER_JWT — токен живого персоналу.");
    console.log("         Сесія у COOKIE (@supabase/ssr), не в localStorage — сніпет у шапці файлу.");
    console.log("         Живе ~годину. Не друкувати, не класти в лог, не слати в переписку.");
    return;
  }
  if (cmd === "cleanup") { await cmdCleanup(db, write); return; }
  if (!["plan", "run", "room", "cas", "waitlist"].includes(cmd)) throw new Error(`невідома команда «${cmd}»`);

  const room = await pickRoom(db, opts.room);
  const study = await pickStudy(db, room);
  const tz = room.clinics?.timezone || "UTC";
  console.log(`Центр: ${room.clinics?.name} (${tz})`);
  console.log(`Кабінет: ${room.name} [${room.modality}] ${room.id}`);
  console.log(`Склад: ${study.type} / ${study.region}, ${FIXTURE_DUR_MIN}+${FIXTURE_BUF_MIN} хв`);

  if (cmd === "plan") {
    console.log(`\nПлан: ${n} паралельних записів в один слот + контроль у ${n} різних слотів.`);
    console.log(`Дні-кандидати: +${DAYS[0]}..+${DAYS[DAYS.length - 1]}, часи: ${TIMES.join(", ")}.`);
    console.log("Пошук слота вимагає пробного запису — тому `plan` його НЕ робить.");
    console.log("Запуск: node scripts/race-check.mjs run --run");
    console.log("Інші сценарії: room --run (кабінет), cas --run (CAS), waitlist --run (кандидат листа).");
    return;
  }

  /* Гард запису. Без нього команда писала б у ПРОД просто тому, що вона так
     називається — а прапорець `--run` існував би лише в довідці. */
  if (!write) {
    console.log(`\n⚠️ \`${cmd}\` пише в ПРОД. Без --run нічого не виконано.`);
    console.log(`Запуск: node scripts/race-check.mjs ${cmd} --run`);
    return;
  }

  // Фікстури — звичайні записи черги: тригер 0145 емітить їх партнеру, якщо
  // у клініки увімкнено вебхук. Перевіряємо ДО першого запису.
  await assertNoLiveWebhook(db, room.clinic_id);
  if (cmd === "room") await assertRoomFree(db, room.id);

  /* CAS вимагає живого токена персоналу — службова роль до RPC не допущена
     за дизайном. Немає токена — чесний SKIP з інструкцією, а не імітація
     перевірки службовою роллю (вона дала б 42501 і виглядала б як «дефект»). */
  let user = null;
  if (cmd === "cas" || cmd === "waitlist") {
    const jwt = process.env.RADFLOW_USER_JWT;
    if (!jwt) {
      console.log(`\nSKIP: немає RADFLOW_USER_JWT — сценарій ${cmd} не запускався.`);
      console.log("  RPC службову роль НЕ пускає (auth_clinic_id() = NULL → 42501/28000),");
      console.log("  тож без токена живого персоналу перевіряти нічого.");
      console.log("  Токен: сесія у COOKIE `sb-<ref>-auth-token` (@supabase/ssr), НЕ в localStorage.");
      console.log("         Готовий сніпет для консолі браузера — у шапці scripts/race-check.mjs.");
      console.log(`  Запуск: $env:RADFLOW_USER_JWT="..."; node scripts/race-check.mjs ${cmd} --run --room <uuid>`);
      console.log("  ⚠️ --room ОБОВʼЯЗКОВИЙ, якщо центрів кілька: без нього береться перший");
      console.log("     активний кабінет, і він може бути з ЧУЖОГО центру — RPC дасть 42501.");
      console.log("  Токен живе ~годину; у переписку й лог він не потрапляє.");
      return;
    }
    user = userClient(jwt);
    /* ДО першого запису: центр токена ↔ центр кабінету. Ставимо саме тут —
       після `assertNoLiveWebhook` і ПЕРЕД `findSlots`, який уже пише проби. */
    await assertTokenClinicMatches(user, room);
  }

  const cleanupIds = [];
  const waitlistIds = [];
  let code = 0;
  try {
    const { slots, tried } = await findSlots(db, room, study, {
      days: DAYS, times: TIMES, count: n, cleanupIds,
    });
    console.log(`\nПридатних слотів: ${slots.length} (відкинуто кандидатів: ${tried.length}).`);
    console.log(`Слот гонки: ${slots[0].day} ${slots[0].time}`);

    /* КОНТРОЛЬ ПЕРШИМ і осмислено. Якщо постріли самі по собі не проходять,
       «одна удача з N» в основному сценарії нічого не доводить — тому при
       провалі контролю гонку взагалі НЕ запускаємо, щоб не видати артефакт
       за результат. Контроль спільний для всіх сценаріїв: він доводить
       придатність фікстури й РЕАЛЬНУ паралельність клієнта. */
    const control = await runControl(db, { room, study, slots, cleanupIds });
    printOutcomes(`КОНТРОЛЬ (${slots.length} різних слотів)`, control.outcomes);
    console.log(`  → ${control.verdict.verdict}: ${control.verdict.reason}\n`);
    if (control.verdict.verdict !== "PASS") {
      console.log("Гонку НЕ запускаємо: без справного контролю її результат неінтерпретований.");
      code = 2;
    } else if (cmd === "room") {
      const race = await runRoomRace(db, { room, study, slots, n, cleanupIds });
      printOutcomes(`ГОНКА ЗА КАБІНЕТ (${n} одночасних in_progress)`, race.outcomes);
      console.log(`  → ${race.verdict.verdict}: ${race.verdict.reason}`);
      console.log(`  розкид стартів: ${race.verdict.spread} мс`);
      code = race.verdict.verdict === "PASS" ? 0 : (race.verdict.verdict === "FAIL" ? 1 : 2);
    } else if (cmd === "waitlist") {
      /* ⚠️ ВЛАСНИЙ КОНТРОЛЬ, ПОВЕРХ спільного (знахідка ревʼю Б, с62).
         Спільний контроль вище доводить придатність слотів і паралельність
         СЛУЖБОВОГО клієнта. Про користувацький клієнт, токен персоналу,
         доступність RPC і валідність фікстури листа він не говорить нічого —
         а без цього «N−1 × 55000» не можна приписати конкуренції. */
      const wlControl = await runWaitlistControl(db, user, {
        room, study, slots, n, cleanupIds, waitlistIds,
      });
      if (wlControl.outcomes.length) {
        printOutcomes(`КОНТРОЛЬ ЛИСТА (${n} × RPC на РІЗНИХ кандидатах у РІЗНІ слоти)`, wlControl.outcomes);
      }
      console.log(`  → ${wlControl.verdict.verdict}: ${wlControl.verdict.reason}\n`);
      if (wlControl.verdict.verdict !== "PASS") {
        /* ⚠️ Без `return`: він вискочив би повз `process.exit(code)` після
           `finally`, і процес завершився б нулем — тобто «контроль не
           пройшов» читалось би як успіх. */
        console.log("Гонку НЕ запускаємо: контроль листа не пройшов, її результат був би неінтерпретований.");
        code = 2;
      } else {
        const race = await runWaitlistRace(db, user, {
          room, study, slot: slots[0], n, cleanupIds, waitlistIds,
        });
        printOutcomes(`ГОНКА ЗА КАНДИДАТА (${n} × schedule_from_waitlist_rpc на ОДНОМУ кандидаті)`, race.outcomes);
        console.log(`  → ${race.verdict.verdict}: ${race.verdict.reason}`);
        console.log(`  розкид стартів: ${race.verdict.spread} мс`);
        /* Крок 3 RPC — окремим рядком, бо вердикт гонки про нього не знає.
           «Кандидат scheduled, звʼязок веде на запис переможця» — це і є
           атомарність кроків 1–3, заявлена в тілі функції. */
        console.log(`  кандидат: status=${race.link.status ?? "?"} · scheduled_entry_id=`
          + `${race.link.entryId ? "є" : "НЕМАЄ"} · збігається з переможцем: `
          + `${race.link.matchesWinner ? "так" : "НІ"}`);
        const linkOk = race.link.status === "scheduled" && race.link.entryId && race.link.matchesWinner;
        if (!linkOk && race.verdict.verdict === "PASS") {
          console.log("  ⚠️ Гонка чиста, але звʼязок кандидата з записом НЕ зійшовся — крок 3 під питанням.");
        }
        /* ⚠️ `PASS && !linkOk` — це 2 (НЕ ДОВЕДЕНО), а не 1 (ДОВЕДЕНИЙ ДЕФЕКТ)
           — знахідка ревʼю Б, с62. Перша редакція давала тут 1, а `linkOk`
           хибніє і від збою ДІАГНОСТИЧНОГО читання (`status` стає рядком
           `?(…)`), і від зміни форми відповіді PostgREST на скалярний `uuid`
           (тоді `entryId` порожній у ВСІХ пострілів). Жодне з двох нічого не
           каже про взаємне виключення, а «1» у цьому файлі скрізь означає
           доведений дефект. */
        code = race.verdict.verdict === "FAIL" ? 1
          : race.verdict.verdict === "INCONCLUSIVE" ? 2
          : (linkOk ? 0 : 2);
      }
    } else if (cmd === "cas") {
      const race = await runCas(db, user, { room, study, slot: slots[0], n, cleanupIds });
      printCasOutcomes(`ПАРАЛЕЛЬНИЙ CAS (${n} × ${CAS_FROM} → ${CAS_TO} на ОДНОМУ записі)`, race.outcomes);
      console.log(`  → ${race.verdict.verdict}: ${race.verdict.reason}`);
      console.log(`  розкид стартів: ${race.verdict.spread} мс`);
      code = race.verdict.verdict === "PASS" ? 0 : (race.verdict.verdict === "FAIL" ? 1 : 2);
    } else {
      const race = await runRace(db, { room, study, slot: slots[0], n, cleanupIds });
      printOutcomes(`ГОНКА (${n} пострілів в ОДИН слот)`, race.outcomes);
      console.log(`  → ${race.verdict.verdict}: ${race.verdict.reason}`);
      console.log(`  розкид стартів: ${race.verdict.spread} мс`);
      code = race.verdict.verdict === "PASS" ? 0 : (race.verdict.verdict === "FAIL" ? 1 : 2);
    }
  } finally {
    /* Прибирання і в разі падіння: недоприбраний запис блокує РЕАЛЬНИЙ слот.
       Повторний delete по вже видалених id — безпечний no-op. */
    /* ⚠️ КОЖЕН КРОК — У СВОЄМУ try (знахідка ревʼю А, с62). Блок `finally`
       був прямою послідовністю: відмова мережі на першому ж `await` кидала
       виняток, решта кроків не виконувалась узагалі, і фікстура листа
       лишалась у проді БЕЗ жодного рядка-підказки. Тепер кожен крок або
       робить своє, або гучно каже, що не зміг. */
    const step = async (what, fn) => {
      try { return await fn(); }
      catch (e) { console.log(`⚠️ крок прибирання «${what}» упав: ${e.message}`); code = code || 1; return null; }
    };

    /* ⚠️ ПОРЯДОК: спершу дочитати звʼязок, і лише потім видаляти. FK
       `scheduled_entry_id` — `ON DELETE SET NULL`, тож видалення черги
       ПЕРШИМ обнулило б єдиний слід до запису, чия відповідь загубилась.
       У щасливому шляху `runWaitlistRace` уже дочитав його; тут — на випадок
       падіння ДО того місця (наприклад мережа впала посеред `Promise.all`).

       ⚠️ ПОМИЛКУ ЦЬОГО ЧИТАННЯ ПЕРЕВІРЯЄМО (знахідка ревʼю А, с62). Перша
       редакція брала `link.data || []` і мовчки йшла далі: при збою читання
       нічого не додавалось у список, `verifyClean` рахував ЛИШЕ відомі id і
       чесно друкував «Лишилось: записів 0» — ХИБНА заява про чистоту, після
       якої наступний крок видаляв рядок листа разом із єдиним слідом. */
    let linkReadOk = true;
    if (waitlistIds.length) {
      const link = await step("дочитати звʼязок кандидата", () =>
        db.from("waitlist_entries").select("scheduled_entry_id").in("id", waitlistIds));
      if (!link || link.error) {
        linkReadOk = false;
        console.log(`⚠️ НЕ вдалося дочитати scheduled_entry_id (${link?.error?.message ?? "виняток"}).`);
      } else {
        for (const r of link.data || []) {
          if (r.scheduled_entry_id && !cleanupIds.includes(r.scheduled_entry_id)) {
            cleanupIds.push(r.scheduled_entry_id);
            console.log(`  дочитано осиротілий запис ${r.scheduled_entry_id} — у прибирання`);
          }
        }
      }
    }
    const delQ = await step("видалити записи черги", () => cleanup(db, cleanupIds));
    /* ⚠️ Помилку видалення ПОЗНАЧОК друкуємо разом зі списком id: рядок-батько
       вже видалено, тож `cleanup --run` цю позначку за іменем НЕ знайде
       (знахідка ревʼю А). Явний список — єдине, що лишає її знімабельною. */
    if (delQ?.markers) {
      console.log(`⚠️ позначки НЕ знято (${delQ.markers}). Явний список entity_id: ${cleanupIds.join(", ")}`);
      code = code || 1;
    }
    const left = (await step("звірити прибирання черги", () => verifyClean(db, cleanupIds)))
      ?? { entriesLeft: "?", markersLeft: "?" };
    console.log(`\nПрибрано ${cleanupIds.length} id. Лишилось: записів ${left.entriesLeft}, позначок ${left.markersLeft}.`);
    if (left.entriesLeft !== 0 || left.markersLeft !== 0) {
      console.log("⚠️ Залишки! Добити: node scripts/race-check.mjs cleanup --run");
      code = code || 1;
    }
    if (waitlistIds.length) {
      /* ⚠️ РЯДОК ЛИСТА НЕ ВИДАЛЯЄМО, ЯКЩО ЗВʼЯЗОК НЕ ПРОЧИТАНО. Він — єдиний
         покажчик на запис черги, створений пострілом із втраченою відповіддю.
         Видалити його наосліп означає власноруч зробити той запис
         незнаходжуваним. Краще лишити фікстуру (її знайде `cleanup --run` за
         іменем) і сказати про це вголос. */
      if (!linkReadOk) {
        console.log(`⚠️ Рядок листа НЕ видалено навмисно: ${waitlistIds.join(", ")}`);
        console.log("   Спершу прогляньте scheduled_entry_id, потім: node scripts/race-check.mjs cleanup --run");
        code = code || 1;
      } else {
        const delW = await step("видалити рядки листа", () => cleanupWaitlist(db, waitlistIds));
        if (delW?.markers) {
          console.log(`⚠️ позначки листа НЕ знято (${delW.markers}). Явний список entity_id: ${waitlistIds.join(", ")}`);
          code = code || 1;
        }
        const leftW = (await step("звірити прибирання листа", () => verifyCleanWaitlist(db, waitlistIds)))
          ?? { entriesLeft: "?", markersLeft: "?" };
        console.log(`Лист очікування: прибрано ${waitlistIds.length} id. Лишилось: рядків ${leftW.entriesLeft}, позначок ${leftW.markersLeft}.`);
        if (leftW.entriesLeft !== 0 || leftW.markersLeft !== 0) {
          console.log("⚠️ Залишки в листі очікування! Добити: node scripts/race-check.mjs cleanup --run");
          code = code || 1;
        }
      }
    }
  }
  process.exit(code);
}

/* Канон Node-скриптів проєкту: main() виконується БЕЗУМОВНО — жодних
   guard-ів по argv[1] (на симлінках і у Windows-шляхах вони дають мовчазний
   no-op, і скрипт «нічого не робить» без пояснення). */
main().catch((e) => {
  console.error(`ПОМИЛКА: ${e.message}`);
  process.exit(2);
});
