import { Suspense } from "react";
import { redirect } from "next/navigation";
import { platformSession } from "@/lib/platformAuth";
import PlatformConsole from "@/components/PlatformConsole";
import RoleNotice from "@/components/RoleNotice";

/* W-17 (WCAG 2.4.2): у кожної сторінки своя назва вкладки. */
export const metadata = { title: "Платформа — RadFlow" };
/* Завжди на запит: без env (клон без ключів) platformSession() повертається до
   cookies(), і Next пререндерив би редірект як статику. */
export const dynamic = "force-dynamic";

/* ===== /platform — консоль оператора платформи (0206, с84) =====
   Гейт ІНШОЇ форми, ніж у клінічних сторінок (tests/authSurface.test.ts, PLATFORM):
   у оператора немає профілю, тож голова «getUser → profiles» тут не підходить —
   право дає рядок `platform_operators` (lib/platformAuth.ts, service-role лише
   на сервері). Кожен стан сесії має РІВНО один наслідок, і жоден не веде туди,
   звідки middleware повернув би назад (ревʼю с84, лінза B — петля
   /platform ⇄ /queue, коли прапорець є, а рядка немає або він не прочитався):
     • сесії немає → /login з поверненням;
     • немає service-ключа / рядок не прочитався → екран із кнопкою виходу
       (редірект у /login чи /queue — петля з middleware);
     • сесія без рядка: з прапорцем оператора → /api/auth/reset (вихід і
       пояснення на /login), без прапорця → /queue (клінічний контур);
     • вимкнений оператор → відмова з кнопкою виходу. */
export default async function PlatformPage() {
  const s = await platformSession();
  if (s.state === "anonymous") redirect("/login?redirect=/platform");
  if (s.state === "unconfigured") {
    return <RoleNotice title="Сервер не налаштовано" text="На сервері немає SUPABASE_SERVICE_ROLE_KEY — консоль платформи без нього не працює. Зверніться до RadFlow." />;
  }
  if (s.state === "read_failed") {
    return <RoleNotice title="Тимчасова помилка" text="Не вдалося перевірити права оператора. Оновіть сторінку за хвилину; якщо не допомагає — вийдіть і увійдіть знову." />;
  }
  if (s.state === "stranger") redirect(s.claim ? "/api/auth/reset?reason=platform_missing" : "/queue");
  if (!s.operator.active) {
    return <RoleNotice title="Доступ оператора вимкнено" text="Ваш доступ до консолі платформи вимкнено іншим оператором. Якщо це помилка — зверніться до нього." />;
  }
  /* Suspense — під useSearchParams у клієнтській консолі (стан екрана живе в URL). */
  return (
    <Suspense fallback={null}>
      <PlatformConsole operator={{ id: s.operator.id, email: s.operator.email, full_name: s.operator.full_name }} />
    </Suspense>
  );
}
