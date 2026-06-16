/* =====================================================================
   RadFlow — Кабінет радіолога (Radiologist Office)  ·  v2
   ---------------------------------------------------------------------
   Призначення сторінки:
     • Черга пацієнтів — той самий механізм/UI, що й у Адміністратора
       (розгортувані рядки .qrow-item, спільні компоненти StatsBar та
       QueueControls з queue-components.jsx, спільні дані getQueuePatients).
     • КОНТРОЛЬ ДОСТУПУ ДО ОБЛАДНАННЯ: радіолог бачить ВИКЛЮЧНО кабінети,
       видані йому Адміністратором (window.getAuthorizedCabinets()).
       Черга жорстко фільтрується — дослідження неавторизованого
       обладнання ніколи не потрапляють у вибірку.
     • Дії в рядку — у межах ролі радіолога (зміна статусу дослідження,
       примітки); адмін-дії (виклик у кабінет, новий запис) тут відсутні.

   Залежності (підключаються в radflow-radiologist.html ДО цього файлу):
     queue-data.js, radiologist-data.js, rf-shell.jsx, queue-components.jsx
   ===================================================================== */
const { useState, useEffect, useMemo, useRef } = React;

/* ---------- Годинник у шапці (поточний час, оновлюється щосекунди) ---------- */
function LiveClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const time = now.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return <span className="rad-clock tabular">🕐 {time}</span>;
}

/* ---------- Бічна панель: ідентичність + список авторизованих кабінетів ----------
   Список кабінетів тут — це водночас відображення прав доступу і ЄДИНИЙ перемикач
   («Усі кабінети» + кожен авторизований кабінет), керує roomFilter. */
function RadSidebar({ counts, roomFilter, setRoomFilter, authorized, singleCabinet }) {
  return (
    <aside className="sidebar">
      <div className="sb-head">
        <a href="radflow-queue-board.html" className="sb-logo"><span className="dot"></span>RadFlow</a>
        <div className="sb-sub">Радіолог • МЦ «Медика»</div>
      </div>
      <nav className="sb-nav">
        <div className="sb-section">
          <div className="sb-label">Авторизовані кабінети</div>
          {/* «Усі кабінети» — перший пункт переліку (за кількох авторизованих) */}
          {!singleCabinet && (
            <button className={"sb-cab sb-cab-btn" + (roomFilter === "all" ? " active" : "")} onClick={() => setRoomFilter("all")}>
              <span className="sb-cab-tile" style={{ background: "var(--card-hover)", color: "var(--text-secondary)" }}>▦</span>
              <span className="sb-cab-meta">
                <span className="sb-cab-name">Усі кабінети</span>
                <span className="sb-cab-model">{authorized.length} апаратів · {counts.total} у черзі</span>
              </span>
            </button>
          )}
          {authorized.map((k) => {
            const r = window.RF_ROOMS[k];
            if (!r) return null;
            return (
              <button key={k} className={"sb-cab sb-cab-btn" + (roomFilter === k ? " active" : "")} onClick={() => setRoomFilter(k)}>
                <span className={"sb-cab-tile " + (r.kind === "МРТ" ? "mrt" : "ct")}>{r.kind}</span>
                <span className="sb-cab-meta">
                  <span className="sb-cab-name">{r.name}</span>
                  <span className="sb-cab-model">{r.model}</span>
                </span>
              </button>
            );
          })}
        </div>
      </nav>
      <div className="sb-user">
        <div className="avatar" style={{ background: "linear-gradient(135deg,#30d158,#1a7a36)" }}>{window.RAD_PROFILE.initials}</div>
        <div className="meta">
          <div className="nm">{window.RAD_PROFILE.name}</div>
          <div className="rl">{window.RAD_PROFILE.role}</div>
        </div>
        <button className="icon-btn" title="Вийти">⏻</button>
      </div>
    </aside>
  );
}

