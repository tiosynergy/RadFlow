// ============================================================
//  RadFlow — сидер ТЕСТОВИХ даних черги та листа очікування.
//
//  ЩО РОБИТЬ (для ОДНІЄЇ клініки):
//   1. ПОВНІСТЮ видаляє waitlist_entries і queue_entries клініки (чистка тестових даних!).
//   2. Наповнює чергу: сьогодні + 7 днів уперед (без неділь), 10–15 пацієнтів/день,
//      розкладених по кабінетах БЕЗ перетинів (тригер check_no_overlap все одно пильнує).
//      Минулі сьогоднішні слоти отримують статус done/no_show для реалізму.
//   3. Додає 5 пацієнтів у лист очікування (cito/urgent/planned, різні бажані вікна).
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

const mkPriority = () => (chance(0.02) ? "cito" : chance(0.1) ? "urgent" : "planned");
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

async function main() {
  // ── Клініка ──
  const nameArg = process.argv[2];
  const { data: clinics, error: cErr } = await db.from("clinics").select("id, name");
  if (cErr) throw cErr;
  let clinic = nameArg ? clinics.find((c) => c.name === nameArg) : clinics.length === 1 ? clinics[0] : null;
  if (!clinic) {
    console.error(nameArg
      ? `Клініку "${nameArg}" не знайдено. Наявні: ${clinics.map((c) => c.name).join(", ")}`
      : `Клінік декілька — вкажіть назву аргументом. Наявні: ${clinics.map((c) => c.name).join(", ")}`);
    process.exit(1);
  }
  console.log(`Клініка: ${clinic.name} (${clinic.id})`);

  const { data: rooms } = await db.from("rooms").select("id, name, modality").eq("clinic_id", clinic.id).order("name");
  if (!rooms?.length) { console.error("У клініки немає кабінетів."); process.exit(1); }
  console.log(`Кабінети: ${rooms.map((r) => `${r.name} (${r.modality})`).join(", ")}`);

  const { data: admin } = await db.from("profiles").select("id").eq("clinic_id", clinic.id).eq("role", "admin").limit(1).maybeSingle();
  const createdBy = admin?.id ?? null;

  // ── 1. Чистка ──
  const del1 = await db.from("waitlist_entries").delete().eq("clinic_id", clinic.id).select("id");
  const del2 = await db.from("queue_entries").delete().eq("clinic_id", clinic.id).select("id");
  if (del1.error) throw del1.error;
  if (del2.error) throw del2.error;
  console.log(`Видалено: queue_entries=${del2.data?.length ?? 0}, waitlist_entries=${del1.data?.length ?? 0}`);

  // ── 2. Черга: сьогодні + 7 днів (без неділь), 10–15 пацієнтів/день ──
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  let insOk = 0, insFail = 0;

  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    if (day.getDay() === 0) continue; // неділя — кабінети зачинені
    const isToday = offset === 0;
    const target = 10 + rnd(6); // 10–15
    const cursors = Object.fromEntries(rooms.map((r) => [r.id, 8 * 60])); // з 08:00
    let made = 0, guard = 0;

    while (made < target && guard++ < 200) {
      // МРТ трохи частіше за КТ; кабінет має вміщувати дослідження до 18:00.
      const room = pick(rooms.filter((r) => (chance(0.6) ? r.modality === "MRI" : true))) || pick(rooms);
      const study = mkStudy(room.modality === "CT" ? "CT" : "MRI");
      const extra = chance(0.15) ? [mkStudy(room.modality === "CT" ? "CT" : "MRI")] : [];
      const studies = [study, ...extra];
      const durationMin = studies.reduce((s, x) => s + x.dur, 0);
      const buffer = chance(0.15) ? 10 : 5;
      const start = cursors[room.id];
      if (start + durationMin > 18 * 60) { // не вміщується — кабінет на сьогодні повний
        if (rooms.every((r) => cursors[r.id] + 30 > 18 * 60)) break;
        continue;
      }
      // Крок сітки 30 хв: наступний слот після (тривалість + буфер).
      cursors[room.id] = start + Math.ceil((durationMin + buffer) / 30) * 30;

      const time = fmtMin(start);
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(start / 60), start % 60);
      const endMin = start + durationMin;
      // Минулі сьогоднішні — done (10% no_show); майбутні/інші дні — scheduled.
      const past = isToday && endMin < nowMin;
      const status = past ? (chance(0.1) ? "no_show" : "done") : "scheduled";
      const callStatus = status === "scheduled" ? (offset <= 1 && chance(0.6) ? "confirmed" : "not_called") : "confirmed";
      const p = mkPatient();

      const { error } = await db.from("queue_entries").insert({
        clinic_id: clinic.id, room_id: room.id, created_by: createdBy,
        patient_name: p.name, patient_phone: p.phone, patient_dob: p.dob,
        patient_sex: p.sex, patient_age: p.age, patient_weight: p.weight,
        studies, studies_original: studies,
        has_contrast: studies.some((s) => s.contrast),
        contraindications: chance(0.05),
        priority_level: mkPriority(),
        duration_min: durationMin, buffer_time_min: buffer,
        scheduled_date: dateKey(day), scheduled_time: time, scheduled_at: at.toISOString(),
        status, call_status: callStatus,
        note: chance(0.15) ? "Тестовий запис (сид)" : null,
      });
      if (error) { insFail++; console.warn(`  ! ${dateKey(day)} ${time}: ${error.message}`); }
      else { insOk++; made++; }
    }
    console.log(`${dateKey(day)}: ${made} записів`);
  }

  // ── 3. Лист очікування: 5 пацієнтів ──
  const WL = [
    { prio: "cito", mod: "MRI", from: null, to: null },
    { prio: "urgent", mod: "MRI", from: "08:00", to: "12:00" },
    { prio: "planned", mod: "MRI", from: "16:00", to: "20:00" },
    { prio: "planned", mod: "CT", from: null, to: null },
    { prio: "planned", mod: "CT", from: "12:00", to: "16:00" },
  ];
  let wlOk = 0;
  for (const w of WL) {
    const p = mkPatient();
    const study = mkStudy(w.mod);
    const { error } = await db.from("waitlist_entries").insert({
      clinic_id: clinic.id, created_by: createdBy,
      patient_name: p.name, patient_phone: p.phone, patient_dob: p.dob,
      patient_sex: p.sex, patient_age: p.age, patient_weight: p.weight,
      studies: [study], duration_min: study.dur, buffer_time_min: 5,
      modality: w.mod, priority_level: w.prio,
      desired_date_from: dateKey(now),
      desired_date_to: chance(0.6) ? dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 14)) : null,
      desired_time_from: w.from, desired_time_to: w.to,
      note: chance(0.4) ? "Тестовий пацієнт листа очікування (сид)" : null,
      status: "waiting",
    });
    if (error) console.warn(`  ! waitlist: ${error.message}`);
    else wlOk++;
  }

  console.log(`Готово: черга +${insOk} (відхилено тригерами: ${insFail}), лист очікування +${wlOk}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
