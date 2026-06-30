"use client";

/* ===== RadFlow — Додати лікаря-направляча =====
   Портовано з queue-app.jsx (AddDoctorModal). Чиста форма — збереження у БД
   робить батьківський компонент через onSave. */

import { useState } from "react";
import PhoneInput from "@/components/PhoneInput";
import { useModalA11y } from "@/lib/useModalA11y";

const SPECS = ["Невролог", "Ортопед-травматолог", "Онколог", "Терапевт", "Кардіолог", "Нейрохірург", "Ревматолог", "Інша спеціальність"];

type ExistingDoctor = { id: string; name: string; spec?: string | null; clinic_name?: string | null };

interface AddDoctorModalProps {
  existing?: ExistingDoctor[];
  onClose: () => void;
  onSave: (data: { name: string; spec: string; clinic: string; phone: string; email: string }) => void;
}

export default function AddDoctorModal({ existing = [], onClose, onSave }: AddDoctorModalProps) {
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  const [name, setName] = useState("");
  const [spec, setSpec] = useState("");
  const [phone, setPhone] = useState("");
  const [clinic, setClinic] = useState("");
  const [email, setEmail] = useState("");
  const valid = name.trim() && phone.trim();

  return (
    <div className="overlay">
      <div className="dialog fade-in" style={{ maxWidth: 540 }} ref={dialogRef} role="dialog" aria-modal="true" aria-label="Додавання лікаря-направника">
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--green-bg)", color: "var(--green)" }}>🩺</span>Додати лікаря-направляча</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dlg-body">
          <div className="hint-blue">Лікарі-направлячі прив'язуються до записів — це дозволяє формувати звіти за джерелами направлень.</div>
          <label className="fld">
            <span className="fld-lab">ПІБ лікаря <span className="req">*</span></span>
            <input className="inp" placeholder="Прізвище Ім'я По батькові" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <div className="fld-row">
            <label className="fld">
              <span className="fld-lab">Спеціальність</span>
              <select className="inp" value={spec} onChange={(e) => setSpec(e.target.value)}>
                <option value="">— Оберіть —</option>
                {SPECS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="fld">
              <span className="fld-lab">Телефон <span className="req">*</span></span>
              <PhoneInput required value={phone} onChange={setPhone} />
            </label>
          </div>
          <div className="fld-row">
            <label className="fld">
              <span className="fld-lab">Клініка / заклад</span>
              <input className="inp" placeholder="Назва закладу" value={clinic} onChange={(e) => setClinic(e.target.value)} />
            </label>
            <label className="fld">
              <span className="fld-lab">Email</span>
              <input className="inp" placeholder="doctor@clinic.ua" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
          </div>

          {existing.length > 0 && (
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
          <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
          <button className="btn btn-primary" disabled={!valid} onClick={() => onSave({ name: name.trim(), spec, clinic, phone, email })}>Додати лікаря</button>
        </div>
      </div>
    </div>
  );
}
