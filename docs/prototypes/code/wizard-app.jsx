/* ===== RadFlow — Setup Wizard app ===== */
const { useState, useRef: aUseRef, useEffect: aUseEffect } = React;

const WIZ_STEPS = [
  { key: 1, title: "Профіль клініки", desc: "Дані, акаунт, обладнання" },
];
const STEP_COUNT = WIZ_STEPS.length;

function WizApp() {
  const [step, setStep] = useState(1);
  const [done, setDone] = useState({});
  const [valid, setValid] = useState({});                   // валідність кроку приходить від StepRegister
  const [skipped, setSkipped] = useState({});               // кроки, пропущені свідомо
  const [launched, setLaunched] = useState(false);
  const [toasts, push] = useToasts();

  /* кожен крок повідомляє свою валідність наверх (F1) */
  function report(k, ok) {
    setValid((v) => (v[k] === ok ? v : { ...v, [k]: ok }));
  }

  /* F11 — навігація: назад вільно, вперед тільки до вже відкритого кроку.
     "Заблоковані" кроки справді не клікаються. */
  function reachable(n) {
    if (n <= step) return true;        // назад / поточний
    if (done[n - 1] || skipped[n - 1]) return true; // наступний після завершеного
    return false;
  }
  function go(n) {
    if (n < 1 || n > STEP_COUNT) return;
    if (!reachable(n)) return;
    setStep(n);
  }

  function next() {
    if (!valid[step]) return;
    setDone((d) => ({ ...d, [step]: true }));
    setSkipped((s) => { const c = { ...s }; delete c[step]; return c; });
    if (step < STEP_COUNT) setStep(step + 1);
  }
  function skip() { // F1 — необов'язковий крок: позначаємо "незавершений", але йдемо далі
    setSkipped((s) => ({ ...s, [step]: true }));
    if (step < STEP_COUNT) setStep(step + 1);
    push("Крок пропущено — додасте пізніше у Налаштуваннях", "info");
  }
  function launch() {
    setLaunched(true);
    setDone((d) => ({ ...d, [STEP_COUNT]: true }));
    push("🎉 Кабінет активовано!", "success");
  }
  function saveDraftExit() {
    push("Чернетку збережено — повернетесь будь-коли", "success");
    setTimeout(() => { window.location.href = "radflow-queue-board.html"; }, 700);
  }

  /* F3 — прогрес від поточного кроку, збігається з підписом «Крок X з N» */
  const pct = Math.round((step / STEP_COUNT) * 100);

  function stepState(k) {
    if (k === step) return "active";
    if (done[k]) return "done";
    if (skipped[k]) return "skipped";
    if (reachable(k)) return "open";
    return "locked";
  }

  /* F11 — Enter = «Продовжити» (поза textarea / select) */
  function onKey(e) {
    if (e.key !== "Enter") return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "textarea" || tag === "select" || tag === "button") return;
    if (launched) return;
    if (step < STEP_COUNT && valid[step]) { e.preventDefault(); next(); }
  }

  const stepFields = {
    1: "ПІБ адміністратора, назву клініки, місто та хоча б один апарат",
  };

  return (
    <div className="wiz" onKeyDown={onKey}>
      <aside className="wiz-side">
        <div className="wiz-head">
          <a href="radflow-queue-board.html" className="wiz-logo"><span className="dot"></span>RadFlow</a>
          <div className="wiz-sub">Налаштування та профіль кабінету</div>
        </div>
        <div className="wiz-steps">
          {WIZ_STEPS.map((s, i) => {
            const st = stepState(s.key);
            const clickable = st !== "locked";
            return (
              <div
                key={s.key}
                className={"wstep " + st}
                onClick={() => go(s.key)}
                title={st === "locked" ? "Спершу завершіть попередній крок" : undefined}
                style={{ cursor: clickable ? "pointer" : "not-allowed" }}
              >
                {i < WIZ_STEPS.length - 1 && <span className={"wstep-line" + (done[s.key] ? " done" : "")}></span>}
                <span className="wstep-num">
                  {st === "done" ? "✓" : st === "skipped" ? "!" : st === "locked" ? "🔒" : s.key}
                </span>
                <span className="wstep-txt">
                  <span className="wstep-title">{s.title}</span>
                  <span className="wstep-desc">
                    {st === "skipped" ? "Незавершено — додати пізніше" : s.desc}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
        <div className="wiz-foot">
          <div className="wiz-prog-bar"><div className="wiz-prog-fill" style={{ width: pct + "%" }}></div></div>
          <div className="wiz-prog-lab">
            <span>Крок {step} з {STEP_COUNT}</span>
            <a href="mailto:support@radflow.ua?subject=Допомога%20з%20налаштуванням" title="Написати в підтримку">Підтримка</a>
          </div>
          <a className="wiz-exit" onClick={saveDraftExit} title="Прогрес збережеться, можна продовжити пізніше">⤓ Зберегти чернетку й вийти</a>
        </div>
      </aside>

      <div className="wiz-main">
        <div className="wiz-main-inner">
          {launched
            ? <LaunchSuccess />
            : <StepRegister report={report} />}
        </div>

        {!launched && (
          <div className="wiz-bar">
            <div className="wiz-bar-inner">
              <button className="btn btn-ghost" onClick={() => go(step - 1)} disabled={step === 1}>← Назад</button>

              <div className="wiz-bar-right">
                {WIZ_STEPS[step - 1].optional && step < STEP_COUNT && (
                  <button className="btn btn-ghost" onClick={skip} title="Цей крок необов'язковий">Пропустити</button>
                )}
                {step < STEP_COUNT ? (
                  <span className="wiz-cta-wrap" title={valid[step] ? undefined : "Заповніть " + (stepFields[step] || "обов'язкові поля")}>
                    <button className="btn btn-primary" onClick={next} disabled={!valid[step]}>
                      Зберегти та продовжити →
                    </button>
                  </span>
                ) : (
                  /* F2 — фінальна дія в тій самій нижній панелі, зелена (гейт по валідності) */
                  <span className="wiz-cta-wrap" title={valid[step] ? undefined : "Заповніть " + (stepFields[step] || "обов'язкові поля")}>
                    <button className="btn btn-green btn-launch" onClick={launch} disabled={!valid[step]}>🚀 Запустити кабінет</button>
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      <Toasts toasts={toasts} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<WizApp />);
