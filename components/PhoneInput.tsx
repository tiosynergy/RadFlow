"use client";

/* ===== RadFlow — поле телефону (стиль Apple iOS) =====
   Форматує номер під час набору і підсвічує некоректний (.invalid).
   value/onChange лишаються рядком — зберігається відформатований номер. */

import type { CSSProperties } from "react";
import { formatPhoneUA, isValidPhoneUA } from "@/lib/phone";

interface PhoneInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  className?: string;
  style?: CSSProperties;
  id?: string;
  name?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  onBlur?: () => void;
}

export default function PhoneInput({
  value,
  onChange,
  placeholder = "+380 XX XXX XX XX",
  required = false,
  className = "inp",
  style,
  id,
  name,
  disabled,
  autoFocus,
  onBlur,
}: PhoneInputProps) {
  const has = (value || "").trim() !== "";
  // Некоректний, якщо є введення, але номер ще не повний;
  // або поле обовʼязкове й порожнє.
  const invalid = (has && !isValidPhoneUA(value)) || (required && !has);

  return (
    <input
      type="tel"
      inputMode="tel"
      autoComplete="tel"
      id={id}
      name={name}
      disabled={disabled}
      autoFocus={autoFocus}
      className={className + (invalid && has ? " invalid" : "")}
      placeholder={placeholder}
      value={value}
      style={style}
      onBlur={onBlur}
      onChange={(e) => onChange(formatPhoneUA(e.target.value))}
    />
  );
}
