"use client";

import { useRouter } from "next/navigation";
import { signOutAndRedirect } from "@/lib/auth";

export default function SignOutButton() {
  const router = useRouter();

  async function signOut() {
    await signOutAndRedirect(router);
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
