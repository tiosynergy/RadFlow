/**
 * Сторож SQL-коментарів у міграціях і смоуках.
 *
 * ЧОМУ. У с25 міграція 0128 впала в SQL Editor на `syntax error at or near
 * "case"`: у шапці `/* … *\/` був текст «queue.*&#47;case.*» — послідовність
 * `*` + `/` ЗАКРИЛА блочний коментар достроково, і решта шапки поїхала в
 * парсер як SQL. Postgres блочні коментарі вкладає, але `*` + `/` всередині
 * тексту він однаково читає як закриття.
 *
 * Дефект того ж класу вже ловився ТРИЧІ в TS-файлах цієї ж сесії, і жоден
 * прогін `execute_sql` його не спіймав — бо dry-run робився ПЕРЕДРУКОВАНИМ
 * SQL без шапки. Урок: сторож має читати ФАЙЛ, а не те, що агент вважає
 * його вмістом.
 *
 * Тест перевіряє баланс `/*` … `*` + `/` у кожному .sql репозиторію:
 * кожен відкритий блочний коментар мусить закриватись рівно там, де
 * задумано, і не раніше.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const OPEN = "/" + "*";
const CLOSE = "*" + "/";

/** Директорії з SQL, які веде проєкт. */
const SQL_DIRS = ["supabase/migrations", "supabase/smoke", "supabase/maintenance"];

function sqlFiles(): string[] {
  const out: string[] = [];
  for (const dir of SQL_DIRS) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // директорії може не бути — це не помилка
    }
    for (const n of names) if (n.endsWith(".sql")) out.push(join(dir, n));
  }
  return out;
}

/**
 * Знаходить блочні коментарі, що закрились НЕ на своєму місці.
 * Повертає опис проблеми або null, якщо все гаразд.
 *
 * Правило просте і механічне: рахуємо глибину вкладеності блочних
 * коментарів, ігноруючи рядкові (`--`) та вміст рядкових літералів.
 * Якщо `*` + `/` трапляється при глибині 0 — це «зайве» закриття,
 * тобто рівно наш дефект.
 */
export function strayBlockCommentClose(sql: string): string | null {
  let depth = 0;
  let line = 1;
  // Рядок, де коментар востаннє закрився: саме він винен, коли далі
  // трапляється «зайве» закриття (шапка закрилась раніше, ніж задумано).
  let lastCloseLine = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "\n") { line++; continue; }

    if (depth === 0) {
      // Поза коментарем: пропускаємо рядкові коментарі й літерали.
      if (ch === "-" && sql[i + 1] === "-") {
        while (i < sql.length && sql[i] !== "\n") i++;
        line++;
        continue;
      }
      if (ch === "'") {
        i++;
        while (i < sql.length && sql[i] !== "'") { if (sql[i] === "\n") line++; i++; }
        continue;
      }
      if (ch === "*" && sql[i + 1] === "/") {
        return lastCloseLine
          ? `рядок ${line}: «${CLOSE}» поза блочним коментарем — коментар закрився ранiше, на рядку ${lastCloseLine}`
          : `рядок ${line}: «${CLOSE}» поза блочним коментарем`;
      }
      if (ch === "/" && sql[i + 1] === "*") { depth++; i++; continue; }
    } else {
      if (ch === "/" && sql[i + 1] === "*") { depth++; i++; continue; }
      if (ch === "*" && sql[i + 1] === "/") {
        depth--; i++;
        if (depth === 0) lastCloseLine = line;
        continue;
      }
    }
  }
  if (depth > 0) return `незакритий блочний коментар (глибина ${depth})`;
  return null;
}

describe("SQL: блочні коментарі не закриваються достроково (урок 0128)", () => {
  const files = sqlFiles();

  it("у репозиторії взагалі є .sql-файли (сторож не має бути порожнім)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    it(`${f} — коментарі збалансовані`, () => {
      expect(strayBlockCommentClose(readFileSync(f, "utf8"))).toBeNull();
    });
  }
});

describe("сам сторож ловить дефект (перевірка навмисною поломкою)", () => {
  it("ловить «queue.*&#47;case.*» у шапці — точний випадок 0128", () => {
    const broken = [OPEN + " шапка", "   події queue." + CLOSE + "case.*", CLOSE, "select 1;"].join("\n");
    const msg = strayBlockCommentClose(broken);
    // Сторож мусить показати ПЕРЕДЧАСНЕ закриття (рядок 2), а не лише фінальне.
    expect(msg).toContain("на рядку 2");
  });

  it("ловить незакритий коментар", () => {
    expect(strayBlockCommentClose(OPEN + " забули закрити\nselect 1;")).toContain("незакритий");
  });

  it("не свариться на коректний файл із вкладеними коментарями", () => {
    const ok = [
      OPEN + " шапка " + OPEN + " вкладена " + CLOSE + " все ще коментар " + CLOSE,
      "-- рядковий коментар з " + CLOSE + " всередині",
      "select '" + CLOSE + "'::text;",
      "select 1;",
    ].join("\n");
    expect(strayBlockCommentClose(ok)).toBeNull();
  });
});
