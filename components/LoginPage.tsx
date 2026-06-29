"use client";

/* ===== RadFlow — сторінка входу =====
   Той самий стиль, що й реєстрація (register.css). */

import { useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import "./register.css";

const REQUIRED = "Це поле обов'язкове";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawRedirect = searchParams.get("redirect") || "/queue";
  // Лише внутрішні шляхи (захист від open-redirect): один "/", без "//" чи "/\".
  const redirectTo = /^\/(?![/\\])/.test(rawRedirect) ? rawRedirect : "/queue";

  const [values, setValues] = useState<Record<string, string>>({ email: "", password: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<{ show: boolean; title: string; msg: string }>({ show: false, title: "", msg: "" });

  function validate(name: string, v: string): string {
    if (name === "email") return !v.trim() ? REQUIRED : "";
    if (name === "password") return !v ? REQUIRED : "";
    return "";
  }

  function setField(name: string, value: string) {
    setValues((p) => ({ ...p, [name]: value }));
    if (touched[name]) setErrors((p) => ({ ...p, [name]: validate(name, value) }));
  }

  function blurField(name: string) {
    setTouched((p) => ({ ...p, [name]: true }));
    setErrors((p) => ({ ...p, [name]: validate(name, values[name]) }));
  }

  function showToast(msg: string, title = "Помилка входу") {
    setToast({ show: true, title, msg });
    setTimeout(() => setToast((t) => ({ ...t, show: false })), 3600);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const newErrors: Record<string, string> = {
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
      // Вхід за логіном або email — резолв і signIn на сервері (email не розкривається).
      const res = await fetch("/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: values.email.trim(), password: values.password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSubmitting(false);
        showToast(data.error || "Невірний логін/email або пароль.");
        return;
      }
      router.push(redirectTo);
      router.refresh();
    } catch {
      setSubmitting(false);
      showToast("Не вдалося звʼязатися із сервером. Спробуйте ще раз.");
    }
  }

  const inputProps = (name: string, type: string) => ({
    id: name,
    type,
    value: values[name],
    onChange: (e: ChangeEvent<HTMLInputElement>) => setField(name, e.target.value),
    onBlur: () => blurField(name),
    className: touched[name] && errors[name] ? "invalid" : undefined,
    "aria-invalid": !!(touched[name] && errors[name]),
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
