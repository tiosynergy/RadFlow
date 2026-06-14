/* ===== RadFlow — Seed data ===== */
// Statuses: 'waiting' | 'cabinet' | 'done' | 'noshow'
window.RF_TODAY = "П'ятниця, 30 травня 2026";

window.RF_ROOMS = {
  r1: { name: "Кабінет №1", model: "Siemens Avanto 1.5T", kind: "МРТ" },
  r2: { name: "Кабінет №2", model: "GE Optima", kind: "КТ" },
  r3: { name: "Кабінет №3", model: "Philips Ingenia 3.0T", kind: "МРТ" },
  r4: { name: "Кабінет №4", model: "Siemens Magnetom", kind: "МРТ" },
  r5: { name: "Кабінет №5", model: "Canon Aquilion", kind: "КТ" },
  r6: { name: "Кабінет №6", model: "Toshiba Activion", kind: "КТ" },
  r7: { name: "Кабінет №7", model: "Philips Incisive", kind: "КТ" },
};

// secondsInCabinet only meaningful for the active 'cabinet' patient
window.RF_PATIENTS = [
  { id: 1,  time: "08:00", name: "Коваленко Марія Олегівна",      age: 34, phone: "+38 067 214 88 03", proc: "МРТ колінного суглоба",                  dur: 30, room: "r1", status: "done" },
  { id: 2,  time: "08:40", name: "Бондаренко Олег Петрович",       age: 57, phone: "+38 050 332 17 90", proc: "КТ органів грудної клітки",             dur: 20, room: "r2", status: "done" },
  { id: 3,  time: "09:10", name: "Ткаченко Ірина Василівна",       age: 41, phone: "+38 063 901 45 22", proc: "МРТ хребта (поперековий відділ)",       dur: 45, room: "r1", status: "done" },
  { id: 4,  time: "09:30", name: "Мороз Андрій Сергійович",        age: 29, phone: "+38 097 555 10 64", proc: "КТ голови",                            dur: 15, room: "r2", status: "done" },
  { id: 5,  time: "10:00", name: "Шевченко Людмила Іванівна",      age: 63, phone: "+38 066 818 27 41", proc: "МРТ головного мозку з контрастом",      dur: 75, room: "r1", status: "noshow" },
  { id: 6,  time: "10:30", name: "Петренко Василь Іванович",       age: 48, phone: "+38 050 123 45 67", proc: "МРТ головного мозку без контрасту",     dur: 60, room: "r1", status: "cabinet", secondsInCabinet: 34*60 },
  { id: 7,  time: "10:50", name: "Гнатюк Софія Андріївна",         age: 26, phone: "+38 073 440 12 88", proc: "КТ черевної порожнини з контрастом",    dur: 40, room: "r2", status: "cabinet" },
  { id: 8,  time: "11:30", name: "Сидоренко Наталія Володимирівна",age: 52, phone: "+38 098 277 63 19", proc: "МРТ плечового суглоба",                 dur: 30, room: "r1", status: "waiting" },
  { id: 9,  time: "12:15", name: "Лисенко Юлія Романівна",         age: 38, phone: "+38 095 612 90 77", proc: "КТ органів грудної клітки",             dur: 20, room: "r2", status: "waiting" },
  { id: 10, time: "12:45", name: "Кравчук Дмитро Олександрович",   age: 45, phone: "+38 067 703 55 12", proc: "МРТ черевної порожнини",                dur: 50, room: "r1", status: "waiting" },
  { id: 11, time: "13:30", name: "Поліщук Вікторія Тарасівна",     age: 31, phone: "+38 050 909 41 23", proc: "КТ нирок та сечовивідних шляхів",       dur: 25, room: "r2", status: "waiting" },
  { id: 12, time: "14:10", name: "Савченко Богдан Юрійович",       age: 60, phone: "+38 063 188 74 50", proc: "МРТ головного мозку без контрасту",     dur: 60, room: "r1", status: "waiting" },
  { id: 13, time: "14:50", name: "Мельник Олена Степанівна",       age: 44, phone: "+38 097 326 80 15", proc: "КТ органів грудної клітки з контрастом",dur: 35, room: "r2", status: "waiting" },
  { id: 14, time: "15:30", name: "Захарченко Артем Ігорович",      age: 22, phone: "+38 073 654 02 99", proc: "МРТ колінного суглоба",                 dur: 30, room: "r1", status: "waiting" },
  { id: 15, time: "09:40", name: "Онищенко Роман Анатолійович",   age: 39, phone: "+38 067 511 23 09", proc: "МРТ головного мозку",                    dur: 30, room: "r3", status: "cabinet" },
  { id: 16, time: "11:00", name: "Данилюк Оксана Василівна",        age: 47, phone: "+38 050 712 84 50", proc: "МРТ хребта (шийний відділ)",          dur: 45, room: "r3", status: "waiting" },
  { id: 17, time: "10:20", name: "Ковальчук Ігор Миколайович",     age: 33, phone: "+38 097 224 61 77", proc: "МРТ колінного суглоба",                 dur: 30, room: "r4", status: "waiting" },
  { id: 18, time: "08:30", name: "Руденко Алла Петрівна",            age: 55, phone: "+38 063 808 19 42", proc: "МРТ плечового суглоба",                 dur: 30, room: "r4", status: "done" },
  { id: 19, time: "11:10", name: "Бабенко Сергій Олегович",        age: 61, phone: "+38 066 433 70 18", proc: "КТ органів грудної клітки",             dur: 20, room: "r5", status: "cabinet" },
  { id: 20, time: "12:00", name: "Ткач Марина Володимирівна",        age: 28, phone: "+38 073 190 55 23", proc: "КТ голови",                            dur: 15, room: "r5", status: "waiting" },
  { id: 21, time: "13:15", name: "Мазур Олександр Юрійович",       age: 50, phone: "+38 050 661 02 38", proc: "КТ черевної порожнини",                dur: 40, room: "r6", status: "waiting" },
  { id: 22, time: "09:00", name: "Левчук Тетяна Сергіївна",         age: 36, phone: "+38 097 745 30 61", proc: "КТ нирок та сечовивідних шляхів",       dur: 25, room: "r7", status: "done" },
  { id: 23, time: "14:30", name: "Сорока Віктор Павлович",          age: 58, phone: "+38 063 559 88 14", proc: "КТ органів грудної клітки",             dur: 20, room: "r6", status: "waiting" },
];

window.RF_STATUS_META = {
  waiting:  { label: "Очікує",       cls: "gray",  dot: false },
  cabinet:  { label: "В кабінеті",   cls: "blue",  dot: true  },
  done:     { label: "Виконано",     cls: "green", dot: false },
  noshow:   { label: "Не відбулось", cls: "red",   dot: false },
};

// Кабінети, у сценаріях яких є непрочитані зміни (колл-лист / зміни черги) → червоний кружечок
window.RF_CABINET_ALERTS = ["r1", "r3"];

// Лікарі-направлячі
window.RF_DOCTORS = [
  { id: 1, name: "Іваненко Сергій Петрович", spec: "Невролог", clinic: "Клініка «Здоров'я»", phone: "+38 067 100 22 33", refs: 24 },
  { id: 2, name: "Гончар Наталія Вікторівна", spec: "Ортопед-травматолог", clinic: "МЦ «Ортес»", phone: "+38 050 200 33 44", refs: 18 },
  { id: 3, name: "Бойчук Андрій Іванович", spec: "Онколог", clinic: "Онкоцентр", phone: "+38 063 300 44 55", refs: 31 },
];
