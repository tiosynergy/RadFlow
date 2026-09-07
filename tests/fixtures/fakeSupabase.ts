/* ===== Двійник Supabase-клієнта для роутів (аудит с45) =====

   Потрібен, щоб роути публікованої доступності перевірялися ПОВЕДІНКОВО, а не
   регулярками по вихідному коду: дірка I-1 («кабінет у ремонті публікується
   вільним») жила саме в роуті.

   Двійник свідомо ЗЛИЙ до себе — ревʼю с45 (round 2) показало, що м'який
   двійник гірший за його відсутність:
     • невідомий метод/фільтр КИДАЄ, а не мовчки ігнорується. Інакше додана в
       роут `.gte("started_at", …)` була б no-op у тесті й реальним фільтром у
       PostgREST — простій, що почався до діапазону, зник би, а набір лишався
       зеленим;
     • `select("…")` звіряє імена колонок із фікстурою. Дрейф імені колонки в
       PostgREST дає помилку (42703) і 500 на кожному виклику; тут — виняток;
     • uuid порівнюється БЕЗ регістру, як у Postgres, а не як рядок JS. */

export type Row = Record<string, unknown>;

export interface FakeDb {
  /** table → рядки. Фільтри застосовуються до них по-справжньому. */
  tables: Record<string, Row[]>;
  /** table (або "rpc") → помилка замість даних. */
  errors: Record<string, { message: string } | undefined>;
  /** rpc-ім'я + p_date → рядки зайнятості. */
  rpc: Record<string, Row[]>;
  /** Останні застосовані фільтри по таблиці — для перевірок «а чи питали?». */
  seen: Record<string, Record<string, unknown> | undefined>;
  /** с59: id, який `auth.admin.createUser` віддасть НАСТУПНОМУ створеному
      акаунту. Не задано — виклик КИДАЄ (тест, що створює акаунт, мусить
      сказати це явно). Журнал викликів auth.admin — у `authCalls`. */
  nextUserId?: string;
  authCalls?: string[];
  /** с59: УСІ запити по порядку (ревʼю А: `seen` тримає лише ОСТАННІЙ запит
      по таблиці, тож «брудний» select, зроблений першим, зникав із поля зору). */
  queries?: Array<{ table: string; cols: string[]; wrote?: "insert" | "update" }>;
}

export const emptyDb = (): FakeDb => ({ tables: {}, errors: {}, rpc: {}, seen: {} });

const isUuid = (v: unknown) =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Postgres порівнює uuid без урахування регістру і зберігає канонічний нижній. */
const eqVal = (a: unknown, b: unknown) =>
  isUuid(a) || isUuid(b)
    ? String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase()
    : a === b;

type Filter = { op: string; col: string; val: unknown };

class FakeQuery {
  private filters: Filter[] = [];
  private cols: string[] = [];
  private orExpr: string | null = null;
  private wantSingle = false;
  /* с59 (пакет 38): запис. `insert` кладе рядок у таблицю фікстури, `update`
     накладає патч на ВІДФІЛЬТРОВАНІ рядки (фільтри після `.update()` діють
     по-справжньому, як у PostgREST). Обидва повертають {data:null,error:null},
     як supabase-js без `.select()`. Ніякого `upsert`/`delete` — не реалізовано
     = кидає, за каноном двійника. */
  private patch: Row | null = null;
  private inserted: Row[] | null = null;

  constructor(private table: string, private db: FakeDb) {}

  select(cols?: string) {
    this.cols = (cols ?? "").split(",").map((c) => c.trim()).filter(Boolean);
    return this;
  }
  insert(rows: Row | Row[]) { this.inserted = Array.isArray(rows) ? rows : [rows]; return this; }
  update(patch: Row) { this.patch = patch; return this; }
  eq(col: string, val: unknown) { this.filters.push({ op: "eq", col, val }); return this; }
  neq(col: string, val: unknown) { this.filters.push({ op: "neq", col, val }); return this; }
  in(col: string, val: unknown[]) { this.filters.push({ op: "in", col, val }); return this; }
  lt(col: string, val: unknown) { this.filters.push({ op: "lt", col, val }); return this; }
  lte(col: string, val: unknown) { this.filters.push({ op: "lte", col, val }); return this; }
  gt(col: string, val: unknown) { this.filters.push({ op: "gt", col, val }); return this; }
  gte(col: string, val: unknown) { this.filters.push({ op: "gte", col, val }); return this; }
  is(col: string, val: unknown) { this.filters.push({ op: "is", col, val }); return this; }
  or(expr: string) { this.orExpr = expr; return this; }
  maybeSingle() { this.wantSingle = true; return this; }
  single() { this.wantSingle = true; return this; }

  then<T>(res: (v: { data: unknown; error: unknown }) => T, rej?: (e: unknown) => T) {
    try {
      return Promise.resolve(this.run()).then(res, rej);
    } catch (e) {
      return Promise.reject(e) as unknown as Promise<T>;
    }
  }

