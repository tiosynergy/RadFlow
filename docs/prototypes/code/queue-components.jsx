/* ===== RadFlow — UI Components ===== */
const { useState, useEffect, useRef } = React;

/* ---------- Sidebar, Toasts, fmtTimer live in rf-shell.jsx ---------- */

/* ---------- Top bar ---------- */
function TopBar({ onRefresh, onNew, date }) {
  return (
    <header className="topbar">
      <div className="tb-title">
        <span className="tic">▦</span>
        <div>
          <h1>Дошка черги</h1>
          <div className="date">{date || window.RF_TODAY}</div>
        </div>
      </div>
      <div className="tb-right">
        <span className="rt-pill"><span className="pulse-dot g"></span>Real-time</span>
        <button className="btn btn-secondary" onClick={onRefresh}>↻ Оновити</button>
        <button className="btn btn-primary btn-lg" onClick={onNew}>＋ Новий запис</button>
      </div>
    </header>
  );
}

/* ---------- Call-list preview (за день ДО) — права колонка ---------- */
function CallListPreview({ roomView, onToast }) {
  const [openId, setOpenId] = useState(null);
  const [tick, setTick] = useState(0); // форс-оновлення після зміни статусу
  const getList = (typeof window !== "undefined" && window.getCallList) ? window.getCallList : null;
  let all = getList ? getList() : ((typeof window !== "undefined" && window.CL_PATIENTS) ? window.CL_PATIENTS : []);
  const meta = (typeof window !== "undefined" && window.CL_STATUS) ? window.CL_STATUS : {};
  const studyType = (typeof window !== "undefined" && window.clStudyType) ? window.clStudyType : ((s) => "МРТ");

  // фільтр за кабінетом: якщо обрано конкретний кабінет — лише його пацієнти
  let roomName = null;
  if (roomView && roomView !== "all" && window.RF_ROOMS && window.RF_ROOMS[roomView]) {
    roomName = window.RF_ROOMS[roomView].name;
  }
  // У «швидкому» колл-листі лишаються лише ті, кого ще треба обдзвонити (підтверджені — зникають)
  let pending = all.filter((p) => p.status !== "confirmed");
  if (roomName) pending = pending.filter((p) => p.room === roomName);
  pending = pending.slice().sort((a, b) => a.time.localeCompare(b.time)); // за чергою (часом)
  const left = pending.length;

  function toggle(id) { setOpenId((o) => o === id ? null : id); }

  function setStatus(p, status) {
    if (window.saveCallStatus) window.saveCallStatus(p.id, status);
    if (status === "confirmed") setOpenId(null); // зникне зі списку
    setTick((t) => t + 1);
    const nm = p.name.split(" ").slice(0, 2).join(" ");
    const msgs = {
      confirmed: `${nm} — підтверджено ✓ · прибрано з колл-листа`,
      noanswer: `${nm} — не відповідає`,
      callback: `${nm} — у списку «передзвонити»`,
      refused: `${nm} — відмова`,
    };
    if (onToast) onToast(msgs[status] || "Оновлено", status === "confirmed" ? "success" : status === "noanswer" || status === "refused" ? "warning" : "info");
  }

  return (
    <div className="rcard clp">
      <h3>
        <span className="hic">☎</span>Колл-лист
        <span className="clp-badge">{left}</span>
      </h3>
      <div className="clp-sub">
        {roomName ? roomName + " · обдзвін на завтра" : "Обдзвін на завтра · субота, 31 травня"}
      </div>
      {pending.length === 0 ? (
        <div className="clp-empty">
          <span className="clp-empty-ic">✓</span>
          <span>{roomName ? "Цей кабінет повністю обдзвонено" : "Усіх пацієнтів обдзвонено"}</span>
        </div>
      ) : (
        <div className="clp-list">
          {pending.map((p) => {
            const m = meta[p.status] || { cls: "gray", label: "" };
            const type = studyType(p.proc);
            const isOpen = openId === p.id;
            return (
              <div className={"clp-item" + (isOpen ? " open" : "")} key={p.id}>
                <button className="clp-row" onClick={() => toggle(p.id)}>
                  <span className={"clp-chev" + (isOpen ? " open" : "")}>›</span>
                  <span className="clp-time tabular">{p.time}</span>
                  <span className="clp-meta">
                    <span className="clp-name">{p.name}</span>
                    <span className="clp-phone-txt">{p.phone}</span>
                  </span>
                  <span className={"clp-dot " + m.cls} title={m.label}></span>
                </button>
                {isOpen && (
                  <div className="clp-detail fade-in">
                    <div className="clp-dl">
                      <span className="clp-dl-row"><span className="clp-dk">ПІБ</span><span className="clp-dv clp-dv-name">{p.name}</span></span>
                      <span className="clp-dl-row"><span className="clp-dk">Кабінет</span><span className="clp-dv">{p.room}</span></span>
                      <span className="clp-dl-row"><span className="clp-dk">Тип</span><span className="clp-dv"><span className={"cld-type " + (type === "МРТ" ? "mrt" : "ct")}>{type}</span> {p.proc}</span></span>
                      <span className="clp-dl-row"><span className="clp-dk">Вік</span><span className="clp-dv">{p.age} р.</span></span>
                      <span className="clp-dl-row"><span className="clp-dk">Статус</span><span className="clp-dv">{m.label}</span></span>
                    </div>
                    <a className="btn btn-primary btn-sm clp-call" href={"tel:" + p.phone.replace(/\s/g, "")}>☎ Подзвонити</a>
                    <div className="clp-actions">
                      <button className="btn btn-green btn-sm" onClick={() => setStatus(p, "confirmed")}>✓ Підтвердити</button>
                      <button className="btn btn-secondary btn-sm clp-act-orange" onClick={() => setStatus(p, "noanswer")}>☏ Не відповідає</button>
                      <button className="btn btn-secondary btn-sm clp-act-blue" onClick={() => setStatus(p, "callback")}>↩ Передзвонити</button>
                      <button className="btn btn-secondary btn-sm clp-act-red" onClick={() => setStatus(p, "refused")}>✕ Відмова</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <a className="btn btn-secondary clp-all" href="radflow-call-list.html">Відкрити колл-лист →</a>
    </div>
  );
}

/* ---------- Stats bar ---------- */
function StatsBar({ counts }) {
  const items = [
    { lab: "Всього сьогодні", val: counts.total, sub: "записів", cls: "white" },
    { lab: "Очікують", val: counts.waiting, sub: "пацієнтів", cls: "yellow" },
    { lab: "В кабінеті", val: counts.cabinet, sub: "зараз", cls: "blue" },
    { lab: "Виконано", val: counts.done, sub: "процедур", cls: "green" },
    { lab: "Не відбулось", val: counts.noshow, sub: "неявка/збій", cls: "red" },
  ];
  return (
    <div className="stats">
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

/* ---------- Room switcher (перехід між кабінетами) ---------- */
function RoomSwitcher({ view, setView, currentByRoom, waitingByRoom }) {
  const keys = Object.keys(window.RF_ROOMS);
  const tabs = [{ key: "all", icon: "▦", name: "Усі кабінети", sub: keys.length + " кабінети" }];
  keys.forEach((k) => {
    const r = window.RF_ROOMS[k];
    tabs.push({ key: k, icon: r.kind, name: r.name, sub: r.model });
  });
  return (
    <div className="room-switch">
      {tabs.map((t) => {
        const occ = t.key !== "all" && !!currentByRoom[t.key];
        const wait = t.key !== "all" ? (waitingByRoom[t.key] || 0) : 0;
        return (
          <button key={t.key} className={"room-tab" + (view === t.key ? " active" : "")} onClick={() => setView(t.key)}>
            <span className={"rt-ic" + (t.key !== "all" ? (window.RF_ROOMS[t.key].kind === "МРТ" ? " mrt" : " ct") : "")}>{t.icon}</span>
            <span className="rt-meta">
              <span className="rt-name">{t.name}</span>
              <span className="rt-sub">{t.sub}</span>
            </span>
            {t.key !== "all" && (
              <span className={"rt-state " + (occ ? "busy" : "free")}>{occ ? "Зайнятий" : "Вільний"}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- Compact room card (на огляді «Усі кабінети») ---------- */
function RoomStatusCard({ roomKey, patient, enteredAt, nextWaiting, onComplete, onCall, onOpen }) {
  const room = window.RF_ROOMS[roomKey];
  return (
    <div className={"room-card " + (patient ? "busy" : "free")}>
      <div className="rc-head">
        <span className={"equip-tile " + (room.kind === "МРТ" ? "mrt" : "ct")}>{room.kind}</span>
        <div className="rc-h-meta">
          <div className="rc-name">{room.name}</div>
          <div className="rc-model">{room.model}</div>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => onOpen(roomKey)}>Відкрити →</button>
      </div>
      {patient ? (
        <div className="rc-body">
          <div className="rc-tag"><span className="pulse-dot"></span>Зараз в кабінеті</div>
          <div className="rc-pat">{patient.name}</div>
          <div className="rc-proc">{patient.proc} · {patient.dur} хв · {patient.time}</div>
          <div className="rc-foot">
            <LiveTimer enteredAt={enteredAt}>{(sec) => {
              const over = sec > patient.dur * 60;
              return (
                <span className="rc-timer-wrap">
                  <span className={"rc-timer tabular" + (over ? " over" : "")}>{fmtTimer(sec)}</span>
                  <span className="rc-timer-lab">{over ? "перевищено" : "у кабінеті"}</span>
                </span>
              );
            }}</LiveTimer>
            <button className="btn btn-green btn-sm" onClick={() => onComplete(patient)}>✓ Завершити</button>
          </div>
        </div>
      ) : (
        <div className="rc-body empty">
          <div className="rc-free-row">
            <span className="rc-free-dot"></span>
            <span className="rc-free">Кабінет вільний</span>
          </div>
          {nextWaiting
            ? <button className="btn btn-primary btn-sm" onClick={() => onCall(nextWaiting)}>Викликати: {nextWaiting.name.split(" ").slice(0, 2).join(" ")} · {nextWaiting.time}</button>
            : <div className="rc-free-sub">Немає пацієнтів у черзі цього кабінету</div>}
        </div>
      )}
    </div>
  );
}

/* ---------- Current patient card ---------- */
function CurrentCard({ patient, enteredAt, roomKey, nextWaiting, onCall, onComplete, onReschedule }) {
  if (!patient) {
    const room = roomKey ? window.RF_ROOMS[roomKey] : null;
    return (
      <div className="current" style={{ background: "var(--border)", boxShadow: "none" }}>
        <div className="current-inner" style={{ background: "var(--card)", padding: "22px 24px", gap: 18 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-secondary)" }}>
              {room ? room.name + " вільний" : "Кабінет вільний"}
            </div>
            <div style={{ fontSize: 13, marginTop: 4, color: "var(--text-muted)" }}>
              {nextWaiting ? "Наступний у черзі: " + nextWaiting.name + " · " + nextWaiting.time : "Немає пацієнтів у черзі"}
            </div>
          </div>
          {nextWaiting && (
            <button className="btn btn-primary" onClick={() => onCall(nextWaiting)} style={{ flexShrink: 0 }}>Викликати наступного</button>
          )}
        </div>
      </div>
    );
  }
  const room = window.RF_ROOMS[patient.room];
  return (
    <div className="current">
      <div className="current-inner">
        <div className="cur-main">
          <div className="cur-tag"><span className="pulse-dot"></span>Зараз в кабінеті — {room.name}</div>
          <div className="cur-name">{patient.name}</div>
          <div className="cur-proc">{patient.proc} · {patient.dur} хв</div>
          <div className="cur-meta">
            <span className="mi"><b>Час:</b> {patient.time}</span>
            <span className="mi"><b>Кабінет:</b> {room.name} ({room.model})</span>
            <span className="mi"><b>Вік:</b> {patient.age} р.</span>
            <span className="mi"><b>Тел:</b> {patient.phone}</span>
          </div>
        </div>
        <div className="cur-timer">
          <LiveTimer enteredAt={enteredAt}>{(sec) => {
            const over = sec > patient.dur * 60;
            return (
              <>
                <div className="t tabular" style={over ? { color: "var(--orange)" } : null}>{fmtTimer(sec)}</div>
                <div className="tl">{over ? "перевищено час" : "хв у кабінеті"}</div>
              </>
            );
          }}</LiveTimer>
        </div>
        <div className="cur-actions">
          <button className="btn btn-green" onClick={() => onComplete(patient)}>✓ Завершити процедуру</button>
          <button className="btn btn-secondary btn-sm" onClick={() => onReschedule(patient)} style={{ justifyContent: "center" }}>Перенести</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Queue controls ---------- */
function QueueControls({ filter, setFilter, counts, query, setQuery }) {
  const pills = [
    { key: "all", label: "Усі", ct: counts.total },
    { key: "waiting", label: "Очікують", ct: counts.waiting },
    { key: "cabinet", label: "В кабінеті", ct: counts.cabinet },
    { key: "done", label: "Виконано", ct: counts.done },
    { key: "noshow", label: "Не відбулось", ct: counts.noshow },
  ];
  return (
    <div className="qctrl">
      <div className="pills">
        {pills.map((p) => (
          <button key={p.key} className={"pill" + (filter === p.key ? " active" : "")} onClick={() => setFilter(p.key)}>
            {p.label}<span className="ct">({p.ct})</span>
          </button>
        ))}
      </div>
      <div className="spacer"></div>
      <div className="search">
        <span className="si">⌕</span>
        <input placeholder="Пошук пацієнта…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
    </div>
  );
}

/* ---------- Queue row ---------- */
/* ---------- Queue row (клік розгортає панель дій; керується батьком) ---------- */
function QueueRow({ p, flash, canCall, readOnly, expanded, onToggle, onCall, onComplete, onUndo, onNoShow, onSetStatus }) {
  const meta = window.RF_STATUS_META[p.status];
  const room = window.RF_ROOMS[p.room];
  const isCito = window.isCito && window.isCito(p.id) && (p.status === "waiting" || p.status === "cabinet");

  const STATUSES = [
    { key: "waiting", label: "Очікує", cls: "gray" },
    { key: "cabinet", label: "В кабінеті", cls: "blue" },
    { key: "done", label: "Виконано", cls: "green" },
    { key: "noshow", label: "Не відбулось", cls: "red" },
  ];

  function act(fn) { return (e) => { e.stopPropagation(); fn(p); }; }

  return (
    <div className={"qrow-item " + p.status + (expanded ? " open" : "") + (flash ? " flash" : "")} data-qrow={p.id}>
      <div className="qrow" role="button" tabIndex={0} onClick={() => onToggle(p.id)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(p.id); } }}>
        <div className="q-time tabular">{p.time}<div className="td">{p.dur} хв</div></div>
        <div className="q-pat">
          <div className="nm">{isCito && <span className="cito-tag">CITO</span>}{p.name}</div>
          <div className="det">{p.age} р. · {p.phone}</div>
        </div>
        <div className="q-proc">
          <div className="pp">{p.proc}</div>
          <div className="du">{room.kind}</div>
        </div>
        <div className="q-room"><b>{room.name}</b>{room.model}</div>
        <div>
          <span className={"badge " + meta.cls}>{meta.dot && <span className="pulse-dot" style={{ width: 6, height: 6 }}></span>}{meta.label}</span>
        </div>
        <span className={"q-chev" + (expanded ? " open" : "")} aria-hidden>›</span>
      </div>

      <div className="qrow-detail-wrap">
        <div className="qrow-detail-inner">
          <div className="qrow-detail">
            <div className="qd-info">
              <span className="qd-row"><span className="qd-k">Процедура</span><span className="qd-v">{p.proc}</span></span>
              <span className="qd-row"><span className="qd-k">Кабінет</span><span className="qd-v">{room.name} · {room.model}</span></span>
              <span className="qd-row"><span className="qd-k">Час · Тривалість</span><span className="qd-v">{p.time} · {p.dur} хв</span></span>
              <span className="qd-row"><span className="qd-k">Телефон</span><a className="qd-v qd-phone" href={"tel:" + p.phone.replace(/\s/g, "")} onClick={(e) => e.stopPropagation()}>{p.phone}</a></span>
              <span className="qd-row"><span className="qd-k">Вік</span><span className="qd-v">{p.age} р.</span></span>
              <span className="qd-row"><span className="qd-k">Статус</span><span className="qd-v"><span className={"badge " + meta.cls}>{meta.label}</span></span></span>
            </div>
            <div className="qd-actions">
              {readOnly ? (
                <span className="q-readonly">{p.status === "done" ? "✓ Виконано" : "Заплановано на цей день"}</span>
              ) : (
                <>
                  {p.status === "waiting" && (
                    <>
                      <button className="btn btn-primary btn-sm" disabled={!canCall} onClick={act(onCall)} title={canCall ? "" : "Кабінет зайнятий"}>▶ Викликати в кабінет</button>
                      <button className="btn btn-secondary btn-sm" onClick={(e) => e.stopPropagation()}>▤ Перенести</button>
                      <button className="btn btn-secondary btn-sm qd-act-red" onClick={act(onNoShow)}>✕ Неявка</button>
                    </>
                  )}
                  {p.status === "cabinet" && (
                    <button className="btn btn-green btn-sm" onClick={act(onComplete)}>✓ Завершити процедуру</button>
                  )}
                  {p.status === "done" && (
                    <span className="q-done-lab">✓ Дослідження виконано</span>
                  )}
                  {p.status === "noshow" && (
                    <>
                      <span className="q-noshow-lab">✕ Не відбулось</span>
                      <button className="btn btn-secondary btn-sm" onClick={act(onUndo)}>↩ Повернути в чергу</button>
                    </>
                  )}
                </>
              )}
            </div>

            {!readOnly && onSetStatus && (
              <div className="qd-statusfix">
                <span className="qd-sf-lab">Змінити статус <span className="qd-sf-hint">(у разі помилкового натискання)</span></span>
                <div className="qd-seg">
                  {STATUSES.map((s) => (
                    <button key={s.key} className={"qd-seg-btn " + s.cls + (p.status === s.key ? " active" : "")}
                      onClick={(e) => { e.stopPropagation(); onSetStatus(p, s.key); }}>
                      <span className={"qd-seg-dot " + s.cls}></span>{s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Mini calendar (клік по дню → перехід на день) ---------- */
function MiniCalendar({ selectedDay, onSelectDay, hasChanges }) {
  const TODAY = 30;
  const dow = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
  const daysInMonth = 31;
  const startIdx = 3; // 1 травня під Чт → 30 травня = П'ятниця (узгоджено з колл-листом)
  const withDots = new Set([2, 5, 8, 12, 15, 19, 22, 26, 29, 30, 31]);
  const cells = [];
  for (let i = 0; i < startIdx; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  return (
    <div className="rcard">
      <div className="cal-head">
        <span className="cal-month">Травень 2026</span>
        <div className="cal-nav">
          <button className="mini-icon" style={{ width: 26, height: 26 }}>‹</button>
          <button className="mini-icon" style={{ width: 26, height: 26 }}>›</button>
        </div>
      </div>
      <div className="cal-grid">
        {dow.map((d) => <div className="cal-dow" key={d}>{d}</div>)}
        {cells.map((d, i) => {
          if (d === null) return <div className="cal-day empty-day" key={"e" + i}></div>;
          const isToday = d === TODAY;
          const isSel = d === selectedDay;
          const weekend = ((startIdx + d - 1) % 7) >= 5;
          return (
            <button
              className={"cal-day" + (isToday ? " today" : "") + (isSel && !isToday ? " selected" : "") + (weekend && !isToday ? " muted" : "")}
              key={d} onClick={() => onSelectDay && onSelectDay(d)}
            >
              {d}
              {withDots.has(d) && <span className="cdot"></span>}
              {hasChanges && isToday && <span className="cal-change" title="Є зміни у черзі"></span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- Room load (розгортуваний список) ---------- */
function RoomLoad({ rooms }) {
  const [open, setOpen] = useState(false);
  const avg = rooms.length ? Math.round(rooms.reduce((s, r) => s + r.pct, 0) / rooms.length) : 0;
  return (
    <div className="rcard">
      <button className={"rcard-toggle" + (open ? " open" : "")} onClick={() => setOpen((o) => !o)}>
        <span className="rct-title">Завантаженість кабінетів</span>
        <span className="rct-sum">{rooms.length} · сер. {avg}%</span>
        <span className="rct-chev">⌄</span>
      </button>
      {open && (
        <div className="load-body">
          {rooms.map((r) => (
            <div className="load-row" key={r.name}>
              <div className="load-top">
                <span className="load-name">{r.name} {r.kind}</span>
                <span className="load-pct" style={{ color: r.color }}>{r.pct}%</span>
              </div>
              <div className="load-bar"><div className="load-fill" style={{ width: r.pct + "%", background: r.color }}></div></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Quick actions ---------- */
function QuickActions({ onNew }) {
  return (
    <div className="rcard">
      <h3>Швидкі дії</h3>
      <div className="qa-stack">
        <button className="btn btn-primary" onClick={onNew}>＋ Новий запис</button>
        <button className="btn btn-secondary">☎ Колл-лист</button>
        <button className="btn btn-secondary">⚠ Інцидент</button>
      </div>
    </div>
  );
}

Object.assign(window, {
  TopBar, StatsBar, CurrentCard, QueueControls, QueueRow,
  MiniCalendar, RoomLoad, QuickActions, RoomSwitcher, RoomStatusCard, CallListPreview,
});
