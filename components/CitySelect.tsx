"use client";

/* ===== RadFlow — вибір населеного пункту (combobox) =====
   Місто обирається зі списку (довідник КАТОТТГ, таблиця public.cities) через
   серверний пошук RPC search_cities — список (~30k) не вантажиться у браузер.
   value/onChange лишаються рядком: назовні віддається готовий підпис (label),
   напр. "м. Київ, Київська обл." — він і зберігається у clinics.city. */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createClient } from "@/lib/supabase/client";

interface CityHit {
  id: string;
  name: string;
  region: string | null;
  district: string | null;
  category: string;
  label: string;
}

interface CitySelectProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  className?: string;
  style?: CSSProperties;
  id?: string;
  name?: string;
  disabled?: boolean;
}

export default function CitySelect({
  value,
  onChange,
  placeholder = "Почніть вводити місто…",
  required = false,
  className = "inp",
  style,
  id,
  name,
  disabled,
}: CitySelectProps) {
  const [text, setText] = useState(value || "");
  const [hits, setHits] = useState<CityHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  // Чи відповідає поточний текст обраному зі списку значенню.
  const chosenRef = useRef(value || "");

  // Зовнішня зміна value (напр. префіл форми) — синхронізуємо текст.
  useEffect(() => {
    setText(value || "");
    chosenRef.current = value || "";
  }, [value]);

  // Debounce-пошук у довіднику.
  useEffect(() => {
    const q = text.trim();
    if (q.length < 2 || q === chosenRef.current.trim()) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const supabase = createClient();
        const { data, error } = await supabase.rpc("search_cities", { q });
        if (error) throw error;
        if (!cancelled) {
          setHits((data as CityHit[]) || []);
          setOpen(true);
          setActive(-1);
        }
      } catch {
        // Транзієнтні мережеві помилки (оновлення токена тощо) не валять UI.
        if (!cancelled) setHits([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [text]);

  // Клік поза компонентом — закрити список.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function pick(h: CityHit) {
    setText(h.label);
    chosenRef.current = h.label;
    onChange(h.label);
    setOpen(false);
    setHits([]);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || hits.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      pick(hits[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const has = (text || "").trim() !== "";
  // Некоректно: поле обовʼязкове й порожнє, АБО введено текст без вибору зі списку.
  const invalid = (required && !has) || (has && text.trim() !== chosenRef.current.trim());

  return (
    <div ref={boxRef} style={{ position: "relative", ...style }}>
      <input
        id={id}
        name={name}
        disabled={disabled}
        autoComplete="off"
        className={className + (invalid && has ? " invalid" : "")}
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value.trim() !== chosenRef.current.trim()) onChange("");
        }}
        onFocus={() => hits.length > 0 && setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && hits.length > 0 && (
        <ul className="city-list" role="listbox">
          {hits.map((h, i) => (
            <li
              key={h.id}
              role="option"
              aria-selected={i === active}
              className={"city-opt" + (i === active ? " active" : "")}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(h);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="city-opt-name">{h.name}</span>
              <span className="city-opt-meta">
                {[h.district ? h.district + " р-н" : null, h.region ? h.region + " обл." : null]
                  .filter(Boolean)
                  .join(", ")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
