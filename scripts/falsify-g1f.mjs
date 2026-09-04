// ============================================================
//  Стенд фальсифікації пакета Г1-F (с54).
//
//  Питання: чи справжні сторожі гарда «сервер не приймає добу, виведену з
//  розбіжного годинника» — тобто чи почервоніє САМЕ ТОЙ тест, який його
//  стереже, якщо повернути дефект назад.
//
//  ⚠️ Правлю БОЙОВІ файли → try/finally + обробники сигналів обовʼязкові.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ перед заміною.
//  ⚠️ БАЗОВА ЛІНІЯ обовʼязкова: немутований набір мусить бути ЗЕЛЕНИМ.
//  ⚠️ Кожна червона позиція називає ІМʼЯ тесту-сторожа (U-80б), і інвентар
//     заповнений ТВЕРДЖЕННЯМ, а не з прогону (урок пакета 8, с52).
//
//  Запуск: node scripts/falsify-g1f.mjs
//  Звіт:   falsify-g1f.md (корінь, у .gitignore)
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf } from "./lib/falsify-verdict.mjs";

const FILES = {
  ct: "lib/clockTrust.ts",
  uft: "lib/useFollowToday.ts",
  qa: "app/queue/actions.ts",
  wa: "app/waitlist/actions.ts",
  rm: "components/RescheduleModal.tsx",
  wm: "components/WaitlistModal.tsx",
  qb: "components/QueueBoard.tsx",
  wb: "components/WaitlistBoard.tsx",
  /* Пакет 22 (с56): три шляхи СТВОРЕННЯ і обидві точки, де народжується
     їхня заявка. Без них карта знову обіцяла б «весь ланцюг», не маючи
     половини — рівно та помилка, яку тут уже виправляли. */
  bm: "components/BookingModal.tsx",
  rp: "components/ReferralPortal.tsx",
  wcm: "components/WaitlistCandidatesModal.tsx",
};
/* ⚠️ КАРТА ФАЙЛІВ ПОКРИВАЄ ВЕСЬ ЛАНЦЮГ, а не лише «свої» (урок U-72, с50):
   правило, предикат, обидва екшени, обидві форми — і, за знахідкою ревʼю,
   ще ДВА місця, де заявка НАРОДЖУЄТЬСЯ або може бути підмінена: дошка черги
   (інлайн-переноси будують власну заявку `boardClock`) і дошка листа (може
   передати `null`). Перша редакція карти цих файлів не мала, а коментар над
   нею стверджував «покриває весь ланцюг» — тобто стенд фізично не міг
   зламати три з чотирьох точок народження заявки і при цьому обіцяв покриття.
   Спеки — обидва: `followToday` лишається в наборі, щоб винесення предиката з
   `followedDay` перевірялось поведінково. */
const SPECS = ["tests/clockTrust.test.ts", "tests/followToday.test.ts"];
const OUT = "falsify-g1f.md";
const REPORT = ".falsify-g1f.json";

