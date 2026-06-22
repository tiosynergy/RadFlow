"use client";

/* ===== RadFlow — встановлення пароля (перший вхід) =====
   Користувача створив адміністратор; тут він задає собі пароль за логіном.
   Працює лише поки пароль не встановлено (далі — скидання адміністратором). */

import { useState } from "react";
import "./register.css";

const REQUIRED = "Це поле обов'язкове";

export default function SetPasswordPage() {
  const [values, setValues] = useState({ login: "", password: "", password2: "" });
  const [errors, setErrors] = useState({});
  const [touched, setTouched] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [toast, setToast] = useState({ show: false, title: "", msg: "" });

  function validate(name, vals) {
    const v = vals[name] || "";
    if (name === "login") return !v.trim() ? REQUIRED : "";
    if (name === "password") return !v ? REQUIRED : (v.length < 8 || !/[A-ZА-ЯЇІЄ]/.test(v) || !/\d/.test(v)) ? "Мінімум 8 символів, одна велика буква, одна цифра" : "";
    if (name === "password2") return !v ? REQUIRED : v !== vals.password ? "Паролі не співпадають" : "";
    return "";
  }

  function setField(name, value) {
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
  function blurField(name) {
    setTouched((p) => ({ ...p, [name]: true }));
    setErrors((p) => ({ ...p, [name]: validate(name, values) }));
  }
  function showToast(msg, title = "Помилка") {
    setToast({ show: true, title, msg });
    setTimeout(() => setToast((t) => ({ ...t, show: false })), 3800);
  }

  async function onSubmit(e) {
    e.preventDefault();
    const names = ["login", "password", "password2"];
    const ne = {}; const nt = {};
    names.forEach((n) => { nt[n] = true; ne[n] = validate(n, values); });
    setTouched(nt); setErrors(ne);
    if (names.some((n) => ne[n])) return;

    setSubmitting(true);
    try {
      const res = await fetch("/api/account/set-password", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login: values.login.trim(), password: values.password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setSubmitting(false); showToast(data.error || "Не вдалося встановити пароль."); return; }
      setSuccess(true);
    } catch {
      setSubmitting(false);
      showToast("Не вдалося звʼязатися із сервером. Спробуйте ще раз.");
    }
  }

  const inputProps = (name, type) => ({
    id: name, type, value: values[name],
    onChange: (e) => setField(name, e.target.value),
    onBlur: () => blurField(name),
    className: touched[name] && errors[name] ? "invalid" : undefined,
    "aria-invalid": touched[name] && errors[name] ? "true" : "false",
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

            <form onSubmit={onSubmit} noValidate>
              <div className="field">
                <label htmlFor="login">Логін або email</label>
                <input {...inputProps("login", "text")} placeholder="Ваш логін або email" autoComplete="username" />
                {touched.login && errors.login && <div className="err" role="alert">{errors.login}</div>}
              </div>
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

              <button className="btn" type="submit" disabled={submitting} aria-busy={submitting} style={{ marginTop: 6 }}>
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
