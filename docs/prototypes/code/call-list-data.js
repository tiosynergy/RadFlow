/* ===== RadFlow — Call List data (записи на завтра) ===== */
// status: 'pending' | 'confirmed' | 'noanswer' | 'callback' | 'refused'
// дата «завтра» обчислюється від реального системного годинника (queue-data.js завантажується першим)
window.CL_TOMORROW = (window.rfFmtFull && window.rfAddDays && window.rfToday)
  ? ("Записи на завтра · " + window.rfFmtFull(window.rfAddDays(window.rfToday(), 1)))
  : "Записи на завтра";

window.CL_STATUS = {
  pending:   { label: "Ще не дзвонили", cls: "gray",   icon: "○" },
  confirmed: { label: "Підтверджено",   cls: "green",  icon: "✓" },
  noanswer:  { label: "Не відповідає",  cls: "orange", icon: "✗" },
  callback:  { label: "Передзвонити",   cls: "blue",   icon: "↩" },
  refused:   { label: "Відмова",        cls: "red",    icon: "✕" },
};

window.CL_PATIENTS = [
  { id: 1,  time: "08:00", name: "Коваль Тетяна Миколаївна",      age: 47, phone: "+38 067 412 33 90", proc: "МРТ головного мозку",          room: "Кабінет №1", status: "confirmed", note: "Прийде з направленням" },
  { id: 2,  time: "08:40", name: "Романюк Ігор Васильович",       age: 61, phone: "+38 050 778 21 04", proc: "КТ грудної клітки",            room: "Кабінет №2", status: "confirmed", note: "" },
  { id: 3,  time: "09:20", name: "Левченко Оксана Петрівна",      age: 38, phone: "+38 063 200 55 17", proc: "МРТ хребта",                   room: "Кабінет №1", status: "noanswer",  note: "Двічі не відповіла" },
  { id: 4,  time: "10:00", name: "Дорошенко Павло Андрійович",    age: 54, phone: "+38 097 631 88 42", proc: "КТ черевної порожнини",        room: "Кабінет №2", status: "callback",  note: "Передзвонити після 14:00" },
  { id: 5,  time: "10:45", name: "Гриценко Алла Сергіївна",       age: 29, phone: "+38 066 145 90 23", proc: "МРТ колінного суглоба",        room: "Кабінет №1", status: "pending",   note: "" },
  { id: 6,  time: "11:30", name: "Бойко Максим Олегович",         age: 33, phone: "+38 073 902 14 66", proc: "КТ голови",                    room: "Кабінет №2", status: "confirmed", note: "" },
  { id: 7,  time: "12:10", name: "Марченко Світлана Ігорівна",    age: 45, phone: "+38 095 327 70 11", proc: "МРТ плечового суглоба",        room: "Кабінет №1", status: "noanswer",  note: "" },
  { id: 8,  time: "13:00", name: "Ткачук Володимир Петрович",     age: 58, phone: "+38 050 419 02 88", proc: "КТ нирок",                     room: "Кабінет №2", status: "pending",   note: "" },
  { id: 9,  time: "13:50", name: "Савчук Ірина Олександрівна",    age: 41, phone: "+38 067 853 41 29", proc: "МРТ органів малого таза",      room: "Кабінет №1", status: "callback",  note: "Уточнити контраст" },
  { id: 10, time: "14:30", name: "Кравець Андрій Миколайович",    age: 50, phone: "+38 063 712 60 05", proc: "КТ грудної клітки з контр.",   room: "Кабінет №2", status: "confirmed", note: "" },
  { id: 11, time: "15:15", name: "Поліщук Наталія Вікторівна",    age: 36, phone: "+38 097 248 33 71", proc: "МРТ головного мозку з контр.", room: "Кабінет №1", status: "noanswer",  note: "" },
  { id: 12, time: "16:00", name: "Лебідь Дмитро Сергійович",      age: 63, phone: "+38 066 590 17 84", proc: "КТ хребта",                    room: "Кабінет №2", status: "pending",   note: "" },
];

/* ===== Спільне сховище статусів дзвінка — ЄДИНЕ ДЖЕРЕЛО ПРАВДИ =====
   Один store для всіх ролей: колл-лист (обдзвін завтрашніх пацієнтів),
   запланована черга, дошка адміністратора та кабінет радіолога читають
   статус звідси. Зміна на будь-якій сторінці миттєво синхронізується:
     • між вкладками/вікнами — через подію 'storage';
     • у межах однієї вкладки — через подію 'rf-call-sync'. */
