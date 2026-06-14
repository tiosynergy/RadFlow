/* ===== RadFlow — Call List ===== */
const { useState, useMemo } = React;

function clCounts(list) {
  const c = { total: list.length, pending: 0, confirmed: 0, noanswer: 0, callback: 0, refused: 0 };
  list.forEach((p) => c[p.status]++);
  return c;
}

function StatusBadge({ status }) {
  const m = window.CL_STATUS[status];
  return <span className={"badge " + m.cls}>{m.icon} {m.label}</span>;
}

function CallRow({ p, flash, expanded, onToggle, onSet, onNote }) {
  const type = window.clStudyType(p.proc);
  return (
    <div className={"clrow-wrap" + (expanded ? " open" : "")}>
      <div className={"clrow " + p.status + (flash ? " flash" : "")}>
        <button className="cl-exp-btn" onClick={() => onToggle(p.id)} title={expanded ? "Згорнути" : "Розгорнути"}>
          <span className={"cl-chev" + (expanded ? " open" : "")}>›</span>
        </button>
        <div className="cl-time tabular">{p.time}</div>
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
            <div className="cld-item cld-item-full"><span className="cld-lab">Тип дослідження</span><span className="cld-val cld-val-wrap"><span className={"cld-type " + (type === "МРТ" ? "mrt" : "ct")}>{type}</span> {p.proc}</span></div>
            <div className="cld-item"><span className="cld-lab">Телефон</span><span className="cld-val"><a className="tel" href={"tel:" + p.phone.replace(/\s/g, "")}>{p.phone}</a></span></div>
          </div>
          <div className="cld-actions">
            <span className="cld-lab">Дія:</span>
            <button className="btn btn-green btn-sm" onClick={() => onSet(p.id, "confirmed")}>✓ Підтвердити запис</button>
            <button className="btn btn-secondary btn-sm" style={{ color: "var(--orange)" }} onClick={() => onSet(p.id, "noanswer")}>☏ Не відповідає</button>
            <button className="btn btn-secondary btn-sm" style={{ color: "#4da3ff" }} onClick={() => onSet(p.id, "callback")}>↩ Передзвонити</button>
            <button className="btn btn-secondary btn-sm" style={{ color: "var(--red)" }} onClick={() => onSet(p.id, "refused")}>✕ Відмова</button>
          </div>
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
  const [toasts, push] = useToasts();

  const counts = useMemo(() => clCounts(list), [list]);

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

  const stats = [
    { lab: "Всього записів", val: counts.total, pct: 100, color: "var(--text-faint)", cls: "" },
    { lab: "Підтверджено", val: counts.confirmed, pct: Math.round(counts.confirmed/counts.total*100), color: "var(--green)", cls: "green" },
    { lab: "Не відповідає", val: counts.noanswer, pct: Math.round(counts.noanswer/counts.total*100), color: "var(--orange)", cls: "orange" },
    { lab: "Передзвонити", val: counts.callback, pct: Math.round(counts.callback/counts.total*100), color: "#4da3ff", cls: "blue" },
  ];
  const statColor = { "": "var(--text)", green: "var(--green)", orange: "var(--orange)", blue: "#4da3ff" };

  const filtered = list.filter((p) => {
    if (filter !== "all" && p.status !== filter) return false;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      if (!(p.name.toLowerCase().includes(q) || p.phone.includes(q) || p.proc.toLowerCase().includes(q))) return false;
    }
    return true;
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
                    onToggle={toggleExpand} onSet={setStatus} onNote={setNote} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <Toasts toasts={toasts} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
