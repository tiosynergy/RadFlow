/* ===== RadFlow — Call List ===== */
const { useState, useMemo, useEffect } = React;

function clCounts(list) {
  const c = { total: list.length, pending: 0, confirmed: 0, noanswer: 0, callback: 0, refused: 0 };
  list.forEach((p) => c[p.status]++);
  return c;
}

function StatusBadge({ status }) {
  const m = window.CL_STATUS[status] || { cls: "gray", icon: "○", label: status };
  return <span className={"badge " + m.cls}>{m.icon} {m.label}</span>;
}

/* Колл-лист — це завжди записи на завтра (один день). Коротка дата DD.MM
   показується під часом, щоб поруч із годиною було видно й дату прийому. */
function clTomorrowShort() {
  var d = (window.rfAddDays && window.rfToday) ? window.rfAddDays(window.rfToday(), 1) : new Date(Date.now() + 86400000);
  return String(d.getDate()).padStart(2, "0") + "." + String(d.getMonth() + 1).padStart(2, "0");
}

function CallRow({ p, flash, expanded, onToggle, onSet, onNote, onReschedule, onEditStudies }) {
  const type = window.clStudyType(p.proc);
  // апарат кабінету (за назвою кабінету) — модель показуємо біля типу дослідження
  const room = Object.values(window.RF_ROOMS || {}).find((r) => r.name === p.room) || null;
  return (
    <div className={"clrow-wrap" + (expanded ? " open" : "")}>
      <div className={"clrow " + p.status + (flash ? " flash" : "")}>
        <button className="cl-exp-btn" onClick={() => onToggle(p.id)} title={expanded ? "Згорнути" : "Розгорнути"}>
          <span className={"cl-chev" + (expanded ? " open" : "")}>›</span>
        </button>
        <div className="cl-time tabular">{p.time}<div className="cl-date">{clTomorrowShort()}</div></div>
        <button className="cl-name cl-name-btn" onClick={() => onToggle(p.id)}>{p.name}</button>
        <div><a className="tel" href={"tel:" + p.phone.replace(/\s/g, "")}>☎ {p.phone}</a></div>
        <div className="cl-proc">{p.proc}</div>
        <div className="cl-room">{p.room}</div>
        <div><StatusBadge status={p.status} /></div>
        <div>
          <input className="note-input" placeholder="Нотатка…" value={p.note}
            onChange={(e) => onNote(p.id, e.target.value)} />
        </div>
        <div className="cl-actions">
          {p.status === "confirmed" ? (
            <>
              <span className="q-done-lab">✓ Готово</span>
              <button className="mini-icon" title="Скасувати" onClick={() => onSet(p.id, "pending")}>↩</button>
            </>
          ) : (
            <>
              <button className="btn btn-green btn-sm" title="Підтвердити" onClick={() => onSet(p.id, "confirmed")}>✓</button>
              <button className="mini-icon" title="Не відповідає" style={{ color: "var(--orange)" }} onClick={() => onSet(p.id, "noanswer")}>☏</button>
              <button className="mini-icon" title="Передзвонити" style={{ color: "#4da3ff" }} onClick={() => onSet(p.id, "callback")}>↩</button>
            </>
          )}
        </div>
      </div>
      {expanded && (
        <div className="cl-detail fade-in">
          <div className="cld-grid">
            <div className="cld-item cld-item-full"><span className="cld-lab">Пацієнт (ПІБ)</span><span className="cld-val cld-name">{p.name}</span></div>
            <div className="cld-item"><span className="cld-lab">Кабінет</span><span className="cld-val">{p.room}</span></div>
            <div className="cld-item"><span className="cld-lab">Вік</span><span className="cld-val">{p.age} р.</span></div>
            <div className="cld-item cld-item-full"><span className="cld-lab">Тип дослідження</span><span className="cld-val cld-val-wrap"><span className={"cld-type " + (type === "МРТ" ? "mrt" : "ct")}>{type}</span> {p.proc}{room && <span className="cld-machine">· {p.room} — {room.model}</span>}</span></div>
            <div className="cld-item"><span className="cld-lab">Телефон</span><span className="cld-val"><a className="tel" href={"tel:" + p.phone.replace(/\s/g, "")}>{p.phone}</a></span></div>
          </div>
          <div className="cld-actions">
            <span className="cld-lab">Дія:</span>
            <button className="btn btn-green btn-sm" onClick={() => onSet(p.id, "confirmed")}>✓ Підтвердити запис</button>
            <button className="btn btn-secondary btn-sm" onClick={() => onEditStudies(p)}>🩻 Дослідження</button>
            <button className="btn btn-primary btn-sm" onClick={() => onReschedule(p)}>🗓 Перенести на слот</button>
            <button className="btn btn-secondary btn-sm" style={{ color: "var(--orange)" }} onClick={() => onSet(p.id, "noanswer")}>☏ Не відповідає</button>
            <button className="btn btn-secondary btn-sm" style={{ color: "#4da3ff" }} onClick={() => onSet(p.id, "callback")}>↩ Передзвонити</button>
            <button className="btn btn-secondary btn-sm" style={{ color: "var(--red)" }} onClick={() => onSet(p.id, "refused")}>✕ Відмова</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* К-01: секція обдзвону постраждалих від простою — прямо на сторінці Колл-лист.
   Ті самі inline-дії, що й на дошці: ☎ Подзвонити · 🗓 Перенести · ↩ Передзвонити · ✕ Відмова.
   Колл-лист стає єдиним місцем для будь-якого обдзвону (звичайного й інцидентного). */
function IncidentCallSection({ incident, onIncStatus, onReschedule }) {
  const [openId, setOpenId] = useState(null);
  const incMeta = window.RF_INC_STATUS || {};
  const incPending = window.rfIncPending ? window.rfIncPending(incident) : 0;
  const short = (n) => n.split(" ").slice(0, 2).join(" ");

  return (
    <div className="info-banner red cl-inc-sec" style={{ flexDirection: "column", alignItems: "stretch", borderColor: "var(--red)", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="ib-ic">🔧</span>
        <span className="ib-txt" style={{ flex: 1 }}>
          <b>{incident.machineName} заблоковано</b> — {incident.reasonLabel} · простій {incident.windowLabel || (incident.fromLabel + "–" + incident.toLabel)}.{" "}
          {incPending > 0
            ? <><b>{incPending}</b> {incPending === 1 ? "пацієнт потребує" : "пацієнтів потребують"} обдзвону на перезапис — дзвоніть прямо тут.</>
            : <>Усіх постраждалих опрацьовано ✓</>}
        </span>
        <a href="radflow-incidents.html" className="btn btn-secondary btn-sm" style={{ flexShrink: 0 }}>Перерозподілити автоматично →</a>
      </div>
      {incident.patients.length === 0 ? (
        <div className="cl-inc-empty">У вікні простою активних записів не було.</div>
      ) : (
        <div className="cl-inc-list">
          {incident.patients.map((p) => {
            const cs = p.callStatus || "pending";
            const m = incMeta[cs] || { cls: "gray", label: "", icon: "" };
            const isOpen = openId === p.id;
            const done = cs === "rescheduled" || cs === "refused";
            return (
              <div className={"cl-inc-item" + (isOpen ? " open" : "") + (done ? " done" : "")} key={p.id}>
                <button className="cl-inc-row" onClick={() => setOpenId((o) => o === p.id ? null : p.id)}>
                  <span className={"cl-chev" + (isOpen ? " open" : "")}>›</span>
                  <span className="cl-inc-time tabular">{!p.isToday && <span className="bd-aff-day">{p.dayLabel}</span>}{p.time}</span>
                  <span className="cl-inc-name">{p.name} · <span style={{ color: "var(--text-muted)" }}>{p.proc}</span></span>
                  <span className={"badge " + m.cls} style={{ flexShrink: 0 }}>{m.icon} {m.label}</span>
                </button>
                {isOpen && (
                  <div className="cl-inc-detail fade-in">
                    <a className="btn btn-primary btn-sm" href={"tel:" + String(p.phone).replace(/\s/g, "")}>☎ Подзвонити {p.phone}</a>
                    <div className="cld-actions" style={{ marginTop: 8 }}>
                      <button className="btn btn-primary btn-sm" onClick={() => onReschedule({
                        patient: { name: p.name, proc: p.proc, kind: incident.kind, phone: p.phone, age: p.age },
                        onDone: (slot) => {
                          onIncStatus(p, incident, "rescheduled");
                          const isManual = window.getBookings && window.getBookings().some((b) => b.id === p.id);
                          if (!isManual && window.suppressPatient) window.suppressPatient(p.id);
                          if (window.addBookingRecord) window.addBookingRecord({ id: Date.now(), date: slot.date, time: slot.time, name: p.name, age: p.age || 40, phone: p.phone || "", proc: p.proc, dur: slot.dur, room: slot.roomKey, status: "queued", call: "pending" });
                        },
                      })}>🗓 Перенести на слот</button>
                      <button className="btn btn-secondary btn-sm" style={{ color: "#4da3ff" }} onClick={() => onIncStatus(p, incident, "callback")}>↩ Передзвонити</button>
                      <button className="btn btn-secondary btn-sm" style={{ color: "var(--red)" }} onClick={() => onIncStatus(p, incident, "refused")}>✕ Відмова</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function App() {
  const [list, setList] = useState(window.getCallList());
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [flashId, setFlashId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [incidents, setIncidents] = useState(() => (window.getIncidents ? window.getIncidents() : []));
  const [toasts, push] = useToasts();

  /* активні інциденти (поломки/ТО) — синхронно з дошкою та сторінкою інцидентів */
  useEffect(() => {
    function refresh(e) { if (e && e.type === "storage" && e.key && e.key !== window.RF_INC_KEY) return; setIncidents(window.getIncidents ? window.getIncidents() : []); }
    window.addEventListener("storage", refresh);
    window.addEventListener("rf-incident-sync", refresh);
    return () => { window.removeEventListener("storage", refresh); window.removeEventListener("rf-incident-sync", refresh); };
  }, []);
  const incPending = incidents.reduce((s, i) => s + window.rfIncPending(i), 0);
  const [resched, setResched] = useState(null); // { patient, onDone } — кого переносимо на слот
  const [editStudies, setEditStudies] = useState(null); // запис, чиї дослідження редагуємо

  function doReschedule(slot) {
    const r = resched;
    if (!r) return;
    if (r.onDone) {
      // перенос постраждалого від простою (інцидентний обдзвін) — лишається на сторінці Колл-лист
      r.onDone(slot);
    } else {
      const p = r.patient;
      setStatus(p.id, "confirmed");
      setNote(p.id, `Перенесено → ${slot.roomName} · ${slot.date} ${slot.time}`);
      // реальний перенос: створюємо запис на новому слоті у спільному сховищі
      if (window.addBookingRecord) window.addBookingRecord({ id: Date.now(), date: slot.date, time: slot.time, name: p.name, age: p.age || 40, phone: p.phone || "", proc: p.proc, dur: slot.dur, room: slot.roomKey, status: "queued", call: "pending" });
      push(`${p.name.split(" ").slice(0, 2).join(" ")} — перенесено на ${slot.roomName} · ${slot.date} ${slot.time}`, "success");
    }
    setResched(null);
  }

  /* К-01: обдзвін постраждалих від простою ведеться ПРЯМО тут (на Колл-листі) —
     дія живе там, де адмін бачить інформацію та ухвалює рішення. */
  function setIncStatus(p, incident, status) {
    if (window.setIncidentCallStatus) window.setIncidentCallStatus(p.id, status);
    setIncidents(window.getIncidents ? window.getIncidents() : []);
    if (status === "refused" && window.suppressPatient) window.suppressPatient(p.id); // відмова → запис скасовується
    const nm = p.name.split(" ").slice(0, 2).join(" ");
    const msgs = {
      callback: `${nm} — у списку «передзвонити»`,
      refused: `${nm} — відмова від перезапису`,
      rescheduled: `${nm} — перезаписано ✓`,
    };
    push(msgs[status] || "Оновлено", status === "rescheduled" ? "success" : status === "refused" ? "warning" : "info");
  }

  const counts = useMemo(() => clCounts(list), [list]);

  /* real-time: статус дзвінка змінили на дошці адміна/в іншій вкладці
     ('storage') або в межах цієї вкладки ('rf-call-sync') — перечитуємо спільне сховище */
  useEffect(() => {
    function refresh(e) {
      if (e && e.type === "storage" && e.key && e.key !== window.CL_STORAGE_KEY && e.key !== window.RF_BOOKINGS_KEY && e.key !== window.RF_CANCELLED_KEY) return;
      setList(window.getCallList());
    }
    window.addEventListener("storage", refresh);
    window.addEventListener("rf-call-sync", refresh);
    window.addEventListener("rf-booking-sync", refresh); // нові/скасовані/перенесені записи
    return () => { window.removeEventListener("storage", refresh); window.removeEventListener("rf-call-sync", refresh); window.removeEventListener("rf-booking-sync", refresh); };
  }, []);

  function flash(id) { setFlashId(id); setTimeout(() => setFlashId((f) => f === id ? null : f), 1300); }
  function toggleExpand(id) { setExpandedId((e) => e === id ? null : id); }

  function setStatus(id, status) {
    setList((l) => l.map((p) => p.id === id ? { ...p, status } : p));
    window.saveCallStatus(id, status); // синхронізація з «швидким» колл-листом на дошці
    flash(id);
    const p = list.find((x) => x.id === id);
    const nm = p ? p.name.split(" ").slice(0, 2).join(" ") : "";
    const msgs = {
      confirmed: `${nm} — підтверджено ✓ · прибрано зі швидкого колл-листа`,
      noanswer: `${nm} — не відповідає`,
      callback: `${nm} — у списку «передзвонити»`,
      refused: `${nm} — відмова`,
      pending: "Статус повернено",
    };
    push(msgs[status] || "Оновлено", status === "confirmed" ? "success" : status === "noanswer" || status === "refused" ? "warning" : "info");
  }

  function setNote(id, note) { setList((l) => l.map((p) => p.id === id ? { ...p, note } : p)); }

  function confirmAll() {
    setList((l) => l.map((p) => ({ ...p, status: "confirmed" })));
    list.forEach((p) => window.saveCallStatus(p.id, "confirmed"));
    push("Усіх пацієнтів підтверджено · Realtime-оновлення надіслано", "success");
  }

  const tabs = [
    { key: "all", label: "Всі", ct: counts.total },
    { key: "pending", label: "Ще не дзвонили", ct: counts.pending },
    { key: "callback", label: "Передзвонити", ct: counts.callback },
    { key: "noanswer", label: "Не відповідає", ct: counts.noanswer },
    { key: "confirmed", label: "Підтверджено", ct: counts.confirmed },
  ];

  const pct = (n) => counts.total ? Math.round(n / counts.total * 100) : 0;
  const stats = [
    { lab: "Всього записів", val: counts.total, pct: 100, color: "var(--text-faint)", cls: "" },
    { lab: "Підтверджено", val: counts.confirmed, pct: pct(counts.confirmed), color: "var(--green)", cls: "green" },
    { lab: "Не відповідає", val: counts.noanswer, pct: pct(counts.noanswer), color: "var(--orange)", cls: "orange" },
    { lab: "Передзвонити", val: counts.callback, pct: pct(counts.callback), color: "#4da3ff", cls: "blue" },
  ];
  const statColor = { "": "var(--text)", green: "var(--green)", orange: "var(--orange)", blue: "#4da3ff" };

  /* Сортування за пріоритетом дзвінка: зверху — ті, з ким ще треба звʼязатися
     (не дзвонили → передзвонити → не відповідає), знизу — опрацьовані
     (підтверджено, відмова). У межах групи — за часом прийому. */
  const CALL_ORDER = { pending: 0, callback: 1, noanswer: 2, confirmed: 3, refused: 4 };
  const filtered = list.filter((p) => {
    if (filter !== "all" && p.status !== filter) return false;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      if (!(p.name.toLowerCase().includes(q) || p.phone.includes(q) || p.proc.toLowerCase().includes(q))) return false;
    }
    return true;
  }).sort((a, b) => {
    const pa = CALL_ORDER[a.status] != null ? CALL_ORDER[a.status] : 9;
    const pb = CALL_ORDER[b.status] != null ? CALL_ORDER[b.status] : 9;
    if (pa !== pb) return pa - pb;
    return String(a.time).localeCompare(String(b.time));
  });

  return (
    <div className="app">
      <Sidebar active="calls" />
      <div className="main">
        <PageTopBar
          icon="☎" title="Колл-лист" subtitle={window.CL_TOMORROW}
          actions={<>
            <button className="btn btn-secondary" onClick={() => push("Колл-лист експортовано у CSV", "info")}>↧ Експорт</button>
            <button className="btn btn-primary" onClick={confirmAll}>✓ Всіх підтверджено</button>
          </>}
        />
        <div className="content-full">
          <div className="page-max">
            {incidents.map((incident) => (
              <IncidentCallSection key={incident.roomKey} incident={incident} onIncStatus={setIncStatus} onReschedule={setResched} />
            ))}
            <div className="info-banner">
              <span className="ib-ic">🤖</span>
              <span className="ib-txt"><b>WF-05 активовано</b> — сьогодні о 18:00 n8n автоматично сформував та надіслав цей колл-лист. Зателефонуйте кожному пацієнту та зафіксуйте статус.</span>
            </div>

            <div className="cl-stats">
              {stats.map((s) => (
                <div className="cl-stat" key={s.lab}>
                  <div className="lab">{s.lab}</div>
                  <div className="val tabular" style={{ color: statColor[s.cls] }}>{s.val}</div>
                  <div className="mini-bar"><div className="mini-fill" style={{ width: s.pct + "%", background: s.color }}></div></div>
                </div>
              ))}
            </div>

            <div className="qctrl">
              <div className="pills">
                {tabs.map((t) => (
                  <button key={t.key} className={"pill" + (filter === t.key ? " active" : "")} onClick={() => setFilter(t.key)}>
                    {t.label}<span className="ct">({t.ct})</span>
                  </button>
                ))}
              </div>
              <div className="spacer"></div>
              <div className="search"><span className="si">⌕</span>
                <input placeholder="Пошук…" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
            </div>

            <div className="clhead">
              <div></div><div>Час</div><div>Пацієнт</div><div>Телефон</div><div>Процедура</div>
              <div>Кабінет</div><div>Статус</div><div>Нотатка</div><div style={{ textAlign: "right" }}>Дії</div>
            </div>
            {filtered.length === 0 ? (
              <div className="empty"><div className="ei">☎</div><div className="et">Немає записів</div><div className="es">Змініть фільтр або пошук</div></div>
            ) : (
              <div className="clrows">
                {filtered.map((p) => (
                  <CallRow key={p.id} p={p} flash={flashId === p.id} expanded={expandedId === p.id}
                    onToggle={toggleExpand} onSet={setStatus} onNote={setNote} onEditStudies={setEditStudies} onReschedule={(pat) => setResched({ patient: { id: pat.id, name: pat.name, proc: pat.proc, roomName: pat.room, phone: pat.phone, age: pat.age } })} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <Toasts toasts={toasts} />
      {resched && <RescheduleModal patient={resched.patient} onClose={() => setResched(null)} onConfirm={doReschedule} />}
      {editStudies && <StudyEditModal patient={editStudies} date={window.rfAddDays(window.rfToday(), 1)} onClo