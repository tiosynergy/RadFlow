/* ===== RadFlow — Seed data ===== */
// Statuses: 'queued' (записаний, ще не прийшов) | 'waiting' (прийшов, очікує) | 'cabinet' | 'done' | 'noshow'
// call (підтвердження по колл-листу напередодні): 'confirmed' | 'noanswer' | 'callback' | 'refused' | 'pending'

/* ===== Реальні дати (календар прив'язаний до системного годинника) ===== */
window.RF_WEEKDAYS_UK = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"]; // getDay(): 0=Нд
window.RF_WEEKDAYS_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];                                  // сітка від понеділка
window.RF_MONTHS_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
window.RF_MONTHS_NOM = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
window.rfToday = function () { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
window.rfAddDays = function (d, n) { const x = new Date(d); x.setDate(x.getDate() + n); x.setHours(0, 0, 0, 0); return x; };
window.rfSameDay = function (a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); };
window.rfFmtFull = function (d) { return window.RF_WEEKDAYS_UK[d.getDay()] + ", " + d.getDate() + " " + window.RF_MONTHS_GEN[d.getMonth()] + " " + d.getFullYear(); };
window.rfFmtShort = function (d) { return d.getDate() + " " + window.RF_MONTHS_GEN[d.getMonth()]; };
// getDay() з понеділка (0=Пн … 6=Нд) — для розкладки сітки календаря
window.rfDowMon = function (d) { return (d.getDay() + 6) % 7; };
window.rfIsWorkday = function (d) { return d.getDay() !== 0; }; // клініка працює Пн–Сб, неділя — вихідний

window.RF_TODAY = window.rfFmtFull(window.rfToday());

/* Порядок відображення черги = реальний потік пацієнта:
   В кабінеті → Очікують → В черзі → Виконано → Не відбулось (всередині групи — за часом). */
