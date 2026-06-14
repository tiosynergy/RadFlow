/* ===== RadFlow — Queue Board App ===== */
const { useState, useEffect, useRef, useMemo } = React;

function computeCounts(patients) {
  const c = { total: patients.length, waiting: 0, cabinet: 0, done: 0, noshow: 0 };
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
    return { name: room.name, kind: room.kind, pct, color: room.kind === "МРТ" ? "var(--blue)" : "var(--orange)" };
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
  const [selectedDay, setSelectedDay] = useState(30); // 30 травня = сьогодні
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [toasts, setToasts] = useState([]);
  const [flashId, setFlashId] = useState(null);
  const [expandedRow, setExpandedRow] = useState(null); // id розгорнутого рядка черги (лише один)
  const [modal, setModal] = useState(null); // 'new' | {complete patient} | {reschedule}
  const toastSeq = useRef(0);

  const TODAY = 30;
  const isToday = selectedDay === TODAY;
  const WEEKDAYS = ["Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота", "Неділя"];
  const dateLabel = WEEKDAYS[(3 + (selectedDay - 1)) % 7] + ", " + selectedDay + " травня 2026";

  /* пацієнти для обраного дня: сьогодні — живі дані; інші дні — розклад (минуле=виконано, майбутнє=заплановано) */
  const viewPatients = useMemo(() => {
    if (isToday) return patients;
    const past = selectedDay < TODAY;
    const n = Math.min(patients.length, 4 + (selectedDay % 7));
    return patients.slice(0, n).map((p) => ({ ...p, status: past ? "done" : "waiting" }));
  }, [patients, selectedDay, isToday]);

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

  /* deep-link: ?new=1 / ?adddoc=1 / ?register=1 / ?room=rN */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const rm = params.get("room");
    if (rm && window.RF_ROOMS && window.RF_ROOMS[rm]) setRoomView(rm);

    if (params.get("new") === "1") setModal("new");
    else if (params.get("adddoc") === "1") setModal("adddoc");
    else if (params.get("register") === "1") setModal("register");
    else if (!localStorage.getItem("rf_registered")) setModal("register");
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
    if (currentByRoom[p.room]) { pushToast(`${window.RF_ROOMS[p.room].name} зайнятий — спершу завершіть поточну процедуру`, "warning"); return; }
    setPatients((ps) => ps.map((x) => x.id === p.id ? { ...x, status: "cabinet" } : x));
    setEnteredAt((prev) => ({ ...prev, [p.room]: Date.now() }));
    flash(p.id);
    pushToast(`${p.name.split(" ").slice(0, 2).join(" ")} викликано в ${window.RF_ROOMS[p.room].name}`, "info");
  }

  function completePatient(p) {
    setPatients((ps) => ps.map((x) => x.id === p.id ? { ...x, status: "done" } : x));
    flash(p.id);
    pushToast("Процедуру виконано · Realtime-оновлення надіслано всім ролям", "success");
    setModal(null);
  }

  function openComplete(p) {
    setModal({ type: "complete", patient: p });
  }

  function failPatient(p, reason) {
    setPatients((ps) => ps.map((x) => x.id === p.id ? { ...x, status: "noshow", reason } : x));
    flash(p.id);
    pushToast(`${p.name.split(" ").slice(0, 2).join(" ")} — не відбулось: ${reason}`, "error");
    setModal(null);
  }

  function noShowPatient(p) {
    setPatients((ps) => ps.map((x) => x.id === p.id ? { ...x, status: "noshow" } : x));
    flash(p.id);
    pushToast(`${p.name.split(" ").slice(0, 2).join(" ")} — неявка зафіксована, слот звільнено`, "error");
  }

  function undoPatient(p) {
    setPatients((ps) => ps.map((x) => x.id === p.id ? { ...x, status: "waiting" } : x));
    flash(p.id);
    pushToast("Статус повернено → Очікує", "info");
  }

  /* виправлення статусу (у разі випадкового натискання) — пряма зміна на будь-який статус */
  function correctStatus(p, status) {
    if (p.status === status) return;
    if (status === "cabinet") {
      const occ = currentByRoom[p.room];
      if (occ && occ.id !== p.id) { pushToast(`${window.RF_ROOMS[p.room].name} зайнятий — спершу звільніть кабінет`, "warning"); return; }
      setEnteredAt((prev) => ({ ...prev, [p.room]: Date.now() }));
    }
    setPatients((ps) => ps.map((x) => x.id === p.id ? { ...x, status } : x));
    if (window.saveStudy) window.saveStudy(p.id, { status }); // синхронізація з кабінетом радіолога
    flash(p.id);
    const labels = { waiting: "Очікує", cabinet: "В кабінеті", done: "Виконано", noshow: "Не відбулось" };
    pushToast(`Статус виправлено → ${labels[status]} · синхронізовано`, "info");
  }

  function addBooking(b) {
    const id = Math.max(...patients.map((p) => p.id)) + 1;
    const np = { id, time: b.time, name: b.name, age: b.age || 40, phone: b.phone || "+38 0__ ___ __ __", proc: b.proc, dur: b.dur, room: b.room, status: "waiting" };
    setPatients((ps) => {
      const next = [...ps, np];
      next.sort((a, c) => a.time.localeCompare(c.time));
      return next;
    });
    flash(id);
    pushToast(`Новий запис: ${b.name} о ${b.time}`, "success");
    setModal(null);
  }

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

  const filtered = scoped.filter((p) => {
    if (filter !== "all" && p.status !== filter) return false;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      if (!(p.name.toLowerCase().includes(q) || p.proc.toLowerCase().includes(q) || p.phone.includes(q))) return false;
    }
    return true;
  });

  return (
    <div className="app">
      <Sidebar active={roomView} />
      <div className="main">
        <TopBar date={dateLabel} onRefresh={() => pushToast("Дані оновлено · підключення активне", "info")} onNew={() => setModal("new")} />
        <div className="content-wrap">
          <div className="content">
            {isToday && window.getCitoPatients && (
              <CitoBanner patients={window.getCitoPatients(patients)} onOpen={(id) => { const p = patients.find((x) => x.id === id); if (p) { setRoomView(p.room); flash(id); } }} />
            )}
            <div className="board-main-top">
              <StatsBar counts={counts} />
              {!isToday ? (
                <div className="day-banner">
                  <span className="db-ic">{selectedDay < TODAY ? "🗂" : "📅"}</span>
                  <div className="db-meta">
                    <div className="db-title">{dateLabel}</div>
                    <div className="db-sub">{selectedDay < TODAY ? "Архів — день завершено" : "Заплановані записи на цей день"} · {counts.total} записів</div>
                  </div>
                  <button className="btn btn-secondary btn-sm" onClick={() => setSelectedDay(TODAY)}>← Сьогодні</button>
                </div>
              ) : roomView === "all" ? (
                <div className="room-cards">
                  {roomKeys.map((k) => (
                    <RoomStatusCard
                      key={k} roomKey={k}
                      patient={currentByRoom[k]} enteredAt={enteredAt[k]}
                      nextWaiting={nextWaitingByRoom[k]}
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
                    onCall={callPatient}
                    onComplete={openComplete}
                    onReschedule={() => pushToast("Перенесення — відкрийте картку пацієнта", "info")}
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
                    key={p.id} p={p} flash={flashId === p.id}
                    expanded={expandedRow === p.id} onToggle={toggleRow}
                    canCall={!currentByRoom[p.room]} readOnly={!isToday}
                    onCall={callPatient} onComplete={openComplete}
                    onUndo={undoPatient} onNoShow={noShowPatient}
                    onSetStatus={correctStatus}
                  />
                ))}
              </div>
            )}
          </div>
          <aside className="rpanel">
            <MiniCalendar selectedDay={selectedDay} onSelectDay={setSelectedDay} hasChanges={hasQueueChanges} />
            <RoomLoad rooms={roomLoad} />
            <CallListPreview roomView={roomView} onToast={pushToast} />
          </aside>
        </div>
      </div>
      <Toasts toasts={toasts} />
      {modal === "new" && <NewBookingModal patients={patients} onClose={() => setModal(null)} onSave={addBooking} />}
      {modal === "adddoc" && <AddDoctorModal onClose={() => setModal(null)} onSave={(d) => { pushToast(`Лікаря-направляча додано: ${d.name}`, "success"); setModal(null); }} />}
      {modal === "register" && <PrimaryRegistrationModal onClose={() => { localStorage.setItem("rf_registered", "1"); setModal(null); }} onDone={() => { localStorage.setItem("rf_registered", "1"); pushToast("Первинну реєстрацію завершено · кабінет активовано", "success"); setModal(null); }} />}
      {modal && modal.type === "complete" && (
        <CompletionModal patient={modal.patient} enteredAt={enteredAt[modal.patient.room]}
          onClose={() => setModal(null)} onSuccess={completePatient} onFail={failPatient} />
      )}
    </div>
  );
}

