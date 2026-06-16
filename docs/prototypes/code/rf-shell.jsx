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
  { key: "calls", ic: "☎", label: "Колл-лист",              href: "radflow-call-list.html" },
  { key: "incidents", ic: "⚠", label: "Інцидент",           href: "radflow-incidents.html" },
  { key: "adddoc", ic: "🩺", label: "Лікар-направляч",       href: "radflow-queue-board.html?adddoc=1" },
  { key: "price", ic: "₴", label: "Прайс-лист",             href: "radflow-setup-wizard.html#price" },
];

function Sidebar({ active }) {
  const rooms = (typeof window !== "undefined" && window.RF_ROOMS) ? window.RF_ROOMS : {};
  const alerts = (typeof window !== "undefined" && window.RF_CABINET_ALERTS) ? window.RF_CABINET_ALERTS : [];
  const roomKeys = Object.keys(rooms);

  /* Бейджі рахуються з реального стану (не хардкод):
       • «Інцидент» = 1, якщо є активне блокування апарата (rf_incident_v1), інакше прихований;
       • «Колл-лист» = к-сть пацієнтів на обдзвін (через простій + базовий колл-лист). */
  const incList = (typeof window !== "undefined" && window.getIncidents) ? window.getIncidents() : [];
  const incPending = (typeof window !== "undefined" && window.rfIncidentsTotalPending) ? window.rfIncidentsTotalPending() : 0;
  const callPending = (typeof window !== "undefined" && window.getCallList)
    ? window.getCallList().filter((p) => p.status !== "confirmed").length : 0;
  const BADGES = { incidents: incList.length, calls: callPending + incPending };

  const Item = (it) => {
    const b = BADGES[it.key];
    return (
      <a key={it.key} href={it.href} className={"sb-item" + (active === it.key ? " active" : "")}>
        <span className="ic">{it.ic}</span>
        <span className="sb-item-lab">{it.label}</span>
        {b ? <span className={"sb-badge" + (it.key === "incidents" ? " sb-badge-red" : "")}>{b}</span> : null}
      </a>
    );
  };

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

/* ---------- Спільна модалка «Перенести на новий слот» ----------
   Дозволяє ухвалити рішення про перезапис ПРЯМО там, де ведеться обдзвін
   (колл-лист, обдзвін через простій, черга): обрати кабінет того ж типу
   (заблоковані апарати виключено), дату та вільний слот. */
function RescheduleModal({ patient, onClose, onConfirm }) {
  const rooms = (typeof window !== "undefined" && window.RF_ROOMS) ? window.RF_ROOMS : {};
  const roomKeys = Object.keys(rooms);
  const kind = patient.kind || (window.clStudyType ? window.clStudyType(patient.proc || "") : "МРТ");
  const dur = patient.dur || (kind === "КТ" ? 20 : 45);

  // кабінети того ж типу, окрім заблокованих інцидентами
  const blocked = {};
  (window.getIncidents ? window.getIncidents() : []).forEach((i) => { blocked[i.roomKey] = true; });
  const options = roomKeys.filter((k) => rooms[k].kind === kind && !blocked[k]);

  function pad(n) { return String(n).padStart(2, "0"); }
  function dateVal(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function toMin(t) { var p = String(t).split(":"); return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); }
  function fmt(m) { return pad(Math.floor(m / 60)) + ":" + pad(m % 60); }

  const def = (function () {
    if (patient.roomKey && rooms[patient.roomKey] && !blocked[patient.roomKey]) return patient.roomKey;
    if (patient.roomName) { var k = roomKeys.find(function (x) { return rooms[x].name === patient.roomName && !blocked[x]; }); if (k) return k; }
    return options[0] || roomKeys[0];
  })();
  const [room, setRoom] = rfUseState(def);
  const [dateStr, setDateStr] = rfUseState(dateVal(window.rfAddDays(window.rfToday(), 1)));
  const [time, setTime] = rfUseState("");

  const today = window.rfToday();
  const dateObj = new Date(dateStr + "T00:00:00");
  const isToday = window.rfSameDay(dateObj, today);
  const dayList = isToday
    ? (window.getQueuePatients ? window.getQueuePatients() : [])
    : (window.getDayPatients ? window.getDayPatients(dateObj) : []);
  const busy = dayList.filter(function (p) { return p.room === room && p.status !== "noshow"; })
    .map(function (p) { return { s: toMin(p.time), e: toMin(p.time) + (p.dur || 30) }; });
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const slots = []; for (var m = 8 * 60; m < 18 * 60; m += 30) slots.push(fmt(m));
  function slotState(s) {
    var a = toMin(s), b = a + dur;
    if (isToday && a < nowMin) return "past";
    if (busy.some(function (x) { return a >= x.s && a < x.e; })) return "busy";
    if (busy.some(function (x) { return a < x.e && x.s < b; })) return "tight";
    return "free";
  }
  function nextApptAfter(s) { var a = toMin(s); var f = busy.filter(function (x) { return x.s >= a; }).sort(function (x, y) { return x.s - y.s; })[0]; return f ? fmt(f.s) : null; }
  const freeCount = slots.filter(function (s) { return slotState(s) === "free"; }).length;
  const busyList = busy.slice().sort(function (a, b) { return a.s - b.s; });
  const valid = room && time && !blocked[room];

  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 520 }}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--blue-bg)", color: "var(--blue)" }}>🗓</span>Перенести на новий слот</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dlg-body">
          <div className="ctx-hint blue" style={{ fontSize: 13 }}>Пацієнт: <b>{patient.name}</b> · {patient.proc} · {dur} хв</div>
          <div className="fld">
            <span className="fld-lab">Кабінет ({kind})</span>
            {options.length === 0
              ? <div className="ctx-hint red" style={{ fontSize: 12.5 }}>Немає доступних кабінетів типу {kind} (усі заблоковані). Спробуйте інший день або зніміть блокування.</div>
              : <div className="bd-rooms">
                  {options.map(function (k) { var r = rooms[k]; return (
                    <button key={k} className={"bd-room" + (room === k ? " active" : "")} onClick={function () { setRoom(k); setTime(""); }} title={r.name + " · " + r.model}>
                      <span className={"bd-room-kind " + (r.kind === "МРТ" ? "mrt" : "ct")}>{r.kind}</span>
                      <span className="bd-room-meta"><span className="bd-room-name">{r.name}</span><span className="bd-room-model">{r.model}</span></span>
                    </button>); })}
                </div>}
          </div>
          <div className="fld-row">
            <label className="fld" style={{ maxWidth: 180 }}><span className="fld-lab">Дата</span>
              <input className="inp tabular" type="date" min={dateVal(today)} value={dateStr} onChange={function (e) { setDateStr(e.target.value); setTime(""); }} /></label>
            <div className="fld"><span className="fld-lab">Вільні слоти · блок {dur} хв · {freeCount} вільних</span></div>
          </div>
          <div className="fld">
            <div className="bk-slot-grid">
              {slots.map(function (s) {
                var st = slotState(s);
                var title = st === "busy" ? "Зайнято" : st === "tight" ? ("Не вміщується: блок " + dur + " хв перетне запис о " + nextApptAfter(s)) : st === "past" ? "Час минув" : ("Вільно · " + s + "–" + fmt(toMin(s) + dur));
                return (
                  <button key={s} className={"slot" + (time === s ? " sel" : "") + (st !== "free" ? " taken" : "") + (st === "tight" ? " tight" : "") + (st === "busy" ? " busy" : "")} disabled={st !== "free"} onClick={function () { setTime(s); }} title={title}>{s}</button>); })}
            </div>
            {busyList.length > 0 && (
              <div className="bk-busy-list">
                <span className="bk-busy-lab">Зайнятий час ({rooms[room].name}):</span>
                {busyList.map(function (b, i) { return <span className="bk-busy-chip" key={i}>{fmt(b.s)}–{fmt(b.e)}</span>; })}
              </div>
            )}
            <div className="bk-slot-legend">
              <span><span className="lg-dot free"></span>вільно</span>
              <span><span className="lg-dot tight"></span>не вміщується</span>
              <span><span className="lg-dot busy"></span>зайнято</span>
            </div>
            {time && (function () {
              var s = toMin(time), e = s + dur;
              var conflict = busy.filter(function (x) { return s < x.e && x.s < e; })[0];
              var next = busy.filter(function (x) { return x.s >= e; }).sort(function (a, b) { return a.s - b.s; })[0];
              var fmtGap = function (m) { var h = Math.floor(m / 60), mm = m % 60; return (h ? h + " год " : "") + (mm ? mm + " хв" : (h ? "" : "0 хв")); };
              return (
                <div className={"bk-slot-confirm " + (conflict ? "bad" : "ok")}>
                  {conflict
                    ? <>⚠ Перетин із записом {fmt(conflict.s)}–{fmt(conflict.e)} — оберіть інший слот</>
                    : <>✓ Слот вільний, накладок немає. Запис: <b>{time}–{fmt(e)}</b> ({dur} хв).{next ? <> Далі кабінет вільний до наступного запису о <b>{fmt(next.s)}</b> — запас {fmtGap(next.s - e)}.</> : <> Далі до кінця дня вільно.</>}</>}
                </div>
              );
            })()}
          </div>
        </div>
        <div className="dlg-foot">
          {valid
            ? <span className="bk-summary">{rooms[room].name} · {dateStr} {time}–{fmt(toMin(time) + dur)}</span>
            : <span style={{ fontSize: 12, color: "var(--text-faint)", marginRight: "auto", alignSelf: "center" }}>Оберіть кабінет, дату та слот</span>}
          <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
          <button className="btn btn-primary" disabled={!valid} onClick={function () { onConfirm({ roomKey: room, roomName: rooms[room].name, date: dateStr, time: time, dur: dur }); }}>✓ Перенести на цей слот</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Спільна модалка «Дослідження» (тип дослідження) ----------
   Дозволяє редагувати й додавати кілька досліджень ПРЯМО там, де ухвалюється
   рішення (черга, колл-лист, кабінет радіолога, новий запис). Кожне дослідження:
   тип (МРТ/КТ) + область + контраст → тривалість і ціна рахуються автоматично,
   сумарно по всіх дослідженнях. */