window.CL_STORAGE_KEY = "rf_calllist_status_v1";
window.getCallStatuses = function () {
  try { return JSON.parse(localStorage.getItem(window.CL_STORAGE_KEY)) || {}; }
  catch (e) { return {}; }
};
window.saveCallStatus = function (id, status) {
  const m = window.getCallStatuses();
  m[id] = status;
  localStorage.setItem(window.CL_STORAGE_KEY, JSON.stringify(m));
  // синхронізація в реальному часі в межах поточної вкладки (storage спрацьовує лише між вкладками)
  try { window.dispatchEvent(new CustomEvent("rf-call-sync", { detail: { id: id, status: status } })); } catch (e) {}
};
/* Колл-лист на ЗАВТРА = та сама змодельована черга на завтра (schedule.js).
   Єдине джерело пацієнтів і статусів → колл-лист і черга на завтра повністю
   синхронізовані з одного сховища (rf_calllist_status_v1) за id пацієнта. */
window.getCallList = function () {
  const stored = window.getCallStatuses();
  let base;
  if (window.getDayPatients && window.rfAddDays && window.rfToday) {
    const tomorrow = window.rfAddDays(window.rfToday(), 1);
    base = window.getDayPatients(tomorrow)
      .filter((p) => p.status !== "noshow")   // скасовані/неявки не обдзвонюємо
      .map((p) => ({
      id: p.id,
      time: p.time,
      name: p.name,
      age: p.age,
      phone: p.phone,
      proc: p.proc,
      room: (window.RF_ROOMS && window.RF_ROOMS[p.room]) ? window.RF_ROOMS[p.room].name : p.room,
      status: p.call,   // базовий статус дзвінка з моделювання (до дій оператора)
      note: "",
    }));
  } else {
    base = window.CL_PATIENTS.map((p) => ({ ...p })); // запасний варіант, якщо schedule.js не підключено
  }
  return base.map((p) => ({ ...p, status: stored[p.id] || p.status }));
};
/* Статус дзвінка для будь-якого пацієнта черги: спочатку зі спільного сховища,
   інакше — базове значення (поле p.call у запису черги). */
window.getCallStatusFor = function (id, fallback) {
  const stored = window.getCallStatuses();
  return stored[id] || fallback || "pending";
};
window.clStudyType = function (proc) { return proc.trim().toUpperCase().indexOf("КТ") === 0 ? "КТ" : "МРТ"; };

/* =====================================================================
   ІНЦИДЕНТ (Поломка / ТО) → автоматичний колл-лист (обдзвін на перезапис)
   ---------------------------------------------------------------------
   Виправляє дві проблеми юзабіліті-тесту:
     • Проблема 1 — реєстрація поломки автоматично формує Call List із
       пацієнтів затронутого вікна простою + лічильник «N потребують обдзвону».
     • Проблема 2 — поломка фіксується через діалог (апарат + причина +
       тривалість), а не одним «німим» кліком.
   Активний інцидент зберігається у спільному сховищі та синхронізується
   між ролями подіями 'storage' (між вкладками) і 'rf-incident-sync' (у межах
   вкладки) — як решта Realtime-даних RadFlow.
   ===================================================================== */
window.RF_INC_KEY = "rf_incident_v1";

/* "08:40" → 520 хвилин */
window.rfTimeToMin = function (t) {
  var p = String(t || "").split(":");
  return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
};
window.rfMinToTime = function (m) {
  m = Math.max(0, Math.min(24 * 60 - 1, Math.round(m)));
  var h = Math.floor(m / 60), mm = m % 60;
  return String(h).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
};

/* Постраждалі записи: пацієнти обраного апарата у вікні простою [fromMin, toMin),
   які ще не оброблені (виключаємо «Виконано» та «Не відбулось»). */
window.rfAffected = function (patients, roomKey, fromMin, toMin) {
  return (patients || [])
    .filter(function (p) {
      if (p.room !== roomKey) return false;
      if (p.status === "done" || p.status === "noshow") return false;
      var m = window.rfTimeToMin(p.time);
      return m >= fromMin && m < toMin;
    })
    .sort(function (a, b) { return String(a.time).localeCompare(String(b.time)); });
};

/* Статуси обдзвону постраждалого пацієнта (відрізняються від звичайного колл-листа) */
window.RF_INC_STATUS = {
  pending:     { label: "Потребує обдзвону", cls: "orange", icon: "☎" },
  callback:    { label: "Передзвонити",      cls: "blue",   icon: "↩" },
  rescheduled: { label: "Перезаписано",      cls: "green",  icon: "✓" },
  refused:     { label: "Відмова",           cls: "red",    icon: "✕" },
};
/* Скільки ще треба обдзвонити = не «перезаписано» і не «відмова» */
window.rfIncPending = function (inc) {
  if (!inc || !inc.patients) return 0;
  return inc.patients.filter(function (p) {
    return p.callStatus !== "rescheduled" && p.callStatus !== "refused";
  }).length;
};

