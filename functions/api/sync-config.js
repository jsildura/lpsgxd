// Cloudflare Pages Function: Public Firebase Sync Configuration Provider
// Safely provides client Firebase configuration if defined in Cloudflare environment variables.

export async function onRequestGet(context) {
  const { env } = context;

  let config = null;
  if (env && env.FIREBASE_CONFIG) {
    try {
      config = typeof env.FIREBASE_CONFIG === 'string'
        ? JSON.parse(env.FIREBASE_CONFIG)
        : env.FIREBASE_CONFIG;
    } catch (e) {
      console.warn('Failed to parse FIREBASE_CONFIG env variable:', e);
    }
  }

  return new Response(JSON.stringify({
    configured: Boolean(config),
    config: config || null
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}