window.RF_FLOW_ORDER = { cabinet: 0, waiting: 1, queued: 2, done: 3, noshow: 4 };
window.rfSortFlow = function (list) {
  const o = window.RF_FLOW_ORDER;
  const rank = function (s) { return (o[s] === undefined ? 9 : o[s]); };
  return list.slice().sort(function (a, b) {
    const d = rank(a.status) - rank(b.status);
    if (d !== 0) return d;
    return (a.time || "").localeCompare(b.time || "");
  });
};

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
  { id: 1,  time: "08:00", name: "Коваленко Марія Олегівна",      age: 34, phone: "+38 067 214 88 03", proc: "МРТ колінного суглоба",                  dur: 30, room: "r1", status: "done", call: "confirmed" },
  { id: 2,  time: "08:40", name: "Бондаренко Олег Петрович",       age: 57, phone: "+38 050 332 17 90", proc: "КТ органів грудної клітки",             dur: 20, room: "r2", status: "done", call: "confirmed" },
  { id: 3,  time: "09:10", name: "Ткаченко Ірина Василівна",       age: 41, phone: "+38 063 901 45 22", proc: "МРТ хребта (поперековий відділ)",       dur: 45, room: "r1", status: "done", call: "confirmed" },
  { id: 4,  time: "09:30", name: "Мороз Андрій Сергійович",        age: 29, phone: "+38 097 555 10 64", proc: "КТ голови",                            dur: 15, room: "r2", status: "done", call: "confirmed" },
  { id: 5,  time: "10:00", name: "Шевченко Людмила Іванівна",      age: 63, phone: "+38 066 818 27 41", proc: "МРТ головного мозку з контрастом",      dur: 75, room: "r1", status: "noshow", call: "noanswer" },
  { id: 6,  time: "10:30", name: "Петренко Василь Іванович",       age: 48, phone: "+38 050 123 45 67", proc: "МРТ головного мозку без контрасту",     dur: 60, room: "r1", status: "cabinet", secondsInCabinet: 34*60, call: "confirmed" },
  { id: 7,  time: "10:50", name: "Гнатюк Софія Андріївна",         age: 26, phone: "+38 073 440 12 88", proc: "КТ черевної порожнини з контрастом",    dur: 40, room: "r2", status: "cabinet", call: "confirmed" },
  { id: 8,  time: "11:30", name: "Сидоренко Наталія Володимирівна",age: 52, phone: "+38 098 277 63 19", proc: "МРТ плечового суглоба",                 dur: 30, room: "r1", status: "waiting", call: "confirmed" },
  { id: 9,  time: "12:15", name: "Лисенко Юлія Романівна",         age: 38, phone: "+38 095 612 90 77", proc: "КТ органів грудної клітки",             dur: 20, room: "r2", status: "waiting", call: "callback" },
  { id: 10, time: "12:45", name: "Кравчук Дмитро Олександрович",   age: 45, phone: "+38 067 703 55 12", proc: "МРТ черевної порожнини",                dur: 50, room: "r1", status: "queued", call: "confirmed" },
  { id: 11, time: "13:30", name: "Поліщук Вікторія Тарасівна",     age: 31, phone: "+38 050 909 41 23", proc: "КТ нирок та сечовивідних шляхів",       dur: 25, room: "r2", status: "queued", call: "noanswer" },
  { id: 12, time: "14:10", name: "Савченко Богдан Юрійович",       age: 60, phone: "+38 063 188 74 50", proc: "МРТ головного мозку без контрасту",     dur: 60, room: "r1", status: "queued", call: "confirmed" },
  { id: 13, time: "14:50", name: "Мельник Олена Степанівна",       age: 44, phone: "+38 097 326 80 15", proc: "КТ органів грудної клітки з контрастом",dur: 35, room: "r2", status: "queued", call: "noanswer" },
  { id: 14, time: "15:30", name: "Захарченко Артем Ігорович",      age: 22, phone: "+38 073 654 02 99", proc: "МРТ колінного суглоба",                 dur: 30, room: "r1", status: "queued", call: "pending" },
  { id: 15, time: "09:40", name: "Онищенко Роман Анатолійович",   age: 39, phone: "+38 067 511 23 09", proc: "МРТ головного мозку",                    dur: 30, room: "r3", status: "cabinet", call: "confirmed" },
  { id: 16, time: "11:00", name: "Данилюк Оксана Василівна",        age: 47, phone: "+38 050 712 84 50", proc: "МРТ хребта (шийний відділ)",          dur: 45, room: "r3", status: "waiting", call: "confirmed" },
  { id: 17, time: "10:20", name: "Ковальчук Ігор Миколайович",     age: 33, phone: "+38 097 224 61 77", proc: "МРТ колінного суглоба",                 dur: 30, room: "r4", status: "waiting", call: "confirmed" },
  { id: 18, time: "08:30", name: "Руденко Алла Петрівна",            age: 55, phone: "+38 063 808 19 42", proc: "МРТ плечового суглоба",                 dur: 30, room: "r4", status: "done", call: "confirmed" },
  { id: 19, time: "11:10", name: "Бабенко Сергій Олегович",        age: 61, phone: "+38 066 433 70 18", proc: "КТ органів грудної клітки",             dur: 20, room: "r5", status: "cabinet", call: "confirmed" },
  { id: 20, time: "12:00", name: "Ткач Марина Володимирівна",        age: 28, phone: "+38 073 190 55 23", proc: "КТ голови",                            dur: 15, room: "r5", status: "queued", call: "confirmed" },
  { id: 21, time: "13:15", name: "Мазур Олександр Юрійович",       age: 50, phone: "+38 050 661 02 38", proc: "КТ черевної порожнини",                dur: 40, room: "r6", status: "queued", call: "callback" },
  { id: 22, time: "09:00", name: "Левчук Тетяна Сергіївна",         age: 36, phone: "+38 097 745 30 61", proc: "КТ нирок та сечовивідних шляхів",       dur: 25, room: "r7", status: "done", call: "confirmed" },
  { id: 23, time: "14:30", name: "Сорока Віктор Павлович",          age: 58, phone: "+38 063 559 88 14", proc: "КТ органів грудної клітки",             dur: 20, room: "r6", status: "queued", call: "refused" },
];

