/**
 * F-01 (аудит с45): клінічний запис не видаляють — його скасовують.
 *
 * ЧОМУ. Тригер `guard_status_change_referrer` (0079) декларує дослівно
 * «направник може лише перенести або скасувати запис» і стереже UPDATE.
 * Політика `queue_write_referrer` при цьому оголошена на ALL, а роль
 * `authenticated` мала табличний грант DELETE — тож направник міг просто
 * ВИДАЛИТИ рядок через PostgREST, обійшовши декларацію. Жива проба під його
 * JWT (у транзакції, відкочено) дала `DELETE_ROWS=1`. Те саме могли робити
 * реєстратор і адмін (`queue_write_staff` — теж ALL); дірка не була
 * «тільки про направника».
 *
 * Видалення гірше за скасування: позначки «непрочитане» на DELETE не виникає
 * (`tg_change_markers_queue` — AFTER INSERT/UPDATE), у «Журнал дій» теж нічого
 * (події емітить прикладний код), слот звільняється мовчки. Переживає це лише
 * `audit_log` — і той fail-open, з горизонтом 90 днів до знеособлення.
 *
 * Міграція 0163 знімає DELETE (і TRUNCATE) у клієнтських ролей і ставить
 * розтяжку-тригер.
 *
 * ⚠️ ЩО САМЕ СТЕРЕЖЕ ЦЕЙ ФАЙЛ — і чого він НЕ стереже.
 * Vitest тут у `environment: "node"` і до БД не ходить, тож перевірити
 * ПРИВІЛЕЙ у проді він не може: інваріант «DELETE знято» стереже
 * `supabase/smoke/no_client_hard_delete_smoke.sql`, і саме він є регресом на
 * F-01. Тут — три речі, яких не видно з БД:
 *   1) міграція не «схудла» при рефакторингу і везе відкат;
 *   2) застосунок НЕ намагається видаляти ці рядки клієнтським ключем —
 *      припущення, на якому побудований revoke;
 *   3) шлях скасування, який лишається натомість, покриває `needs_reschedule`
 *      — інакше в направника не лишилось би жодного важеля.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { resolve, join } from "path";

const root = process.cwd();
const MIGRATION = "supabase/migrations/0163_no_client_hard_delete.sql";
const SMOKE = "supabase/smoke/no_client_hard_delete_smoke.sql";

const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

describe("міграція 0163", () => {
  const sql = read(MIGRATION);

  it("знімає DELETE в обох клієнтських ролей на обох таблицях", () => {
    expect(sql).toMatch(/revoke\s+delete\s+on\s+public\.queue_entries\s+from\s+anon,\s*authenticated/i);
    expect(sql).toMatch(/revoke\s+delete\s+on\s+public\.waitlist_entries\s+from\s+anon,\s*authenticated/i);
  });

  it("знімає і TRUNCATE — RLS на нього не діє, тригер не спрацьовує", () => {
    expect(sql).toMatch(/revoke\s+truncate\s+on\s+public\.queue_entries\s+from\s+anon,\s*authenticated/i);
    expect(sql).toMatch(/revoke\s+truncate\s+on\s+public\.waitlist_entries\s+from\s+anon,\s*authenticated/i);
  });

  it("ставить розтяжку-тригер на обидві таблиці", () => {
    expect(sql).toMatch(/create\s+trigger\s+a01_no_client_delete\s+before\s+delete\s+on\s+public\.queue_entries/i);
    expect(sql).toMatch(/create\s+trigger\s+a01_no_client_delete\s+before\s+delete\s+on\s+public\.waitlist_entries/i);
  });

  it("тригерна функція лишається SECURITY INVOKER — інакше current_user безглуздий", () => {
    // У DEFINER current_user = власник (`postgres`), умова стала б завжди
    // ХИБНОЮ, і розтяжка мовчки перетворилась би на пустушку (fail-open).
    const fn = sql.slice(sql.indexOf("create or replace function public.guard_no_client_delete"),
                         sql.indexOf("comment on function"));
    expect(fn.length, "тіло функції не знайдено — тест застарів").toBeGreaterThan(0);
    expect(fn).not.toMatch(/security\s+definer/i);
    expect(fn).toMatch(/current_user\s+in\s*\(\s*'anon'\s*,\s*'authenticated'\s*\)/i);
  });

  it("НЕ чіпає службову роль — на ній тримаються інтеграції і скрипти", () => {
    expect(sql).not.toMatch(/revoke[^;]*from[^;]*service_role/i);
  });

  it("має секцію відкату в КІНЦІ файлу і повертає рівно те, що зняла", () => {
    const at = sql.indexOf("=== ВІДКАТ ===");
    expect(at, "секції відкату немає").toBeGreaterThan(-1);
    const tail = sql.slice(at);
    for (const t of ["queue_entries", "waitlist_entries"]) {
      expect(tail, `відкат не повертає delete на ${t}`).toMatch(new RegExp(`grant\\s+delete\\s+on\\s+public\\.${t}`, "i"));
      expect(tail, `відкат не повертає truncate на ${t}`).toMatch(new RegExp(`grant\\s+truncate\\s+on\\s+public\\.${t}`, "i"));
    }
    expect(tail).toMatch(/drop\s+trigger\s+if\s+exists\s+a01_no_client_delete/i);
    expect(tail).toMatch(/delete\s+from\s+public\.migration_ledger/i);
  });

  it("самореєструється в леджері під власним іменем файлу", () => {
    expect(sql).toMatch(/values \('0163_no_client_hard_delete\.sql'\)/);
  });
});

describe("смоук 0163 — саме він є регресом на F-01", () => {
  const sql = read(SMOKE);

  it("зона (d) спершу доводить ПЕРЕДУМОВУ експлойта, а вже потім вимагає відмови", () => {
    // Без цього 42501 приходив би від перевірки привілею на будь-якому рядку,
    // і зона (d) була б лише переказом зони (b).
    expect(sql).toMatch(/auth_referrer_can_book_room\(v_room\)/);
    expect(sql).toMatch(/v_seen\s*<>\s*1\s*or\s*not\s+coalesce\(v_book, false\)/);
  });

  it("перевіряє і привілей, і розтяжку, і живий власницький шлях", () => {
    expect(sql).toMatch(/has_table_privilege\('authenticated', 'public\.queue_entries',\s*'DELETE'\)/);
    expect(sql).toMatch(/has_table_privilege\('authenticated', 'public\.queue_entries',\s*'TRUNCATE'\)/);
    expect(sql).toMatch(/has_table_privilege\('service_role'/);
    expect(sql).toMatch(/grant delete on public\.queue_entries to authenticated/);
    expect(sql).toMatch(/grant delete on public\.waitlist_entries to authenticated/);
    expect(sql).toMatch(/SMOKE_OK/);
  });

  it("фікстура не тягне лок patient_cases", () => {
    expect(sql).toMatch(/case_id is null/);
  });

  it("асерти на sqlstate — через is distinct from (NULL значущий)", () => {
    expect(sql).toMatch(/v_err is distinct from '42501'/);
  });
});

/* Регрес на дефект, який 0163 міг би створити: забравши прямий DELETE, ми
   зобовʼязані лишити робочий важіль. Для `needs_reschedule` його не було. */
