/* ===== RadFlow — UI Components ===== */
const { useState, useEffect, useRef } = React;

/* ---------- Sidebar, Toasts, fmtTimer live in rf-shell.jsx ---------- */

/* ---------- Top bar ---------- */
function TopBar({ onRefresh, onNew, onBreakdown, date, simOn, onToggleSim }) {
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
        {onToggleSim && (
          <button
            className={"btn btn-sm " + (simOn ? "btn-secondary" : "btn-ghost")}
            onClick={onToggleSim}
            title="Симуляція потоку пацієнтів у реальному часі"
            style={simOn ? { color: "var(--green)", borderColor: "var(--green)" } : null}
          >
            <span className="pulse-dot" style={{ background: simOn ? "var(--green)" : "var(--text-muted)", width: 7, height: 7, marginRight: 6 }}></span>
            {simOn ? "Потік: Live" : "Потік: пауза"}
          </button>
        )}
        <button className="btn btn-secondary" onClick={onRefresh}>↻ Оновити</button>
        {onBreakdown && (
          <button className="btn btn-breakdown" onClick={onBreakdown} title="Зафіксувати поломку або технічне обслуговування апарата">
            🔧 Поломка / ТО
          </button>
        )}
        <button className="btn btn-primary btn-lg" onClick={onNew}>＋ Новий запис</button>
      </div>
    </header>
  );
}

