"use client";

/* ===== RadFlow — Лікарі-направники (адмін, крос-клінічна модель) =====
   Доступ направника до центру = referral_access. Адмін центру:
   • запрошує направника за email (глобальний акаунт) → /api/referrers/invite;
   • підтверджує/відхиляє запити направників (status='pending_clinic');
   • відкликає активний доступ.
   Пароль направник задає сам на /set-password. */

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import Sidebar from "@/components/Sidebar";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";

const EMPTY = { email: "", full_name: "", login: "", phone: "", note: "", policy: "direct", modalities: ["MRI", "CT"] };
const MOD_LABEL = { MRI: "МРТ", CT: "КТ", OTHER: "Інше" };
function modsLabel(mods) { return !mods || mods.length === 0 ? "усі" : mods.map((m) => MOD_LABEL[m] || m).join(", "); }

const ACCESS_ST = {
  active: { label: "Активний", cls: "green" },
  pending_clinic: { label: "Запит на доступ", cls: "yellow" },
  pending_referrer: { label: "Запрошено — очікує лікаря", cls: "blue" },
  revoked: { label: "Відкликано", cls: "gray" },
  declined: { label: "Відхилено", cls: "gray" },
};

async function postJSON(url, body) {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  } catch { return { ok: false, data: { error: "Помилка зʼєднання із сервером" } }; }
}

