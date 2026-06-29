"use client";

/* ===== RadFlow — Керівники (CEO) · адмін =====
   Адміністратор призначає роль CEO (керівник з аналітикою) новому або наявному
   користувачу за логіном. CEO — глобальний грант: один керівник може мати кілька
   центрів. Пароль керівник задає сам на /set-password; адмін може скинути/задати
   пароль, відкликати доступ до свого центру або повністю видалити CEO-акаунт. */

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import Sidebar from "@/components/Sidebar";
import LiveClock from "@/components/LiveClock";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";

type CeoForm = { login: string; full_name: string; email: string; phone: string; note: string };
type Ceo = {
  id: string; login: string | null; full_name: string | null; email: string | null;
  phone: string | null; note: string | null; password_set: boolean; invite_token: string | null; role: string;
};
type PwModal = { id: string; val: string; busy: boolean };

const EMPTY: CeoForm = { login: "", full_name: "", email: "", phone: "", note: "" };

interface CeoManagerProps {
  clinicId: string;
  clinicName?: string;
  adminName?: string;
  embedded?: boolean;
}

export default function CeoManager({ clinicId, clinicName, adminName, embedded = false }: CeoManagerProps) {
  const [ceos, setCeos] = useState<Ceo[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<CeoForm>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  const [origin, setOrigin] = useState("");
  const [pwModal, setPwModal] = useState<PwModal | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setOrigin(window.location.origin); }, []);

  function notify(msg: string, type = "success") { setToast({ msg, type }); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 4500); }
  function setF(k: keyof CeoForm, v: string) { setForm((f) => ({ ...f, [k]: v })); }
  async function copyLink(tok: string) {
    const link = (origin || window.location.origin) + "/set-password?token=" + encodeURIComponent(tok);
    try { await navigator.clipboard.writeText(link); notify("Посилання для входу скопійовано", "success"); }
    catch { notify(link, "info"); }
  }

  const reload = useCallback(async () => {
    const supabase = createClient();
    const { data: links } = await supabase
      .from("ceo_access")
      .select("ceo_id")
      .eq("clinic_id", clinicId)
      .eq("status", "active");
    const ids = (links || []).map((l) => l.ceo_id as string);
    if (ids.length === 0) { setCeos([]); setLoading(false); return; }
    const { data: profs } = await supabase
      .from("profiles")
      .select("id, login, full_name, email, phone, note, password_set, invite_token, role")
      .in("id", ids);
    const rows = (profs || []).slice()
      .sort((a, b) => String(a.full_name || a.login || "").localeCompare(String(b.full_name || b.login || "")));
    setCeos(rows as Ceo[]);
    setLoading(false);
  }, [clinicId]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => { window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
  }, [reload]);

  async function grant() {
    if (!form.login.trim()) { notify("Вкажіть логін керівника", "error"); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/ceo/grant", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { notify(data.error || "Помилка призначення", "error"); setBusy(false); return; }
      setForm(EMPTY);
      notify(data.created_account
        ? "Керівника створено. Скопіюйте в його картці посилання для встановлення пароля й передайте йому."
        : "Роль CEO призначено наявному користувачу.", "success");
      reload();
    } catch { notify("Помилка зʼєднання із сервером", "error"); }
    setBusy(false);
  }

  async function resetPassword(id: string, label: string | null) {
    if (!window.confirm(`Скинути пароль для «${label}»?\n\nПоточний пароль перестане діяти. Керівник задасть новий на /set-password за своїм логіном.`)) return;
    const res = await fetch("/api/staff/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: id, action: "reset" }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { notify(data.error || "Помилка", "error"); return; }
    notify("Пароль скинуто — керівник задасть новий на /set-password", "info");
    reload();
  }
  function setPassword(id: string) { setPwModal({ id, val: "", busy: false }); }
  async function submitPassword() {
    if (!pwModal || pwModal.val.length < 8) { notify("Пароль мінімум 8 символів", "error"); return; }
    setPwModal((m) => (m ? { ...m, busy: true } : m));
    const res = await fetch("/api/staff/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: pwModal.id, action: "set", password: pwModal.val }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { notify(data.error || "Помилка", "error"); setPwModal((m) => (m ? { ...m, busy: false } : m)); return; }
    setCeos((rs) => rs.map((r) => (r.id === pwModal.id ? { ...r, password_set: true } : r)));
    notify("Пароль встановлено", "success");
    setPwModal(null);
  }
  async function revoke(id: string, label: string | null) {
    if (!window.confirm(`Відкликати CEO-доступ до вашого центру для «${label}»?\n\nАкаунт керівника не видаляється — він може лишатися керівником інших центрів.`)) return;
    const res = await fetch("/api/ceo/revoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ceoId: id }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { notify(data.error || "Помилка", "error"); return; }
    setCeos((rs) => rs.filter((r) => r.id !== id));
    notify("Доступ відкликано", "info");
  }
  async function deleteCeo(id: string, label: string | null) {
    if (!window.confirm(`Повністю видалити CEO-акаунт «${label}»?\n\nДоступно лише якщо це єдиний центр керівника. Дію не можна скасувати.`)) return;
    const res = await fetch("/api/ceo/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ceoId: id }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { notify(data.error || "Помилка видалення", "error"); return; }
    setCeos((rs) => rs.filter((r) => r.id !== id));
    notify("CEO-акаунт видалено", "info");
  }

  const card = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 20, marginBottom: 16 };

  return (
    <div className={embedded ? "setup-embed" : "app"}>
      {!embedded && <Sidebar clinicName={clinicName} adminName={adminName} adminRole="Адміністратор" roleKey="admin" activeNav="ceo-admin" />}
      <div className={embedded ? "setup-embed-main" : "main"}>
        {!embedded && (
          <header className="topbar">
            <div className="tb-title">
              <span className="tic">📊</span>
              <div><h1>Керівники (CEO)</h1><div className="date">{clinicName} · <LiveClock /></div></div>
            </div>
          </header>
        )}

        <div className={embedded ? undefined : "content"} style={embedded ? undefined : { overflowY: "auto", padding: "22px", maxWidth: 900 }}>
          {/* Призначити керівника */}
          <div style={card}>
            <div className="bk-section-label" style={{ marginTop: 0 }}>Призначити керівника</div>
            <div className="fld-row">
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Логін <span className="req">*</span></span><input className="inp" placeholder="логін для входу" value={form.login} onChange={(e) => setF("login", e.target.value)} /></label>
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">ПІБ</span><input className="inp" placeholder="Прізвище Імʼя По батькові" value={form.full_name} onChange={(e) => setF("full_name", e.target.value)} /></label>
            </div>
            <div className="fld-row">
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Email</span><input className="inp" type="email" placeholder="ceo@clinic.ua" value={form.email} onChange={(e) => setF("email", e.target.value)} /></label>
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Телефон</span><input className="inp" type="tel" placeholder="+380 XX XXX XX XX" value={form.phone} onChange={(e) => setF("phone", e.target.value)} /></label>
            </div>
            <label className="fld"><span className="fld-lab">Примітка</span><input className="inp" placeholder="Коротка примітка (необовʼязково)" value={form.note} onChange={(e) => setF("note", e.target.value)} /></label>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
              <button className="btn btn-primary" disabled={busy} onClick={grant}>{busy ? "Зберігаємо…" : "Призначити CEO"}</button>
            </div>
            <div className="hint-blue">Якщо користувач уже є в RadFlow — введіть лише <b>логін</b>, ми додамо йому роль CEO поверх наявної. Для нового керівника заповніть ще ПІБ і телефон; після створення скопіюйте в його картці <b>персональне посилання</b> й передайте йому.</div>
          </div>

          {/* Керівники */}
          <div style={card}>
            <div className="bk-section-label" style={{ marginTop: 0 }}>Керівники вашого центру ({ceos.length})</div>
            {loading ? (
              <div style={{ color: "var(--text-muted)", padding: 8 }}>Завантаження…</div>
            ) : ceos.length === 0 ? (
              <div style={{ color: "var(--text-muted)", padding: 8, fontSize: 13 }}>Поки немає керівників. Призначте їх вище.</div>
            ) : ceos.map((r) => (
              <div key={r.id} style={{ padding: "14px 0", borderTop: "1px solid var(--border)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{r.full_name || r.login || r.email}</div>
                    <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                      {r.login ? "@" + r.login + " · " : ""}{r.email}{r.phone ? " · " + r.phone : ""}
                    </div>
                    {r.note && <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{r.note}</div>}
                  </div>
                  <span className={"badge " + (r.password_set ? "green" : "yellow")}>{r.password_set ? "🔒 Пароль встановлено" : "Пароль не задано"}</span>
                  <button className="btn btn-secondary btn-sm" title="Керівник задасть пароль наново" onClick={() => resetPassword(r.id, r.full_name || r.login)}>Скинути пароль</button>
                  <button className="btn btn-secondary btn-sm" title="Задати пароль вручну" onClick={() => setPassword(r.id)}>Задати пароль</button>
                  <button className="btn btn-secondary btn-sm" title="Відкликати доступ до вашого центру" onClick={() => revoke(r.id, r.full_name || r.login)}>Відкликати</button>
                  {r.role === "ceo" && (
                    <button className="btn btn-secondary btn-sm qd-act-red" title="Видалити CEO-акаунт назавжди (лише якщо це єдиний центр)" onClick={() => deleteCeo(r.id, r.full_name || r.login)}>🗑</button>
                  )}
                </div>
                {!r.password_set && r.invite_token && (
                  <div style={{ fontSize: 12, marginTop: 8, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ color: "var(--text-muted)" }}>🔗 Посилання для встановлення пароля:</span>
                    <code style={{ fontSize: 11.5, color: "var(--text-secondary)", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>/set-password?token=…</code>
                    <button className="btn btn-secondary btn-sm" onClick={() => copyLink(r.invite_token as string)}>Скопіювати</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {pwModal && (
        <div className="overlay" onClick={() => !pwModal.busy && setPwModal(null)}>
          <div className="dialog fade-in" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <div className="dlg-head"><div className="dlg-title">Задати пароль</div><button className="icon-btn" onClick={() => setPwModal(null)}>✕</button></div>
            <div className="dlg-body">
              <label className="fld" style={{ marginBottom: 0 }}><span className="fld-lab">Новий пароль (мінімум 8 символів)</span>
                <input className="inp" type="password" autoFocus value={pwModal.val}
                  onChange={(e) => setPwModal((m) => (m ? { ...m, val: e.target.value } : m))}
                  onKeyDown={(e) => { if (e.key === "Enter") submitPassword(); }} placeholder="Пароль" />
              </label>
            </div>
            <div className="dlg-foot" style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setPwModal(null)}>Скасувати</button>
              <button className="btn btn-primary" disabled={pwModal.busy || pwModal.val.length < 8} onClick={submitPassword}>{pwModal.busy ? "Зберігаємо…" : "Встановити"}</button>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "var(--card)", border: "1px solid var(--border-strong)", borderLeft: "4px solid " + (toast.type === "error" ? "var(--red)" : "var(--green)"), borderRadius: 12, padding: "12px 18px", boxShadow: "var(--shadow-pop)", zIndex: 50, fontSize: 13.5, maxWidth: 440 }}>{toast.msg}</div>
      )}
    </div>
  );
}
