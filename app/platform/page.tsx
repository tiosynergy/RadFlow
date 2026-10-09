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
   на сервері). Без сесії → /login з поверненням; сесія без рядка оператора →
   /queue (клінічний контур сам розведе роль або вийде через /api/auth/reset);
   вимкнений оператор → відмова з кнопкою виходу (редірект дав би петлю з
   middleware, який веде оператора за прапорцем сюди). */
export default async function PlatformPage() {
  const { user, operator } = await platformSession();
  if (!user) redirect("/login?redirect=/platform");
  if (!operator) redirect("/queue");
  if (!operator.active) {
    return <RoleNotice title="Доступ оператора вимкнено" text="Ваш доступ до консолі платформи вимкнено іншим оператором. Якщо це помилка — зверніться до нього." />;
  }
  /* Suspense — під useSearchParams у клієнтській консолі (стан екрана живе в URL). */
  return (
    <Suspense fallback={null}>
      <PlatformConsole operator={{ id: operator.id, email: operator.email, full_name: operator.full_name }} />
    </Suspense>
  );
}
