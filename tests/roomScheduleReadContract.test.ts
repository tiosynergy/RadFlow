/* U-13 — КОНТРАКТ читання рядка кабінету, на якому стоїть уся правка.
 *
 * Питання, від відповіді на яке залежить, існує дефект чи ні: що приходить у
 * компонент, коли рядок `rooms` НЕ читається (кабінет невидимий за RLS 0139 або
 * видалений) — помилка чи тиха порожнеча?
 *
 * ⚠️ Чому це тест, а не замір у браузері. Спроба поміряти живцем (підміна
 * відповіді через window.fetch) дала ХИБНИЙ результат: клієнт `supabase-js`
 * захоплює `fetch` у момент створення, тож друга й третя версії перехоплювача
 * ніколи не виконались, і я дивився на наслідки ПЕРШОЇ — тіла `[]`, яке дає
 * помилку РОЗБОРУ, а не «0 рядків». Портал тоді чесно показав банер, і замір
 * сказав би «дефекту немає». Той самий клас, що зіпсований замір у U-33:
 * інструмент лишив свій слід у вимірюваному.
 *
 * Тут працює СПРАВЖНІЙ клієнт із підставленим транспортом: жодного двійника
 * PostgREST — рівно та бібліотека, що поїде в прод.
 */
import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";

/* ⚠️ Тут була заготовка `zeroRows()` — відповідь 406/PGRST116. Прибрана НЕ
   тому, що eslint поскаржився на невикористану змінну, а тому, що вона хибна:
   такої відповіді цей клієнт не отримує (заголовка `vnd.pgrst.object+json` він
   не шле — див. знімок нижче), і саме на ній перша версія тесту «довела»
   протилежне тому, що відбувається насправді. */

/** Рядок є і в ньому є графік — контрольний випадок. */
const oneRow = () =>
  new Response(JSON.stringify({ schedule: { start: "08:00", end: "22:00", days: [1, 1, 1, 1, 1, 1, 1] } }),
    { status: 200, headers: { "Content-Type": "application/json" } });

const clientWith = (fetchImpl: typeof fetch) =>
  createClient("https://example.supabase.co", "anon-key-for-tests-only", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchImpl },
  });

describe("U-13: контракт читання rooms.schedule", () => {
  /* ⚠️ Спершу ЗАМІРЯЄМО, що клієнт узагалі просить: перша версія цього тесту
     годувала йому 406/PGRST116 — відповідь, яку PostgREST дає лише на
     `Accept: application/vnd.pgrst.object+json`. Якщо `maybeSingle()` цього
     заголовка не шле, то й такої відповіді в житті не буде, а тест міряв би
     вигаданий стан. Спочатку факт, потім твердження. */
  it("maybeSingle() просить саме те, на що ми потім відповідаємо", async () => {
    let accept: string | null = null;
    let calls = 0;
    const sb = clientWith((async (_u: string, init?: RequestInit) => {
      calls++;
      const h = new Headers(init?.headers);
      accept = h.get("Accept");
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch);
    await sb.from("rooms").select("schedule").eq("id", "any").maybeSingle();
    /* ⚠️ Лічильник — не формальність (ревʼю сторожів, MINOR 10): знімок `null`
       НЕ відрізняє «заголовка немає» від «підставлений fetch узагалі не
       викликали». Без цієї перевірки тест був би тим самим зіпсованим заміром,
       від якого застерігає шапка файла. */
    expect(calls, "підставлений fetch не викликався — знімок нижче ні про що").toBe(1);
    expect(accept, "заголовок Accept для maybeSingle() змінився").toMatchInlineSnapshot(`null`);
  });

  /* Заголовка `vnd.pgrst.object+json` цей клієнт НЕ шле (знімок вище — null),
     отже PostgREST на 0 рядків віддає звичайний порожній МАСИВ зі статусом 200,
     а не 406/PGRST116. Саме цю відповідь і треба годувати. */
  it("0 рядків (RLS сховала кабінет) → data:null І error:null — тиша, а не помилка", async () => {
    const sb = clientWith((async () =>
      new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch);
    const res = await sb.from("rooms").select("schedule").eq("id", "any").maybeSingle();
    /* Саме тому перевірки `if (res.error) throw` НЕ ДОСИТЬ: помилки немає.
       Якщо колись supabase-js почне віддавати тут error — цей тест почервоніє,
       і правку можна буде спростити. Поки червоніє протилежне. */
    expect(res.error, "0 рядків більше не тиха — премис U-13 змінився").toBeNull();
    expect(res.data, "0 рядків мали б давати null").toBeNull();
  });

  it("рядок є → графік доїжджає цілим (контроль, щоб тест не був тавтологією)", async () => {
    const sb = clientWith((async () => oneRow()) as unknown as typeof fetch);
    const res = await sb.from("rooms").select("schedule").eq("id", "any").maybeSingle();
    expect(res.error).toBeNull();
    expect((res.data as { schedule?: { end?: string } } | null)?.schedule?.end).toBe("22:00");
  });
});
