"use client";

/* ===== RadFlow — сторінка входу =====
   Той самий стиль, що й реєстрація (register.css). */

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";
import "./register.css";

const REQUIRED = "Це поле обов'язкове";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawRedirect = searchParams.get("redirect") || "/queue";
  // Лише внутрішні шляхи (захист від open-redirect): один "/", без "//" чи "/\".
  const redirectTo = /^\/(?![/\\])/.test(rawRedirect) ? rawRedirect : "/queue";

  const [values, setValues] = useState({ email: "", password: "" });
  const [errors, setErrors] = useState({});
  const [touched, setTouched] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState({ show: false, title: "", msg: "" });

  function validate(name, v) {
    if (name === "email") return !v.trim() ? REQUIRED : "";
    if (name === "password") return !v ? REQUIRED : "";
    return "";
  }

  function setField(name, value) {
    setValues((p) => ({ ...p, [name]: value }));
    if (touched[name]) setErrors((p) => ({ ...p, [name]: validate(name, value) }));
  }

  function blurField(name) {
    setTouched((p) => ({ ...p, [name]: true }));
    setErrors((p) => ({ ...p, [name]: validate(name, values[name]) }));
  }

  function showToast(msg, title = "Помилка входу") {
    setToast({ show: true, title, msg });
    setTimeout(() => setToast((t) => ({ ...t, show: false })), 3600);
  }

  async function onSubmit(e) {
    e.preventDefault();
    const newErrors = {
      email: validate("email", values.email),
      password: validate("password", values.password),
    };
    setTouched({ email: true, password: true });
    setErrors(newErrors);
    if (newErrors.email || newErrors.password) return;

    if (!isSupabaseConfigured()) {
      showToast("Supabase ще не налаштований. Див. docs/setup/02-supabase-setup.md");
      return;
    }

    setSubmitting(true);
    try {
      const supabase = createClient();
      // Вхід за логіном або email: якщо введено логін — резолвимо email.
      let email = values.email.trim();
      if (!email.includes("@")) {
        const { data: resolved } = await supabase.rpc("email_for_login", { p_login: email });
        if (!resolved) {
          setSubmitting(false);
          showToast("Невірний логін або пароль.");
          return;
        }
        email = resolved;
      }
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password: values.password,
      });
      if (error) {
        setSubmitting(false);
        if (/email not confirmed/i.test(error.message)) {
          showToast("Спочатку підтвердьте email — перевірте пошту.");
        } else {
          showToast("Невірний логін/email або пароль.");
        }
        return;
      }
      router.push(redirectTo);
      router.refresh();
    } catch {
      setSubmitting(false);
      showToast("Не вдалося звʼязатися із сервером. Спробуйте ще раз.");
    }
  }

  const inputProps = (name, type) => ({
    id: name,
    type,
    value: values[name],
    onChange: (e) => setField(name, e.target.value),
    onBlur: () => blurField(name),
    className: touched[name] && errors[name] ? "invalid" : undefined,
    "aria-invalid": touched[name] && errors[name] ? "true" : "false",
  });

  return (
    <div className="reg-root">
      <div className="topbar">
        <div className="logo">
          <span className="dot" />
          RadFlow
        </div>
      </div>

      <div className="card">
        <div className="head">
          <h1>Вхід у RadFlow</h1>
          <p>Введіть логін (або email) і пароль вашого акаунта</p>
        </div>

        <form onSubmit={onSubmit} noValidate>
          <div className="field">
            <label htmlFor="email">Логін або email</label>
            <input
              {...inputProps("email", "text")}
              placeholder="логін або you@clinic.ua"
              autoComplete="username"
            />
            {touched.email && errors.email && (
              <div className="err" role="alert">
                {errors.email}
              </div>
            )}
          </div>

          <div className="field">
            <label htmlFor="password">Пароль</label>
            <input
              {...inputProps("password", "password")}
              placeholder="Пароль"
              autoComplete="current-password"
            />
            {touched.password && errors.password && (
              <div className="err" role="alert">
                {errors.password}
              </div>
            )}
          </div>

          <button
            className="btn"
            type="submit"
            disabled={submitting}
            aria-busy={submitting}
            style={{ marginTop: 6 }}
          >
            {submitting ? (
              <>
                <span className="spinner" />
                Входимо…
              </>
            ) : (
              "Увійти"
            )}
          </button>

          <p className="alt">
            Перший вхід? <a href="/set-password">Встановіть пароль</a>
          </p>
          <p className="alt">
            Нова клініка? <a href="/register">Зареєструвати адміністратора</a>
          </p>
        </form>
      </div>

      <div
        className={"toast" + (toast.show ? " show" : "")}
        role="alert"
        style={{ borderLeftColor: "var(--red)" }}
      >
        <div className="tt">{toast.title}</div>
        <div className="td">{toast.msg}</div>
      </div>
    </div>
  );
}
