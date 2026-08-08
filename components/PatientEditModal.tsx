"use client";

/* ===== RadFlow — Редагування даних пацієнта =====
   Відкривається кліком по імені пацієнта в черзі (адміністратор) або у
   «Моїх направленнях» (лікар-направник). Зміни пишуться в queue_entries і
   миттєво розходяться по ролях через Realtime/полінг. */

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { updatePatientDetails, setQueuePriority } from "@/app/queue/actions";
import PhoneInput from "@/components/PhoneInput";
import { PRIORITY_OPTIONS, PRIORITY_META, type PatientPriority } from "@/lib/priority";
import type { TablesUpdate } from "@/supabase/types";
import "@/styles/prototype/radflow.css";
import "@/styles/prototype/radflow-screens.css";
import { useModalA11y } from "@/lib/useModalA11y";

type PatientForm = {
  id?: string;
  clinic_id?: string | null;
  created_by?: string | null;
  patient_name?: string;
  patient_phone?: string | null;
  patient_dob?: string | null;
  patient_age?: number | null;
  patient_sex?: string | null;
  patient_weight?: number | string | null;
  contraindications?: boolean | null;
  doctor?: string | null;
  note?: string | null;
  priority_level?: PatientPriority;
};
type DoctorOption = { key: string; name: string; sub: string };
/* «Залишити як є» для `doctor`, якого немає ні серед направників, ні в довіднику
   (напр. лікаря прибрали з довідника). Окремий ключ, а НЕ порожній рядок:
   інакше «не чіпати» і «очистити» зливаються, і довільний текст стає незмивним
   (ревʼю р.1). */
const KEEP_KEY = "keep";
/* ⚠️ ОДНА нормалізація на весь файл. У ревʼю р.2: `nameCount`/`refNames`
   рахувались по СИРОМУ `trim()`, а зіставлення довідника — по нормалізованому.
   На тих самих даних, що дали початковий баг («Заставська··Марія» проти
   «Заставська·Марія»), колізія не виявлялась, мітки `@login` не було, а
   браузер згортає пробіли в `<option>` — два РІЗНІ пункти виглядали однаково.
   Оператор обирав навмання, і вибір направника відправляв картку пацієнта в
   чужий портал. Порівнюємо ТІЛЬКИ через `norm`. */
const norm = (s: string) => s.trim().replace(/\s+/g, " ");

interface PatientEditModalProps {
  entryId: string;
  canEditPriority?: boolean; // адмін або лікар-направник (власник запису)
  onClose: () => void;
  onSaved?: () => void;
}

function calcAge(dob: string | null | undefined): number | null {
  if (!dob) return null;
  const b = new Date(dob);
  if (isNaN(b.getTime())) return null;
  const n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  const m = n.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && n.getDate() < b.getDate())) a--;
  return a < 0 ? null : a;
}