const MUTATIONS = [
  /* ---------- ПРАВИЛО: перевіряється ВИКЛИКОМ ---------- */
  {
    id: "M1", file: "ct", green: false,
    expect: /СПРАВЖНЯ ПІВНІЧ між кліком і сервером/,
    what: "знято другу умову — гард судить лише по добах",
    from: `  if (Math.abs(server.nowMs - claim.nowMs) <= tolMs) return "ok";`,
    to: `  void tolMs;`,
  },
  {
    id: "M2", file: "ct", green: false,
    expect: /дату обрала ЛЮДИНА/,
    what: "гард перестав розрізняти дефолт і свідомий вибір людини",
    from: `  if (!claim.fromToday) return "ok";`,
    to: `  void 0;`,
  },
  {
    id: "M3", file: "ct", green: false,
    expect: /доби збіглись/,
    what: "знято вихід «доби збіглись» — зсув, що добу не перетинає, став відмовою",
    from: `  if (claim.dayKey === server.dayKey) return "ok";`,
    to: `  void 0;`,
  },
  {
    id: "M4", file: "ct", green: false,
    expect: /malformed перевіряється ПЕРШИМ/,
    what: "зіпсованій заявці почали вірити на слово про fromToday",
    from: `  ) return "malformed";`,
    to: `  ) return claim.fromToday === false ? "ok" : "malformed";`,
  },
  {
    id: "M5", file: "ct", green: false,
    expect: /відсутня заявка/,
    what: "відсутня заявка стала відмовою — стара вкладка лягла б у мить деплою",
    from: `  if (claim === null || claim === undefined) return "ok";`,
    to: `  if (claim === null || claim === undefined) return "malformed";`,
  },
  {
    id: "M6", file: "ct", green: false,
    expect: /на мілісекунду за межею/,
    what: "допуск став одностороннім — годинник, що СПІШИТЬ, більше не ловиться",
    from: `  if (Math.abs(server.nowMs - claim.nowMs) <= tolMs) return "ok";`,
    to: `  if (server.nowMs - claim.nowMs <= tolMs) return "ok";`,
  },
  {
    id: "M7", file: "ct", green: false,
    expect: /десять секунд польоту запиту/,
    what: "з допуску знято бюджет на політ — холодний старт сам став відмовою",
    from: `export const CLOCK_TRUST_TOL_MS = CLOCK_WORST_ERROR_MS + CLOCK_TRUST_NET_BUDGET_MS;`,
    to: `export const CLOCK_TRUST_TOL_MS = CLOCK_WORST_ERROR_MS;`,
  },
  {
    id: "M8", file: "uft", green: false,
    expect: /дата прийшла ззовні явно \(pinnedKey\)/,
    what: "предикат забув про pinnedKey — deep-link почав рахуватись дефолтом",
    from: `  if (pinnedKey && curKey === pinnedKey) return false;`,
    to: `  void pinnedKey;`,
  },
  {
    id: "M9", file: "uft", green: false,
    expect: /чужа дата в полі/,
    what: "заявка стверджує «виведена з сьогодні» завжди — гард б'є по свідомому вибору",
    from: `    fromToday: derivedFromToday({`,
    to: `    fromToday: true || derivedFromToday({`,
  },

  /* ---------- ПРОВОДКА: перевіряється пінами по джерелу ---------- */
  {
    id: "M10", file: "qa", green: false,
    expect: /гард стоїть і стоїть ДО перевірки минулого/,
    what: "гард знято з rescheduleQueueEntry",
    /* Якір несе ще й наступний рядок переносу: у пакеті 22 голий виклик гарда
       став збігатись у чотирьох шляхах запису. */
    from: `    if (clockClaimVerdict(input.clock as ClockClaim | undefined, serverClockNow(tz)) !== "ok") {
      return CLOCK_SKEW_ERR;
    }
  }
  /* Перенести в МИНУЛЕ не можна`,
    to: `    if (false) {
      return CLOCK_SKEW_ERR;
    }
  }
  /* Перенести в МИНУЛЕ не можна`,
  },
  {
    id: "M11", file: "qa", green: false,
    expect: /гард стоїть і стоїть ДО перевірки минулого/,
    what: "гард з'їхав ПІСЛЯ перевірки минулого — оператор читає наслідок замість причини",
    from: `  {
    const tz = await clinicTz(supabase, clinicId);
    if (clockClaimVerdict(input.clock as ClockClaim | undefined, serverClockNow(tz)) !== "ok") {
      return CLOCK_SKEW_ERR;
    }
  }
  /* Перенести в МИНУЛЕ не можна — жодною роллю. Клієнтський гейт тут не працював
     (isToday=false → перевірка "past" пропускалась), тому це і є основна діра. */
  if (await isPastSlot(supabase, clinicId, input.scheduledDate, input.scheduledTime)) return PAST_ERR;`,
    to: `  if (await isPastSlot(supabase, clinicId, input.scheduledDate, input.scheduledTime)) return PAST_ERR;
  {
    const tz = await clinicTz(supabase, clinicId);
    if (clockClaimVerdict(input.clock as ClockClaim | undefined, serverClockNow(tz)) !== "ok") {
      return CLOCK_SKEW_ERR;
    }
  }`,
  },
  {
    id: "M12", file: "qa", green: false,
    expect: /заявка ОБОВʼЯЗКОВА в типі/,
    what: "заявку в RescheduleInput зроблено необовʼязковою — сторож повноти знято",
    from: `  clock: ClockClaim;
};

/** Перенос записи`,
    to: `  clock?: ClockClaim;
};

/** Перенос записи`,
  },
  {
    id: "M13", file: "qa", green: false,
    expect: /схема входу лишає розбір заявки ПРАВИЛУ/,
    what: "заявку почали розбирати схемою — гілка malformed стала недосяжною",
    from: `  clock: z.unknown().optional(),
});

const sIncident`,
    to: `  clock: z.object({ nowMs: z.number(), dayKey: zDateKey, fromToday: z.boolean() }).optional(),
});

const sIncident`,
  },
  {
    id: "M14", file: "wa", green: false,
    expect: /лист очікування: гард стоїть на вставці і на патчі/,
    what: "гард знято з addWaitlistEntry",
    from: `    if (clockClaimVerdict(input.clock as ClockClaim | undefined, serverClockNow(tz)) !== "ok") {`,
    to: `    if (false) {`,
  },
  {
    id: "M15", file: "wa", green: false,
    expect: /лист очікування: гард стоїть на вставці і на патчі/,
    what: "гард патча перестав дивитись на desired_date_from",
    from: `  if (v.data.patch.desired_date_from !== undefined) {`,
    to: `  if (false) {`,
  },
  {
    id: "M16", file: "rm", green: false,
    expect: /форми будують заявку ТИМИ САМИМИ аргументами/,
    what: "форма переносу будує заявку іншим зсувом, ніж веде правило",
    from: `clock: clockClaimOf({ clinicTz: clinicTz || undefined, curKey: dateStr, offsetDays: 1 }),`,
    to: `clock: clockClaimOf({ clinicTz: clinicTz || undefined, curKey: dateStr, offsetDays: 0 }),`,
  },
  {
    id: "M17", file: "wm", green: false,
    expect: /форми будують заявку ТИМИ САМИМИ аргументами/,
    what: "лист очікування будує заявку без pinnedKey — збережена дата стає «дефолтом»",
    from: `          pinnedKey: initial?.desired_date_from ?? null,
`,
    to: ``,
  },

  /* ---------- ЗНАХІДКИ РЕВʼЮ: «сторож тримає РЯДОК, а не ВІДМОВУ» ---------- */
  {
    id: "M18", file: "qa", green: false,
    expect: /гард стоїть і стоїть ДО перевірки минулого/,
    what: "гард лишився на місці, але перестав ВІДМОВЛЯТИ (знято return)",
    from: `      return CLOCK_SKEW_ERR;\n    }\n  }\n  /* Перенести в МИНУЛЕ`,
    to: `      void CLOCK_SKEW_ERR;\n    }\n  }\n  /* Перенести в МИНУЛЕ`,
  },
  {
    id: "M19", file: "qa", green: false,
    expect: /гард стоїть і стоїть ДО перевірки минулого/,
    what: "відповідь гарда підмінено власним текстом — зникла і причина, і названий вихід",
    from: `const CLOCK_SKEW_ERR = { ok: false as const, error: CLOCK_SKEW_MSG, code: "clock_skew" as const };`,
    to: `const CLOCK_SKEW_ERR = { ok: false as const, error: "Не вдалося зберегти запис", code: "clock_skew" as const };`,
  },
  {
    id: "M20", file: "wa", green: false,
    expect: /лист очікування: гард стоїть на вставці і на патчі/,
    what: "гард вставки обгорнуто в чужу умову — мертвий для звичайного додавання",
    from: `  {\n    const tz = (await supabase.from("clinics")`,
    to: `  if (input.sourceEntryId) {\n    const tz = (await supabase.from("clinics")`,
  },
  {
    id: "M21", file: "wa", green: false,
    expect: /`null` замість заявки на патчі З ДАТОЮ/,
    what: "`null` замість заявки на патчі з датою знову пропускається",
    from: `    if (clock === null) return CLOCK_SKEW_ERR;\n`,
    to: ``,
  },
  {
    id: "M22", file: "qb", green: false,
    expect: /дошка черги будує заявку ТИМИ САМИМИ аргументами/,
    what: "заявка дошки завжди каже «обрала людина» — гард вимкнено для обох інлайн-переносів",
    /* ⚠️ ПЕРЕЯКОРЕНО в с55 (F3): із заявки дошки знято `pinnedKey: initialDate`
       — пін глушив відмову Г1-F рівно на дип-лінку в сьогоднішній день. Старий
       якір дав 0 входжень, і передпольотна перевірка чесно НЕ ПУСТИЛА стенд
       (0 с, «ЯКОРІ ПРОТУХЛИ»). Мутація лишається тією самою по СЕНСУ: зробити
       `fromToday` тотожно хибним, тільки тепер це додавання піна, а не підміна. */
    from: `  const boardClock = () => clockClaimOf({ clinicTz, curKey: dateKey(selectedDate) });`,
    to: `  const boardClock = () => clockClaimOf({ clinicTz, curKey: dateKey(selectedDate), pinnedKey: dateKey(selectedDate) });`,
  },
  {
    id: "M23", file: "qb", green: false,
    expect: /дошка черги будує заявку ТИМИ САМИМИ аргументами/,
    what: "інлайн-перенос на колізії перестав возити заявку",
    from: `      reason: "Накладення: попереднє дослідження затягнулося", clock: boardClock(),`,
    to: `      reason: "Накладення: попереднє дослідження затягнулося", clock: { nowMs: 0, dayKey: "1970-01-01", fromToday: false },`,
  },
  {
    id: "M24", file: "rm", green: false,
    expect: /форми будують заявку ТИМИ САМИМИ аргументами/,
    what: "гілка «інший кабінет» будує заявку іншим зсувом — гард вимкнено для переносу в інший кабінет",
    from: `      clock: clockClaimOf({ clinicTz: clinicTz || undefined, curKey: dateKeyOf(b.date), offsetDays: 1 }),`,
    to: `      clock: clockClaimOf({ clinicTz: clinicTz || undefined, curKey: dateKeyOf(b.date), offsetDays: 0 }),`,
  },
  {
    id: "M25", file: "ct", green: false,
    expect: /допуск закріплений і ЗВЕРХУ/,
    what: "допуск мовчки РОЗШИРЕНО до 33 хв — гард перестає ловити реальні уходи годинника",
    from: `export const CLOCK_TRUST_NET_BUDGET_MS = 30_000;`,
    to: `export const CLOCK_TRUST_NET_BUDGET_MS = 2_000_000;`,
  },
  {
    id: "M26", file: "ct", green: false,
    expect: /доба рахується в зоні клініки/,
    what: "серверна доба рахується в зоні ПРОЦЕСУ — у Києві щоночі три години гард тримає лише допуск",
    from: `  return { nowMs, dayKey: wallDayKeyAt(nowMs, clinicTz || undefined) };`,
    to: `  return { nowMs, dayKey: wallDayKeyAt(nowMs) };`,
  },
  {
    id: "M27", file: "ct", green: false,
    expect: /зіпсована заявка/,
    what: "з ключа доби знято якорі — сміття довкола дати стало валідним ключем",
    from: `const isDayKey = (v: string) => v.length === 10 && DAY_KEY_RE.test(v);`,
    to: `const isDayKey = (v: string) => /\\d{4}-\\d{2}-\\d{2}/.test(v);`,
  },

  /* ---------- ПРАВКИ БЕЗ ДЕФЕКТУ — мусять лишитись ЗЕЛЕНИМИ ---------- */
  /* ---------- ПАКЕТ 22 (с56): три шляхи СТВОРЕННЯ ---------- */
  {
    id: "P1", file: "qa", green: false,
    expect: /створення \(createBooking\)/,
    what: "гард знято зі створення запису — доба зі збитого годинника знову їде мовчки",
    from: `    if (clockClaimVerdict(input.clock as ClockClaim | undefined, serverClockNow(tz)) !== "ok") {
      return CLOCK_SKEW_ERR;
    }
  }
  if (await isPastSlot(supabase, clinicId, input.scheduledDate, input.scheduledTime)) return PAST_ERR;
  /* 0077: createBooking доступний лише персоналу`,
    to: `    void tz;
  }
  if (await isPastSlot(supabase, clinicId, input.scheduledDate, input.scheduledTime)) return PAST_ERR;
  /* 0077: createBooking доступний лише персоналу`,
  },
  {
    id: "P2", file: "qa", green: false,
    expect: /створення \(createBooking\)/,
    what: "гард створення читається, але більше не ВІДМОВЛЯЄ",
    from: `      return CLOCK_SKEW_ERR;
    }
  }
  if (await isPastSlot(supabase, clinicId, input.scheduledDate, input.scheduledTime)) return PAST_ERR;
  /* 0077: createBooking доступний лише персоналу`,
    to: `      void CLOCK_SKEW_ERR;
    }
  }
  if (await isPastSlot(supabase, clinicId, input.scheduledDate, input.scheduledTime)) return PAST_ERR;
  /* 0077: createBooking доступний лише персоналу`,
  },
  {
    id: "P3", file: "qa", green: false,
    expect: /створення \(createBooking\)/,
    what: "гард створення з'їхав ПІСЛЯ перевірки минулого — оператор прочитає наслідок",
    from: `  {
    const tz = await clinicTz(supabase, clinicId);
    if (clockClaimVerdict(input.clock as ClockClaim | undefined, serverClockNow(tz)) !== "ok") {
      return CLOCK_SKEW_ERR;
    }
  }
  if (await isPastSlot(supabase, clinicId, input.scheduledDate, input.scheduledTime)) return PAST_ERR;
  /* 0077: createBooking доступний лише персоналу`,
    to: `  if (await isPastSlot(supabase, clinicId, input.scheduledDate, input.scheduledTime)) return PAST_ERR;
  {
    const tz = await clinicTz(supabase, clinicId);
    if (clockClaimVerdict(input.clock as ClockClaim | undefined, serverClockNow(tz)) !== "ok") {
      return CLOCK_SKEW_ERR;
    }
  }
  /* 0077: createBooking доступний лише персоналу`,
  },
  {
    id: "P4", file: "qa", green: false,
    expect: /створення \(scheduleFromWaitlist\)/,
    what: "гард знято з листа очікування — запис із чужої доби створюється мовчки",
    from: `    if (clockClaimVerdict(input.clock as ClockClaim | undefined, serverClockNow(tz)) !== "ok") {
      return CLOCK_SKEW_ERR;
    }
  }
  if (await isPastSlot(supabase, clinicId, input.scheduledDate, input.scheduledTime)) return PAST_ERR;
  const gate = await scheduleBlock(`,
    to: `    void tz;
  }
  if (await isPastSlot(supabase, clinicId, input.scheduledDate, input.scheduledTime)) return PAST_ERR;
  const gate = await scheduleBlock(`,
  },
  {
    id: "P5", file: "qa", green: false,
    expect: /ДО атомарного CAS/,
    what: "гард листа очікування з'їхав ПІСЛЯ CAS — відмова столбить кандидата",
    from: `  {
    const tz = await clinicTz(supabase, clinicId);
    if (clockClaimVerdict(input.clock as ClockClaim | undefined, serverClockNow(tz)) !== "ok") {
      return CLOCK_SKEW_ERR;
    }
  }
  if (await isPastSlot(supabase, clinicId, input.scheduledDate, input.scheduledTime)) return PAST_ERR;
  const gate = await scheduleBlock(`,
    to: `  if (await isPastSlot(supabase, clinicId, input.scheduledDate, input.scheduledTime)) return PAST_ERR;
  const gate = await scheduleBlock(`,
  },
  {
    id: "P6", file: "qa", green: false,
    expect: /створення \(createReferralBooking\)/,
    what: "гард знято з направлення — направник записує в чужу добу мовчки",
    from: `    const tz = await clinicTz(supabase, input.clinicId);
    if (clockClaimVerdict(input.clock as ClockClaim | undefined, serverClockNow(tz)) !== "ok") {
      return CLOCK_SKEW_ERR;
    }`,
    to: `    const tz = await clinicTz(supabase, input.clinicId);
    void tz;`,
  },
  {
    id: "P7", file: "qa", green: false,
    expect: /створення \(createReferralBooking\)/,
    what: "гард направлення взяв зону не центру — доба рахується чужим годинником",
    from: `    const tz = await clinicTz(supabase, input.clinicId);
    if (clockClaimVerdict(input.clock as ClockClaim | undefined, serverClockNow(tz)) !== "ok") {`,
    to: `    const tz = await clinicTz(supabase, input.roomId);
    if (clockClaimVerdict(input.clock as ClockClaim | undefined, serverClockNow(tz)) !== "ok") {`,
  },
  {
    id: "P8", file: "qa", green: false,
    expect: /ОБОВ.ЯЗКОВА в обох типах створення/,
    what: "заявка в BookingInput стала необовʼязковою — сторож повноти знято",
    from: `  clock: ClockClaim;
};

/** Создать новую запись`,
    to: `  clock?: ClockClaim;
};

/** Создать новую запись`,
  },
  {
    id: "P9", file: "qa", green: false,
    expect: /ОБОВ.ЯЗКОВА в обох типах створення/,
    what: "заявка в ReferralBookingInput стала необовʼязковою",
    from: `  clock: ClockClaim;   // Г1-F, пакет 22 — див. коментар у BookingInput`,
    to: `  clock?: ClockClaim;   // Г1-F, пакет 22 — див. коментар у BookingInput`,
  },
  {
    id: "P10", file: "bm", green: false,
    expect: /форма запису будує заявку/,
    what: "заявка модалки будується іншим зсувом, ніж веде її правило",
    from: `          curKey: dateKey(bookDate),
          offsetDays: 0,`,
    to: `          curKey: dateKey(bookDate),
          offsetDays: 1,`,
  },
  {
    id: "P11", file: "bm", green: false,
    expect: /форма запису будує заявку/,
    what: "у заявки модалки прибрано pinnedKey — дата з картки пацієнта стала «дефолтом»",
    from: `          offsetDays: 0,
          pinnedKey: prefill?.datePinned ? prefill.date ?? null : null,
        }),`,
    to: `          offsetDays: 0,
        }),`,
  },
  {
    id: "P12", file: "rp", green: false,
    expect: /портал направника будує заявку зоною/,
    what: "портал будує заявку своєю зоною замість зони центру",
    from: `      clock: clockClaimOf({ clinicTz: selTz, curKey: dateVal(bookDate), offsetDays: 1 }),`,
    to: `      clock: clockClaimOf({ clinicTz: undefined, curKey: dateVal(bookDate), offsetDays: 1 }),`,
  },
  {
    id: "P13", file: "wcm", green: false,
    expect: /усі три споживачі модалки везуть заявку далі/,
    what: "кандидати на звільнений слот перестали везти заявку далі",
    from: `      clock: b.clock,   // Г1-F (пакет 22) — див. WaitlistBoard.saveBooking`,
    to: `      // clock прибрано`,
  },
  {
    id: "P14", file: "wb", green: false,
    expect: /усі три споживачі модалки везуть заявку далі/,
    what: "дошка листа очікування перестала везти заявку модалки",
    from: `      clock: b.clock,   // Г1-F (пакет 22) — гард стоїть ДО CAS, кандидат не столбиться`,
    to: `      // clock прибрано`,
  },
  {
    id: "G6", file: "bm", green: true,
    what: "[позитивний контроль] коментар у модалці переписано іншим стилем — сторожів тут нема",
    from: `    if (!valid || saving) return;   // M-6: подвійний клік не створює другий запис`,
    to: `    if (!valid || saving) return;   /* M-6: подвійний клік не створює другий запис */`,
  },
  {
    id: "G1", file: "ct", green: true,
    what: "той самий формат ключа доби, записаний конструктором RegExp",
    from: `const DAY_KEY_RE = /^\\d{4}-\\d{2}-\\d{2}$/;`,
    to: `const DAY_KEY_RE = new RegExp("^\\\\d{4}-\\\\d{2}-\\\\d{2}$");`,
  },
  {
    id: "G2", file: "uft", green: true,
    what: "винесення предиката скасовано — умови повернуто в followedDay дослівно",
    from: `  if (!derivedFromToday({ todayDay: prevDay, curKey, offsetDays, pinnedKey })) return null;`,
    to: `  if (curKey !== dateKeyOf(shiftDays(prevDay, offsetDays))) return null;\n  if (pinnedKey && curKey === pinnedKey) return null;`,
  },
  {
    id: "G3", file: "qa", green: true,
    what: "гард переформатовано на два рядки (пін по нормалізованому джерелу)",
    from: `    if (clockClaimVerdict(input.clock as ClockClaim | undefined, serverClockNow(tz)) !== "ok") {
      return CLOCK_SKEW_ERR;
    }
  }
  /* Перенести в МИНУЛЕ не можна`,
    to: `    if (clockClaimVerdict(input.clock as ClockClaim | undefined,\n      serverClockNow(tz)) !== "ok") {
      return CLOCK_SKEW_ERR;
    }
  }
  /* Перенести в МИНУЛЕ не можна`,
  },
  {
    id: "G4", file: "wa", green: true,
    what: "гард листа переформатовано на два рядки (знахідка ревʼю: рефакторні правки були лише для черги)",
    from: `    if (clockClaimVerdict(input.clock as ClockClaim | undefined, serverClockNow(tz)) !== "ok") {`,
    to: `    if (clockClaimVerdict(input.clock as ClockClaim | undefined,\n      serverClockNow(tz)) !== "ok") {`,
  },
  {
    id: "G5", file: "wb", green: true,
    what: "перенос аргументу заявки на свій рядок у дошці листа",
    from: `    }, w.clock);   // Г1-F: патч ВЕЗЕ desired_date_from — заявка обовʼязкова, і вона від форми`,
    to: `    },\n      w.clock);   // Г1-F: патч ВЕЗЕ desired_date_from — заявка обовʼязкова, і вона від форми`,
  },
];

