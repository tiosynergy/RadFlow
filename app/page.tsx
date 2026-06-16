import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Корінь сайту: ведемо на дошку (якщо увійшов) або на вхід.
// /queue сам перенаправляє за роллю (радіолог → /radiologist тощо).
export default async function Home() {
  const supabase = await createClient();
  const {
    data: { use