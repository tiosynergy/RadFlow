"use client";

/* ===== RadFlow — Лікарі-направники (адмін) =====
   Адміністратор створює акаунт лікаря-направника вручну (логін, ПІБ, телефон,
   email, примітка, місце роботи). Пароль лікар задає сам на /set-password;
   адміністратор може скинути або задати пароль. Кабінети не призначаються. */

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import Sidebar from "@/components/Sidebar";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";

const EMPTY = { login: "", full_name: "", email: "", phone: "", note: "", workplace: "" };

export default function ReferrersManager({ clinicId, rooms, clinicName, adminName }) {
  const [referrers, setReferrers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  function notify(msg, type = "success") { setToast({ msg, type }); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 4000); }
  function setF(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  const reload = useCallback(async () => {
    const supabase = createClient();
    const { data: profs } = await supabase.from("profiles").select("id, login, full_name, email, phone, note, workplace, password_set").eq("clinic_id", clinicId).eq("role", "referrer").order("full_name");
    setReferrers(profs || []);
    setLoading(false);
  }, [clinicId]);

  useEffect(() => { reload(); }, [reload]);

  async function createAccount() {
    if (!form.login.trim() || !form.full_name.trim() || !form.email.trim()) { notify("Заповніть логін, ПІБ та email", "error"); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/staff", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "referrer", ...form }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { notify(data.error || "Помилка створення", "error"); setBusy(false); return; }
      setForm(EMPTY);
      notify("Лікаря створено. Передайте йому логін — пароль він задасть на /set-password.", "success");
      reload();
    } catch { notify("Помилка зʼєднання із сервером", "error"); }
    setBusy(false);
  }

  async function resetPassword(profileId, label) {
    if (!window.confirm(`Скинути пароль для «${label}»?\n\nПоточний пароль перестане діяти. Користувач задасть новий на /set-password за своїм логіном.`)) return;
    const res = await fetch("/api/staff/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: profileId, action: "reset" }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { notify(data.error || "Помилка", "error"); return; }
    setReferrers((rs) => rs.map((r) => (r.id === profileId ? { ...r, password_set: false } : r)));
    notify("Пароль скинуто — користувач задасть новий на /set-password", "info");
  }
  async function setPassword(profileId) {
    const pw = window.prompt("Новий пароль (мінімум 8 символів):");
    if (pw == null) return;
    if (pw.length < 8) { notify("Пароль мінімум 8 символів", "error"); return; }
    const res = await fetch("/api/staff/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: profileId, action: "set", password: pw }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { notify(data.error || "Помилка", "error"); return; }
    setReferrers((rs) => rs.map((r) => (r.id === profileId ? { ...r, password_set: true } : r)));
    notify("Пароль встановлено", "success");
  }
  async function deleteReferrer(profileId, label) {
    if (!window.confirm(`Видалити акаунт лікаря-направника «${label}» назавжди?\n\nБудуть видалені: обліковий запис і профіль. Створені ним направлення (записи пацієнтів) залишаться. Дію не можна скасувати.`)) return;
    const supabase = createClient();
    const { error } = await supabase.rpc("delete_clinic_member", { target: profileId });
    if (error) { notify("Помилка: " + error.message, "error"); return; }
    setReferrers((rs) => rs.filter((r) => r.id !== profileId));
    notify("Акаунт лікаря видалено", "info");
  }

  const card = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 20, marginBottom: 16 };

  return (
    <div className="app">
      <Sidebar clinicName={clinicName} adminName={adminName} adminRole="Адміністратор" rooms={rooms} activeNav="referrers" />
      <div className="main">
        <header className="topbar">
          <div className="tb-title">
            <span className="tic">🩺</span>
            <div><h1>Лікарі-направники</h1><div className="date">{clinicName}</div></div>
          </div>
        </header>

        <div className="content" style={{ overflowY: "auto", padding: "22px", maxWidth: 900 }}>
          {/* Додати лікаря */}
          <div style={card}>
            <div className="bk-section-label" style={{ marginTop: 0 }}>Додати лікаря-направника</div>
            <div className="fld-row">
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Логін *</span><input className="inp" placeholder="логін для входу" value={form.login} onChange={(e) => setF("login", e.target.value)} /></label>
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">ПІБ *</span><input className="inp" placeholder="Прізвище Імʼя По батькові" value={form.full_name} onChange={(e) => setF("full_name", e.target.value)} /></label>
            </div>
            <div className="fld-row">
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Email *</span><input className="inp" type="email" placeholder="doctor@clinic.ua" value={form.email} onChange={(e) => setF("email", e.target.value)} /></label>
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Телефон</span><input className="inp" type="tel" placeholder="+380 XX XXX XX XX" value={form.phone} onChange={(e) => setF("phone", e.target.value)} /></label>
            </div>
            <label className="fld"><span className="fld-lab">Місце роботи</span><input className="inp" placeholder="Клініка / лікарня направника" value={form.workplace} onChange={(e) => setF("workplace", e.target.value)} /></label>
            <label className="fld"><span className="fld-lab">Пароль</span><input className="inp" placeholder="Порожній — користувач задасть сам на /set-password" disabled /></label>
            <label className="fld"><span className="fld-lab">Примітка</span><input className="inp" placeholder="Коротка примітка (необовʼязково)" value={form.note} onChange={(e) => setF("note", e.target.value)} /></label>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
              <button className="btn btn-primary" disabled={busy} onClick={createAccount}>{busy ? "Створюємо…" : "Створити акаунт"}</button>
            </div>
            <div className="hint-blue">Пароль не задається тут: передайте лікарю його <b>логін</b>, він встановить пароль на <b>/set-password</b>. Забув пароль — ви скинете кнопкою нижче.</div>
          </div>

          {/* Лікарі */}
          <div style={card}>
            <div className="bk-section-label" style={{ marginTop: 0 }}>Лікарі-направники клініки ({referrers.length})</div>
            {loading ? (
              <div style={{ color: "var(--text-muted)", padding: 8 }}>Завантаження…</div>
            ) : referrers.length === 0 ? (
              <div style={{ color: "var(--text-muted)", padding: 8, fontSize: 13 }}>Поки немає лікарів-направників. Додайте їх вище.</div>
            ) : referrers.map((r) => (
              <div key={r.id} style={{ padding: "14px 0", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{r.full_name || r.login || r.email}</div>
                  <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                    {r.login ? "@" + r.login + " · " : ""}{r.email}{r.phone ? " · " + r.phone : ""}
                  </div>
                  {r.workplace && <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>🏥 {r.workplace}</div>}
                  {r.note && <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{r.note}</div>}
                </div>
                <span className={"badge " + (r.password_set ? "green" : "yellow")}>{r.password_set ? "🔒 Пароль встановлено" : "Пароль не задано"}</span>
                <button className="btn btn-secondary btn-sm" title="Користувач задасть пароль наново" onClick={() => resetPassword(r.id, r.full_name || r.login)}>Скинути пароль</button>
                <button className="btn btn-secondary btn-sm" title="Задати пароль вручну" onClick={() => setPassword(r.id)}>Задати пароль</button>
                <button className="btn btn-secondary btn-sm qd-act-red" title="Видалити акаунт назавжди" onClick={() => deleteReferrer(r.id, r.full_name || r.login)}>🗑</button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "var(--card)", border: "1px solid var(--border-strong)", borderLeft: "4px solid " + (toast.type === "error" ? "var(--red)" : "var(--green)"), borderRadius: 12, padding: "12px 18px", boxShadow: "var(--shadow-pop)", zIndex: 50, fontSize: 13.5, maxWidth: 440 }}>{toast.msg}</div>
      )}
    </div>
  );
}
