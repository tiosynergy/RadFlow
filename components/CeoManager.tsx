"use client";

/* ===== RadFlow — Керівники (CEO) · адмін =====
   Адміністратор призначає роль CEO (керівник з аналітикою) новому або наявному
   користувачу за логіном. CEO — глобальний грант: один керівник може мати кілька
   центрів. Пароль керівник задає сам на /set-password; адмін може скинути/задати
   пароль, відкликати доступ до свого центру або повністю видалити CEO-акаунт. */

import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import Toast from "@/components/Toast";
import ConfirmDialog from "@/components/ConfirmDialog";
import { createClient } from "@/lib/supabase/client";
import { isTechnicalEmail } from "@/lib/login";
import { EMPTY_TOKENS, REISSUE_HINT, forgetToken, inviteHint, rememberToken, type FreshTokens } from "@/lib/inviteLink";
import Sidebar from "@/components/Sidebar";
import LiveClock from "@/components/LiveClock";
import PhoneInput from "@/components/PhoneInput";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";

type CeoForm = { login: string; full_name: string; email: string; phone: string; note: string };
/* RF-09b (0179): `invite_token` у відповіді RPC більше НЕМАЄ — definer-функція
   обходила колонковий грант 0178 і віддавала живий токен CEO будь-якому адміну
   будь-якого з його центрів. Токен екран знає лише з відповіді роута видачі. */
type Ceo = {
  id: string; login: string | null; full_name: string | null; email: string | null;
  phone: string | null; note: string | null; password_set: boolean; role: string;
};
type PwModal = { id: string; val: string; busy: boolean };

const EMPTY: CeoForm = { login: "", full_name: "", email: "", phone: "", note: "" };

/* Крос-рольовий член списку (персонал чи направник ІНШОГО центру з
   CEO-грантом) без пароля: «Скинути пароль» тут відповість 403 —
   /api/staff/password авторизує персонал лише свого центру, а направника —
   лише за активним referral_access. Вести адміна на кнопку з помилкою не
   можна (ревʼю Б с59), тож кажемо, хто насправді видає посилання. */
