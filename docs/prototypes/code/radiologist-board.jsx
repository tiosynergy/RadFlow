/* ===== RadFlow — Radiologist Kanban Board (Дошка) ===== */
const { useState: useStateB } = React;

/* ---------- Stats bar ---------- */
function RadBoardStats({ studies }) {
  const active = studies.filter((p) => p.status !== "done" && p.status !== "noshow");
  const urgent = active.filter((p) => {
    const pr = (window.RAD_CLINICAL[p.id] || {}).priority;
    return pr === "cito" || pr === "urgent";
  }).length;
  const waiting = studies.filter((p) => p.status === "waiting");
  const avgWait = waiting.length ? Math.round(waiting.reduce((s, p) => s + window.radWaitMin(p), 0) / waiting.length) : 0;
  const done = studies.filter((p) => window.radPhase(p) === "done").length;
  const items = [
    { lab: "У черзі (активні)", val: active.length, cls: "white", sub: "досліджень" },
    { lab: "Термінових", val: urgent, cls: "red", sub: "CITO + терміново" },
    { lab: "Сер. час очікування", val: avgWait + " хв", cls: avgWait > 60 ? "red" : avgWait >= 30 ? "yellow" : "green", sub: "по черзі" },
    { lab: "Виконано сьогодні", val: done, cls: "green", sub: "підписано / закрито" },
  ];
  return (
    <div className="stats rb-stats">
      {items.map((s) => (
        <div className="stat" key={s.lab}>
          <div className="lab">{s.lab}</div>
          <div className={"val tabular " + s.cls}>{s.val}</div>
          <div className="sub">{s.sub}</div>
        </div>
      ))}
    </div>
  );
}

/* ---------- Filters ---------- */
function RadBoardFilters({ q, setQ, modality, setModality, priority, setPriority, overdue, setOverdue }) {
  return (
    <div className="rb-filters">
      <div className="search rb-search">
        <span className="si">⌕</span>
        <input placeholder="Пошук: пацієнт, № дослідження…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="rb-fgroup">
        <span className="rb-flab">Модальність</span>
        {["all", "МРТ", "КТ"].map((m) => (
          <button key={m} className={"pill pill-sm" + (modality === m ? " active" : "")} onClick={() => setModality(m)}>{m === "all" ? "Усі" : m}</button>
        ))}
      </div>
      <div className="rb-fgroup">
        <span className="rb-flab">Пріоритет</span>
        {[["all", "Усі"], ["cito", "CITO"], ["urgent", "Терм."], ["planned", "План."]].map(([k, l]) => (
          <button key={k} className={"pill pill-sm" + (priority === k ? " active" : "")} onClick={() => setPriority(k)}>{l}</button>
        ))}
      </div>
      <button className={"pill pill-sm" + (overdue ? " active" : "")} onClick={() => setOverdue((o) => !o)} title="Лише прострочені (&gt;60 хв)">⚠ Прострочені</button>
    </div>
  );
}

/* ---------- Study card ---------- */
function StudyCard({ p, onDragStart, onOpen, onMove }) {
  const cl = window.RAD_CLINICAL[p.id] || {};
  const doc = (window.RF_DOCTORS || []).find((d) => d.id === cl.docId);
  const type = window.studyType(p.proc);
  const prio = window.RAD_PRIORITY[cl.priority] || window.RAD_PRIORITY.planned;
  const g = window.radGender(p.name);
  const phase = window.radPhase(p);
  const waitMin = window.radWaitMin(p);
  const waitColor = window.radWaitColor(waitMin);
  const signed = (window.getStudyStore()[p.id] || {}).protocol && window.getStudyStore()[p.id].protocol.signed;

  // next action by phase
  const nextByPhase = { waiting: ["cabinet", "▶ Взяти в роботу"], cabinet: ["ready", "✎ На опис"], ready: ["done", "✓ Завершити"] };
  const next = nextByPhase[phase];

  return (
    <div className={"sc prio-" + (cl.priority || "planned")} draggable onDragStart={(e) => onDragStart(e, p.id)}>
      <div className="sc-top">
        <span className={"sc-tile " + (type === "МРТ" ? "mrt" : "ct")}>{type}</span>
        <div className="sc-id">
          <span className="sc-acc tabular">{window.radAccession(p.id)}</span>
          <span className="sc-time tabular">{p.time}</span>
        </div>
        {cl.priority && cl.priority !== "planned" && <span className={"rq-prio " + prio.cls}>{prio.label}</span>}
      </div>
      <div className="sc-name">{p.name}</div>
      <div className="sc-demo">{p.age} р. · {g.label} · {window.RF_ROOMS[p.room].name}</div>
      <div className="sc-study">{p.proc}{cl.region ? " · " + cl.region : ""}</div>
      {cl.indication && <div className="sc-q" title={cl.indication}>❓ {cl.indication}</div>}
      <div className="sc-foot">
        {p.status === "waiting"
          ? <span className={"sc-wait " + waitColor}>◷ {waitMin} хв очікує</span>
          : <span className="sc-wait neutral">{signed ? "🔏 Підписано" : (phase === "ready" ? "✎ Очікує опису" : phase === "done" ? "✓ Готово" : "▶ Сканування")}</span>}
        {cl.contrast && <span className="sc-contrast">+ контраст</span>}
      </div>
      <div className="sc-actions">
        {next && <button className="btn btn-secondary btn-sm sc-next" onClick={() => onMove(p.id, next[0])}>{next[1]}</button>}
        <button className="btn btn-primary btn-sm" onClick={() => onOpen(p.id)}>Відкрити →</button>
      </div>
    </div>
  );
}