/* Вирівнюємо демо-час сидів до сітки 30 хв (старти на :00/:30, без накладок у кабінеті) */
(function () {
  function toMin(t) { var p = String(t).split(":"); return (+p[0]) * 60 + (+p[1] || 0); }
  function fmt(m) { return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); }
  var taken = {};
  window.RF_PATIENTS.slice().sort(function (a, b) { return toMin(a.time) - toMin(b.time); }).forEach(function (p) {
    var m = Math.round(toMin(p.time) / 30) * 30;
    taken[p.room] = taken[p.room] || {};
    while (taken[p.room][m]) m += 30;       // уникаємо збігу старту в межах кабінету
    taken[p.room][m] = true;
    p.time = fmt(m);
  });
})();

window.RF_STATUS_META = {
  queued:   { label: "В черзі",      cls: "gray",   dot: false },
  waiting:  { label: "Очікує",       cls: "yellow", dot: false },
  cabinet:  { label: "В кабінеті",   cls: "blue",   dot: true  },
  done:     { label: "Виконано",     cls: "green",  dot: false },
  noshow:   { label: "Не відбулось", cls: "red",    dot: false },
};

// Кабінети, у сценаріях яких є непрочитані зміни (колл-лист / зміни черги) → червоний кружечок
window.RF_CABINET_ALERTS = ["r1", "r3"];

// Лікарі-направлячі
window.RF_DOCTORS = [
  { id: 1, name: "Іваненко Сергій Петрович", spec: "Невролог", clinic: "Клініка «Здоров'я»", phone: "+38 067 100 22 33", refs: 24 },
  { id: 2, name: "Гончар Наталія Вікторівна", spec: "Ортопед-травматолог", clinic: "МЦ «Ортес»", phone: "+38 050 200 33 44", refs: 18 },
  { id: 3, name: "Бойчук Андрій Іванович", spec: "Онколог", clinic: "Онкоцентр", phone: "+38 063 300 44 55", refs: 31 },
];

/* ===== Ручні записи (Новий запис) — спільне сховище =====
   Раніше новий запис лише додавався в RF_PATIENTS у памʼяті (зникав після
   перезавантаження і не синхронізувався між вкладками/ролями), а запис на
   майбутній день взагалі ніде не зберігався. Тепер усі ручні записи живуть у
   localStorage rf_bookings_v1 і вмерджуються у живу чергу (getQueuePatients,
   сьогодні) та у розклад інших днів (getDayPatients). */
window.RF_BOOKINGS_KEY = "rf_bookings_v1";
window.rfDateKey = function (d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};
window.getBookings = function () {
  try { return JSON.parse(localStorage.getItem(window.RF_BOOKINGS_KEY)) || []; }
  catch (e) { return []; }
};
window.addBookingRecord = function (rec) {
  var a = window.getBookings();
  a.push(rec);
  localStorage.setItem(window.RF_BOOKINGS_KEY, JSON.stringify(a));
  try { window.dispatchEvent(new CustomEvent("rf-booking-sync", { detail: rec })); } catch (e) {}
};
/* Видалити ручний запис (скасування). */
window.removeBookingRecord = function (id) {
  var a = window.getBookings(), n = a.filter(function (b) { return b.id !== id; });
  if (n.length !== a.length) {
    localStorage.setItem(window.RF_BOOKINGS_KEY, JSON.stringify(n));
    try { window.dispatchEvent(new CustomEvent("rf-booking-sync", { detail: { remove: id } })); } catch (e) {}
    return true;
  }
  return false;
};

/* Оновити наявний ручний запис (перенесення на іншу дату/час/кабінет). */
window.updateBookingRecord = function (id, patch) {
  var a = window.getBookings(), found = false;
  a = a.map(function (b) { if (b.id === id) { found = true; return Object.assign({}, b, patch); } return b; });
  if (found) {
    localStorage.setItem(window.RF_BOOKINGS_KEY, JSON.stringify(a));
    try { window.dispatchEvent(new CustomEvent("rf-booking-sync", { detail: { id: id } })); } catch (e) {}
  }
  return found;
};

