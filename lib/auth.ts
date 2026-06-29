import { createClient } from "@/lib/supabase/client";

// Спільний вихід з акаунта: завершити сесію і повернути на сторінку входу.
// Один источник правди замість дубльованого коду в Sidebar / SignOutButton / RadSidebar.
export async function signOutAndRedirect(router: { push: (href: string) => void; refresh: () => void }) {
  const supabase = createClient();
  await supabase.auth.signOut();
  router.push("/login");
  router.refresh();
}
