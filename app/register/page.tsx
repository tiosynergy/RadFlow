import RegisterPage from "@/components/RegisterPage";

/* W-17 (WCAG 2.4.2): у кожної сторінки своя назва вкладки — до цього всі звались «RadFlow». */
export const metadata = { title: "Реєстрація — RadFlow" };

export default function Register() {
  return <RegisterPage />;
}
