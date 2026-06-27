"use client";

/* ===== RadFlow — встановлення пароля (перший вхід) =====
   Користувача створив адміністратор; тут він задає собі пароль за логіном.
   Працює лише поки пароль не встановлено (далі — скидання адміністратором). */

import { useState, useEffect, type ChangeEvent, type FormEvent } from "react";
import "./register.css";

const REQUIRED = "Це поле обов'язкове";

export default function SetPasswordPage() {
  const [values, setValues] = useState<Record<string, string>>({ password: "", password2: "" });
  const [token, setToken] = useState<string | null>(null); // одноразовий токен із ?token=
  const [identity, setIdentity] = useState<{ login: string | null; full_name: string | null } | null>(null);
  const [tokenInvalid, setTokenInvalid] = useState(false); // токен є, але недійсний/використаний
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [toast, setToast] = useState<{ show: boolean; title: string; msg: string }>({ show: false, title: "", msg: "" });

  // Беремо одноразовий токен із посилання ?token=… (адмін передає його особисто)
  // і резолвимо його в логін/ПІБ, щоб показати, для якого акаунта задаємо пароль.
  useEffect(() => {
    let raw: string | null = null;
    try { raw = (new URLSearchParams(window.location.search).get("token") || "").trim() || null; } catch { /* ignore */ }
    if (!raw) return;
    const tkn: string = raw;
    setToken(tkn);
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/account/set-password?token=${encodeURIComponent(tkn)}`);
        if (!active) return;
        if (res.ok) {
          const d = await res.json().catch(() => ({}));
          setIdentity({ login: d.login ?? null, full_name: d.full_name ?? null });
        } else {
          setTokenInvalid(true); // токен є, але вже використаний / недійсний
        }
      } catch { if (active) setTokenInvalid(true); }
    })();
    return () => { active = false; };
  }, []);

  function validate(name: string, vals: Record<string, string>): string {
    const v = vals[name] || "";
    if (name === "password") return !v ? REQUIRED : (v.length < 8 || !/[A-ZА-ЯЇІЄ]/.test(v) || !/\d/.test(v)) ? "Мінімум 8 символів, одна велика буква, одна цифра" : "";
    if (name === "password2") return !v ? REQUIRED : v !== vals.password ? "Паролі не співпадають" : "";
    return "";
  }

  function setField(name: string, value: string) {
    setValues((prev) => {
      const next = { ...prev, [name]: value };
      setErrors((e) => {
        const ne = { ...e };
        if (touched[name]) ne[name] = validate(name, next);
        if (name === "password" && touched.password2) ne.password2 = validate("password2", next);
        return ne;
      });
      return next;
    });
  }
  function blurField(name: string) {
    setTouched((p) => ({ ...p, [name]: true }));
    setErrors((p) => ({ ...p, [name]: validate(name, values) }));
  }
  function showToast(msg: string, title = "Помилка") {
    setToast({ show: true, title, msg });
    setTimeout(() => setToast((t) => ({ ...t, show: false })), 3800);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const names = ["password", "password2"];
    const ne: Record<string, string> = {}; const nt: Record<string, boolean> = {};
    names.forEach((n) => { nt[n] = true; ne[n] = validate(n, values); });
    setTouched(nt); setErrors(ne);
    if (names.some((n) => ne[n])) return;
    if (!token) { showToast("Посилання недійсне. Попросіть адміністратора надіслати нове."); return; }

    setSubmitting(true);
    try {
      const res = await fetch("/api/account/set-password", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: values.password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setSubmitting(false); showToast(data.error || "Не вдалося встановити пароль."); return; }
      setSuccess(true);
    } catch {
      setSubmitting(false);
      showToast("Не вдалося звʼязатися із сервером. Спробуйте ще раз.");
    }
  }

  const inputProps = (name: string, type: string) => ({
    id: name, type, value: values[name],
    onChange: (e: ChangeEvent<HTMLInputElement>) => setField(name, e.target.value),
    onBlur: () => blurField(name),
    className: touched[name] && errors[name] ? "invalid" : undefined,
    "aria-invalid": !!(touched[name] && errors[name]),
  });

  return (
    <div className="reg-root">
      <div className="topbar">
        <div className="logo"><span className="dot" />RadFlow</div>
      </div>

      <div className="card">
        {success ? (
          <div className="success fade">
            <div className="ic">✅</div>
            <h2>Пароль встановлено!</h2>
            <div className="sub">Тепер увійдіть за своїм логіном і паролем.</div>
            <a className="btn" href="/login">Перейти до входу</a>
          </div>
        ) : (
          <>
            <div className="head">
              <h1>Встановлення пароля</h1>
              <p>Ваш акаунт створив адміністратор. Задайте свій пароль для першого входу.</p>
            </div>

            {identity && (
              <div className="hint" role="status" style={{ marginBottom: 12, textAlign: "center" }}>
                Пароль для акаунта{identity.full_name ? <> <b>{identity.full_name}</b></> : null}
                {identity.login ? <> · <b>@{identity.login}</b></> : null}
              </div>
            )}

            {(!token || tokenInvalid) && (
              <div className="err" role="alert" style={{ marginBottom: 12 }}>
                Посилання недійсне або неповне. Відкрийте сторінку за посиланням від адміністратора або попросіть надіслати нове.
              </div>
            )}

            <form onSubmit={onSubmit} noValidate>
              <div className="field">
                <label htmlFor="password">Новий пароль</label>
                <input {...inputProps("password", "password")} placeholder="Пароль" autoComplete="new-password" />
                <div className="hint">Мінімум 8 символів, одна велика буква, одна цифра</div>
                {touched.password && errors.password && <div className="err" role="alert">{errors.password}</div>}
              </div>
              <div className="field">
                <label htmlFor="password2">Повторіть пароль</label>
                <input {...inputProps("password2", "password")} placeholder="Повторіть пароль" autoComplete="new-password" />
                {touched.password2 && errors.password2 && <div className="err" role="alert">{errors.password2}</div>}
              </div>

              <button className="btn" type="submit" disabled={submitting || !token || tokenInvalid} aria-busy={submitting} style={{ marginTop: 6 }}>
                {submitting ? <><span className="spinner" />Зберігаємо…</> : "Встановити пароль"}
              </button>
              <p className="alt">Вже маєте пароль? <a href="/login">Увійти</a></p>
            </form>
          </>
        )}
      </div>

      <div className={"toast" + (toast.show ? " show" : "")} role="alert" style={{ borderLeftColor: "var(--red)" }}>
        <div className="tt">{toast.title}</div>
        <div className="td">{toast.msg}</div>
      </div>
    </div>
  );
}