/* ---------- New booking modal ---------- */
function NewBookingModal({ patients, onClose, onSave }) {
  const procs = [
    { proc: "МРТ головного мозку без контрасту", dur: 60, room: "r1" },
    { proc: "МРТ хребта (поперековий відділ)", dur: 45, room: "r1" },
    { proc: "МРТ колінного суглоба", dur: 30, room: "r1" },
    { proc: "КТ органів грудної клітки", dur: 20, room: "r2" },
    { proc: "КТ голови", dur: 15, room: "r2" },
    { proc: "КТ черевної порожнини з контрастом", dur: 40, room: "r2" },
  ];
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [age, setAge] = useState("");
  const [procIdx, setProcIdx] = useState(0);
  const slots = ["11:00", "13:00", "13:45", "15:00", "16:00", "16:30", "17:00", "17:30"];
  const [time, setTime] = useState("");
  const sel = procs[procIdx];
  const valid = name.trim() && time;

  return (
    <div className="overlay" onMouseDown={(e) => e.target.classList.contains("overlay") && onClose()}>
      <div className="dialog fade-in">
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic">＋</span>Новий запис</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dlg-body">
          <div className="hint-blue"><b>Smart Scheduler:</b> найближчий вільний слот для «{sel.proc}» — {window.RF_ROOMS[sel.room].name}.</div>
          <label className="fld">
            <span className="fld-lab">Пацієнт *</span>
            <input className="inp" placeholder="Прізвище Ім'я По батькові" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <div className="fld-row">
            <label className="fld">
              <span className="fld-lab">Телефон</span>
              <input className="inp" placeholder="+38 0__ ___ __ __" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </label>
            <label className="fld" style={{ maxWidth: 110 }}>
              <span className="fld-lab">Вік</span>
              <input className="inp" placeholder="—" value={age} onChange={(e) => setAge(e.target.value.replace(/\D/g, ""))} />
            </label>
          </div>
          <label className="fld">
            <span className="fld-lab">Процедура</span>
            <select className="inp" value={procIdx} onChange={(e) => setProcIdx(+e.target.value)}>
              {procs.map((p, i) => <option key={i} value={i}>{p.proc} · {p.dur} хв · {window.RF_ROOMS[p.room].name}</option>)}
            </select>
          </label>
          <div className="fld">
            <span className="fld-lab">Час</span>
            <div className="slot-grid">
              {slots.map((s) => {
                const taken = patients.some((p) => p.time === s);
                return (
                  <button key={s} className={"slot" + (time === s ? " sel" : "") + (taken ? " taken" : "")}
                    disabled={taken} onClick={() => setTime(s)}>{s}</button>
                );
              })}
            </div>
          </div>
        </div>
        <div className="dlg-foot">
          <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
          <button className="btn btn-primary" disabled={!valid}
            onClick={() => onSave({ name: name.trim(), phone, age: +age || 0, proc: sel.proc, dur: sel.dur, room: sel.room, time })}>
            Зберегти запис
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Procedure completion modal — ADMIN-PROC-01 ---------- */
const FAIL_REASONS = [
  { group: "Стан пацієнта", items: ["Клаустрофобія", "Несумісний імплант", "Кардіостимулятор", "Не готовий", "Погано почувається", "Відмовився"] },
  { group: "Технічні причини", items: ["Поломка обладнання", "Апарат потребує ТО"] },
  { group: "Інше", items: ["Інше"] },
];

function CompletionModal({ patient, enteredAt, onClose, onSuccess, onFail }) {
  const [result, setResult] = useState("success");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const room = window.RF_ROOMS[patient.room];
  const canConfirm = result === "success" || (result === "failed" && reason);

  const techHint = reason === "Поломка обладнання" || reason === "Апарат потребує ТО";
  const callHint = reason === "Не готовий" || reason === "Відмовився" || reason === "Погано почувається";

  function confirm() {
    if (result === "success") onSuccess(patient);
    else onFail(patient, reason);
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target.classList.contains("overlay") && onClose()}>
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
                <div className="ctx-hint blue">↩ Передати пацієнта до <a href="radflow-call-list.html">Колл-листа</a> для перезапису?</div>
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
    <div className="overlay" onMouseDown={(e) => e.target.classList.contains("overlay") && onClose()}>
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

/* ---------- Primary registration modal (схожа на Майстер налаштування) ---------- */
function PrimaryRegistrationModal({ onClose, onDone }) {
  const steps = ["Клініка", "Кабінети", "Адміністратор", "Готово"];
  const [step, setStep] = useState(0);
  const [clinic, setClinic] = useState("МЦ «Медика»");
  const [city, setCity] = useState("Київ");
  const [rooms, setRooms] = useState([
    { kind: "МРТ", name: "Кабінет №1", model: "Siemens Avanto" },
    { kind: "КТ", name: "Кабінет №2", model: "GE Optima" },
  ]);
  const [admin, setAdmin] = useState("Оксана Мельник");
  const [email, setEmail] = useState("o.melnyk@medika.ua");

  function next() { if (step < steps.length - 1) setStep(step + 1); else onDone(); }
  function back() { if (step > 0) setStep(step - 1); }
  function addRoom() { setRooms((r) => [...r, { kind: "МРТ", name: "Кабінет №" + (r.length + 1), model: "" }]); }
  function setRoom(i, key, val) { setRooms((r) => r.map((x, j) => j === i ? { ...x, [key]: val } : x)); }
  function delRoom(i) { setRooms((r) => r.filter((_, j) => j !== i)); }

  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 560 }}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic">✦</span>Первинна реєстрація кабінету</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        {/* step indicator */}
        <div className="reg-steps">
          {steps.map((s, i) => (
            <div key={s} className={"reg-step" + (i === step ? " active" : "") + (i < step ? " done" : "")}>
              <span className="reg-num">{i < step ? "✓" : i + 1}</span>
              <span className="reg-lab">{s}</span>
            </div>
          ))}
        </div>

        <div className="dlg-body">
          {step === 0 && (
            <div className="fade-in" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="hint-blue">Вітаємо у RadFlow! Заповніть базові дані, щоб активувати ваш кабінет МРТ/КТ.</div>
              <label className="fld"><span className="fld-lab">Назва клініки *</span>
                <input className="inp" value={clinic} onChange={(e) => setClinic(e.target.value)} /></label>
              <div className="fld-row">
                <label className="fld"><span className="fld-lab">Місто</span>
                  <input className="inp" value={city} onChange={(e) => setCity(e.target.value)} /></label>
                <label className="fld"><span className="fld-lab">Телефон закладу</span>
                  <input className="inp" defaultValue="+38 044 555 12 00" /></label>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="fade-in" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="hint-blue">Додайте апарати МРТ/КТ. Це визначає кабінети та доступні слоти для запису.</div>
              {rooms.map((r, i) => (
                <div className="reg-room" key={i}>
                  <select className="inp" style={{ maxWidth: 90 }} value={r.kind} onChange={(e) => setRoom(i, "kind", e.target.value)}>
                    <option>МРТ</option><option>КТ</option>
                  </select>
                  <input className="inp" placeholder="Кабінет" value={r.name} onChange={(e) => setRoom(i, "name", e.target.value)} />
                  <input className="inp" placeholder="Модель апарата" value={r.model} onChange={(e) => setRoom(i, "model", e.target.value)} />
                  <button className="mini-icon" title="Видалити" onClick={() => delRoom(i)} disabled={rooms.length <= 1}>✕</button>
                </div>
              ))}
              <button className="btn btn-secondary btn-sm" style={{ alignSelf: "flex-start" }} onClick={addRoom}>＋ Додати апарат</button>
            </div>
          )}

          {step === 2 && (
            <div className="fade-in" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="hint-blue">Обліковий запис адміністратора — він керуватиме чергою та записами.</div>
              <label className="fld"><span className="fld-lab">ПІБ адміністратора *</span>
                <input className="inp" value={admin} onChange={(e) => setAdmin(e.target.value)} /></label>
              <label className="fld"><span className="fld-lab">Email *</span>
                <input className="inp" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
              <label className="fld"><span className="fld-lab">Пароль</span>
                <input className="inp" type="password" defaultValue="••••••••" /></label>
            </div>
          )}

          {step === 3 && (
            <div className="fade-in" style={{ textAlign: "center", padding: "10px 0" }}>
              <div style={{ fontSize: 46 }}>🎉</div>
              <div style={{ fontSize: 19, fontWeight: 700, marginTop: 10 }}>Все готово, {admin.split(" ")[0]}!</div>
              <div style={{ fontSize: 13.5, color: "var(--text-secondary)", marginTop: 8 }}>{clinic} · {city} · {rooms.length} кабінети</div>
              <div className="summary-box" style={{ textAlign: "left", marginTop: 16 }}>
                <div className="summary-row"><span className="sk">Клініка</span><span className="sv">{clinic}</span></div>
                <div className="summary-row"><span className="sk">Кабінети</span><span className="sv">{rooms.map((r) => r.kind).join(" · ")}</span></div>
                <div className="summary-row"><span className="sk">Адміністратор</span><span className="sv">{admin}</span></div>
              </div>
              <div className="hint-blue" style={{ marginTop: 14, textAlign: "left" }}>Далі ви можете уточнити прайс-лист і розклад у «Майстрі налаштування».</div>
            </div>
          )}
        </div>

        <div className="dlg-foot">
          {step > 0 && step < 3 ? <button className="btn btn-ghost" onClick={back}>← Назад</button> : <span></span>}
          <button className="btn btn-primary" onClick={next}>
            {step === 3 ? "🚀 Активувати кабінет" : "Далі →"}
          </button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { App });
ReactDOM.createRoot(document.getElementById("root")).render(<App />);