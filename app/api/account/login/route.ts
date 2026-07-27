import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/apiAuth";
import { parseBody } from "@/lib/validationHttp";
import { safeDbError, zLogin } from "@/lib/validation";

const sChangeLogin = z.object({ login: zLogin });

/* POST /api/account/login — зміна ВЛАСНОГО логіна (0124).

   Досі логін задавався один раз при створенні акаунта і більше не змінювався:
   для адміна — під час реєстрації центру, для персоналу — адміном у картці.
   Єдиним винятком був направник (/api/referral/profile). Тепер логін —
   обовʼязковий і рівноправний спосіб входу, тож можливість його виправити
   потрібна: у реєстрації центру логін підставляється ще й у назву клініки,
   і люди заводять там щось випадкове.

   Роут працює під service-role свідомо: тригер guard_profile_privileges (0064)
   забороняє міняти login з клієнтського ключа й пропускає лише auth.uid() IS NULL.
   Тому міняємо ЛИШЕ власний рядок (id = user.id) — інакше service-role тут
   перетворився б на mass-assignment.

   Направник сюди не ходить: у нього логін живе на екрані профілю разом із
   приватним email (/api/referral/profile), і дублювати цей шлях означало б два
   різні місця, де змінюється одне поле. */
export async function POST(req: Request) {
  const gate = await requireRole(["admin", "registrar", "radiologist", "ceo"], {
    forbidden: "Змінити логін може лише власник акаунта",
    // Логін — ідентифікатор входу: підбір вільного значення перебором тут не
    // потрібен нікому, а зайві зміни ламають людям звичку входу.
    rateLimit: { key: "acct:login", max: 10, windowSeconds: 3600 },
  });
  if (!gate.ok) return gate.res;
  const { user } = gate;

  const parsed = await parseBody("api/account/login", req, sChangeLogin, "Перевірте формат логіна");
  if (!parsed.ok) return parsed.res;
  const { login } = parsed.data;

  const admin = createAdminClient();

  /* Унікальність — дружнє повідомлення; жорстку гарантію дає profiles_login_uidx.
     Гонку двох одночасних запитів ловить саме індекс, тому нижче обробляємо
     й помилку UPDATE, а не покладаємось лише на цю перевірку. */
  const { data: dup } = await admin
    .from("profiles").select("id").eq("login", login).neq("id", user.id).maybeSingle();
  if (dup) return NextResponse.json({ error: "Логін вже зайнятий" }, { status: 409 });

  const { error } = await admin.from("profiles").update({ login }).eq("id", user.id);
  if (error) {
    const msg = error.message || "";
    if (/unique|duplicate/i.test(msg)) {
      return NextResponse.json({ error: "Логін вже зайнятий" }, { status: 409 });
    }
    if (/profiles_login_format_chk/i.test(msg)) {
      return NextResponse.json({ error: "Логін не відповідає формату" }, { status: 400 });
    }
    return NextResponse.json({ error: safeDbError("api/account/login", error) }, { status: 400 });
  }

  /* Адресу входу тут НЕ чіпаємо — і це головна причина, чому службова адреса
     радіолога випадкова, а не <login>@radiologist.radflow.local. Якби вона
     виводилась із логіна, цей роут мусив би оновити ще й auth.users.email;
     атомарності між Auth API і базою немає, і збій між двома викликами лишав
     би людину, яка не може увійти взагалі: логін новий, адреса стара.
     Тепер зміна логіна — один UPDATE одного рядка. */
  return NextResponse.json({ ok: true, login });
}
