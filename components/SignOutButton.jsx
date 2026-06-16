"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function SignOutButton() {
  const router = useRouter();

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      onClick={signOut}
      style={{
        height: 40,
        padding: "0 18px",
        border: "1px solid #48484a",
        borderRadius: 10,
        background: "#3a3a3c",
        color: "#f5f5f7",
        fontSize: 14,
        fontWeight: 500,
        cursor: "pointer",
      }}
    >
      Вийти
    </button>
  );
}
