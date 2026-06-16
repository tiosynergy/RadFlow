/* ===== RadFlow — Queue Board App ===== */
const { useState, useEffect, useRef, useMemo } = React;

function computeCounts(patients) {
  const c = { total: patients.length, queued: 0, waiting: 0, cabinet: 0, done: 0, noshow: 0 };
  patients.forEach((p) => { c[p.status]++; });
  return c;
}

function computeRoomLoad(patients) {
  const cap = 480; // 8h working day in minutes
  return Object.keys(window.RF_ROOMS).map((rk) => {
    const room = window.RF_ROOMS[rk];
    const mins = patients.filter((p) => p.room === rk && p.status !== "noshow")
                         .reduce((s, p) => s + p.dur, 0);
    const pct = Math.min(100, Math.round((mins / cap) * 100));
    return { roomKey: rk, name: room.name, kind: room.kind, pct, color: room.kind === "МРТ" ? "var(--blue)" : "var(--orange)" };
  });
}

function App() {
  const [patients, setPatients] = useState(() => window.getQueuePatients ? window.getQueuePatients() : window.RF_PATIENTS.map((p) => ({ ...p })));
  const [enteredAt, setEnteredAt] = useState(() => {
    const now = Date.now();
    const m = {};
    Object.keys(window.RF_ROOMS).forEach((k) => { m[k] = now; });
    m.r1 = now - 34 * 60 * 1000;  // в кабінеті
    m.r2 = now - 12 * 60 * 1000;
    m.r3 = now - 48 * 60 * 1000;  // перевищено час → затримка
    m.r5 = now - 5 * 60 * 1000;
    return m;
  });
  const [roomView, setRoomView] = useState("all");
  const [selectedDate, setSelectedDate] = useState(() => window.rfToday()); // реальна дата (сьогодні за замовчуванням)
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [toasts, setToasts] = useState([]);
  const [flashId, setFlashId] = useState(null);
  const [expandedRow, setExpandedRow] = useState(null); // id розгорнутого рядка черги (лише один)
  const [modal, setModal] = useState(null); // 'new' | 'breakdown' | {complete patient} | {reschedule}
  const [incidents, setIncidents] = useState(() => (window.getIncidents ? window.getIncidents() : [])); // активні поломки/ТО (кілька кабінетів)
  const [reschedule, setReschedule] = useState(null); // пацієнт черги, якого переносимо на слот
  const [bookingVer, setBookingVer] = useState(0); // версія ручних записів (для перерахунку перегляду інших днів)
  const [confirm, setConfirm] = useState(null); // діалог підтвердження дії
  const [editStudies, setEditStudies] = useState(null); // запис, чиї дослідження редагуємо
  const [schedEdit, setSchedEdit] = useState(null); // дата, чий режим роботи редагуємо
  const [schedVer, setSchedVer] = useState(0); // версія ручних змін графіка (перерахунок черги/календаря)
  const [reschedView, setReschedView] = useState(null); // дата, чий колл-лист на перенесення відкрито
  const [reschedVer, setReschedVer] = useState(0); // версія колл-листа на перенесення
  const toastSeq = useRef(0);
  const selectedDateRef = useRef(selectedDate);
  useEffect(() => { selectedDateRef.current = selectedDate; }, [selectedDate]);

  const today = window.rfToday();
  const isToday = window.rfSameDay(selectedDate, today);
  const isPast = selectedDate < today && !isToday;
  const dateLabel = window.rfFmtFull(selectedDate);

  /* пацієнти для обраного дня:
       • сьогодні — живі дані (RF_PATIENTS + симуляція в реальному часі);
       • інші дні — детерміноване моделювання розкладу за реальною датою. */
  const selKey = selectedDate.getTime();
  const viewPatients = useMemo(() => {
    if (isToday) return patients;
    return window.getDayPatients ? window.getDayPatients(selectedDate) : [];
  }, [patients, selKey, isToday, bookingVer, schedVer]);

  /* per-room active patient + queue helpers */
  const roomKeys = Object.keys(window.RF_ROOMS);
  const currentByRoom = {};
  const waitingByRoom = {};
  const nextWaitingByRoom = {};
  roomKeys.forEach((k) => {
    currentByRoom[k] = viewPatients.find((p) => p.room === k && p.status === "cabinet") || null;
    const w = viewPatients.filter((p) => p.room === k && p.status === "waiting");
    waitingByRoom[k] = w.length;
    nextWaitingByRoom[k] = w[0] || null;
  });

  /* deep-link: ?new=1 / ?adddoc=1 / ?room=rN */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const rm = params.get("room");
    if (rm && window.RF_ROOMS && window.RF_ROOMS[rm]) setRoomView(rm);

    if (params.get("new") === "1") setModal("new");
    else if (params.get("adddoc") === "1") setModal("adddoc");
  }, []);

  /* колапс розгорнутого рядка при кліку поза будь-яким рядком черги + Esc */
  useEffect(() => {
    if (expandedRow == null) return;
    function onDocClick(e) { if (!e.target.closest(".qrow-item")) setExpandedRow(null); }
    function onKey(e) { if (e.key === "Escape") setExpandedRow(null); }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDocClick); document.removeEventListener("keydown", onKey); };
  }, [expandedRow]);

  function toggleRow(id) { setExpandedRow((cur) => (cur === id ? null : id)); }

  /* Real-time синхронізація:
       • статуси дослідження з кабінету радіолога (rf_study_store_v1)
       • статуси дзвінка з колл-листа (rf_calllist_status_v1)
     застосовуються миттєво — між вкладками (storage) і в межах вкладки (rf-call-sync). */
  const [, setCallVer] = useState(0);
  function reapplyStudy() {
    const store = window.getStudyStore ? window.getStudyStore() : {};
    setPatients((ps) => ps.map((p) => (store[p.id] && store[p.id].status) ? { ...p, status: store[p.id].status } : p));
  }
  useEffect(() => {
    function onStorage(e) {
      if (!e.key || e.key === window.RAD_STORE_KEY) reapplyStudy();
      if (!e.key || e.key === window.CL_STORAGE_KEY) setCallVer((v) => v + 1); // перемалювати статуси дзвінка
      if (!e.key || e.key === window.RF_INC_KEY) setIncidents(window.getIncidents ? window.getIncidents() : []);
      if (!e.key || e.key === window.RF_BOOKINGS_KEY) { setBookingVer((v) => v + 1); if (window.rfSameDay(selectedDateRef.current, window.rfToday()) && window.getQueuePatients) setPatients(window.getQueuePatients()); }
      if (!e.key || e.key === window.RF_SCHED_KEY) setSchedVer((v) => v + 1); // ручний графік роботи кабінетів
      if (!e.key || e.key === window.RF_RESCHED_KEY) setReschedVer((v) => v + 1); // колл-лист на перенесення
    }
    function onStudySync() { reapplyStudy(); }     // симуляція/радіолог у цій же вкладці
    function onCallSync() { setCallVer((v) => v + 1); }
    function onIncSync() { setIncidents(window.getIncidents ? window.getIncidents() : []); } // поломки/ТО
    function onBookingSync() { setBookingVer((v) => v + 1); } // нові ручні записи
    function onSchedSync() { setSchedVer((v) => v + 1); } // зміни режиму роботи кабінетів
    function onReschedSync() { setReschedVer((v) => v + 1); } // колл-лист на перенесення
    window.addEventListener("storage", onStorage);
    window.addEventListener("rf-study-sync", onStudySync);
    window.addEventListener("rf-call-sync", onCallSync);
    window.addEventListener("rf-incident-sync", onIncSync);
    window.addEventListener("rf-booking-sync", onBookingSync);
    window.addEventListener("rf-sched-sync", onSchedSync);
    window.addEventListener("rf-resched-sync", onReschedSync);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("rf-study-sync", onStudySync);
      window.removeEventListener("rf-call-sync", onCallSync);
      window.removeEventListener("rf-incident-sync", onIncSync);
      window.removeEventListener("rf-booking-sync", onBookingSync);
      window.removeEventListener("rf-sched-sync", onSchedSync);
      window.removeEventListener("rf-resched-sync", onReschedSync);
    };
  }, []);

  /* Таймери кабінетів: коли пацієнт заходить у кабінет (вручну або симуляцією) —
     перезапускаємо відлік для цього кабінету. */
  const prevCabRef = useRef(null);
  useEffect(() => {
    const cur = {};
    Object.keys(window.RF_ROOMS).forEach((k) => {
      const c = patients.find((p) => p.room === k && p.status === "cabinet");
      cur[k] = c ? c.id : null;
    });
    if (prevCabRef.current === null) { prevCabRef.current = cur; return; } // перший прохід — не чіпати початкові офсети
    let changed = false; const next = { ...enteredAt };
    Object.keys(cur).forEach((k) => { if (prevCabRef.current[k] !== cur[k] && cur[k]) { next[k] = Date.now(); changed = true; } });
    prevCabRef.current = cur;
    if (changed) setEnteredAt(next);
  }, [patients]);

  /* Тумблер симуляції потоку пацієнтів */
  const [simOn, setSimOn] = useState(() => (window.RFSim ? window.RFSim.isOn() : true));
  function toggleSim() {
    const on = !simOn;
    setSimOn(on);
    if (window.RFSim) window.RFSim.setOn(on);
    pushToast(on ? "Симуляцію потоку увімкнено · Real-time" : "Симуляцію потоку призупинено", on ? "success" : "info");
  }
  useEffect(() => {
    function onTog(e) { setSimOn(e && e.detail ? e.detail.on : (window.RFSim && window.RFSim.isOn())); }
    window.addEventListener("rf-sim-toggle", onTog);
    return () => window.removeEventListener("rf-sim-toggle", onTog);
  }, []);

  /* toast helper */
  function pushToast(msg, type = "success") {
    const id = ++toastSeq.current;
    setToasts((ts) => [...ts, { id, msg, type }]);
    setTimeout(() => setToasts((ts) => ts.map((t) => t.id === id ? { ...t, out: true } : t)), 3400);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 3700);
  }

  function flash(id) {
    setFlashId(id);
    setTimeout(() => setFlashId((f) => (f === id ? null : f)), 1300);
  }

  /* ---- actions ---- */
  function callPatient(p) {
    if (incidents.some((i) => i.roomKey === p.room)) { pushToast(`${window.RF_ROOMS[p.room].name} заблоковано (поломка/ТО) — спершу розблокуйте апарат`, "warning"); return; }
    if (currentByRoom[p.room]) { pushToast(`${window.RF_ROOMS[p.room].name} зайнятий — спершу завершіть поточну процедуру`, "warning"); return; }
    setPatients((ps) => ps.map((x) => x.id === p.id ? { ...x, status: "cabinet" } : x));
    setEnteredAt((prev) => ({ ...prev, [p.room]: Date.now() }));
    if (window.saveStudy) window.saveStudy(p.id, { status: "cabinet" }); // синхронізація з кабінетом радіолога
    flash(p.id);
    pushToast(`${p.name.split(" ").slice(0, 2).join(" ")} викликано в ${window.RF_ROOMS[p.room].name}`, "info");
  }

  function completePatient(p, notes) {
    setPatients((ps) => ps.map((x) => x.id === p.id ? { ...x, status: "done", notes } : x));
    if (window.saveStudy) window.saveStudy(p.id, { status: "done" }); // синхронізація з кабінетом радіолога
    flash(p.id);
    pushToast("Процедуру виконано · Realtime-оновлення надіслано всім ролям", "success");
    setModal(null);
  }

  function openComplete(p) {
    setModal({ type: "complete", patient: p });
  }

  /* К-04: збій процедури → перезапис в одному місці. Фіксуємо «Не відбулось»
     і одразу відкриваємо перенесення на новий слот для цього ж пацієнта. */
  function failAndReschedule(p, reason, notes) {
    failPatient(p, reason, notes); // статус «Не відбулось» + закриває модалку завершення
    openReschedule(p);             // одразу пропонуємо новий слот
  }

  function failPatient(p, reason, notes) {
    setPatients((ps) => ps.map((x) => x.id === p.id ? { ...x, status: "noshow", reason, notes } : x));
    if (window.saveStudy) window.saveStudy(p.id, { status: "noshow" }); // синхронізація з кабінетом радіолога
    flash(p.id);
    pushToast(`${p.name.split(" ").slice(0, 2).join(" ")} — не відбулось: ${reason}`, "error");
    setModal(null);
  }

  function noShowPatient(p) {
    setPatients((ps) => ps.map((x) => x.id === p.id ? { ...x, status: "noshow" } : x));
    if (window.saveStudy) window.saveStudy(p.id, { status: "noshow" }); // синхронізація з кабінетом радіолога
    flash(p.id);
    pushToast(`${p.name.split(" ").slice(0, 2).join(" ")} — неявка зафіксована, слот звільнено`, "error");
  }

  /* пацієнт фізично прийшов: В черзі → Очікує */
  function arrivePatient(p) {
    setPatients((ps) => ps.map((x) => x.id === p.id ? { ...x, status: "waiting" } : x));
    if (window.saveStudy) window.saveStudy(p.id, { status: "waiting" }); // синхронізація з кабінетом радіолога
    flash(p.id);
    pushToast(`${p.name.split(" ").slice(0, 2).join(" ")} прийшов(-ла) → Очікує`, "info");
  }

  function undoPatient(p) {
    setPatients((ps) => ps.map((x) => x.id === p.id ? { ...x, status: "queued" } : x));
    if (window.saveStudy) window.saveStudy(p.id, { status: "queued" }); // синхронізація з кабінетом радіолога
    flash(p.id);
    pushToast("Статус повернено → В черзі", "info");
  }

  /* виправлення статусу (у разі випадкового натискання) — пряма зміна на будь-який статус */
  function correctStatus(p, status) {
    if (p.status === status) return;
    // «Виконано» лише після кабінету — не можна завершити дослідження, якого не було
    if (status === "done" && p.status !== "cabinet") {
      pushToast("«Виконано» можна позначити лише для пацієнта в кабінеті — спершу викличте його в кабінет", "warning");
      return;
    }
    if (status === "cabinet") {
      const occ = currentByRoom[p.room];
      if (occ && occ.id !== p.id) { pushToast(`${window.RF_ROOMS[p.room].name} зайнятий — спершу звільніть кабінет`, "warning"); return; }
      setEnteredAt((prev) => ({ ...prev, [p.room]: Date.now() }));
    }
    setPatients((ps) => ps.map((x) => x.id === p.id ? { ...x, status } : x));
    if (window.saveStudy) window.saveStudy(p.id, { status }); // синхронізація з кабінетом радіолога
    flash(p.id);
    const labels = { queued: "В черзі", waiting: "Очікує", cabinet: "В кабінеті", done: "Виконано", noshow: "Не відбулось" };
    pushToast(`Статус виправлено → ${labels[status]} · синхронізовано`, "info");
  }

  function addBooking(b) {
    const dateObj = b.date || window.rfToday();
    const id = Date.now(); // унікальний id поза діапазоном сидів/розкладу
    const rec = { id, date: window.rfDateKey(dateObj), time: b.time, name: b.name, age: b.age || 40, weight: b.weight || null, phone: b.phone || "+38 0__ ___ __ __", proc: b.proc, dur: b.dur, room: b.room, status: "queued", call: "pending", notes: b.notes };

    /* Записуємо у СПІЛЬНЕ сховище ручних записів (rf_bookings_v1) → запис
       зберігається після перезавантаження, синхронізується між вкладками/ролями
       і вмерджується у чергу (сьогодні) та розклад інших днів. */
    if (window.addBookingRecord) window.addBookingRecord(rec);
    // якщо досліджень кілька — зберігаємо структурований набір (rf_studies_v1)
    if (b.studies && b.studies.length > 1 && window.saveStudies) window.saveStudies(id, b.studies);

    const bookToday = window.rfSameDay(dateObj, window.rfToday());
    if (bookToday) {
      if (window.saveStudy) window.saveStudy(id, { status: "queued", phase: "waiting" });
      if (window.getQueuePatients) setPatients(window.getQueuePatients());
      flash(id);
      pushToast(`Новий запис: ${b.name} · ${window.RF_ROOMS[b.room].name} о ${b.time} · синхронізовано з чергою`, "success");
    } else {
      setBookingVer((v) => v + 1); // оновити перегляд іншого дня, якщо він зараз відкритий
      pushToast(`Новий запис: ${b.name} на ${window.rfFmtShort(dateObj)} ${b.time} · ${window.RF_ROOMS[b.room].name} · збережено в розклад`, "success");
    }
    setModal(null);
  }

  /* ---- Поломка / ТО (виправлення Проблем 1 і 2) ---- */
  // Реєстрація/редагування інциденту: модалка передає вже зібраний інцидент
  // (rfBuildIncident) з постраждалими сьогодні + наперед (для «До відновлення»).
  function registerBreakdown(inc, isEdit) {
    window.upsertIncident(inc);            // → rf-incident-sync оновить стан + усі ролі
    if (isEdit) {
      pushToast(`Інцидент оновлено · ${inc.machineName} · ${window.rfIncPending(inc)} на обдзвін`, "info");
      setModal(null);
    } else {
      setModal({ type: "breakdownDone", incident: inc });
      pushToast(`${inc.machineName} заблоковано · сформовано колл-лист: ${inc.patients.length} на обдзвін`, "warning");
    }
  }
  // Оновлення статусу обдзвону постраждалого пацієнта (з правої панелі).
  function setIncidentCall(p, status) {
    if (window.setIncidentCallStatus) window.setIncidentCallStatus(p.id, status);
    const nm = p.name.split(" ").slice(0, 2).join(" ");
    const msgs = {
      rescheduled: `${nm} — перезаписано ✓`,
      callback: `${nm} — у списку «передзвонити»`,
      refused: `${nm} — відмова від перезапису`,
    };
    pushToast(msgs[status] || "Оновлено", status === "rescheduled" ? "success" : status === "refused" ? "warning" : "info");
  }
  // Перенесення пацієнта черги на новий слот (рішення приймається прямо тут).
  function openReschedule(p) { setReschedule({ id: p.id, name: p.name, proc: p.proc, dur: p.dur, roomKey: p.room, phone: p.phone, age: p.age, weight: p.weight }); }
  function doReschedule(slot) {
    const p = reschedule;
    if (p) {
      let flashTarget = p.id;
      const isManual = window.getBookings && window.getBookings().some((b) => b.id === p.id);
      if (isManual && window.updateBookingRecord) {
        // ручний запис — реально переносимо (оновлюємо запис у сховищі); статус скидаємо
        window.updateBookingRecord(p.id, { date: slot.date, time: slot.time, room: slot.roomKey, status: "queued", call: "pending" });
        // дослідження на новому слоті ще не проводилось → скидаємо «в кабінеті/виконано» на «В черзі»
        if (window.saveStudy) window.saveStudy(p.id, { status: "queued", phase: "waiting" });
      } else {
        // згенерований/сід-пацієнт — ховаємо оригінал і створюємо НОВИЙ запис «В черзі» на новому слоті
        if (window.suppressPatient) window.suppressPatient(p.id);
        const newId = Date.now();
        if (window.addBookingRecord) window.addBookingRecord({ id: newId, date: slot.date, time: slot.time, name: p.name, age: p.age || 40, weight: p.weight || null, phone: p.phone || "", proc: p.proc, dur: p.dur, room: slot.roomKey, status: "queued", call: "pending" });
        flashTarget = newId;
      }
      setBookingVer((v) => v + 1);
      if (isToday && window.getQueuePatients) setPatients(window.getQueuePatients());
      flash(flashTarget);
      pushToast(`${p.name.split(" ").slice(0, 2).join(" ")} перенесено → ${slot.roomName} · ${slot.date} ${slot.time}`, "success");
    }
    setReschedule(null);
  }

  // Скасування / відмова → статус «Не відбулось» (синхронізується з чергою й усіма ролями
  // через спільне сховище досліджень). Запис лишається в історії дня, потрапляє в блок
  // «Не відбулось» і його можна повернути в чергу.
  function doCancelBooking(p, msg, reason) {
    if (window.saveStudy) window.saveStudy(p.id, { status: "noshow", phase: "waiting", reason: reason || "Скасовано адміністратором" });
    setBookingVer((v) => v + 1);
    if (isToday && window.getQueuePatients) setPatients(window.getQueuePatients());
    flash(p.id);
    pushToast(msg || `Не відбулось · ${p.name.split(" ").slice(0, 2).join(" ")} · ${window.RF_ROOMS[p.room].name} ${p.time}`, "warning");
  }
  // Скасування з підтвердженням.
  function cancelBooking(p) {
    const nm = p.name.split(" ").slice(0, 2).join(" ");
    setConfirm({
      title: "Скасувати запис?",
      message: `Запис «${nm} · ${window.RF_ROOMS[p.room].name} · ${p.time}» буде позначено як «Не відбулось». Його можна буде повернути в чергу.`,
      confirmLabel: "Так, скасувати запис", cancelLabel: "Ні, лишити", danger: true,
      onConfirm: () => { doCancelBooking(p, null, "Скасовано адміністратором"); setConfirm(null); },
    });
  }
  // Змінити статус дзвінка-підтвердження (синхронізується з колл-листом через rf-call-sync).
  function setCallStatus(p, status) {
    const nm = p.name.split(" ").slice(0, 2).join(" ");
    if (status === "refused") {
      // відмова на обдзвоні → запис → «Не відбулось», але СПЕРШУ підтвердження
      setConfirm({
        title: "Відмова пацієнта — скасувати запис?",
        message: `Пацієнт «${nm}» відмовився на обдзвоні. Запис на ${window.RF_ROOMS[p.room].name} о ${p.time} буде позначено як «Не відбулось».`,
        confirmLabel: "Так, скасувати запис", cancelLabel: "Ні, лишити", danger: true,
        onConfirm: () => { if (window.saveCallStatus) window.saveCallStatus(p.id, "refused"); doCancelBooking(p, `Відмова пацієнта · ${nm} — Не відбулось`, "Відмова пацієнта (обдзвін)"); setConfirm(null); },
      });
      return;
    }
    if (window.saveCallStatus) window.saveCallStatus(p.id, status);
    const m = (window.CL_STATUS || {})[status] || { label: status };
    pushToast(`Дзвінок · ${nm} → ${m.label}`, status === "confirmed" ? "success" : status === "noanswer" ? "warning" : "info");
  }

  // Зняти блокування конкретного кабінету.
  function resolveIncident(roomKey) {
    if (window.removeIncident) window.removeIncident(roomKey);
    const nm = (window.RF_ROOMS[roomKey] || {}).name || "Апарат";
    pushToast(`${nm} розблоковано · інцидент завершено`, "success");
  }

  /* id пацієнтів (сьогодні), що чекають на обдзвін через будь-який активний інцидент */
  const reschedIds = useMemo(() => {
    const s = new Set();
    if (isToday) {
      incidents.forEach((inc) => (inc.patients || []).forEach((p) => {
        if (p.isToday && p.callStatus !== "rescheduled" && p.callStatus !== "refused") s.add(p.id);
      }));
    }
    return s;
  }, [incidents, isToday]);

  /* ---- derived (scoped to selected room + selected day) ---- */
  const scoped = roomView === "all" ? viewPatients : viewPatients.filter((p) => p.room === roomView);
  const counts = useMemo(() => computeCounts(scoped), [scoped]);
  const roomLoad = useMemo(() => computeRoomLoad(viewPatients), [viewPatients]);

  /* зміни у черзі СЬОГОДНІ: відмова (неявка) або затримка (перевищено час у кабінеті) */
  const hasQueueChanges = patients.some((p) => p.status === "noshow")
    || roomKeys.some((k) => {
      const p = patients.find((x) => x.room === k && x.status === "cabinet");
      return p && (Date.now() - enteredAt[k]) / 1000 > p.dur * 60;
    });

  const filtered = window.rfSortFlow(scoped.filter((p) => {
    if (filter !== "all" && p.status !== filter) return false;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      if (!(p.name.toLowerCase().includes(q) || p.proc.toLowerCase().includes(q) || p.phone.includes(q))) return false;
    }
    return true;
  }));

  return (
    <div className="app">
      <Sidebar active={roomView} />
      <div className="main">
        <TopBar date={dateLabel} onRefresh={() => pushToast("Дані оновлено · підключення активне", "info")} onNew={() => setModal("new")} onBreakdown={isToday ? () => setModal("breakdown") : null} simOn={simOn} onToggleSim={toggleSim} />
        <div className="content-wrap">
          <div className="content">
            {isToday && window.getCitoPatients && (
              <CitoBanner patients={window.getCitoPatients(patients)} onOpen={(id) => { const p = patients.find((x) => x.id === id); if (p) { setRoomView(p.room); flash(id); } }} />
            )}
            {isToday && incidents.map((incident) => (
              <div className="inc-banner fade-in" key={incident.roomKey}>
                <span className="inc-banner-ic">🔧</span>
                <div className="inc-banner-txt">
                  <div className="inc-banner-title">
                    {incident.machineName} заблоковано · {incident.reasonLabel}
                    <span className="inc-banner-window">простій {incident.windowLabel || (incident.fromLabel + "–" + incident.toLabel)}</span>
                  </div>
                  <div className="inc-banner-sub">
                    {window.rfIncPending(incident) > 0
                      ? <><b>{window.rfIncPending(incident)}</b> {window.rfIncPending(incident) === 1 ? "пацієнт потребує" : "пацієнтів потребують"} обдзвону на перезапис — у панелі «Обдзвін через простій» →</>
                      : <>Усіх постраждалих пацієнтів опрацьовано ✓</>}
                  </div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => setModal({ type: "breakdown-edit", existing: incident })}>✏ Редагувати</button>
                <button className="btn btn-secondary btn-sm" onClick={() => resolveIncident(incident.roomKey)}>🔓 Розблокувати</button>
              </div>
            ))}
            <div className="board-main-top">
              <StatsBar counts={counts} filter={filter} setFilter={setFilter} />
              {(() => {
                const r = window.getReschedule ? window.getReschedule(selectedDate) : null;
                if (!r || !r.patients || r.patients.length === 0) return null;
                const pend = window.rfReschedPending ? window.rfReschedPending(r) : r.patients.length;
                const done = r.patients.length - pend;
                return (
                  <div className="resched-banner">
                    <span className="rb-ic">☎</span>
                    <div className="rb-meta">
                      <div className="rb-title">{r.patients.length} {r.patients.length === 1 ? "запис потребує" : "записів потребують"} перенесення</div>
                      <div className="rb-sub">Зміна графіка{r.label ? " · " + r.label : ""} · <b className="rb-pend">{pend}</b> на обдзвін{done ? ", " + done + " опрацьовано" : ""}</div>
                    </div>
                    <button className="btn btn-primary btn-sm" onClick={() => setReschedView(selectedDate)}>Колл-лист перенесення →</button>
                  </div>
                );
              })()}
              {!isToday ? (
                <div className="day-banner">
                  <span className="db-ic">{isPast ? "🗂" : "📅"}</span>
                  <div className="db-meta">
                    <div className="db-title">{dateLabel}</div>
                    <div className="db-sub">{(() => {
                      const ov = window.rfDayOverrideStatus ? window.rfDayOverrideStatus(selectedDate) : { kind: "none", label: "" };
                      const custom = window.rfDayCustomRooms ? window.rfDayCustomRooms(selectedDate) : [];
                      if (ov.kind === "closed") return (ov.label ? ov.label + " · " : "") + "клініка зачинена";
                      if (ov.kind === "custom") {
                        const closedN = custom.filter((r) => r.closed).length, customN = custom.length - closedN, parts = [];
                        if (closedN) parts.push(closedN + " зачинено");
                        if (customN) parts.push(customN + " з ін. графіком");
                        return (ov.label ? ov.label : "Особливий графік") + " · " + parts.join(", ") + (counts.total ? " · " + counts.total + " записів" : "");
                      }
                      if (counts.total === 0) return "Вихідний — клініка не працює";
                      return (isPast ? "Архів — день завершено" : "Заплановані записи на цей день") + " · " + counts.total + " записів";
                    })()}</div>
                  </div>
                  <button className="btn btn-secondary btn-sm" onClick={() => setSelectedDate(window.rfToday())}>← Сьогодні</button>
                </div>
              ) : roomView === "all" ? (
                <div className="room-cards">
                  {roomKeys.map((k) => (
                    <RoomStatusCard
                      key={k} roomKey={k}
                      patient={currentByRoom[k]} enteredAt={enteredAt[k]}
                      nextWaiting={nextWaitingByRoom[k]}
                      blocked={incidents.find((i) => i.roomKey === k) || null}
                      onUnblock={() => resolveIncident(k)}
                      onComplete={openComplete} onCall={callPatient} onOpen={setRoomView}
                    />
                  ))}
                </div>
              ) : (
                <>
                  <div className="room-view-head">
                    <button className="btn btn-ghost btn-sm" onClick={() => setRoomView("all")}>← Усі кабінети</button>
                    <span className="rvh-title">
                      <span className={"rvh-tile " + (window.RF_ROOMS[roomView].kind === "МРТ" ? "mrt" : "ct")}>{window.RF_ROOMS[roomView].kind}</span>
                      {window.RF_ROOMS[roomView].name} · {window.RF_ROOMS[roomView].model}
                    </span>
                  </div>
                  <CurrentCard
                    patient={currentByRoom[roomView]}
                    enteredAt={enteredAt[roomView]}
                    roomKey={roomView}
                    nextWaiting={nextWaitingByRoom[roomView]}
                    blocked={incidents.find((i) => i.roomKey === roomView) || null}
                    onUnblock={() => resolveIncident(roomView)}
                    onCall={callPatient}
                    onComplete={openComplete}
                    onReschedule={openReschedule}
                  />
                </>
              )}
            </div>

            <QueueControls filter={filter} setFilter={setFilter} counts={counts} query={query} setQuery={setQuery} />
            <div className="qhead">
              <div>Час</div><div>Пацієнт</div><div>Процедура</div><div>Кабінет</div><div>Статус</div><div></div>
            </div>
            {filtered.length === 0 ? (
              <div className="empty">
                <div className="ei">⌕</div>
                <div className="et">Нічого не знайдено</div>
                <div className="es">Спробуйте змінити фільтр або пошуковий запит</div>
              </div>
            ) : (
              <div className="qrows">
                {filtered.map((p) => (
                  <QueueRow
                    key={p.id} p={p} date={selectedDate} flash={flashId === p.id}
                    expanded={expandedRow === p.id} onToggle={toggleRow}
                    rescheduling={reschedIds.has(p.id)}
                    roomBlocked={incidents.some((i) => i.roomKey === p.room)}
                    canCall={!currentByRoom[p.room]} readOnly={!isToday} canReschedule={!isPast}
                    onCall={callPatient} onComplete={openComplete}
                    onArrive={arrivePatient}
                    onUndo={undoPatient} onNoShow={noShowPatient}
                    onSetStatus={correctStatus}
                    onReschedule={openReschedule}
                    onCancel={cancelBooking}
                    onSetCall={setCallStatus}
                    onEditStudies={isPast ? undefined : setEditStudies}
                  />
                ))}
              </div>
            )}
          </div>
          <aside className="rpanel">
            <MiniCalendar selectedDate={selectedDate} onSelectDate={setSelectedDate} today={today} hasChanges={hasQueueChanges} counts={counts} simOn={simOn} onEditSchedule={setSchedEdit} schedVer={schedVer} />
            <RoomLoad rooms={roomLoad} />
            <CallListPreview roomView={roomView} onToast={pushToast} incidents={isToday ? incidents : []} onIncStatus={setIncidentCall} />
          </aside>
        </div>
      </div>
      <Toasts toasts={toasts} />
      {modal === "new" && <NewBookingModal patients={patients} onClose={() => setModal(null)} onSave={addBooking} />}
      {modal === "adddoc" && <AddDoctorModal onClose={() => setModal(null)} onSave={(d) => { pushToast(`Лікаря-направляча додано: ${d.name}`, "success"); setModal(null); }} />}
      {(modal === "breakdown" || (modal && modal.type === "breakdown-edit")) &&
        <BreakdownModal existing={modal && modal.existing} onClose={() => setModal(null)}
          onConfirm={(inc) => registerBreakdown(inc, !!(modal && modal.existing))} />}
      {modal && modal.type === "breakdownDone" && <BreakdownDoneModal incident={modal.incident} onClose={() => setModal(null)} />}
      {reschedule && <RescheduleModal patient={reschedule} onClose={() => setReschedule(null)} onConfirm={doReschedule} />}
      {editStudies && <StudyEditModal patient={editStudies} date={selectedDate} onClose={() => setEditStudies(null)} onConfirm={() => { setBookingVer((v) => v + 1); if (isToday && window.getQueuePatients) setPatients(window.getQueuePatients()); pushToast("Дослідження оновлено · синхронізовано", "success"); }} />}
      {confirm && <ConfirmModal {...confirm} onClose={() => setConfirm(null)} />}
      {schedEdit && <ScheduleEditModal date={schedEdit} onClose={() => setSchedEdit(null)} onSaved={(msg) => { setSchedVer((v) => v + 1); setReschedVer((v) => v + 1); pushToast(msg || "Графік роботи оновлено · синхронізовано", "success"); }} />}
      {reschedView && <ReschedCallListModal date={reschedView} onClose={() => setReschedView(null)} onChange={() => { setReschedVer((v) => v + 1); setBookingVer((v) => v + 1); if (isToday && window.getQueuePatients) setPatients(window.getQueuePatients()); }} />}
      {modal && modal.type === "complete" && (
        <CompletionModal patient={modal.patient} enteredAt={enteredAt[modal.patient.room]}
          onClose={() => setModal(null)} onSuccess={completePatient} onFail={failPatient} onReschedule={failAndReschedule} />
      )}
    </div>
  );
}