describe("скасування покриває запис без слота", () => {
  it("CANCELLABLE_STATUSES містить needs_reschedule і не дорівнює LIVE_STATUSES", () => {
    const src = read("app/queue/actions.ts");
    const m = src.match(/const CANCELLABLE_STATUSES: readonly QueueStatus\[\] =\s*([\s\S]{0,160}?);/);
    expect(m, "константи CANCELLABLE_STATUSES немає — сторож застарів").not.toBeNull();
    expect(m![1]).toContain("needs_reschedule");
    expect(src).toMatch(/cancelQueueEntry[\s\S]{0,600}?allowed: CANCELLABLE_STATUSES/);
    // Завершення і виклик мусять лишитись на вужчому списку: `needs_reschedule`
    // не можна ні завершити, ні викликати в кабінет — слота в нього немає.
    const live = src.match(/const LIVE_STATUSES: readonly QueueStatus\[\] =\s*([\s\S]{0,160}?);/);
    expect(live, "константи LIVE_STATUSES немає — сторож застарів").not.toBeNull();
    expect(live![1]).not.toContain("needs_reschedule");
  });

  it("у направника кнопка «Скасувати» доступна для needs_reschedule", () => {
    const src = read("components/ReferrerBoard.tsx");
    const m = src.match(/const canCancel =[\s\S]{0,200}?;/);
    expect(m, "canCancel не знайдено — сторож застарів").not.toBeNull();
    expect(m![0]).toContain("needs_reschedule");
  });

  /* Дефект, який породила САМА ця правка (знайшло ревʼю р2): відкривши
     скасування, ми оживили soft-undo на стані, куди повернутись неможливо —
     `zQueueStatus` не приймає `needs_reschedule`, а RPC кидає на нього 42501.
     Оператор бачив би «Помилка: Некоректні дані запиту» після успішного
     скасування. */
  it("QueueBoard не пропонує «Відмінити» для needs_reschedule", () => {
    const src = read("components/QueueBoard.tsx");
    const at = src.indexOf("async function cancelUndo");
    expect(at, "cancelUndo не знайдено — сторож застарів").toBeGreaterThan(-1);
    const fn = src.slice(at, src.indexOf("async function setCall", at));
    expect(fn).toMatch(/if \(prev === "needs_reschedule"\)/);
    // Гілка з дією мусить стояти ПІСЛЯ раннього виходу.
    expect(fn.indexOf('prev === "needs_reschedule"')).toBeLessThan(fn.indexOf("↩ Відмінити"));
  });

  it("zQueueStatus і далі не приймає needs_reschedule — на цьому тримається гілка вище", () => {
    const src = read("lib/validation.ts");
    const m = src.match(/export const zQueueStatus = z\.enum\(\[([\s\S]{0,200}?)\]\)/);
    expect(m, "zQueueStatus не знайдено — сторож застарів").not.toBeNull();
    expect(m![1]).not.toContain("needs_reschedule");
  });
});

