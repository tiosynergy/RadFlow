/* ===== RadFlow — Setup Wizard app ===== */
const { useState } = React;

const WIZ_STEPS = [
  { key: 1, title: "Профіль клініки", desc: "Дані та акаунт" },
  { key: 2, title: "Прайс-лист", desc: "AI-парсинг або вручну" },
  { key: 3, title: "Обладнання та кабінети", desc: "МРТ, КТ, кімнати" },
  { key: 4, title: "Розклад роботи", desc: "Години та перерви" },
  { key: 5, title: "Персонал і запуск", desc: "Запросити та активувати" },
];

function WizApp() {
  const [step, setStep] = useState(1);
  const [done, setDone] = useState({}); 
  const [toasts, push] = useToasts();

  function go(n) { if (n >= 1 && n <= 5) setStep(n); }
  function next() {
    setDone((d) => ({ ...d, [step]: true }));
    if (step < 5) setStep(step + 1);
    else push("Налаштування завершено", "success");
  }

  const pct = Math.round((Object.keys(done).length / 5) * 100);

  function stepState(k) {
    if (k === step) return "active";
    if (done[k] || k < step) return "done";
    return "locked";
  }

  return (
    <div className="wiz">
      <aside className="wiz-side">
        <div className="wiz-head">
          <a href="radflow-queue-board.html" className="wiz-logo"><span className="dot"></span>RadFlow</a>
          <div className="wiz-sub">Налаштування та профіль кабінету</div>
        </div>
        <div className="wiz-steps">
          {WIZ_STEPS.map((s, i) => {
            const st = stepState(s.key);
            return (
              <div key={s.key} className={"wstep " + st} onClick={() => go(s.key)}>
                {i < WIZ_STEPS.length - 1 && <span className={"wstep-line" + (done[s.key] ? " done" : "")}></span>}
                <span className="wstep-num">{st === "done" ? "✓" : s.key}</span>
                <span className="wstep-txt">
                  <span className="wstep-title">{s.title}</span>
                  <span className="wstep-desc">{s.desc}</span>
                </span>
              </div>
            );
          })}
        </div>
        <div className="wiz-foot">
          <div className="wiz-prog-bar"><div className="wiz-prog-fill" style={{ width: pct + "%" }}></div></div>
          <div className="wiz-prog-lab"><span>Крок {step} з 5</span><a href="radflow-queue-board.html">Підтримка</a></div>
        </div>
      </aside>

      <div className="wiz-main">
        <div className="wiz-main-inner">
          {step === 1 && <StepRegister />}
          {step === 2 && <StepPriceList toast={push} />}
          {step === 3 && <StepEquipment toast={push} />}
          {step === 4 && <StepSchedule />}
          {step === 5 && <StepGoLive toast={push} />}
        </div>
        <div className="wiz-bar">
          <div className="wiz-bar-inner">
            <button className="btn btn-ghost" onClick={() => go(step - 1)} disabled={step === 1}>← Назад</button>
            {step < 5
              ? <button className="btn btn-primary" onClick={next}>Зберегти та продовжити →</button>
              : <span></span>}
          </div>
        </div>
      </div>
      <Toasts toasts={toasts} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<WizApp />);
