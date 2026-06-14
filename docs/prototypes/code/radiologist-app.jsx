/* ===== RadFlow — Radiologist workspace ===== */
const { useState, useEffect, useMemo, useRef } = React;

const PRIORITY_ORDER = { cito: 0, urgent: 1, planned: 2 };

/* ---------- Sidebar (radiologist) ---------- */
function RadSidebar({ counts, roomFilter, setRoomFilter }) {
  const rooms = window.RF_ROOMS;
  const authorized = window.RAD_PROFILE.cabinets;
  return (
    <aside className="sidebar">
      <div className="sb-head">
        <a href="radflow-queue-board.html" className="sb-logo"><span className="dot"></span>RadFlow</a>
        <div className="sb-sub">Радіолог • МЦ «Медика»</div>
      </div>
      <nav className="sb-nav">
        <div className="sb-section">
          <div className="sb-label">Робота</div>
          <button className={"sb-item" + (roomFilter === "all" ? " active" : "")} onClick={() => setRoomFilter("all")}>
            <span className="ic">▦</span>
            <span className="sb-item-lab">Моя черга</span>
            <span className="sb-badge dim">{counts.total}</span>
          </button>
        </div>
        <div className="sb-section">
          <div className="sb-label">Авторизовані кабінети</div>
          {authorized.map((k) => {
            const r = rooms[k];
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

/* ---------- Queue list item ---------- */
function RadQueueItem({ p, active, onSelect }) {
  const meta = window.RF_STATUS_META[p.status];
  const cl = window.RAD_CLINICAL[p.id] || {};
  const prio = window.RAD_PRIORITY[cl.priority] || window.RAD_PRIORITY.planned;
  const type = window.studyType(p.proc);
  const store = window.getStudyStore()[p.id];
  const signed = store && store.protocol && store.protocol.signed;
  return (
    <button className={"rq-item" + (active ? " active" : "") + " st-" + p.status} onClick={() => onSelect(p.id)}>
      <span className="rq-time tabular">{p.time}</span>
      <span className={"rq-tile " + (type === "МРТ" ? "mrt" : "ct")}>{type}</span>
      <span className="rq-main">
        <span className="rq-name">{p.name}</span>
        <span className="rq-proc">{p.proc}</span>
      </span>
      <span className="rq-side">
        {cl.priority && cl.priority !== "planned" && <span className={"rq-prio " + prio.cls}>{prio.label}</span>}
        <span className={"badge " + meta.cls + " rq-badge"}>{meta.dot && <span className="pulse-dot" style={{ width: 5, height: 5 }}></span>}{signed ? "Підписано" : meta.label}</span>
      </span>
    </button>
  );
}

/* ---------- Patient detail ---------- */
const RAD_STATUSES = [
  { key: "waiting", label: "Очікує", cls: "gray" },
  { key: "cabinet", label: "В кабінеті", cls: "blue" },
  { key: "done", label: "Виконано", cls: "green" },
  { key: "noshow", label: "Не відбулось", cls: "red" },
];

function PatientDetail({ patient, store, onStatus, onSaveNotes, toast }) {
  const cl = window.RAD_CLINICAL[patient.id] || {};
  const doc = (window.RF_DOCTORS || []).find((d) => d.id === cl.docId);
  const room = window.RF_ROOMS[patient.room];
  const prio = window.RAD_PRIORITY[cl.priority] || window.RAD_PRIORITY.planned;
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
      {/* header */}
      <div className="pd-head">
        <div className="pd-h-left">
          <div className="pd-name">{patient.name}</div>
          <div className="pd-sub">{patient.age} р. · {patient.phone}</div>
        </div>
        <div className="pd-h-right">
          {cl.priority && <span className={"rq-prio " + prio.cls}>{prio.label}</span>}
          <span className={"badge " + meta.cls}>{meta.dot && <span className="pulse-dot" style={{ width: 6, height: 6 }}></span>}{meta.label}</span>
        </div>
      </div>

      {/* clinical info grid */}
      <div className="pd-grid">
        <Info label="Процедура" value={patient.proc} wide />
        <Info label="Кабінет / Апарат" value={room.name + " · " + room.model} />
        <Info label="Час · Тривалість" value={patient.time + " · " + patient.dur + " хв"} />
        <Info label="Контраст" value={cl.contrast ? "З контрастом" : "Без контрасту"} />
        <Info label="Вага пацієнта" value={(cl.weight || "—") + " кг"} />
        <Info label="Лікар-направник" value={
          doc
            ? <span className="pd-doc"><span>{doc.name} · {doc.spec}</span><a className="pd-doc-phone" href={"tel:" + doc.phone.replace(/\s/g, "")}>☎ {doc.phone}</a></span>
            : "—"
        } wide />
      </div>

      {/* status control — радіолог змінює статус дослідження */}
      <div className="pd-status-ctrl">
        <span className="pd-field-lab">Статус дослідження</span>
        <div className="status-seg">
          {RAD_STATUSES.map((s) => (
            <button key={s.key} className={"ss-btn " + s.cls + (patient.status === s.key ? " active" : "")} onClick={() => onStatus(patient.id, s.key)}>
              <span className={"ss-dot " + s.cls}></span>{s.label}
            </button>
          ))}
        </div>
      </div>

      {/* live timer when in cabinet */}
      {patient.status === "cabinet" && (
        <div className="pd-timer-card">
          <LiveTimer enteredAt={Date.now() - (patient.secondsInCabinet || 0) * 1000}>{(sec) => {
            const over = sec > patient.dur * 60;
            return <span className={"pd-timer tabular" + (over ? " over" : "")}>◷ {fmtTimer(sec)} <span className="pd-timer-lab">{over ? "перевищено час" : "у кабінеті"}</span></span>;
          }}</LiveTimer>
        </div>
      )}

      {/* notes */}
      <div className="pd-notes">
        <span className="pd-field-lab">Примітки радіолога <span className="pd-autosave">· автозбереження</span></span>
        <textarea className="pd-textarea" rows={3} placeholder="Внутрішня нотатка (видно команді)…" value={notes} onChange={(e) => saveNote(e.target.value)}></textarea>
      </div>
    </div>
  );
}

function Info({ label, value, wide, indication }) {
  return (
    <div className={"pd-info" + (wide ? " wide" : "") + (indication ? " indication" : "")}>
      <span className="pd-info-lab">{label}</span>
      <span className="pd-info-val">{value}</span>
    </div>
  );
}

/* ---------- App ---------- */
function RadApp() {
  const authorized = window.RAD_PROFILE.cabinets;
  const [patients, setPatients] = useState(() => window.getQueuePatients().filter((p) => authorized.includes(p.room)));
  const [store, setStore] = useState(window.getStudyStore());
  const [filter, setFilter] = useState("all");
  const [roomFilter, setRoomFilter] = useState("all");
  const [selectedId, setSelectedId] = useState(null);
  const [toasts, push] = useToasts();

  // лише пацієнти обраного кабінету (або всі авторизовані)
  const visible = useMemo(() => roomFilter === "all" ? patients : patients.filter((p) => p.room === roomFilter), [patients, roomFilter]);

  // radiologist queue = studies, sorted: cabinet → priority → time
  const queue = useMemo(() => {
    return visible.slice().sort((a, b) => {
      const ac = a.status === "cabinet" ? 0 : 1, bc = b.status === "cabinet" ? 0 : 1;
      if (ac !== bc) return ac - bc;
      const ap = PRIORITY_ORDER[(window.RAD_CLINICAL[a.id] || {}).priority] ?? 2;
      const bp = PRIORITY_ORDER[(window.RAD_CLINICAL[b.id] || {}).priority] ?? 2;
      if (ap !== bp) return ap - bp;
      return a.time.localeCompare(b.time);
    });
  }, [visible]);

  const counts = useMemo(() => {
    const c = { total: visible.length, waiting: 0, cabinet: 0, done: 0, noshow: 0 };
    visible.forEach((p) => c[p.status]++);
    return c;
  }, [visible]);

  const filtered = queue.filter((p) => {
    if (filter === "all") return true;
    if (filter === "active") return p.status === "cabinet" || p.status === "waiting";
    return p.status === filter;
  });

  const selected = patients.find((p) => p.id === selectedId) || null;

  function setStatus(id, status) {
    const phase = status === "noshow" ? "waiting" : status; // тримаємо канбан-фазу узгодженою
    window.saveStudy(id, { status, phase });
    setPatients((ps) => ps.map((p) => p.id === id ? { ...p, status } : p));
    setStore(window.getStudyStore());
    const labels = { cabinet: "В кабінеті", waiting: "Очікує", noshow: "Не відбулось", done: "Виконано" };
    const p = patients.find((x) => x.id === id);
    push(`${p ? p.name.split(" ").slice(0, 2).join(" ") : ""} → ${labels[status] || "оновлено"} · синхронізовано`, status === "noshow" ? "warning" : status === "done" ? "success" : "info");
  }

  function saveNotes(id, notes) {
    window.saveStudy(id, { notes });
    setStore(window.getStudyStore());
  }

  const pills = [
    { key: "all", label: "Усі", ct: counts.total },
    { key: "cabinet", label: "В кабінеті", ct: counts.cabinet },
    { key: "waiting", label: "Очікують", ct: counts.waiting },
    { key: "done", label: "Виконано", ct: counts.done },
  ];

  const cito = window.getCitoPatients ? window.getCitoPatients(visible) : [];

  const activeRoom = roomFilter !== "all" && window.RF_ROOMS[roomFilter] ? window.RF_ROOMS[roomFilter] : null;

  return (
    <div className="app">
      <RadSidebar counts={counts} roomFilter={roomFilter} setRoomFilter={setRoomFilter} />
      <div className="main">
        <PageTopBar
          icon="🩺" title="Кабінет радіолога" subtitle={window.RF_TODAY + " · " + window.RAD_PROFILE.name}
          actions={<>
            <span className="rt-pill"><span className="pulse-dot g"></span>Real-time</span>
            <span className="rad-counter">Опрацьовано: <b>{counts.done}</b> / {counts.total}</span>
          </>}
        />
        <div className="rad-list-wrap">
          {cito.length > 0 && <CitoBanner patients={cito} onOpen={(id) => setSelectedId(id)} />}
          <div className="rad-queue rad-queue-single">
            <div className="rad-queue-head">
              <span className="rqh-title">{activeRoom ? activeRoom.name : "Моя черга"}</span>
              <span className="rqh-count">{filtered.length}</span>
              <div className="rad-pills">
                {pills.map((p) => (
                  <button key={p.key} className={"pill pill-sm" + (filter === p.key ? " active" : "")} onClick={() => setFilter(p.key)}>
                    {p.label}<span className="ct">{p.ct}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="rad-queue-list">
              {filtered.length === 0 ? (
                <div className="empty"><div className="et">Немає досліджень</div></div>
              ) : filtered.map((p) => (
                <RadQueueItem key={p.id} p={p} active={p.id === selectedId} onSelect={setSelectedId} />
              ))}
            </div>
          </div>
        </div>
      </div>
      {selected && (
        <div className="overlay" onMouseDown={(e) => e.target.classList.contains("overlay") && setSelectedId(null)}>
          <div className="dialog rad-dialog fade-in">
            <div className="dlg-head">
              <div className="dlg-title"><span className="tic">🩻</span>Дослідження пацієнта</div>
              <button className="icon-btn" onClick={() => setSelectedId(null)}>✕</button>
            </div>
            <div className="rad-dialog-body">
              <PatientDetail patient={selected} store={store} onStatus={setStatus} onSaveNotes={saveNotes} toast={push} />
            </div>
          </div>
        </div>
      )}
      <Toasts toasts={toasts} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<RadApp />);
