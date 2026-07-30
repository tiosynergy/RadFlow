"use client";

/* ===== RadFlow — перемикач звукових сповіщень =====
   Один переиспользуемый пункт сайдбара для ролей, що отримують звукові події:
   admin/registrar (Sidebar), radiologist (RadSidebar), referrer (ReferrerSidebar).
   CEO перемикач не бачить (звуків у нього немає).

   Правила:
     • за замовчуванням вимкнено; вмикається ЛИШЕ явним кліком (жест розблоковує
       AudioContext — інакше браузер не дасть звук взагалі);
     • при вмиканні — короткий preview, щоб користувач знав, як воно звучить;
     • якщо браузер заблокував аудіо, стан «увімкнено» НЕ показуємо — підказка
       «натисніть ще раз» (наступний клік — теж жест, зазвичай розблоковує);
     • стан передається текстом і глифом, не лише кольором (UI-інваріант);
     • візуальні статуси дошки лишаються основним джерелом інформації. */

import { useEffect, useState } from "react";
import { playPatientReady, unlockAudio } from "@/lib/soundEngine";
import { setSoundEnabled, soundEnabled, subscribeSoundPref } from "@/lib/soundPrefs";

export default function SoundToggle() {
  // Початково false і на сервері, і на клієнті (гідрація без розбіжностей);
  // ефект одразу підтягує збережену настройку.
  const [on, setOn] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    setOn(soundEnabled());
    return subscribeSoundPref(setOn);
  }, []);

  async function toggle() {
    if (on) {
      setSoundEnabled(false);
      setHint(null);
      return;
    }
    const ok = await unlockAudio(); // у межах жесту користувача
    if (!ok) {
      setHint("Браузер заблокував звук — натисніть ще раз");
      return;
    }
    setSoundEnabled(true);
    setHint(null);
    playPatientReady(); // короткий preview
  }

  return (
    <>
      <button
        type="button"
        className="sb-item"
        aria-pressed={on}
        onClick={toggle}
        style={{ width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer" }}
        title={on ? "Звукові сповіщення увімкнено" : "Звукові сповіщення вимкнено"}
      >
        <span className="ic" aria-hidden>{on ? "🔔" : "🔕"}</span>
        <span className="sb-item-lab">{on ? "Вимкнути звукові сповіщення" : "Увімкнути звукові сповіщення"}</span>
      </button>
      {hint && (
        <div role="status" style={{ fontSize: "0.71875rem", color: "var(--text-muted)", padding: "0 10px 4px" }}>
          {hint}
        </div>
      )}
    </>
  );
}
