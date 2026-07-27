import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { clientIp, rateLimitOk, rlKey } from "@/lib/rateLimit";
import { parseBody } from "@/lib/validationHttp";
import { normalizeLogin, isValidLogin } from "@/lib/login";

const sCheck = z.object({ login: z.string().trim().min(1).max(64) });

/* POST /api/auth/login-available — чи вільний логін (публічно, до реєстрації).

   Навіщо: логін глобально унікальний, а при реєстрації центру він приходить у
   metadata і далі його обробляє тригер handle_new_user. Якщо логін зайнятий,
   тригер мовчки додає суфікс («ivanov» → «ivanov2»), бо інакше падає весь
   signUp із непрозорим «Database error saving new user». Але тоді людина
   реєструється з одним логіном, а входити мусить іншим — і ніде цього не
   бачить. Ця перевірка дає їй сказати про конфлікт ДО створення акаунта.

   Чому це не дірка енумерації: відповідь — булеве «вільний / зайнятий» і
   нічого більше. Ні email, ні ПІБ, ні ролі, ні факту існування конкретної
   людини. Логін — публічний ідентифікатор (його вводять при вході), а не
   секрет; на відміну від /api/auth/login, тут немає пари «логін+пароль», тож
   підбір нічого не відкриває. Але оракул існування акаунта — це все одно крок
   назад щодо 0032/0072 (де права на резолв логіна відкликали саме «за
   енумерацію»), тому ліміт стоїть подвійний: і за IP, і за самим логіном. */
export async function POST(req: Request) {
  const parsed = await parseBody("api/auth/login-available", req, sCheck, "Вкажіть логін");
  if (!parsed.ok) return parsed.res;

  const login = normalizeLogin(parsed.data.login);

  /* Два незалежні ліміти — рішення власника після ревʼю.

     За IP (10/5хв) — щоб з однієї точки не зібрали словник логінів центру.
     За САМИМ логіном (5/год, ключ — хеш) — щоб ротація IP не обходила перший:
     бот із тисячі адрес усе одно не перевірить один логін більше пʼяти разів
     на годину. Ключ хешуємо (rlKey) з тієї ж причини, що й на вході: інакше
     вміст і довжину первинного ключа rate_limits задає атакувальник.

     Ліміт свідомо низький: чесній людині при реєстрації вистачає двох-трьох
     перевірок, а різниця між «швидко» і «дуже швидко» тут нічого не варта. */
  const ip = clientIp(req);
  const [okIp, okLogin] = await Promise.all([
    rateLimitOk(`login-avail:ip:${ip}`, 10, 300),
    rateLimitOk(rlKey("login-avail:id", login), 5, 3600),
  ]);
  if (!okIp || !okLogin) {
    return NextResponse.json({ error: "Забагато перевірок. Зачекайте кілька хвилин." }, { status: 429 });
  }
  // Невалідний формат — не «зайнятий», а саме невалідний: інакше форма казала б
  // «логін зайнятий» на «Др. Іванов», і людина шукала б неіснуючого двійника.
  if (!isValidLogin(login)) return NextResponse.json({ ok: true, valid: false, available: false });

  if (!isAdminConfigured()) {
    // Без service-role перевірити нічим. Не блокуємо реєстрацію: віддаємо
    // «не знаємо», і форма просто не показує підказку.
    return NextResponse.json({ ok: true, valid: true, available: null });
  }
  const admin = createAdminClient();
  const { data, error } = await admin.from("profiles").select("id").eq("login", login).maybeSingle();
  /* Помилку НЕ ковтаємо: без цієї гілки протухлий service-role ключ дає 401,
     data === null, і роут упевнено відповідає «вільний». Людина реєструється з
     письмовим підтвердженням, що логін її, а тригер тим часом мовчки додає
     суфікс. Краще чесне «не знаю» — форма тоді просто не показує підказку. */
  if (error) return NextResponse.json({ ok: true, valid: true, available: null });
  return NextResponse.json({ ok: true, valid: true, available: !data });
}