/* ---------- Column ---------- */
function KanbanColumn({ col, studies, onDragStart, onDropCard, onOpen, onMove, dragOver, setDragOver }) {
  return (
    <div
      className={"kc" + (dragOver === col.key ? " drop" : "")}
      onDragOver={(e) => { e.preventDefault(); setDragOver(col.key); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(null); }}
      onDrop={(e) => { e.preventDefault(); onDropCard(col.key); setDragOver(null); }}
    >
      <div className="kc-head">
        <span className={"kc-dot " + col.cls}></span>
        <span className="kc-title">{col.label}</span>
        <span className="kc-count">{studies.length}</span>
      </div>
      <div className="kc-list">
        {studies.length === 0 ? (
          <div className="kc-empty">Перетягніть сюди картку</div>
        ) : studies.map((p) => (
          <StudyCard key={p.id} p={p} onDragStart={onDragStart} onOpen={onOpen} onMove={onMove} />
        ))}
      </div>
    </div>
  );
}

/* ---------- Board ---------- */
function RadBoard({ studies, onMove, onOpen }) {
  const [q, setQ] = useStateB("");
  const [modality, setModality] = useStateB("all");
  const [priority, setPriority] = useStateB("all");
  const [overdue, setOverdue] = useStateB(false);
  const [dragId, setDragId] = useStateB(null);
  const [dragOver, setDragOver] = useStateB(null);

  function onDragStart(e, id) { setDragId(id); e.dataTransfer.effectAllowed = "move"; }
  function onDropCard(phase) { if (dragId != null) { onMove(dragId, phase); setDragId(null); } }

  const filtered = studies.filter((p) => {
    if (p.status === "noshow") return false;
    if (modality !== "all" && window.studyType(p.proc) !== modality) return false;
    const pr = (window.RAD_CLINICAL[p.id] || {}).priority || "planned";
    if (priority !== "all" && pr !== priority) return false;
    if (overdue && !(p.status === "waiting" && window.radWaitMin(p) > 60)) return false;
    if (q.trim()) {
      const s = q.trim().toLowerCase();
      if (!(p.name.toLowerCase().includes(s) || window.radAccession(p.id).toLowerCase().includes(s) || p.proc.toLowerCase().includes(s))) return false;
    }
    return true;
  });

  const byCol = {};
  window.RAD_COLUMNS.forEach((c) => { byCol[c.key] = []; });
  filtered.forEach((p) => {
    const ph = window.radPhase(p);
    (byCol[ph] || byCol.waiting).push(p);
  });
  // sort each column: priority then time
  const PO = { cito: 0, urgent: 1, planned: 2 };
  Object.keys(byCol).forEach((k) => byCol[k].sort((a, b) => {
    const ap = PO[(window.RAD_CLINICAL[a.id] || {}).priority] ?? 2, bp = PO[(window.RAD_CLINICAL[b.id] || {}).priority] ?? 2;
    return ap !== bp ? ap - bp : a.time.localeCompare(b.time);
  }));

  return (
    <div className="rb">
      <RadBoardStats studies={studies} />
      <RadBoardFilters q={q} setQ={setQ} modality={modality} setModality={setModality} priority={priority} setPriority={setPriority} overdue={overdue} setOverdue={setOverdue} />
      <div className="kanban">
        {window.RAD_COLUMNS.map((col) => (
          <KanbanColumn key={col.key} col={col} studies={byCol[col.key] || []}
            onDragStart={onDragStart} onDropCard={onDropCard} onOpen={onOpen} onMove={onMove}
            dragOver={dragOver} setDragOver={setDragOver} />
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { RadBoard });
