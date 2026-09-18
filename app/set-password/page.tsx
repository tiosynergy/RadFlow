import SetPasswordPage from "@/components/SetPasswordPage";

/* W-17 (WCAG 2.4.2): у кожної сторінки своя назва вкладки — до цього всі звались «RadFlow». */
export const metadata = { title: "Встановлення пароля — RadFlow" };

export default function Page() {
  return <SetPasswordPage />;
}
