// Cloudflare Pages Functions: Shared Authentication Utilities

const AUTH_COOKIE_NAME = "lpsg_auth_session";

/**
 * Derives a deterministic cryptographic token from the app password using Web Crypto.
 * @param {string} password 
 * @returns {Promise<string>} Hex-encoded SHA-256 token
 */
export async function computeAuthToken(password) {
  const enc = new TextEncoder().encode(password + ":lpsg_session_auth_v1_secure_salt");
  const hashBuffer = await crypto.subtle.digest("SHA-256", enc);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Gets the configured password from environment variables.
 * @param {object} env Cloudflare environment bindings
 * @returns {string}
 */
export function getAppPassword(env) {
  return (env && env.APP_PASSWORD && typeof env.APP_PASSWORD === 'string') 
    ? env.APP_PASSWORD.trim() 
    : "";
}

/**
 * Parses cookies from the Request headers.
 * @param {Request} request 
 * @returns {Record<string, string>}
 */
export function parseCookies(request) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = {};
  cookieHeader.split(";").forEach(part => {
    const [key, ...val] = part.trim().split("=");
    if (key) {
      cookies[key.trim()] = decodeURIComponent(val.join("=").trim());
    }
  });
  return cookies;
}

/**
 * Validates if the request has a valid permanent authentication cookie.
 * @param {Request} request 
 * @param {object} env 
 * @returns {Promise<boolean>}
 */
export async function isAuthenticated(request, env) {
  const appPassword = getAppPassword(env);
  if (!appPassword) return false;

  const cookies = parseCookies(request);
  const sessionToken = cookies[AUTH_COOKIE_NAME];
  if (!sessionToken) return false;

  const expectedToken = await computeAuthToken(appPassword);
  return sessionToken === expectedToken;
}

/**
 * Builds the Set-Cookie header string for a permanent session.
 * Max-Age is 10 years (315,360,000 seconds) - effectively never expires.
 * @param {string} token 
 * @param {boolean} isHttps 
 * @returns {string}
 */
export function createSessionCookie(token, isHttps = false) {
  const secureFlag = isHttps ? "; Secure" : "";
  return `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=315360000; HttpOnly; SameSite=Lax${secureFlag}`;
}

/**
 * Builds the Set-Cookie header to clear the session cookie.
 * @returns {string}
 */
export function createClearSessionCookie() {
  return `${AUTH_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}
