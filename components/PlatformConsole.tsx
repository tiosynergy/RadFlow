"use client";

/* ===== RadFlow — консоль оператора платформи (0206, с84) =====
   Оператор керує ЦЕНТРАМИ як клієнтами: перелік центрів зі статусом і
   показниками, картка центру (облік: статус / тариф / оплачено до / нотатки;
   реквізити; штат; кабінети; інтеграції; журнал), оператори платформи і журнал
   дій. Пацієнтських даних тут немає і бути не може — роути їх не віддають.

   Усі дані — fetch до /api/platform/** (service-role лише на сервері, після
   гейта). Стан екрана — у URL (`?view=…&clinic=…`), тож картку можна відкрити
   за посиланням і повернутись назад кнопкою браузера. Оболонка своя
   (styles/prototype/platform.css): кабінетів, дошки й бейджів у оператора немає. */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signOutAndRedirect } from "@/lib/auth";
import Toast, { type ToastData } from "@/components/Toast";
import ConfirmDialog from "@/components/ConfirmDialog";
import BaseDialog from "@/components/BaseDialog";
import { passwordTooLong, PASSWORD_LIMIT_HINT } from "@/lib/passwordRules";
import {
  CLINIC_STATUSES, CLINIC_STATUS_LABEL, PLAN_MAX, STATUS_REASON_MAX, ACCOUNT_NOTES_MAX,
  statusNeedsReason, platformLogText,
  type ClinicStatus, type ClinicListItem, type PlatformLogItem, type PlatformOperatorRow, type ClinicStats, type PlatformAccountRow,
} from "@/lib/platformContract";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/platform.css";

type View = "clinics" | "operators" | "log";
const VIEWS: Array<{ key: View; label: string; ic: string }> = [
  { key: "clinics", label: "Центри", ic: "🏥" },
  { key: "operators", label: "Оператори", ic: "🛠" },
  { key: "log", label: "Журнал дій", ic: "📜" },
];

