import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/apiAuth";
import { parseBody, parseJson } from "@/lib/validationHttp";
import { safeDbError, zUuid, zName, zEmail, zLogin, zOptText } from "@/lib/validation";
import { randomRadiologistEmail, isTechnicalEmail } from "@/lib/login";

// M-12: тіло запиту — схемою, а не String(body.x || ""). Кабінети — тільки UUID
// (масив після dedupe); решта валідації (кабінет належить центру) — нижче, з БД.
const sStaff = z.object({
  role: z.enum(["radiologist", "registrar"]).default("radiologist"),
  // 0124: у радіолога адреса СЛУЖБОВА й випадкова, тож email тут —
  // необовʼязкова контактна пошта. Для реєстратора це, як і раніше, адреса
  // входу, тому обовʼязковість перевіряємо нижче, знаючи роль.
  email: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.union([zEmail, z.null(), z.undefined()]),
  ).transform((v) => (v ? String(v) : null)),
  login: zLogin,
  full_name: zName,
  phone: zOptText(32),
  note: zOptText(2000),
  room_ids: z.union([z.array(zUuid), z.null(), z.undefined()]).transform((v) => (Array.isArray(v) ? Array.from(new Set(v)) : null)),
});

/* PATCH /api/staff — редагування картки співробітника (сесія 14).
   До цього картку не можна було правити ВЗАГАЛІ: у роуті був лише POST, а в
   StaffManager — пароль і кабінети. Опечатка в ПІБ чи телефоні лікувалась
   тільки «видалити акаунт і створити заново», а контактну пошту радіолога
   (0124) після створення вписати було нічим — і єдиний канал звʼязку з лікарем
   зникав назавжди (саме так вийшло з `zast2`: створений без email 27.07).

   Свідомо НЕ редагуються:
   - `login` — після створення акаунта не змінюється взагалі: /api/account/login
     править ЛИШЕ власний рядок (`.eq("id", user.id)`), а /setup доступний тільки
     адміну. Дати адміну змінювати чужий логін = ще один резолв унікальності й
     ще один шлях відібрати людині вхід; поки що чесніше сказати «перестворіть».
   - `email` — це адреса ВХОДУ в auth.users. Її зміна вимагає синхронно правити
     auth.users і profiles, а атомарності між Auth API і базою немає: збій
     посередині лишає людину без входу (та сама причина, через яку в 0124
     службова адреса радіолога стала випадковою);
   - `role`, `clinic_id`, `approved`, `password_set`, `invite_token` — службові.
   Список колонок нижче — БІЛИЙ, а не «все, крім». Роут ходить під service-role,
   тобто `guard_profile_privileges` його пропускає (auth.uid() = NULL), і БД тут
   не підстрахує.

   Семантика справжнього PATCH: ключа немає в тілі → колонку НЕ чіпаємо (канон
   0061 з room_ids, розрізняється через parseJson по сирому обʼєкту). Інакше
   будь-який наступний клієнт, що надішле скорочене тіло, мовчки занулив би
   телефон, примітку й контактну пошту — а саме через втрату контактної пошти
   ця ручка й зʼявилась. `""` у полі — це явне стирання, і воно навмисне. */
const sStaffPatch = z.object({
  userId: zUuid,
  full_name: zName.optional(),
  phone: zOptText(32).optional(),
  note: zOptText(2000).optional(),
  // Порожній рядок = «стерти пошту», а не «помилка формату».
  contact_email: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.union([zEmail, z.null()]),
  ).optional(),
});

