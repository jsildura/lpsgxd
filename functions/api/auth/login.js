// Cloudflare Pages Function: /api/auth/login
import { getAppPassword, computeAuthToken, createSessionCookie } from "../../_auth.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json().catch(() => ({}));
    const providedPassword = (body.password || "").toString().trim();

    const expectedPassword = getAppPassword(env);

    if (!providedPassword || providedPassword !== expectedPassword) {
      return new Response(
        JSON.stringify({ error: "Incorrect password. Please try again." }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        }
      );
    }

    // Generate secure deterministic session token
    const token = await computeAuthToken(expectedPassword);
    const url = new URL(request.url);
    const isHttps = url.protocol === "https:";
    const cookieHeader = createSessionCookie(token, isHttps);

    return new Response(
      JSON.stringify({ success: true, message: "Authenticated successfully" }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": cookieHeader,
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Authentication failed: " + err.message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") {
    return onRequestPost(context);
  }
  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { "Content-Type": "application/json" },
  });
}