  private run(): { data: unknown; error: unknown } {
    const err = this.db.errors[this.table];
    if (err) return { data: null, error: err };

    const rows = this.db.tables[this.table] ?? [];
    this.assertColumnsExist(rows);
    this.db.seen[this.table] = {
      cols: this.cols,
      filters: this.filters.map((f) => `${f.op}:${f.col}`),
      or: this.orExpr,
      wrote: this.inserted ? "insert" : this.patch ? "update" : undefined,
    };
    (this.db.queries ??= []).push({
      table: this.table, cols: this.cols,
      wrote: this.inserted ? "insert" : this.patch ? "update" : undefined,
    });

    if (this.inserted) {
      this.db.tables[this.table] = rows.concat(this.inserted.map((r) => ({ ...r })));
      return { data: null, error: null };
    }
    if (this.patch) {
      const patch = this.patch;
      this.db.tables[this.table] = rows.map((r) => (this.matches(r) ? { ...r, ...patch } : r));
      return { data: null, error: null };
    }

    const out = rows.filter((r) => this.matches(r));
    return this.wantSingle ? { data: out[0] ?? null, error: null } : { data: out, error: null };
  }

  /* PostgREST на неіснуючу колонку віддає помилку (42703/PGRST204), і роут
     падає в fail-closed 500 на КОЖНОМУ виклику. Тут це виняток у тесті. */
  private assertColumnsExist(rows: Row[]) {
    if (rows.length === 0) return;
    for (const c of this.cols) {
      if (!rows.some((r) => c in r)) {
        throw new Error(`FakeSupabase: ${this.table}.select("${c}") — такої колонки у фікстурі немає`);
      }
    }
  }

  private matches(r: Row): boolean {
    for (const f of this.filters) {
      const v = r[f.col];
      if (f.op === "eq" && !eqVal(v, f.val)) return false;
      if (f.op === "neq" && eqVal(v, f.val)) return false;
      if (f.op === "in" && !(f.val as unknown[]).some((x) => eqVal(v, x))) return false;
      if (f.op === "lt" && !(String(v) < String(f.val))) return false;
      if (f.op === "lte" && !(String(v) <= String(f.val))) return false;
      if (f.op === "gt" && !(String(v) > String(f.val))) return false;
      if (f.op === "gte" && !(String(v) >= String(f.val))) return false;
      if (f.op === "is" && !(f.val === null ? v == null : v === f.val)) return false;
    }
    return this.orExpr == null || this.matchesOr(r, this.orExpr);
  }

  /* `or=(a.op.v,b.is.null)` — одна OR-група всередині загального AND.
     Розбір як у PostgREST: `колонка.оператор.значення`, значення — усе до коми
     (крапки й двокрапки ISO роздільниками НЕ є). */
  private matchesOr(r: Row, expr: string): boolean {
    return expr.split(",").some((part) => {
      const m = /^([a-z_]+)\.([a-z]+)\.(.+)$/i.exec(part.trim());
      if (!m) throw new Error(`FakeSupabase: не розібрав or(${part})`);
      const [, col, op, raw] = m;
      const v = r[col];
      if (op === "is") return raw === "null" ? v == null : String(v) === raw;
      if (op === "eq") return eqVal(v, raw);
      if (op === "gt") return v != null && String(v) > raw;
      if (op === "gte") return v != null && String(v) >= raw;
      if (op === "lt") return v != null && String(v) < raw;
      if (op === "lte") return v != null && String(v) <= raw;
      throw new Error(`FakeSupabase: невідомий оператор or(${op})`);
    });
  }
}

/* Будь-який метод, якого двійник не реалізує, МУСИТЬ впасти: мовчазний no-op
   робить тест зеленим там, де PostgREST застосує реальний фільтр. */
const strict = <T extends object>(target: T, what: string): T =>
  new Proxy(target, {
    get(o, prop, recv) {
      if (prop in o || typeof prop === "symbol") return Reflect.get(o, prop, recv);
      throw new Error(`FakeSupabase: ${what}.${String(prop)}() не реалізовано — додай у двійник`);
    },
  });

/** Клієнт-двійник: .from(table) і .rpc(name, args). */
export function fakeAdminClient(db: FakeDb) {
  return strict(
    {
      from: (t: string) => strict(new FakeQuery(t, db), `from("${t}")`),
      rpc: (name: string, args: Record<string, unknown>) => {
        const err = db.errors.rpc;
        if (err) return Promise.resolve({ data: null, error: err });
        const key = `${name}:${String(args?.p_date ?? "")}`;
        return Promise.resolve({ data: db.rpc[key] ?? [], error: null });
      },
      /* с59: рівно три методи service-role auth, які кличуть роути видачі
         запрошень. Кожен пишеться в `db.authCalls`, щоб тест міг сказати «роут
         НЕ створював акаунт» ствердно, а не за відсутністю помилки. */
      auth: strict(
        {
          admin: strict(
            {
              createUser: async () => {
                (db.authCalls ??= []).push("createUser");
                if (!db.nextUserId) throw new Error("FakeSupabase: auth.admin.createUser без db.nextUserId — тест не сказав, який id віддати");
                return { data: { user: { id: db.nextUserId } }, error: null };
              },
              deleteUser: async (id: string) => { (db.authCalls ??= []).push(`deleteUser:${id}`); return { data: null, error: null }; },
              updateUserById: async (id: string) => { (db.authCalls ??= []).push(`updateUserById:${id}`); return { data: null, error: null }; },
            },
            "auth.admin"
          ),
        },
        "auth"
      ),
    },
    "client"
  );
}
