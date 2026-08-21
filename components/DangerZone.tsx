"use client";

import { useState } from "react";

/* ===== Небезпечна зона: повне видалення медичного центру =====

   Компонент навмисно самодостатній: один POST на /api/clinic/delete-request,
   жодних записів у БД з клієнта. Всі перевірки (роль, збіг назви, пошта)
   продубльовані на сервері — клієнтські лише прибирають зайвий раунд-тріп.

   Видалення ДВОФАЗНЕ: тут лише запит + лист. Виконує /delete-confirm за
   посиланням із листа. Тому кнопка чесно називається «Надіслати лист», а не
   «Видалити»: до переходу за посиланням нічого не відбувається. */

export default function DangerZone({ clinicName }: { clinicName: string }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const nameMatches = typed.trim() === clinicName;

  function close() {
    if (busy) return;
    setOpen(false);
    setTyped("");
    setErr(null);
  }

  async function submit() {
    if (!nameMatches || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/clinic/delete-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clinicNameConfirmation: typed }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; message?: string; error?: string }
        | null;
      if (!res.ok) {
        setErr(body?.error ?? "Не вдалося створити запит. Спробуйте пізніше.");
        return;
      }
      setDone(body?.message ?? "Лист підтвердження надіслано.");
      setOpen(false);
      setTyped("");
    } catch {
      setErr("Мережева помилка. Спробуйте ще раз.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      style={{
        marginTop: 32,
        border: "1px solid var(--danger, #c0392b)",
        borderRadius: 8,
        padding: 16,
      }}
    >
      <h2 style={{ color: "var(--danger, #c0392b)", fontSize: "1.05rem", marginBottom: 8 }}>
        Небезпечна зона
      </h2>
      <p style={{ color: "var(--text-muted)", lineHeight: 1.5, marginBottom: 12 }}>
        Повне видалення медичного центру. Безповоротно зникнуть: уся черга
        пацієнтів, лист очікування, кабінети та їхні графіки, каталог послуг,
        ключі інтеграцій і всі працівники разом з обліковими записами —
        включно з вашим обліковим записом адміністратора.
      </p>
      {done ? (
        <p style={{ color: "var(--text)", lineHeight: 1.5 }}>{done}</p>
      ) : (
        <button className="btn" style={{ borderColor: "var(--danger, #c0392b)", color: "var(--danger, #c0392b)" }} onClick={() => setOpen(true)}>
          Видалити медичний центр…
        </button>
      )}

      {open && (
        <div className="overlay" onClick={close}>
          <div className="dialog fade-in" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div className="dlg-head">
              <div className="dlg-title">Видалити «{clinicName}»?</div>
              <button className="icon-btn" aria-label="Закрити" onClick={close} disabled={busy}>✕</button>
            </div>
            <div className="dlg-body">
              <p style={{ marginBottom: 10, lineHeight: 1.5 }}>
                Це <b>безповоротно</b>. Буде видалено всі дані центру і черга
                пацієнтів; обліковий запис адміністратора буде видалено також.
              </p>
              <p style={{ marginBottom: 10, lineHeight: 1.5 }}>
                Після підтвердження на вашу пошту прийде лист — видалення
                відбудеться лише після переходу за посиланням із нього
                (посилання діє 60 хвилин).
              </p>
              <label style={{ display: "block", marginBottom: 6 }}>
                Наберіть назву центру точно як у налаштуваннях:
              </label>
              <input
                className="input"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={clinicName}
                disabled={busy}
                autoFocus
              />
              {err && <p style={{ color: "var(--danger, #c0392b)", marginTop: 8 }}>{err}</p>}
            </div>
            <div className="dlg-foot" style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="btn btn-ghost" onClick={close} disabled={busy}>Скасувати</button>
              <button
                className="btn"
                style={{ background: "var(--danger, #c0392b)", color: "#fff" }}
                onClick={submit}
                disabled={!nameMatches || busy}
                title={!nameMatches ? "Назва не збігається" : undefined}
              >
                {busy ? "Надсилаємо лист…" : "Надіслати лист підтвердження"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
