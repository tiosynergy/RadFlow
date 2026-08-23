/* RadFlow — харнес живої конкурентності за слот (беклог №1, хвіст с32).
   Чиста логіка і вердикти — race-check-lib.mjs (під vitest).

     node scripts/race-check.mjs plan                      # нічого не пише
     node scripts/race-check.mjs run --run                 # ПИШЕ в прод
     node scripts/race-check.mjs run --run --n 4 --room <uuid>
     node scripts/race-check.mjs cleanup --run             # аварійне прибирання

   ⚠️ Пише в ПРОД (dev і prod — одна БД). Без `--run` жодного запису:
   `plan` лише знаходить придатний слот і друкує намір. Прибирання йде за
   ЯВНИМ списком id, згенерованих ДО пострілу (правило с14).

   ⚠️ Службова роль ОБХОДИТЬ RLS, але НЕ обходить тригери — а гарант гонки
   саме тригерний (`check_no_overlap`, 0064). Тому харнес перевіряє рівно
   той рубіж, що працює в проді. Чого він НЕ перевіряє: прав доступу.

   Канон Node-скриптів проєкту: split lib+CLI, main() виконується безумовно. */

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { parseArgs, isUuid, loadEnvLocal } from "./integration-admin-lib.mjs";
import {
  FIXTURE_NAME, FIXTURE_DUR_MIN, FIXTURE_BUF_MIN,
  MODALITY_STUDY_TYPE, buildFixture, clinicDay,
  verdictSlotRace, verdictControl,
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
    console.log("race-check.mjs plan | run --run [--n 2..8] [--room <uuid>] | cleanup [--run]");
    return;
  }
  if (cmd === "cleanup") { await cmdCleanup(db, write); return; }
  if (cmd !== "plan" && cmd !== "run") throw new Error(`невідома команда «${cmd}»`);

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
    return;
  }

  /* Гард запису. Без нього `run` писав би в ПРОД просто тому, що команда
     так називається — а прапорець `--run` існував би лише в довідці. */
  if (!write) {
    console.log("\n⚠️ `run` пише в ПРОД. Без --run нічого не виконано.");
    console.log("Запуск: node scripts/race-check.mjs run --run");
    return;
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
       за результат. */
    const control = await runControl(db, { room, study, slots, cleanupIds });
    printOutcomes(`КОНТРОЛЬ (${slots.length} різних слотів)`, control.outcomes);
    console.log(`  → ${control.verdict.verdict}: ${control.verdict.reason}\n`);
    if (control.verdict.verdict !== "PASS") {
      console.log("Гонку НЕ запускаємо: без справного контролю її результат неінтерпретований.");
      code = 2;
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