export async function PATCH(req: Request) {
  const gate = await requireRole(["admin"], {
    needClinic: true,
    forbidden: "Лише адміністратор",
    rateLimit: { key: "acct:edit", max: 120, windowSeconds: 3600 },
  });
  if (!gate.ok) return gate.res;
  const { me } = gate;

  const raw: unknown = await req.json().catch(() => ({}));
  const parsed = parseJson("api/staff.patch", raw, sStaffPatch,
    "Перевірте поля: ПІБ (до 200), email (коректний), телефон (до 32), примітка (до 2000)");
  if (!parsed.ok) return parsed.res;
  const { userId } = parsed.data;
  const sent = (k: string) =>
    typeof raw === "object" && raw !== null && Object.prototype.hasOwnProperty.call(raw, k);

  const admin = createAdminClient();
  const { data: target } = await admin
    .from("profiles").select("clinic_id, role").eq("id", userId).single();
  if (!target) return NextResponse.json({ error: "Профіль не знайдено" }, { status: 404 });

  /* Персонал СВОГО центру і лише персонал. Адміна (в тому числі себе), CEO й
     направника цей роут не чіпає: у них свої картки й свої правила членства
     (ceo_access / referral_access), а тут гейт — простий clinic_id. */
  if ((target.role !== "radiologist" && target.role !== "registrar")
      || target.clinic_id !== me.clinic_id) {
    return NextResponse.json({ error: "Немає прав редагувати цей акаунт" }, { status: 403 });
  }

  const contactEmail = parsed.data.contact_email ?? null;
  /* contact_email має сенс лише в радіолога: у реєстратора `email` і є
     справжньою поштою (вона ж адреса входу), і друга «контактна» поруч читалась
     би як робочий канал, якого ніхто не читає. */
  if (sent("contact_email") && target.role !== "radiologist" && contactEmail) {
    return NextResponse.json(
      { error: "Контактна пошта — лише для радіолога; у реєстратора email є адресою входу" },
      { status: 400 },
    );
  }
  // Службова адреса в полі «для звʼязку» — це лист у нікуди: домен наш, поштової
  // скриньки за ним не існує. Той самий захист, що в POST.
  if (contactEmail && isTechnicalEmail(contactEmail)) {
    return NextResponse.json({ error: "Ця адреса службова — вкажіть справжню пошту" }, { status: 400 });
  }

  const patch: { full_name?: string; phone?: string | null; note?: string | null; contact_email?: string | null } = {};
  if (sent("full_name") && parsed.data.full_name !== undefined) patch.full_name = parsed.data.full_name;
  if (sent("phone")) patch.phone = parsed.data.phone ?? null;
  if (sent("note")) patch.note = parsed.data.note ?? null;
  // Реєстратору колонку не чіпаємо навіть при `null`: у нього її просто немає сенсу.
  if (sent("contact_email") && target.role === "radiologist") patch.contact_email = contactEmail;

  // Порожній patch — це не «успішно нічого не зробили»: PostgREST на update без
  // колонок відповість помилкою, а клієнт покаже «збережено». Ловимо тут.
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Немає що зберігати" }, { status: 400 });
  }

  const { error: uErr } = await admin.from("profiles").update(patch).eq("id", userId);
  if (uErr) return NextResponse.json({ error: safeDbError("api/staff.patch", uErr) }, { status: 400 });

  return NextResponse.json({ ok: true });
}

