// Cloudflare Pages Function: /api/auth/logout
import { createClearSessionCookie } from "../../_auth.js";

export async function onRequest(context) {
  const cookieHeader = createClearSessionCookie();

  return new Response(
    JSON.stringify({ success: true, message: "Logged out successfully" }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": cookieHeader,
        "Cache-Control": "no-store",
      },
    }
  );
}
