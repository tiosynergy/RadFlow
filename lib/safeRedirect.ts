/* ===== RadFlow — шлях повернення після входу (с84, ревʼю лінза C M-2 + р2 H-1) =====

   `/login?redirect=…` — відкритий параметр: посилання на /login з ним може
   прислати будь-хто. До с84 його стеріг вираз `^\/(?![/\\])` («один слеш, далі
   не слеш і не бекслеш»), і цього мало: WHATWG-парсер URL ВИРІЗАЄ табуляцію і
   переводи рядка (\t \n \r) ПЕРЕД розбором, тож `/\t//evil.com` проходив вираз і
   ставав `///evil.com` → https://evil.com/ (а `router.push` іде на чужий origin
   через location.assign). Фішинг: справжня сторінка входу, справжній пароль, а
   після входу — клон «сесія закінчилась, введіть ще раз» на чужому домені.

   ⚠️ Друга пастка — НОРМАЛІЗАЦІЯ (ревʼю с84 р2, H-1). Перша редакція цього файлу
   перевіряла вхід, а назовні віддавала `u.pathname`, де dot-сегменти вже згорнуті:
   `/..//evil.com`, `/.//evil.com`, `/%2e//evil.com`, `/queue/..//evil.com` давали
   `//evil.com` — протокол-відносний шлях на чужий хост. Сирий рядок браузер лишав
   на своєму origin, тож «виправлення» саме відкрило дірку. Тому перевіряється
   ВИХІД, а не лише вхід: те, що повертається, мусить починатися рівно з одного
   `/` і розвʼязуватись у свій origin — і це остання дія перед поверненням.

   Правило:
     • жодних керуючих символів, пробілів і бекслешів (у спецсхемах `\` = `/`);
     • вхід починається з одного `/` (не `//`);
     • `new URL(raw, <фіктивний свій origin>)` лишається на ТОМУ Ж origin;
     • вихід (нормалізований pathname + search + hash) НЕ починається з `//` і сам
       розвʼязується у свій origin.
   Чиста функція без імпортів: читається і в браузері (LoginPage), і під vitest. */

const BASE = "https://radflow.invalid";

function sameOrigin(path: string): boolean {
  try {
    return new URL(path, BASE).origin === BASE;
  } catch {
    return false;
  }
}

export function safeRedirectPath(raw: string | null | undefined, fallback = "/queue"): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return fallback;
  /* \s у JS — і ASCII-пробіли, і юнікодні (NBSP, U+2028…); плюс C0/DEL і бекслеш. */
  if (/[\u0000-\u001f\u007f\\]|\s/.test(raw)) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  if (!sameOrigin(raw)) return fallback;
  const u = new URL(raw, BASE);
  const out = u.pathname + u.search + u.hash;
  /* Перевірка ВИХОДУ: після згортання dot-сегментів шлях міг стати `//host`. */
  if (!out.startsWith("/") || out.startsWith("//") || !sameOrigin(out)) return fallback;
  return out;
}
