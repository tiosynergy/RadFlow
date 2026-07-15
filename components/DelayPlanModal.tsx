"use client";

/* ===== RadFlow — модалка «Політика черги при затримці» (0078–0081, етап 3b) =====

   Дослідження в кабінеті затягнулося і наїжджає на наступні записи. Сервер
   (previewDelayPlan) уже порахував ОБИДВА плани — тут адмін їх дивиться,
   перемикає стратегію і підтверджує ОДИН. Застосування — атомарне через
   queue_apply_delay_plan_rpc (все-або-нічого).

   ЧОМУ ПЛАН ПРИЙШОВ ГОТОВИМ, А НЕ РАХУЄТЬСЯ ТУТ. `delay_min` і сітка слотів
   залежать від «зараз» у настінному часі клініки. Той самий розрахунок робить
   сервер (щоб застосувати) і показує ця модалка (щоб адмін бачив, ЩО підтверджує).
   Дві реалізації розійшлися б — тому обидва плани приходять із previewDelayPlan
   одним об'єктом, а модалка їх лише відмальовує.

   РОЛІ. Дивитися може будь-хто з персоналу (радіолог теж — він бачить затримку і
   може ініціювати перерахунок). ЗАСТОСОВУЄ лише адмін — canApply. Це не лише UI:
   справжній рубіж — гейт auth_is_admin() усередині RPC. */

import { useMemo, useState } from "react";
import { useModalA11y } from "@/lib/useModalA11y";
import type { DelayPreview } from "@/app/queue/actions";
import type { DelayPlan, PlanItem } from "@/lib/delayPlan";

export interface DelayApplyPayload {
  strategy: "cascade_shift" | "reschedule_conflicts";
  items: { id: string; kind: "shift" | "no_fit" | "conflict"; from: string; to: string | null }[];
  reason: string | null;
}

interface Props {
  preview: DelayPreview;
  roomName: string;
  /** Персонал може дивитися; застосовує лише адмін. */
  canApply: boolean;
  busy: boolean;
  onClose: () => void;
  onApply: (payload: DelayApplyPayload) => void;
}

const STRATEGY_LABEL: Record<DelayPlan["strategy"], string> = {
  cascade_shift: "Зсунути чергу",
  reschedule_conflicts: "Перенести конфліктних",
};

const KIND_META: Record<PlanItem["kind"], { label: string; cls: string }> = {
  keep: { label: "Лишається", cls: "gray" },
  shift: { label: "Зсув", cls: "blue" },
  no_fit: { label: "Потребує переносу", cls: "orange" },
  conflict: { label: "Потребує переносу", cls: "orange" },
};

const shortName = (n: string | null | undefined) => String(n || "—").split(" ").slice(0, 2).join(" ");

