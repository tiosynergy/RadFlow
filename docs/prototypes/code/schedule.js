/* =====================================================================
   RadFlow — Моделювання черг за реальними датами (Schedule)
   ---------------------------------------------------------------------
   getDayPatients(date) повертає РЕАЛІСТИЧНУ чергу на будь-який день:
     • Неділя — клініка не працює (порожньо).
     • Субота — скорочений графік.
     • Будній день — повний графік.
   Генерація ДЕТЕРМІНОВАНА (seeded by date): той самий день завжди дає
   той самий розклад, але різні дні — різні черги (інші пацієнти/час).
     • Минулі дні  → дослідження виконані (зрідка «не відбулось»).
     • Майбутні    → заплановані (В черзі), статуси дзвінків — мікс.
   «Сьогодні» цей генератор НЕ обслуговує: жива черга береться з
   getQueuePatients() (RF_PATIENTS + симуляція в реальному часі).

   Залежності: queue-data.js (RF_ROOMS, rf-хелпери дат).
   ===================================================================== */
(function () {
  "use strict";
  if (typeof window === "undefined") return;

  /* детермінований PRNG */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function daySeed(d) { return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

  var NAMES_F = [
    "Коваленко Марія Олегівна", "Ткаченко Ірина Василівна", "Шевченко Людмила Іванівна",
    "Гнатюк Софія Андріївна", "Сидоренко Наталія Володимирівна", "Лисенко Юлія Романівна",
    "Поліщук Вікторія Тарасівна", "Мельник Олена Степанівна", "Данилюк Оксана Василівна",
    "Руденко Алла Петрівна", "Ткач Марина Володимирівна", "Левчук Тетяна Сергіївна",
    "Кравець Наталія Іванівна", "Бойко Світлана Миколаївна", "Гриценко Алла Сергіївна",
    "Савчук Ірина Олександрівна", "Марченко Світлана Ігорівна", "Романюк Ольга Петрівна"
  ];
  var NAMES_M = [
    "Бондаренко Олег Петрович", "Мороз Андрій Сергійович", "Петренко Василь Іванович",
    "Кравчук Дмитро Олександрович", "Савченко Богдан Юрійович", "Захарченко Артем Ігорович",
    "Онищенко Роман Анатолійович", "Ковальчук Ігор Миколайович", "Бабенко Сергій Олегович",
    "Мазур Олександр Юрійович", "Сорока Віктор Павлович", "Дорошенко Павло Андрійович",
    "Ткачук Володимир Петрович", "Лебідь Дмитро Сергійович", "Романюк Ігор Васильович",
    "Кравець Андрій Миколайович", "Бойчук Максим Олегович", "Гончар Сергій Вікторович"
  ];

  var PROCS = [
    { proc: "МРТ головного мозку без контрасту", kind: "МРТ", dur: 60 },
    { proc: "МРТ головного мозку з контрастом", kind: "МРТ", dur: 75 },
    { proc: "МРТ хребта (поперековий відділ)", kind: "МРТ", dur: 45 },
    { proc: "МРТ хребта (шийний відділ)", kind: "МРТ", dur: 45 },
    { proc: "МРТ колінного суглоба", kind: "МРТ", dur: 30 },
    { proc: "МРТ плечового суглоба", kind: "МРТ", dur: 30 },
    { proc: "МРТ черевної порожнини", kind: "МРТ", dur: 50 },
    { proc: "КТ органів грудної клітки", kind: "КТ", dur: 20 },
    { proc: "КТ органів грудної клітки з контрастом", kind: "КТ", dur: 35 },
    { proc: "КТ голови", kind: "КТ", dur: 15 },
    { proc: "КТ черевної порожнини", kind: "КТ", dur: 40 },
    { proc: "КТ нирок та сечовивідних шляхів", kind: "КТ", dur: 25 }
  ];

  function roomsByKind(kind) {
    var rooms = window.RF_ROOMS || {};
    return Object.keys(rooms).filter(function (k) { return rooms[k].kind === kind; });
  }
  function fmtTime(min) {
    var h = Math.floor(min / 60), m = min % 60;
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  }
  function phone(rng) {
    var codes = ["067", "050", "063", "097", "066", "073", "095", "098"];
    var c = pick(rng, codes);
    function d(n) { var s = ""; for (var i = 0; i < n; i++) s += Math.floor(rng() * 10); return s; }
    return "+38 " + c + " " + d(3) + " " + d(2) + " " + d(2);
  }

  /* Кількість записів на день */
  function dayCount(d, rng) {
    var dow = d.getDay();
    if (dow === 0) return 0;          // неділя — вихідний
    if (dow === 6) return 6 + Math.floor(rng() * 4); // субота: 6–9
    return 13 + Math.floor(rng() * 8);               // будній: 13–20
  }

  /* Головна функція: черга на конкретну дату (детермінована) */
  window.getDayPatients = function (date, opts) {
    // ignoreSchedule=true → повертаємо первісно заплановані записи БЕЗ урахування
    // ручного графіка (потрібно, щоб зібрати пацієнтів, яких зачіпає закриття дня/кабінету).
    var ignoreSchedule = opts && opts.ignoreSchedule;
    var d = new Date(date); d.setHours(0, 0, 0, 0);
    if (!window.RF_ROOMS) return [];
    // ручний неробочий день (свято / держ. вихідний) — черги немає
    if (!ignoreSchedule && window.rfDayClosed && window.rfDayClosed(d)) return [];
    var rng = mulberry32(daySeed(d));
    var n = dayCount(d, rng);
    if (n === 0) return [];

    var today = window.rfToday ? window.rfToday() : new Date();
    var isPast = d < today;

    var startMin = 8 * 60, endMin = 17 * 60 + 30;
    var step = Math.max(15, Math.floor((endMin - startMin) / n));
    var list = [];
    for (var i = 0; i < n; i++) {
      var pr = pick(rng, PROCS);
      var roomOpts = roomsByKind(pr.kind);
      var room = roomOpts.length ? roomOpts[Math.floor(rng() * roomOpts.length)] : Object.keys(window.RF_ROOMS)[0];
      var female = rng() < 0.5;
      var name = pick(rng, female ? NAMES_F : NAMES_M);
      var t = startMin + i * step;
      t = Math.round(t / 30) * 30;            // вирівнювання старту до сітки 30 хв (без «некруглих» 10:58)
      if (t > endMin) t = Math.floor(endMin / 30) * 30; // не пізніше 17:30

      var status, call;
      if (isPast) {
        status = rng() < 0.12 ? "noshow" : "done";
        call = status === "noshow" ? (rng() < 0.5 ? "noanswer" : "refused") : "confirmed";
      } else {
        status = "queued";
        var r = rng();
        call = r < 0.55 ? "confirmed" : r < 0.72 ? "pending" : r < 0.86 ? "callback" : "noanswer";
      }

      list.push({
        id: daySeed(d) * 1000 + i,             // унікальний id поза діапазоном «сьогодні»/колл-листа
        time: fmtTime(t),
        name: name,
        age: 22 + Math.floor(rng() * 48),
        weight: 55 + Math.floor(rng() * 40),
        phone: phone(rng),
        proc: pr.proc,
        dur: pr.dur,
        room: room,
        status: status,
        call: call
      });
    }
    // вмерджуємо ручні записи (Новий запис) на цю дату — rf_bookings_v1
    if (window.getBookingsForDate) {
      var manual = window.getBookingsForDate(d);
      for (var j = 0; j < manual.length; j++) list.push(manual[j]);
    }
    // накладаємо статуси зі сховища досліджень (rf_study_store_v1) — щоб «Не відбулось»
    // (скасування/відмова) було видно й на майбутні дні, синхронно з чергою
    if (window.getStudyStore) {
      var st = window.getStudyStore();
      list = list.map(function (p) { var s = st[p.id]; return (s && s.status) ? Object.assign({}, p, { status: s.status, reason: s.reason || p.reason }) : p; });
    }
    // накладаємо відредаговані дослідження (rf_studies_v1) — назва + сумарна тривалість
    if (window.rfApplyStudies) list = list.map(function (p) { return window.rfApplyStudies(p); });
    // ховаємо ПЕРЕНЕСЕНІ записи (оригінал після перенесення) — rf_cancelled_v1
    if (window.isPatientSuppressed) list = list.filter(function (p) { return !window.isPatientSuppressed(p.id); });
    // ручний графік кабінетів: ховаємо записи зачинених кабінетів / поза годинами роботи
    if (!ignoreSchedule && window.rfRoomOpenAt) list = list.filter(function (p) { return window.rfRoomOpenAt(d, p.room, p.time); });
    list.sort(function (a, b) { return a.time.localeCompare(b.time); });
    return list;
  };
})();
