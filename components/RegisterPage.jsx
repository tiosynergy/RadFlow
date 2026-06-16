"use client";

/* ===== RadFlow — стартова сторінка (реєстрація) =====
   Перенесено з D:\Проект\HTML\LandingPage\radflow-register-social-dark.html
   Логіку валідації переписано на React-стан. */

import { useState } from "react";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";
import "./register.css";

const REQUIRED = "Це поле обов'язкове";

const FIELDS = ["login", "email", "phone", "password", "password2"];

function validateField(name, values) {
  const v = values[name] || "";
  switch (name) {
    case "login":
      return !v.trim() ? REQUIRED : v.trim().length < 3 ? "Логін має містити щонайменше 3 символи" : "";
    case "email":
      return !v.trim() ? REQUIRED : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? "Введіть коректну електронну адресу" : "";
    case "phone":
      return !v.trim() ? REQUIRED : !/^\+380\d{9}$/.test(v.replace(/[\s()-]/g, "")) ? "Введіть номер у форматі +380 XX XXX XX XX" : "";
    case "password":
      return !v ? REQUIRED : (v.length < 8 || !/[A-ZА-ЯЇІЄ]/.test(v) || !/\d/.test(v)) ? "Мінімум 8 символів, одна велика буква, одна цифра" : "";
    case "password2":
      return !v ? REQUIRED : v !== values.password ? "Паролі не співпадають" : "";
    case "terms":
      return !values.terms ? "Потрібно прийняти умови" : "";
    default:
      return "";
  }
}

async function registerUser(values) {
  if (!isSupabaseConfigured()) {
    return {
      ok: false,
      message: "Supabase ще не налаштований. Див. docs/setup/02-supabase-setup.md",
    };
  }

  try {
    const supabase = createClient();
    const { error } = await supabase.auth.signUp({
      email: values.email.trim(),
      password: values.password,
      options: {
        // Метадані для тригера handle_new_user (створює клініку + профіль).
        data: {
          login: values.login.trim(),
          phone: values.phone.trim(),
          clinic_name: values.login.trim(),
        },
        emailRedirectTo:
          typeof window !== "undefined"
            ? `${window.location.origin}/auth/callback`
            : undefined,
      },
    });

    if (error) {
      const msg = error.message || "";
      if (/already registered|already exists|user already/i.test(msg)) {
        return { ok: false, field: "email", message: "Цей email вже зареєстрований" };
      }
      return { ok: false, message: "Помилка: " + msg };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: "Не вдалося звʼязатися із сервером. Спробуйте ще раз." };
  }
}

const GoogleIcon = () => (
  <svg viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.4 29.3 35 24 35c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 5.1 29.5 3 24 3 12.9 3 4 11.9 4 23s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z" /><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 5.1 29.5 3 24 3 16.3 3 9.7 7.3 6.3 14.7z" /><path fill="#4CAF50" d="M24 43c5.2 0 9.9-2 13.5-5.2l-6.2-5.3C29.2 34.5 26.7 35 24 35c-5.3 0-9.6-2.6-11.3-7l-6.5 5C9.6 38.6 16.2 43 24 43z" /><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4 5.5l6.2 5.3C39.9 36 44 30.6 44 23c0-1.3-.1-2.3-.4-3.5z" /></svg>
);
const FacebookIcon = () => (
  <svg viewBox="0 0 24 24"><path fill="#1877F2" d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.69.24 2.69.24v2.97h-1.52c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z" /></svg>
);
const XIcon = () => (
  <svg viewBox="0 0 24 24"><path className="xg" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
);