/* ---------- Режим роботи кабінетів за датою (свята / вихідні) ----------
   Адміністратор відкриває це вікно з календаря на головній дошці черги —
   там, де ухвалюється рішення про конкретний день. Можна закрити всю клініку
   (неробочий день із підписом) або змінити графік кожного кабінету окремо
   (зачинено / інші години). Зберігається у rf_sched_override_v1. */
function ScheduleEditModal({ date, onClose, onSaved }) {
  const rooms = window.RF_ROOMS || {};
  const roomKeys = Object.keys(rooms);
  const def = window.RF_DEFAULT_HOURS || { start: "08:00", end: "18:00" };
  const dateLabel = window.rfFmtFull ? window.rfFmtFull(date) : String(date);
  const existing = window.getDayOverride ? window.getDayOverride(date) : null;
  const defaultClosed = window.rfDefaultClosed ? window.rfDefaultClosed(date) : (date.getDay() === 0);

  const [allClosed, setAllClosed] = useState(!!(existing && existing.allClosed));
  const [label, setLabel] = useState((existing && existing.label) || "");
  const [roomState, setRoomState] = useState(() => {
    const m = {};
    roomKeys.forEach((k) => {
      const eff = window.rfRoomScheduleForDate ? window.rfRoomScheduleForDate(date, k) : { closed: defaultClosed, start: def.start, end: def.end };
      const mode = eff.closed ? "closed" : ((eff.start !== def.start || eff.end !== def.end) ? "custom" : "open");
      m[k] = { mode, start: eff.start || def.start, end: eff.end || def.end };
    });
    return m;
  });
  function setRoom(k, patch) { setRoomState((s) => ({ ...s, [k]: { ...s[k], ...patch } })); }

  const LABELS = ["Державне свято", "Вихідний день", "Санітарний день", "Технічне обслуговування"];

  /* Будуємо об'єкт оверайду з поточного стану форми (без збереження). */
  function buildOv() {
    if (allClosed) return { allClosed: true, label: label.trim() || "Неробочий день" };
    const ro = {};
    roomKeys.forEach((k) => {
      const st = roomState[k];
      if (st.mode === "closed") { if (!defaultClosed) ro[k] = { closed: true }; }
      else if (st.mode === "custom") { ro[k] = { start: st.start, end: st.end }; }
      else { if (defaultClosed) ro[k] = { start: st.start, end: st.end }; } // явне відкриття типового вихідного
    });
    const o = { rooms: ro };
    if (label.trim()) o.label = label.trim();
    return o;
  }

  /* Записи, яких торкнеться це закриття/скорочення — попередній перегляд. */
  const previewOv = buildOv();
  const affected = window.rfAffectedByClosure ? window.rfAffectedByClosure(date, previewOv) : [];

  function save() {
    const ov = buildOv();
    if (window.setDayOverride) window.setDayOverride(date, ov);
    // зачеплені записи → колл-лист на перенесення (зберігаємо вже зафіксовані статуси обдзвону)
    if (window.setReschedule) {
      if (affected.length) {
        const prev = window.getReschedule ? window.getReschedule(date) : null;
        const prevMap = {};
        if (prev && prev.patients) prev.patients.forEach((p) => { if (p.callStatus && p.callStatus !== "pending") prevMap[p.id] = p.callStatus; });
        const patients = affected.map((p) => prevMap[p.id] ? { ...p, callStatus: prevMap[p.id] } : p);
        const lbl = ov.label || (ov.allClosed ? "Неробочий день" : "Зміна графіка");
        window.setReschedule(date, { label: lbl, createdAt: Date.now(), patients });
      } else if (window.clearReschedule) {
        window.clearReschedule(date);
      }
    }
    const empty = !ov.allClosed && (!ov.rooms || Object.keys(ov.rooms).length === 0);
    const msg = empty ? "Повернуто типовий графік"
      : affected.length ? `Графік оновлено · ${affected.length} ${affected.length === 1 ? "запис" : "записів"} → колл-лист на перенесення`
      : "Графік роботи оновлено · синхронізовано";
    onSaved && onSaved(msg);
    onClose && onClose();
  }
  function reset() {
    if (window.clearDayOverride) window.clearDayOverride(date);
    // графік повернуто до типового → записи більше не потребують перенесення:
    // прибираємо колл-лист (тим, кого ще не встигли обдзвонити, дзвонити вже не треба)
    const hadList = !!(window.getReschedule && window.getReschedule(date));
    if (window.clearReschedule) window.clearReschedule(date);
    onSaved && onSaved(hadList ? "Повернуто типовий графік · колл-лист перенесення очищено" : "Повернуто типовий графік");
    onClose && onClose();
  }

  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 560 }}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic">🗓</span>Режим роботи · {window.rfFmtShort ? window.rfFmtShort(date) : ""}</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dlg-body">
          <div className="ctx-hint blue">Графік на <b>{dateLabel}</b>. Закрийте всю клініку на свято / державний вихідний або змініть години роботи окремих кабінетів. Зміни одразу відображаються в календарі та черзі.</div>

          <label className="sch-allclosed">
            <input type="checkbox" checked={allClosed} onChange={(e) => setAllClosed(e.target.checked)} />
            <span><b>Неробочий день</b> — вся клініка зачинена</span>
          </label>

          <label className="fld">
            <span className="fld-lab">Причина / підпис{allClosed ? "" : " (необов'язково)"}</span>
            <input className="inp" placeholder="напр. Державне свято" value={label} onChange={(e) => setLabel(e.target.value)} />
            <div className="sch-chips">
              {LABELS.map((l) => <button key={l} type="button" className={"sch-chip" + (label === l ? " on" : "")} onClick={() => setLabel(label === l ? "" : l)}>{l}</button>)}
            </div>
          </label>

          {!allClosed && (
            <div className="sch-rooms">
              <div className="sch-rooms-lab">Кабінети та обладнання</div>
              {roomKeys.map((k) => {
                const r = rooms[k], st = roomState[k];
                return (
                  <div className="sch-room" key={k}>
                    <div className="sch-room-info">
                      <span className={"sch-room-ic " + (r.kind === "МРТ" ? "mrt" : "ct")}>{r.kind === "МРТ" ? "🧲" : "🩻"}</span>
                      <div className="sch-room-txt">
                        <span className="sch-room-name">{r.name}</span>
                        <span className="sch-room-model">{r.kind} · {r.model}</span>
                      </div>
                    </div>
                    <div className="sch-room-ctl">
                      <div className="bk-seg bk-seg-sm">
                        <button className={"bk-seg-btn" + (st.mode === "open" ? " active" : "")} onClick={() => setRoom(k, { mode: "open" })}>Працює</button>
                        <button className={"bk-seg-btn" + (st.mode === "custom" ? " active" : "")} onClick={() => setRoom(k, { mode: "custom" })}>Інші години</button>
                        <button className={"bk-seg-btn" + (st.mode === "closed" ? " active" : "")} onClick={() => setRoom(k, { mode: "closed" })}>Зачинено</button>
                      </div>
                      {st.mode === "custom" && (
                        <div className="sch-hours">
                          <input className="inp tabular" type="time" value={st.start} onChange={(e) => setRoom(k, { start: e.target.value })} />
                          <span className="sch-dash">–</span>
                          <input className="inp tabular" type="time" value={st.end} onChange={(e) => setRoom(k, { end: e.target.value })} />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Попередження: на цю дату вже є записи, яких торкнеться зміна */}
          {affected.length > 0 && (
            <div className="ctx-hint red sch-affected">
              <div className="sch-aff-head">⚠ На цю дату вже заплановано {affected.length} {affected.length === 1 ? "запис" : "записів"} у кабінетах, що змінюються.</div>
              <div className="sch-aff-sub">Після збереження їх буде додано до <b>колл-листа на перенесення</b> — реєстратор обдзвонить пацієнтів і перенесе на інший слот/день.</div>
              <ul className="sch-aff-list">
                {affected.slice(0, 4).map((p) => (
                  <li key={p.id}>{p.time} · {p.name} · {(window.RF_ROOMS[p.room] || {}).name || p.room}</li>
                ))}
                {affected.length > 4 && <li className="sch-aff-more">…та ще {affected.length - 4}</li>}
              </ul>
            </div>
          )}
        </div>
        <div className="dlg-foot sch-foot">
          {existing
            ? <button className="btn btn-ghost sch-reset" onClick={reset} title="Прибрати ручні зміни — повернути типовий графік">↺ Скинути до типового</button>
            : <span className="sch-foot-sp" />}
          <div className="sch-foot-r">
            <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
            <button className="btn btn-primary" onClick={save}>✓ Зберегти графік</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Колл-лист на перенесення (після зміни графіка) ----------
   Пацієнти, чиї записи зачепило закриття дня/кабінету. Реєстратор обдзвонює
   й переносить кожного на новий слот (повторно використовує RescheduleModal).
   Статуси обдзвону спільні зі сценарієм поломки апарата (RF_INC_STATUS). */
function ReschedCallListModal({ date, onClose, onChange }) {
  const [, setVer] = useState(0);
  const [resched, setResched] = useState(null); // пацієнт, якого переносимо
  const entry = window.getReschedule ? window.getReschedule(date) : null;
  const patients = entry ? entry.patients : [];
  const ST = window.RF_INC_STATUS || {};
  const rooms = window.RF_ROOMS || {};
  const dateLabel = window.rfFmtFull ? window.rfFmtFull(date) : String(date);
  const pend = window.rfReschedPending ? window.rfReschedPending(entry) : patients.length;

  function setStatus(id, status) { if (window.setRescheduleStatus) window.setRescheduleStatus(date, id, status); setVer((v) => v + 1); onChange && onChange(); }
  function doMove(p, slot) {
    const isManual = window.getBookings && window.getBookings().some((b) => b.id === p.id);
    if (isManual && window.updateBookingRecord) {
      window.updateBookingRecord(p.id, { date: slot.date, time: slot.time, room: slot.roomKey, status: "queued", call: "pending" });
    } else {
      if (window.suppressPatient) window.suppressPatient(p.id);          // ховаємо первісний запис закритого дня
      if (window.addBookingRecord) window.addBookingRecord({ id: Date.now(), date: slot.date, time: slot.time, name: p.name, age: p.age || 40, phone: p.phone || "", proc: p.proc, dur: p.dur || 30, room: slot.roomKey, status: "queued", call: "pending" });
    }
    if (window.setRescheduleStatus) window.setRescheduleStatus(date, p.id, "rescheduled");
    setResched(null); setVer((v) => v + 1); onChange && onChange();
  }

  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 560 }}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--orange-bg)", color: "var(--orange)" }}>☎</span>Перенесення записів · {window.rfFmtShort ? window.rfFmtShort(date) : ""}</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dlg-body">
          <div className="ctx-hint blue">Графік на <b>{dateLabel}</b> змінено{entry && entry.label ? " — " + entry.label : ""}. Обдзвоніть пацієнтів і перенесіть на інший слот або день. Залишилось обдзвонити: <b>{pend}</b> з {patients.length}.</div>
          {patients.length === 0
            ? <div className="ctx-hint" style={{ color: "var(--text-muted)" }}>Список порожній.</div>
            : (
              <ul className="rcl-list">
                {patients.map((p) => {
                  const meta = ST[p.callStatus] || ST.pending || { label: p.callStatus, cls: "gray", icon: "○" };
                  const doneRow = p.callStatus === "rescheduled" || p.callStatus === "refused";
                  return (
                    <li className={"rcl-row" + (doneRow ? " done" : "")} key={p.id}>
                      <div className="rcl-info">
                        <span className="rcl-time tabular">{p.time}</span>
                        <div className="rcl-txt">
                          <span className="rcl-name">{p.name}</span>
                          <span className="rcl-sub">{p.proc} · {(rooms[p.room] || {}).name || p.room} · <a className="rcl-tel" href={"tel:" + (p.phone || "").replace(/\s/g, "")}>{p.phone}</a></span>
                        </div>
                        <span className={"rcl-st " + (meta.cls || "gray")}>{meta.icon} {meta.label}</span>
                      </div>
                      <div className="rcl-act">
                        <button className="btn btn-primary btn-sm" onClick={() => setResched(p)}>{p.callStatus === "rescheduled" ? "Перенести ще раз" : "Перенести"}</button>
                        {p.callStatus !== "callback" && p.callStatus !== "rescheduled" && <button className="btn btn-secondary btn-sm" onClick={() => setStatus(p.id, "callback")} title="Передзвонити пізніше">↩</button>}
                        {p.callStatus !== "refused" && p.callStatus !== "rescheduled" && <button className="btn btn-secondary btn-sm rcl-refuse" onClick={() => setStatus(p.id, "refused")} title="Пацієнт відмовився">✕</button>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
        </div>
        <div className="dlg-foot">
          <button className="btn btn-ghost" onClick={onClose}>Закрити</button>
        </div>
      </div>
      {resched && <RescheduleModal patient={{ name: resched.name, proc: resched.proc, dur: resched.dur, phone: resched.phone, age: resched.age, roomKey: resched.room }} onClose={() => setResched(null)} onConfirm={(slot) => doMove(resched, slot)} />}
    </div>
  );
}

/* ---------- New booking modal ---------- */
/* contrast: true — дослідження можна виконати з контрастом (показується, коли
   відмічено чекбокс «Контраст»); інакше показуються всі за типом/моделлю. */
const MRT_REGIONS = [
  { label: "Головний мозок",                dur: 60, price: 2400, contrast: true },
  { label: "Хребет — шийний відділ",        dur: 40, price: 2100, contrast: true },
  { label: "Хребет — грудний відділ",       dur: 40, price: 2100, contrast: true },
  { label: "Хребет — поперековий відділ",   dur: 45, price: 2100, contrast: true },
  { label: "Колінний суглоб",               dur: 30, price: 1800, contrast: false },
  { label: "Плечовий суглоб",              dur: 30, price: 1800, contrast: false },
  { label: "Кульшовий суглоб",             dur: 35, price: 1900, contrast: false },
  { label: "Черевна порожнина",            dur: 50, price: 2600, contrast: true },
  { label: "Малий таз",                    dur: 45, price: 2600, contrast: true },
  { label: "Серце та судини",              dur: 60, price: 3200, contrast: true },
  { label: "Молочні залози",               dur: 50, price: 2700, contrast: true },
];
const CT_REGIONS = [
  { label: "Голова / мозок",                    dur: 15, price: 1200, contrast: true },
  { label: "Органи грудної клітки",             dur: 20, price: 1500, contrast: true },
  { label: "Органи черевної порожнини",         dur: 25, price: 1700, contrast: true },
  { label: "Малий таз",                         dur: 20, price: 1500, contrast: true },
  { label: "Хребет",                            dur: 20, price: 1400, contrast: false },
  { label: "Кінцівки",                          dur: 15, price: 1200, contrast: false },
  { label: "КТ-ангіографія",                   dur: 30, price: 2400, contrast: true },
  { label: "Мультизональне дослідження",        dur: 40, price: 2800, contrast: true },
];
/* Доплата за контраст (К-07: коротка ціна у формі запису). */
const CONTRAST_SURCHARGE = 900;

/* Determine room key by study type — pick first non-occupied cabinet */
function pickRoom(studyType, patients) {
  const mrtRooms = Object.keys(window.RF_ROOMS).filter((k) => window.RF_ROOMS[k].kind === "МРТ");
  const ctRooms  = Object.keys(window.RF_ROOMS).filter((k) => window.RF_ROOMS[k].kind === "КТ");
  const pool = studyType === "MRT" ? mrtRooms : ctRooms;
  const busy = new Set(patients.filter((p) => p.status === "cabinet").map((p) => p.room));
  return pool.find((k) => !busy.has(k)) || pool[0] || "r1";
}

/* time helpers for the scheduler */
const BK_SLOT_START = 8 * 60, BK_SLOT_END = 18 * 60, BK_SLOT_STEP = 30;
function bkToMin(t) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function bkFmt(min) { return String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0"); }
function bkSlots() { const out = []; for (let m = BK_SLOT_START; m < BK_SLOT_END; m += BK_SLOT_STEP) out.push(bkFmt(m)); return out; }

/* Mini calendar used inside the booking scheduler (sync-aware, working days Пн–Сб).
   Враховує ручний графік кабінетів: неробочі дні (свята/вихідні) та закриті
   кабінети недоступні для запису; дні з особливим графіком позначені. */
function BookingCalendar({ value, onPick, roomKey }) {
  const today = window.rfToday();
  const [viewMonth, setViewMonth] = useState(() => new Date(value.getFullYear(), value.getMonth(), 1));
  function shift(n) { setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1)); }
  const dow = window.RF_WEEKDAYS_SHORT || ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
  const y = viewMonth.getFullYear(), mo = viewMonth.getMonth();
  const first = new Date(y, mo, 1);
  const days = new Date(y, mo + 1, 0).getDate();
  const startIdx = window.rfDowMon ? window.rfDowMon(first) : ((first.getDay() + 6) % 7);
  const label = (window.RF_MONTHS_NOM ? window.RF_MONTHS_NOM[mo] : "") + " " + y;
  const cells = [];
  for (let i = 0; i < startIdx; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  return (
    <div className="bk-cal">
      <div className="cal-head">
        <span className="cal-month">{label}</span>
        <div className="cal-nav">
          <button className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shift(-1)} title="Попередній місяць">‹</button>
          <button className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shift(1)} title="Наступний місяць">›</button>
        </div>
      </div>
      <div className="cal-grid">
        {dow.map((d) => <div className="cal-dow" key={d}>{d}</div>)}
        {cells.map((d, i) => {
          if (d === null) return <div className="cal-day empty-day" key={"e" + i}></div>;
          const cd = new Date(y, mo, d);
          const isToday = window.rfSameDay(cd, today);
          const isSel = window.rfSameDay(cd, value);
          const isSunday = cd.getDay() === 0;
          const isPast = cd < today;
          // графік обраного кабінету на цю дату (свята/вихідні/закриті кабінети/інші години)
          const sched = window.rfRoomScheduleForDate ? window.rfRoomScheduleForDate(cd, roomKey) : { closed: isSunday, custom: false };
          const ovSt = window.rfDayOverrideStatus ? window.rfDayOverrideStatus(cd) : { kind: "none", label: "" };
          const disabled = isPast || sched.closed;
          const markClosed = sched.closed && !isPast;     // зачинено (свято/вихідний/закритий кабінет)
          const markCustom = !sched.closed && sched.custom; // особливі години роботи цього кабінету
          return (
            <button
              className={"cal-day" + (isToday ? " today" : "") + (isSel && !isToday ? " selected" : "") + (disabled ? " muted" : "") + (markClosed ? " holiday" : "") + (markCustom ? " custom" : "")}
              key={d} disabled={disabled} onClick={() => !disabled && onPick(cd)}
              title={ovSt.label || undefined}
            >
              {d}
              {!disabled && <span className="cdot"></span>}
              {(markClosed || markCustom) && <span className={"cal-sched " + (markClosed ? "closed" : "custom")}></span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* Дата народження → коротко ДД.ММ.РРРР */
function bkDobFmt(s) {
  if (!s) return "";
  const p = String(s).split("-");
  return p.length === 3 ? p[2] + "." + p[1] + "." + p[0] : s;
}
/* Маска ДД.ММ.РРРР з рядка будь-яких символів (лишаємо тільки цифри). */
function bkDobMask(raw) {
  const d = String(raw).replace(/\D/g, "").slice(0, 8);
  let out = d.slice(0, 2);
  if (d.length >= 3) out += "." + d.slice(2, 4);
  if (d.length >= 5) out += "." + d.slice(4, 8);
  return out;
}
/* Перевірка введеної вручну дати народження: коректний день/місяць, реальна дата,
   не в майбутньому (ще не народився) і не задавня (вік > 120 років). */
function bkParseDob(text) {
  const m = String(text).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return { ok: false, partial: true };
  const dd = +m[1], mm = +m[2], yyyy = +m[3];
  const today = window.rfToday();
  if (mm < 1 || mm > 12) return { ok: false, err: "Некоректний місяць" };
  if (dd < 1 || dd > 31) return { ok: false, err: "Некоректний день" };
  const dt = new Date(yyyy, mm - 1, dd);
  if (dt.getFullYear() !== yyyy || dt.getMonth() !== mm - 1 || dt.getDate() !== dd) return { ok: false, err: "Такої дати не існує" };
  if (dt > today) return { ok: false, err: "Дата в майбутньому — пацієнт ще не народився" };
  if (yyyy < today.getFullYear() - 120) return { ok: false, err: "Завелика дата — перевірте рік (вік > 120)" };
  return { ok: true, iso: yyyy + "-" + m[2] + "-" + m[1] };
}
/* Поле дати народження: ручне введення цифрами (з маскою й перевіркою) +
   розгортуваний календар у стилі проекту. Навігація місяці (‹ ›) / роки («  »);
   майбутні дати недоступні. */
function DobField({ value, onChange, invalid }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => bkDobFmt(value));
  const [err, setErr] = useState("");
  const today = window.rfToday();
  const base = value ? new Date(value + "T00:00:00") : new Date(today.getFullYear() - 30, today.getMonth(), 1);
  const [viewMonth, setViewMonth] = useState(() => new Date(base.getFullYear(), base.getMonth(), 1));
  const shift = (n) => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  const shiftYear = (n) => setViewMonth((m) => new Date(m.getFullYear() + n, m.getMonth(), 1));

  function onType(raw) {
    const masked = bkDobMask(raw);
    setText(masked);
    if (masked.length < 10) { setErr(""); onChange(""); return; }   // ще не повна дата
    const res = bkParseDob(masked);
    if (res.ok) { setErr(""); onChange(res.iso); const d = new Date(res.iso + "T00:00:00"); setViewMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }
    else { setErr(res.err || "Некоректна дата"); onChange(""); }
  }
  function openCal() {
    if (value) { const d = new Date(value + "T00:00:00"); setViewMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }
    setOpen((o) => !o);
  }
  const dow = window.RF_WEEKDAYS_SHORT || ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
  const y = viewMonth.getFullYear(), mo = viewMonth.getMonth();
  const first = new Date(y, mo, 1);
  const days = new Date(y, mo + 1, 0).getDate();
  const startIdx = window.rfDowMon ? window.rfDowMon(first) : ((first.getDay() + 6) % 7);
  const label = (window.RF_MONTHS_NOM ? window.RF_MONTHS_NOM[mo] : "") + " " + y;
  const sel = value ? new Date(value + "T00:00:00") : null;
  const cells = [];
  for (let i = 0; i < startIdx; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  function pick(d) {
    const cd = new Date(y, mo, d);
    const iso = cd.getFullYear() + "-" + String(cd.getMonth() + 1).padStart(2, "0") + "-" + String(cd.getDate()).padStart(2, "0");
    onChange(iso);
    setText(bkDobFmt(iso));
    setErr("");
    setOpen(false);
  }
  return (
    <div className="bk-dob">
      <div className="bk-dob-field">
        <input className={"inp bk-dob-input" + (err || invalid ? " bk-dob-inv" : "")} type="text" inputMode="numeric"
          placeholder="дд.мм.рррр" value={text} maxLength={10}
          onChange={(e) => onType(e.target.value)} />
        <button type="button" className={"bk-dob-ic-btn" + (open ? " open" : "")} onClick={openCal} title="Обрати в календарі">🗓</button>
      </div>
      {err && <span className="bk-dob-err">⚠ {err}</span>}
      {open && (
        <React.Fragment>
          <div className="bk-dob-backdrop" onClick={() => setOpen(false)}></div>
          <div className="bk-dob-pop">
            <div className="cal-head">
              <div className="cal-nav">
                <button type="button" className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shiftYear(-1)} title="Попередній рік">«</button>
                <button type="button" className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shift(-1)} title="Попередній місяць">‹</button>
              </div>
              <span className="cal-month">{label}</span>
              <div className="cal-nav">
                <button type="button" className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shift(1)} title="Наступний місяць">›</button>
                <button type="button" className="mini-icon" style={{ width: 24, height: 24 }} onClick={() => shiftYear(1)} title="Наступний рік">»</button>
              </div>
            </div>
            <div className="cal-grid">
              {dow.map((d) => <div className="cal-dow" key={d}>{d}</div>)}
              {cells.map((d, i) => {
                if (d === null) return <div className="cal-day empty-day" key={"e" + i}></div>;
                const cd = new Date(y, mo, d);
                const isSel = sel && window.rfSameDay(cd, sel);
                const isToday = window.rfSameDay(cd, today);
                const future = cd > today;
                return (
                  <button type="button" key={d} disabled={future}
                    className={"cal-day" + (isSel ? " selected" : "") + (isToday && !isSel ? " today" : "") + (future ? " muted" : "")}
                    onClick={() => !future && pick(d)}>{d}</button>
                );
              })}
            </div>
          </div>
        </React.Fragment>
      )}
    </div>
  );
}

function NewBookingModal({ patients, onClose, onSave }) {
  /* patient */
  const [name,   setName]   = useState("");
  const [dob,    setDob]    = useState("");
  const [gender, setGender] = useState("");
  const [weight, setWeight] = useState("");
  const [phone,  setPhone]  = useState("");
  const [email,  setEmail]  = useState("");
  /* study */
  const [studyType, setStudyType] = useState("MRT");
  const [region,    setRegion]    = useState("");
  const [contrast,  setContrast]  = useState(false);   // чекбокс: false = без контрасту (за замовч.)
  /* contra + notes */
  const [hasContra, setHasContra] = useState(false);   // чекбокс: false = протипоказань немає (за замовч.)
  const [notes,     setNotes]     = useState("");
  /* referring doctor (К-07): вибір + inline-додавання, не виходячи з форми */
  const [docs,     setDocs]     = useState(() => (window.RF_DOCTORS || []).slice());
  const [doctorId, setDoctorId] = useState("");
  const [addDoc,   setAddDoc]   = useState(false);
  /* scheduler */
  const roomsOfType = (t) => Object.keys(window.RF_ROOMS).filter((k) => window.RF_ROOMS[k].kind === (t === "MRT" ? "МРТ" : "КТ"));
  const [room, setRoom] = useState(() => roomsOfType("MRT")[0]);
  const [bookDate, setBookDate] = useState(() => window.rfToday());
  const [time, setTime] = useState("");

  /* з контрастом → лише дослідження, які можна виконати з контрастом;
     без галочки → усі за типом/моделлю обладнання. */
  const allRegions = studyType === "MRT" ? MRT_REGIONS : CT_REGIONS;
  const regions = contrast ? allRegions.filter((r) => r.contrast) : allRegions;

  function changeType(t) {
    setStudyType(t);
    setRegion("");
    setContrast(false);
    setRoom(roomsOfType(t)[0]);
    setTime("");
    // один запис = один кабінет = одна модальність: додаткові дослідження теж переводимо на новий тип
    const k = t === "MRT" ? "МРТ" : "КТ";
    setExtraStudies((a) => a.map((s) => s.type === k ? s : { ...s, type: k, region: "", dur: exDur(k, "") }));
  }
  /* перемикання чекбокса: якщо обрана область недоступна з контрастом — скидаємо її */
  function toggleContrast(v) {
    setContrast(v);
    if (v && region && !allRegions.some((r) => r.label === region && r.contrast)) { setRegion(""); setTime(""); }
  }

  function calcAge(d) {
    if (!d) return 0;
    return Math.floor((Date.now() - new Date(d).getTime()) / (365.25 * 24 * 3600 * 1000));
  }

  const contrastSuffix = contrast ? " з контрастом" : "";
  const procLabel = region
    ? `${studyType === "MRT" ? "МРТ" : "КТ"} · ${region}${contrastSuffix}`
    : (studyType === "MRT" ? "МРТ" : "КТ");

  const regionObj = regions.find((r) => r.label === region);
  const computedDur = regionObj ? regionObj.dur + (contrast ? 15 : 0) : (studyType === "MRT" ? 45 : 20);
  /* К-07: ціна обраного дослідження — показуємо одразу у формі (без виходу в Прайс). */
  const price = regionObj ? regionObj.price + (contrast ? CONTRAST_SURCHARGE : 0) : null;
  const fmtPrice = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₴";
  /* «Час дослідження» = тривалість (хв): автозаповнюється з області, редагується вручну */
  const [durEdit, setDurEdit] = useState("");
  useEffect(() => { if (region) setDurEdit(String(computedDur)); }, [region, contrast, studyType]);
  const dur = Math.max(5, parseInt(durEdit, 10) || computedDur);
  const durCustom = region && parseInt(durEdit, 10) && parseInt(durEdit, 10) !== computedDur;

  /* Кілька досліджень в одному записі: основне (вище) + додаткові (нижче).
     Кожне: Тип + Область + Тривалість (редагується). Слот = сумарна тривалість. */
  const [extraStudies, setExtraStudies] = useState([]);
  // КТ і МРТ — різні кабінети/апарати: додаткові дослідження мусять збігатися з модальністю основного
  const primaryKind = studyType === "MRT" ? "МРТ" : "КТ";
  const exRegions = (t) => (window.rfRegionsFor ? window.rfRegionsFor(t) : []);
  const exDur = (t, reg) => { const o = exRegions(t).find((r) => r.label === reg); return o ? o.dur : (t === "КТ" ? 20 : 45); };
  const exPatch = (i, p) => setExtraStudies((a) => a.map((r, idx) => idx === i ? { ...r, ...p } : r));
  const exSetType = (i, t) => exPatch(i, { type: t, region: "", dur: exDur(t, "") });
  const exSetRegion = (i, reg) => { const r = extraStudies[i]; exPatch(i, { region: reg, dur: exDur(r.type, reg) }); };
  const exSetDur = (i, v) => exPatch(i, { dur: Math.max(5, parseInt(v, 10) || 0) });
  const exAdd = () => setExtraStudies((a) => [...a, { type: primaryKind, region: "", dur: exDur(primaryKind, "") }]);
  const exRemove = (i) => setExtraStudies((a) => a.filter((_, idx) => idx !== i));
  const validExtra = extraStudies.filter((s) => s.region);

  const primaryStudy = region ? { type: studyType === "MRT" ? "МРТ" : "КТ", region, contrast: contrast === true, dur } : null;
  const allStudies = (primaryStudy ? [primaryStudy] : []).concat(validExtra.map((s) => ({ type: s.type, region: s.region, dur: parseInt(s.dur, 10) || 0 })));
  const combinedLabel = allStudies.length ? allStudies.map((s) => window.rfStudyLabel(s)).join(" + ") : procLabel;
  const slotDur = dur + validExtra.reduce((s, x) => s + (parseInt(x.dur, 10) || 0), 0);

  /* ── slot availability — synced with the queue for the chosen date + cabinet ── */
  const isBookToday = window.rfSameDay(bookDate, window.rfToday());
  const dayList = isBookToday
    ? patients
    : (window.getDayPatients ? window.getDayPatients(bookDate) : []);
  const roomBusy = dayList
    .filter((p) => p.room === room && p.status !== "noshow")
    .map((p) => ({ s: bkToMin(p.time), e: bkToMin(p.time) + (p.dur || 30), name: p.name }));
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();

  /* Ручний графік обраного кабінету на дату — свята / вихідні / інші години.
     Якщо кабінет зачинено або слот поза робочими годинами — записати не можна. */
  const roomSched = window.rfRoomScheduleForDate
    ? window.rfRoomScheduleForDate(bookDate, room)
    : { closed: false, start: bkFmt(BK_SLOT_START), end: bkFmt(BK_SLOT_END), custom: false };
  const roomClosed = !!roomSched.closed;
  const schedStart = roomSched.start || bkFmt(BK_SLOT_START);
  const schedEnd = roomSched.end || bkFmt(BK_SLOT_END);
  const schedEndMin = bkToMin(schedEnd);
  const ovStatus = window.rfDayOverrideStatus ? window.rfDayOverrideStatus(bookDate) : { kind: "none", label: "" };

  /* Стан слота:
       closed   — кабінет не працює цього дня (свято/вихідний/закритий кабінет);
       offhours — слот поза робочими годинами кабінету (особливий графік);
       past     — час минув (для сьогодні);
       busy     — початок слота потрапляє в наявний запис (кабінет зайнято);
       tight    — старт вільний, але блок тривалості перетне запис/кінець робочого дня;
       free     — повністю вільно під обрану тривалість. */
  function slotState(slot) {
    const s = bkToMin(slot), e = s + slotDur;
    if (roomClosed) return "closed";
    if (slot < schedStart || s >= schedEndMin) return "offhours";
    if (e > schedEndMin) return "tight";                    // блок виходить за межі робочого дня
    if (isBookToday && s < nowMin) return "past";
    if (roomBusy.some((b) => s >= b.s && s < b.e)) return "busy";
    if (roomBusy.some((b) => s < b.e && b.s < e)) return "tight";
    return "free";
  }
  /* найближчий запис після старту слота — щоб пояснити «не вміщується» */
  function nextApptAfter(slot) {
    const s = bkToMin(slot);
    const after = roomBusy.filter((b) => b.s >= s).sort((a, b) => a.s - b.s)[0];
    return after ? bkFmt(after.s) : null;
  }
  const slots = bkSlots();
  const freeCount = slots.filter((s) => slotState(s) === "free").length;
  const busyList = roomBusy.slice().sort((a, b) => a.s - b.s);

  /* конфлікт для вручну введеного часу: перекриття з чергою цього кабінету */
  const timeConflict = (() => {
    if (!time) return false;
    const s = bkToMin(time), e = s + slotDur;
    return roomBusy.some((b) => s < b.e && b.s < e);
  })();

  /* Конкретний перелік незаповнених обов'язкових полів — щоб підказати, чого саме бракує */
  const miss = {
    name: !name.trim(), dob: !dob, gender: !gender, phone: !phone.trim(),
    region: !region, time: !time,
  };
  const MISS_LABELS = { name: "ПІБ", dob: "Дата народження", gender: "Стать", phone: "Телефон", region: "Область дослідження", time: "Слот часу" };
  const missingList = Object.keys(MISS_LABELS).filter((k) => miss[k]).map((k) => MISS_LABELS[k]);
  // не можна зберегти, якщо обраний слот перетинає запис, кабінет зачинено або слот поза графіком
  const timeBadBySched = time ? (slotState(time) !== "free") : false;
  const valid = missingList.length === 0 && room && !timeConflict && !roomClosed && !timeBadBySched;

  function handleSave() {
    if (!valid) return;
    onSave({
      name: name.trim(),
      phone,
      email: email.trim() || undefined,
      age: calcAge(dob),
      weight: weight ? +weight : null,
      gender,
      proc: combinedLabel,
      dur: slotDur,
      studies: allStudies,
      room,
      date: bookDate,
      time,
      notes: notes.trim() || undefined,
      hasContra,
      doctor: (docs.find((d) => String(d.id) === String(doctorId)) || {}).name || undefined,
    });
  }

  const roomKeys = roomsOfType(studyType);

  return (
    <div className="overlay">
      <div className="dialog fade-in bk-dialog">
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic">＋</span>Новий запис</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="bk-grid">

          {/* ════ ЛІВА КОЛОНКА — Пацієнт + Дослідження ════ */}
          <div className="bk-col bk-col-left">

            <div className="bk-section-label">Пацієнт</div>

            <label className="fld">
              <span className={"fld-lab" + (miss.name ? " bk-miss-lab" : "")}>ПІБ *</span>
              <input className="inp" placeholder="Прізвище Ім'я По батькові" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </label>

            <div className="fld-row">
              <div className="fld" style={{ flex: "0 0 150px" }}>
                <span className={"fld-lab" + (miss.dob ? " bk-miss-lab" : "")}>Дата народження *</span>
                <DobField value={dob} onChange={setDob} invalid={miss.dob} />
              </div>
              <div className="fld" style={{ flex: "0 0 auto" }}>
                <span className={"fld-lab" + (miss.gender ? " bk-miss-lab" : "")}>Стать *</span>
                <div className="bk-gender-row">
                  <button className={"bk-gender-btn" + (gender === "М" ? " active" : "")} onClick={() => setGender("М")} title="Чоловіча">♂</button>
                  <button className={"bk-gender-btn" + (gender === "Ж" ? " active" : "")} onClick={() => setGender("Ж")} title="Жіноча">♀</button>
                </div>
              </div>
              <div className="fld" style={{ flex: "0 0 52px" }}>
                <span className="fld-lab">Вік</span>
                <div className="inp bk-age" title="Розраховано з дати народження">{dob ? calcAge(dob) : "—"}</div>
              </div>
              <label className="fld" style={{ flex: "0 0 60px" }}>
                <span className="fld-lab">Вага</span>
                <input className="inp" placeholder="кг" value={weight} onChange={(e) => setWeight(e.target.value.replace(/\D/g, ""))} />
              </label>
            </div>

            <div className="fld-row">
              <label className="fld">
                <span className={"fld-lab" + (miss.phone ? " bk-miss-lab" : "")}>Телефон *</span>
                <input className="inp" type="tel" placeholder="+38 0__ ___ __ __" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </label>
              <label className="fld">
                <span className="fld-lab">Email</span>
                <input className="inp" type="email" placeholder="patient@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
            </div>

            <div className="bk-section-label">Дослідження</div>

            <div className="fld-row" style={{ alignItems: "flex-end" }}>
              <div className="fld" style={{ flex: "0 0 130px" }}>
                <span className="fld-lab">Тип *</span>
                <div className="bk-seg">
                  <button className={"bk-seg-btn" + (studyType === "MRT" ? " active mrt" : "")} onClick={() => changeType("MRT")}>МРТ</button>
                  <button className={"bk-seg-btn" + (studyType === "CT"  ? " active ct"  : "")} onClick={() => changeType("CT")}>КТ</button>
                </div>
              </div>
              <div className="fld">
                <span className="fld-lab">Параметри</span>
                <div className="bk-check-row">
                  <label className={"rf-check" + (contrast ? " on" : "")}>
                    <input type="checkbox" checked={contrast} onChange={(e) => toggleContrast(e.target.checked)} />
                    <span className="rf-box"></span><span>Контраст</span>
                  </label>
                  <label className={"rf-check" + (hasContra ? " warn" : "")}>
                    <input type="checkbox" checked={hasContra} onChange={(e) => setHasContra(e.target.checked)} />
                    <span className="rf-box"></span><span>Протипоказання</span>
                  </label>
                </div>
              </div>
            </div>

            <div className="fld-row" style={{ alignItems: "flex-start" }}>
              <label className="fld" style={{ flex: "1 1 auto" }}>
                <span className={"fld-lab" + (miss.region ? " bk-miss-lab" : "")}>Область дослідження *</span>
                <select className="inp" value={region} onChange={(e) => setRegion(e.target.value)}>
                  <option value="">— Оберіть область —</option>
                  {regions.map((r) => (
                    <option key={r.label} value={r.label}>{r.label}{contrastSuffix} · {r.dur + (contrast ? 15 : 0)} хв</option>
                  ))}
                </select>
              </label>
              <label className="fld" style={{ flex: "0 0 108px" }}>
                <span className="fld-lab">Тривалість *</span>
                <div className="bk-dur-row">
                  <input className="inp bk-dur-input" type="number" min="5" step="5" placeholder="—"
                    value={durEdit} onChange={(e) => setDurEdit(e.target.value.replace(/\D/g, ""))} disabled={!region} />
                  <span className="bk-dur-unit">хв</span>
                </div>
                <span className={"bk-time-state " + (durCustom ? "busy" : "none")}>
                  {!region ? "оберіть область" : durCustom ? `↺ за замовч. ${computedDur} хв` : "за тривалістю області"}
                </span>
              </label>
            </div>

            {/* Додаткові дослідження — компактна таблиця (Тип · Область · Трив.) */}
            <div className="fld">
              {extraStudies.length > 0 && (
                <div className="bk-study-table">
                  <div className="bk-study-head">
                    <span>Тип</span><span>Область дослідження</span><span>Трив.</span><span></span>
                  </div>
                  {extraStudies.map((r, i) => {
                    const regs = exRegions(r.type);
                    return (
                      <div className="bk-study-row" key={i}>
                        <div className="bk-seg bk-seg-sm st-seg-locked" title="Тип = тип основного дослідження (один кабінет, одна модальність)">
                          <button className={"bk-seg-btn active " + (primaryKind === "МРТ" ? "mrt" : "ct")} disabled aria-disabled="true">{primaryKind}</button>
                        </div>
                        <select className="inp" value={r.region} onChange={(e) => exSetRegion(i, e.target.value)}>
                          <option value="">— Оберіть область —</option>
                          {regs.map((x) => <option key={x.label} value={x.label}>{x.label} · {x.dur} хв</option>)}
                        </select>
                        <div className="bk-study-dur"><input className="inp" type="number" min="5" step="5" value={r.dur} onChange={(e) => exSetDur(i, e.target.value)} /><span className="st-dur-u">хв</span></div>
                        <button className="st-row-del" title="Прибрати" onClick={() => exRemove(i)}>✕</button>
                      </div>
                    );
                  })}
                </div>
              )}
              <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: extraStudies.length > 0 ? 8 : 0 }} onClick={exAdd}>＋ Додати дослідження</button>
            </div>

            <label className="fld">
              <span className="fld-lab">Лікар-направник</span>
              <select className="inp" value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
                <option value="">— Без направлення / самозвернення —</option>
                {docs.map((d) => <option key={d.id} value={d.id}>{d.name}{d.spec ? " · " + d.spec : ""}</option>)}
              </select>
            </label>

            <label className="fld" style={{ flex: 1 }}>
              <span className="fld-lab">Примітки</span>
              <textarea className="inp bk-notes" placeholder="Додаткова інформація про пацієнта, скеровання, особливі вимоги до дослідження…" value={notes} onChange={(e) => setNotes(e.target.value)}></textarea>
            </label>
          </div>

          {/* ════ ПРАВА КОЛОНКА — Smart Scheduler ════ */}
          <div className="bk-col bk-col-right">
            <div className="bk-sched-head">
              <span className="bk-sched-spark">✦</span>
              <span className="bk-sched-title">Smart Scheduler</span>
              <span className="bk-sched-sync"><span className="pulse-dot" style={{ background: "var(--green)", width: 6, height: 6 }}></span> синхр. з чергою</span>
            </div>

            {/* Cabinet selection */}
            <div className="fld">
              <span className="fld-lab">Кабінет ({studyType === "MRT" ? "МРТ" : "КТ"})</span>
              <div className="bk-room-chips">
                {roomKeys.map((k) => {
                  const r = window.RF_ROOMS[k];
                  const num = (r.name.match(/№?\s*(\d+)/) || [])[1] || r.name;
                  const rClosed = window.rfRoomScheduleForDate ? window.rfRoomScheduleForDate(bookDate, k).closed : false;
                  return (
                    <button key={k} className={"bk-room-chip" + (room === k ? " active" : "") + (studyType === "MRT" ? " mrt" : " ct") + (rClosed ? " closed" : "")} onClick={() => { setRoom(k); setTime(""); }} title={r.name + " · " + r.model + (rClosed ? " · зачинено " + window.rfFmtShort(bookDate) : "")}>
                      №{num}{rClosed && <span className="bk-room-closed-dot" aria-hidden></span>}
                    </button>
                  );
                })}
              </div>
              <span className="bk-room-model-line">{window.RF_ROOMS[room].model}</span>
            </div>

            {/* Calendar */}
            <BookingCalendar value={bookDate} onPick={(d) => { setBookDate(d); setTime(""); }} roomKey={room} />

            {/* Available slots */}
            <div className="fld">
              <div className="bk-slots-head">
                <span className={"fld-lab" + (miss.time ? " bk-miss-lab" : "")} style={{ margin: 0 }}>Вільні слоти · {window.rfFmtShort(bookDate)} {miss.time ? "— оберіть час *" : ""}</span>
                <span className="bk-free-count">блок {slotDur} хв{allStudies.length > 1 ? ` (${allStudies.length} досл.)` : ""} · {freeCount} вільних</span>
              </div>
              {roomClosed && (
                <div className="ctx-hint red" style={{ marginBottom: 10 }}>🚫 {window.RF_ROOMS[room].name} не працює {window.rfFmtShort(bookDate)}{ovStatus.label ? " · " + ovStatus.label : ""}. Оберіть інший день або кабінет.</div>
              )}
              {!roomClosed && roomSched.custom && (
                <div className="ctx-hint blue" style={{ marginBottom: 10 }}>🕐 Особливий графік {window.rfFmtShort(bookDate)}: {schedStart}–{schedEnd}.</div>
              )}
              <div className={"bk-slot-grid" + (miss.time ? " bk-miss-slots" : "")}>
                {slots.map((s) => {
                  const st = slotState(s);
                  const title = st === "closed" ? "Кабінет не працює цього дня"
                    : st === "offhours" ? `Поза годинами роботи (${schedStart}–${schedEnd})`
                    : st === "busy" ? "Зайнято"
                    : st === "tight" ? `Не вміщується: блок ${slotDur} хв перетне ${nextApptAfter(s) ? "запис о " + nextApptAfter(s) : "кінець робочого дня (" + schedEnd + ")"}`
                    : st === "past" ? "Час минув"
                    : `Вільно · ${s}–${bkFmt(bkToMin(s) + slotDur)}`;
                  return (
                    <button key={s} className={"slot" + (time === s ? " sel" : "") + (st !== "free" ? " taken" : "") + (st === "tight" ? " tight" : "") + (st === "busy" ? " busy" : "")}
                      disabled={st !== "free"} onClick={() => setTime(s)} title={title}>{s}</button>
                  );
                })}
              </div>
              {busyList.length > 0 && (
                <div className="bk-busy-list">
                  <span className="bk-busy-lab">Зайнятий час ({window.RF_ROOMS[room].name}):</span>
                  {busyList.map((b, i) => <span className="bk-busy-chip" key={i}>{bkFmt(b.s)}–{bkFmt(b.e)}</span>)}
                </div>
              )}
              <div className="bk-slot-legend">
                <span><span className="lg-dot free"></span>вільно</span>
                <span><span className="lg-dot tight"></span>не вміщується</span>
                <span><span className="lg-dot busy"></span>зайнято</span>
              </div>
              {time && (() => {
                const s = bkToMin(time), e = s + slotDur;
                const conflict = roomBusy.find((b) => s < b.e && b.s < e);
                const next = roomBusy.filter((b) => b.s >= e).sort((a, b) => a.s - b.s)[0];
                const fmtGap = (m) => { const h = Math.floor(m / 60), mm = m % 60; return (h ? h + " год " : "") + (mm ? mm + " хв" : (h ? "" : "0 хв")); };
                return (
                  <div className={"bk-slot-confirm " + (conflict ? "bad" : "ok")}>
                    {conflict
                      ? <>⚠ Перетин із записом {bkFmt(conflict.s)}–{bkFmt(conflict.e)} — оберіть інший слот</>
                      : <>✓ Слот вільний, накладок немає. Запис: <b>{time}–{bkFmt(e)}</b> ({slotDur} хв).{next ? <> Далі кабінет вільний до наступного запису о <b>{bkFmt(next.s)}</b> — запас {fmtGap(next.s - e)}.</> : <> Далі до кінця дня вільно.</>}</>}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>

        <div className="dlg-foot">
          {valid
            ? <span className="bk-summary">{name.split(" ").slice(0, 2).join(" ")} · {allStudies.length > 1 ? allStudies.length + " досл." : (studyType === "MRT" ? "МРТ" : "КТ")} · {window.RF_ROOMS[room].name} · {window.rfFmtShort(bookDate)} {time}–{bkFmt(bkToMin(time) + slotDur)}</span>
            : <span className="bk-missing">{missingList.map((m, i) => <span className="bk-miss-chip" key={i}>{m}</span>)}</span>}
          <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
          <button className="btn btn-primary" disabled={!valid} onClick={handleSave}>Зберегти запис</button>
        </div>
      </div>
      {/* К-07: додати лікаря-направника поверх форми запису і одразу обрати його */}
      {addDoc && <AddDoctorModal onClose={() => setAddDoc(false)} onSave={(d) => {
        const nd = { id: Date.now(), name: d.name, spec: d.spec, clinic: d.clinic, phone: d.phone, refs: 0 };
        setDocs((arr) => [...arr, nd]);
        setDoctorId(String(nd.id));
        setAddDoc(false);
      }} />}
    </div>
  );
}

/* ---------- Procedure completion modal — ADMIN-PROC-01 ---------- */
const FAIL_REASONS = [
  { group: "Стан пацієнта", items: ["Клаустрофобія", "Несумісний імплант", "Кардіостимулятор", "Не готовий", "Погано почувається", "Відмовився"] },
  { group: "Технічні причини", items: ["Поломка обладнання", "Апарат потребує ТО"] },
  { group: "Інше", items: ["Інше"] },
];

function CompletionModal({ patient, enteredAt, onClose, onSuccess, onFail, onReschedule }) {
  const [result, setResult] = useState("success");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const room = window.RF_ROOMS[patient.room];
  const canConfirm = result === "success" || (result === "failed" && reason);

  const techHint = reason === "Поломка обладнання" || reason === "Апарат потребує ТО";
  const callHint = reason === "Не готовий" || reason === "Відмовився" || reason === "Погано почувається";

  function confirm() {
    if (result === "success") onSuccess(patient, notes);
    else onFail(patient, reason, notes);
  }

  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 540 }}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--green-bg)", color: "var(--green)" }}>✓</span>Завершення процедури</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dlg-body">
          {/* patient card */}
          <div className="pc-card">
            <div className="pc-top">
              <div className="pc-name">{patient.name}</div>
              <LiveTimer enteredAt={enteredAt}>{(sec) => (
                <span className="badge blue tabular" style={{ flexShrink: 0 }}>
                  <span aria-hidden>▷</span> В кабінеті: {fmtTimer(sec)}
                </span>
              )}</LiveTimer>
            </div>
            <div className="pc-proc">{patient.proc} · {patient.dur} хв</div>
            <div className="pc-meta">
              <span><b>Час:</b> {patient.time}</span>
              <span><b>Кабінет:</b> {room.name} — {room.model}</span>
              <span><b>Вік:</b> {patient.age} р.</span>
            </div>
          </div>

          {/* result selection */}
          <div className="res-group">
            <button className={"res-opt" + (result === "success" ? " sel green" : "")} onClick={() => setResult("success")}>
              <span className="res-ic" style={{ background: "var(--green-bg)" }}>✅</span>
              <span className="res-txt">
                <span className="res-title">Успішно завершено</span>
                <span className="res-sub">Дослідження проведено повністю. Статус → «Виконано».</span>
              </span>
              <span className={"res-radio" + (result === "success" ? " on green" : "")}></span>
            </button>
            <button className={"res-opt" + (result === "failed" ? " sel red" : "")} onClick={() => setResult("failed")}>
              <span className="res-ic" style={{ background: "var(--red-bg)" }}>❌</span>
              <span className="res-txt">
                <span className="res-title">Не відбулось</span>
                <span className="res-sub">Дослідження не проведено. Слот буде звільнено.</span>
              </span>
              <span className={"res-radio" + (result === "failed" ? " on red" : "")}></span>
            </button>
          </div>

          {/* failure reason */}
          {result === "failed" && (
            <div className="fade-in" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="dlg-divider"></div>
              <label className="fld">
                <span className="fld-lab">Причина (обов'язково) *</span>
                <select className="inp" value={reason} onChange={(e) => setReason(e.target.value)}>
                  <option value="">— Оберіть причину —</option>
                  {FAIL_REASONS.map((g) => (
                    <optgroup key={g.group} label={g.group}>
                      {g.items.map((it) => <option key={it} value={it}>{it}</option>)}
                    </optgroup>
                  ))}
                </select>
              </label>
              {techHint && (
                <div className="ctx-hint red">⚠ Причина — несправність обладнання. <a href="radflow-incidents.html">Заблокувати апарат →</a></div>
              )}
              {callHint && (
                <div className="ctx-hint blue">↩ Пацієнт не пройшов дослідження — перезапишіть його прямо тут кнопкою «🗓 Перезаписати пацієнта» нижче, не виходячи з вікна.</div>
              )}
            </div>
          )}

          <label className="fld">
            <span className="fld-lab">Нотатка</span>
            <textarea className="inp" rows={2} placeholder="Додатковий коментар (необов'язково)…" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ resize: "vertical" }}></textarea>
          </label>

          <div className="hint-blue">⚡ <b>Realtime:</b> статус миттєво оновиться для ролей Адмін · Радіолог · CEO · Лікар через Supabase Realtime WebSocket.</div>
        </div>
        <div className="dlg-foot">
          <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
          {result === "failed" && onReschedule && (
            <button className="btn btn-primary" disabled={!reason} title={reason ? "Зафіксувати збій і одразу перенести на новий слот" : "Спершу оберіть причину"}
              onClick={() => onReschedule(patient, reason, notes)}>🗓 Перезаписати пацієнта</button>
          )}
          <button className={"btn " + (result === "success" ? "btn-green" : "btn-danger")} disabled={!canConfirm} onClick={confirm}>
            {result === "success" ? "✓ Підтвердити — Виконано" : "Зафіксувати — Не відбулось"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Add referring doctor modal ---------- */
function AddDoctorModal({ onClose, onSave }) {
  const [name, setName] = useState("");
  const [spec, setSpec] = useState("");
  const [clinic, setClinic] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const existing = (window.RF_DOCTORS || []);
  const specs = ["Невролог", "Ортопед-травматолог", "Онколог", "Терапевт", "Кардіолог", "Нейрохірург", "Ревматолог", "Інша спеціальність"];
  const valid = name.trim() && phone.trim();

  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 540 }}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--green-bg)", color: "var(--green)" }}>🩺</span>Додати лікаря-направляча</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dlg-body">
          <div className="hint-blue">Лікарі-направлячі прив'язуються до записів пацієнтів — це дозволяє формувати звіти за джерелами направлень.</div>
          <label className="fld">
            <span className="fld-lab">ПІБ лікаря *</span>
            <input className="inp" placeholder="Прізвище Ім'я По батькові" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <div className="fld-row">
            <label className="fld">
              <span className="fld-lab">Спеціальність</span>
              <select className="inp" value={spec} onChange={(e) => setSpec(e.target.value)}>
                <option value="">— Оберіть —</option>
                {specs.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="fld">
              <span className="fld-lab">Телефон *</span>
              <input className="inp" placeholder="+38 0__ ___ __ __" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </label>
          </div>
          <div className="fld-row">
            <label className="fld">
              <span className="fld-lab">Клініка / заклад</span>
              <input className="inp" placeholder="Назва закладу" value={clinic} onChange={(e) => setClinic(e.target.value)} />
            </label>
            <label className="fld">
              <span className="fld-lab">Email</span>
              <input className="inp" placeholder="doctor@clinic.ua" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
          </div>

          {existing.length > 0 && (
            <div className="fld">
              <span className="fld-lab">Вже у базі ({existing.length})</span>
              <div className="doc-list">
                {existing.map((d) => (
                  <div className="doc-row" key={d.id}>
                    <span className="doc-av">{d.name.split(" ").map((w) => w[0]).slice(0, 2).join("")}</span>
                    <span className="doc-meta">
                      <span className="doc-name">{d.name}</span>
                      <span className="doc-sub">{d.spec} · {d.clinic}</span>
                    </span>
                    <span className="doc-refs">{d.refs} напр.</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="dlg-foot">
          <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
          <button className="btn btn-primary" disabled={!valid} onClick={() => onSave({ name: name.trim(), spec, clinic, phone, email })}>Додати лікаря</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Breakdown / Maintenance modal — Поломка / ТО ----------
   Виправляє Проблему 2: замість одного «німого» кліку — діалог із вибором
   апарата, причини (поломка/ТО) і тривалості простою. Саме тривалість
   визначає вікно, у якому рахуються постраждалі пацієнти. */
const RF_DAY_END_MIN = 17 * 60 + 30; // 17:30 — кінець робочого дня

function rfNowMinClamped() {
  const now = new Date();
  let m = now.getHours() * 60 + now.getMinutes();
  m = Math.round(m / 5) * 5;            // округлення до 5 хв
  if (m < 8 * 60) m = 8 * 60;           // не раніше 08:00
  if (m > RF_DAY_END_MIN) m = RF_DAY_END_MIN;
  return m;
}
function rfDateInputVal(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function BreakdownModal({ existing, onClose, onConfirm }) {
  const rooms = window.RF_ROOMS;
  const roomKeys = Object.keys(rooms);
  const ed = existing || null;
  const [roomKey, setRoomKey] = useState(ed ? ed.roomKey : roomKeys[0]);
  const [reason, setReason] = useState(ed ? ed.reason : "breakdown");   // 'breakdown' | 'maintenance'
  const [durKey, setDurKey] = useState(ed ? ed.durKey : "");
  const [startTime, setStartTime] = useState(ed ? ed.fromLabel : window.rfMinToTime(rfNowMinClamped()));
  const [restoreDate, setRestoreDate] = useState(ed && ed.restoreDate ? ed.restoreDate : rfDateInputVal(window.rfAddDays(window.rfToday(), 1)));

  const reasonLabel = reason === "maintenance" ? "Планове ТО" : "Поломка обладнання";
  const fromMin = window.rfTimeToMin(startTime);
  const minRestore = rfDateInputVal(window.rfAddDays(window.rfToday(), 1));

  const DURATIONS = [
    { k: "1h", label: "1 година" }, { k: "2h", label: "2 години" }, { k: "4h", label: "4 години" },
    { k: "eod", label: "До кінця дня" }, { k: "restore", label: "До відновлення" },
  ];

  // Повний інцидент (постраждалі сьогодні + майбутні дні для «До відновлення»).
  const inc = useMemo(
    () => (durKey ? window.rfBuildIncident(roomKey, reason, reasonLabel, fromMin, durKey, restoreDate) : null),
    [roomKey, reason, durKey, fromMin, restoreDate]
  );
  const affected = inc ? inc.patients : [];
  const todayCount = affected.filter((p) => p.isToday).length;
  const futureCount = affected.length - todayCount;
  const valid = roomKey && reason && durKey && (durKey !== "restore" || restoreDate);

  function confirm() {
    let built = window.rfBuildIncident(roomKey, reason, reasonLabel, fromMin, durKey, restoreDate);
    if (ed) built = window.rfMergeIncidentStatuses(built, ed);
    onConfirm(built);
  }

  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 600 }}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--red-bg)", color: "var(--red)" }}>🔧</span>{ed ? "Редагувати інцидент" : "Поломка / Технічне обслуговування"}</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dlg-body">
          <div className="ctx-hint red" style={{ fontSize: 13 }}>⚠ Блокування призупиняє нові записи на апарат і автоматично формує колл-лист пацієнтів, чиї записи потрапляють у вікно простою.</div>

          {/* Апарат */}
          <div className="fld">
            <span className="fld-lab">Який апарат? *</span>
            <div className="bd-rooms">
              {roomKeys.map((k) => {
                const r = rooms[k];
                const mrt = r.kind === "МРТ";
                return (
                  <button key={k} className={"bd-room" + (roomKey === k ? " active" : "")} onClick={() => setRoomKey(k)} title={r.name + " · " + r.model}>
                    <span className={"bd-room-kind " + (mrt ? "mrt" : "ct")}>{r.kind}</span>
                    <span className="bd-room-meta">
                      <span className="bd-room-name">{r.name}</span>
                      <span className="bd-room-model">{r.model}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Причина */}
          <div className="fld">
            <span className="fld-lab">Причина *</span>
            <div className="res-group" style={{ flexDirection: "row", gap: 10 }}>
              <button className={"res-opt" + (reason === "breakdown" ? " sel red" : "")} onClick={() => setReason("breakdown")} style={{ flex: 1 }}>
                <span className="res-ic" style={{ background: "var(--red-bg)" }}>🔧</span>
                <span className="res-txt"><span className="res-title">Поломка обладнання</span><span className="res-sub">Несправність — потрібен ремонт</span></span>
                <span className={"res-radio" + (reason === "breakdown" ? " on red" : "")}></span>
              </button>
              <button className={"res-opt" + (reason === "maintenance" ? " sel red" : "")} onClick={() => setReason("maintenance")} style={{ flex: 1 }}>
                <span className="res-ic" style={{ background: "var(--orange-bg)" }}>⚙️</span>
                <span className="res-txt"><span className="res-title">Планове ТО</span><span className="res-sub">Технічне обслуговування</span></span>
                <span className={"res-radio" + (reason === "maintenance" ? " on red" : "")}></span>
              </button>
            </div>
          </div>

          {/* Початок + тривалість */}
          <div className="fld-row">
            <label className="fld" style={{ maxWidth: 160 }}>
              <span className="fld-lab">Початок простою</span>
              <input className="inp tabular" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </label>
            <div className="fld">
              <span className="fld-lab">Тривалість простою *</span>
              <div className="bd-durs">
                {DURATIONS.map((d) => (
                  <button key={d.k} className={"bd-chip" + (durKey === d.k ? " active" : "")} onClick={() => setDurKey(d.k)}>{d.label}</button>
                ))}
              </div>
            </div>
          </div>

          {/* Дата відновлення — лише для «До відновлення» */}
          {durKey === "restore" && (
            <label className="fld">
              <span className="fld-lab">Очікувана дата відновлення * <span style={{ color: "var(--text-faint)", fontWeight: 400 }}>— записи наперед до цієї дати теж підуть на обдзвін</span></span>
              <input className="inp tabular" type="date" min={minRestore} value={restoreDate} onChange={(e) => setRestoreDate(e.target.value)} style={{ maxWidth: 200 }} />
            </label>
          )}

          {/* Жива превʼю постраждалих */}
          <div className="fld">
            <span className="fld-lab">
              {durKey
                ? (durKey === "restore"
                    ? <>На обдзвін: {todayCount} сьогодні{futureCount ? <> + {futureCount} наперед</> : null} = {affected.length}</>
                    : inc.openEnded
                      ? <>Постраждалі записи на апараті — усі незавершені ({affected.length})</>
                      : <>Постраждалі записи у вікні {inc.fromLabel}–{inc.toLabel} ({affected.length})</>)
                : <>Оберіть тривалість, щоб побачити постраждалих пацієнтів</>}
            </span>
            {durKey && (
              affected.length === 0 ? (
                <div className="bd-aff-empty">✓ Немає активних записів на {rooms[roomKey].name} у цьому періоді</div>
              ) : (
                <div className="bd-aff">
                  {affected.map((p) => (
                    <div className="bd-aff-row" key={p.id}>
                      <span className="bd-aff-time tabular">{p.time}</span>
                      <span className="bd-aff-name">{!p.isToday && <span className="bd-aff-day">{p.dayLabel}</span>}{p.name}</span>
                      <span className="bd-aff-proc">{p.proc}</span>
                      <span className="bd-aff-tag">→ обдзвін</span>
                    </div>
                  ))}
                </div>
              )
            )}
          </div>

          <div className="hint-blue">⚡ <b>Realtime:</b> колл-лист і блокування апарата миттєво зʼявляться у всіх ролей (Адмін · Радіолог · CEO).</div>
        </div>
        <div className="dlg-foot">
          {durKey
            ? <span className="bk-summary">{rooms[roomKey].name} · {reason === "maintenance" ? "ТО" : "Поломка"} · {inc.durationLabel} · <b>{affected.length}</b> на обдзвін</span>
            : <span style={{ fontSize: 12, color: "var(--text-faint)", marginRight: "auto", alignSelf: "center" }}>* Оберіть апарат, причину та тривалість</span>}
          <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
          <button className="btn btn-danger" disabled={!valid} onClick={confirm}>{ed ? "💾 Зберегти зміни" : "🔒 Зафіксувати та сформувати обдзвін"}</button>
        </div>
      </div>
    </div>
  );
}

function BreakdownDoneModal({ incident, onClose }) {
  const n = incident.patients.length;
  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 440, textAlign: "center" }}>
        <div className="dlg-body" style={{ padding: "32px 26px 22px", gap: 16 }}>
          <div style={{ fontSize: 46 }}>🔧</div>
          <div style={{ fontSize: 19, fontWeight: 700 }}>{incident.machineName} заблоковано</div>
          <div style={{ fontSize: 13.5, color: "var(--text-secondary)" }}>{incident.reasonLabel} · простій {incident.windowLabel || (incident.fromLabel + "–" + incident.toLabel)}</div>
          <div className="bd-done-box">
            <div className="bd-done-row"><span className="sk">Записів на обдзвін</span><span className="sv">{n}</span></div>
            <div className="bd-done-row"><span className="sk">Сформовано колл-лист</span><span className="sv" style={{ color: "var(--orange)" }}>{n} на обдзвін</span></div>
            <div className="bd-done-row"><span className="sk">Realtime-оновлення</span><span className="sv" style={{ color: "var(--green)" }}>✓ надіслано</span></div>
          </div>
          <div className="bd-done-hint">
            {n > 0
              ? <>Список пацієнтів — у панелі <b>«Обдзвін через простій»</b> праворуч. Дзвоніть і фіксуйте статус (перезаписано / передзвонити / відмова).</>
              : <>У вікні простою активних записів немає — обдзвонювати нікого.</>}
          </div>
        </div>
        <div className="dlg-foot" style={{ justifyContent: "center" }}>
          <button className="btn btn-green" style={{ minWidth: 220, justifyCon