/* ⚠️ U-80б (с52). Кожна мутація, яка МУСИТЬ почервоніти, називає ТЕСТ-СТОРОЖА. */
for (const m of MUTATIONS) {
  const bad =
    (!m.green && !m.expect) ? "мутація мусить червоніти, але не називає сторожа (`expect`)"
    : (m.green && m.expect) ? "`expect` у рядка, який МУСИТЬ лишитись зеленим — сторожа тут не буває"
    : (m.expect && /\|/.test(m.expect.source)) ? "у регулярці `|` — вона зламає таблицю звіту"
    : null;
  if (bad) {
    console.error(`⛔ ІНВЕНТАР БРЕШЕ: ${m.id} — ${bad}. Стенд НЕ прогнано.`);
    process.exit(1);
  }
}

/* ⚠️ ПІН НА КІЛЬКІСТЬ АДРЕСНИХ ПОЗИЦІЙ (с52). Правило вище ВИМАГАЄ прибрати
   `expect` у рядка з `green: true` — а отже саме воно й дає найдешевший спосіб
   погасити червону позицію: перевести її в зелені і зняти сторожа. */
const EXPECTED_RED = 41;   // +14 у пакеті 22 (три шляхи створення)
const redCount = MUTATIONS.filter((m) => !m.green).length;
if (redCount !== EXPECTED_RED) {
  console.error(`⛔ ІНВЕНТАР БРЕШЕ: адресних мутацій ${redCount}, а очікується ${EXPECTED_RED}. `
    + "Якщо позицію знято свідомо — поправте EXPECTED_RED разом із нею. Стенд НЕ прогнано.");
  process.exit(1);
}