/* ===== Кілька одночасних інцидентів =====
   Сховище rf_incident_v1 тримає МАСИВ інцидентів (по одному на заблокований
   кабінет). Передбачено міграцію зі старого single-формату. */
window.getIncidents = function () {
  try {
    var v = JSON.parse(localStorage.getItem(window.RF_INC_KEY));
    if (!v) return [];
    return Array.isArray(v) ? v : [v]; // міграція: одиночний інцидент → масив
  } catch (e) { return []; }
};
window._rfSaveIncidents = function (arr) {
  localStorage.setItem(window.RF_INC_KEY, JSON.stringify(arr || []));
  try { window.dispatchEvent(new CustomEvent("rf-incident-sync", { detail: arr })); } catch (e) {}
};
window.getIncidentForRoom = function (roomKey) {
  return window.getIncidents().filter(function (i) { return i.roomKey === roomKey; })[0] || null;
};
/* Додати або оновити інцидент кабінету (за roomKey). */
window.upsertIncident = function (inc) {
  var arr = window.getIncidents().filter(function (i) { return i.roomKey !== inc.roomKey; });
  arr.push(inc);
  window._rfSaveIncidents(arr);
};
/* Зняти блокування конкретного кабінету. */
window.removeIncident = function (roomKey) {
  window._rfSaveIncidents(window.getIncidents().filter(function (i) { return i.roomKey !== roomKey; }));
};
window.clearAllIncidents = function () { window._rfSaveIncidents([]); };
/* Сумарно пацієнтів на обдзвін по всіх інцидентах. */
window.rfIncidentsTotalPending = function () {
  return window.getIncidents().reduce(function (s, i) { return s + window.rfIncPending(i); }, 0);
};

/* Зворотна сумісність: одиночні гетери повертають перший інцидент. */
window.getIncident = function () { return window.getIncidents()[0] || null; };
window.saveIncident = function (inc) { window.upsertIncident(inc); };
window.clearIncident = function (roomKey) { if (roomKey) window.removeIncident(roomKey); else window.clearAllIncidents(); };
/* Вікно простою за обраною тривалістю.
   ВАЖЛИВО: «До кінця дня» і «До відновлення» — відкриті: вони охоплюють УСІХ
   незавершених пацієнтів апарата на день (affectedFrom = 0), незалежно від часу
   початку. Інакше, якщо інцидент реєструють під кінець дня, вікно вироджувалося
   ([17:30, 17:30)) і колл-лист виходив порожнім. */
window.RF_DAY_END_MIN = 17 * 60 + 30;
window.rfIncidentWindow = function (durKey, fromMin) {
  var END = window.RF_DAY_END_MIN;
  if (durKey === "eod" || durKey === "restore") {
    return { openEnded: true, affectedFrom: 0, toMin: END,
             durationLabel: durKey === "eod" ? "До кінця дня" : "До відновлення" };
  }
  var FIX = { "1h": 60, "2h": 120, "4h": 240 };
  var LBL = { "1h": "1 година", "2h": "2 години", "4h": "4 години" };
  var mins = FIX[durKey] || 0;
  return { openEnded: false, affectedFrom: fromMin, toMin: Math.min(END, fromMin + mins),
           durationLabel: LBL[durKey] || "" };
};

/* Постраждалі пацієнти інциденту:
     • СЬОГОДНІ — усі незавершені записи апарата у вікні простою
       (для відкритого простою — від початку дня);
     • НАПЕРЕД (лише «До відновлення») — усі майбутні записи апарата по днях
       аж до дати відновлення включно (детермінований розклад getDayPatients).
   Кожен запис отримує dayLabel/isToday для відображення в колл-листі. */
