"use client";

/* ===== RadFlow — «Управління чергою»: політика при затримці (0078) =====

   Дослідження затягнулося і фактичним вікном налазить на наступний запис більше
   ніж на поріг → система пропонує адміну ПЛАН. Тут — лише налаштування; сам план
   і його застосування зʼявляться на етапі 3.

   ВАЖЛИВО ПРО СЕНС: навіть коли обрано автоматичну стратегію, масове застосування
   ВСЕ ОДНО вимагає підтвердження адміністратора. «Автоматична» тут означає «яку
   стратегію показати першою», а не «зробити мовчки». Пацієнти — не рядки в таблиці,
   і мовчазний зсув 20 записів без людини — це дзвінки, яких ніхто не робив. */

import { useState } from "react";
import { saveQueueDelayPolicy } from "@/app/queue/actions";
import type { QueueDelayPolicy } from "@/supabase/types";

export interface QueuePolicyInitial {
  policy: QueueDelayPolicy;
  overlapThresholdMin: number;
  maxCascadePatients: number;
  allowAfterHoursShift: boolean;
}

const OPTIONS: { key: QueueDelayPolicy; title: string; desc: string }[] = [
  {
    key: "manual",
    title: "Вирішує оператор",
    desc: "Показати обидва плани — зсув черги і перенос конфліктних — і дати обрати. Нічого не застосовується без людини.",
  },
  {
    key: "cascade_shift",
    title: "Зсунути чергу",
    desc: "Наступні записи кабінету посуваються — кожен у ПЕРШИЙ слот, куди реально вміщується (з урахуванням графіка, перерв, простоїв і буферів). Не однакова дельта для всіх.",
  },
  {
    key: "reschedule_conflicts",
    title: "Перенести конфліктних",
    desc: "Черга не рухається. Записи, чиї інтервали перетнулись із фактичним вікном, ідуть у «Потребує переносу» — реєстратура передзвонює і переносить.",
  },
];

export default function QueuePolicySettings({ initial }: { initial: QueuePolicyInitial }) {
  const [policy, setPolicy] = useState<QueueDelayPolicy>(initial.policy);
  const [threshold, setThreshold] = useState(String(initial.overlapThresholdMin));
  const [maxCascade, setMaxCascade] = useState(String(initial.maxCascadePatients));
  const [afterHours, setAfterHours] = useState(initial.allowAfterHoursShift);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  /* Ті самі межі, що в zod і в CHECK БД. Тримаємо їх синхронними СВІДОМО: інакше
     користувач ловить сирий 23514 з бази замість підказки в полі. */
  const thrNum = parseInt(threshold, 10);
  const thrBad = !(thrNum >= 5 && thrNum <= 120 && thrNum % 5 === 0);
  const casNum = parseInt(maxCascade, 10);
  const casBad = !(casNum >= 1 && casNum <= 100);
  const valid = !thrBad && !casBad;

  async function save() {
    if (!valid || saving) return;
    setSaving(true);
    setMsg(null);
    const res = await saveQueueDelayPolicy({
      policy,
      overlapThresholdMin: thrNum,
      maxCascadePatients: casNum,
      allowAfterHoursShift: afterHours,
    });
    setSaving(false);
    setMsg(res.ok
      ? { text: "Політику збережено", ok: true }
      : { text: "Помилка: " + res.error, ok: false });
  }

  return (
    <div className="qp-wrap">
      <div className="ctx-hint blue" style={{ fontSize: 13, marginBottom: 14 }}>
        Коли дослідження затягується і <b>фактично</b> перекриває наступний запис більше ніж на поріг,
        система рахує план і показує його вам. <b>Застосування завжди підтверджує адміністратор</b> —
        навіть якщо обрано автоматичну стратегію.
      </div>

      <div className="fld">
        <span className="fld-lab">Стратегія за замовчуванням</span>
        <div className="qp-opts">
          {OPTIONS.map((o) => (
            <button
              key={o.key}
              type="button"
              className={"qp-opt" + (policy === o.key ? " sel" : "")}
              onClick={() => setPolicy(o.key)}
              aria-pressed={policy === o.key}
            >
              <span className="qp-opt-title">{o.title}</span>
              <span className="qp-opt-desc">{o.desc}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="fld-row">
        <label className="fld">
          <span className="fld-lab">Поріг спрацювання, хв<span className="req">*</span></span>
          <input
            className={"inp" + (thrBad ? " invalid" : "")}
            type="number" min={5} max={120} step={5}
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
          <span className="fld-hint">
            {thrBad
              ? "Від 5 до 120 хв, кратно 5"
              : `Наїзд ≤ ${thrNum} хв вважаємо нормою — його поглинає буфер. Сценарій запускається, коли більше.`}
          </span>
        </label>

        <label className="fld">
          <span className="fld-lab">Максимум записів у плані<span className="req">*</span></span>
          <input
            className={"inp" + (casBad ? " invalid" : "")}
            type="number" min={1} max={100}
            value={maxCascade}
            onChange={(e) => setMaxCascade(e.target.value)}
          />
          <span className="fld-hint">
            {casBad ? "Від 1 до 100" : "Запобіжник: більше записів одним рішенням система не зсуне."}
          </span>
        </label>
      </div>

      <label className="fld" style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
        <input type="checkbox" checked={afterHours} onChange={(e) => setAfterHours(e.target.checked)} style={{ marginTop: 3 }} />
        <span>
          <span className="fld-lab" style={{ display: "block" }}>Дозволити зсув за межі робочого графіка</span>
          <span className="fld-hint">
            Вимкнено: запис, який не вміщується до кінця дня, <b>не виштовхується</b> за графік — він іде
            в «Потребує переносу». Увімкнено: план може вийти за графік, але кожен такий вихід
            все одно потребує окремого підтвердження і причини.
          </span>
        </span>
      </label>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6 }}>
        <button className="btn btn-primary" onClick={save} disabled={!valid || saving}>
          {saving ? "Зберігаємо…" : "Зберегти політику"}
        </button>
        {msg && (
          <span style={{ fontSize: 13, color: msg.ok ? "var(--green)" : "var(--red)" }}>{msg.text}</span>
        )}
      </div>
    </div>
  );
}