/* ---------- Call-list preview (за день ДО) — права колонка ---------- */
function CallListPreview({ roomView, onToast, incidents, onIncStatus }) {
  const [openId, setOpenId] = useState(null);
  const [tick, setTick] = useState(0); // форс-оновлення після зміни статусу
  const [resched, setResched] = useState(null); // { patient, onDone } для перенесення на слот
  const short = (n) => n.split(" ").slice(0, 2).join(" ");

  /* real-time: статус дзвінка змінили на іншій вкладці ('storage') або
     в межах цієї ('rf-call-sync') — перечитуємо спільне сховище */
  useEffect(() => {
    function refresh(e) { if (e && e.type === "storage" && e.key && e.key !== window.CL_STORAGE_KEY) return; setTick((t) => t + 1); }
    window.addEventListener("storage", refresh);
    window.addEventListener("rf-call-sync", refresh);
    return () => { window.removeEventListener("storage", refresh); window.removeEventListener("rf-call-sync", refresh); };
  }, []);
  const getList = (typeof window !== "undefined" && window.getCallList) ? window.getCallList : null;
  let all = getList ? getList() : ((typeof window !== "undefined" && window.CL_PATIENTS) ? window.CL_PATIENTS : []);
  const meta = (typeof window !== "undefined" && window.CL_STATUS) ? window.CL_STATUS : {};
  const studyType = (typeof window !== "undefined" && window.clStudyType) ? window.clStudyType : ((s) => (s || "").trim().toUpperCase().indexOf("КТ") === 0 ? "КТ" : "МРТ");

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

  /* --- Автоматичний колл-лист через поломку/ТО (Проблема 1) — по одній панелі на інцидент --- */
  const incMeta = (typeof window !== "undefined" && window.RF_INC_STATUS) ? window.RF_INC_STATUS : {};
  const incList = incidents || [];

  return (
    <React.Fragment>
    {incList.map((incident) => {
      const incPending = window.rfIncPending ? window.rfIncPending(incident) : 0;
      return (
      <div className="rcard clp clp-inc" key={incident.roomKey}>
        <h3>
          <span className="hic hic-red">🔧</span>Обдзвін через простій
          <span className="clp-badge clp-badge-red">{incPending}</span>
        </h3>
        <div className="clp-sub clp-inc-sub">
          {incPending > 0
            ? <span><b>{incPending}</b> {incPending === 1 ? "пацієнт потребує" : "пацієнтів потребують"} обдзвону на перезапис</span>
            : <span>Усіх постраждалих пацієнтів опрацьовано ✓</span>}
        </div>
        <div className="clp-inc-ctx">
          {incident.kind === "МРТ" ? "🧲" : "💠"} {incident.machineName} · {incident.model}<br />
          {incident.reasonLabel} · простій {incident.windowLabel || (incident.fromLabel + "–" + incident.toLabel)}
        </div>
        {incident.patients.length === 0 ? (
          <div className="clp-empty"><span className="clp-empty-ic">✓</span><span>У вікні простою записів немає</span></div>
        ) : (
          <div className="clp-list">
            {incident.patients.map((p) => {
              const cs = p.callStatus || "pending";
              const m = incMeta[cs] || { cls: "gray", label: "" };
              const isOpen = openId === ("inc-" + p.id);
              const done = cs === "rescheduled" || cs === "refused";
              return (
                <div className={"clp-item" + (isOpen ? " open" : "") + (done ? " clp-done" : "")} key={"inc-" + p.id}>
                  <button className="clp-row" onClick={() => toggle("inc-" + p.id)}>
                    <span className={"clp-chev" + (isOpen ? " open" : "")}>›</span>
                    <span className="clp-time tabular">{p.time}</span>
                    <span className="clp-meta">
                      <span className="clp-name">{!p.isToday && <span className="bd-aff-day">{p.dayLabel}</span>}{p.name}</span>
                      <span className="clp-phone-txt">{p.phone} · {m.label}</span>
                    </span>
                    <span className={"clp-dot " + m.cls} title={m.label}></span>
                  </button>
                  {isOpen && (
                    <div className="clp-detail fade-in">
                      <div className="clp-dl">
                        <span className="clp-dl-row"><span className="clp-dk">ПІБ</span><span className="clp-dv clp-dv-name">{p.name}</span></span>
                        <span className="clp-dl-row"><span className="clp-dk">Дослідження</span><span className="clp-dv">{p.proc}</span></span>
                        <span className="clp-dl-row"><span className="clp-dk">Був час</span><span className="clp-dv tabular">{p.time}</span></span>
                        <span className="clp-dl-row"><span className="clp-dk">Статус</span><span className="clp-dv">{m.label}</span></span>
                      </div>
                      <a className="btn btn-primary btn-sm clp-call" href={"tel:" + String(p.phone).replace(/\s/g, "")}>☎ Подзвонити</a>
                      <div className="clp-actions">
                        <button className="btn btn-primary btn-sm" onClick={() => setResched({ patient: { name: p.name, proc: p.proc, kind: incident.kind, phone: p.phone, age: p.age }, onDone: (slot) => { onIncStatus && onIncStatus(p, "rescheduled"); if (window.addBookingRecord) window.addBookingRecord({ id: Date.now(), date: slot.date, time: slot.time, name: p.name, age: p.age || 40, phone: p.phone || "", proc: p.proc, dur: slot.dur, room: slot.roomKey, status: "queued", call: "pending" }); onToast && onToast(`${short(p.name)} — перенесено на ${slot.roomName} · ${slot.date} ${slot.time}`, "success"); } })}>🗓 Перенести</button>
                        <button className="btn btn-secondary btn-sm clp-act-blue" onClick={() => onIncStatus && onIncStatus(p, "callback")}>↩ Передзвонити</button>
                        <button className="btn btn-secondary btn-sm clp-act-red" onClick={() => onIncStatus && onIncStatus(p, "refused")}>✕ Відмова</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <a className="btn btn-secondary clp-all" href="radflow-incidents.html">Перерозподілити автоматично →</a>
      </div>
      );
    })}
    <div className="rcard clp">
      <h3>
        <span className="hic">☎</span>Колл-лист
        <span className="clp-badge">{left}</span>
      </h3>
      <div className="clp-sub">
        {roomName ? roomName + " · обдзвін на завтра" : ("Обдзвін на завтра · " + (window.rfFmtFull && window.rfAddDays && window.rfToday ? window.rfFmtFull(window.rfAddDays(window.rfToday(), 1)) : ""))}
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
                      <button className="btn btn-secondary btn-sm clp-act-blue" onClick={() => setResched({ patient: { name: p.name, proc: p.proc, roomName: p.room, phone: p.phone, age: p.age }, onDone: (slot) => { setStatus(p, "confirmed"); if (window.addBookingRecord) window.addBookingRecord({ id: Date.now(), date: slot.date, time: slot.time, name: p.name, age: p.age || 40, phone: p.phone || "", proc: p.proc, dur: slot.dur, room: slot.roomKey, status: "queued", call: "pending" }); onToast && onToast(`${short(p.name)} — перенесено на ${slot.roomName} · ${slot.date} ${slot.time}`, "success"); } })}>🗓 Перенести</button>
                      <button className="btn btn-secondary btn-sm clp-act-orange" onClick={() => setStatus(p, "noanswer")}>☏ Не відповідає</button>
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
    {resched && <RescheduleModal patient={resched.patient} onClose={() => setResched(null)} onConfirm={(slot) => { resched.onDone(slot); setResched(null); }} />}
    </React.Fragment>
  );
}

/* ---------- Stats bar ---------- */
/* Велика статистика = активні фільтри черги (маленькі пілюлі більше не потрібні).
   Клік по картці фільтрує чергу за відповідним статусом; «Всього сьогодні» = усі. */
function StatsBar({ counts, filter, setFilter }) {
  const items = [
    { key: "all", lab: "Всього сьогодні", val: counts.total, sub: "записів", cls: "white" },
    { key: "queued", lab: "В черзі", val: counts.queued, sub: "записані", cls: "gray" },
    { key: "waiting", lab: "Очікують", val: counts.waiting, sub: "прийшли", cls: "yellow" },
    { key: "cabinet", lab: "В кабінеті", val: counts.cabinet, sub: "зараз", cls: "blue" },
    { key: "done", lab: "Виконано", val: counts.done, sub: "процедур", cls: "green" },
    { key: "noshow", lab: "Не відбулось", val: counts.noshow, sub: "неявка/збій", cls: "red" },
  ];
  const clickable = typeof setFilter === "function";
  return (
    <div className="stats">
      {items.map((s) => (
        <div
          className={"stat" + (clickable ? " clickable" : "") + (clickable && filter === s.key ? " active" : "")}
          key={s.key}
          role={clickable ? "button" : undefined}
          tabIndex={clickable ? 0 : undefined}
          aria-pressed={clickable ? (filter === s.key) : undefined}
          onClick={clickable ? () => setFilter(s.key) : undefined}
          onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFilter(s.key); } } : undefined}
          title={clickable ? "Показати: " + s.lab : undefined}
        >
          <div className="lab">{s.lab}</div>
          <div className={"val tabular " + s.cls}>{s.val}</div>
          <div className="sub">{s.sub}</div>
        </div>
      ))}
    </div>
  );
}

/* ---------- Compact room card (на огляді «Усі кабінети») ---------- */
function RoomStatusCard({ roomKey, patient, enteredAt, nextWaiting, blocked, onUnblock, onComplete, onCall, onOpen }) {
  const room = window.RF_ROOMS[roomKey];
  if (blocked) {
    const pend = window.rfIncPending ? window.rfIncPending(blocked) : 0;
    return (
      <div className="room-card blocked-card">
        <div className="rc-head">
          <span className={"equip-tile " + (room.kind === "МРТ" ? "mrt" : "ct")}>{room.kind}</span>
          <div className="rc-h-meta">
            <div className="rc-name">{room.name}</div>
            <div className="rc-model">{room.model}</div>
          </div>
          <span className="badge red">🔒 Заблоковано</span>
        </div>
        <div className="rc-body">
          <div className="rc-blocked-reason">🔧 {blocked.reasonLabel} · простій {blocked.windowLabel || (blocked.fromLabel + "–" + blocked.toLabel)}</div>
          <div className="rc-blocked-calls">{pend > 0 ? `☎ ${pend} на обдзвін для перезапису` : "✓ усіх постраждалих опрацьовано"}</div>
          <div className="rc-foot">
            <span className="rc-blocked-hint">Нові виклики призупинено</span>
            <button className="btn btn-green btn-sm" onClick={onUnblock}>🔓 Розблокувати</button>
          </div>
        </div>
      </div>
    );
  }
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
        <div className="rc-body rc-body-busy">
          <div className="rc-brow">
            <span className="rc-pat"><span className="pulse-dot"></span>{patient.name}</span>
            <LiveTimer enteredAt={enteredAt}>{(sec) => {
              const over = sec > patient.dur * 60;
              return (
                <span className={"rc-timer tabular" + (over ? " over" : "")} title={over ? "Час перевищено" : "Зараз в кабінеті"}>{fmtTimer(sec)}</span>
              );
            }}</LiveTimer>
          </div>
          <div className="rc-brow">
            <span className="rc-proc" title={patient.proc + " · " + patient.dur + " хв · " + patient.time}>{patient.proc} · {patient.dur} хв · {patient.time}</span>
            <button className="btn btn-green btn-sm" onClick={() => onComplete(patient)}>✓ Завершити</button>
          </div>
        </div>
      ) : (
        <div className="rc-body empty">
          <div className="rc-free-row">
            <span className="rc-free-dot"></span>
            <span className="rc-free">Кабінет вільний</span>
          </div>
          {nextWaiting &&
            <button className="btn btn-primary btn-sm" onClick={() => onCall(nextWaiting)}>Викликати: {nextWaiting.name.split(" ").slice(0, 2).join(" ")} · {nextWaiting.time}</button>}
        </div>
      )}
    </div>
  );
}

/* ---------- Current patient card ---------- */
function CurrentCard({ patient, enteredAt, roomKey, nextWaiting, blocked, onUnblock, onCall, onComplete, onReschedule }) {
  if (blocked) {
    const room = window.RF_ROOMS[roomKey];
    const pend = window.rfIncPending ? window.rfIncPending(blocked) : 0;
    return (
      <div className="current" style={{ background: "var(--red)", boxShadow: "none" }}>
        <div className="current-inner" style={{ background: "var(--card)", padding: "22px 24px", gap: 18, alignItems: "center" }}>
          <span className="equip-tile mrt" style={{ background: "var(--red-bg)", color: "var(--red)", flexShrink: 0 }}>🔒</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--red)" }}>{room ? room.name : "Кабінет"} заблоковано</div>
            <div style={{ fontSize: 13, marginTop: 4, color: "var(--text-secondary)" }}>
              🔧 {blocked.reasonLabel} · простій {blocked.windowLabel || (blocked.fromLabel + "–" + blocked.toLabel)}
              {" · "}{pend > 0 ? `☎ ${pend} на обдзвін` : "усіх опрацьовано ✓"}
            </div>
          </div>
          <button className="btn btn-green" onClick={onUnblock} style={{ flexShrink: 0 }}>🔓 Розблокувати</button>
        </div>
      </div>
    );
  }
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
/* Фільтри-пілюлі прибрано — їхній функціонал тепер у великих картках StatsBar.
   Лишається тільки пошук. */
function QueueControls({ query, setQuery }) {
  return (
    <div className="qctrl">
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
function QueueRow({ p, date, flash, canCall, readOnly, canReschedule, expanded, rescheduling, roomBlocked, onToggle, onCall, onComplete, onArrive, onUndo, onNoShow, onSetStatus, onReschedule, onCancel, onSetCall, onEditStudies }) {
  const meta = window.RF_STATUS_META[p.status];
  const room = window.RF_ROOMS[p.room];
  const isCito = window.isCito && window.isCito(p.id) && (p.status === "queued" || p.status === "waiting" || p.status === "cabinet");
  // статус дзвінка зі СПІЛЬНОГО сховища (синхронізується з колл-листом у реальному часі)
  const callStatus = window.getCallStatusFor ? window.getCallStatusFor(p.id, p.call) : p.call;
  const callMeta = (window.CL_STATUS && callStatus) ? window.CL_STATUS[callStatus] : null;

  const STATUSES = [
    { key: "queued", label: "В черзі", cls: "gray" },
    { key: "waiting", label: "Очікує", cls: "yellow" },
    { key: "cabinet", label: "В кабінеті", cls: "blue" },
    { key: "done", label: "Виконано", cls: "green" },
    { key: "noshow", label: "Не відбулось", cls: "red" },
  ];
  const CALL_STATUSES = [
    { key: "confirmed", label: "Підтверджено", cls: "green" },
    { key: "callback", label: "Передзвонити", cls: "blue" },
    { key: "noanswer", label: "Не відповідає", cls: "orange" },
    { key: "refused", label: "Відмова", cls: "red" },
    { key: "pending", label: "Не дзвонили", cls: "gray" },
  ];

  function act(fn) { return (e) => { e.stopPropagation(); fn(p); }; }

  return (
    <div className={"qrow-item " + p.status + (expanded ? " open" : "") + (flash ? " flash" : "") + (rescheduling ? " rescheduling" : "")} data-qrow={p.id}>
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
        <div className="q-status-cell">
          <span className={"badge " + meta.cls}>{meta.dot && <span className="pulse-dot" style={{ width: 6, height: 6 }}></span>}{meta.label}</span>
          {rescheduling && <span className="badge red q-resched-badge" title="Апарат заблоковано — пацієнт у колл-листі на перезапис">🔧 Перезапис</span>}
        </div>
        <span className={"q-chev" + (expanded ? " open" : "")} aria-hidden>›</span>
      </div>

      <div className="qrow-detail-wrap">
        <div className="qrow-detail-inner">
          <div className="qrow-detail">
            <div className="qd-info">
              <span className="qd-row"><span className="qd-k">Процедура</span><span className="qd-v">{p.proc}</span></span>
              <span className="qd-row"><span className="qd-k">Кабінет</span><span className="qd-v">{room.name} · {room.model}</span></span>
              {date && <span className="qd-row"><span className="qd-k">Дата</span><span className="qd-v">{window.rfFmtFull ? window.rfFmtFull(date) : ""}</span></span>}
              <span className="qd-row"><span className="qd-k">Час · Тривалість</span><span className="qd-v">{p.time} · {p.dur} хв</span></span>
              <span className="qd-row"><span className="qd-k">Телефон</span><a className="qd-v qd-phone" href={"tel:" + p.phone.replace(/\s/g, "")} onClick={(e) => e.stopPropagation()}>{p.phone}</a></span>
              <span className="qd-row"><span className="qd-k">Вік</span><span className="qd-v">{p.age} р.</span></span>
              <span className="qd-row"><span className="qd-k">Вага</span><span className="qd-v">{(() => { const w = p.weight || ((window.RAD_CLINICAL && window.RAD_CLINICAL[p.id]) || {}).weight; return w ? w + " кг" : "—"; })()}</span></span>
              <span className="qd-row"><span className="qd-k">Статус</span><span className="qd-v"><span className={"badge " + meta.cls}>{meta.label}</span></span></span>
              <span className="qd-row"><span className="qd-k">Дзвінок-підтвердження</span><span className="qd-v qd-v-call">{callMeta
                ? <span className={"qd-call " + callMeta.cls} title="Статус підтвердження по колл-листу напередодні">{callMeta.icon} {callMeta.label}</span>
                : <span className="qd-call gray">○ Не дзвонили</span>}
                {/* К-06: подзвонити й підтвердити прямо тут, де видно статус дзвінка */}
                {onSetCall && p.status !== "done" && p.status !== "noshow" && callStatus !== "confirmed" && (
                  <span className="qd-call-quick">
                    <a className="qd-call-tel" href={"tel:" + p.phone.replace(/\s/g, "")} onClick={(e) => e.stopPropagation()} title={"Подзвонити: " + p.phone}>☎</a>
                    <button className="btn btn-green btn-xs" onClick={(e) => { e.stopPropagation(); onSetCall(p, "confirmed"); }} title="Позначити дзвінок як підтверджений">✓ Підтвердити</button>
                  </span>
                )}</span></span>
            </div>
            <div className="qd-actions">
              {onEditStudies && p.status !== "done" && p.status !== "noshow" && <button className="btn btn-secondary btn-sm" onClick={act(onEditStudies)}>🩻 Дослідження</button>}
              {readOnly ? (
                <>
                  <span className="q-readonly">{p.status === "done" ? "✓ Виконано" : p.status === "noshow" ? "✕ Не відбулось" : "Заплановано на цей день"}</span>
                  {canReschedule && p.status !== "done" && p.status !== "noshow" && (
                    <>
                      <button className="btn btn-secondary btn-sm" onClick={act(onReschedule)}>🗓 Перенести на слот</button>
                      <button className="btn btn-secondary btn-sm qd-act-red" onClick={act(onCancel)}>✕ Скасувати запис</button>
                    </>
                  )}
                  {canReschedule && p.status === "noshow" && (
                    <button className="btn btn-secondary btn-sm" onClick={act(onUndo)}>↩ Повернути в чергу</button>
                  )}
                </>
              ) : (
                <>
                  {p.status === "queued" && (
                    <>
                      <button className="btn btn-primary btn-sm" onClick={act(onArrive)}>✓ Пацієнт прийшов</button>
                      <button className="btn btn-secondary btn-sm" onClick={act(onReschedule)}>🗓 Перенести на слот</button>
                      <button className="btn btn-secondary btn-sm qd-act-red" onClick={act(onCancel)}>✕ Скасувати запис</button>
                      <button className="btn btn-secondary btn-sm qd-act-red" onClick={act(onNoShow)}>✕ Неявка</button>
                    </>
                  )}
                  {p.status === "waiting" && (
                    <>
                      <button className="btn btn-primary btn-sm" disabled={!canCall} onClick={act(onCall)} title={canCall ? "" : "Кабінет зайнятий"}>▶ Викликати в кабінет</button>
                      <button className="btn btn-secondary btn-sm" onClick={act(onReschedule)}>🗓 Перенести на слот</button>
                      <button className="btn btn-secondary btn-sm qd-act-red" onClick={act(onCancel)}>✕ Скасувати запис</button>
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
                  {STATUSES.map((s) => {
                    const lockDone = s.key === "done" && p.status !== "cabinet"; // завершити можна лише з кабінету
                    return (
                      <button key={s.key} disabled={lockDone}
                        className={"qd-seg-btn " + s.cls + (p.status === s.key ? " active" : "") + (lockDone ? " locked" : "")}
                        title={lockDone ? "«Виконано» доступне лише коли пацієнт у кабінеті" : ""}
                        onClick={(e) => { e.stopPropagation(); if (!lockDone) onSetStatus(p, s.key); }}>
                        <span className={"qd-seg-dot " + s.cls}></span>{s.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {canReschedule && onSetCall && p.status !== "done" && p.status !== "noshow" && (
              <div className="qd-statusfix">
                <span className="qd-sf-lab">Дзвінок-підтвердження <span className="qd-sf-hint">(обдзвін напередодні)</span></span>
                <div className="qd-seg">
                  {CALL_STATUSES.map((s) => (
                    <button key={s.key} className={"qd-seg-btn " + s.cls + (callStatus === s.key ? " active" : "")}
                      onClick={(e) => { e.stopPropagation(); onSetCall(p, s.key); }}>
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
function MiniCalendar({ selectedDate, onSelectDate, today, hasChanges, counts, simOn, onEditSchedule, schedVer }) {
  /* живий тик — календар оновлюється в реальному часі разом із потоком пацієнтів */
  const [, setClock] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setClock((c) => c + 1), 1000);
    return () => clearInterval(id);
  }, []);

  /* місяць, що відображається (навігація ‹ ›); за замовчуванням — місяць обраної дати */
  const [viewMonth, setViewMonth] = useState(() => new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
  function shiftMonth(n) { setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1)); }

  const nowStr = new Date().toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const done = counts ? counts.done : 0;
  const total = counts ? counts.total : 0;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const dow = window.RF_WEEKDAYS_SHORT || ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
  const y = viewMonth.getFullYear(), mo = viewMonth.getMonth();
  const firstOfMonth = new Date(y, mo, 1);
  const daysInMonth = new Date(y, mo + 1, 0).getDate();
  const startIdx = window.rfDowMon ? window.rfDowMon(firstOfMonth) : ((firstOfMonth.getDay() + 6) % 7); // зміщення від понеділка
  const monthLabel = (window.RF_MONTHS_NOM ? window.RF_MONTHS_NOM[mo] : "") + " " + y;

  const cells = [];
  for (let i = 0; i < startIdx; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  /* Режим роботи обраної дати — короткий статус + кнопка налаштування
     (рішення про свято/вихідний ухвалюється тут, у календарі) */
  const selOv = window.rfDayOverrideStatus ? window.rfDayOverrideStatus(selectedDate) : { kind: "none", label: "" };
  const selDefaultClosed = window.rfDefaultClosed ? window.rfDefaultClosed(selectedDate) : (selectedDate.getDay() === 0);
  const defH = window.RF_DEFAULT_HOURS || { start: "08:00", end: "18:00" };
  const customRooms = window.rfDayCustomRooms ? window.rfDayCustomRooms(selectedDate) : []; // які саме кабінети мають інший графік
  let schedTxt, schedCls;
  if (selOv.kind === "closed") { schedTxt = selOv.label || "Неробочий день"; schedCls = "closed"; }
  else if (selOv.kind === "custom") { schedTxt = selOv.label ? selOv.label + " · особливий графік" : "Особливий графік кабінетів"; schedCls = "custom"; }
  else if (selDefaultClosed) { schedTxt = "Вихідний (неділя)"; schedCls = "muted"; }
  else { schedTxt = "Працює · " + defH.start + "–" + defH.end; schedCls = "ok"; }

  return (
    <div className="rcard">
      <div className="cal-head">
        <span className="cal-month">{monthLabel}</span>
        <div className="cal-nav">
          <button className="mini-icon" style={{ width: 26, height: 26 }} onClick={() => shiftMonth(-1)} title="Попередній місяць">‹</button>
          <button className="mini-icon" style={{ width: 26, height: 26 }} onClick={() => shiftMonth(1)} title="Наступний місяць">›</button>
        </div>
      </div>
      <div className="cal-grid">
        {dow.map((d) => <div className="cal-dow" key={d}>{d}</div>)}
        {cells.map((d, i) => {
          if (d === null) return <div className="cal-day empty-day" key={"e" + i}></div>;
          const cellDate = new Date(y, mo, d);
          const isToday = window.rfSameDay(cellDate, today);
          const isSel = window.rfSameDay(cellDate, selectedDate);
          const isSunday = cellDate.getDay() === 0;
          // ручний режим роботи на цю дату (свято / особливий графік)
          const ovSt = window.rfDayOverrideStatus ? window.rfDayOverrideStatus(cellDate) : { kind: "none", label: "" };
          const isHoliday = ovSt.kind === "closed";
          const isCustom = ovSt.kind === "custom";
          const hasAppts = (window.rfIsWorkday ? window.rfIsWorkday(cellDate) : !isSunday) && !isHoliday; // робочі дні мають записи
          return (
            <button
              className={"cal-day" + (isToday ? " today" : "") + (isSel && !isToday ? " selected" : "") + (isSunday && !isToday ? " muted" : "") + (isHoliday ? " holiday" : "") + (isCustom ? " custom" : "")}
              key={d} onClick={() => onSelectDate && onSelectDate(cellDate)}
              title={ovSt.label || undefined}
            >
              {d}
              {hasAppts && <span className="cdot"></span>}
              {(isHoliday || isCustom) && <span className={"cal-sched " + (isHoliday ? "closed" : "custom")}></span>}
              {hasChanges && isToday && <span className="cal-change" title="Є зміни у черзі"></span>}
            </button>
          );
        })}
      </div>

      {/* живий блок: годинник + прогрес дня в реальному часі (синхронно з потоком) */}
      <div className="cal-live" style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: simOn ? "var(--green)" : "var(--text-muted)", fontWeight: 600 }}>
            <span className="pulse-dot" style={{ background: simOn ? "var(--green)" : "var(--text-muted)", width: 7, height: 7 }}></span>
            {simOn ? "Live" : "Пауза"}
          </span>
          <span className="tabular" style={{ color: "var(--text-secondary)" }}>🕐 {nowStr}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, color: "var(--text-secondary)" }}>
          <span>{window.rfSameDay(selectedDate, today) ? "Сьогодні виконано" : "Виконано за день"}</span>
          <span className="tabular" style={{ fontWeight: 700, color: "var(--text)" }}>{done} / {total}</span>
        </div>
        <div className="load-bar" style={{ height: 6, borderRadius: 4, background: "var(--border)", overflow: "hidden" }}>
          <div style={{ width: pct + "%", height: "100%", background: "var(--green)", transition: "width .6s ease" }}></div>
        </div>
      </div>

      {/* Режим роботи обраного дня — налаштування графіка кабінетів (свята/вихідні) */}
      {onEditSchedule && (
        <div className="cal-sched-strip">
          <div className="css-row">
            <div className="css-info">
              <span className="css-lab">Режим роботи · {window.rfFmtShort ? window.rfFmtShort(selectedDate) : ""}</span>
              <span className={"css-val " + schedCls}>{schedTxt}</span>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => onEditSchedule(selectedDate)} title="Змінити графік роботи кабінетів на цю дату">Налаштувати</button>
          </div>
          {/* які саме кабінети/апарати мають інший графік цього дня */}
          {customRooms.length > 0 && (
            <ul className="css-rooms">
              {customRooms.map((r) => (
                <li className="css-room" key={r.roomKey}>
                  <span className={"css-room-dot " + (r.closed ? "closed" : "custom")}></span>
                  <span className="css-room-name">{r.name} <span className="css-room-kind">{r.kind}</span></span>
                  <span className={"css-room-st " + (r.closed ? "closed" : "custom")}>{r.closed ? "зачинено" : (r.start + "–" + r.end)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
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
          {/* К-05: рядок завантаженості — клікабельний перехід до черги цього кабінету,
              цифра веде туди, де з нею можна щось зробити (а не лише індикатор). */}
          {rooms.map((r) => (
            <a className="load-row load-row-link" key={r.name}
               href={r.roomKey ? "radflow-queue-board.html?room=" + r.roomKey : undefined}
               title={"Відкрити чергу: " + r.name}>
              <div className="load-top">
                <span className="load-name">{r.name} {r.kind} <span className="load-go" aria-hidden>→</span></span>
                <span className="load-pct" style={{ color: r.color }}>{r.pct}%</span>
              </div>
              <div className="load-bar"><div className="load-fill" style={{ width: r.pct + "%", background: r.color }}></div></div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

Object.assign(window, {
  TopBar, StatsBar, CurrentCard, QueueControls, QueueRow,
  MiniCalendar, RoomLoad, RoomStatusCard, CallListPreview,
});
