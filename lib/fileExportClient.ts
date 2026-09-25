/* ===== Клієнтський крок «сервер зібрав файл → браузер зберігає» (с80, Н-16) =====

   Сервер (роут експорту) рахує область, читає рядки під RLS, екранує формули і
   пише подію в журнал; браузеру лишається один ланцюжок: POST → перевірити
   відповідь → зберегти Blob → сказати людині, що сталось. До с80 цей ланцюжок
   жив прямо в обробнику кнопки, і ревʼю с80 (M-3) показало ціну: 12 із 18
   мутантів клієнта колл-листа виживали — без `finally` кнопка лишалась мертвою
   до перезавантаження, без `return` після відмови JSON помилки зберігався як
   `call-list-….csv` із тостом «експортовано».

   Тепер ланцюжок — ЧИСТА функція із внедреними fetch / збереженням / тостом, і
   її перевіряє tests/fileExportClient.test.ts у node. Компонент тримає лише
   свій стан (`exporting`, гейт `loading`) — це пінить tests/staleSliceGuard.

   ⚠️ Функція НЕ кидає: будь-який збій (мережа, читання тіла, збереження) —
   тост `failText` і `false`. Обробник кнопки однаково ставить `finally`
   (стан кнопки — справа компонента), але «не кидає» — контракт, на який він
   має право покладатися. */

export type NotifyKind = "success" | "error" | "info";

export type FileExportDeps = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  save: (blob: Blob, fileName: string) => void;
  notify: (msg: string, kind: NotifyKind) => void;
};

export type FileExportRequest = {
  url: string;
  /** Тіло POST — серіалізується в JSON. */
  body: unknown;
  fileName: string;
  /** Текст відмови за статусом; тіло відповіді читається ЛИШЕ для 400/403 —
      там безпечна фраза самого роуту, решта статусів тіла не показує. */
  errorText: (status: number, body: unknown) => string;
  /** Загальна фраза збою мережі / читання / збереження. */
  failText: string;
  /** Текст успіху — може читати заголовки відповіді (напр. кількість рядків). */
  successText: (res: Response) => string;
  successKind?: NotifyKind;
};

/** Один експорт. `true` — файл віддано на збереження; ніколи не кидає. */
export async function runFileExport(req: FileExportRequest, deps: FileExportDeps): Promise<boolean> {
  try {
    const res = await deps.fetch(req.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
      cache: "no-store",
    });
    if (!res.ok) {
      const body = res.status === 403 || res.status === 400 ? await res.json().catch(() => null) : null;
      deps.notify(req.errorText(res.status, body), "error");
      return false;
    }
    const blob = await res.blob();
    deps.save(blob, req.fileName);
    deps.notify(req.successText(res), req.successKind ?? "success");
    return true;
  } catch {
    deps.notify(req.failText, "error");
    return false;
  }
}

/** Браузерне збереження Blob як файлу: тимчасове посилання з `download`.
    URL відкликається одразу після `click()` — завантаження вже стартувало
    (так само робили й клієнти до с80). */
export function saveBlobAsFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