function StudyEditModal({ patient, date, onClose, onConfirm, title }) {
  const regionsFor = (t) => (window.rfRegionsFor ? window.rfRegionsFor(t) : []);
  const CDUR = window.RF_CONTRAST_DUR || 15;
  const CSUR = window.RF_CONTRAST_SURCHARGE || 900;
  const MIN_STUDY = 15;          // найкоротше можливе дослідження, хв
  const DAY_END = 18 * 60;       // кінець робочого дня

  /* Скільки часу вільно у слоті пацієнта: від початку його запису до початку
     наступного запису в тому самому кабінеті того ж дня (або до кінця дня).
     Сумарна тривалість усіх досліджень не може перевищити це вікно — інакше
     запис перетне наступного пацієнта. */
  function pad(n) { return String(n).padStart(2, "0"); }
  function toMin(t) { var p = String(t || "").split(":"); return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); }
  function fmt(m) { return pad(Math.floor(m / 60)) + ":" + pad(m % 60); }
  const rooms = (typeof window !== "undefined" && window.RF_ROOMS) ? window.RF_ROOMS : {};
  const roomKey = rooms[patient.room] ? patient.room : Object.keys(rooms).find((k) => rooms[k].name === patient.room) || patient.roomKey;
  /* Кабінет визначає модальність: КТ і МРТ — РІЗНІ кабінети й обладнання.
     Тому всі дослідження ОДНОГО слота можливі лише на апараті цього кабінету
     (не можна чергувати КТ→МРТ→КТ в одному записі). Тип фіксуємо за кабінетом. */
  const roomKind = (roomKey && rooms[roomKey]) ? rooms[roomKey].kind : null; // "МРТ" | "КТ" | null
  const lockType = roomKind === "МРТ" || roomKind === "КТ";
  const defaultType = lockType ? roomKind : "МРТ";
  const dateObj = date || (window.rfToday ? window.rfToday() : new Date());
  const isToday = window.rfSameDay ? window.rfSameDay(dateObj, window.rfToday()) : true;
  const dateLabel = isToday ? "сьогодні" : (window.rfFmtFull ? window.rfFmtFull(dateObj) : "");
  const dayList = isToday
    ? (window.getQueuePatients ? window.getQueuePatients() : [])
    : (window.getDayPatients ? window.getDayPatients(dateObj) : []);
  const startMin = toMin(patient.time);
  const nextStart = dayList
    .filter((p) => p.id !== patient.id && p.room === roomKey && p.status !== "noshow")
    .map((p) => toMin(p.time)).filter((m) => m > startMin).sort((a, b) => a - b)[0];
  const windowEnd = (nextStart != null) ? nextStart : DAY_END;
  const availableDur = Math.max(0, windowEnd - startMin);

  function seed() {
    const base = (window.rfStudiesForPatient ? window.rfStudiesForPatient(patient) : []);
    return base.map((s) => {
      const t = lockType ? roomKind : (s.type || "МРТ");
      // якщо успадковане дослідження іншої модальності — область не дійсна для цього кабінету, скидаємо
      const keepRegion = !lockType || !s.type || s.type === roomKind;
      const region = keepRegion ? (s.region || "") : "";
      return { type: t, region, dur: region ? (s.dur || 45) : recalc(t, "") };
    });
  }
  const [rows, setRows] = rfUseState(seed);

  function regionObj(type, label) { return regionsFor(type).find((r) => r.label === label) || null; }
  function recalc(type, region, prevDur) {
    const ro = regionObj(type, region);
    return ro ? ro.dur : (prevDur || (type === "КТ" ? 20 : 45));
  }
  function patch(i, p) { setRows((rs) => rs.map((r, idx) => idx === i ? { ...r, ...p } : r)); }
  function setType(i, type) { if (lockType) return; patch(i, { type, region: "", dur: recalc(type, "") }); }
  function setRegion(i, region) { const r = rows[i]; patch(i, { region, dur: recalc(r.type, region, r.dur) }); }
  function setDur(i, v) { patch(i, { dur: Math.max(5, parseInt(v, 10) || 0) }); }
  function addRow() { setRows((rs) => [...rs, { type: defaultType, region: "", dur: recalc(defaultType, "") }]); }
  function removeRow(i) { setRows((rs) => rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs); }

  const totalDur = rows.reduce((s, r) => s + (parseInt(r.dur, 10) || 0), 0);
  const overflow = totalDur > availableDur;            // не вміщується у слот
  const remaining = availableDur - totalDur;
  const canAdd = remaining >= MIN_STUDY;               // чи лишилось місце ще на одне дослідження
  const valid = rows.length > 0 && rows.every((r) => r.region) && !overflow;

  function save() {
    const arr = rows.filter((r) => r.region).map((r) => ({ type: r.type, region: r.region, dur: parseInt(r.dur, 10) || 0 }));
    if (window.saveStudies) window.saveStudies(patient.id, arr);
    if (onConfirm) onConfirm(arr, { dur: totalDur });
    onClose && onClose();
  }

  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 600 }}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--blue-bg)", color: "var(--blue)" }}>🩻</span>{title || "Дослідження пацієнта"}</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dlg-body">
          <div className="ctx-hint blue" style={{ fontSize: 13 }}>Пацієнт: <b>{patient.name}</b>{dateLabel ? <> · <b>{dateLabel}</b></> : null} · слот о <b>{patient.time}</b>{roomKey && rooms[roomKey] ? <> · {rooms[roomKey].name}{lockType ? <> · <b>{roomKind}</b></> : null}</> : null}. {lockType ? <>Усі дослідження слота — лише <b>{roomKind}</b> (КТ і МРТ виконуються на різних апаратах у різних кабінетах). Вміщуються у вільний час до наступного запису.</> : <>Дослідження вміщуються у вільний час до наступного запису.</>}</div>
          <div className={"ctx-hint " + (overflow ? "red" : "blue")} style={{ fontSize: 12.5 }}>
            {overflow
              ? <>⚠ Не вміщується: разом <b>{totalDur} хв</b>, доступно <b>{availableDur} хв</b> ({nextStart != null ? <>до наступного запису о {fmt(nextStart)}</> : <>до кінця дня</>}). Приберіть або скоротіть дослідження на {totalDur - availableDur} хв.</>
              : <>Доступно у слоті: <b>{availableDur} хв</b> ({nextStart != null ? <>до наступного запису о {fmt(nextStart)}</> : <>до кінця дня</>}). Вільно ще <b>{remaining} хв</b>.</>}
          </div>
          <div className="st-rows">
            {rows.map((r, i) => {
              const regions = regionsFor(r.type);
              const hasRegion = !r.region || regions.some((x) => x.label === r.region);
              return (
                <div className="st-row" key={i}>
                  <div className="st-row-head">
                    <span className="st-row-n">Дослідження {i + 1}</span>
                    {rows.length > 1 && <button className="st-row-del" title="Прибрати" onClick={() => removeRow(i)}>✕</button>}
                  </div>
                  <div className="st-row-body">
                    <div className="st-field st-field-type">
                      <span className="st-flab">Тип</span>
                      {lockType ? (
                        <div className="bk-seg st-seg st-seg-locked" title="Тип апарата задає кабінет — у цьому слоті лише дослідження цієї модальності">
                          <button className={"bk-seg-btn active " + (roomKind === "МРТ" ? "mrt" : "ct")} disabled aria-disabled="true">{roomKind} <span className="st-lock-ic" aria-hidden>🔒</span></button>
                        </div>
                      ) : (
                        <div className="bk-seg st-seg">
                          <button className={"bk-seg-btn" + (r.type === "МРТ" ? " active mrt" : "")} onClick={() => setType(i, "МРТ")}>МРТ</button>
                          <button className={"bk-seg-btn" + (r.type === "КТ" ? " active ct" : "")} onClick={() => setType(i, "КТ")}>КТ</button>
                        </div>
                      )}
                    </div>
                    <label className="st-field st-field-region">
                      <span className="st-flab">Область дослідження</span>
                      <select className="inp" value={hasRegion ? r.region : ""} onChange={(e) => setRegion(i, e.target.value)}>
                        <option value="">— Оберіть область —</option>
                        {!hasRegion && r.region && <option value={r.region}>{r.region} (поточне)</option>}
                        {regions.map((x) => <option key={x.label} value={x.label}>{x.label} · {x.dur} хв</option>)}
                      </select>
                    </label>
                    <label className="st-field st-field-dur">
                      <span className="st-flab">Тривалість</span>
                      <div className="st-dur"><input className="inp" type="number" min="5" step="5" value={r.dur} onChange={(e) => setDur(i, e.target.value)} /><span className="st-dur-u">хв</span></div>
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
          <button className="btn btn-secondary btn-sm" style={{ marginTop: 10 }} disabled={!canAdd} onClick={addRow}
            title={canAdd ? "" : "Немає вільного часу у слоті для ще одного дослідження"}>＋ Додати дослідження</button>
          {!canAdd && rows.every((r) => r.region) && <span className="st-nofit">Більше не вміщується — час до наступного запису вичерпано.</span>}
        </div>
        <div className="dlg-foot">
          <span className="st-total">Разом: <b>{totalDur} хв</b> · {rows.length} {rows.length === 1 ? "дослідження" : "досл."}</span>
          <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
          <button className="btn btn-primary" disabled={!valid} onClick={save}>✓ Зберегти дослідження</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Спільне діалогове вікно підтвердження дії ---------- */
function ConfirmModal({ title, message, confirmLabel, cancelLabel, danger, onConfirm, onClose }) {
  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 420 }}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: danger ? "var(--red-bg)" : "var(--blue-bg)", color: danger ? "var(--red)" : "var(--blue)" }}>{danger ? "⚠" : "?"}</span>{title || "Підтвердження"}</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dlg-body">
          <div style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.55 }}>{message}</div>
        </div>
        <div className="dlg-foot">
          <button className="btn btn-ghost" onClick={onClose}>{cancelLabel || "Скасувати"}</button>
          <button className={"btn " + (danger ? "btn-danger" : "btn-primary")} onClick={onConfirm}>{confirmLabel || "Підтвердити"}</button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { fmtTimer, Sidebar, Toasts, useToasts, PageTopBar, RF_OPS, LiveTimer, CitoBanner, RescheduleModal, ConfirmModal, StudyEditModal });