export default function DelayPlanModal({ preview, roomName, canApply, busy, onClose, onApply }: Props) {
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);

  // Стартова стратегія — політика центру, якщо вона автоматична; інакше «зсунути».
  const [strategy, setStrategy] = useState<DelayPlan["strategy"]>(
    preview.policy === "reschedule_conflicts" ? "reschedule_conflicts" : "cascade_shift"
  );
  const [reason, setReason] = useState("");

  const plan = strategy === "cascade_shift" ? preview.cascade : preview.conflicts;

  // Показуємо лише те, що реально змінюється (keep — фон, його не чіпаємо).
  const affected = useMemo(() => plan.items.filter((i) => i.kind !== "keep"), [plan]);

  // Причина обов'язкова, якщо хоч один слав їде ЗА графік (0078: schedule_exceptions).
  const needsReason = affected.some((i) => i.offSchedule);
  const reasonMissing = needsReason && !reason.trim();
  const nothingToDo = affected.length === 0;

  const applyDisabled = busy || !canApply || nothingToDo || reasonMissing;

  const doApply = () => {
    if (applyDisabled) return;
    onApply({
      strategy,
      items: affected.map((i) => ({ id: i.id, kind: i.kind as "shift" | "no_fit" | "conflict", from: i.from, to: i.to })),
      reason: reason.trim() || null,
    });
  };

  return (
    <div className="overlay">
      <div className="dialog fade-in" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Політика черги при затримці"
        style={{ maxWidth: 560, width: "100%" }}>
        <div className="dlg-head">
          <div className="dlg-title">Затримка в кабінеті · {roomName}</div>
          <button className="icon-btn" onClick={onClose} aria-label="Закрити">✕</button>
        </div>

        <div className="dlg-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Факт затримки. */}
          <div className="ctx-hint red" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
            <b>Наїзд на чергу — {preview.delayMin} хв</b> (поріг центру {preview.thresholdMin} хв).
            {" "}Кабінет реально звільниться о <b className="tabular">{fmtMin(preview.freeAtMin)}</b>.
          </div>

          {/* Перемикач стратегії. */}
          <div>
            <div className="fld-lab" style={{ marginBottom: 6 }}>Стратегія</div>
            <div style={{ display: "flex", gap: 6 }}>
              {(["cascade_shift", "reschedule_conflicts"] as const).map((s) => (
                <button key={s} type="button" onClick={() => setStrategy(s)}
                  className={"btn btn-sm " + (strategy === s ? "btn-primary" : "btn-secondary")}
                  style={{ flex: 1 }} aria-pressed={strategy === s}>
                  {STRATEGY_LABEL[s]}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 6 }}>
              {strategy === "cascade_shift"
                ? "Кожен наступний запис їде на перший слот, куди вміщується цілком. Хто не влазить у день — у «Потребує переносу»."
                : "Чергу не рухаємо. Записи, що перетнулися з фактичним вікном кабінету, — у «Потребує переносу» (обдзвонить реєстратура)."}
            </div>
          </div>

          {/* Прев'ю затронутих. */}
          <div>
            <div className="fld-lab" style={{ marginBottom: 6, display: "flex", justifyContent: "space-between" }}>
              <span>Зміни ({affected.length})</span>
              {plan.needsReschedule > 0 && <span className="badge orange" style={{ fontSize: 10.5 }}>у переносі: {plan.needsReschedule}</span>}
            </div>

            {nothingToDo ? (
              <div style={{ fontSize: 12.5, color: "var(--text-muted)", padding: "8px 0" }}>
                Черга встигає — зсувати нікого. Можливо, дослідження вже завершили.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", maxHeight: 260, overflowY: "auto" }}>
                {affected.map((i) => {
                  const m = KIND_META[i.kind];
                  return (
                    <div key={i.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderTop: "1px solid var(--border)" }}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {shortName(i.name)}
                      </span>
                      <span className="tabular" style={{ fontSize: 12.5, color: "var(--text-muted)", flexShrink: 0 }}>
                        {i.kind === "shift" && i.to
                          ? <>{i.from} → <b style={{ color: "var(--text)" }}>{i.to}</b>{i.shiftMin ? <> (+{i.shiftMin})</> : null}</>
                          : <>{i.from} →</>}
                      </span>
                      <span className={"badge " + m.cls} style={{ fontSize: 10, flexShrink: 0 }}>{m.label}</span>
                      {i.offSchedule && <span className="badge orange" style={{ fontSize: 10, flexShrink: 0 }} title="Слот виходить за робочий графік — потрібна причина">⏰</span>}
                    </div>
                  );
                })}
              </div>
            )}

            {plan.truncated && (
              <div style={{ fontSize: 11.5, color: "var(--orange)", marginTop: 6 }}>
                ⚠ План уперся в стелю центру — частину записів дня він не чіпає. Їх доведеться перенести окремо.
              </div>
            )}
          </div>

          {/* Причина — обов'язкова, якщо є вихід за графік. */}
          {needsReason && (
            <div>
              <label className="fld-lab" htmlFor="delay-reason">
                Причина роботи поза графіком <span className="req">*</span>
              </label>
              <textarea id="delay-reason" value={reason} onChange={(e) => setReason(e.target.value)}
                rows={2} maxLength={500} placeholder="Напр.: погоджено із завідувачем, пацієнт із області"
                style={{ width: "100%", resize: "vertical", marginTop: 4 }} />
              <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>
                Хоча б один слот виходить за робочий графік кабінету — причина ляже в журнал винятків.
              </div>
            </div>
          )}

          {!canApply && (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Масову зміну черги підтверджує адміністратор центру. Ви бачите план, але не застосовуєте його.
            </div>
          )}
        </div>

        <div className="dlg-foot">
          <button className="btn btn-ghost" onClick={onClose}>Закрити</button>
          {canApply && (
            <button className="btn btn-primary" disabled={applyDisabled} aria-busy={busy} onClick={doApply}
              title={reasonMissing ? "Вкажіть причину роботи поза графіком" : nothingToDo ? "Немає що застосовувати" : "Застосувати план"}>
              {busy ? "…" : "Застосувати план"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function fmtMin(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}
