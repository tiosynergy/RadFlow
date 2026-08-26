"use client";

/* ===== RadFlow — Додати лікаря-направляча =====
   Портовано з queue-app.jsx (AddDoctorModal). Чиста форма — збереження у БД
   робить батьківський компонент через onSave. */

import { useState } from "react";
import PhoneInput from "@/components/PhoneInput";
import { useModalA11y } from "@/lib/useModalA11y";

const SPECS = ["Невролог", "Ортопед-травматолог", "Онколог", "Терапевт", "Кардіолог", "Нейрохірург", "Ревматолог", "Інша спеціальність"];

type ExistingDoctor = { id: string; name: string; spec?: string | null; clinic_name?: string | null };

/* с43: та сама форма працює і на РЕДАГУВАННЯ картки довідника (initial
   заданий) — «дія в місці ухвалення рішення». В edit-режимі: свої заголовок і
   кнопка, прихований блок «Вже у базі» (нерелевантний), прихований email
   (колонки в `doctors` НЕМАЄ — порожнє поле брехало б, що email «не задано»),
   і чесне попередження, що вже створені записи тримають імʼя текстом. */
interface AddDoctorModalProps {
  existing?: ExistingDoctor[];
  initial?: { name: string; spec: string; clinic: string; phone: string } | null;
  /** Контекстне пояснення замість типового hint (напр. «імʼя оновиться і в
      цьому записі» з картки пацієнта). */
  hint?: string;
  /** Помилка збереження — показується ТУТ, форма лишається відкритою з
      введеним (ревʼю с43: закриття при відмові викидало набране). */
  errorText?: string | null;
  onClose: () => void;
  onSave: (data: { name: string; spec: string; clinic: string; phone: string; email: string }) => void | Promise<void>;
}

export default function AddDoctorModal({ existing = [], initial = null, hint, errorText = null, onClose, onSave }: AddDoctorModalProps) {
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  const editMode = initial != null;
  const [name, setName] = useState(initial?.name ?? "");
  const [spec, setSpec] = useState(initial?.spec ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [clinic, setClinic] = useState(initial?.clinic ?? "");
  const [email, setEmail] = useState("");
  /* Подвійний клік «Додати» = два insert, а DELETE у реєстратора немає —
     дубль було б нікому прибрати (ревʼю с43). */
  const [busy, setBusy] = useState(false);
  /* Легасі-опція спеціальності — від ПОЧАТКОВОГО значення, не від поточного:
     інакше вона зникала б зі списку після першого ж перемикання. */
  const initialSpec = initial?.spec ?? "";
  /* Телефон обовʼязковий лише при СТВОРЕННІ: легасі-картка без телефону
     інакше не давала б виправити навіть одрук у ПІБ (ревʼю с43). */
  const valid = name.trim() && (editMode || phone.trim());

  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 540 }} ref={dialogRef} role="dialog" aria-modal="true" aria-label={editMode ? "Редагування даних лікаря-направника" : "Додавання лікаря-направника"}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--green-bg)", color: "var(--green)" }}>🩺</span>{editMode ? "Редагувати дані лікаря" : "Додати лікаря-направника"}</div>
          <button className="icon-btn" onClick={onClose} aria-label="Закрити">✕</button>
        </div>
        <div className="dlg-body">
          <div className="hint-blue">{hint ?? (editMode
            ? "Зміни застосуються до довідника й до нових записів. Раніше створені записи зберігають імʼя лікаря на момент запису."
            : "Лікарі-направники прив'язуються до записів — це дозволяє формувати звіти за джерелами направлень.")}</div>
          {errorText && <div className="ctx-hint red" role="alert" style={{ fontSize: "0.78125rem", marginBottom: 10 }}>⚠ {errorText}</div>}
          <label className="fld">
            <span className="fld-lab">ПІБ лікаря <span className="req">*</span></span>
            <input className="inp" placeholder="Прізвище Ім'я По батькові" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <div className="fld-row">
            <label className="fld">
              <span className="fld-lab">Спеціальність</span>
              <select className="inp" value={spec} onChange={(e) => setSpec(e.target.value)}>
                <option value="">— Оберіть —</option>
                {/* Спеціальність поза списком (легасі-дані) — не губимо мовчки.
                    Від ПОЧАТКОВОГО значення: інакше опція зникала б після
                    першого перемикання і повернутись було б нікуди. */}
                {initialSpec && !SPECS.includes(initialSpec) && <option value={initialSpec}>{initialSpec}</option>}
                {SPECS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="fld">
              <span className="fld-lab">Телефон {!editMode && <span className="req">*</span>}</span>
              <PhoneInput required={!editMode} value={phone} onChange={setPhone} />
            </label>
          </div>
          <div className="fld-row">
            <label className="fld">
              <span className="fld-lab">Клініка / заклад</span>
              <input className="inp" placeholder="Назва закладу" value={clinic} onChange={(e) => setClinic(e.target.value)} />
            </label>
            {!editMode && (
            <label className="fld">
              <span className="fld-lab">Email</span>
              <input className="inp" placeholder="doctor@clinic.ua" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            )}
          </div>

          {!editMode && existing.length > 0 && (
            <div className="fld">
              <span className="fld-lab">Вже у базі ({existing.length})</span>
              <div className="doc-list">
                {existing.map((d) => (
                  <div className="doc-row" key={d.id}>
                    <span className="doc-av">{String(d.name).split(" ").map((w) => w[0]).slice(0, 2).join("")}</span>
                    <span className="doc-meta">
                      <span className="doc-name">{d.name}</span>
                      <span className="doc-sub">{[d.spec, d.clinic_name].filter(Boolean).join(" · ")}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="dlg-foot">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Скасувати</button>
          <button className="btn btn-primary" disabled={!valid || busy}
            onClick={async () => {
              setBusy(true);
              try { await onSave({ name: name.trim(), spec, clinic, phone, email }); }
              finally { setBusy(false); }
            }}>
            {busy ? "Зберігаємо…" : editMode ? "Зберегти зміни" : "Додати лікаря"}
          </button>
        </div>
      </div>
    </div>
  );
}