/* ---------- Рядок черги — той самий механізм розгортання, що й у адміністратора ---------- */
function RadQueueRow({ p, date, expanded, onToggle, store, onStatus, onSaveNotes, onReschedule, onEditStudies, readOnly }) {
  const meta = window.RF_STATUS_META[p.status];
  const cl = window.RAD_CLINICAL[p.id] || {};
  const room = window.RF_ROOMS[p.room];
  const isCito = window.isCito && window.isCito(p.id);
  const g = window.radGender ? window.radGender(p.name) : null;
  const st = window.getStudyStore()[p.id] || {};
  const signed = st.protocol && st.protocol.signed;

  return (
    <div className={"qrow-item " + p.status + (expanded ? " open" : "")} data-qrow={p.id}>
      {/* шапка рядка — клік розгортає панель (як у адміністратора) */}
      <div className="qrow" role="button" tabIndex={0} onClick={() => onToggle(p.id)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(p.id); } }}>
        <div className="q-time tabular">{p.time}<div className="td">{p.dur} хв</div></div>
        <div className="q-pat">
          <div className="nm">{isCito && <span className="cito-tag">CITO</span>}{p.name}</div>
          <div className="det">{p.age} р.{g ? " · " + g.label : ""}</div>
        </div>
        <div className="q-proc">
          <div className="pp">{p.proc}</div>
          <div className="du">{room.kind}{cl.region ? " · " + cl.region : ""}</div>
        </div>
        <div className="q-room"><b>{room.name}</b>{room.model}</div>
        <div className="rqrow-status">
          <span className={"badge " + meta.cls}>{meta.dot && <span className="pulse-dot" style={{ width: 6, height: 6 }}></span>}{signed ? "Підписано" : meta.label}</span>
        </div>
        <span className={"q-chev" + (expanded ? " open" : "")} aria-hidden>›</span>
      </div>

      {/* розгортувана панель — клінічний контекст + дії радіолога (статус, примітки) */}
      <div className="qrow-detail-wrap">
        <div className="qrow-detail-inner">
          <div className="qrow-detail">
            <PatientDetail patient={p} date={date} store={store} onStatus={onStatus} onSaveNotes={onSaveNotes} onReschedule={onReschedule} onEditStudies={onEditStudies} embedded readOnly={readOnly} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Деталі дослідження (вміст розгортуваної панелі) ---------- */
/* Статуси повністю відповідають головній черзі Адміністратора (5 статусів) */
const RAD_STATUSES = [
  { key: "queued", label: "В черзі", cls: "gray" },
  { key: "waiting", label: "Очікує", cls: "yellow" },
  { key: "cabinet", label: "В кабінеті", cls: "blue" },
  { key: "done", label: "Виконано", cls: "green" },
  { key: "noshow", label: "Не відбулось", cls: "red" },
];

