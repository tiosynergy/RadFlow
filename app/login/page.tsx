import { Suspense } from "react";
import LoginPage from "@/components/LoginPage";

/* W-17 (WCAG 2.4.2): у кожної сторінки своя назва вкладки — до цього всі звались «RadFlow». */
export const metadata = { title: "Вхід — RadFlow" };

export default function Login() {
  return (
    <Suspense fallback={null}>
      <LoginPage />
    </Suspense>
  );
}