const FOREIGN_ROLE_HINT =
  "🔗 Пароль ще не встановлено. Цей акаунт належить іншому центру (персонал або направник) — посилання для входу видає адміністратор того центру.";

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
  /* RF-09: токени, ОТРИМАНІ У ВІДПОВІДЯХ роутів у цій сесії екрана. Живуть
     ПОРУЧ зі списком, а не в його рядках: `reload()` смикається на кожен фокус
     вкладки і затер би токен разом із рядком. */
  const [freshTokens, setFreshTokens] = useState<FreshTokens>(EMPTY_TOKENS);
  /* Підтвердження деструктивних дій — ConfirmDialog у стилі RadFlow замість
     window.confirm (с28, зауваження власника). */
  const [ask, setAsk] = useState<null | { title: string; text: ReactNode; confirmLabel: string; danger?: boolean; run: () => void }>(null);
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
    // Повний список членства CEO центру через security-definer RPC (0044):
    // показує й крос-рольових/крос-клінічних CEO, не послаблюючи RLS.
    // ⚠️ RF-09b (0179): RPC більше не віддає invite_token НІКОМУ — поле у
    // відповіді завжди null і в тип Ceo не входить. Токен — лише з карти
    // freshTokens, яку наповнюють відповіді роутів видачі.
    try {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("ceo_list_for_clinic", { p_clinic: clinicId });
      if (error) throw error;
      setCeos((data || []) as Ceo[]);
    } catch {
      // транзієнтний збій (оновлення токена/мережа) — не валимо екран
    } finally {
      setLoading(false);
    }
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
      /* RF-09: роут повертає токен ЛИШЕ для акаунта, створеного цим самим
         викликом (RF-09d: наявному акаунту токен не видається й не читається —
         інакше адмін чужого центру брав би його за одним логіном). Тому для
         наявного акаунта без пароля підказуємо єдиний легітимний шлях —
         «Скинути пароль» у картці. */
      setFreshTokens((m) => rememberToken(m, data.ceo_id, data.invite_token));
      if (data.created_account && !data.ceo_id) {
        /* Розсинхрон збірок (старий сервер / новий клієнт): токен є, а ключа
           для карти немає — посилання щойно втрачено. Кажемо це, а не «скопіюйте». */
        notify("Керівника створено, але посилання не вдалося показати — оновіть сторінку і натисніть «Скинути пароль» у його картці.", "error");
      } else {
        notify(data.created_account
          ? "Керівника створено. Скопіюйте в його картці посилання для встановлення пароля й передайте йому."
          : (data.password_set === false
            ? (data.role === "ceo"
              ? "Роль CEO призначено. Пароль у цього акаунта ще не задано — щоб передати посилання, натисніть «Скинути пароль» у картці."
              : "Роль CEO призначено. Пароль у цього акаунта ще не задано — посилання для входу видає адміністратор його центру.")
            : "Роль CEO призначено наявному користувачу."), "success");
      }
      reload();
    } catch { notify("Помилка зʼєднання із сервером", "error"); }
    setBusy(false);
  }

  function askResetPassword(id: string, label: string | null) {
    setAsk({
      title: `Скинути пароль для «${label}»?`,
      /* ⚠️ Було «задасть новий на /set-password ЗА СВОЇМ ЛОГІНОМ» — неправда з
         міграції 0032: пароль задається лише за одноразовим токеном. Той самий
         хибний текст пакет 37 зняв у StaffManager і ReferrersManager. */
      text: "Поточний пароль перестане діяти. Ви отримаєте нове посилання — передайте його керівнику.",
      confirmLabel: "Скинути пароль",
      run: () => { void resetPassword(id); },
    });
  }
  async function resetPassword(id: string) {
    const res = await fetch("/api/staff/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: id, action: "reset" }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { notify(data.error || "Помилка", "error"); return; }
    setCeos((rs) => rs.map((r) => (r.id === id ? { ...r, password_set: false } : r)));
    /* RF-09: роут повертає СВІЖИЙ токен — це єдиний момент, коли екран його
       бачить. До пакета 38 цей обробник токен із відповіді не клав узагалі:
       кнопка «Скопіювати» жила ВИКЛЮЧНО за рахунок RPC, який 0179 закриває. */
    setFreshTokens((m) => rememberToken(m, id, data.invite_token));
    notify("Пароль скинуто — скопіюйте нове посилання в картці й передайте керівнику.", "info");
  }
  function setPassword(id: string) { setPwModal({ id, val: "", busy: false }); }
  async function submitPassword() {
    if (!pwModal || pwModal.val.length < 8) { notify("Пароль мінімум 8 символів", "error"); return; }
    setPwModal((m) => (m ? { ...m, busy: true } : m));
    const res = await fetch("/api/staff/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: pwModal.id, action: "set", password: pwModal.val }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { notify(data.error || "Помилка", "error"); setPwModal((m) => (m ? { ...m, busy: false } : m)); return; }
    setCeos((rs) => rs.map((r) => (r.id === pwModal.id ? { ...r, password_set: true } : r)));
    setFreshTokens((m) => forgetToken(m, pwModal.id)); // токен погашено сервером — не показувати мертвий
    notify("Пароль встановлено", "success");
    setPwModal(null);
  }
  function askRevoke(id: string, label: string | null) {
    setAsk({
      title: `Відкликати CEO-доступ до вашого центру для «${label}»?`,
      text: "Акаунт керівника не видаляється — він може лишатися керівником інших центрів.",
      confirmLabel: "Відкликати",
      danger: true,
      run: () => { void revoke(id); },
    });
  }
  async function revoke(id: string) {
    const res = await fetch("/api/ceo/revoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ceoId: id }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { notify(data.error || "Помилка", "error"); return; }
    setCeos((rs) => rs.filter((r) => r.id !== id));
    setFreshTokens((m) => forgetToken(m, id));
    notify("Доступ відкликано", "info");
  }
  function askDeleteCeo(id: string, label: string | null) {
    setAsk({
      title: `Повністю видалити CEO-акаунт «${label}»?`,
      text: "Доступно лише якщо це єдиний центр керівника. Дію не можна скасувати.",
      confirmLabel: "Видалити",
      danger: true,
      run: () => { void deleteCeo(id); },
    });
  }
  async function deleteCeo(id: string) {
    const res = await fetch("/api/ceo/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ceoId: id }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { notify(data.error || "Помилка видалення", "error"); return; }
    setCeos((rs) => rs.filter((r) => r.id !== id));
    setFreshTokens((m) => forgetToken(m, id));
    notify("CEO-акаунт видалено", "info");
  }

  const card = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 20, marginBottom: 16 };

  return (
    <div className={embedded ? "setup-embed" : "app"}>
      {!embedded && <Sidebar clinicName={clinicName} adminName={adminName} adminRole="Адміністратор" roleKey="admin" clinicIds={clinicId ? [clinicId] : []} activeNav="ceo-admin" />}
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
              <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Телефон</span><PhoneInput value={form.phone} onChange={(v) => setF("phone", v)} /></label>
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
              <div style={{ color: "var(--text-muted)", padding: 8, fontSize: "0.8125rem" }}>Поки немає керівників. Призначте їх вище.</div>
            ) : ceos.map((r) => (
              <div key={r.id} style={{ padding: "14px 0", borderTop: "1px solid var(--border)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>{r.full_name || r.login || r.email}</div>
                    <div style={{ fontSize: "0.78125rem", color: "var(--text-muted)" }}>
                      {/* Службову адресу (<логін>@ceo.radflow.local) не показуємо:
                          вона виглядає як пошта, і адмін написав би на неї
                          листа, якого ніхто ніколи не отримає. */}
                      {r.login ? "@" + r.login + " · " : ""}
                      {isTechnicalEmail(r.email) ? "вхід за логіном" : r.email}
                      {r.phone ? " · " + r.phone : ""}
                    </div>
                    {r.note && <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: 2 }}>{r.note}</div>}
                  </div>
                  <span className={"badge " + (r.password_set ? "green" : "yellow")}>{r.password_set ? "🔒 Пароль встановлено" : "Пароль не задано"}</span>
                  <button className="btn btn-secondary btn-sm" title="Керівник задасть пароль наново" onClick={() => askResetPassword(r.id, r.full_name || r.login)}>Скинути пароль</button>
                  <button className="btn btn-secondary btn-sm" title="Задати пароль вручну" onClick={() => setPassword(r.id)}>Задати пароль</button>
                  <button className="btn btn-secondary btn-sm" title="Відкликати доступ до вашого центру" onClick={() => askRevoke(r.id, r.full_name || r.login)}>Відкликати</button>
                  {r.role === "ceo" && (
                    <button className="btn btn-secondary btn-sm qd-act-red" title="Видалити CEO-акаунт назавжди (лише якщо це єдиний центр)" onClick={() => askDeleteCeo(r.id, r.full_name || r.login)}>🗑</button>
                  )}
                </div>
                {(() => {
                  /* RF-09: три стани замість двох — рішення в lib/inviteLink.ts,
                     тут лише малюємо. «Пароль не задано, токена на руках немає»
                     показує адміну, що запрошення висить і як передати його
                     знову (той самий вузол, що у StaffManager/ReferrersManager). */
                  const hint = inviteHint(r.password_set, freshTokens, r.id);
                  if (hint.kind === "none") return null;
                  if (hint.kind === "reissue") {
                    /* Кнопка «Скинути пароль», на яку веде підказка, працює
                       лише для CEO-only акаунта; крос-рольовому — чесний текст. */
                    return (
                      <div style={{ fontSize: "0.75rem", marginTop: 8, color: "var(--text-muted)" }}>{r.role === "ceo" ? REISSUE_HINT : FOREIGN_ROLE_HINT}</div>
                    );
                  }
                  return (
                    <div style={{ fontSize: "0.75rem", marginTop: 8, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <span style={{ color: "var(--text-muted)" }}>🔗 Посилання для встановлення пароля:</span>
                      <code style={{ fontSize: "0.71875rem", color: "var(--text-secondary)", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>/set-password?token=…</code>
                      <button className="btn btn-secondary btn-sm" onClick={() => copyLink(hint.token)}>Скопіювати</button>
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>
        </div>
      </div>

      {pwModal && (
        <div className="overlay" onClick={() => !pwModal.busy && setPwModal(null)}>
          <div className="dialog fade-in" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <div className="dlg-head"><div className="dlg-title">Задати пароль</div><button className="icon-btn" aria-label="Закрити" onClick={() => setPwModal(null)}>✕</button></div>
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
      {ask && (
        <ConfirmDialog
          title={ask.title}
          text={ask.text}
          confirmLabel={ask.confirmLabel}
          cancelLabel="Скасувати"
          danger={ask.danger}
          onClose={() => setAsk(null)}
          onConfirm={() => { const run = ask.run; setAsk(null); run(); }}
        />
      )}
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