/* Статус — гліфом І кольором (AGENTS.md: колір не єдиний носій стану). */
const STATUS_BADGE: Record<ClinicStatus, { cls: string; glyph: string }> = {
  trial: { cls: "blue", glyph: "◔" },
  active: { cls: "green", glyph: "●" },
  suspended: { cls: "orange", glyph: "⏸" },
  archived: { cls: "gray", glyph: "▣" },
};
const ROLE_LABEL: Record<string, string> = {
  admin: "Адміністратор", registrar: "Реєстратор", radiologist: "Радіолог", referrer: "Направник", ceo: "Керівник",
};
const REF_STATUS_LABEL: Record<string, string> = {
  active: "активних", pending_clinic: "запитів від лікарів", pending_referrer: "запрошень чекають", revoked: "відкликаних", declined: "відхилених",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  /* Ключ дати (paid_until, YYYY-MM-DD) — без Date: `new Date("2026-10-15")` — це
     UTC-північ, і на захід від Гринвіча показалося б 14.10. */
  const key = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (key) return `${key[3]}.${key[2]}.${key[1]}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function daysAgo(iso: string | null | undefined): string {
  if (!iso) return "ще не було";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) return "сьогодні";
  if (days === 1) return "вчора";
  return `${days} дн. тому`;
}
function paidBadge(paidUntil: string | null): { cls: string; text: string } | null {
  if (!paidUntil) return null;
  const end = new Date(paidUntil + "T23:59:59");
  const left = Math.ceil((end.getTime() - Date.now()) / 86_400_000);
  if (left < 0) return { cls: "red", text: `прострочено ${-left} дн.` };
  if (left <= 7) return { cls: "orange", text: `лишилось ${left} дн.` };
  return { cls: "green", text: `до ${fmtDate(paidUntil)}` };
}

const SESSION_GONE = "Сесія завершилась — увійдіть знову";

async function api<T>(path: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string; status: number; field?: string }> {
  try {
    const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    /* 401 = сесії немає (вийшла, сплила, її завершили): кажемо це прямо, а не
       серверне «Не авторизовано» — людині треба знати, що робити далі. */
    if (res.status === 401) return { ok: false, error: SESSION_GONE, status: 401 };
    if (!res.ok) return { ok: false, error: (data && data.error) || "Помилка запиту", status: res.status, field: typeof data?.field === "string" ? data.field : undefined };
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, error: "Не вдалося звʼязатися із сервером", status: 0 };
  }
}

function StatusBadge({ status }: { status: ClinicStatus }) {
  const b = STATUS_BADGE[status] ?? STATUS_BADGE.trial;
  return (
    <span className={"badge " + b.cls}>
      <span aria-hidden="true">{b.glyph}</span> {CLINIC_STATUS_LABEL[status] ?? status}
    </span>
  );
}

function SecretBox({ secret, label, onCopied }: { secret: string; label: string; onCopied: (ok: boolean) => void }) {
  async function copy() {
    try { await navigator.clipboard.writeText(secret); onCopied(true); } catch { onCopied(false); }
  }
  return (
    <div className="pf-secret" role="status">
      <span><span aria-hidden="true">🔑</span> {label}:</span>
      <code>{secret}</code>
      <button type="button" className="btn btn-secondary btn-sm" onClick={copy}>Скопіювати</button>
      <span className="pf-hint">Показано один раз — передайте людині поза системою; після входу вона змінить його на свій кнопкою «Змінити пароль».</span>
    </div>
  );
}

/* ───────────────────────────── Центри: перелік ───────────────────────────── */

function ClinicsView({ onOpen }: { onOpen: (id: string) => void }) {
  const [items, setItems] = useState<ClinicListItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<ClinicStatus | "all">("all");
  const [q, setQ] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await api<{ clinics: ClinicListItem[] }>("/api/platform/clinics");
      if (!alive) return;
      if (!r.ok) { setErr(r.error); return; }
      setItems(r.data.clinics);
    })();
    return () => { alive = false; };
  }, []);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items?.length ?? 0 };
    for (const s of CLINIC_STATUSES) c[s] = (items ?? []).filter((x) => x.status === s).length;
    return c;
  }, [items]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (items ?? []).filter((x) => (filter === "all" || x.status === filter)
      && (!needle || x.name.toLowerCase().includes(needle) || (x.city ?? "").toLowerCase().includes(needle)));
  }, [items, filter, q]);

  if (err) return <div className="pf-card"><div className="pf-err">{err}</div></div>;
  if (!items) return <div className="pf-empty" role="status">Завантаження центрів…</div>;

  return (
    <div className="pf-page">
      <div className="pf-card">
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div className="pills" role="group" aria-label="Фільтр за статусом">
            {(["all", ...CLINIC_STATUSES] as const).map((s) => (
              <button
                key={s}
                type="button"
                className={"pill" + (filter === s ? " active" : "")}
                aria-pressed={filter === s}
                onClick={() => setFilter(s)}
              >
                {s === "all" ? "Усі" : CLINIC_STATUS_LABEL[s]} <span className="ct">{counts[s] ?? 0}</span>
              </button>
            ))}
          </div>
          <label className="fld" style={{ flex: 1, minWidth: 200 }}>
            <span className="fld-lab">Пошук</span>
            <input className="inp" value={q} onChange={(e) => setQ(e.target.value)} placeholder="назва або місто" />
          </label>
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="pf-empty">Центрів за цим фільтром немає.</div>
      ) : (
        <div className="pf-table-wrap">
          <table className="pf-table">
            <thead>
              <tr>
                <th scope="col">Центр</th>
                <th scope="col">Статус</th>
                <th scope="col">Тариф</th>
                <th scope="col">Оплачено до</th>
                <th scope="col" className="num">Штат</th>
                <th scope="col" className="num">Кабінети</th>
                <th scope="col" className="num">Записи, 30 дн</th>
                <th scope="col">Активність</th>
                <th scope="col">Зареєстровано</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => {
                const pb = paidBadge(c.paid_until);
                return (
                  <tr key={c.id}>
                    <td>
                      <button type="button" className="pf-rowbtn" onClick={() => onOpen(c.id)}>{c.name}</button>
                      <div className="muted" style={{ fontSize: "0.75rem" }}>{c.city || "місто не вказано"}{!c.configured_at ? " · не налаштовано" : ""}</div>
                    </td>
                    <td><StatusBadge status={c.status} /></td>
                    <td>{c.plan || <span className="muted">—</span>}</td>
                    <td>{pb ? <span className={"badge " + pb.cls}>{pb.text}</span> : <span className="muted">—</span>}</td>
                    <td className="num">{c.stats ? c.stats.staff_n : "—"}</td>
                    <td className="num">{c.stats ? `${c.stats.rooms_active_n}/${c.stats.rooms_n}` : "—"}</td>
                    <td className="num">{c.stats ? c.stats.entries_30d : "—"}</td>
                    <td className="muted">{c.stats ? daysAgo(c.stats.last_activity_at) : "—"}</td>
                    <td className="muted">{fmtDate(c.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="pf-hint" style={{ marginTop: 10 }}>
        Статус без запису в обліку — «Пробний». Записи рахуються за датою дослідження; активність — останній рух у черзі центру.
        {" "}{items.length ? "" : "Жодного центру ще не зареєстровано."}
      </p>
    </div>
  );
}

/* ───────────────────────────── Центр: картка ────────────────────────────── */

type ClinicCardData = {
  clinic: { id: string; name: string; city: string | null; address: string | null; phones: unknown[]; emails: unknown[]; timezone: string; created_at: string; configured_at: string | null; queue_delay_policy: string };
  status: ClinicStatus;
  account: PlatformAccountRow | null;
  stats: ClinicStats | null;
  people: Array<{ id: string; full_name: string; role: string; login: string; approved: boolean; password_set: boolean; created_at: string; email: string | null; phone: string | null }>;
  referrers: Record<string, number>;
  ceos: Record<string, number>;
  rooms: Array<{ id: string; name: string; modality: string; apparatus_model: string | null; active: boolean }>;
  integrations: {
    keys: Array<{ id: string; name: string; key_prefix: string; active: boolean; revoked_at: string | null; created_at: string; last_used_at: string | null }>;
    webhooks: Array<{ id: string; host: string; enabled: boolean; created_at: string }>; // host — з маскою ліворуч (див. роут)
    gcal: { status: string; enabled: boolean; last_sync_at: string | null; last_error_code: string | null } | null;
  };
  log: PlatformLogItem[];
};

function ClinicCard({ id, onBack, notify }: { id: string; onBack: () => void; notify: (msg: string, type?: string) => void }) {
  const [data, setData] = useState<ClinicCardData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gen, setGen] = useState(0);
  const reload = useCallback(() => setGen((g) => g + 1), []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await api<ClinicCardData>(`/api/platform/clinics/${id}`);
      if (!alive) return;
      if (!r.ok) { setErr(r.error); return; }
      setErr(null);
      setData(r.data);
    })();
    return () => { alive = false; };
  }, [id, gen]);

  if (err) return <div className="pf-page"><div className="pf-card"><div className="pf-err">{err}</div><button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 10 }} onClick={onBack}>← До переліку</button></div></div>;
  if (!data) return <div className="pf-empty" role="status">Завантаження картки…</div>;

  const { clinic, account, stats } = data;
  const pb = paidBadge(account?.paid_until ?? null);

  return (
    <div className="pf-page">
      <div className="pf-card">
        {/* Заголовок — лише назва: бейдж і кнопка поза <h2>, інакше імʼя
            заголовка для ридера — «Центр Один Пробний ← До переліку». */}
        <div className="pf-card-head">
          <h2>{clinic.name}</h2>
          <StatusBadge status={data.status} />
          <span className="spacer" />
          <button type="button" className="btn btn-secondary btn-sm" onClick={onBack}>← До переліку</button>
        </div>
        <dl className="pf-kv">
          <dt>Місто</dt><dd>{clinic.city || "—"}</dd>
          <dt>Адреса</dt><dd>{clinic.address || "—"}</dd>
          <dt>Телефони центру</dt><dd>{clinic.phones.length ? clinic.phones.map(String).join(", ") : "—"}</dd>
          <dt>Пошта центру</dt><dd>{clinic.emails.length ? clinic.emails.map(String).join(", ") : "—"}</dd>
          <dt>Часова зона</dt><dd>{clinic.timezone}</dd>
          <dt>Зареєстровано</dt><dd>{fmtDateTime(clinic.created_at)}</dd>
          <dt>Налаштовано</dt><dd>{clinic.configured_at ? fmtDateTime(clinic.configured_at) : "ще ні (майстер не завершено)"}</dd>
          <dt>Політика черги</dt><dd>{clinic.queue_delay_policy}</dd>
        </dl>
      </div>

      <div className="pf-grid-2">
        <StatusPanel clinicId={id} current={data.status} account={account} onDone={reload} notify={notify} />
        <AccountPanel clinicId={id} account={account} paid={pb} onDone={reload} notify={notify} />
      </div>

      <div className="pf-card">
        <h2>Показники</h2>
        {stats ? (
          <div className="pf-stats">
            <div className="pf-stat"><div className="v">{stats.staff_n}</div><div className="l">штат</div></div>
            <div className="pf-stat"><div className="v">{stats.referrers_n}</div><div className="l">направників</div></div>
            <div className="pf-stat"><div className="v">{stats.ceos_n}</div><div className="l">керівників</div></div>
            <div className="pf-stat"><div className="v">{stats.rooms_active_n}<span className="l" style={{ display: "inline", marginLeft: 4 }}>/ {stats.rooms_n}</span></div><div className="l">кабінетів активних</div></div>
            <div className="pf-stat"><div className="v">{stats.services_n}</div><div className="l">послуг у каталозі</div></div>
            <div className="pf-stat"><div className="v">{stats.entries_30d}</div><div className="l">записів за 30 дн</div></div>
            <div className="pf-stat"><div className="v">{stats.entries_total}</div><div className="l">записів усього</div></div>
            <div className="pf-stat"><div className="v" style={{ fontSize: "0.9375rem" }}>{daysAgo(stats.last_activity_at)}</div><div className="l">остання активність</div></div>
          </div>
        ) : <div className="pf-hint">Показники недоступні.</div>}
      </div>

      <div className="pf-grid-2">
        <div className="pf-card">
          <h2>Люди центру</h2>
          <ul className="pf-list">
            {data.people.map((p) => (
              <li key={p.id}>
                <div className="grow">
                  <div>{p.full_name || p.login} <span className="sub">· {ROLE_LABEL[p.role] ?? p.role} · @{p.login}</span></div>
                  {(p.email || p.phone) && <div className="sub">{[p.email, p.phone].filter(Boolean).join(" · ")}</div>}
                </div>
                <span className={"badge " + (p.password_set ? "green" : "yellow")}>{p.password_set ? "пароль є" : "запрошення"}</span>
                {!p.approved && <span className="badge gray">не підтверджено</span>}
              </li>
            ))}
            {data.people.length === 0 && <li className="sub">Штату немає.</li>}
          </ul>
          <p className="pf-hint" style={{ marginTop: 10 }}>
            Направники: {Object.entries(data.referrers).map(([s, n]) => `${n} ${REF_STATUS_LABEL[s] ?? s}`).join(", ") || "немає"}.
            {" "}Керівники: {Object.entries(data.ceos).map(([s, n]) => `${n} ${s === "active" ? "активних" : "відкликаних"}`).join(", ") || "немає"}.
            {" "}Контакти показуються лише для адміністраторів центру.
          </p>
        </div>
        <div className="pf-card">
          <h2>Кабінети та інтеграції</h2>
          <ul className="pf-list">
            {data.rooms.map((r) => (
              <li key={r.id}>
                <div className="grow">{r.name} <span className="sub">· {r.modality}{r.apparatus_model ? ` · ${r.apparatus_model}` : ""}</span></div>
                <span className={"badge " + (r.active ? "green" : "gray")}>{r.active ? "активний" : "вимкнено"}</span>
              </li>
            ))}
            {data.rooms.length === 0 && <li className="sub">Кабінетів немає.</li>}
          </ul>
          <dl className="pf-kv" style={{ marginTop: 12 }}>
            <dt>API-ключі</dt>
            <dd>{data.integrations.keys.length ? data.integrations.keys.map((k) => `${k.name} (${k.key_prefix}…, ${k.active && !k.revoked_at ? "активний" : "відкликано"}${k.last_used_at ? `, останній виклик ${fmtDate(k.last_used_at)}` : ""})`).join("; ") : "немає"}</dd>
            <dt>Вебхуки</dt>
            <dd>{data.integrations.webhooks.length ? data.integrations.webhooks.map((w) => `${w.host} (${w.enabled ? "увімкнено" : "вимкнено"})`).join("; ") : "немає"}</dd>
            <dt>Google Calendar</dt>
            <dd>{data.integrations.gcal ? `${data.integrations.gcal.status}${data.integrations.gcal.enabled ? "" : " (вимкнено)"}${data.integrations.gcal.last_sync_at ? `, синк ${fmtDateTime(data.integrations.gcal.last_sync_at)}` : ""}${data.integrations.gcal.last_error_code ? `, помилка ${data.integrations.gcal.last_error_code}` : ""}` : "не підключено"}</dd>
          </dl>
        </div>
      </div>

      <div className="pf-card">
        <h2>Журнал платформи по центру</h2>
        <LogList items={data.log} />
      </div>
    </div>
  );
}

function StatusPanel({ clinicId, current, account, onDone, notify }: {
  clinicId: string; current: ClinicStatus; account: PlatformAccountRow | null; onDone: () => void; notify: (m: string, t?: string) => void;
}) {
  const [status, setStatus] = useState<ClinicStatus>(current);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setStatus(current); }, [current]);
  const changed = status !== current;
  const needReason = changed && statusNeedsReason(status);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!changed || busy) return;
    if (needReason && !reason.trim()) { notify("Для призупинення або архіву вкажіть причину", "error"); return; }
    setBusy(true);
    const r = await api<{ ok: true }>(`/api/platform/clinics/${clinicId}/status`, { method: "POST", body: JSON.stringify({ status, reason: reason.trim() || null }) });
    setBusy(false);
    if (!r.ok) { notify(r.error, "error"); return; }
    notify(`Статус змінено: ${CLINIC_STATUS_LABEL[status]}`, "success");
    setReason("");
    onDone();
  }

  return (
    <div className="pf-card">
      <h2>Статус центру</h2>
      <dl className="pf-kv" style={{ marginBottom: 12 }}>
        <dt>Зараз</dt><dd><StatusBadge status={current} /></dd>
        <dt>Змінено</dt><dd>{account?.status_changed_at ? fmtDateTime(account.status_changed_at) : "з реєстрації (запису в обліку немає)"}</dd>
        {account?.status_reason && (<><dt>Причина</dt><dd>{account.status_reason}</dd></>)}
      </dl>
      <form className="pf-form" onSubmit={submit}>
        <label className="fld">
          <span className="fld-lab">Новий статус</span>
          <select className="inp" value={status} onChange={(e) => setStatus(e.target.value as ClinicStatus)}>
            {CLINIC_STATUSES.map((s) => <option key={s} value={s}>{CLINIC_STATUS_LABEL[s]}</option>)}
          </select>
        </label>
        <label className="fld">
          <span className="fld-lab">Причина{needReason ? <> <span className="req">*</span></> : " (за бажанням)"}</span>
          <input className="inp" value={reason} maxLength={STATUS_REASON_MAX} onChange={(e) => setReason(e.target.value)} placeholder="напр. несплата, тест, прохання клієнта" aria-required={needReason} />
        </label>
        <div className="pf-hint">
          «Призупинено» і «Архів» закривають вхід персоналу центру через сторінку входу RadFlow. Це обмеження входу, а не
          блокування даних: живі сесії, направники й керівники центру статусом не зупиняються. Статус не залежить від
          оплати — його змінює лише оператор. Причину бачать лише оператори; даних пацієнтів сюди не пишіть.
        </div>
        <div className="pf-actions">
          <button type="submit" className="btn btn-primary" disabled={!changed || busy} aria-busy={busy}>
            {busy ? <><span className="rf-spin" aria-hidden="true" /> Зберігаємо…</> : "Змінити статус"}
          </button>
        </div>
      </form>
    </div>
  );
}

function AccountPanel({ clinicId, account, paid, onDone, notify }: {
  clinicId: string; account: PlatformAccountRow | null; paid: { cls: string; text: string } | null; onDone: () => void; notify: (m: string, t?: string) => void;
}) {
  const [plan, setPlan] = useState(account?.plan ?? "");
  const [paidUntil, setPaidUntil] = useState(account?.paid_until ?? "");
  const [notes, setNotes] = useState(account?.notes ?? "");
  const [busy, setBusy] = useState(false);
  /* Картка перечитується після кожної дії (і сусідньої — зміни статусу); форму
     під руками не скидаємо: поле, яке людина НЕ правила, підтягує нове значення
     з обліку, а правлене лишається як є (ревʼю с84, лінза B). */
  const prev = useRef(account);
  useEffect(() => {
    const was = prev.current;
    prev.current = account;
    setPlan((v) => (v === (was?.plan ?? "") ? account?.plan ?? "" : v));
    setPaidUntil((v) => (v === (was?.paid_until ?? "") ? account?.paid_until ?? "" : v));
    setNotes((v) => (v === (was?.notes ?? "") ? account?.notes ?? "" : v));
  }, [account]);

  /* Порівняння — з ОБРІЗАНИМ значенням (ревʼю с84 р2, L-3): сервер зберігає trim(),
     і «  Базовий » після збереження інакше лишалось би «брудним» назавжди, а кожен
     клік писав би ще один слід у журнал. */
  const planDirty = plan.trim() !== (account?.plan ?? "");
  const paidDirty = paidUntil !== (account?.paid_until ?? "");
  const notesDirty = notes.trim() !== (account?.notes ?? "");
  const dirty = planDirty || paidDirty || notesDirty;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!dirty || busy) return;
    setBusy(true);
    const body: Record<string, string | null> = {};
    if (planDirty) body.plan = plan.trim() || null;
    if (paidDirty) body.paid_until = paidUntil || null;
    if (notesDirty) body.notes = notes.trim() || null;
    const r = await api<{ ok: true }>(`/api/platform/clinics/${clinicId}/account`, { method: "POST", body: JSON.stringify(body) });
    setBusy(false);
    if (!r.ok) { notify(r.error, "error"); return; }
    notify("Облік збережено", "success");
    onDone();
  }

  return (
    <div className="pf-card">
      <div className="pf-card-head">
        <h2>Тариф і оплата</h2>
        <span className="spacer" />
        {paid && <span className={"badge " + paid.cls}>{paid.text}</span>}
      </div>
      <form className="pf-form" onSubmit={submit}>
        <div className="fld-row">
          <label className="fld">
            <span className="fld-lab">Тариф</span>
            <input className="inp" value={plan} maxLength={PLAN_MAX} onChange={(e) => setPlan(e.target.value)} placeholder="напр. Базовий, 1 кабінет" />
          </label>
          <label className="fld">
            <span className="fld-lab">Оплачено до</span>
            <input className="inp" type="date" value={paidUntil} onChange={(e) => setPaidUntil(e.target.value)} />
          </label>
        </div>
        <label className="fld">
          <span className="fld-lab">Нотатки оператора</span>
          <textarea className="inp" value={notes} maxLength={ACCOUNT_NOTES_MAX} onChange={(e) => setNotes(e.target.value)} placeholder="домовленості, контактна особа, історія звернень" />
        </label>
        <div className="pf-hint">Ручний облік без платіжного провайдера: рахунки й автоматична оплата — пізніше. Ці поля на доступ центру не впливають.</div>
        <div className="pf-actions">
          <button type="submit" className="btn btn-primary" disabled={!dirty || busy} aria-busy={busy}>
            {busy ? <><span className="rf-spin" aria-hidden="true" /> Зберігаємо…</> : "Зберегти облік"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ───────────────────────────── Оператори ────────────────────────────────── */

function OperatorsView({ meId, notify }: { meId: string; notify: (m: string, t?: string) => void }) {
  const [rows, setRows] = useState<PlatformOperatorRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gen, setGen] = useState(0);
  const [form, setForm] = useState({ email: "", full_name: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "active" | "password"; row: PlatformOperatorRow; active?: boolean } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [ownPwd, setOwnPwd] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await api<{ operators: PlatformOperatorRow[] }>("/api/platform/operators");
      if (!alive) return;
      if (!r.ok) { setErr(r.error); return; }
      setErr(null);
      setRows(r.data.operators);
    })();
    return () => { alive = false; };
  }, [gen]);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!form.email.trim()) { notify("Вкажіть email оператора", "error"); return; }
    setBusy(true);
    const r = await api<{ ok: true; email: string; temp_password: string }>("/api/platform/operators", { method: "POST", body: JSON.stringify(form) });
    setBusy(false);
    if (!r.ok) { notify(r.error, "error"); return; }
    setSecret({ label: `Тимчасовий пароль для ${r.data.email}`, value: r.data.temp_password });
    setForm({ email: "", full_name: "", note: "" });
    notify("Оператора створено", "success");
    setGen((g) => g + 1);
  }

  async function runConfirm() {
    if (!confirm || confirmBusy) return;
    setConfirmBusy(true);
    if (confirm.kind === "active") {
      const r = await api<{ ok: true; claim_synced?: boolean }>(`/api/platform/operators/${confirm.row.id}/active`, { method: "POST", body: JSON.stringify({ active: confirm.active }) });
      setConfirmBusy(false);
      setConfirm(null);
      if (!r.ok) { notify(r.error, "error"); return; }
      if (r.data.claim_synced === false) {
        /* Чесно за напрямком (ревʼю с84 р2, L-2): увімкненому прапорець долагодить
           вхід; вимкненому вхід закрито — прапорець лишиться, але прав не дає. */
        notify(confirm.active
          ? "Оператора увімкнено, але прапорець маршрутизації не оновився — вирівняється при його наступному вході"
          : "Оператора вимкнено (доступу немає), але прапорець маршрутизації не знявся — повторіть вимкнення пізніше; до того людина бачитиме екран «доступ вимкнено»", "warn");
      } else {
        notify(confirm.active ? "Оператора увімкнено" : "Оператора вимкнено", "success");
      }
    } else {
      const r = await api<{ ok: true; temp_password: string }>(`/api/platform/operators/${confirm.row.id}/password`, { method: "POST", body: "{}" });
      setConfirmBusy(false);
      setConfirm(null);
      if (!r.ok) { notify(r.error, "error"); return; }
      setSecret({ label: `Новий тимчасовий пароль для ${confirm.row.email}`, value: r.data.temp_password });
      notify("Пароль скинуто", "success");
    }
    setGen((g) => g + 1);
  }

  /* Картка помилки — лише коли переліку ще немає. Якщо збій стався на
     ПЕРЕчитуванні (напр. після дії), сторінка лишається: блок із щойно виданим
     паролем не має зникати разом зі списком (с84 — саме так пропав пароль). */
  if (err && !rows && !secret) return <div className="pf-page"><div className="pf-card"><div className="pf-err" role="alert">{err}</div></div></div>;

  return (
    <div className="pf-page">
      <div className="pf-card">
        <h2>Новий оператор</h2>
        <form className="pf-form" onSubmit={create}>
          <div className="fld-row">
            <label className="fld">
              <span className="fld-lab">Email <span className="req">*</span></span>
              <input className="inp" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@company.ua" autoComplete="off" aria-required="true" />
            </label>
            <label className="fld">
              <span className="fld-lab">ПІБ</span>
              <input className="inp" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} placeholder="Прізвище Імʼя" />
            </label>
          </div>
          <label className="fld">
            <span className="fld-lab">Примітка</span>
            <input className="inp" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="роль у команді, коротко" />
          </label>
          <div className="pf-hint">Справжня пошта (не службова адреса). Вхід — на /login за email і тимчасовим паролем, який покажеться один раз нижче.</div>
          <div className="pf-actions">
            <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
              {busy ? <><span className="rf-spin" aria-hidden="true" /> Створюємо…</> : "Створити оператора"}
            </button>
          </div>
        </form>
        {secret && <SecretBox secret={secret.value} label={secret.label} onCopied={(ok) => notify(ok ? "Пароль скопійовано" : "Не вдалося скопіювати — виділіть і скопіюйте вручну", ok ? "success" : "warn")} />}
      </div>

      <div className="pf-card">
        <h2>Оператори платформи</h2>
        {err && <div className="pf-err" role="alert">{err}</div>}
        {!rows ? (err ? null : <div role="status" className="pf-hint">Завантаження…</div>) : (
          <ul className="pf-list">
            {rows.map((r) => (
              <li key={r.id}>
                <div className="grow">
                  <div>{r.full_name || r.email}{r.id === meId ? " (це ви)" : ""}</div>
                  <div className="sub">{r.email} · з {fmtDate(r.created_at)}{r.note ? ` · ${r.note}` : ""}</div>
                </div>
                <span className={"badge " + (r.active ? "green" : "gray")}>{r.active ? "активний" : `вимкнено ${fmtDate(r.disabled_at)}`}</span>
                {/* Свій пароль — лише «Змінити» (на свій, з поточним). «Скинути» собі
                    сервер не дає: admin-зміна пароля завершує ВСІ сесії, і оператор
                    вилітав із консолі разом із новим паролем (с84). */}
                {r.id === meId
                  ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOwnPwd(true)}>Змінити пароль</button>
                  : r.active && <button type="button" className="btn btn-secondary btn-sm" aria-label={`Скинути пароль — ${r.email}`} onClick={() => setConfirm({ kind: "password", row: r })}>Скинути пароль</button>}
                {r.id !== meId && (
                  <button type="button" className={"btn btn-secondary btn-sm" + (r.active ? " qd-act-red" : "")} aria-label={`${r.active ? "Вимкнути" : "Увімкнути"} — ${r.email}`} onClick={() => setConfirm({ kind: "active", row: r, active: !r.active })}>
                    {r.active ? "Вимкнути" : "Увімкнути"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {confirm && (
        <ConfirmDialog
          title={confirm.kind === "password" ? "Скинути пароль оператора?" : confirm.active ? "Увімкнути оператора?" : "Вимкнути оператора?"}
          text={confirm.kind === "password"
            ? <>Поточний пароль <b>{confirm.row.email}</b> перестане діяти, а відкриті сесії цього оператора завершаться; новий тимчасовий покажеться один раз.</>
            : confirm.active
              ? <>Оператор <b>{confirm.row.email}</b> знову зможе входити в консоль.</>
              : <>Оператор <b>{confirm.row.email}</b> втратить доступ з наступного запиту. Слід у журналі лишиться.</>}
          confirmLabel={confirm.kind === "password" ? "Скинути" : confirm.active ? "Увімкнути" : "Вимкнути"}
          cancelLabel="Залишити"
          danger={confirm.kind === "active" && !confirm.active}
          busy={confirmBusy}
          onConfirm={runConfirm}
          onClose={() => { if (!confirmBusy) setConfirm(null); }}
        />
      )}
      {ownPwd && (
        <OwnPasswordDialog
          email={rows?.find((r) => r.id === meId)?.email ?? ""}
          onClose={() => setOwnPwd(false)}
          onDone={() => { setOwnPwd(false); notify("Пароль змінено", "success"); }}
        />
      )}
    </div>
  );
}

/* «Змінити пароль» — свій пароль на СВІЙ (с84, прохання власника). Поточний
   пароль обовʼязковий — це захист самого роуту (межа безпеки акаунта — перемикачі
   GoTrue з ToDo П-6). Сервер — /api/platform/me/password:
   зміна йде через власну сесію, тож ви лишаєтесь у консолі, а інші ваші сесії
   GoTrue завершує. Паролі не зберігаються ніде поза полями цього вікна.
   Кнопка «Змінити» не стає `disabled` (AGENTS.md: у пастці фокуса — лише
   aria-disabled): що не так, каже повідомлення після натискання. */
function OwnPasswordDialog({ email, onClose, onDone }: { email: string; onClose: () => void; onDone: () => void }) {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const curRef = useRef<HTMLInputElement>(null);
  const newRef = useRef<HTMLInputElement>(null);
  const matchId = useId();
  /* Та сама помилка вдруге не змінює DOM — скринридер її не повторить. Тому
     спершу чистимо, а текст ставимо наступним тиком. */
  const say = (text: string) => { setError(null); setTimeout(() => setError(text), 30); };

  /* «Не збігаються» — лише коли повтор уже не коротший за новий (а не з першої літери). */
  const mismatch = again.length > 0 && again.length >= next.length && next !== again;

  function problem(): string | null {
    if (!cur) return "Вкажіть поточний пароль";
    if (next.length < 8) return "Новий пароль — мінімум 8 символів";
    if (passwordTooLong(next)) return `Новий пароль задовгий: ${PASSWORD_LIMIT_HINT}`;
    if (next !== again) return "Паролі не збігаються";
    if (next === cur) return "Новий пароль збігається з поточним";
    return null;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const p = problem();
    if (p) { say(p); return; }
    setBusy(true);
    setError(null);
    const r = await api<{ ok: true }>("/api/platform/me/password", { method: "POST", body: JSON.stringify({ current_password: cur, new_password: next }) });
    setBusy(false);
    if (!r.ok) {
      say(r.error);
      /* Фокус — у поле, про яке помилка (сервер каже `field`); інакше — у поточний. */
      (r.field === "new" ? newRef : curRef).current?.focus();
      return;
    }
    onDone();
  }

  return (
    <BaseDialog title="Змінити свій пароль" maxWidth={420} busy={busy} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <div className="dlg-body">
          <label className="fld">
            <span className="fld-lab">Поточний пароль</span>
            <input ref={curRef} className="inp" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" aria-required="true" />
          </label>
          <label className="fld">
            <span className="fld-lab">Новий пароль (мінімум 8 символів)</span>
            <input ref={newRef} className="inp" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" aria-required="true" />
          </label>
          <label className="fld">
            <span className="fld-lab">Новий пароль ще раз</span>
            <input className="inp" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" aria-required="true" aria-invalid={mismatch || undefined} aria-describedby={matchId} />
          </label>
          {/* Живі області — постійні вузли (вставлений role=status скринридер може не оголосити). */}
          <div id={matchId} className="pf-hint" aria-live="polite">{mismatch ? "Паролі не збігаються" : ""}</div>
          <div className="pf-err" role="alert">{error ?? ""}</div>
          <div className="pf-hint">Ви лишаєтесь у консолі; інші ваші сесії (в інших браузерах і на інших пристроях) буде завершено.</div>
          {/* Для менеджера паролів: оновити запис саме цього акаунта. Після полів —
              BaseDialog фокусує ПЕРШЕ поле, і воно має бути «Поточний пароль». */}
          <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
        </div>
        <div className="dlg-foot" style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn btn-ghost" onClick={() => { if (!busy) onClose(); }} aria-disabled={busy || undefined}>Скасувати</button>
          <button type="submit" className="btn btn-primary" aria-disabled={busy || undefined} aria-busy={busy || undefined}>{busy ? "Зберігаємо…" : "Змінити"}</button>
        </div>
      </form>
    </BaseDialog>
  );
}

/* ───────────────────────────── Журнал ───────────────────────────────────── */

function LogList({ items }: { items: PlatformLogItem[] }) {
  if (!items.length) return <div className="pf-hint">Записів ще немає.</div>;
  return (
    <ul className="pf-list">
      {items.map((it) => (
        <li key={it.id}>
          <span className="pf-log-time">{fmtDateTime(it.occurred_at)}</span>
          <span className="grow">{platformLogText(it)}</span>
        </li>
      ))}
    </ul>
  );
}

function LogView() {
  const [items, setItems] = useState<PlatformLogItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await api<{ log: PlatformLogItem[] }>("/api/platform/log?limit=200");
      if (!alive) return;
      if (!r.ok) { setErr(r.error); return; }
      setItems(r.data.log);
    })();
    return () => { alive = false; };
  }, []);
  if (err) return <div className="pf-page"><div className="pf-card"><div className="pf-err">{err}</div></div></div>;
  if (!items) return <div className="pf-empty" role="status">Завантаження журналу…</div>;
  return (
    <div className="pf-page">
      <div className="pf-card">
        <h2>Останні 200 дій операторів</h2>
        <LogList items={items} />
      </div>
    </div>
  );
}

/* ───────────────────────────── Оболонка ─────────────────────────────────── */

export default function PlatformConsole({ operator }: { operator: { id: string; email: string; full_name: string } }) {
  const router = useRouter();
  const sp = useSearchParams();
  const rawView = sp.get("view");
  const rawClinic = sp.get("clinic");
  const clinicId = rawClinic && UUID_RE.test(rawClinic) ? rawClinic : null;
  const view: View = clinicId ? "clinics" : rawView === "operators" || rawView === "log" ? rawView : "clinics";

  const [toast, setToast] = useState<ToastData | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((msg: string, type = "success") => {
    setToast({ msg, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), type === "error" ? 6000 : 3500);
  }, []);

  const go = useCallback((next: View, clinic?: string) => {
    const q = new URLSearchParams();
    if (clinic) q.set("clinic", clinic); else if (next !== "clinics") q.set("view", next);
    const qs = q.toString();
    router.push("/platform" + (qs ? `?${qs}` : ""));
  }, [router]);

  const title = clinicId ? "Картка центру" : VIEWS.find((v) => v.key === view)?.label ?? "Центри";

  return (
    <div className="pf-app">
      <nav className="pf-nav" aria-label="Розділи платформи">
        <div className="pf-nav-head">
          <div className="pf-logo"><span className="dot" />RadFlow</div>
          <div className="pf-sub">Платформа · оператор</div>
        </div>
        <div className="pf-nav-list">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              className={"pf-nav-item" + (view === v.key && !clinicId ? " active" : "")}
              aria-current={view === v.key && !clinicId ? "page" : undefined}
              onClick={() => go(v.key)}
            >
              <span className="ic" aria-hidden="true">{v.ic}</span>{v.label}
            </button>
          ))}
        </div>
        <div className="pf-nav-foot">
          <div className="pf-me">
            <div className="nm">{operator.full_name || operator.email}</div>
            <div className="em">{operator.email}</div>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => signOutAndRedirect(router)}>Вийти</button>
        </div>
      </nav>
      <div className="pf-main">
        <header className="pf-topbar">
          <div>
            <h1>{title}</h1>
            <div className="pf-crumb">{clinicId ? "Центр як клієнт платформи" : view === "clinics" ? "Центри як клієнти платформи" : view === "operators" ? "Люди RadFlow з доступом до консолі" : "Хто що змінив"}</div>
          </div>
          <div className="pf-right">
            {clinicId && <button type="button" className="btn btn-ghost btn-sm" onClick={() => go("clinics")}>← Усі центри</button>}
          </div>
        </header>
        <div className="pf-content">
          {clinicId ? (
            <ClinicCard key={clinicId} id={clinicId} onBack={() => go("clinics")} notify={notify} />
          ) : view === "operators" ? (
            <OperatorsView meId={operator.id} notify={notify} />
          ) : view === "log" ? (
            <LogView />
          ) : (
            <ClinicsView onOpen={(id) => go("clinics", id)} />
          )}
        </div>
      </div>
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
