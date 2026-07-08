// ============================================================
//  RadFlow — сидер ТЕСТОВИХ даних черги та листа очікування.
//
//  ЩО РОБИТЬ (для ОДНІЄЇ клініки):
//   1. ПОВНІСТЮ видаляє waitlist_entries і queue_entries клініки (чистка тестових даних!).
//   2. Наповнює чергу на сьогодні + 7 днів уперед (без неділь):
//        • від АДМІНІСТРАТОРА (реєстратури) — 5–7 записів/день;
//        • від НАПРАВНИКІВ — 3–5 записів/день; направник із доступом до кількох
//          кабінетів розкладає своїх пацієнтів у РІЗНІ кабінети;
//        • у кожному кабінеті лишаються ВІЛЬНІ слоти (1–3 на день).
//      Розклад — без перетинів (тригер check_no_overlap) і в обхід ПЕРЕРВ кабінету
//      (нова фіча: rooms.schedule.breaks). Минулі сьогоднішні слоти → done/no_show.
//   3. Лист очікування: 3–5 пацієнтів НА КОЖЕН кабінет, прив'язані до нього (room_id),
//      частина від адміністратора, частина від направників (з доступом до кабінету).
//
//  Запуск (env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — або .env.local):
//      node scripts/seed-test-data.mjs                  # якщо клініка одна
//      node scripts/seed-test-data.mjs "Medicom"        # або явно за назвою
//
//  УВАГА: скрипт ДЕСТРУКТИВНИЙ для записів обраної клініки. Тільки для тестових баз.
//  Довідник досліджень продубльовано з lib/studies.ts (сид, дрейф не критичний).
// ============================================================

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