/* ===== Скасовані/перенесені згенеровані записи =====
   Згенерований/сід-пацієнт не редагується напряму, тож при перенесенні ми
   ховаємо оригінал (за id) і створюємо новий ручний запис на новому слоті. */
window.RF_CANCELLED_KEY = "rf_cancelled_v1";
window.getCancelled = function () {
  try { return JSON.parse(localStorage.getItem(window.RF_CANCELLED_KEY)) || []; }
  catch (e) { return []; }
};
window.suppressPatient = function (id) {
  var a = window.getCancelled();
  if (a.indexOf(id) < 0) {
    a.push(id);
    localStorage.setItem(window.RF_CANCELLED_KEY, JSON.stringify(a));
    try { window.dispatchEvent(new CustomEvent("rf-booking-sync", { detail: { suppress: id } })); } catch (e) {}
  }
};
window.isPatientSuppressed = function (id) { return window.getCancelled().indexOf(id) >= 0; };

/* Ручні записи на конкретну дату (без поля status/call із даними пацієнта черги). */
window.getBookingsForDate = function (dateObj) {
  var key = window.rfDateKey(dateObj);
  return window.getBookings()
    .filter(function (b) { return b.date === key; })
    .map(function (b) {
      return { id: b.id, time: b.time, name: b.name, age: b.age, weight: b.weight, phone: b.phone,
               proc: b.proc, dur: b.dur, room: b.room, status: b.status || "queued", call: b.call || "pending", notes: b.notes, manual: true };
    });
};

/* =====================================================================
   ДОСЛІДЖЕННЯ (тип дослідження) — спільна модель для всіх ролей
   ---------------------------------------------------------------------
   Один запис може містити КІЛЬКА досліджень. Структура дослідження:
     { type: "МРТ"|"КТ", region: "<область>", contrast: bool, dur: <хв>, price: <грн> }
   Сховище rf_studies_v1 (id пацієнта → масив досліджень) — єдине джерело правди;
   комбінована назва й сумарна тривалість/ціна накладаються на запис скрізь, де він
   показується (черга, колл-лист, кабінет радіолога). Редагувати/додавати можна з
   будь-якого місця, де ухвалюється рішення. ===================================== */