/* ⚠️ РАЗОВА ПЕРЕВІРКА ЯКОРІВ (борг U-80г, с53 — тут зроблена кроком стенда):
   кожен `from` мусить трапитись у своєму файлі РІВНО ОДИН раз. Протухлий якір
   інакше виглядає майже як успіх — мутація відхиляється рядком у таблиці, а
   сторож не перевіряється взагалі. */
{
  const bad = [];
  for (const m of MUTATIONS) {
    const n = readFileSync(FILES[m.file], "utf8").split(m.from).length - 1;
    if (n !== 1) bad.push(`${m.id} (${FILES[m.file]}): ${n}`);
  }
  if (bad.length) {
    console.error("⛔ ЯКОРІ ПРОТУХЛИ (очікується рівно 1 збіг): " + bad.join(", ") + ". Стенд НЕ прогнано.");
    process.exit(1);
  }
}

const orig = {};
for (const [k, p] of Object.entries(FILES)) orig[k] = readFileSync(p, "utf8");
let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  for (const [k, p] of Object.entries(FILES)) writeFileSync(p, orig[k]);
}
process.on("SIGINT", () => { restore(); process.exit(130); });
process.on("SIGTERM", () => { restore(); process.exit(143); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(2); });

/** Прогін набору. JSON-репортером, а не текстом. */
function run() {
  if (existsSync(REPORT)) unlinkSync(REPORT);
  spawnSync("npx", ["vitest", "run", ...SPECS, "--reporter=json", `--outputFile.json=${REPORT}`],
    { shell: true, stdio: "ignore", timeout: 5 * 60 * 1000 });
  /* ⚠️ U-80 (с51): прогін, який НЕ ВІДБУВСЯ, — окремий стан, а не «сторож спіймав». */
  if (!existsSync(REPORT)) return { crashed: true, ok: false, red: [], all: [] };
  let r;
  try { r = JSON.parse(readFileSync(REPORT, "utf8")); }
  catch { return { crashed: true, ok: false, red: [], all: [] }; }
  const red = [], all = [];
  for (const f of r.testResults || []) {
    /* `fullName`, а не `title` (U-80б): у двох спеках цього стенда є однойменні
       describe-блоки, і за `title` назвати сторожа поіменно неможливо. */
    for (const a of f.assertionResults || []) {
      const n = a.fullName || a.title;
      all.push(n);
      if (a.status !== "passed") red.push(n);
    }
  }
  return { crashed: false, ok: r.success === true && red.length === 0, red, all, total: r.numTotalTests };
}

