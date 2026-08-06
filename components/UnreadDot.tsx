"use client";

/* ===== RadFlow — контекстна позначка непрочитаної зміни («червона крапка») =====
   ТЗ: CLAUDE_CONTEXTUAL_UNREAD_CHANGES_PROMPT.md.

   ⚠️ Стан НЕ передається лише кольором (WCAG 1.4.1 + правило проєкту «статус —
   глифом І кольором»): крапка завжди несе приховане текстове імʼя, яке каже,
   ЩО саме змінилось і ХТО змінив. Сама наявність крапки — теж неколірний
   сигнал (форма зʼявилась / зникла).

   ⚠️ Глобального дзвіночка, інбоксу й нижнього індикатора в системі немає за
   вимогою ТЗ. Ця крапка живе ТІЛЬКИ поруч із конкретною інформацією. */

import type { ChangeMarker } from "@/lib/unreadChanges";
import { topSeverity, unreadGroupLabel } from "@/lib/unreadChanges";

type Props = {
  /** Позначки, що стоять за цією крапкою (порожньо → нічого не малюємо). */
  markers: readonly ChangeMarker[];
  /** Показувати число, коли позначок кілька (пункти навігації, секції). */
  withCount?: boolean;
  /** Оголошувати появу асистивним технологіям. Вмикати ТОЧКОВО — на екрані
   *  не повинно бути десятка живих областей, що говорять одночасно. */
  live?: boolean;
  className?: string;
};

export default function UnreadDot({ markers, withCount = false, live = false, className }: Props) {
  if (!markers.length) return null;

  const sev = topSeverity(markers) ?? "info";
  const label = unreadGroupLabel(markers);
  const cls =
    "rf-dot rf-dot-" + sev + (withCount && markers.length > 1 ? " rf-dot-num" : "") +
    (className ? " " + className : "");

  return (
    <span
      className={cls}
      /* role="status" (ввічливий) — а не alert: зміна даних не є аварією і не
         повинна переривати те, що користувач зараз читає. */
      {...(live ? { role: "status" as const } : {})}
    >
      <span aria-hidden="true">{withCount && markers.length > 1 ? markers.length : "●"}</span>
      <span className="rf-vh">{label}</span>
    </span>
  );
}