// POST /api/staff — адміністратор створює акаунт радіолога / лікаря-направника.
// Пароль НЕ задається: користувач встановлює його сам на /set-password
// (тимчасовий випадковий пароль ставимо лише щоб акаунт був валідним).
export async function POST(req: Request) {
  // Роут СТВОРЮЄ auth-акаунт → ліміт per-admin (скомпрометований акаунт інакше
  // за хвилину наробить тисячі користувачів: квота Supabase, рахунок, сміття).
  const gate = await requireRole(["admin"], {
    needClinic: true,
    forbidden: "Лише адміністратор",
    rateLimit: { key: "acct:create", max: 30, windowSeconds: 3600 },
  });
  if (!gate.ok) return gate.res;
  const { me } = gate;

  /* Персонал ЦЕНТРУ: радіолог або реєстратор (обидва мають clinic_id).
     Лікарі-направники мають ГЛОБАЛЬНИЙ акаунт (clinic_id = NULL) і створюються
     через /api/referrers/invite — інакше ламається tenant-модель направника
     (членство через referral_access). Адміна створює лише реєстрація центру.

     Реєстратор довго був «мертвою» роллю: enum і маршрути були, RLS (0073) теж,
     а створити акаунт не було чим — уся реєстратура сиділа під адміном. */
  const parsed = await parseBody("api/staff", req, sStaff, "Заповніть логін, ПІБ та email (коректний)");
  if (!parsed.ok) return parsed.res;
  const { role, login, full_name: fullName, phone, note } = parsed.data;
  const inputEmail = parsed.data.email;

  /* 0124 — рішення власника: радіолог входить ЛИШЕ за логіном.
     Адреса входу в нього службова і ВИПАДКОВА (rad.<hex>@…): її не знає ні він,
     ні адмін, і вивести з логіна не можна — тож увійти по пошті нічим. Справжню пошту, якщо адмін її
     вказав, зберігаємо окремо в contact_email — інакше втрачаємо єдиний канал
     звʼязку з лікарем. Той самий канон, що в направників (0041) і CEO.
     Реєстратор — навпаки: у нього справжня адреса, і вхід по email лишається. */
  const isRad = role === "radiologist";
  if (!isRad && !inputEmail) {
    return NextResponse.json({ error: "Вкажіть email — реєстратор входить логіном або поштою" }, { status: 400 });
  }
  /* Службові адреси — не для вводу ззовні. Реєстратор із адресою
     @radiologist.radflow.local втратив би вхід по пошті (її глушить
     /api/auth/login), хоча форма обіцяє протилежне. */
  if (inputEmail && !isRad && isTechnicalEmail(inputEmail)) {
    return NextResponse.json({ error: "Ця адреса службова — вкажіть справжню пошту" }, { status: 400 });
  }
  // Адреса радіолога ВИПАДКОВА, не похідна від логіна: інакше вона вгадується
  // з логіна, а зміна логіна вимагала б синхронно правити auth.users (див. lib/login).
  const email = isRad ? randomRadiologistEmail() : (inputEmail as string);
  const contactEmail = isRad ? inputEmail : null;
  const workplace: string | null = null; // лише радіологи; поле workplace — для направників
  const roomIds: string[] = role === "radiologist" ? (parsed.data.room_ids ?? []) : []; // кабінети — лише радіологам

  const admin = createAdminClient();

  /* Кабінети мають належати клініці адміна. Раніше room_id брався з тіла запиту
     як є (service-role обходить RLS) — так у radiologist_rooms могли осісти
     чужі/видалені кабінети. Сусідній роут /api/staff/rooms так уже перевіряє.
     Робимо ДО створення auth-акаунта, щоб не лишати «сирітський» акаунт. */
  if (roomIds.length) {
    const { data: okRooms } = await admin
      .from("rooms").select("id").eq("clinic_id", me.clinic_id).in("id", roomIds);
    const okSet = new Set((okRooms || []).map((r) => r.id));
    if (roomIds.some((id) => !okSet.has(id))) {
      return NextResponse.json({ error: "Кабінет не належить вашому центру" }, { status: 400 });
    }
  }
  const tempPass = "Rf!" + crypto.randomUUID().replace(/-/g, "");
  // Одноразовий токен для безпечного встановлення пароля (/set-password?token=…).
  const inviteToken = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");

  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    password: tempPass,
    user_metadata: { managed: "true", login },
  });
  if (cErr || !created?.user) {
    const msg = cErr?.message || "";
    return NextResponse.json(
      { error: /registered|already|exists/i.test(msg)
          ? (isRad ? "Не вдалося створити акаунт — спробуйте ще раз" : "Email вже використовується")
          : safeDbError("api/staff.createUser", cErr) },
      { status: 400 }
    );
  }

  const uid = created.user.id;
  const { error: pErr } = await admin.from("profiles").insert({
    id: uid, clinic_id: me.clinic_id, role, login, full_name: fullName,
    email, contact_email: contactEmail, phone, note, workplace,
    approved: true, password_set: false, invite_token: inviteToken,
  });
  if (pErr) {
    await admin.auth.admin.deleteUser(uid); // відкат, щоб не лишати «сирітський» auth-акаунт
    return NextResponse.json(
      { error: /login/i.test(pErr.message) && /unique|duplicate/i.test(pErr.message) ? "Логін вже зайнятий" : safeDbError("api/staff.profile", pErr) },
      { status: 400 }
    );
  }

  // Помилку призначення кабінетів раніше мовчки ковтали: акаунт створювався, а
  // радіолог лишався без кабінетів — і ніхто про це не дізнавався.
  let roomsWarning: string | null = null;
  if (role === "radiologist" && roomIds.length) {
    const { error: rErr } = await admin.from("radiologist_rooms").insert(
      roomIds.map((rid) => ({ clinic_id: me.clinic_id as string, profile_id: uid, room_id: rid }))
    );
    if (rErr) {
      safeDbError("api/staff.rooms", rErr);   // деталі — в лог, користувачу лише факт
      roomsWarning = "Акаунт створено, але кабінети не призначились. Призначте їх у картці радіолога.";
    }
  }

  return NextResponse.json({ ok: true, id: uid, invite_token: inviteToken, warning: roomsWarning });
}