export default function PatientEditModal({ entryId, canEditPriority, onClose, onSaved }: PatientEditModalProps) {
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);
  const [form, setForm] = useState<PatientForm | null>(null);
  const [origPriority, setOrigPriority] = useState<PatientPriority | null>(null);
  const [docs, setDocs] = useState<DoctorOption[]>([]); // активні направники + довідник
  const [lockDoctor, setLockDoctor] = useState(false); // запис внесено направником → не редагувати
  /* ⚠️ ВИБІР НАПРАВНИКА ЖИВЕ КЛЮЧЕМ (`r-<id>` / `d-<id>` / ""), А НЕ ІМЕНЕМ.
     Раніше `referrer_id` перезбирався на КОЖНОМУ збереженні пошуком по рядку
     (`docs.find(d => d.name === form.doctor)`), і будь-яке розходження тихо
     клало null. Зловлено живцем: у профілі «Заставська  Марія» (17 символів,
     подвійний пробіл), у записі «Заставська Марія» (16) — адмін правив ПІБ
     ПАЦІЄНТА, поля направника не чіпав, а звʼязок рвався. Запис зникав із
     порталу направника (той фільтрує по `referrer_id`), крапка не зʼявлялась,
     а `doctor` лишався текстом — тобто адмін навіть не бачив поломки.
     Імʼя як ключ ламається ще й на тезках (дедуп по імені викидає другого)
     і на переіменуванні направника. */
  const [docKey, setDocKey] = useState<string>("");
  const [origDocKey, setOrigDocKey] = useState<string>("");
  /* Направник у записі є, але його картка недоступна цій ролі (RLS) → поле
     тільки для читання: керувати тим, чого не бачимо, не можна. */
  const [refUnresolved, setRefUnresolved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let live = true;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("queue_entries")
        // `referrer_id` читаємо ОБОВʼЯЗКОВО: саме він, а не імʼя, визначає звʼязок.
        .select("id, clinic_id, created_by, patient_name, patient_phone, patient_dob, patient_age, patient_sex, patient_weight, contraindications, doctor, referrer_id, note, priority_level")
        .eq("id", entryId)
        .maybeSingle();
      if (!live) return;
      setForm(data || {});
      setOrigPriority(data?.priority_level ?? null);
      if (data?.clinic_id) {
        const cid = data.clinic_id;
        const [accRes, docRes] = await Promise.all([
          supabase.from("referral_access").select("referrer_id, status").eq("clinic_id", cid),
          supabase.from("doctors").select("id, name, spec").eq("clinic_id", cid).order("name"),
        ]);
        const access = accRes.data || [];
        // Чи запис створив направник центру (будь-який статус доступу) → блокуємо зміну.
        const allRefIds = new Set(access.map((a) => a.referrer_id));
        if (data.created_by && allRefIds.has(data.created_by)) { if (live) setLockDoctor(true); }
        // Список для вибору — лише АКТИВНІ направники + довідник.
        const activeRefIds = Array.from(new Set(access.filter((a) => a.status === "active").map((a) => a.referrer_id)));
        /* ⚠️ ПОТОЧНИЙ направник запису — В СПИСКУ ЗАВЖДИ, навіть якщо його доступ
           уже НЕ active: інакше в селекті немає опції з його ключем, і перше ж
           збереження мовчки перевело б запис у «без направника». */
        const curRefId = data.referrer_id ?? null;
        const idsToLoad = Array.from(new Set([...activeRefIds, ...(curRefId ? [curRefId] : [])]));
        let refProfiles: { id: string; full_name: string | null; login: string | null }[] = [];
        if (idsToLoad.length) {
          const { data: profs } = await supabase.from("profiles").select("id, full_name, login").in("id", idsToLoad);
          refProfiles = profs || [];
        }
        const activeSet = new Set(activeRefIds);
        /* ⚠️ ДЕДУП ПО КЛЮЧУ, А НЕ ПО ІМЕНІ (ревʼю р.1). Дедуп по імені викидав
           ТЕЗКУ — і якщо викинутим виявлявся поточний направник, у селекті
           лишався ІНШИЙ лікар із тим самим ПІБ. Оператор обирав його не
           помітивши, і запис їхав у портал ЧУЖОГО направника: це вже не
           загублений звʼязок, а показ даних пацієнта сторонній людині.
           Тезок тепер розрізняємо логіном, а не ховаємо. */
        const nameCount = new Map<string, number>();
        refProfiles.forEach((p) => { const n = norm(p.full_name || ""); if (n) nameCount.set(n, (nameCount.get(n) ?? 0) + 1); });
        const opts: DoctorOption[] = [];
        refProfiles.forEach((p) => {
          const n = (p.full_name || "").trim();
          if (!n) return;
          const marks = ["направник"];
          if ((nameCount.get(norm(n)) ?? 0) > 1 && p.login) marks.push("@" + p.login);   // тезки — за НОРМАЛІЗОВАНИМ імʼям
          if (!activeSet.has(p.id)) marks.push("доступ неактивний");                     // поточний із відкликаним доступом
          opts.push({ key: "r-" + p.id, name: n, sub: marks.join(" · ") });
        });
        const refNames = new Set(opts.map((o) => norm(o.name)));
        (docRes.data || []).forEach((d) => { const n = (d.name || "").trim(); if (n && !refNames.has(norm(n))) opts.push({ key: "d-" + d.id, name: n, sub: d.spec || "" }); });
        opts.sort((a, b) => a.name.localeCompare(b.name, "uk"));
        /* Початковий ключ: направник — ЗА id (єдине надійне джерело). Далі —
           лікар довідника за нормалізованим іменем (для нього FK не існує
           взагалі, це лише підсвітка). Якщо `doctor` не впізнано — KEEP_KEY:
           окремий пункт «залишити як є», НЕ той самий, що «— не вказано —».
           Без цього розділення (ревʼю р.1) не можна було ані стерти довільний
           текст, ані відрізнити «не чіпати» від «очистити». */
        let k = "";
        const curResolved = !!curRefId && opts.some((o) => o.key === "r-" + curRefId);
        if (curResolved) k = "r-" + curRefId;
        else if ((data.doctor || "").trim()) {
          k = opts.find((o) => o.key.startsWith("d-") && norm(o.name) === norm(data.doctor as string))?.key ?? KEEP_KEY;
        }
        /* ⚠️ FAIL-CLOSED, коли направник Є, але його картку прочитати не вдалось
           (ревʼю р.2). RLS на `referral_access`/`profiles` вимагає адміна, тож у
           реєстратора й радіолога список направників порожній ЗАВЖДИ. Без цього
           гарду селект показував би «— не вказано —» при заповненому
           `referrer_id`, і одне випадкове торкання поля тихо відчепило б
           направлення — причому саме той користувач відновити звʼязок не може.
           Блокуємо поле замість того, щоб дати його зіпсувати. */
        if (live) {
          setDocs(opts); setDocKey(k); setOrigDocKey(k);
          if (curRefId && !curResolved) setRefUnresolved(true);
        }
      }
    })();
    return () => { live = false; };
  }, [entryId]);

  function setF<K extends keyof PatientForm>(k: K, v: PatientForm[K]) { setForm((f) => ({ ...(f || {}), [k]: v })); }

  async function save() {
    if (!form) return;
    if (!String(form.patient_name || "").trim()) { setErr("Вкажіть ПІБ пацієнта"); return; }
    if (!String(form.patient_phone || "").trim()) { setErr("Вкажіть телефон"); return; }
    if (!form.patient_dob) { setErr("Вкажіть дату народження"); return; }
    if (!form.patient_sex) { setErr("Вкажіть стать"); return; }
    setBusy(true); setErr("");
    const w = form.patient_weight;
    const patch: TablesUpdate<"queue_entries"> = {
      patient_name: (form.patient_name || "").trim(),
      patient_phone: (form.patient_phone || "").trim() || null,
      patient_dob: form.patient_dob || null,
      patient_age: form.patient_dob ? calcAge(form.patient_dob) : (form.patient_age ?? null),
      patient_sex: form.patient_sex || null,
      patient_weight: (w === "" || w == null) ? null : Number(w),
      contraindications: !!form.contraindications,
      note: (form.note || "").trim() || null,
    };
    /* Направника змінюємо ЛИШЕ якщо запис не внесений самим направником І
       користувач СПРАВДІ рухав це поле. Без другої умови правка ПІБ пацієнта
       перезаписувала б `referrer_id` наосліп — саме так звʼязок і губився. */
    if (!lockDoctor && !refUnresolved && docKey !== origDocKey && docKey !== KEEP_KEY) {
      const selOpt = docs.find((d) => d.key === docKey);   // ключ, не імʼя
      patch.doctor = selOpt ? selOpt.name : null;          // docKey === "" → очистити
      patch.referrer_id = selOpt && selOpt.key.startsWith("r-") ? selOpt.key.slice(2) : null;
    }
    const res = await updatePatientDetails(entryId, patch);
    // Пріоритет — окремим викликом з перевіркою ролі (лише admin/направник-власник).
    if (res.ok && canEditPriority && form.priority_level && form.priority_level !== origPriority) {
      const pr = await setQueuePriority(entryId, form.priority_level);
      if (!pr.ok) { setBusy(false); setErr("Дані збережено, але пріоритет: " + pr.error); return; }
    }
    setBusy(false);
    if (!res.ok) { setErr("Помилка збереження: " + res.error); return; }
    if (onSaved) onSaved();
    if (onClose) onClose();
  }

  const curDoctor = form?.doctor || "";
  /* Пункт «залишити як є» показуємо, лише поки він доречний: запис прийшов із
     нерозпізнаним `doctor`. Мітка НЕ залежить від поточного вибору — інакше
     «— не вказано —» перемальовувалось би на старе імʼя, і оператор думав би,
     що очищення не спрацювало, тоді як патч уже ніс null (ревʼю р.1). */
  const showKeepOption = origDocKey === KEEP_KEY && !!curDoctor;

  return (
    <div className="overlay" onClick={() => { if (!busy) onClose(); }}>
      <div className="dialog fade-in" style={{ maxWidth: 460 }} ref={dialogRef} role="dialog" aria-modal="true" aria-label="Редагування даних пацієнта" onClick={(e) => e.stopPropagation()}>
        <div className="dlg-head">
          <div className="dlg-title"><span className="tic" style={{ background: "var(--blue-bg)", color: "var(--blue-text)" }}>👤</span>Дані пацієнта</div>
          <button className="icon-btn" onClick={onClose} aria-label="Закрити">✕</button>
        </div>
        <div className="dlg-body">
          {!form ? (
            <div style={{ color: "var(--text-muted)", padding: 8 }}>Завантаження…</div>
          ) : (
            <>
              <label className="fld"><span className="fld-lab">ПІБ <span className="req">*</span></span>
                <input className="inp" autoFocus value={form.patient_name || ""} onChange={(e) => setF("patient_name", e.target.value)} placeholder="Прізвище Імʼя По батькові" />
              </label>
              <div className="fld-row">
                <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Телефон <span className="req">*</span></span>
                  <PhoneInput value={form.patient_phone || ""} onChange={(v) => setF("patient_phone", v)} />
                </label>
                <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Дата народження <span className="req">*</span></span>
                  <input className="inp tabular" type="date" value={form.patient_dob || ""} onChange={(e) => setF("patient_dob", e.target.value)} />
                </label>
              </div>
              <div className="fld-row">
                <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Стать <span className="req">*</span></span>
                  <select className="inp" value={form.patient_sex || ""} onChange={(e) => setF("patient_sex", e.target.value)}>
                    <option value="">—</option>
                    <option value="М">Чоловік</option>
                    <option value="Ж">Жінка</option>
                  </select>
                </label>
                <label className="fld" style={{ flex: 1 }}><span className="fld-lab">Вага, кг</span>
                  {/* max = PATIENT_WEIGHT_MAX (lib/validation.ts): сервер відхилить більше,
                      і без max у полі користувач отримав би загальний 400 замість підказки. */}
                  <input className="inp" type="number" min="0" max="400" value={form.patient_weight ?? ""} onChange={(e) => setF("patient_weight", e.target.value)} />
                </label>
              </div>
              <label className="fld"><span className="fld-lab">Лікар-направник</span>
                {lockDoctor ? (
                  <>
                    <input className="inp" value={curDoctor || "— не вказано —"} disabled readOnly title="Запис внесено лікарем-направником" />
                    <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>🔒 Запис внесено лікарем-направником — зміна недоступна.</span>
                  </>
                ) : refUnresolved ? (
                  <>
                    <input className="inp" value={curDoctor || "— не вказано —"} disabled readOnly title="Картка направника недоступна для вашої ролі" />
                    <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>🔒 Направника призначено, але його картка недоступна для вашої ролі. Щоб не відчепити направлення, поле заблоковано — зверніться до адміністратора центру.</span>
                  </>
                ) : (
                  <select className="inp" value={docKey} onChange={(e) => setDocKey(e.target.value)}>
                    <option value="">— не вказано —</option>
                    {showKeepOption && <option value={KEEP_KEY}>{curDoctor} (не у списку — залишити)</option>}
                    {docs.map((d) => <option key={d.key} value={d.key}>{d.name}{d.sub ? " · " + d.sub : ""}</option>)}
                  </select>
                )}
              </label>
              <label className={"rf-check" + (form.contraindications ? " on" : "")} style={{ marginBottom: 10 }}>
                <input type="checkbox" checked={!!form.contraindications} onChange={(e) => setF("contraindications", e.target.checked)} />
                <span className="rf-box" /><span>Є протипоказання (напр. кардіостимулятор, металеві імпланти)</span>
              </label>
              {canEditPriority && (
                <div className="fld" style={{ marginBottom: 10 }}>
                  <span className="fld-lab">Пріоритет пацієнта</span>
                  <div className="prio-seg" role="radiogroup" aria-label="Пріоритет пацієнта">
                    {PRIORITY_OPTIONS.map((pv) => {
                      const m = PRIORITY_META[pv];
                      return (
                        <button key={pv} type="button" role="radio" aria-checked={form.priority_level === pv}
                          className={"prio-seg-btn " + m.tone + (form.priority_level === pv ? " active" : "")}
                          onClick={() => setF("priority_level", pv)} title={m.desc}>
                          {m.short}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <label className="fld" style={{ marginBottom: 0 }}><span className="fld-lab">Примітка</span>
                <input className="inp" value={form.note || ""} onChange={(e) => setF("note", e.target.value)} />
              </label>
              {err && <div className="ctx-hint red" style={{ fontSize: "0.78125rem", marginTop: 8 }}>⚠ {err}</div>}
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