export default function RegisterPage() {
  const [values, setValues] = useState({ login: "", email: "", phone: "", password: "", password2: "", terms: false });
  const [errors, setErrors] = useState({});
  const [touched, setTouched] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [toast, setToast] = useState({ show: false, type: "error", title: "", msg: "" });

  function setField(name, value) {
    setValues((prev) => {
      const next = { ...prev, [name]: value };
      // оновлюємо помилку поля «на льоту», якщо воно вже торкнуте
      setErrors((errPrev) => {
        const e = { ...errPrev };
        if (touched[name]) e[name] = validateField(name, next);
        if (name === "password" && touched.password2) e.password2 = validateField("password2", next);
        return e;
      });
      return next;
    });
  }

  function blurField(name) {
    setTouched((p) => ({ ...p, [name]: true }));
    setErrors((p) => ({ ...p, [name]: validateField(name, values) }));
  }

  function showToast(message, type = "error", title) {
    setToast({ show: true, type, title: title || (type === "error" ? "Помилка реєстрації" : ""), msg: message });
    setTimeout(() => setToast((t) => ({ ...t, show: false })), type === "error" ? 3600 : 3200);
  }

  function social(name) {
    showToast("Демо: підключіть OAuth-провайдера " + name + ".", "info", "Реєстрація через " + name);
  }

  async function onSubmit(e) {
    e.preventDefault();
    const allNames = [...FIELDS, "terms"];
    const newTouched = {};
    const newErrors = {};
    allNames.forEach((n) => {
      newTouched[n] = true;
      newErrors[n] = validateField(n, values);
    });
    setTouched(newTouched);
    setErrors(newErrors);
    if (allNames.some((n) => newErrors[n])) return;

    setSubmitting(true);
    const res = await registerUser(values);
    if (res.ok) {
      setSuccess(true);
      return;
    }
    setSubmitting(false);
    if (res.field === "email") {
      setTouched((p) => ({ ...p, email: true }));
      setErrors((p) => ({ ...p, email: res.message }));
    } else {
      showToast(res.message);
    }
  }

  const inputProps = (name, type = "text", extra = {}) => ({
    id: name,
    type,
    value: values[name],
    onChange: (e) => setField(name, e.target.value),
    onBlur: () => blurField(name),
    className: touched[name] && errors[name] ? "invalid" : undefined,
    "aria-invalid": touched[name] && errors[name] ? "true" : "false",
    ...extra,
  });

  return (
    <div className="reg-root">
      <div className="topbar">
        <div className="logo"><span className="dot" />RadFlow</div>
        <span className="badge"><span className="pdot" />14 днів безкоштовно</span>
      </div>

      <div className="card">
        {success ? (
          <div className="success fade">
            <div className="ic">✅</div>
            <h2>Акаунт адміністратора створено!</h2>
            <div className="sub">Якщо увімкнено підтвердження email — підтвердьте пошту, потім увійдіть. Радіологів і лікарів-направників ви додасте вже всередині, у розділах «Радіологи» та «Лікарі-направники».</div>
            <a className="btn" href="/login">Перейти до входу</a>
          </div>
        ) : (
          <>
            <div className="head">
              <h1>Реєстрація адміністратора клініки</h1>
              <p>Створіть акаунт адміністратора нової клініки. Співробітників ви додасте всередині системи.</p>
            </div>

            <div className="rec">⚡ Найшвидший спосіб</div>
            <div className="social">
              <button type="button" className="sbtn" onClick={() => social("Google")}><GoogleIcon />Продовжити з Google</button>
              <button type="button" className="sbtn" onClick={() => social("Facebook")}><FacebookIcon />Продовжити з Facebook</button>
              <button type="button" className="sbtn" onClick={() => social("X")}><XIcon />Продовжити з X</button>
            </div>

            <div className="divider">Або зареєструватися через email</div>

            <form onSubmit={onSubmit} noValidate>
              <div className="field">
                <label htmlFor="login">Логін</label>
                <input {...inputProps("login", "text", { placeholder: "Ваш логін", autoComplete: "username" })} />
                {touched.login && errors.login && <div className="err" role="alert">{errors.login}</div>}
              </div>
              <div className="field">
                <label htmlFor="email">Email</label>
                <input {...inputProps("email", "email", { placeholder: "you@clinic.ua", autoComplete: "email" })} />
                {touched.email && errors.email && <div className="err" role="alert">{errors.email}</div>}
              </div>
              <div className="field">
                <label htmlFor="phone">Номер телефону</label>
                <input {...inputProps("phone", "tel", { placeholder: "+380 XX XXX XX XX", autoComplete: "tel", inputMode: "tel" })} />
                {touched.phone && errors.phone && <div className="err" role="alert">{errors.phone}</div>}
              </div>
              <div className="field">
                <label htmlFor="password">Пароль</label>
                <input {...inputProps("password", "password", { placeholder: "Пароль", autoComplete: "new-password" })} />
                <div className="hint">Мінімум 8 символів, одна велика буква, одна цифра</div>
                {touched.password && errors.password && <div className="err" role="alert">{errors.password}</div>}
              </div>
              <div className="field">
                <label htmlFor="password2">Повторити пароль</label>
                <input {...inputProps("password2", "password", { placeholder: "Повторіть пароль", autoComplete: "new-password" })} />
                {touched.password2 && errors.password2 && <div className="err" role="alert">{errors.password2}</div>}
              </div>

              <div className="check">
                <input id="terms" type="checkbox" checked={values.terms}
                  onChange={(e) => { setField("terms", e.target.checked); setTouched((p) => ({ ...p, terms: true })); setErrors((p) => ({ ...p, terms: validateField("terms", { ...values, te