window.RF_MRT_REGIONS = [
  { label: "Головний мозок", dur: 60, price: 2400 },
  { label: "Хребет — шийний відділ", dur: 40, price: 2100 },
  { label: "Хребет — грудний відділ", dur: 40, price: 2100 },
  { label: "Хребет — поперековий відділ", dur: 45, price: 2100 },
  { label: "Колінний суглоб", dur: 30, price: 1800 },
  { label: "Плечовий суглоб", dur: 30, price: 1800 },
  { label: "Кульшовий суглоб", dur: 35, price: 1900 },
  { label: "Черевна порожнина", dur: 50, price: 2600 },
  { label: "Малий таз", dur: 45, price: 2600 },
  { label: "Серце та судини", dur: 60, price: 3200 },
  { label: "Молочні залози", dur: 50, price: 2700 },
];
window.RF_CT_REGIONS = [
  { label: "Голова / мозок", dur: 15, price: 1200 },
  { label: "Органи грудної клітки", dur: 20, price: 1500 },
  { label: "Органи черевної порожнини", dur: 25, price: 1700 },
  { label: "Малий таз", dur: 20, price: 1500 },
  { label: "Хребет", dur: 20, price: 1400 },
  { label: "Кінцівки", dur: 15, price: 1200 },
  { label: "КТ-ангіографія", dur: 30, price: 2400 },
  { label: "Мультизональне дослідження", dur: 40, price: 2800 },
];
window.RF_CONTRAST_SURCHARGE = 900;   // доплата за контраст, грн
window.RF_CONTRAST_DUR = 15;          // +хв за контраст
window.rfRegionsFor = function (type) { return type === "КТ" ? window.RF_CT_REGIONS : window.RF_MRT_REGIONS; };
/* Тип дослідження з тексту процедури (КТ… → КТ, інакше МРТ). */
window.rfStudyKind = function (proc) { return String(proc || "").trim().toUpperCase().indexOf("КТ") === 0 ? "КТ" : "МРТ"; };
/* Назва одного дослідження для показу. */
window.rfStudyLabel = function (s) {
  return (s.type || "МРТ") + " · " + (s.region || "") + (s.contrast ? " з контрастом" : "");
};
window.rfFmtUah = function (n) { return String(n || 0).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₴"; };

window.RF_STUDIES_KEY = "rf_studies_v1";
window.getAllStudies = function () {
  try { return JSON.parse(localStorage.getItem(window.RF_STUDIES_KEY)) || {}; }
  catch (e) { return {}; }
};
/* Масив досліджень запису або null, якщо не редагували вручну. */
window.getStudies = function (id) {
  var m = window.getAllStudies();
  return (m[id] && m[id].length) ? m[id] : null;
};
window.saveStudies = function (id, arr) {
  var m = window.getAllStudies();
  if (arr && arr.length) m[id] = arr; else delete m[id];
  localStorage.setItem(window.RF_STUDIES_KEY, JSON.stringify(m));
  // оновлюємо живий запис (rf_bookings_v1) для ручних записів — назва/тривалість
  var c = window.rfStudiesCombined(arr);
  if (window.updateBookingRecord && window.getBookings && window.getBookings().some(function (b) { return b.id === id; })) {
    window.updateBookingRecord(id, { proc: c.label, dur: c.dur });
  }
  // синхронізація для всіх відкритих ролей/вкладок
  try { window.dispatchEvent(new CustomEvent("rf-study-sync", { detail: { id: id } })); } catch (e) {}
  try { window.dispatchEvent(new CustomEvent("rf-booking-sync", { detail: { id: id } })); } catch (e) {}
};
/* Сумарна назва (через « + »), тривалість і ціна по набору досліджень. */
window.rfStudiesCombined = function (arr) {
  if (!arr || !arr.length) return { label: "", dur: 0, price: 0 };
  return {
    label: arr.map(window.rfStudyLabel).join(" + "),
    dur: arr.reduce(function (s, x) { return s + (parseInt(x.dur, 10) || 0); }, 0),
    price: arr.reduce(function (s, x) { return s + (parseInt(x.price, 10) || 0); }, 0),
  };
};
/* Дослідження запису для редагування: збережений набір або похідний єдиний
   елемент із поточної процедури (щоб завжди було що показати/доповнити). */
window.rfStudiesForPatient = function (p) {
  var saved = window.getStudies(p.id);
  if (saved) return saved.map(function (s) { return Object.assign({}, s); });
  var kind = window.rfStudyKind(p.proc);
  return [{ type: kind, region: p.proc || "", contrast: /контраст/i.test(p.proc || ""), dur: p.dur || (kind === "КТ" ? 20 : 45), price: 0, raw: true }];
};
/* Накласти збережені дослідження на запис (назва + сумарна тривалість). */
window.rfApplyStudies = function (p) {
  var arr = window.getStudies(p.id);
  if (arr && arr.length) {
    var c = window.rfStudiesCombined(arr);
    return Object.assign({}, p, { proc: c.label, dur: c.dur, studies: arr, studyPrice: c.price });
  }
  return p;
};

/* =====================================================================
   РЕЖИМ РОБОТИ ОБЛАДНАННЯ ЗА ДАТОЮ (свята, держ. вихідні, дод. вихідні)
   ---------------------------------------------------------------------
   Адміністратор з головної дошки черги (у календарі) може вручну
   перевизначити графік на конкретну дату:
     • вся клініка — неробочий день (з підписом-причиною);
     • окремий кабінет/апарат — зачинено або інші години роботи.
   Зберігається у localStorage rf_sched_override_v1:
     { "<dateKey>": { allClosed?, label?, rooms?: { <rk>: {closed?|start,end} } } }
   Типовий графік: Пн–Сб 08:00–18:00, неділя — вихідний.
   Зміни синхронізуються між ролями/вкладками (rf-sched-sync + storage).
   ===================================================================== */
window.RF_DEFAULT_HOURS = { start: "08:00", end: "18:00" };
window.RF_SCHED_KEY = "rf_sched_override_v1";

window.getScheduleOverrides = function () {
  try { return JSON.parse(localStorage.getItem(window.RF_SCHED_KEY)) || {}; }
  catch (e) { return {}; }
};
window.getDayOverride = function (dateObj) {
  return window.getScheduleOverrides()[window.rfDateKey(dateObj)] || null;
};
window.setDayOverride = function (dateObj, ov) {
  var all = window.getScheduleOverrides();
  var key = window.rfDateKey(dateObj);
  var empty = !ov || (!ov.allClosed && (!ov.rooms || Object.keys(ov.rooms).length === 0));
  if (empty) delete all[key]; else all[key] = ov;
  localStorage.setItem(window.RF_SCHED_KEY, JSON.stringify(all));
  try { window.dispatchEvent(new CustomEvent("rf-sched-sync", { detail: { date: key } })); } catch (e) {}
};
window.clearDayOverride = function (dateObj) { window.setDayOverride(dateObj, null); };

/* Типово неробочий день? (неділя) */
window.rfDefaultClosed = function (dateObj) { return dateObj.getDay() === 0; };

/* Чи вся клініка неробоча в цей день (ручний вихідний). */
window.rfDayClosed = function (dateObj) {
  var ov = window.getDayOverride(dateObj);
  return !!(ov && ov.allClosed);
};

/* Ефективний графік кабінету на дату: { closed, start, end, custom }. */
window.rfRoomScheduleForDate = function (dateObj, roomKey) {
  var def = window.RF_DEFAULT_HOURS;
  var ov = window.getDayOverride(dateObj);
  if (ov && ov.allClosed) return { closed: true, start: def.start, end: def.end, custom: true };
  var roomOv = ov && ov.rooms ? ov.rooms[roomKey] : null;
  if (roomOv) {
    if (roomOv.closed) return { closed: true, start: def.start, end: def.end, custom: true };
    return { closed: false, start: roomOv.start || def.start, end: roomOv.end || def.end, custom: true };
  }
  if (window.rfDefaultClosed(dateObj)) return { closed: true, start: def.start, end: def.end, custom: false };
  return { closed: false, start: def.start, end: def.end, custom: false };
};

/* Чи відкритий кабінет о вказаній годині "HH:MM" (фільтр згенерованої черги). */
window.rfRoomOpenAt = function (dateObj, roomKey, hhmm) {
  var s = window.rfRoomScheduleForDate(dateObj, roomKey);
  if (s.closed) return false;
  return hhmm >= s.start && hhmm < s.end;
};

/* Перелік кабінетів, у яких графік на дату відрізняється від типового
   (через ручний оверайд): [{ roomKey, name, kind, model, closed, start, end }].
   Показуємо адміну, щоб було видно саме які апарати зачинені / з іншими годинами. */
window.rfDayCustomRooms = function (dateObj) {
  var ov = window.getDayOverride(dateObj);
  if (!ov) return [];
  var rooms = window.RF_ROOMS || {};
  var out = [];
  Object.keys(rooms).forEach(function (k) {
    var r = rooms[k];
    if (ov.allClosed) { out.push({ roomKey: k, name: r.name, kind: r.kind, model: r.model, closed: true }); return; }
    var ro = ov.rooms ? ov.rooms[k] : null;
    if (!ro) return; // цей кабінет працює як зазвичай
    if (ro.closed) { out.push({ roomKey: k, name: r.name, kind: r.kind, model: r.model, closed: true }); return; }
    var s = window.rfRoomScheduleForDate(dateObj, k);
    out.push({ roomKey: k, name: r.name, kind: r.kind, model: r.model, closed: false, start: s.start, end: s.end });
  });
  return out;
};

/* Статус дня для календаря: { kind: "closed"|"custom"|"none", label }. */
window.rfDayOverrideStatus = function (dateObj) {
  var ov = window.getDayOverride(dateObj);
  if (!ov) return { kind: "none", label: "" };
  if (ov.allClosed) return { kind: "closed", label: ov.label || "Неробочий день" };
  if (ov.rooms && Object.keys(ov.rooms).length) {
    var rk = Object.keys(window.RF_ROOMS || {});
    var allShut = rk.length > 0 && rk.every(function (k) { var r = ov.rooms[k]; return r && r.closed; });
    return { kind: allShut ? "closed" : "custom", label: ov.label || (allShut ? "Неробочий день" : "Особливий графік") };
  }
  return { kind: "none", label: "" };
};

/* =====================================================================
   ПЕРЕНЕСЕННЯ ЗАПИСІВ ПІСЛЯ ЗМІНИ ГРАФІКА
   ---------------------------------------------------------------------
   Коли адміністратор закриває день/кабінет або скорочує години, уже
   заплановані записи не зникають мовчки — вони потрапляють у колл-лист на
   перенесення (rf_resched_v1, ключ — дата). Реєстратор обдзвонює пацієнтів і
   переносить кожного на новий слот (як у сценарії поломки апарата).
   callStatus: pending | callback | rescheduled | refused (RF_INC_STATUS).
   ===================================================================== */
window.RF_RESCHED_KEY = "rf_resched_v1";
window.getAllReschedule = function () {
  try { return JSON.parse(localStorage.getItem(window.RF_RESCHED_KEY)) || {}; }
  catch (e) { return {}; }
};
window.getReschedule = function (dateObj) {
  return window.getAllReschedule()[window.rfDateKey(dateObj)] || null;
};
window._rfSaveReschedule = function (all) {
  localStorage.setItem(window.RF_RESCHED_KEY, JSON.stringify(all || {}));
  try { window.dispatchEvent(new CustomEvent("rf-resched-sync", {})); } catch (e) {}
};
window.setReschedule = function (dateObj, entry) {
  var all = window.getAllReschedule();
  var key = window.rfDateKey(dateObj);
  if (!entry || !entry.patients || entry.patients.length === 0) delete all[key];
  else all[key] = entry;
  window._rfSaveReschedule(all);
};
window.clearReschedule = function (dateObj) {
  var all = window.getAllReschedule();
  delete all[window.rfDateKey(dateObj)];
  window._rfSaveReschedule(all);
};
window.setRescheduleStatus = function (dateObj, id, status) {
  var all = window.getAllReschedule();
  var key = window.rfDateKey(dateObj);
  var e = all[key];
  if (!e) return;
  e.patients = e.patients.map(function (p) { return p.id === id ? Object.assign({}, p, { callStatus: status }) : p; });
  window._rfSaveReschedule(all);
};
/* Скільки ще потребують обдзвону (не «перенесено» і не «відмова»). */
window.rfReschedPending = function (entry) {
  if (!entry || !entry.patients) return 0;
  return entry.patients.filter(function (p) { return p.callStatus !== "rescheduled" && p.callStatus !== "refused"; }).length;
};
/* Сумарно по всіх датах. */
window.rfReschedTotalPending = function () {
  var all = window.getAllReschedule(), n = 0;
  Object.keys(all).forEach(function (k) { n += window.rfReschedPending(all[k]); });
  return n;
};

/* Записи, яких торкається закриття/скорочення графіка на дату під оверайд `ov`
   (зачинені кабінети або слоти поза новими годинами). Беремо первісний розклад
   (ignoreSchedule), виключаємо вже виконані/неявки. */
window.rfAffectedByClosure = function (dateObj, ov) {
  var raw = window.getDayPatients ? window.getDayPatients(dateObj, { ignoreSchedule: true }) : [];
  return raw.filter(function (p) {
    if (p.status === "done" || p.status === "noshow") return false;
    if (ov && ov.allClosed) return true;
    var ro = ov && ov.rooms ? ov.rooms[p.room] : null;
    if (!ro) return false;
    if (ro.closed) return true;
    var st = ro.start || "08:00", en = ro.end || "18:00";
    return p.time < st || p.time >= en; // поза новими годинами роботи
  }).map(function (p) {
    return { id: p.id, time: p.time, name: p.name, phone: p.phone, proc: p.proc, dur: p.dur, age: p.age, room: p.room, callStatus: "pending" };
  });
};
