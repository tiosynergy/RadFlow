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
  buildCaseFixture, buildCaseStep, CASE_ACTIVE_STATUSES,
  verdictSlotRace, verdictControl, verdictInProgressRace, verdictCas,
  verdictWaitlistRace, verdictCaseCancelRace, verdictCaseRounds, verdictEmergencyStop,
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

/** ДРУГИЙ кабінет того самого центру — сценаріям `case` і `stop`.

    ⚠️ Не «зручність», а вимога тригера `check_case_distinct_room`: активні
    кроки одного кейса мусять бути в РІЗНИХ кабінетах, інакше 23505. Модальність
    може бути будь-яка з придатних — склад для неї підбирає `pickStudy`.
    Для `stop` другий кабінет потрібен інакше: набір з одного елемента робить
    «той самий набір у протилежному порядку» тотожним самому собі. */
async function pickSecondRoom(db, room, room2Opt) {
  const { data: rooms, error } = await db
    .from("rooms")
    .select("id, name, modality, clinic_id, active, clinics(id, name, timezone)")
    .eq("active", true).eq("clinic_id", room.clinic_id);
  if (error) throw new Error(`не читаються кабінети центру: ${error.message}`);
  const cand = (rooms || []).filter((r) => r.id !== room.id && MODALITY_STUDY_TYPE[r.modality]);

  if (room2Opt) {
    if (!isUuid(room2Opt)) throw new Error(`--room2 «${room2Opt}» не uuid`);
    if (room2Opt === room.id) throw new Error("--room2 збігається з --room: потрібні РІЗНІ кабінети");
    const hit = cand.find((r) => r.id === room2Opt);
    if (!hit) {
      throw new Error(
        `кабінет ${room2Opt} не підходить як другий: він неактивний, з іншого центру `
        + "або має модальність без канонічного типу.\n"
        + `  Придатні: ${cand.map((r) => `${r.id} «${r.name}»`).join(", ") || "жодного"}`);
    }
    return hit;
  }

  if (!cand.length) {
    throw new Error(
      `у центрі лише один придатний кабінет — потрібні ДВА.\n` +
      "  Для «кейса»: тригер check_case_distinct_room не дасть двом активним крокам стояти в одному кабінеті.\n" +
      "  Для «зупинки»: набір з одного кабінету робить «протилежний порядок» безглуздим.");
  }
  /* ⚠️ НЕОДНОЗНАЧНІСТЬ — ПОМИЛКА, А НЕ ПРИВІД ВГАДУВАТИ (с63). Перша редакція
     брала `.find(...)`, тобто ПЕРШИЙ-ліпший кабінет у порядку, який віддала
     база. Поки центрів-пісочниць було по два кабінети, це працювало
     випадково. Щойно в смоук-центрі зʼявився третій, той самий рядок міг
     мовчки обрати кабінет із ЖИВИМИ записами — а для аварійної зупинки це
     означає зняти з виклику чужий день. Ціна вгадування несиметрична, тож
     вгадувати не можна взагалі. */
  if (cand.length > 1) {
    throw new Error(
      `у центрі ${cand.length} придатних других кабінети — оберіть явно: --room2 <uuid>\n`
      + cand.map((r) => `  ${r.id}  «${r.name}» [${r.modality}]`).join("\n"));
  }
  return cand[0];
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

/** Прибирання КЕЙСА: кроки, потім сам кейс.

    ⚠️ ПОРЯДОК ОБОВʼЯЗКОВИЙ і має ту саму природу, що в листі очікування. FK
    `queue_entries_case_id_fkey` — `ON DELETE SET NULL` (заміряно
    `pg_get_constraintdef` 10.09.2026). Видаливши кейс ПЕРШИМ, ми власноруч
    обнулили б `case_id` у всіх його кроках — і єдиний слід, за яким їх можна
    знайти після втраченої відповіді, зник би разом із ним. */
async function cleanupCase(db, caseIds) {
  if (!caseIds.length) return { cases: null };
  const e = await db.from("patient_cases").delete().in("id", caseIds);
  const m = await db.from("user_change_markers").delete().in("entity_id", caseIds);
  return { cases: e.error?.message ?? null, markers: m.error?.message ?? null };
}

/** Сценарій «кейс»: `cancel_case_rpc` ПРОТИ `add_case_step_rpc` на ОДНОМУ кейсі.

    Гарант — `select … for update` на рядку кейса як ЄДИНА точка серіалізації
    всіх мутацій кейса, і перевірка `status = 'open'` ПІСЛЯ нього.

    ⚠️ ПОСТАНОВКА ВРАХОВУЄ ДВА ТРИГЕРИ КЕЙСА, і без них фікстура не лягла б:
    * `check_case_distinct_room` — активні кроки одного кейса мусять бути в
      РІЗНИХ кабінетах (23505). Тому крок-фікстура і крок, який додаємо, беруть
      РІЗНІ кабінети, і обидва — з центру кейса.
    * `check_case_no_time_overlap` — пацієнт не може бути у двох кабінетах
      одночасно (23P01). Тому слоти рознесені (кандидати `findSlots` стоять на
      годину один від одного).
    Пропустивши це, ми отримали б відмову кроку з чужим SQLSTATE — і вердикт
    чесно сказав би «відмовлено НЕ через скасування», але прогін не довів би
    нічого. */
async function runCaseRound(db, user, { room, study, room2, study2, slotA, slotB, cleanupIds, caseIds, label = "кейс" }) {
  const kase = buildCaseFixture({ id: randomUUID(), clinicId: room.clinic_id, label });
  caseIds.push(kase.id);
  const insCase = await db.from("patient_cases").insert(kase);
  if (insCase.error) throw new Error(`фікстуру кейса не вставлено: ${insCase.error.code} ${insCase.error.message}`);

  // Крок 1 — службовою роллю, напряму: він лише створює кейсу «вміст».
  const step1 = buildFixture({
    id: randomUUID(), clinicId: room.clinic_id, roomId: room.id,
    day: slotA.day, time: slotA.time, label: "кейс-крок-1", study,
  });
  step1.case_id = kase.id;
  step1.case_step = 1;
  cleanupIds.push(step1.id);
  const ins1 = await fire(db, step1);
  if (!ins1.ok) throw new Error(`крок 1 кейса не вставлено: ${ins1.sqlstate} ${ins1.message}`);

  // Крок 2 — той, який ДОДАЄМО в гонці: ІНШИЙ кабінет, ІНШИЙ слот.
  const p_step = buildCaseStep({
    roomId: room2.id, day: slotB.day, time: slotB.time, study: study2,
  });

  const [add, cancel] = await Promise.all([
    (async () => {
      const startedAt = Date.now();
      const { data, error } = await user.rpc("add_case_step_rpc", { p_case_id: kase.id, p_step });
      return {
        startedAt, finishedAt: Date.now(), ok: !error,
        entryId: typeof data === "string" ? data : null,
        sqlstate: error?.code ?? "", message: error?.message ?? "",
      };
    })(),
    (async () => {
      const startedAt = Date.now();
      const { data, error } = await user.rpc("cancel_case_rpc", { p_case_id: kase.id });
      return {
        startedAt, finishedAt: Date.now(), ok: !error,
        cancelled: typeof data === "number" ? data : null,
        sqlstate: error?.code ?? "", message: error?.message ?? "",
      };
    })(),
  ]);
  if (add.entryId) cleanupIds.push(add.entryId);

  /* КІНЦЕВИЙ СТАН читаємо з БД, а не збираємо з відповідей. Відповідь може
     загубитись, а стан — ні; і саме стан, а не відповіді, є предметом
     твердження. Заразом це єдиний спосіб знайти крок, доданий пострілом із
     втраченою відповіддю (`case_id` ще на місці — кейс ми не видаляли). */
  const cs = await db.from("patient_cases").select("status").eq("id", kase.id).maybeSingle();
  const st = await db.from("queue_entries").select("id, case_step, status").eq("case_id", kase.id);
  for (const s of st.data || []) if (!cleanupIds.includes(s.id)) cleanupIds.push(s.id);

  const final = {
    caseStatus: cs.error ? null : (cs.data?.status ?? null),
    steps: st.error ? [] : (st.data || []),
    readError: cs.error?.message || st.error?.message || null,
  };
  if (final.readError) {
    return { caseId: kase.id, add, cancel, final, verdict: { verdict: "INCONCLUSIVE", spread: 0,
      reason: `кінцевий стан не прочитався (${final.readError}) — судити нема про що` } };
  }
  return { caseId: kase.id, add, cancel, final, verdict: verdictCaseCancelRace(add, cancel, final) };
}

/** Прибрати рядки ОДНОГО раунду відразу, не чекаючи `finally`.

    ⚠️ ЦЕ НЕ АКУРАТНІСТЬ, А УМОВА ПРАЦЕЗДАТНОСТІ СЕРІЇ. Раунди йдуть по тих
    самих двох слотах; лишивши кроки попереднього раунду в базі, наступний
    дістав би 23P01 від `check_no_overlap` — і сценарій упав би об власні
    фікстури. Рівно так у с62 впав перший прод-прогін листа очікування:
    контроль створював записи в тих слотах, які потім брала гонка, і прибирав
    їх лише у `finally`.

    ⚠️ Порядок той самий, що всюди: спершу КРОКИ, потім кейс. FK
    `queue_entries.case_id` — `on delete set null`, тож видалений першим кейс
    обнулив би `case_id` і відрізав кроки від звʼязку. Id лишаються в
    `cleanupIds`/`caseIds`: повторне видалення — безпечний no-op, а от
    ВИКРЕСЛИТИ їх звідти означало б утратити слід, якщо видалення не вдалось. */
async function cleanupRound(db, caseId) {
  const st = await db.from("queue_entries").select("id").eq("case_id", caseId);
  if (st.error) return { left: `кроки не прочитались: ${st.error.message}` };
  const ids = (st.data || []).map((r) => r.id);
  if (ids.length) {
    const d = await cleanup(db, ids);
    if (d.entries) return { left: `кроки не видалені: ${d.entries}` };
  }
  const after = await db.from("queue_entries").select("id").eq("case_id", caseId);
  if (after.error) return { left: `звірка кроків не вдалась: ${after.error.message}` };
  if ((after.data || []).length) return { left: `кроків лишилось ${after.data.length}` };
  const dc = await cleanupCase(db, [caseId]);
  if (dc.cases) return { left: `кейс не видалено: ${dc.cases}` };
  return { left: null };
}

/** КОНТРОЛЬ сценарію «кейс»: крок додається НАОДИНЦІ, без скасування поруч.

    ⚠️ Без нього «22023» у гонці нема чому приписати. `add_case_step_rpc`
    піднімає цей самий код ще в чотирьох місцях — усі вони валідація входу
    (кабінет, дослідження, тривалість, слот), тобто ознака непридатної
    фікстури. Контроль доводить, що САМЕ ЦЯ фікстура проходить, коли їй ніхто
    не заважає, — і лише після цього відмова в гонці щось означає.

    Спільний контроль угорі (`runControl`) сюди не годиться: він міряє
    службовий клієнт і вставку в чергу, а тут питання про користувацький
    токен, RPC кейса і три його тригери. */
async function runCaseControl(db, user, { room, study, room2, study2, slotA, slotB, cleanupIds, caseIds }) {
  const kase = buildCaseFixture({ id: randomUUID(), clinicId: room.clinic_id, label: "кейс-контроль" });
  caseIds.push(kase.id);
  const insCase = await db.from("patient_cases").insert(kase);
  if (insCase.error) throw new Error(`контрольний кейс не вставлено: ${insCase.error.code} ${insCase.error.message}`);

  const step1 = buildFixture({
    id: randomUUID(), clinicId: room.clinic_id, roomId: room.id,
    day: slotA.day, time: slotA.time, label: "контроль-крок-1", study,
  });
  step1.case_id = kase.id;
  step1.case_step = 1;
  cleanupIds.push(step1.id);
  const ins1 = await fire(db, step1);
  if (!ins1.ok) throw new Error(`контрольний крок 1 не вставлено: ${ins1.sqlstate} ${ins1.message}`);

  const p_step = buildCaseStep({ roomId: room2.id, day: slotB.day, time: slotB.time, study: study2 });
  const startedAt = Date.now();
  const { data, error } = await user.rpc("add_case_step_rpc", { p_case_id: kase.id, p_step });
  const out = {
    id: "контроль", startedAt, finishedAt: Date.now(), ok: !error,
    entryId: typeof data === "string" ? data : null,
    sqlstate: error?.code ?? "", message: error?.message ?? "",
  };
  if (out.entryId) cleanupIds.push(out.entryId);

  const left = await cleanupRound(db, kase.id);
  const verdict = out.ok
    ? { verdict: "PASS", reason: "крок наодинці додається — фікстура придатна, відмова в гонці матиме сенс" }
    : { verdict: "FAIL", reason: `крок НЕ додається навіть наодинці: ${out.sqlstate} (${String(out.message).slice(0, 80)}) — фікстура непридатна` };
  return { out, verdict, left: left.left };
}

/** СЕРІЯ раундів: контроль, потім `rounds` гонок, потім спільний вердикт. */
async function runCaseSeries(db, user, { room, study, room2, study2, slotA, slotB, rounds, cleanupIds, caseIds }) {
  const control = await runCaseControl(db, user, { room, study, room2, study2, slotA, slotB, cleanupIds, caseIds });
  if (control.verdict.verdict !== "PASS") return { control, rounds: [], verdict: control.verdict };

  const out = [];
  for (let i = 0; i < rounds; i++) {
    const r = await runCaseRound(db, user, {
      room, study, room2, study2, slotA, slotB, cleanupIds, caseIds, label: `кейс-${i + 1}`,
    });
    /* ⚠️ Прибирання ДО наступного раунду, і його збій — привід зупинитись, а
       не «спробувати ще»: наступний раунд усе одно впав би об ці рядки, і
       діагноз виглядав би як дефект гонки. */
    const cl = await cleanupRound(db, r.caseId);
    out.push({ ...r, cleanupLeft: cl.left });
    if (cl.left) break;
  }
  return { control, rounds: out, verdict: verdictCaseRounds(out) };
}

/** Прибирання ІНЦИДЕНТІВ за явним списком id.

    ⚠️ Саме DELETE, а не `status='resolved'`. «Вирішений» інцидент лишається в
    історії кабінету назавжди — тобто харнес дописав би центру подію, якої не
    було. Видалення прибирає рядок, який ми ж і створили, і не лишає сліду в
    журналі простоїв. */
async function cleanupIncidents(db, ids) {
  if (!ids.length) return { incidents: null };
  const e = await db.from("incidents").delete().in("id", ids);
  return { incidents: e.error?.message ?? null };
}

/** Скільки АКТИВНИХ інцидентів у кожному з кабінетів — читаємо ЗАПИТОМ.
    Відповіді RPC для цього не годяться: «RPC не повернула помилки» ≠ «в базі
    рівно один рядок», а весь інваріант 0017 — саме про рядки. */
async function activeIncidentsByRoom(db, roomIds) {
  const { data, error } = await db.from("incidents")
    .select("id, room_id").in("room_id", roomIds).eq("status", "active");
  if (error) throw new Error(`не читаються активні інциденти: ${error.message}`);
  const byRoom = Object.fromEntries(roomIds.map((r) => [r, 0]));
  const ids = [];
  for (const r of data || []) { byRoom[r.room_id] = (byRoom[r.room_id] || 0) + 1; ids.push(r.id); }
  return { byRoom, ids };
}

/** ГОЛОВНИЙ ГАРД сценарію `stop`, і він фіксує рішення власника (с63):
    аварійну зупинку ганяємо ТІЛЬКИ у смоук-центрі.

    ⚠️ Перевіряємо ВЛАСТИВІСТЬ, а не назву клініки. Гард «якщо центр
    називається смоук» обходиться перейменуванням і нічого не гарантує; гард
    «у цих кабінетах немає ЧУЖОЇ роботи» падає на живому центрі за побудовою,
    бо там завжди є записи. Fail-closed.

    Чому саме такий предикат. `emergency_stop_rpc` б'є ПО ПРЕДИКАТУ, а не за
    списком id, і рівно двома способами, які харнес не контролює:
      • `call_status = 'to_recall'` — усім scheduled/waiting/in_progress
        кабінету на `p_date`;
      • `status = 'not_held'` — усім in_progress кабінету на БУДЬ-ЯКУ дату
        (`p_date` тут не діє взагалі).
    Тобто «взяти майбутню дату» від другого удару НЕ рятує. Єдина чесна
    межа — щоб у кабінеті взагалі не було нічого, крім наших фікстур.

    ⚠️ Активний інцидент до пострілу теж заборонений: тоді `on conflict do
    nothing` зʼїв би обидві зупинки, вердикт побачив би «кабінет не зупинив
    ніхто» і показав би це як дефект індексу, хоча кабінет просто був зайнятий. */
async function assertRoomsUsableForStop(db, roomIds) {
  /* ⚠️ ФІЛЬТР «не наша фікстура» — НА СЕРВЕРІ, а не в JS. Клієнтська
     фільтрація тут була б дірою в самому гарді: PostgREST ріже вибірку по
     `db-max-rows` (у Supabase — 1000), і кабінет, у якого перша тисяча
     рядків — наші фікстури від попередніх прогонів, віддав би «чужого немає»,
     а чужі рядки просто не доїхали б. Гард, який мовчки бачить не все, гірший
     за відсутній: він дає дозвіл. */
  const { data, error } = await db.from("queue_entries")
    .select("id, patient_name, scheduled_date, status, room_id")
    .in("room_id", roomIds)
    .in("status", ["scheduled", "waiting", "in_progress"])
    .not("patient_name", "like", `${FIXTURE_NAME}%`)
    .limit(50);
  if (error) throw new Error(`не читається стан кабінетів: ${error.message}`);
  const foreign = data || [];
  if (foreign.length) {
    throw new Error(
      `у кабінетах є ЧУЖА робота (щонайменше ${foreign.length} записів, напр. ${foreign[0].scheduled_date} `
      + `${foreign[0].status}) — аварійна зупинка зняла б її з виклику й вибила б з кабінету.\n`
      + "  Сценарій `stop` ганяється ТІЛЬКИ у смоук-центрі: --room <uuid> кабінету смоук-клініки.\n"
      + "  Це рішення власника (с63), а не технічне обмеження: RPC б'є по предикату,\n"
      + "  а `status='not_held'` ігнорує `p_date` і дістає in_progress БУДЬ-ЯКОЇ дати.");
  }
  const { byRoom } = await activeIncidentsByRoom(db, roomIds);
  const busy = roomIds.filter((r) => byRoom[r] > 0);
  if (busy.length) {
    throw new Error(
      `кабінети вже мають активний простій (${busy.join(", ")}) — гонка неможлива: `
      + "обидві зупинки зʼїли б конфлікт мовчки.\n"
      + "  Зніміть простій у центрі або візьміть інші кабінети.");
  }
}

/** Фікстури сценарію `stop` НЕ МОЖУТЬ бути звʼязані з кейсом — чому саме,
    написано в `verdictEmergencyStop` і в місці виклику. Винесено окремою
    функцією, щоб її можна було назвати в мутації стенда. */
function assertFixturesHaveNoCase(fixtures) {
  const withCase = fixtures.filter((f) => f.case_id != null || f.case_step != null);
  if (withCase.length) {
    throw new Error(
      `фікстури зупинки звʼязані з кейсом (${withCase.length}) — вердикт цього сценарію став би брехливим.\n`
      + "  Він вважає БУДЬ-ЯКИЙ 40P01 дефектом, а `cancel_case_rpc` оголошує вікно дедлока\n"
      + "  «зупинка ↔ тригер перерахунку статусу кейса» ТРАНЗІЄНТНИМ (клієнт повторює).\n"
      + "  Хочете гонку зупинки з кроками кейса — спершу послабте вердикт і поясніть межу.");
  }
}

/** Сценарій «аварійна зупинка»: дві `emergency_stop_rpc` на ОДНОМУ наборі
    кабінетів у ПРОТИЛЕЖНОМУ порядку + `submit_incident_rpc` на спільному
    кабінеті. Питання одне: чи лишається порядок захвату локів детермінованим
    (0083/0109), тобто чи не виникає 40P01.

    ⚠️ ФІКСТУРИ ПОТРІБНІ, і не для краси. Без записів у черзі фаза
    `perform 1 from queue_entries … for update` не лочить НІЧОГО — тобто саме
    та ланка порядку, яку ми стережемо, у прогоні не бере участі. По одному
    запису в кожен кабінет на дату зупинки роблять її справжньою.

    ⚠️ Обидві фікстури мусять стояти на ОДНІЙ даті: `p_date` у RPC один на
    весь набір кабінетів. */
async function runEmergencyStopRace(db, user, { room, room2, study, study2, slotA, slotB, cleanupIds }) {
  const rooms = [room.id, room2.id];
  const date = slotA.day;
  if (slotB.day !== date) {
    throw new Error(`слоти кабінетів на РІЗНІ дати (${date} / ${slotB.day}) — p_date у RPC один`);
  }

  const fixtures = [
    buildFixture({ id: randomUUID(), clinicId: room.clinic_id, roomId: room.id,
                   day: date, time: slotA.time, label: "зупинка-A", study }),
    buildFixture({ id: randomUUID(), clinicId: room2.clinic_id, roomId: room2.id,
                   day: date, time: slotB.time, label: "зупинка-B", study: study2 }),
  ];
  /* ⚠️ АСЕРТ, ЯКИЙ ТРИМАЄ МЕЖУ ВЕРДИКТА (замір с63, див. `verdictEmergencyStop`).
     Вердикт вважає БУДЬ-ЯКИЙ 40P01 дефектом. Це правда лише поки фікстури без
     `case_id`: тіло `cancel_case_rpc` (рядки 56–60 у проді) прямо оголошує
     вікно 40P01 між багаторядковою зупинкою і тригером перерахунку статусу
     КЕЙСА транзієнтним — «клієнт повторює». Зі звʼязкою кейса той самий
     дедлок став би законним, а вердикт продовжив би кричати «дефект».
     Тому умова перевіряється, а не памʼятається: додасть хтось крок кейса у
     фікстуру — прогін зупиниться тут із поясненням, а не збреше потім. */
  assertFixturesHaveNoCase(fixtures);

  for (const f of fixtures) {
    cleanupIds.push(f.id);
    const ins = await fire(db, f);
    if (!ins.ok) throw new Error(`фікстуру зупинки не вставлено (${f.room_id}): ${ins.sqlstate} ${ins.message}`);
  }

  const note = `${FIXTURE_NAME} — харнес`;
  const shoot = async (id, call) => {
    const startedAt = Date.now();
    const { data, error } = await call();
    const finishedAt = Date.now();
    return {
      id, startedAt, finishedAt, ok: !error,
      row: Array.isArray(data) ? data[0] : data,
      sqlstate: error?.code ?? "", message: error?.message ?? "",
    };
  };

  const [a, b, brk] = await Promise.all([
    shoot("зупинка[A,B]", () => user.rpc("emergency_stop_rpc",
      { p_room_ids: [room.id, room2.id], p_date: date, p_note: note })),
    shoot("зупинка[B,A]", () => user.rpc("emergency_stop_rpc",
      { p_room_ids: [room2.id, room.id], p_date: date, p_note: note })),
    shoot("поломка(B)", () => user.rpc("submit_incident_rpc",
      { p_room_id: room2.id, p_reason: "breakdown", p_reason_label: note, p_note: note })),
  ]);

  const stops = [a, b].map((s) => ({
    ...s, asked: rooms, rooms: s.row?.stopped_rooms ?? [],
    affected: s.row?.affected ?? null,
  }));
  const breakdown = { ...brk, room: room2.id };

  /* Стан У БАЗІ — до будь-якого прибирання.

     ⚠️ ЗБІЙ ЦЬОГО ЧИТАННЯ НЕ МАЄ ВБИВАТИ ПРОГІН (той самий клас, що ревʼю Б
     знайшло в листі очікування, с62). `activeIncidentsByRoom` кидає — а
     виняток тут означав би, що результати трьох пострілів, які вже сталися і
     закомічені, не побачить ніхто. Інциденти при цьому створені, і про них
     треба сказати вголос, а не мовчки впасти. Тому: ловимо, віддаємо
     INCONCLUSIVE з причиною, а прибирання у `finally` спрацює як завжди. */
  let byRoom = null;
  let readError = null;
  try {
    ({ byRoom } = await activeIncidentsByRoom(db, rooms));
  } catch (e) {
    readError = e.message;
  }
  if (readError) {
    return {
      stops, breakdown, byRoom: {},
      verdict: { verdict: "INCONCLUSIVE", spread: 0,
        reason: `стан інцидентів у базі не прочитався (${readError}) — судити нема про що` },
    };
  }

  return {
    stops, breakdown, byRoom,
    verdict: verdictEmergencyStop({ stops, breakdown, rooms, activeByRoom: byRoom }),
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

/** Аварійну зупинку друкуємо ІНАКШЕ — з ІМЕНЕМ пострілу.

    ⚠️ Спільний принтер ховає саме те, на чому тримається вердикт. Тут доказ
    конкуренції — «хто саме чекав на локу», тобто пара «ім'я → тривалість».
    Без імені три однакові рядки з різними мілісекундами не читаються взагалі.
    Той самий мотив, що й у `printCasOutcomes`. */
function printStopOutcomes(title, outcomes) {
  const t0 = Math.min(...outcomes.map((o) => o.startedAt));
  console.log(`  ${title}:`);
  for (const o of outcomes) {
    const verdict = o.ok ? "УДАЧА " : `ВІДМОВА ${o.sqlstate}`;
    console.log(`    ${String(o.id).padEnd(14)} +${String(o.startedAt - t0).padStart(4)} мс  `
      + `${String(o.finishedAt - o.startedAt).padStart(5)} мс  ${verdict}`
      + (o.ok ? "" : `  ${String(o.message || "").slice(0, 60)}`));
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
    пострілом і не привʼязаний до імені-маркера, лишився б у проді.

    ⚠️ НАЗВАНА ЗАЛЕЖНІСТЬ, на якій тримається порятунок СИРОТИ (знахідка
    ревʼю А, с62). Крок, у якого `case_id` уже обнулено, знаходиться тут лише
    за іменем — і знаходиться тому, що `add_case_step_rpc` копіює
    `v_case.patient_name` у створюваний запис. Тобто RPC-створений крок
    успадковує маркер «ТЕСТ Гонка с38 …». Перестане копіювати — сирота стане
    незнаходжуваною ОБОМА шляхами. Це не гіпотеза: звірено з
    `pg_get_functiondef(add_case_step_rpc)` 10.09.2026. */
async function cmdCleanup(db, write) {
  const q = await db
    .from("queue_entries").select("id, patient_name, scheduled_date, scheduled_time")
    .like("patient_name", `${FIXTURE_NAME}%`);
  if (q.error) throw new Error(`не читаються залишки черги: ${q.error.message}`);
  const w = await db
    .from("waitlist_entries").select("id, patient_name, status, scheduled_entry_id")
    .like("patient_name", `${FIXTURE_NAME}%`);
  if (w.error) throw new Error(`не читаються залишки листа очікування: ${w.error.message}`);
  /* Третя таблиця — з тієї ж причини, що й друга: сценарій `case` лишає слід
     у `patient_cases`, і без цього рядка «Залишків немає» було б ХИБНОЮ
     заявою. Перелік місць знову виявився вужчим за дерево. */
  const c = await db
    .from("patient_cases").select("id, patient_name, status")
    .like("patient_name", `${FIXTURE_NAME}%`);
  if (c.error) throw new Error(`не читаються залишки кейсів: ${c.error.message}`);
  /* Четверта таблиця — слід сценарію `stop`. Незнятий інцидент коштує дорожче
     за всі попередні залишки разом: він блокує КАБІНЕТ, а не слот. Шукається
     за нотаткою: `runEmergencyStopRace` кладе в `note`/`reason_label` той
     самий маркер `FIXTURE_NAME`, яким живуть решта трьох таблиць. */
  const inc = await db
    .from("incidents").select("id, room_id, status, note, started_at")
    .like("note", `${FIXTURE_NAME}%`).eq("status", "active");
  if (inc.error) throw new Error(`не читаються залишки інцидентів: ${inc.error.message}`);

  const qRows = q.data || [];
  const wRows = w.data || [];
  const cRows = c.data || [];
  const iRows = inc.data || [];
  if (!qRows.length && !wRows.length && !cRows.length && !iRows.length) {
    console.log("Залишків фікстур немає."); return 0;
  }

  if (qRows.length) {
    console.log(`Черга — ${qRows.length}:`);
    qRows.forEach((r) => console.log(`  ${r.id}  ${r.patient_name}  ${r.scheduled_date} ${r.scheduled_time}`));
  }
  if (wRows.length) {
    console.log(`Лист очікування — ${wRows.length}:`);
    wRows.forEach((r) => console.log(`  ${r.id}  ${r.patient_name}  ${r.status}`
      + (r.scheduled_entry_id ? `  → запис ${r.scheduled_entry_id}` : "")));
  }
  if (cRows.length) {
    console.log(`Кейси — ${cRows.length}:`);
    cRows.forEach((r) => console.log(`  ${r.id}  ${r.patient_name}  ${r.status}`));
  }
  if (iRows.length) {
    console.log(`⚠️ АКТИВНІ ІНЦИДЕНТИ (кабінети заблоковані!) — ${iRows.length}:`);
    iRows.forEach((r) => console.log(`  ${r.id}  кабінет ${r.room_id}  від ${r.started_at}`));
  }
  /* ⚠️ БЕЗ --run КОМАНДА ТЕЖ МУСИТЬ ВІДДАВАТИ НЕНУЛЬ. Раніше сухий прогін
     друкував список залишків і виходив нулем — тобто рапортував успіх рівно
     в тій ситуації, заради якої його запускають. Той самий клас, що знайшло
     ревʼю А в `--run`-гілці, просто на сусідній гілці. */
  if (!write) {
    console.log("\nБез --run нічого не видалено.");
    return 1;
  }

  const ids = qRows.map((r) => r.id);
  for (const r of wRows) {
    if (r.scheduled_entry_id && !ids.includes(r.scheduled_entry_id)) {
      ids.push(r.scheduled_entry_id);
      console.log(`  дочитано запис ${r.scheduled_entry_id} за звʼязком із листа`);
    }
  }
  if (cRows.length) {
    const st = await db.from("queue_entries").select("id").in("case_id", cRows.map((r) => r.id));
    if (st.error) throw new Error(`не читаються кроки кейсів: ${st.error.message}`);
    for (const r of st.data || []) {
      if (!ids.includes(r.id)) { ids.push(r.id); console.log(`  дочитано крок кейса ${r.id}`); }
    }
  }
  let bad = 0;

  /* ІНЦИДЕНТИ ПЕРШИМИ: доки вони активні, кабінети для центру мертві. */
  if (iRows.length) {
    const iIds = iRows.map((r) => r.id);
    const delI = await cleanupIncidents(db, iIds);
    if (delI.incidents) { console.log(`⚠️ інциденти НЕ видалено: ${delI.incidents}`); bad = 1; }
    const leftI = await db.from("incidents").select("id").in("id", iIds).eq("status", "active");
    const nI = leftI.error ? "?" : (leftI.data?.length ?? "?");
    console.log(`Інциденти зняті. Лишилось активних: ${nI}.`);
    if (nI !== 0) {
      console.log(`⚠️ КАБІНЕТИ ЛИШИЛИСЬ ЗАБЛОКОВАНИМИ — зніміть простій у центрі: ${iRows.map((r) => r.room_id).join(", ")}`);
      bad = 1;
    }
  }

  const delQ = await cleanup(db, ids);
  if (delQ.entries) { console.log(`⚠️ записи НЕ видалено: ${delQ.entries}`); bad = 1; }
  if (delQ.markers) { console.log(`⚠️ позначки НЕ знято: ${delQ.markers}. Явний список entity_id: ${ids.join(", ")}`); bad = 1; }
  const left = await verifyClean(db, ids);
  console.log(`Черга прибрана. Лишилось: записів ${left.entriesLeft}, позначок ${left.markersLeft}.`);
  if (left.entriesLeft !== 0 || left.markersLeft !== 0) bad = 1;

  const wIds = wRows.map((r) => r.id);
  if (wIds.length) {
    await cleanupWaitlist(db, wIds);
    const leftW = await verifyCleanWaitlist(db, wIds);
    console.log(`Лист прибраний. Лишилось: рядків ${leftW.entriesLeft}, позначок ${leftW.markersLeft}.`);
    if (leftW.entriesLeft !== 0 || leftW.markersLeft !== 0) bad = 1;
  }

  const cIds = cRows.map((r) => r.id);
  if (cIds.length) {
    /* ⚠️ ТОЙ САМИЙ ГЕЙТ, ЩО У `finally` (знахідка ревʼю А, с62): кейс
       видаляємо, лише коли його кроків у базі СПРАВДІ не лишилось. FK
       `on delete set null` інакше обнулить `case_id` над живим кроком і
       відріже його від звʼязку — а команда відрапортує успіх. */
    const st2 = await db.from("queue_entries").select("id").in("case_id", cIds);
    const nSteps = st2.error ? "?" : (st2.data?.length ?? "?");
    if (nSteps !== 0) {
      console.log(`⚠️ Кейси НЕ видалено: у них лишилось кроків ${nSteps}. Спершу приберіть кроки.`);
      bad = 1;
    } else {
      await cleanupCase(db, cIds);
      const leftC = await db.from("patient_cases").select("id").in("id", cIds);
      const n = leftC.error ? "?" : (leftC.data?.length ?? "?");
      console.log(`Кейси прибрані. Лишилось: ${n}.`);
      if (n !== 0) bad = 1;
    }
  }
  /* ⚠️ КОМАНДА МУСИТЬ ВІДДАВАТИ КОД (знахідка ревʼю А). Раніше `cmdCleanup`
     просто повертався, і `main` завершувався БЕЗ `process.exit` — прогін, що
     надрукував «Лишилось: записів 3», виходив нулем, тобто рапортував успіх. */
  return bad;
}

async function main() {
  loadEnvLocal();
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const write = opts.run === true;
  const n = Math.max(2, Math.min(8, Number(opts.n) || 2));
  const db = adminClient();

  if (cmd === "help" || opts.help) {
    console.log("race-check.mjs plan | run --run [--n 2..8] [--room <uuid>] | room --run | cas --run | waitlist --run | case --run | stop --run | cleanup [--run]");
    console.log("  run  — двоє в ОДИН слот (тригер 0064)");
    console.log("  room — двох в ОДИН кабінет (унікальний індекс 0018)");
    console.log("  cas  — двоє міняють статус ОДНОГО запису (for update у 0075).");
    console.log("  waitlist — двоє записують ОДНОГО кандидата листа очікування");
    console.log("         (умовний UPDATE у schedule_from_waitlist_rpc → 55000 WAITLIST_STALE).");
    console.log("  case — скасування кейса ПРОТИ додавання кроку (for update на кейсі).");
    console.log("         Питання одне: чи може виникнути кейс cancelled з АКТИВНИМ кроком.");
    console.log("         СЕРІЯ раундів (--rounds 2..20, типово 8): з двох упорядкувань лише");
    console.log("         «скасування → крок» щось перевіряє, тож вердикт ВИМАГАЄ його хоч раз.");
    console.log("         Другий кабінет: --room2 <uuid>, слоти для нього шукаються окремо.");
    console.log("  stop — дві АВАРІЙНІ ЗУПИНКИ на одному наборі кабінетів у ПРОТИЛЕЖНОМУ порядку");
    console.log("         + «поломка» на спільному кабінеті. Питання: чи лишився детермінованим");
    console.log("         порядок захвату локів (0083/0109), тобто чи не виникає 40P01.");
    console.log("         ⚠️ ТІЛЬКИ СМОУК-ЦЕНТР. RPC б'є по предикату: знімає з виклику весь день");
    console.log("         кабінету і вибиває in_progress БУДЬ-ЯКОЇ дати. Гард падає, якщо в");
    console.log("         кабінетах є хоч один чужий запис.");
    console.log("         Другий кабінет: --room2 <uuid>. ОБОВʼЯЗКОВИЙ, якщо придатних більше одного —");
    console.log("         вгадувати не можна: не той кабінет = знятий з виклику чужий день.");
    console.log("         cas, waitlist, case і stop потребують RADFLOW_USER_JWT — токен живого персоналу.");
    console.log("         Сесія у COOKIE (@supabase/ssr), не в localStorage — сніпет у шапці файлу.");
    console.log("         Живе ~годину. Не друкувати, не класти в лог, не слати в переписку.");
    return;
  }
  if (cmd === "cleanup") { process.exit(await cmdCleanup(db, write)); }
  if (!["plan", "run", "room", "cas", "waitlist", "case", "stop"].includes(cmd)) throw new Error(`невідома команда «${cmd}»`);

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

  /* `stop` бере ДРУГИЙ кабінет і свій гард — обидва ДО першого запису.
     Гард тут найважливіший у файлі: аварійна зупинка б'є по предикату, тож
     помилитись центром означає зняти з виклику чужий робочий день. */
  let stopRoom2 = null;
  let stopStudy2 = null;
  const stopRooms = [];
  if (cmd === "stop") {
    stopRoom2 = await pickSecondRoom(db, room, opts.room2);
    stopStudy2 = await pickStudy(db, stopRoom2);
    console.log(`Другий кабінет: ${stopRoom2.name} [${stopRoom2.modality}] ${stopRoom2.id}`);
    console.log(`Склад 2: ${stopStudy2.type} / ${stopStudy2.region}`);
    stopRooms.push(room.id, stopRoom2.id);
    await assertRoomsUsableForStop(db, stopRooms);
  }

  /* CAS вимагає живого токена персоналу — службова роль до RPC не допущена
     за дизайном. Немає токена — чесний SKIP з інструкцією, а не імітація
     перевірки службовою роллю (вона дала б 42501 і виглядала б як «дефект»). */
  let user = null;
  if (cmd === "cas" || cmd === "waitlist" || cmd === "case" || cmd === "stop") {
    const jwt = process.env.RADFLOW_USER_JWT;
    if (!jwt) {
      console.log(`\nSKIP: немає RADFLOW_USER_JWT — сценарій ${cmd} не запускався.`);
      console.log("  RPC службову роль НЕ пускає (auth_clinic_id() = NULL → 42501/28000),");
      console.log("  тож без токена живого персоналу перевіряти нічого.");
      console.log("  Токен: сесія у COOKIE `sb-<ref>-auth-token` (@supabase/ssr), НЕ в localStorage.");
      console.log("         Готовий сніпет для консолі браузера — у шапці scripts/race-check.mjs.");
      console.log(`  Запуск: $env:RADFLOW_USER_JWT="..."; node scripts/race-check.mjs ${cmd} --run --room <uuid>`
        + (cmd === "stop" ? " --room2 <uuid>" : ""));
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
  const caseIds = [];
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
    } else if (cmd === "case") {
      /* ⚠️ СЦЕНАРІЙ РОЗБЛОКОВАНО В с63. Блокування с62 стояло через те, що
         постріл робився ОДИН раз, а з двох упорядкувань лише одне щось
         перевіряє. Тепер це вимога вердикту, а не сподівання: серія раундів,
         і хоча б один мусить лягти в «скасування → крок». Деталі — у
         `verdictCaseRounds` і docs/audit/PLAN-case-scenario-gaps.md. */
      const room2 = await pickSecondRoom(db, room, opts.room2);
      const study2 = await pickStudy(db, room2);
      console.log(`Другий кабінет: ${room2.name} [${room2.modality}] — ${study2.type} / ${study2.region}`);

      /* ⚠️ ДЛЯ ДРУГОГО КАБІНЕТА — СВІЙ `findSlots` (пункт 4 плану доробки).
         Раніше сюди йшли слоти, перевірені лише для кабінету A: у B свій
         графік, своя перерва і свої простої, тож слот міг бути непридатний —
         і крок падав би чужим SQLSTATE, а виглядало б це як зламаний гард. */
      const found2 = await findSlots(db, room2, study2, {
        days: DAYS, times: TIMES, count: TIMES.length, cleanupIds,
      });
      /* ⚠️ Слоти двох кабінетів мусять бути на ОДНУ дату і РІЗНИЙ час:
         `check_case_no_time_overlap` не дасть пацієнтові стояти у двох
         кабінетах одночасно (23P01), а різні дати зробили б сцену
         неправдоподібною. Кандидати `findSlots` рознесені на годину. */
      const slotA = slots.find((s) => found2.slots.some((x) => x.day === s.day && x.time !== s.time));
      const slotB = slotA ? found2.slots.find((x) => x.day === slotA.day && x.time !== slotA.time) : null;
      if (!slotA || !slotB) {
        throw new Error(
          "не знайшлось пари «та сама дата, різний час» для двох кабінетів.\n"
          + `  кабінет A: ${slots.map((s) => s.day + " " + s.time).join(", ")}\n`
          + `  кабінет B: ${found2.slots.map((s) => s.day + " " + s.time).join(", ")}`);
      }
      const rounds = Math.max(2, Math.min(20, Number(opts.rounds) || 8));
      console.log(`Слоти кейса: A ${slotA.day} ${slotA.time} · B ${slotB.day} ${slotB.time}`);
      console.log(`Раундів: ${rounds} (кожен зі своїм кейсом і прибиранням одразу)`);

      const series = await runCaseSeries(db, user, {
        room, study, room2, study2, slotA, slotB, rounds, cleanupIds, caseIds,
      });
      console.log(`  КОНТРОЛЬ (крок наодинці): ${series.control.verdict.verdict} — ${series.control.verdict.reason}`);
      if (series.control.left) console.log(`  ⚠️ контроль лишив по собі: ${series.control.left}`);
      for (const [i, r] of series.rounds.entries()) {
        const order = r.add.ok ? "крок → скасування" : "скасування → крок";
        console.log(`  раунд ${i + 1}: ${r.verdict.verdict} · ${order} · знято ${r.cancel.cancelled ?? "?"} кроків`
          + ` · кейс=${r.final.caseStatus ?? "?"} · розкид ${r.verdict.spread} мс`
          + (r.add.ok ? "" : ` · ${r.add.sqlstate}`));
        if (r.verdict.verdict !== "PASS") console.log(`      ${r.verdict.reason}`);
        if (r.cleanupLeft) console.log(`      ⚠️ прибирання раунду: ${r.cleanupLeft}`);
      }
      console.log(`  → ${series.verdict.verdict}: ${series.verdict.reason}`);
      code = series.verdict.verdict === "PASS" ? 0 : (series.verdict.verdict === "FAIL" ? 1 : 2);
    } else if (cmd === "stop") {
      /* ⚠️ ДЛЯ ДРУГОГО КАБІНЕТА — СВІЙ `findSlots`, а не слоти першого. Це
         пункт 4 з `PLAN-case-scenario-gaps.md`: сценарій `case` брав слоти,
         перевірені лише для кабінету A, і для B вони могли бути непридатні
         (свій графік, своя перерва, свій інцидент). Тут ця помилка не
         повторюється. */
      const found2 = await findSlots(db, stopRoom2, stopStudy2, {
        days: DAYS, times: TIMES, count: TIMES.length, cleanupIds,
      });
      /* Дата має бути СПІЛЬНА: `p_date` у RPC один на весь набір кабінетів. */
      const slotA = slots.find((s) => found2.slots.some((x) => x.day === s.day));
      const slotB = slotA ? found2.slots.find((x) => x.day === slotA.day) : null;
      if (!slotA || !slotB) {
        throw new Error(
          "спільної дати для двох кабінетів не знайшлось — аварійна зупинка бере ОДИН p_date.\n"
          + `  кабінет A: ${slots.map((s) => s.day).join(", ")}\n`
          + `  кабінет B: ${found2.slots.map((s) => s.day).join(", ")}`);
      }
      console.log(`Спільна дата зупинки: ${slotA.day} (A ${slotA.time}, B ${slotB.time})`);

      const race = await runEmergencyStopRace(db, user, {
        room, room2: stopRoom2, study, study2: stopStudy2, slotA, slotB, cleanupIds,
      });
      printStopOutcomes("ГОНКА АВАРІЙНИХ ЗУПИНОК (набір кабінетів у ПРОТИЛЕЖНОМУ порядку + «поломка»)",
        [...race.stops, race.breakdown]);
      for (const s of race.stops) {
        console.log(`  ${s.id}: зупинено кабінетів ${s.rooms.length}/${s.asked.length}`
          + `, знято з виклику ${s.affected ?? "?"}`);
      }
      console.log(`  поломка(B): ${race.breakdown.ok ? "простій створено" : `відмовлено ${race.breakdown.sqlstate}`}`);
      console.log(`  активних інцидентів у базі: `
        + Object.entries(race.byRoom).map(([r, k]) => `${r.slice(0, 8)}→${k}`).join(", "));
      console.log(`  → ${race.verdict.verdict}: ${race.verdict.reason}`);
      console.log(`  розкид стартів: ${race.verdict.spread} мс`);
      code = race.verdict.verdict === "PASS" ? 0 : (race.verdict.verdict === "FAIL" ? 1 : 2);
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

    /* ІНЦИДЕНТИ — ПЕРШИМИ, і це не стиль. Активний інцидент блокує РЕАЛЬНИЙ
       кабінет: доки він висить, кабінет для центру мертвий. Незнята фікстура
       черги коштує одного слота, незнятий інцидент — цілого кабінету.

       ⚠️ ЧОМУ ТУТ ЧИТАННЯ ПО КАБІНЕТАХ, А НЕ СПИСОК ID ІЗ ВІДПОВІДЕЙ RPC
       (правило с14 — прибирати за ЯВНИМ списком). Список із відповідей
       неповний за побудовою: постріл, чия відповідь загубилась у мережі,
       міг закомітити інцидент, id якого ми не побачили ніколи. Тому список
       будується ЧИТАННЯМ — і він лишається явним: id спершу вичитуються,
       друкуються, і лише потім видаляються поіменно.

       Право вважати ці рядки СВОЇМИ дає `assertRoomsUsableForStop`: він
       упав би ще до пострілу, якби в цих кабінетах був хоч один активний
       інцидент. Тобто before-image тут — «активних інцидентів 0», і він
       знятий, а не припущений. */
    if (stopRooms.length) {
      const inc = await step("вичитати інциденти зупинки", () => activeIncidentsByRoom(db, stopRooms));
      if (!inc) {
        console.log(`⚠️ НЕ вдалося вичитати інциденти — кабінети можуть лишитись ЗАБЛОКОВАНИМИ: ${stopRooms.join(", ")}`);
        console.log("   Зніміть простій у центрі руками або повторіть: node scripts/race-check.mjs stop --run");
        code = code || 1;
      } else if (inc.ids.length) {
        console.log(`  активних інцидентів до зняття: ${inc.ids.length} — ${inc.ids.join(", ")}`);
        const d = await step("видалити інциденти", () => cleanupIncidents(db, inc.ids));
        /* `cleanupIncidents` ПОВЕРТАЄ помилку, а не кидає — `step` її не спіймає. */
        if (!d || d.incidents) {
          console.log(`⚠️ інциденти НЕ видалено (${d?.incidents ?? "виняток"}): ${inc.ids.join(", ")}`);
          code = code || 1;
        }
        /* Звіряємо ЗАПИТОМ: «delete не повернув помилки» ≠ «рядків немає». */
        const after = await step("звірити зняття інцидентів", () => activeIncidentsByRoom(db, stopRooms));
        const leftInc = after ? after.ids.length : "?";
        console.log(`Інциденти: знято ${inc.ids.length}. Лишилось активних: ${leftInc}.`);
        if (leftInc !== 0) {
          console.log(`⚠️ КАБІНЕТИ ЛИШИЛИСЬ ЗАБЛОКОВАНИМИ: ${stopRooms.join(", ")} — зніміть простій у центрі.`);
          code = code || 1;
        }
      } else {
        console.log("Інциденти: активних немає (зупинка не відбулась або вже знята).");
      }
    }

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
    /* ⚠️ Кроки кейса — ПЕРЕД самим кейсом (FK `on delete set null`): видаливши
       кейс першим, ми обнулили б `case_id` і втратили б слід до кроків. Тому
       дочитуємо їх ДО `cleanup` вище — і робимо це навіть якщо `runCaseCancelRace`
       упав до свого читання. */
    if (caseIds.length) {
      const st = await step("дочитати кроки кейса", () =>
        db.from("queue_entries").select("id").in("case_id", caseIds));
      if (!st || st.error) {
        console.log(`⚠️ НЕ вдалося дочитати кроки кейса (${st?.error?.message ?? "виняток"}).`);
        console.log(`   Кейс НЕ видалено навмисно: ${caseIds.join(", ")}`);
        console.log("   Спершу прогляньте його кроки, потім: node scripts/race-check.mjs cleanup --run");
        code = code || 1;
      } else {
        /* ⚠️ БЕРЕМО ВСІ кроки, а не «ще не в списку» (знахідка ревʼю А, с62).
           Перша редакція фільтрувала `!cleanupIds.includes(id)` — і крок, чиє
           видалення вище ВЖЕ провалилось, випадав із повтору саме тому, що він
           у списку. Повторний delete по видаленому id — безпечний no-op, тож
           фільтр не економив нічого, а ціну мав високу. */
        const stepIds = (st.data || []).map((r) => r.id);
        let stepsGone = true;
        if (stepIds.length) {
          console.log(`  кроків кейса в базі: ${stepIds.length} — видаляю`);
          const d = await step("видалити кроки кейса", () => cleanup(db, stepIds));
          /* ⚠️ `cleanup` ПОВЕРТАЄ помилку, а не кидає — тож `step` її не
             спіймає, і мовчазне ігнорування результату було б дірою. */
          if (!d || d.entries) { stepsGone = false; console.log(`⚠️ кроки НЕ видалено (${d?.entries ?? "виняток"})`); }
        }
        /* Звіряємо ЗАПИТОМ, а не за поверненням delete: «delete не повернув
           помилки» ≠ «рядків немає». */
        const leftSteps = await step("звірити кроки кейса", () =>
          db.from("queue_entries").select("id").in("case_id", caseIds));
        const nSteps = leftSteps?.error ? "?" : (leftSteps?.data?.length ?? "?");
        if (nSteps !== 0) stepsGone = false;

        /* ⚠️ КЕЙС ВИДАЛЯЄМО, ЛИШЕ ЯКЩО КРОКІВ СПРАВДІ НЕ ЛИШИЛОСЬ. FK
           `on delete set null`: видаливши кейс над живим кроком, ми власноруч
           обнулили б `case_id` — тобто знищили б єдиний шлях, яким цей крок
           знаходиться за звʼязком. Знахідка ревʼю А: перша редакція видаляла
           кейс беззастережно і друкувала «Лишилось: 0», бо рахувала лише
           `patient_cases`. */
        if (!stepsGone) {
          console.log(`⚠️ Кейс НЕ видалено навмисно (кроків лишилось ${nSteps}): ${caseIds.join(", ")}`);
          console.log("   Добити: node scripts/race-check.mjs cleanup --run");
          code = code || 1;
        } else {
          const delC = await step("видалити кейси", () => cleanupCase(db, caseIds));
          if (delC?.cases) { console.log(`⚠️ кейс НЕ видалено (${delC.cases}): ${caseIds.join(", ")}`); code = code || 1; }
          const leftC = await step("звірити прибирання кейсів", () =>
            db.from("patient_cases").select("id").in("id", caseIds));
          const nLeft = leftC?.error ? "?" : (leftC?.data?.length ?? "?");
          console.log(`Кейси: прибрано ${caseIds.length} id, кроків 0. Лишилось кейсів: ${nLeft}.`);
          if (nLeft !== 0) { console.log("⚠️ Залишки кейсів! Добити: node scripts/race-check.mjs cleanup --run"); code = code || 1; }
        }
      }
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
