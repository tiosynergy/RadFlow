"use client";

/* ===== RadFlow — користувацька настройка звуку =====
   Локально в браузері, versioned-ключ `rf-sound-v1`. Зберігається ЛИШЕ сама
   настройка ("on"/"off") — жодних id записів, кабінетів, клінік чи пацієнтів.
   За замовчуванням звук ВИМКНЕНО; вмикається лише явним кліком користувача
   (перемикач у сайдбарі → unlockAudio() в межах жесту).

   Синхронізація: та сама вкладка — CustomEvent, інші вкладки — подія storage. */

const KEY = "rf-sound-v1";
const EVT = "rf-sound-pref";

export function soundEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(KEY) === "on";
  } catch {
    return false; // приватний режим / вимкнений storage → звук просто вимкнено
  }
}

export function setSoundEnabled(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* немає storage — настройка не переживе перезавантаження, але сесія працює */
  }
  try {
    window.dispatchEvent(new CustomEvent(EVT));
  } catch {
    /* ignore */
  }
}

/** Підписка на зміни настройки (ця вкладка + інші вкладки). Повертає відписку. */
export function subscribeSoundPref(cb: (on: boolean) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (ev: Event) => {
    // storage-подія прилітає на БУДЬ-ЯКУ зміну localStorage — фільтруємо чужі ключі.
    if (ev.type === "storage" && (ev as StorageEvent).key && (ev as StorageEvent).key !== KEY) return;
    cb(soundEnabled());
  };
  window.addEventListener(EVT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(EVT, handler);
    window.removeEventListener("storage", handler);
  };
}
