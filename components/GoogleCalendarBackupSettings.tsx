"use client";

/* ===== RadFlow — «Резервне копіювання в Google Calendar» (0160) =====

   Самостійний admin-блок у /setup (патерн QueuePolicySettings: зберігається
   сам, НЕ бере участі в dirty-снапшоті майстра). Сервер — єдине джерело
   істини: чекбокс тут лише ВІДОБРАЖАЄ canEnable, а кожна дія йде на роут,
   який повторює всі перевірки; відповідь сервера завжди коригує optimistic
   стан назад.

   Статус виражений гліфом + текстом + кольором (не самим кольором);
   причина disabled — видимим текстом, звʼязаним через aria-describedby. */

import { useCallback, useEffect, useRef, useState } from "react";
import ConfirmDialog from "@/components/ConfirmDialog";

type Status = {
  platformConfigured: boolean;
  status: "not_connected" | "connected_no_calendar" | "no_writable_calendar"
        | "ready" | "reauth_required" | "access_lost";
  enabled: boolean;
  canEnable: boolean;
  reason: string | null;
  calendarSummary: string | null;
  calendarIsPersonal: boolean;
  accessRole: "writer" | "owner" | null;
  lastVerifiedAt: string | null;
  lastSyncAt: string | null;
  version: number;
};

/* `selectable` рахує СЕРВЕР (/calendars) тим самим правилом, що й /select:
   другої копії правила «що таке особистий календар» у клієнті НЕМАЄ (с43). */
type CalItem = {
  id: string; summary: string; timeZone: string | null;
  accessRole: string; primary?: boolean; selectable?: boolean;
};

/* Повідомлення після OAuth-redirect (?gcal=<код> від callback-роуту). */
const GCAL_URL_MSG: Record<string, { text: string; kind: "ok" | "err" }> = {
  connected: { text: "Google Calendar підключено. Оберіть календар для резервної копії.", kind: "ok" },
  denied: { text: "Підключення скасовано на екрані Google.", kind: "err" },
  state_invalid: { text: "Сесія підключення протухла або невалідна — спробуйте ще раз.", kind: "err" },
  exchange_failed: { text: "Google відхилив обмін коду — спробуйте підключити повторно.", kind: "err" },
  no_refresh_token: { text: "Google не видав токен доступу — спробуйте підключити повторно.", kind: "err" },
  conflict: { text: "Налаштування щойно змінив інший адміністратор — оновіть сторінку.", kind: "err" },
  not_configured: { text: "Функцію ще не активовано на платформі.", kind: "err" },
  forbidden: { text: "Недостатньо прав для підключення.", kind: "err" },
  error: { text: "Не вдалося завершити підключення — спробуйте ще раз.", kind: "err" },
};

/* no_writable_calendar через /status не приходить (роут не ходить у Google
   на кожен рендер — свідомо); стан лишається в мапі для повноти контракту,
   а користувач бачить те саме пояснення в порожньому списку календарів. */
const STATUS_VIEW: Record<Status["status"], { glyph: string; color: string; text: string }> = {
  not_connected: { glyph: "○", color: "var(--text-muted)", text: "Спочатку підключіть Google-акаунт і надайте доступ до календаря." },
  connected_no_calendar: { glyph: "◐", color: "var(--orange)", text: "Акаунт підключено. Оберіть календар для резервної копії." },
  no_writable_calendar: { glyph: "◐", color: "var(--orange)", text: "Обраний Google-акаунт не має права запису до доступних календарів." },
  ready: { glyph: "●", color: "var(--green)", text: "Google Calendar підключено. Можна увімкнути резервне копіювання." },
  reauth_required: { glyph: "▲", color: "var(--red)", text: "Доступ до календаря втрачено. Підключіть Google Calendar повторно." },
  access_lost: { glyph: "▲", color: "var(--red)", text: "Доступ до календаря втрачено. Відновіть права або оберіть інший календар." },
};