/* Сторож припущення, на якому побудований revoke: застосунок цих рядків не
   видаляє. `scripts/` не скануємо свідомо — seed-test-data.mjs і
   race-check.mjs ходять СЛУЖБОВОЮ роллю, якої revoke не торкнувся.

   ⚠️ Межа методу: сторож лексичний. Він бачить `.from("<таблиця>")…delete()`
   і НЕ побачить імені таблиці у змінній, обгортки-хелпера чи голого fetch на
   `/rest/v1/queue_entries` з `method: "DELETE"`. Це прийнятно як другий
   рубіж — першим є смоук, який питає саму БД. */
describe("застосунок не видаляє клінічні рядки клієнтським ключем", () => {
  const DIRS = ["app", "components", "lib"];
  const CLINICAL = ["queue_entries", "waitlist_entries"];

  function walk(dir: string, out: string[] = []): string[] {
    let names: string[];
    try { names = readdirSync(dir); } catch { return out; }
    for (const n of names) {
      const p = join(dir, n);
      let isDir: boolean;
      try { isDir = statSync(p).isDirectory(); } catch { continue; }  // битий симлінк не валить набір
      if (isDir) walk(p, out);
      else if (/\.tsx?$/.test(n)) out.push(p);
    }
    return out;
  }

  /** Таблиця НАЙБЛИЖЧОГО зліва `.from("…")` для кожного `.delete(`.
      Так ловиться довгий ланцюг із коментарями і не буває хибного спрацювання
      від сусіднього `.from("інша_таблиця")` неподалік. */
  function deletedTables(src: string): string[] {
    const out: string[] = [];
    const re = /\.delete\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const before = src.slice(0, m.index);
      const at = before.lastIndexOf(".from(");
      if (at < 0) continue;
      const t = before.slice(at).match(/^\.from\(\s*["'`]([A-Za-z0-9_]+)["'`]\s*\)/);
      if (t) out.push(t[1]);
    }
    return out;
  }

  const files = DIRS.flatMap((d) => walk(resolve(root, d)));

  it("знайшов що сканувати (інакше сторож — пустушка)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("метод не сліпий: у репозиторії видно ІНШІ .delete() — сторож не завжди порожній", () => {
    const all = files.flatMap((f) => deletedTables(readFileSync(f, "utf8")));
    expect(all.length, "жодного .delete() не знайдено — регексп зламався").toBeGreaterThan(0);
  });

  it.each(CLINICAL)("жодного .delete() по %s", (table) => {
    const hits = files.filter((f) => deletedTables(readFileSync(f, "utf8")).includes(table));
    expect(hits.map((f) => f.replace(root, "")),
      `після 0163 клієнтський DELETE по ${table} падає 42501 — перепишіть на скасування статусом`).toEqual([]);
  });
});
