/* Тести чистої логіки деплой-гейта міграцій (RF-05, пакет 0142).
   planGate/readDiskMigrations живуть у scripts/migration-gate-lib.mjs і БД
   не чіпають; CLI-обгортка (migration-gate.mjs) сюди не імпортується —
   вона безумовно виконує main(). */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { planGate, planGuardPin, pinFor, guardBodyOf, readDiskMigrations } from "../scripts/migration-gate-lib.mjs";

type Row = { name: string; md5: string | null };

const d = (name: string, md5 = "aa"): Row => ({ name, md5 });

describe("planGate", () => {
  it("усе збігається → ok, без failures і stamps", () => {
    const r = planGate([d("0001_a.sql"), d("0002_b.sql", "bb")],
                       [d("0001_a.sql"), d("0002_b.sql", "bb")]);
    expect(r.failures).toEqual([]);
    expect(r.stamps).toEqual([]);
    expect(r.ok).toEqual(["0001_a.sql", "0002_b.sql"]);
  });

  it("файл на диску без запису в леджері → НЕ НАКАТАНО", () => {
    const r = planGate([d("0001_a.sql"), d("0143_new.sql")], [d("0001_a.sql")]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("НЕ НАКАТАНО");
    expect(r.failures[0]).toContain("0143_new.sql");
  });

  it("запис у леджері без файла → НЕМАЄ ФАЙЛА (перейменування/втрата)", () => {
    const r = planGate([d("0001_a.sql")], [d("0001_a.sql"), d("0002_gone.sql")]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("НЕМАЄ ФАЙЛА");
    expect(r.failures[0]).toContain("0002_gone.sql");
  });

  it("md5 null у леджері → у stamps, не у failures (перший прогін)", () => {
    const r = planGate([d("0001_a.sql", "real")], [{ name: "0001_a.sql", md5: null }]);
    expect(r.failures).toEqual([]);
    expect(r.stamps).toEqual([{ name: "0001_a.sql", md5: "real" }]);
  });

  it("md5 розійшовся → файл правили після накату", () => {
    const r = planGate([d("0001_a.sql", "disk")], [d("0001_a.sql", "ledger")]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("MD5 РОЗІЙШОВСЯ");
  });

  it("перейменування = одночасно НЕ НАКАТАНО + НЕМАЄ ФАЙЛА (обидві сторони видно)", () => {
    const r = planGate([d("0002_renamed.sql")], [d("0002_old_name.sql")]);
    expect(r.failures).toHaveLength(2);
    expect(r.failures.join("\n")).toContain("НЕ НАКАТАНО");
    expect(r.failures.join("\n")).toContain("НЕМАЄ ФАЙЛА");
  });

  it("порожній леджер + непорожній диск → усе НЕ НАКАТАНО (не вакуумний тест)", () => {
    const r = planGate([d("0001_a.sql"), d("0002_b.sql")], []);
    expect(r.failures).toHaveLength(2);
  });

  it("порожні диск і леджер → чисто (0 усього)", () => {
    const r = planGate([], []);
    expect(r.failures).toEqual([]);
    expect(r.ok).toEqual([]);
  });

  it("імʼя поза каноном → failure (файл не випадає з-під гейта мовчки)", () => {
    const r = planGate([d("0001_a.sql")], [d("0001_a.sql")], ["143_typo.sql"]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("ІМʼЯ ПОЗА КАНОНОМ");
    expect(r.failures[0]).toContain("143_typo.sql");
  });
});

describe("readDiskMigrations (герметична фікстура)", () => {
  it("бачить NNNN_*.sql з md5; PRECHECK і не-.sql ігнорує; криві імена → badNames", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rf-gate-"));
    try {
      writeFileSync(path.join(dir, "0001_init.sql"), "select 1;");
      writeFileSync(path.join(dir, "0002_b.sql"), "select 2;");
      writeFileSync(path.join(dir, "0064_PRECHECK.sql"), "-- не міграція");
      writeFileSync(path.join(dir, "ROLLBACK.md"), "# not sql");
      writeFileSync(path.join(dir, "143_typo.sql"), "select 3;");
      writeFileSync(path.join(dir, "0003nounderscore.sql"), "select 4;");
      const { files, badNames } = readDiskMigrations(dir);
      expect(files.map((f) => f.name)).toEqual(["0001_init.sql", "0002_b.sql"]);
      for (const f of files) expect(f.md5).toMatch(/^[0-9a-f]{32}$/);
      expect(badNames).toEqual(["0003nounderscore.sql", "143_typo.sql"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("реальна тека проєкту: 0001 на місці, 0142 у списку, PRECHECK-ів немає, кривих імен нуль", () => {
    const dir = path.join(__dirname, "..", "supabase", "migrations");
    const { files, badNames } = readDiskMigrations(dir);
    const names = files.map((f) => f.name);
    expect(names[0]).toBe("0001_init.sql");
    expect(names).toContain("0142_migration_ledger.sql");
    expect(names.some((n) => n.includes("PRECHECK"))).toBe(false);
    expect(badNames).toEqual([]);
  });
});


/* ПІН ТІЛА СТОРОЖА (пакет 0198, М-4 / Н-1).

   ⚠️ Фікстури, а не живе дерево — і це замір, а не смак. Перша редакція
      правила жила в `tests/invariantsCheckedPins.test.ts` і читала справжню
      найсвіжішу міграцію. Повна ревізія показала ціну: `falsify-0180` і
      `falsify-0181` почервоніли на своїх ПОЗИТИВНИХ контролях («переставлено
      два рядки», «переписано коментар»), бо сума по ВСЬОМУ тілу стріляє на
      будь-якій косметиці. Тут правило міряється на СИНТЕТИЧНИХ текстах, тож
      мутації стендів у справжніх файлах його не чіпають, а саме правило
      лишається під тестом. */
describe("planGuardPin — пін сторожа рахується з тіла в тому ж файлі", () => {
  /** Мінімальний передрук: заголовок, межі тіла, саме тіло. */
  const reprint = (body: string) =>
    "-- шапка\ncreate or replace function public.invariants_check(p_write boolean)\n" +
    "returns jsonb\nas $function$\n" + body + "\n$function$;\n";
  const BODY = "declare\n  v_n int := 0;\nbegin\n  return null;\nend;";
  const withPin = (text: string, pin: string) =>
    text + `\ncomment on function public.invariants_check(boolean) is '${pin}';\n`;
  /** Тіло так, як його бачить бібліотека. */
  const bodyOf = (text: string) => guardBodyOf(text) as string;
  /** Готовий коректний передрук із піном. */
  const good = (body: string) => {
    const t = reprint(body);
    return withPin(t, pinFor(bodyOf(t)));
  };

  it("пін порахований із тіла → розбіжностей немає", () => {
    expect(planGuardPin([{ name: "0198_x.sql", text: good(BODY) }])).toEqual([]);
  });

  it("тіло правили, пін лишили старим → ПІН РОЗІЙШОВСЯ З ТІЛОМ", () => {
    const stale = pinFor(bodyOf(reprint(BODY)));
    const changed = withPin(reprint(BODY + "\n-- зайвий коментар"), stale);
    const f = planGuardPin([{ name: "0199_y.sql", text: changed }]);
    expect(f).toHaveLength(1);
    expect(f[0]).toContain("ПІН РОЗІЙШОВСЯ З ТІЛОМ");
    expect(f[0]).toContain("0199_y.sql");
  });

  it("передрук БЕЗ піна → ПЕРЕДРУК БЕЗ ПІНА, і названо очікуваний пін", () => {
    const text = reprint(BODY);
    const f = planGuardPin([{ name: "0199_y.sql", text }]);
    expect(f).toHaveLength(1);
    expect(f[0]).toContain("ПЕРЕДРУК БЕЗ ПІНА");
    expect(f[0]).toContain(pinFor(bodyOf(text)));
  });

  it("пін у файлі, що сторожа не передруковує → ПІН БЕЗ ТІЛА", () => {
    const orphanPin =
      "-- лише напис, тіла тут немає\n" +
      "comment on function public.invariants_check(boolean) is " +
      "'guard_body_md5=00000000000000000000000000000000;len=1';\n";
    const f = planGuardPin([
      { name: "0198_x.sql", text: good(BODY) },
      { name: "0199_only_pin.sql", text: orphanPin },
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]).toContain("ПІН БЕЗ ТІЛА");
  });

  /* ⚠️ РЕГРЕСІЯ, знайдена прогоном гейта на живому дереві (с72). Перша
     редакція вимагала, щоб `as $function$` був у файлі ОДИН, — і 0159, 0179,
     0184, 0187 стали «нечитаними»: вони передруковують сторожа І оголошують
     інші функції. Гейт червонів би на ЧИСТОМУ дереві, тобто зупиняв би кожну
     збірку. Межі беруться від ЗАГОЛОВКА передруку. */
  it("у файлі є ще одна функція (форма 0159/0179/0184/0187) — це нормально", () => {
    const other =
      "create or replace function public.helper()\nreturns int\nas $function$\n" +
      "begin return 1; end;\n$function$;\n";
    const t = other + reprint(BODY);
    expect(bodyOf(t)).toBe(bodyOf(reprint(BODY)));
    expect(planGuardPin([{ name: "0159_hist.sql", text: withPin(t, pinFor(bodyOf(t))) }]))
      .toEqual([]);
  });

  it("чужа функція ПІСЛЯ сторожа не з'їдає межі тіла", () => {
    const other =
      "\ncreate or replace function public.helper()\nreturns int\nas $function$\n" +
      "begin return 1; end;\n$function$;\n";
    const t = reprint(BODY) + other;
    expect(bodyOf(t)).toBe(bodyOf(reprint(BODY)));
  });

  /* ⚠️ Два передруки в одному файлі — і md5 порахувався б із ПЕРШОГО, а в прод
     ліг би другий. Мовчки. */
  it("два заголовки передруку в одному файлі → ТІЛО СТОРОЖА НЕЧИТАНЕ", () => {
    const two = reprint(BODY) + reprint(BODY + "\n-- друге");
    const f = planGuardPin([{ name: "0199_two.sql", text: withPin(two, "guard_body_md5=00000000000000000000000000000000;len=1") }]);
    expect(f).toHaveLength(1);
    expect(f[0]).toContain("ТІЛО СТОРОЖА НЕЧИТАНЕ");
    expect(f[0]).toContain("заголовків передруку 2");
  });

  /* ⚠️ Питаємо пін лише з НАЙСВІЖІШОГО передруку: 0154–0197 писались до
     правила, і ретроспективна вимога зробила б гейт червоним на історії,
     якої вже не переписати (міграції append-only). */
  it("старіші передруки без піна не винні — питаємо з останнього", () => {
    expect(planGuardPin([
      { name: "0190_old.sql", text: reprint(BODY) },
      { name: "0198_fresh.sql", text: good(BODY + "\n-- новіше") },
    ])).toEqual([]);
  });

  it("порядок на вході не важить — «останній» береться за іменем", () => {
    expect(planGuardPin([
      { name: "0198_fresh.sql", text: good(BODY + "\n-- новіше") },
      { name: "0190_old.sql", text: reprint(BODY) },
    ])).toEqual([]);
  });

  it("файл без сторожа взагалі — не наша справа", () => {
    expect(planGuardPin([{ name: "0100_plain.sql", text: "alter table t add column c int;\n" }]))
      .toEqual([]);
  });

  /* ⚠️ Згадка сторожа в ЗАКОМЕНТОВАНОМУ відкаті (так робить 0167) — НЕ
     передрук. Якби якір зʼїхав із початку рядка, гейт вимагав би піна від
     файлів, які тіла не чіпають. */
  it("сторож лише згаданий у коментарі — це не передрук", () => {
    const mention =
      "-- відкат: create or replace function public.invariants_check(...)\n" +
      "delete from public.migration_ledger where name = '0199_z.sql';\n";
    expect(planGuardPin([{ name: "0199_z.sql", text: mention }])).toEqual([]);
  });

  it("CRLF не міняє піна — межі рахуються після зняття chr(13)", () => {
    expect(planGuardPin([{ name: "0198_x.sql", text: good(BODY).replace(/\n/g, "\r\n") }]))
      .toEqual([]);
  });
});