export default function ReferrersManager({ clinicId, rooms, clinicName, adminName }) {
  const [rows, setRows] = useState([]);   // { access_id, status, policy, note, referrer:{full_name,email,phone} }
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  function notify(msg, type = "success") { setToast({ msg, type }); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 4000); }
  function setF(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  const reload = useCallback(async () => {
    const supabase = createClient();
    const { data: access } = await supabase
      .from("referral_access")
      .select("id, referrer_id, status, policy, modalities, note, created_at")
      .eq("clinic_id", clinicId)
      .order("created_at", { ascending: false });
    const list = access || [];
    const ids = Array.from(new Set(list.map((a) => a.referrer_id)));
    const profById = {};
    if (ids.length) {
      const { data: profs } = await supabase.from("profiles").select("id, full_name, email, phone, password_set").in("id", ids);
      (profs || []).forEach((p) => { profById[p.id] = p; });
    }
    setRows(list.map((a) => ({ access_id: a.id, referrer_id: a.referrer_id, status: a.status, policy: a.policy, modalities: a.modalities, note: a.note, referrer: profById[a.referrer_id] || {} })));
    setLoading(false);
  }, [clinicId]);

  // Realtime: оновлюємо список, коли направник приймає/відхиляє запрошення
  // або змінюється грант. Один канал на referral_access свого центру.
  useEffect(() => {
    const supabase = createClient();
    let channel; let cancelled = false;
    (async () => {
      // Без авторизованого сокета RLS не пропустить postgres_changes.
      try { const { data: { session } } = await supabase.auth.getSession(); if (session?.access_token) supabase.realtime.setAuth(session.access_token); } catch { /* ignore */ }
      if (cancelled) return;
      reload();
      channel = supabase.channel("ref-access-" + clinicId)
        .on("postgres_changes", { event: "*", schema: "public", table: "referral_access", filter: "clinic_id=eq." + clinicId }, () => reload())
        .subscribe();
    })();
    // Підстраховка, якщо подію realtime втрачено: оновлення при поверненні на вкладку + легкий поллінг.
    const onVis = () => { if (document.visibilityState === "visible") reload(); };
    document.addEventListener("visibilitychange", onVis); window.addEventListener("focus", onVis);
    const t = setInterval(reload, 15000);
    return () => { cancelled = true; document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", onVis); clearInterval(t); if (channel) supabase.removeChannel(channel); };
  }, [clinicId, reload]);

  async function invite() {
    if (!form.email.trim()) { notify("Вкажіть email лікаря", "error"); return; }
    setBusy(true);
    // Рівно одна обрана модальність → обмеження; обидві/жодної → усі (null).
    const modalities = form.modalities.length === 1 ? form.modalities : null;
    const { ok, data } = await postJSON("/api/referrers/invite", { ...form, modalities });
    setBusy(false);
    if (!ok) { notify(data.error || "Помилка", "error"); return; }
    setForm(EMPTY);
    if (data.status === "active") {
      notify("Доступ активовано (лікар уже надсилав запит)", "success");
    } else if (data.created_account) {
      notify("Акаунт створено. Передайте лікарю логін «" + (data.login || "—") + "» — пароль він задасть на /set-password, далі прийме запрошення у «Мої центри».", "info");
    } else {
      notify("Запрошення надіслано. Лікар прийме його у вкладці «Мої центри».", "success");
    }
    reload();
  }

  async function decide(accessId, decision) {
    setBusyId(accessId);
    const { ok, data } = await postJSON("/api/referral/access/decide", { access_id: accessId, decision });
    setBusyId(null);
    if (!ok) { notify(data.error || "Помилка", "error"); return; }
    notify(decision === "approve" ? "Доступ підтверджено" : decision === "revoke" ? "Доступ відкликано" : "Запит відхилено", "success");
    reload();
  }

  const requests = rows.filter((r) => r.status === "pending_clinic");
  const active = rows.filter((r) => r.status === "active");
  const invited = rows.filter((r) => r.status === "pending_referrer");
  const history = rows.filter((r) => r.status === "revoked" || r.status === "declined");

  const card = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 20, marginBottom: 16 };

  function Row({ r, children }) {
    const m = ACCESS_ST[r.status] || ACCESS_ST.active;
    const name = r.referrer.full_name || r.referrer.email || "Лікар";
    return (
      <div style={{ padding: "14px 0", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{name}</div>
          <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{r.referrer.email || "—"}{r.referrer.phone ? " · " + r.referrer.phone : ""}</div>
          {r.note && <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{r.note}</div>}
          {r.status === "active" && <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>Режим: {r.policy === "confirm" ? "з підтвердженням оператора" : "пряма черга"} · Модальності: {modsLabel(r.modalities)}</div>}
        </div>
        <span className={"badge " + m.cls}>{m.label}</span>
        {children}
      </div>
    );
  }

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
          {/* Запросити лікаря */}
          <div style={card}>
            <div className="bk-section-label" style={{ marginTop: 0 }}>Запросити лікаря-направника</div>
            <div className="fld-row">
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Email *</span><input className="inp" type="email" placeholder="doctor@clinic.ua" value={form.email} onChange={(e) => setF("email", e.target.value)} /></label>
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">ПІБ</span><input className="inp" placeholder="Прізвище Імʼя По батькові" value={form.full_name} onChange={(e) => setF("full_name", e.target.value)} /></label>
            </div>
            <div className="fld-row">
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Логін</span><input className="inp" placeholder="логін для входу (якщо новий акаунт)" value={form.login} onChange={(e) => setF("login", e.target.value)} /></label>
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Телефон</span><input className="inp" type="tel" placeholder="+380 XX XXX XX XX" value={form.phone} onChange={(e) => setF("phone", e.target.value)} /></label>
            </div>
            <div className="fld-row">
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Режим бронювання</span>
                <select className="inp" value={form.policy} onChange={(e) => setF("policy", e.target.value)}>
                  <option value="direct">Пряма черга (одразу в чергу)</option>
                  <option value="confirm">З підтвердженням оператора</option>
                </select>
              </label>
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Примітка</span><input className="inp" placeholder="напр. спеціалізація" value={form.note} onChange={(e) => setF("note", e.target.value)} /></label>
            </div>
            <div className="fld">
              <span className="fld-lab">Доступні модальності</span>
              <div style={{ display: "flex", gap: 18, alignItems: "center", paddingTop: 4 }}>
                {[["MRI", "МРТ"], ["CT", "КТ"]].map(([code, label]) => (
                  <label key={code} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
                    <input type="checkbox" checked={form.modalities.includes(code)}
                      onChange={(e) => setF("modalities", e.target.checked ? Array.from(new Set([...form.modalities, code])) : form.modalities.filter((m) => m !== code))} />
                    {label}
                  </label>
                ))}
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>обидві = усі</span>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
              <button className="btn btn-primary" disabled={busy} onClick={invite}>{busy ? "Надсилаємо…" : "Запросити"}</button>
            </div>
            <div className="hint-blue">Якщо акаунта ще немає — створимо глобальний акаунт направника. Передайте лікарю його <b>логін або email</b>: пароль він задасть на <b>/set-password</b>, далі прийме запрошення у «Мої центри». Логін необовʼязковий — можна входити за email.</div>
          </div>

          {/* Запити на доступ */}
          {requests.length > 0 && (
            <div style={card}>
              <div className="bk-section-label" style={{ marginTop: 0 }}>Запити на доступ ({requests.length})</div>
              {requests.map((r) => (
                <Row key={r.access_id} r={r}>
                  <button className="btn btn-primary btn-sm" disabled={busyId === r.access_id} onClick={() => decide(r.access_id, "approve")}>Підтвердити</button>
                  <button className="btn btn-secondary btn-sm" disabled={busyId === r.access_id} onClick={() => decide(r.access_id, "decline")}>Відхилити</button>
                </Row>
              ))}
            </div>
          )}

          {/* Активні */}
          <div style={card}>
            <div className="bk-section-label" style={{ marginTop: 0 }}>Активні направники ({active.length})</div>
            {loading ? <div style={{ color: "var(--text-muted)", padding: 8 }}>Завантаження…</div>
              : active.length === 0 ? <div style={{ color: "var(--text-muted)", padding: 8, fontSize: 13 }}>Поки немає активних направників. Запросіть лікаря вище.</div>
              : active.map((r) => (
                <Row key={r.access_id} r={r}>
                  <button className="btn btn-secondary btn-sm qd-act-red" disabled={busyId === r.access_id} onClick={() => { if (window.confirm("Відкликати доступ для «" + (r.referrer.full_name || r.referrer.email) + "»?\n\nСтворені ним направлення лишаться. Нові він створювати не зможе.")) decide(r.access_id, "revoke"); }}>Відкликати доступ</button>
                </Row>
              ))}
          </div>

          {/* Запрошені (очікують лікаря) */}
          {invited.length > 0 && (
            <div style={card}>
              <div className="bk-section-label" style={{ marginTop: 0 }}>Запрошені — очікують прийняття ({invited.length})</div>
              {invited.map((r) => <Row key={r.access_id} r={r} />)}
            </div>
          )}

          {/* Історія */}
          {history.length > 0 && (
            <div style={card}>
              <div className="bk-section-label" style={{ marginTop: 0 }}>Історія</div>
              {history.map((r) => <Row key={r.access_id} r={r} />)}
            </div>
          )}
        </div>
      </div>

      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "var(--card)", border: "1px solid var(--border-strong)", borderLeft: "4px solid " + (toast.type === "error" ? "var(--red)" : "var(--green)"), borderRadius: 12, padding: "12px 18px", boxShadow: "var(--shadow-pop)", zIndex: 50, fontSize: 13.5, maxWidth: 440 }}>{toast.msg}</div>
      )}
    </div>
  );
}