function loadEnvLocal() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const file = path.join(root, ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnvLocal();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Відсутні NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY у середовищі.");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

/* ── Довідник (копія lib/studies.ts) ── */
const MRT = [
  ["Головний мозок", 60, 2400, true], ["Хребет — шийний відділ", 40, 2100, true],
  ["Хребет — грудний відділ", 40, 2100, true], ["Хребет — поперековий відділ", 45, 2100, true],
  ["Колінний суглоб", 30, 1800, false], ["Плечовий суглоб", 30, 1800, false],
  ["Кульшовий суглоб", 35, 1900, false], ["Черевна порожнина", 50, 2600, true],
  ["Малий таз", 45, 2600, true], ["Серце та судини", 60, 3200, true], ["Молочні залози", 50, 2700, true],
];
const CT = [
  ["Голова / мозок", 15, 1200, true], ["Органи грудної клітки", 20, 1500, true],
  ["Органи черевної порожнини", 25, 1700, true], ["Малий таз", 20, 1500, true],
  ["Хребет", 20, 1400, false], ["Кінцівки", 15, 1200, false], ["КТ-ангіографія", 30, 2400, true],
];
const CONTRAST_DUR = 15, CONTRAST_SURCHARGE = 900;

/* ── Генератори пацієнтів ── */
const SUR_M = ["Шевченко", "Бондаренко", "Коваленко", "Ткаченко", "Кравченко", "Мельник", "Поліщук", "Савченко", "Руденко", "Мороз", "Лисенко", "Петренко"];
const SUR_F = ["Шевченко", "Бондаренко", "Коваленко", "Ткаченко", "Кравчук", "Мельник", "Іваненко", "Савчук", "Руденко", "Мороз", "Лисенко", "Данилюк"];
const NAME_M = ["Олександр", "Андрій", "Василь", "Дмитро", "Іван", "Микола", "Олег", "Павло", "Сергій", "Тарас", "Юрій", "Богдан"];
const NAME_F = ["Олена", "Анна", "Вікторія", "Дарина", "Ірина", "Катерина", "Марія", "Наталія", "Оксана", "Світлана", "Тетяна", "Юлія"];
const PATRO_M = ["Олександрович", "Андрійович", "Васильович", "Дмитрович", "Іванович", "Миколайович", "Олегович", "Петрович", "Сергійович"];
const PATRO_F = ["Олександрівна", "Андріївна", "Василівна", "Дмитрівна", "Іванівна", "Миколаївна", "Олегівна", "Петрівна", "Сергіївна"];

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const pad = (n) => String(n).padStart(2, "0");
const chance = (p) => Math.random() < p;
const toMin = (t) => { const [h, m] = String(t || "").split(":").map(Number); return (h || 0) * 60 + (m || 0); };

function mkPatient() {
  const male = chance(0.45);
  const name = male
    ? `${pick(SUR_M)} ${pick(NAME_M)} ${pick(PATRO_M)}`
    : `${pick(SUR_F)} ${pick(NAME_F)} ${pick(PATRO_F)}`;
  const year = 1950 + rnd(56); // 1950–2005
  const dob = `${year}-${pad(1 + rnd(12))}-${pad(1 + rnd(28))}`;
  const age = new Date().getFullYear() - year;
  const phone = `+380 ${pad(50 + rnd(48))} ${String(100 + rnd(900))} ${pad(rnd(100))} ${pad(rnd(100))}`;
  return { name, dob, age, sex: male ? "М" : "Ж", phone, weight: chance(0.6) ? 50 + rnd(60) : null };
}

function mkStudy(modality) {
  const [region, dur0, price0, canContrast] = pick(modality === "CT" ? CT : MRT);
  const contrast = canContrast && chance(0.25);
  return {
    type: modality === "CT" ? "КТ" : "МРТ",
    region,
    contrast,
    dur: dur0 + (contrast ? CONTRAST_DUR : 0),
    price: price0 + (contrast ? CONTRAST_SURCHARGE : 0),
  };
}

const mkPriority = () => (chance(0.04) ? "cito" : chance(0.14) ? "urgent" : "planned");
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

/* ── Перерви кабінету (порт lib/schedule.ts: normalizeBreaks + roomBreaksFor) ── */
function normBreaks(o) {
  if (!o || typeof o !== "object") return [];
  const raw = o.breaks;
  if (Array.isArray(raw)) {
    return raw.filter((b) => b && b.start && b.end && String(b.start) < String(b.end)).map((b) => ({ s: toMin(b.start), e: toMin(b.end) }));
  }
  if (o.lunch === true && o.lunchS && o.lunchE && String(o.lunchS) < String(o.lunchE)) return [{ s: toMin(o.lunchS), e: toMin(o.lunchE) }];
  return [];
}
function roomBreaksMin(schedule, date) {
  if (!schedule || typeof schedule !== "object") return [];
  const widx = (date.getDay() + 6) % 7; // Пн..Нд = 0..6
  if (schedule.perDay && Array.isArray(schedule.dayHours) && schedule.dayHours[widx]) return normBreaks(schedule.dayHours[widx]);
  return normBreaks(schedule);
}

const SCHED_START = 8 * 60, SCHED_END = 18 * 60;
// Не заповнюємо кабінет пізніше цього часу — гарантуємо вільні слоти в кінці дня.
const FILL_UNTIL = 16 * 60;

/* Наступний вільний старт у кабінеті: без перетину з попередніми (курсор) і
   в обхід перерв. Повертає хвилини старту або null, якщо кабінет заповнений. */
function nextSlot(cursor, breaks, durationMin, buffer) {
  let start = cursor.v;
  for (let guard = 0; guard < 48; guard++) {
    if (start + durationMin > FILL_UNTIL) return null;
    const hit = breaks.find((b) => start < b.e && b.s < start + durationMin);
    if (hit) { start = Math.ceil(hit.e / 30) * 30; continue; }
    cursor.v = start + Math.ceil((durationMin + buffer) / 30) * 30;
    return start;
  }
  return null;
}

async function main() {
  // ── Клініка ──
  const nameArg = process.argv[2];
  const { data: clinics, error: cErr } = await db.from("clinics").select("id, name");
  if (cErr) throw cErr;
  const clinic = nameArg ? clinics.find((c) => c.name === nameArg) : clinics.length === 1 ? clinics[0] : null;
  if (!clinic) {
    console.error(nameArg
      ? `Клініку "${nameArg}" не знайдено. Наявні: ${clinics.map((c) => c.name).join(", ")}`
      : `Клінік декілька — вкажіть назву аргументом. Наявні: ${clinics.map((c) => c.name).join(", ")}`);
    process.exitCode = 1; return;
  }
  console.log(`Клініка: ${clinic.name} (${clinic.id})`);

  const { data: rooms } = await db.from("rooms").select("id, name, modality, schedule").eq("clinic_id", clinic.id).order("name");
  if (!rooms?.length) { console.error("У клініки немає кабінетів."); process.exitCode = 1; return; }
  console.log(`Кабінети: ${rooms.map((r) => `${r.name} (${r.modality})`).join(", ")}`);

  const { data: admin } = await db.from("profiles").select("id").eq("clinic_id", clinic.id).eq("role", "admin").limit(1).maybeSingle();
  const createdBy = admin?.id ?? null;

  // ── Направники з активним доступом + їх доступні кабінети (room_ids/modalities) ──
  const { data: access } = await db.from("referral_access")
    .select("referrer_id, room_ids, modalities, status").eq("clinic_id", clinic.id).eq("status", "active");
  const referrers = (access || []).map((a) => {
    const roomsFor = rooms.filter((r) =>
      (!a.room_ids || a.room_ids.length === 0 || a.room_ids.includes(r.id)) &&
      (!a.modalities || a.modalities.length === 0 || a.modalities.includes(r.modality))
    );
    return { id: a.referrer_id, rooms: roomsFor };
  }).filter((r) => r.id && r.rooms.length > 0);
  if (referrers.length) {
    console.log(`Направники: ${referrers.length} (кабінетів у доступі: ${referrers.map((r) => r.rooms.length).join("/")})`);
  } else {
    console.log("Направники з доступом не знайдені — записи від направників пропущено.");
  }
  const refRoomIdx = Object.fromEntries(referrers.map((r) => [r.id, 0])); // курсор кабінетів для рівномірного розподілу

  // ── 1. Чистка ──
  const del1 = await db.from("waitlist_entries").delete().eq("clinic_id", clinic.id).select("id");
  const del2 = await db.from("queue_entries").delete().eq("clinic_id", clinic.id).select("id");
  if (del1.error) throw del1.error;
  if (del2.error) throw del2.error;
  console.log(`Видалено: queue_entries=${del2.data?.length ?? 0}, waitlist_entries=${del1.data?.length ?? 0}`);

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  let admOk = 0, refOk = 0, insFail = 0;

  // Вставка одного запису черги в конкретний кабінет; повертає true при успіху.
  async function placeEntry(day, isToday, room, cursor, breaks, creator, referrerId) {
    const modality = room.modality === "CT" ? "CT" : "MRI";
    const study = mkStudy(modality);
    const extra = chance(0.12) ? [mkStudy(modality)] : [];
    const studies = [study, ...extra];
    const durationMin = studies.reduce((s, x) => s + x.dur, 0);
    const buffer = chance(0.15) ? 10 : 5;
    const start = nextSlot(cursor, breaks, durationMin, buffer);
    if (start == null) return false;

    const time = fmtMin(start);
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(start / 60), start % 60);
    const past = isToday && start + durationMin < nowMin;
    const status = past ? (chance(0.12) ? "no_show" : "done") : "scheduled";
    const callStatus = status === "scheduled" ? (chance(0.5) ? "confirmed" : "not_called") : "confirmed";
    const p = mkPatient();

    const { error } = await db.from("queue_entries").insert({
      clinic_id: clinic.id, room_id: room.id, created_by: creator, referrer_id: referrerId,
      patient_name: p.name, patient_phone: p.phone, patient_dob: p.dob,
      patient_sex: p.sex, patient_age: p.age, patient_weight: p.weight,
      studies, studies_original: studies,
      has_contrast: studies.some((s) => s.contrast),
      contraindications: chance(0.05),
      priority_level: mkPriority(),
      duration_min: durationMin, buffer_time_min: buffer,
      scheduled_date: dateKey(day), scheduled_time: time, scheduled_at: at.toISOString(),
      status, call_status: callStatus,
      note: chance(0.12) ? "Тестовий запис (сид)" : null,
    });
    if (error) { insFail++; console.warn(`  ! ${dateKey(day)} ${time} ${room.name}: ${error.message}`); return false; }
    return true;
  }

  // ── 2. Черга: сьогодні + 7 днів (без неділь) ──
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    if (day.getDay() === 0) continue; // неділя — кабінети зачинені
    const isToday = offset === 0;
    const cursors = Object.fromEntries(rooms.map((r) => [r.id, { v: SCHED_START }]));
    const breaksBy = Object.fromEntries(rooms.map((r) => [r.id, roomBreaksMin(r.schedule, day)]));
    let dayAdm = 0, dayRef = 0;

    // Адміністратор/реєстратура — 5–7 записів у будь-які кабінети.
    const adminTarget = 5 + rnd(3);
    for (let k = 0, guard = 0; dayAdm < adminTarget && guard < 60; guard++) {
      // кабінет із найменшим курсором (рівномірне заповнення), МРТ трохи частіше
      const cand = [...rooms].sort((a, b) => cursors[a.id].v - cursors[b.id].v);
      const room = (chance(0.6) && cand.find((r) => r.modality === "MRI")) || cand[0];
      if (await placeEntry(day, isToday, room, cursors[room.id], breaksBy[room.id], createdBy, null)) { dayAdm++; admOk++; }
      else if (rooms.every((r) => cursors[r.id].v + 30 > FILL_UNTIL)) break; // всі кабінети повні
      k++;
    }

    // Направники — 3–5 записів; кожен розкладає у РІЗНІ свої кабінети (round-robin).
    if (referrers.length) {
      const refTarget = 3 + rnd(3);
      for (let k = 0, guard = 0; dayRef < refTarget && guard < 80; guard++, k++) {
        const ref = referrers[k % referrers.length];
        // наступний кабінет цього направника (розподіл по різних кабінетах)
        let placed = false;
        for (let t = 0; t < ref.rooms.length && !placed; t++) {
          const room = ref.rooms[(refRoomIdx[ref.id] + t) % ref.rooms.length];
          placed = await placeEntry(day, isToday, room, cursors[room.id], breaksBy[room.id], ref.id, ref.id);
        }
        if (placed) { refRoomIdx[ref.id] = (refRoomIdx[ref.id] + 1) % ref.rooms.length; dayRef++; refOk++; }
        else if (referrers.every((rf) => rf.rooms.every((r) => cursors[r.id].v + 30 > FILL_UNTIL))) break;
      }
    }
    console.log(`${dateKey(day)}: адмін ${dayAdm}, направники ${dayRef}`);
  }

  // ── 3. Лист очікування: 3–5 пацієнтів НА КОЖЕН кабінет (прив'язані), мікс авторів ──
  let wlOk = 0, wlFail = 0;
  const WINDOWS = [[null, null], ["08:00", "12:00"], ["12:00", "16:00"], ["16:00", "20:00"]];
  for (const room of rooms) {
    const refsForRoom = referrers.filter((r) => r.rooms.some((x) => x.id === room.id));
    const n = 3 + rnd(3); // 3..5
    for (let k = 0; k < n; k++) {
      const p = mkPatient();
      const study = mkStudy(room.modality === "CT" ? "CT" : "MRI");
      const useRef = refsForRoom.length > 0 && chance(0.45);
      const ref = useRef ? pick(refsForRoom) : null;
      const [wf, wt] = pick(WINDOWS);
      const { error } = await db.from("waitlist_entries").insert({
        clinic_id: clinic.id, room_id: room.id, // жорстка прив'язка до кабінету
        created_by: ref ? ref.id : createdBy, referrer_id: ref ? ref.id : null,
        patient_name: p.name, patient_phone: p.phone, patient_dob: p.dob,
        patient_sex: p.sex, patient_age: p.age, patient_weight: p.weight,
        studies: [study], duration_min: study.dur, buffer_time_min: 5,
        modality: room.modality === "CT" ? "CT" : "MRI", priority_level: mkPriority(),
        desired_date_from: dateKey(now),
        desired_date_to: chance(0.6) ? dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 14)) : null,
        desired_time_from: wf, desired_time_to: wt,
        note: chance(0.4) ? "Тестовий пацієнт листа очікування (сид)" : null,
        status: "waiting",
      });
      if (error) { wlFail++; console.warn(`  ! waitlist ${room.name}: ${error.message}`); }
      else wlOk++;
    }
  }

  console.log(`\nГотово: черга +${admOk + refOk} (адмін ${admOk}, направники ${refOk}; відхилено тригерами ${insFail}), лист очікування +${wlOk}${wlFail ? ` (помилок ${wlFail})` : ""}.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
