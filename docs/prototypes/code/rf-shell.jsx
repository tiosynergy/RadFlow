/* ===== RadFlow — Shared shell (sidebar, toasts, helpers) ===== */
const { useState: rfUseState, useEffect: rfUseEffect, useRef: rfUseRef } = React;

function fmtTimer(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return String(m).padStart(2, "0") + ":" + String(ss).padStart(2, "0");
}

const RF_OPS = [
  { key: "new",   ic: "＋", label: "Новий запис",            href: "radflow-queue-board.html?new=1" },
  { key: "calls", ic: "☎", label: "Колл-лист",              href: "radflow-call-list.html", badge: 5 },
  { key: "incidents", ic: "⚠", label: "Інцидент",           href: "radflow-incidents.html", badge: 1 },
  { key: "adddoc", ic: "🩺", label: "Лікар-направляч",       href: "radflow-queue-board.html?adddoc=1" },
  { key: "price", ic: "₴", label: "Прайс-лист",             href: "radflow-setup-wizard.html#price" },
];

function Sidebar({ active }) {
  const rooms = (typeof window !== "undefined" && window.RF_ROOMS) ? window.RF_ROOMS : {};
  const alerts = (typeof window !== "undefined" && window.RF_CABINET_ALERTS) ? window.RF_CABINET_ALERTS : [];
  const roomKeys = Object.keys(rooms);

  const Item = (it) => (
    <a key={it.key} href={it.href} className={"sb-item" + (active === it.key ? " active" : "")}>
      <span className="ic">{it.ic}</span>
      <span className="sb-item-lab">{it.label}</span>
      {it.badge != null && <span className="sb-badge">{it.badge}</span>}
    </a>
  );

  return (
    <aside className="sidebar">
      <div className="sb-head">
        <a href="radflow-queue-board.html" className="sb-logo"><span className="dot"></span>RadFlow</a>
        <div className="sb-sub">Адміністратор • МЦ «Медика»</div>
      </div>
      <nav className="sb-nav">
        {/* Кабінети користувача — КТ / МРТ */}
        <div className="sb-section">
          <div className="sb-label">Кабінети</div>
          <a href="radflow-queue-board.html" className={"sb-item sb-cab-all" + (active === "all" || active === "queue" ? " active" : "")}>
            <span className="ic">▦</span>
            <span className="sb-item-lab">Усі кабінети</span>
            <span className="sb-cab-count">{roomKeys.length}</span>
          </a>
          {roomKeys.map((k) => {
            const r = rooms[k];
            const hasAlert = alerts.indexOf(k) !== -1;
            return (
              <a key={k} href={"radflow-queue-board.html?room=" + k} className={"sb-cab" + (active === k ? " active" : "")}>
                <span className={"sb-cab-tile " + (r.kind === "МРТ" ? "mrt" : "ct")}>{r.kind}</span>
                <span className="sb-cab-meta">
                  <span className="sb-cab-name">{r.name}</span>
                  <span className="sb-cab-model">{r.model}</span>
                </span>
                {hasAlert && <span className="sb-alert-dot" title="Є зміни у сценарії кабінету"></span>}
              </a>
            );
          })}
        </div>

        {/* Операції — модальні вікна / переходи */}
        <div className="sb-section">
          <div className="sb-label">Операції</div>
          {RF_OPS.map(Item)}
        </div>
      </nav>

      {/* Налаштування — лише Майстер, внизу зліва */}
      <div className="sb-settings">
        <a href="radflow-radiologist.html" className="sb-item">
          <span className="ic">🩺</span>
          <span className="sb-item-lab">Кабінет радіолога</span>
        </a>
        <a href="radflow-setup-wizard.html" className={"sb-item" + (active === "wizard" ? " active" : "")}>
          <span className="ic">⚙</span>
          <span className="sb-item-lab">Майстер налаштування</span>
        </a>
      </div>

      <div className="sb-user">
        <div className="avatar" style={{ background: "linear-gradient(135deg,#0a84ff,#7b5cff)" }}>ОМ</div>
        <div className="meta">
          <div className="nm">Оксана Мельник</div>
          <div className="rl">Адміністратор</div>
        </div>
        <button className="icon-btn" title="Вийти">⏻</button>
      </div>
    </aside>
  );
}

/* Toasts + hook */
function Toasts({ toasts }) {
  const icons = { success: "✓", error: "✕", info: "ℹ", warning: "⚠" };
  return (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <div className={"toast " + t.type + (t.out ? " out" : "")} key={t.id}>
          <span className="ti">{icons[t.type]}</span>
          <span className="tmsg">{t.msg}</span>
        </div>
      ))}
    </div>
  );
}

function useToasts() {
  const [toasts, setToasts] = rfUseState([]);
  const seq = rfUseRef(0);
  function push(msg, type = "success") {
    const id = ++seq.current;
    setToasts((ts) => [...ts, { id, msg, type }]);
    setTimeout(() => setToasts((ts) => ts.map((t) => t.id === id ? { ...t, out: true } : t)), 3400);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 3700);
  }
  return [toasts, push];
}

/* Generic top bar */
function PageTopBar({ icon, title, subtitle, actions }) {
  return (
    <header className="topbar">
      <div className="tb-title">
        <span className="tic">{icon}</span>
        <div>
          <h1>{title}</h1>
          {subtitle && <div className="date">{subtitle}</div>}
        </div>
      </div>
      <div className="tb-right">{actions}</div>
    </header>
  );
}

/* Live timer — owns its own interval so it never re-renders parents.
   children is a render fn: (elapsedSeconds) => JSX */
function LiveTimer({ enteredAt, children }) {
  const [, setTick] = rfUseState(0);
  rfUseEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const sec = Math.max(0, Math.floor((Date.now() - enteredAt) / 1000));
  return children(sec);
}

/* CITO — наскрізне термінове сповіщення */
function CitoBanner({ patients, onOpen }) {
  if (!patients || !patients.length) return null;
  const rooms = (typeof window !== "undefined" && window.RF_ROOMS) ? window.RF_ROOMS : {};
  return (
    <div className="cito-banner" role="alert">
      <span className="cito-flag"><span className="cito-pulse"></span>CITO</span>
      <span className="cito-lab">{patients.length === 1 ? "Терміновий пацієнт потребує негайної уваги" : patients.length + " термінові пацієнти потребують негайної уваги"}</span>
      <div className="cito-list">
        {patients.map((p) => (
          <button key={p.id} className="cito-chip" onClick={() => onOpen && onOpen(p.id)}>
            <span className="cito-chip-time tabular">{p.time}</span>
            {p.name}
            <span className="cito-chip-room">{rooms[p.room] ? rooms[p.room].name : ""}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { fmtTimer, Sidebar, Toasts, useToasts, PageTopBar, RF_OPS, LiveTimer, CitoBanner });