const lines = [];
let addressedOk = 0;
try {
  const base = run();
  lines.push(`# Стенд фальсифікації Г1-F (с54)\n`);
  lines.push(`**БАЗОВА ЛІНІЯ:** ${base.ok ? "ЗЕЛЕНА" : "ЧЕРВОНА"} (${base.total} тестів)\n`);
  if (!base.ok) {
    lines.push(`\n⛔ Базова лінія червона — стенд НІЧОГО не доводить. Червоні: ${base.red.join(", ")}\n`);
  } else {
    lines.push(`\n| # | мутація | очікування | факт | вердикт |`);
    lines.push(`|---|---|---|---|---|`);
    for (const m of MUTATIONS) {
      const path = FILES[m.file];
      const srcNow = readFileSync(path, "utf8");
      const n = srcNow.split(m.from).length - 1;
      if (n !== 1) {
        lines.push(`| ${m.id} | ${m.what} | — | ЯКІР НЕ УНІКАЛЬНИЙ (${n}) | ⛔ відхилено |`);
        continue;
      }
      writeFileSync(path, srcNow.replace(m.from, () => m.to));
      const res = run();
      writeFileSync(path, srcNow);
      const wantRed = !m.green;
      if (res.crashed) {
        lines.push(`| ${m.id} | ${m.what} | ${wantRed ? "ЧЕРВОНЕ" : "ЗЕЛЕНЕ"} | прогін не відбувся | ⛔ мутація зламала збірку |`);
        continue;
      }
      const gotRed = !res.ok;
      const fact = gotRed ? res.red.map((t) => `«${t}»`).join("; ") : "усе зелене";
      const missed = wantRed && gotRed && !res.red.some((t) => m.expect.test(t));
      const noSuchGuard = missed && !res.all.some((t) => m.expect.test(t));
      const verdict = noSuchGuard ? "⛔ СТОРОЖА З ТАКИМ ІМЕНЕМ НЕМАЄ (дефект стенда)"
        : missed ? "⛔ ЧУЖИЙ спек"
        : (wantRed === gotRed ? "✅" : "⛔ СТОРОЖ НЕ ТРИМАЄ");
      if (verdict === "✅" && wantRed) addressedOk++;
      const want = wantRed ? `ЧЕРВОНЕ: ${m.expect.source}` : "ЗЕЛЕНЕ";
      lines.push(`| ${m.id} | ${m.what} | ${want} | ${fact} | ${verdict} |`);
    }
  }
} finally {
  restore();
  if (existsSync(REPORT)) unlinkSync(REPORT);
  const verdict = verdictOf(lines, MUTATIONS.length);
  lines.push(`\n${verdict.summary}`);
  lines.push(`\n## ПІДСУМОК: ${addressedOk}/${EXPECTED_RED} адресних, ${MUTATIONS.length - EXPECTED_RED} рефакторних`);
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nЗвіт: ${OUT}. Файли відновлено.`);
  if (!verdict.ok) process.exitCode = 1;
}
