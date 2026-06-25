"use client";

/* ===== RadFlow — Редагування даних пацієнта =====
   Відкривається кліком по імені пацієнта в черзі (адміністратор) або у
   «Моїх направленнях» (лікар-направник). Зміни пишуться в queue_entries і
   миттєво розходяться по ролях через Realtime/полінг.
   «Лікар-направник» випадає зі списку АКТИВНИХ направників ЦЕНТРУ запису
   (referral_access → profiles) + довідник doctors центру. У кожного центру
   власний перелік; направники працюють з багатьма центрами (M2M referral_access). */

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";

function calcAge(dob) {
  if (!dob) return null;
  const b = new Date(dob);
  if (isNaN(b.getTime())) return null;
  const n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  const m = n.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && n.getDate() < b.getDate())) a--;
  return a < 0 ? null : a;
}

export default function PatientEditModal({ entryId, onClose, onSaved }) {
  const [form, setForm] = useState(null);
  const [docs, setDocs] = useState([]); // [{key, name, sub}]
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let live = true;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("queue_entries")
        .select("id, clinic_id, patient_name, patient_phone, patient_dob, patient_age, patient_sex, patient_weight, contraindications, doctor, note")
        .eq("id", entryId)
        .maybeSingle();
      if (!live) return;
      setForm(data || {});
      if (data?.clinic_id) {
        const cid = data.clinic_id;
        // Активні направники центру (акаунти) + довідник лікарів центру.
        const [accRes, docRes] = await Promise.all([
          supabase.from("referral_access").select("referrer_id").eq("clinic_id", cid).eq("status", "active"),
          supabase.from("doctors").select("id, name, spec").eq("clinic_id", cid).order("name"),
        ]);
        const refIds = Array.from(new Set((accRes.data || []).map((a) => a.referrer_id)));
        let refProfiles = [];
        if (refIds.length) {
          const { data: profs } = await supabase.from("profiles").select("id, full_name").in("id", refIds);
          refProfiles = profs || [];
        }
        const seen = new Set();
        const opts = [];
        refProfiles.forEach((p) => { const n = (p.full_name || "").trim(); if (n && !seen.has(n)) { seen.add(n); opts.push({ key: "r-" + p.id, name: n, sub: "направник" }); } });
        (docRes.data || []).forEach((d) => { const n = (d.name || "").trim(); if (n && !seen.has(n)) { seen.add(n); opts.push({ key: "d-" + d.id, name: n, sub: d.spec || "" }); } });
        opts.sort((a, b) => a.name.localeCompare(b.name, "uk"));
        if (live) setDocs(opts);
      }
    })();
    return () => { live = false; };
  }, [entryId]);

  function setF(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  async function save() {
    if (!form) return;
    if (!String(form.patient_name || "").trim()) { setErr("Вкажіть ПІБ пацієнта"); return; }
    setBusy(true); setErr("");
    const supabase = createClient();
    const w = form.patient_weight;
    const patch = {
      patient_name: form.patient_name.trim(),
      patient_phone: (form.patient_phone || "").trim() || null,
      patient_dob: form.patient_dob || null,
      patient_age: form.patient_dob ? calcAge(form.patient_dob) : (form.patient_age ?? null),
      patient_sex: form.patient_sex || null,
      patient_weight: (w === "" || w == null) ? null : Number(w),
      contraindications: !!form.contraindications,
      doctor: (form.doctor || "").trim() || null,
      note: (form.note || "").trim() || null,
    };
    const { error } = await supabase.from("queue_entries").update(patch).eq("id", entryId);
    setBusy(false);
    if (error) { setErr("Помилка збереження: " + error.message); return; }
    if (onSaved) onSaved();
    if (onClose) onClose();
  }

  const curDoctor = form?.doctor || "";
  const knownDoctor = docs.some((d) => d.name === curDoctor);

  return (
    <div className="overlay" onClick={() => { if (!busy) onClose(); }}>
      <div className="dialog fade-in" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--blue-bg)", color: "var(--blue)" }}>👤</span>Дані пацієнта</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dlg-body">
          {!form ? (
            <div style={{ color: "var(--text-muted)", padding: 8 }}>Завантаження…</div>
          ) : (
            <>
              <label className="fld"><span className="fld-lab">ПІБ *</span>
                <input className="inp" autoFocus value={form.patient_name || ""} onChange={(e) => setF("patient_name", e.target.value)} placeholder="Прізвище Імʼя По батькові" />
              </label>
              <div className="fld-row">
                <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Телефон</span>
                  <input className="inp" type="tel" value={form.patient_phone || ""} onChange={(e) => setF("patient_phone", e.target.value)} placeholder="+380 XX XXX XX XX" />
                </label>
                <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Дата народження</span>
                  <input className="inp tabular" type="date" value={form.patient_dob || ""} onChange={(e) => setF("patient_dob", e.target.value)} />
                </label>
              </div>
              <div className="fld-row">
                <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Стать</span>
                  <select className="inp" value={form.patient_sex || ""} onChange={(e) => setF("patient_sex", e.target.value)}>
                    <option value="">—</option>
                    <option value="М">Чоловік</option>
                    <option value="Ж">Жінка</option>
                  </select>
                </label>
                <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Вага, кг</span>
                  <input className="inp" type="number" min="0" value={form.patient_weight ?? ""} onChange={(e) => setF("patient_weight", e.target.value)} />
                </label>
              </div>
              <label className="fld"><span className="fld-lab">Лікар-направник</span>
                <select className="inp" value={curDoctor} onChange={(e) => setF("doctor", e.target.value)}>
                  <option value="">— не вказано —</option>
                  {curDoctor && !knownDoctor && <option value={curDoctor}>{curDoctor}</option>}
                  {docs.map((d) => <option key={d.key} value={d.name}>{d.name}{d.sub ? " · " + d.sub : ""}</option>)}
                </select>
              </label>
              <label className={"rf-check" + (form.contraindications ? " on" : "")} style={{ marginBottom: 10 }}>
                <input type="checkbox" checked={!!form.contraindications} onChange={(e) => setF("contraindications", e.target.checked)} />
                <span className="rf-box" /><span>Є протипоказання (напр. кардіостимулятор, металеві імпланти)</span>
              </label>
              <label className="fld" style={{ marginBottom: 0 }}><span className="fld-lab">Примітка</span>
                <input className="inp" value={form.note || ""} onChange={(e) => setF("note", e.target.value)} />
              </label>
              {err && <div className="ctx-hint red" style={{ fontSize: 12.5, marginTop: 8 }}>⚠ {err}</div>}
            </>
          )}
        </div>
        <div className="dlg-foot" style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Скасувати</button>
          <button className="btn btn-primary" disabled={busy || !form} onClick={save}>{busy ? "Збереження…" : "Зберегти"}</button>
        </div>
      </div>
    </div>
  );
}
