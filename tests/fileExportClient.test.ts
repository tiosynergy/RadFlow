/* с80 (Н-16, ревʼю M-3) — клієнтський ланцюжок експорту: POST → перевірка →
 * збереження → тост. До с80 він жив у обробнику кнопки CallListBoard і 12 із 18
 * мутантів виживали (без `return` після відмови JSON помилки зберігався як файл
 * із тостом «експортовано»). Тепер — чиста функція lib/fileExportClient.ts;
 * fetch, збереження і тост — внедрені. Стан кнопки пінить staleSliceGuard. */
import { describe, it, expect } from "vitest";
import { runFileExport, type FileExportDeps, type FileExportRequest } from "@/lib/fileExportClient";
import { callListExportErrorText, callListExportSuccessText, CALL_LIST_EXPORT_ERR } from "@/lib/callListExport";

type Call = { url: string; init: RequestInit };

function harness(respond: (c: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const saved: Array<{ blob: Blob; fileName: string }> = [];
  const toasts: Array<{ msg: string; kind: string }> = [];
  const deps: FileExportDeps = {
    fetch: async (url, init) => { const c = { url, init }; calls.push(c); return respond(c); },
    save: (blob, fileName) => { saved.push({ blob, fileName }); },
    notify: (msg, kind) => { toasts.push({ msg, kind }); },
  };
  return { deps, calls, saved, toasts };
}

const REQ: FileExportRequest = {
  url: "/api/call-list/export",
  body: { date: "2026-09-26" },
  fileName: "call-list-2026-09-26.csv",
  errorText: callListExportErrorText,
  failText: CALL_LIST_EXPORT_ERR,
  successText: (res) => callListExportSuccessText(res.headers.get("X-Export-Rows")),
  successKind: "info",
};

const csv = (rows: string) => new Response("﻿\"Дата\"", { status: 200, headers: { "X-Export-Rows": rows, "Content-Type": "text/csv" } });

describe("runFileExport — успіх", () => {
  it("POST із JSON-тілом, no-store; Blob зберігається під заданим іменем; тост успіху; true", async () => {
    const h = harness(() => csv("3"));
    const ok = await runFileExport(REQ, h.deps);
    expect(ok).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe("/api/call-list/export");
    expect(h.calls[0].init.method).toBe("POST");
    expect(h.calls[0].init.cache).toBe("no-store");
    expect((h.calls[0].init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({ date: "2026-09-26" });
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].fileName).toBe("call-list-2026-09-26.csv");
    expect(await h.saved[0].blob.text()).toContain("Дата");
    expect(h.toasts).toEqual([{ msg: "Колл-лист експортовано у CSV", kind: "info" }]);
  });

  it("порожній день — файл однаково зберігається, тост чесно каже «лише заголовок»", async () => {
    const h = harness(() => csv("0"));
    expect(await runFileExport(REQ, h.deps)).toBe(true);
    expect(h.saved).toHaveLength(1);
    expect(h.toasts[0].msg).toMatch(/лише заголовок/);
  });
});

describe("runFileExport — відмова сервера: НІЧОГО не зберігаємо", () => {
  it.each([
    [403, { error: "Спершу завершіть налаштування центру" }, "Спершу завершіть налаштування центру"],
    [400, { error: "Некоректний запит експорту" }, "Некоректний запит експорту"],
  ])("%i — тіло читається, у тості безпечна фраза роуту", async (status, body, text) => {
    const h = harness(() => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
    expect(await runFileExport(REQ, h.deps)).toBe(false);
    expect(h.saved, "JSON помилки збережено як файл").toEqual([]);
    expect(h.toasts).toEqual([{ msg: text, kind: "error" }]);
  });

  it.each([
    [401, "Сесія завершилась — увійдіть знову"],
    [429, "Забагато вивантажень за короткий час — спробуйте за кілька хвилин"],
    [500, CALL_LIST_EXPORT_ERR],
  ])("%i — тіло НЕ читається (внутрощі не показуємо), тост із загальним текстом", async (status, text) => {
    const h = harness(() => new Response(JSON.stringify({ error: "stack: секрет" }), { status }));
    expect(await runFileExport(REQ, h.deps)).toBe(false);
    expect(h.saved).toEqual([]);
    expect(h.toasts).toEqual([{ msg: text, kind: "error" }]);
    expect(h.toasts[0].msg).not.toContain("секрет");
  });

  it("403 з тілом, що не JSON, — загальна фраза, без винятку", async () => {
    const h = harness(() => new Response("<html>", { status: 403 }));
    expect(await runFileExport(REQ, h.deps)).toBe(false);
    expect(h.toasts).toEqual([{ msg: "Недостатньо прав для експорту", kind: "error" }]);
  });
});

describe("runFileExport — збої: не кидає, тост failText, нічого не збережено", () => {
  it("мережа впала на запиті", async () => {
    const h = harness(() => { throw new TypeError("Failed to fetch"); });
    await expect(runFileExport(REQ, h.deps)).resolves.toBe(false);
    expect(h.saved).toEqual([]);
    expect(h.toasts).toEqual([{ msg: CALL_LIST_EXPORT_ERR, kind: "error" }]);
  });

  it("тіло не дочитали (обрив посеред завантаження)", async () => {
    const h = harness(() => {
      const r = csv("3");
      Object.defineProperty(r, "blob", { value: async () => { throw new Error("aborted"); } });
      return r;
    });
    await expect(runFileExport(REQ, h.deps)).resolves.toBe(false);
    expect(h.saved).toEqual([]);
    expect(h.toasts).toEqual([{ msg: CALL_LIST_EXPORT_ERR, kind: "error" }]);
  });

  it("збереження кинуло — тост збою, а не «експортовано»", async () => {
    const h = harness(() => csv("3"));
    h.deps.save = () => { throw new Error("blocked"); };
    await expect(runFileExport(REQ, h.deps)).resolves.toBe(false);
    expect(h.toasts).toEqual([{ msg: CALL_LIST_EXPORT_ERR, kind: "error" }]);
  });
});
