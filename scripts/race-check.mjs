/* RadFlow — харнес живої конкурентності (беклог №1, хвіст с32; сценарії
   «кабінет» і «CAS» — с42). Чиста логіка і вердикти — race-check-lib.mjs
   (під vitest).

     node scripts/race-check.mjs plan                      # нічого не пише
     node scripts/race-check.mjs run --run                 # ПИШЕ в прод: слот
     node scripts/race-check.mjs run --run --n 4 --room <uuid>
     node scripts/race-check.mjs room --run                # ПИШЕ: гонка за кабінет
     node scripts/race-check.mjs cas --run                 # ПИШЕ: паралельний CAS
     node scripts/race-check.mjs cleanup --run             # аварійне прибирання

   ТРИ СЦЕНАРІЇ — три РІЗНІ гаранти, і плутати їх не можна:
     run  — двоє пишуться в ОДИН слот     → тригер `check_no_overlap` (0064), 23P01;
     room — двох заводять в ОДИН кабінет  → унікальний індекс
            `queue_one_in_progress_per_room` (0018), 23505;
     cas  — двоє міняють статус ОДНОГО запису → `for update` + звірка
            `p_expected` всередині `queue_set_status_rpc` (0075), БЕЗ винятку:
            невдаха отримує `updated=false` і статус переможця.

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
  verdictSlotRace, verdictControl, verdictInProgressRace, verdictCas,
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
  return createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
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

async function cmdCleanup(db, write) {
  const { data, error } = await db
    .from("queue_entries").select("id, patient_name, scheduled_date, scheduled_time")
    .like("patient_name", `${FIXTURE_NAME}%`);
  if (error) throw new Error(`не читаються залишки: ${error.message}`);
  if (!data?.length) { console.log("Залишків фікстур немає."); return; }
  console.log(`Знайдено ${data.length} залишків:`);
  data.forEach((r) => console.log(`  ${r.id}  ${r.patient_name}  ${r.scheduled_date} ${r.scheduled_time}`));
  if (!write) { console.log("\nБез --run нічого не видалено."); return; }
  const ids = data.map((r) => r.id);
  await cleanup(db, ids);
  const left = await verifyClean(db, ids);
  console.log(`Прибрано. Лишилось: записів ${left.entriesLeft}, позначок ${left.markersLeft}.`);
}

async function main() {
  loadEnvLocal();
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const write = opts.run === true;
  const n = Math.max(2, Math.min(8, Number(opts.n) || 2));
  const db = adminClient();

  if (cmd === "help" || opts.help) {
    console.log("race-check.mjs plan | run --run [--n 2..8] [--room <uuid>] | room --run | cas --run | cleanup [--run]");
    console.log("  run  — двоє в ОДИН слот (тригер 0064)");
    console.log("  room — двох в ОДИН кабінет (унікальний індекс 0018)");
    console.log("  cas  — двоє міняють статус ОДНОГО запису (for update у 0075).");
    console.log("         Потрібен RADFLOW_USER_JWT — токен живого персоналу.");
    console.log("         Сесія у COOKIE (@supabase/ssr), не в localStorage — сніпет у шапці файлу.");
    console.log("         Живе ~годину. Не друкувати, не класти в лог, не слати в переписку.");
    return;
  }
  if (cmd === "cleanup") { await cmdCleanup(db, write); return; }
  if (!["plan", "run", "room", "cas"].includes(cmd)) throw new Error(`невідома команда «${cmd}»`);

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
    console.log("Інші сценарії: room --run (гонка за кабінет), cas --run (паралельний CAS).");
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
  if (cmd === "cas") {
    const jwt = process.env.RADFLOW_USER_JWT;
    if (!jwt) {
      console.log("\nSKIP: немає RADFLOW_USER_JWT — сценарій CAS не запускався.");
      console.log("  `queue_set_status_rpc` службову роль НЕ пускає (auth_clinic_id() = NULL → 42501),");
      console.log("  тож без токена живого персоналу перевіряти нічого.");
      console.log("  Токен: сесія у COOKIE `sb-<ref>-auth-token` (@supabase/ssr), НЕ в localStorage.");
      console.log("         Готовий сніпет для консолі браузера — у шапці scripts/race-check.mjs.");
      console.log("  Запуск: $env:RADFLOW_USER_JWT=\"...\"; node scripts/race-check.mjs cas --run");
      console.log("  Токен живе ~годину; у переписку й лог він не потрапляє.");
      return;
    }
    user = userClient(jwt);
  }

  const cleanupIds = [];
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
    await cleanup(db, cleanupIds);
    const left = await verifyClean(db, cleanupIds);
    console.log(`\nПрибрано ${cleanupIds.length} id. Лишилось: записів ${left.entriesLeft}, позначок ${left.markersLeft}.`);
    if (left.entriesLeft !== 0 || left.markersLeft !== 0) {
      console.log("⚠️ Залишки! Добити: node scripts/race-check.mjs cleanup --run");
      code = code || 1;
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