window.rfIncidentAffected = function (roomKey, fromMin, durKey, restoreDateStr) {
  var END = window.RF_DAY_END_MIN, out = [];
  function add(list, dayLabel, dayOffset, lo, hi) {
    (list || []).forEach(function (p) {
      if (p.room !== roomKey) return;
      if (p.status === "done" || p.status === "noshow") return;
      var m = window.rfTimeToMin(p.time);
      if (m < lo || m >= hi) return;
      out.push({ id: p.id, time: p.time, name: p.name, phone: p.phone, proc: p.proc, age: p.age,
                 dayLabel: dayLabel, isToday: dayOffset === 0, _sort: dayOffset * 2000 + m, callStatus: "pending" });
    });
  }
  var openEnded = (durKey === "eod" || durKey === "restore");
  var todayList = window.getQueuePatients ? window.getQueuePatients() : (window.RF_PATIENTS || []);
  if (openEnded) add(todayList, "сьогодні", 0, 0, END + 1);
  else {
    var FIX = { "1h": 60, "2h": 120, "4h": 240 };
    add(todayList, "сьогодні", 0, fromMin, Math.min(END, fromMin + (FIX[durKey] || 0)));
  }
  if (durKey === "restore" && restoreDateStr && window.getDayPatients && window.rfAddDays && window.rfToday) {
    var MG = window.RF_MONTHS_GEN || [];
    var rd = new Date(restoreDateStr + "T00:00:00"); rd.setHours(0, 0, 0, 0);
    var d = window.rfAddDays(window.rfToday(), 1), off = 1, guard = 0;
    while (d <= rd && guard < 120) {
      add(window.getDayPatients(d), d.getDate() + " " + (MG[d.getMonth()] || ""), off, 0, END + 1);
      d = window.rfAddDays(d, 1); off++; guard++;
    }
  }
  out.sort(function (a, b) { return a._sort - b._sort; });
  out.forEach(function (p) { delete p._sort; });
  return out;
};

/* Єдиний конструктор інциденту — спільний для дошки й сторінки інцидентів. */
window.rfBuildIncident = function (roomKey, reason, reasonLabel, fromMin, durKey, restoreDateStr) {
  var END = window.RF_DAY_END_MIN;
  var room = (window.RF_ROOMS || {})[roomKey] || {};
  var openEnded = (durKey === "eod" || durKey === "restore");
  var FIX = { "1h": 60, "2h": 120, "4h": 240 };
  var DLBL = { "1h": "1 година", "2h": "2 години", "4h": "4 години", "eod": "До кінця дня", "restore": "До відновлення" };
  var toMin = openEnded ? END : Math.min(END, fromMin + (FIX[durKey] || 0));
  var patients = window.rfIncidentAffected(roomKey, fromMin, durKey, restoreDateStr);
  var MG = window.RF_MONTHS_GEN || [];
  var restoreLabel = "";
  if (durKey === "restore" && restoreDateStr) {
    var rd = new Date(restoreDateStr + "T00:00:00");
    restoreLabel = rd.getDate() + " " + (MG[rd.getMonth()] || "");
  }
  var firstToday = patients.filter(function (p) { return p.isToday; })[0];
  var dispFromMin = openEnded ? (firstToday ? window.rfTimeToMin(firstToday.time) : fromMin) : fromMin;
  var fromLabel = window.rfMinToTime(dispFromMin), toLabel = window.rfMinToTime(toMin);
  var windowLabel;
  if (durKey === "restore") windowLabel = "до відновлення" + (restoreLabel ? " — орієнт. " + restoreLabel : "");
  else if (durKey === "eod") windowLabel = "сьогодні до " + toLabel + " (До кінця дня)";
  else windowLabel = fromLabel + "–" + toLabel + " (" + (DLBL[durKey] || "") + ")";
  return {
    roomKey: roomKey, machineName: room.name, model: room.model, kind: room.kind,
    reason: reason, reasonLabel: reasonLabel,
    durKey: durKey, durationLabel: DLBL[durKey] || "", restoreDate: restoreDateStr || null, restoreLabel: restoreLabel,
    openEnded: openEnded, fromMin: dispFromMin, toMin: toMin, fromLabel: fromLabel, toLabel: toLabel,
    windowLabel: windowLabel, createdAt: Date.now(), patients: patients,
  };
};

/* При редагуванні інциденту зберігаємо вже зафіксовані статуси обдзвону
   для пацієнтів, що лишилися у списку (за id). */
window.rfMergeIncidentStatuses = function (built, prev) {
  if (!prev || !prev.patients) return built;
  var map = {};
  prev.patients.forEach(function (p) { map[p.id] = p.callStatus; });
  built.patients = built.patients.map(function (p) {
    return (map[p.id] && map[p.id] !== "pending") ? Object.assign({}, p, { callStatus: map[p.id] }) : p;
  });
  return built;
};

/* Оновити статус обдзвону пацієнта — шукаємо по всіх активних інцидентах
   (id пацієнтів унікальні між кабінетами/днями). */
window.setIncidentCallStatus = function (patientId, status) {
  var arr = window.getIncidents();
  var changed = false;
  arr.forEach(function (inc) {
    inc.patients = inc.patients.map(function (p) {
      if (p.id === patientId) { changed = true; return Object.assign({}, p, { callStatus: status }); }
      return p;
    });
  });
  if (changed) window._rfSaveIncidents(arr);
};