function PatientDetail({ patient, date, store, onStatus, onSaveNotes, onReschedule, onEditStudies, embedded, readOnly }) {
  const cl = window.RAD_CLINICAL[patient.id] || {};
  const doc = (window.RF_DOCTORS || []).find((d) => d.id === cl.docId);
  const room = window.RF_ROOMS[patient.room];
  const meta = window.RF_STATUS_META[patient.status];

  const saved = store[patient.id] || {};
  const [notes, setNotes] = useState(saved.notes || "");

  useEffect(() => {
    const s = window.getStudyStore()[patient.id] || {};
    setNotes(s.notes || "");
  }, [patient.id]);

  function saveNote(v) { setNotes(v); onSaveNotes(patient.id, v); }

  return (
    <div className="pd">
      {/* власна шапка прихована у вбудованому режимі — назву й статус показує сам рядок черги */}
      {!embedded && (
      <div className="pd-head">
        <div className="pd-h-left">
          <div className="pd-name">{patient.name}</div>
          <div className="pd-sub">{patient.age} р. · {patient.phone}</div>
        </div>
        <div className="pd-h-right">
          <span className={"badge " + meta.cls}>{meta.dot && <span className="pulse-dot" style={{ width: 6, height: 6 }}></span>}{meta.label}</span>
        </div>
      </div>
      )}

      {/* клінічна інформація */}
      <div className="pd-grid">
        <Info label="Процедура" value={patient.proc} wide />
        <Info label="Кабінет / Апарат" value={room.name + " · " + room.model} />
        {date && <Info label="Дата" value={window.rfFmtFull ? window.rfFmtFull(date) : ""} />}
        <Info label="Час · Тривалість" value={patient.time + " · " + patient.dur + " хв"} />
        <Info label="Контраст" value={cl.contrast ? "З контрастом" : "Без контрасту"} />
        <Info label="Вага пацієнта" value={(patient.weight || cl.weight) ? (patient.weight || cl.weight) + " кг" : "—"} />
        <Info label="Дзвінок-підтвердження" value={(() => {
          // лише відображення — радіолог не може змінювати статус дзвінка (керує адмін/колл-лист)
          const cs = window.getCallStatusFor ? window.getCallStatusFor(patient.id, patient.call) : patient.call;
          const m = (window.CL_STATUS && cs) ? window.CL_STATUS[cs] : null;
          return m
            ? <span className={"qd-call " + m.cls} title="Статус підтвердження по колл-листу (лише перегляд)">{m.icon} {m.label}</span>
            : <span className="qd-call gray">○ Не дзвонили</span>;
        })()} />
        <Info label="Лікар-направник" value={
          doc
            ? <span className="pd-doc"><span>{doc.name} · {doc.spec}</span><a className="pd-doc-phone" href={"tel:" + doc.phone.replace(/\s/g, "")}>☎ {doc.phone}</a></span>
            : "—"
        } wide />
      </div>

      {/* керування статусом — лише для сьогоднішньої черги (інші дні — перегляд) */}
      {!readOnly && (
        <div className="pd-status-ctrl">
          <span className="pd-field-lab">Статус дослідження</span>
          <div className="status-seg">
            {RAD_STATUSES.map((s) => {
              const lockDone = s.key === "done" && patient.status !== "cabinet"; // завершити можна лише з кабінету
              return (
                <button key={s.key} disabled={lockDone}
                  className={"ss-btn " + s.cls + (patient.status === s.key ? " active" : "") + (lockDone ? " locked" : "")}
                  title={lockDone ? "«Виконано» доступне лише коли пацієнт у кабінеті" : ""}
                  onClick={() => { if (!lockDone) onStatus(patient.id, s.key); }}>
                  <span className={"ss-dot " + s.cls}></span>{s.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* живий таймер, поки пацієнт у кабінеті */}
      {!readOnly && patient.status === "cabinet" && (
        <div className="pd-timer-card">
          <LiveTimer enteredAt={Date.now() - (patient.secondsInCabinet || 0) * 1000}>{(sec) => {
            const over = sec > patient.dur * 60;
            return <span className={"pd-timer tabular" + (over ? " over" : "")}>◷ {fmtTimer(sec)} <span className="pd-timer-lab">{over ? "перевищено час" : "у кабінеті"}</span></span>;
          }}</LiveTimer>
        </div>
      )}

      {/* дослідження + перенесення на новий слот — доступні прямо з черги радіолога */}
      {(onEditStudies || (onReschedule && patient.status !== "done" && patient.status !== "noshow")) && (
        <div className="pd-status-ctrl" style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="pd-field-lab" style={{ margin: 0 }}>Дії</span>
          {onEditStudies && <button className="btn btn-secondary btn-sm" onClick={() => onEditStudies(patient)}>🩻 Дослідження</button>}
          {onReschedule && patient.status !== "done" && patient.status !== "noshow" && (
            <button className="btn btn-secondary btn-sm" onClick={() => onReschedule(patient)}>🗓 Перенести на новий слот</button>
          )}
        </div>
      )}

      {/* примітки радіолога */}
      <div className="pd-notes">
        <span className="pd-field-lab">Примітки радіолога {!readOnly && <span className="pd-autosave">· автозбереження</span>}</span>
        <textarea className="pd-textarea" rows={3} placeholder={readOnly ? "—" : "Внутрішня нотатка (видно команді)…"} value={notes} disabled={readOnly} onChange={(e) => saveNote(e.target.value)}></textarea>
      </div>
    </div>
  );
}

function Info({ label, value, wide }) {
  return (
    <div className={"pd-info" + (wide ? " wide" : "")}>
      <span className="pd-info-lab">{label}</span>
      <span className="pd-info-val">{value}</span>
    </div>
  );
}

/* Лічильники для StatsBar/QueueControls — та сама структура, що в admin computeCounts() */
function radComputeCounts(list) {
  const c = { total: list.length, queued: 0, waiting: 0, cabinet: 0, done: 0, noshow: 0 };
  list.forEach((p) => { c[p.status]++; });
  return c;
}

/* ---------- Сторінка ---------- */
function RadApp() {
  /* === КОНТРОЛЬ ДОСТУПУ: лише кабінети, видані Адміністратором === */
  const authorized = window.getAuthorizedCabinets();      // напр. ["r1","r2","r3","r4"]
  const singleCabinet = authorized.length === 1;

  /* дані: спільна черга, СУВОРО відфільтрована за авторизованим обладнанням
     (getRadiologistQueue гарантує, що чужі кабінети взагалі не завантажуються) */
  const [patients, setPatients] = useState(() => window.getRadiologistQueue());
  const [store, setStore] = useState(window.getStudyStore());

  /* один кабінет → обраний за замовчуванням; кілька → «усі авторизовані» */
  const [roomFilter, setRoomFilter] = useState(singleCabinet ? authorized[0] : "all");
  const [filter, setFilter] = useState("all");   // статус-фільтр (як у адміністратора)
  const [query, setQuery] = useState("");          // пошук (як у адміністратора)
  const [expandedRow, setExpandedRow] = useState(null);
  const [toasts, push] = useToasts();

  /* === Реальний календар (як у адміністратора) === */
  const [selectedDate, setSelectedDate] = useState(() => window.rfToday());
  const [simOn, setSimOn] = useState(() => (window.RFSim ? window.RFSim.isOn() : true));
  const today = window.rfToday();
  const isToday = window.rfSameDay(selectedDate, today);
  const isPast = selectedDate < today && !isToday;
  const dateLabel = window.rfFmtFull(selectedDate);
  const selKey = selectedDate.getTime();
  const readOnly = !isToday; // інші дні — лише перегляд

  function toggleRow(id) { setExpandedRow((cur) => (cur === id ? null : id)); }

  /* Real-time синхронізація:
       • статуси дослідження (rf_study_store_v1)
       • статуси дзвінка з колл-листа (rf_calllist_status_v1) — лише для перегляду
     застосовуються миттєво: між вкладками (storage) і в межах вкладки (rf-call-sync). */
  const [, setCallVer] = useState(0);
  function refreshStudy() {
    setPatients(window.getRadiologistQueue());
    setStore(window.getStudyStore());
  }
  useEffect(() => {
    function onStorage(e) {
      if (!e.key || e.key === window.RAD_STORE_KEY) refreshStudy();
      if (!e.key || e.key === window.CL_STORAGE_KEY) setCallVer((v) => v + 1); // перемалювати статус дзвінка
      if (!e.key || e.key === window.RF_BOOKINGS_KEY || e.key === window.RF_CANCELLED_KEY) refreshStudy(); // нові/скасовані записи
    }
    function onStudySync() { refreshStudy(); }     // симуляція/адмін у цій же вкладці
    function onCallSync() { setCallVer((v) => v + 1); }
    function onBookingSync() { refreshStudy(); }   // нові/скасовані/перенесені записи
    function onSimTog(e) { setSimOn(e && e.detail ? e.detail.on : (window.RFSim && window.RFSim.isOn())); }
    window.addEventListener("storage", onStorage);
    window.addEventListener("rf-study-sync", onStudySync);
    window.addEventListener("rf-call-sync", onCallSync);
    window.addEventListener("rf-booking-sync", onBookingSync);
    window.addEventListener("rf-sim-toggle", onSimTog);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("rf-study-sync", onStudySync);
      window.removeEventListener("rf-call-sync", onCallSync);
      window.removeEventListener("rf-booking-sync", onBookingSync);
      window.removeEventListener("rf-sim-toggle", onSimTog);
    };
  }, []);

  /* колапс розгорнутого рядка при кліку поза будь-яким рядком + Esc (як у адміністратора) */
  useEffect(() => {
    if (expandedRow == null) return;
    function onDocClick(e) { if (!e.target.closest(".qrow-item")) setExpandedRow(null); }
    function onKey(e) { if (e.key === "Escape") setExpandedRow(null); }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDocClick); document.removeEventListener("keydown", onKey); };
  }, [expandedRow]);

  /* пацієнти обраного дня:
       • сьогодні — жива черга (getRadiologistQueue + симуляція);
       • інші дні — детерміноване моделювання (schedule.js), СУВОРО в межах
         авторизованих кабінетів (контроль доступу зберігається). */
  const dayPatients = useMemo(() => {
    if (isToday) return patients;
    const allowed = window.getAuthorizedCabinets();
    const all = window.getDayPatients ? window.getDayPatients(selectedDate) : [];
    return all.filter((p) => allowed.includes(p.room));
  }, [patients, selKey, isToday]);

  /* вибірка за обраним кабінетом — ЗАВЖДИ в межах авторизованих */
  const scoped = useMemo(() => roomFilter === "all" ? dayPatients : dayPatients.filter((p) => p.room === roomFilter), [dayPatients, roomFilter]);

  /* лічильники для StatsBar та QueueControls */
  const counts = useMemo(() => radComputeCounts(scoped), [scoped]);

  /* зміни сьогодні (маркер у календарі) */
  const hasChanges = patients.some((p) => p.status === "noshow");

  /* статус-фільтр + пошук — ІДЕНТИЧНА логіка адмін-черги */
  const filtered = window.rfSortFlow(scoped.filter((p) => {
    if (filter !== "all" && p.status !== filter) return false;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      if (!(p.name.toLowerCase().includes(q) || p.proc.toLowerCase().includes(q) || p.phone.includes(q))) return false;
    }
    return true;
  }));

  /* дія радіолога: зміна статусу дослідження (синхронізується з адмін-дошкою через спільне сховище) */
  function setStatus(id, status) {
    const cur = patients.find((x) => x.id === id);
    if (status === "done" && cur && cur.status !== "cabinet") {
      push("«Виконано» можна позначити лише для пацієнта в кабінеті", "warning");
      return;
    }
    const phase = status === "noshow" ? "waiting" : status; // тримаємо канбан-фазу узгодженою
    window.saveStudy(id, { status, phase });
    setPatients((ps) => ps.map((p) => p.id === id ? { ...p, status } : p));
    setStore(window.getStudyStore());
    const labels = { queued: "В черзі", cabinet: "В кабінеті", waiting: "Очікує", noshow: "Не відбулось", done: "Виконано" };
    const p = patients.find((x) => x.id === id);
    push(`${p ? p.name.split(" ").slice(0, 2).join(" ") : ""} → ${labels[status] || "оновлено"} · синхронізовано`, status === "noshow" ? "warning" : status === "done" ? "success" : "info");
  }

  /* дія радіолога: збереження приміток */
  function saveNotes(id, notes) {
    window.saveStudy(id, { notes });
    setStore(window.getStudyStore());
  }

  /* Перенесення на новий слот недоступне радіологу (лише перегляд + статуси).
     Керує переносом адміністратор / лікар-направник. */

  /* CITO — лише серед авторизованих/видимих досліджень */
  const cito = window.getCitoPatients ? window.getCitoPatients(scoped) : [];

  return (
    <div className="app">
      <RadSidebar counts={counts} roomFilter={roomFilter} setRoomFilter={setRoomFilter} authorized={authorized} singleCabinet={singleCabinet} />
      <div className="main">
        {/* Шапка: ПІБ + роль + поточна дата/час */}
        <PageTopBar
          icon="🩺" title="Кабінет радіолога"
          subtitle={window.RAD_PROFILE.name + " · " + window.RAD_PROFILE.role}
          actions={<>
            <span className="rad-date">{dateLabel}</span>
            <LiveClock />
            <span className="rt-pill"><span className="pulse-dot g"></span>Real-time</span>
            <span className="rad-counter">Опрацьовано: <b>{counts.done}</b> / {counts.total}</span>
          </>}
        />
        <div className="content-wrap">
        <div className="rad-list-wrap">
          {/* банер обраного дня (минуле/майбутнє) — лише перегляд */}
          {!isToday && (
            <div className="day-banner" style={{ marginBottom: 14 }}>
              <span className="db-ic">{isPast ? "🗂" : "📅"}</span>
              <div className="db-meta">
                <div className="db-title">{dateLabel}</div>
                <div className="db-sub">{counts.total === 0 ? "Вихідний — клініка не працює" : (isPast ? "Архів — день завершено" : "Заплановані дослідження") + " · " + counts.total + " записів · лише перегляд"}</div>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => setSelectedDate(window.rfToday())}>← Сьогодні</button>
            </div>
          )}

          {/* Швидка статистика — клікабельні фільтри (ПЕРЕВИКОРИСТАНИЙ StatsBar) */}
          <StatsBar counts={counts} filter={filter} setFilter={setFilter} />

          {cito.length > 0 && <CitoBanner patients={cito} onOpen={(id) => setExpandedRow(id)} />}

          {/* Фільтри + пошук — ПЕРЕВИКОРИСТАНИЙ admin-компонент QueueControls */}
          <QueueControls filter={filter} setFilter={setFilter} counts={counts} query={query} setQuery={setQuery} />

          {/* Черга пацієнтів — той самий розкладний механізм, що й у адміністратора */}
          {filtered.length === 0 ? (
            <div className="empty">
              <div className="ei">⌕</div>
              <div className="et">Нічого не знайдено</div>
              <div className="es">Спробуйте змінити фільтр, кабінет або пошуковий запит</div>
            </div>
          ) : (
            <>
              <div className="qhead">
                <div>Час</div><div>Пацієнт</div><div>Дослідження</div><div>Кабінет</div><div>Статус</div><div></div>
              </div>
              <div className="qrows">
                {filtered.map((p) => (
                  <RadQueueRow
                    key={p.id} p={p} date={selectedDate}
                    expanded={expandedRow === p.id} onToggle={toggleRow}
                    store={store} onStatus={setStatus} onSaveNotes={saveNotes}
                    readOnly={readOnly}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        {/* Права панель: реальний календар (як у адміністратора) */}
        <aside className="rpanel">
          <MiniCalendar
            selectedDate={selectedDate} onSelectDate={setSelectedDate} today={today}
            hasChanges={hasChanges} counts={counts} simOn={simOn}
          />
        </aside>
        </div>
      </div>
      <Toasts toasts={toasts} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<RadApp />);