export default function GoogleCalendarBackupSettings() {
  const [st, setSt] = useState<Status | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [cals, setCals] = useState<CalItem[] | null>(null);
  const [calsBusy, setCalsBusy] = useState(false);
  const [selBusy, setSelBusy] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [discAsk, setDiscAsk] = useState(false);
  const [discBusy, setDiscBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations/google-calendar/status", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as Status;
      if (mounted.current) { setSt(data); setLoadErr(false); }
    } catch {
      if (mounted.current) setLoadErr(true);
    }
  }, []);

  useEffect(() => {
    // код із callback-redirect → повідомлення; параметр прибираємо з URL,
    // щоб F5 не показував його вдруге
    const params = new URLSearchParams(window.location.search);
    const code = params.get("gcal");
    if (code && GCAL_URL_MSG[code]) {
      setMsg(GCAL_URL_MSG[code]);
      params.delete("gcal");
      const q = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (q ? `?${q}` : ""));
    }
    void reload();
  }, [reload]);

  async function loadCalendars() {
    setCalsBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/integrations/google-calendar/calendars", { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setCals(null);
        setMsg({ kind: "err", text: apiErrText(data?.error) });
        await reload();
        return;
      }
      setCals((data?.calendars ?? []) as CalItem[]);
    } catch {
      setMsg({ kind: "err", text: "Мережева помилка — спробуйте ще раз." });
    } finally {
      setCalsBusy(false);
    }
  }

  async function selectCalendar(calendarId: string) {
    if (!st || selBusy) return;
    setSelBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/integrations/google-calendar/select", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ calendarId, version: st.version }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setMsg({ kind: "err", text: apiErrText(data?.error) });
      } else {
        setMsg({ kind: "ok", text: "Календар збережено. Можна увімкнути резервне копіювання." });
        setCals(null);
      }
      await reload();
    } catch {
      setMsg({ kind: "err", text: "Мережева помилка — спробуйте ще раз." });
    } finally {
      setSelBusy(false);
    }
  }

  async function toggleEnabled(next: boolean) {
    if (!st || toggleBusy) return;
    setToggleBusy(true);
    setMsg(null);
    const prev = st;
    setSt({ ...st, enabled: next }); // optimistic; відповідь сервера скоригує
    try {
      const res = await fetch("/api/integrations/google-calendar/enable", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next, version: st.version }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setSt(prev); // rollback
        setMsg({ kind: "err", text: apiErrText(data?.error) });
      } else {
        setMsg(next
          ? { kind: "ok", text: "Резервне копіювання увімкнено. Перша синхронізація зʼявиться в календарі протягом ~2 хвилин." }
          : { kind: "ok", text: "Резервне копіювання вимкнено. Події в календарі не видаляються." });
      }
      await reload();
    } catch {
      setSt(prev);
      setMsg({ kind: "err", text: "Мережева помилка — спробуйте ще раз." });
    } finally {
      setToggleBusy(false);
    }
  }

  async function disconnect() {
    if (!st || discBusy) return;
    setDiscBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/integrations/google-calendar/disconnect", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: st.version }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setMsg({ kind: "err", text: apiErrText(data?.error) });
      } else {
        setMsg(data?.googleRevoked
          ? { kind: "ok", text: "Google Calendar відключено, доступ у Google відкликано." }
          : { kind: "ok", text: "Відключено. Доступ у Google відкликати не вдалося — приберіть RadFlow у налаштуваннях Google-акаунта (Безпека → Сторонній доступ)." });
        setCals(null);
      }
      await reload();
    } catch {
      setMsg({ kind: "err", text: "Мережева помилка — спробуйте ще раз." });
    } finally {
      setDiscBusy(false);
      setDiscAsk(false);
    }
  }

  /* Токен планувальника тут БУВ (0160) і прибраний у 0161: синк смикає
     pg_cron під CRON_SECRET, адмінові клініки ніякі токени не потрібні. */

  /* ── рендер ── */

  if (loadErr) {
    return (
      <div className="ctx-hint red" role="alert">
        <div style={{ marginBottom: 8 }}>Стан підключення не завантажився.</div>
        <button className="btn btn-secondary" onClick={() => { setLoadErr(false); void reload(); }}>
          Спробувати ще раз
        </button>
      </div>
    );
  }
  if (!st) {
    return <div className="ctx-hint" aria-busy="true">Перевіряємо доступ…</div>;
  }

  if (!st.platformConfigured) {
    return (
      <div>
        <div className="ctx-hint" role="note" style={{ marginBottom: st.enabled ? 12 : 0 }}>
          Резервне копіювання в Google Calendar ще не активовано на платформі.
          Зверніться до підтримки RadFlow.
        </div>
        {/* Вимкнути МОЖНА завжди (дизайн §5.2) — сервер обробляє
            enabled=false ДО перевірки платформи; ховати кнопку означало б
            «увімкнено назавжди» при знятому env (ревʼю с42). */}
        {st.enabled && (
          <button className="btn btn-secondary" onClick={() => toggleEnabled(false)}
                  disabled={toggleBusy} aria-busy={toggleBusy}>
            Вимкнути резервне копіювання
          </button>
        )}
      </div>
    );
  }

  const view = STATUS_VIEW[st.status];
  const connected = st.status !== "not_connected";
  /* с43: особисті календарі показуємо в списку — але недоступними і з
     причиною. Мовчазне зникнення очевидного варіанта читається як баг, тому
     список рендериться ЗАВЖДИ, навіть коли придатних у ньому нема.
     Порожній список ПРИДАТНИХ ≠ порожній список взагалі: тексти різні. */
  const selectableCals = cals ? cals.filter((c) => c.selectable !== false) : [];
  const checkboxDisabled = toggleBusy || (!st.enabled && !st.canEnable);

  return (
    <div className="qp-wrap">
      <div className="ctx-hint blue" style={{ fontSize: "0.8125rem", marginBottom: 14 }}>
        Закритий Google-календар клініки з останньою копією черги — аварійне
        джерело на випадок недоступності RadFlow. Дані течуть лише в один бік
        (RadFlow → Google), календар не редагується і не замінює дошку.
      </div>

      {msg && (
        <div className={"ctx-hint " + (msg.kind === "ok" ? "green" : "red")} role="status" aria-live="polite"
             style={{ marginBottom: 12 }}>
          {msg.text}
        </div>
      )}

      {/* Стан: гліф + текст + колір (не лише колір) */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 12 }}>
        <span aria-hidden="true" style={{ color: view.color, fontSize: "1rem", lineHeight: 1.4 }}>{view.glyph}</span>
        <div>
          <div id="gcal-status-text" style={{ lineHeight: 1.5 }}>{view.text}</div>
          {(st.calendarSummary || st.calendarIsPersonal) && (st.status === "ready" || st.enabled) && (
            <div style={{ fontSize: "0.8125rem", color: "var(--text-muted)", marginTop: 2 }}>
              {/* назви особистого календаря в контракті НЕМАЄ: його summary у
                  Google — це адреса акаунта (ревʼю с43) */}
              Календар: <b>{st.calendarSummary ?? "особистий календар акаунта"}</b>
              {st.lastSyncAt && <> · остання синхронізація {fmtWhen(st.lastSyncAt)}</>}
            </div>
          )}
          {/* с43 — підключення, зроблені до заборони особистих календарів.
              Попередження, а не помилка: дзеркало працює. Показуємо в БУДЬ-
              ЯКОМУ стані, у т.ч. reauth_required — інакше людина побачила б
              проблему аж коли повторний вибір відхилять. Кнопку не називаємо:
              її підпис залежить від стану підключення. */}
          {st.calendarIsPersonal && (
            <div className="ctx-hint orange" role="note"
                 style={{ fontSize: "0.78125rem", marginTop: 8 }}>
              Копія лежить в <b>особистому</b> календарі акаунта. У ній — імена
              й телефони пацієнтів: щоб персонал міг читати її в аварії, доступ
              довелося б відкрити разом з усіма приватними подіями власника.
              Створіть у Google окремий календар і оберіть його тут — повторний
              вибір особистого RadFlow уже відхиляє. Події, які вже потрапили в
              особистий календар, приберіть вручну: RadFlow видаляє свої події
              лише в поточному календарі.
            </div>
          )}
        </div>
      </div>

      {/* Дії підключення */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        {!connected && (
          <a className="btn btn-primary" href="/api/integrations/google-calendar/start">
            Підключити Google Calendar
          </a>
        )}
        {connected && (st.status === "reauth_required" || st.status === "access_lost") && (
          <a className="btn btn-primary" href="/api/integrations/google-calendar/start">
            Підключити повторно
          </a>
        )}
        {connected && st.status !== "reauth_required" && (
          <button className="btn btn-secondary" onClick={loadCalendars}
                  disabled={calsBusy} aria-busy={calsBusy}>
            {calsBusy ? "Завантажуємо календарі…" : st.status === "ready" ? "Змінити календар" : "Оберіть календар для резервної копії"}
          </button>
        )}
        {connected && (
          <button className="btn btn-secondary" onClick={() => setDiscAsk(true)} disabled={discBusy}>
            Відключити
          </button>
        )}
      </div>

      {/* Список календарів (лише writer|owner; порожньо = немає writable) */}
      {cals !== null && (
        <div className="fld" style={{ marginBottom: 14 }}>
          <span className="fld-lab">Оберіть календар для резервної копії</span>
          {selectableCals.length === 0 && (
            <div className="ctx-hint red" role="status" style={{ marginBottom: cals.length ? 8 : 0 }}>
              {cals.length === 0
                ? "Обраний Google-акаунт не має права запису до жодного календаря."
                : "Придатних календарів немає: доступні лише особисті календарі, а тримати копію в них не можна — у ній імена й телефони пацієнтів."}
              {" "}Створіть у Google окремий календар (Settings → Add calendar →
              Create new) з назвою «RadFlow Backup — ваша клініка» і натисніть
              кнопку вище ще раз, щоб оновити список.
            </div>
          )}
          {cals.length > 0 && (
            /* Звичайні action-кнопки, НЕ listbox: справжня listbox-роль
               вимагає roving tabindex і стрілки (APG), а вигадана роль без
               реалізації гірша за відсутню (ревʼю с42). Патерн qp-opt як у
               QueuePolicySettings.
               Заборонені календарі — `aria-disabled`, а НЕ нативний `disabled`:
               нативний викидає кнопку з tab-порядку, і причина відмови стає
               недосяжною з клавіатури й для скрінрідера (ревʼю с43). */
            <div role="group" aria-label="Календарі акаунта"
                 style={{ display: "grid", gap: 6 }}>
              {cals.map((c) => {
                const forbidden = c.selectable === false;
                return (
                  <button key={c.id} type="button" className="qp-opt"
                          aria-disabled={forbidden}
                          disabled={selBusy} aria-busy={selBusy}
                          onClick={() => { if (!forbidden) void selectCalendar(c.id); }}>
                    <span className="qp-opt-title">{c.summary}{forbidden ? " — особистий" : ""}</span>
                    <span className="qp-opt-desc">
                      {forbidden
                        ? "Не можна обрати: у копії — імена й телефони пацієнтів, а доступ для персоналу відкрив би разом з нею й усі приватні події акаунта."
                        : <>{c.timeZone ?? "зона невідома"} · роль: {c.accessRole === "owner" ? "власник" : "запис"}</>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <span className="fld-hint">
            Потрібен ОКРЕМИЙ закритий календар: у ньому житимуть імена й
            телефони пацієнтів — доступ лише персоналу клініки.
          </span>
        </div>
      )}

      {/* Головний перемикач */}
      <label className="fld" style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
        <input
          type="checkbox"
          checked={st.enabled}
          disabled={checkboxDisabled}
          aria-describedby="gcal-status-text gcal-enable-hint"
          aria-busy={toggleBusy}
          onChange={(e) => toggleEnabled(e.target.checked)}
          style={{ marginTop: 3 }}
        />
        <span>
          <span className="fld-lab" style={{ display: "block" }}>Резервна копія черги в Google Calendar</span>
          <span className="fld-hint" id="gcal-enable-hint">
            {st.enabled
              ? "Черга дзеркалиться кожні ~2 хвилини. Вимкнути можна будь-коли — події в календарі лишаться."
              : st.canEnable
                ? "Все готово — увімкніть, щоб почати дзеркалити чергу."
                : "Стане доступним після підключення Google і вибору календаря з правом запису."}
          </span>
        </span>
      </label>

      {/* Підтвердження відключення — штатна модалка (фокус-пастка/Esc/
          повернення фокуса через useModalA11y), не саморобний alertdialog */}
      {discAsk && (
        <ConfirmDialog
          title="Відключити Google Calendar?"
          text={<>Резервне копіювання зупиниться, доступ RadFlow до акаунта буде
            відкликано. Події в календарі <b>не видаляються</b>.</>}
          confirmLabel="Так, відключити"
          cancelLabel="Ні"
          danger
          busy={discBusy}
          onConfirm={disconnect}
          onClose={() => setDiscAsk(false)}
        />
      )}
    </div>
  );
}

function apiErrText(code: unknown): string {
  switch (code) {
    case "google_not_configured": return "Функцію ще не активовано на платформі.";
    case "google_not_connected": return "Спочатку підключіть Google-акаунт і надайте доступ до календаря.";
    case "calendar_not_selected": return "Спочатку оберіть календар для резервної копії.";
    case "calendar_not_writable": return "Обраний Google-акаунт не має права запису до цього календаря.";
    case "calendar_is_primary": return "Особистий календар не підходить: у резервній копії — імена й телефони пацієнтів. Створіть у Google окремий календар і оберіть його.";
    case "reauth_required": return "Доступ до календаря втрачено. Підключіть Google Calendar повторно.";
    case "calendar_access_lost": return "Доступ до календаря втрачено. Відновіть права або оберіть інший календар.";
    case "conflict": return "Налаштування щойно змінив інший адміністратор — оновіть сторінку.";
    case "google_unavailable": return "Google тимчасово недоступний — синхронізація затримується, дані в календарі не видаляються.";
    case "rate_limited": return "Забагато запитів — зачекайте хвилину.";
    default:
      // requireRole віддає ГОТОВИЙ український текст («Забагато запитів…»,
      // «Недостатньо прав») — рядок із пробілом показуємо як є; короткий
      // технічний код людині не кажемо (ревʼю с42)
      return typeof code === "string" && code.includes(" ")
        ? code
        : "Не вдалося виконати дію — спробуйте ще раз.";
  }
}

function fmtWhen(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]} ${m[4]}:${m[5]} UTC` : iso;
}
