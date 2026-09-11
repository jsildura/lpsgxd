import { fetchTextWithTimeout } from '../_net.js';

const SESSION_CHECK_TIMEOUT_MS = 8000;

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const { cookies } = body;

    if (!cookies) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'No cookies provided'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Inspect cookie string for known XenForo user ID if present
    // xf_user format is typically: {userId}%2C{token} or {userId},{token}
    let detectedUserId = null;
    const userMatch = cookies.match(/xf_user=([^;]+)/);
    if (userMatch) {
      const decoded = decodeURIComponent(userMatch[1]);
      const commaMatch = decoded.match(/^(\d+)[,%]/);
      if (commaMatch) {
        detectedUserId = commaMatch[1];
      }
    }

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cookie': cookies
    };

    const { response, text: html } = await fetchTextWithTimeout('https://www.lpsg.com/', { headers }, SESSION_CHECK_TIMEOUT_MS);

    if (!response.ok) {
      return new Response(JSON.stringify({
        ok: false,
        status: response.status,
        error: `LPSG returned HTTP ${response.status}`
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check XenForo logged-in indicators
    const isLoggedIn = html.includes('data-logged-in="true"') || 
                       html.includes('/account/') ||
                       html.includes('class="p-navgroup-link--user"') ||
                       Boolean(detectedUserId && !html.includes('data-logged-in="false"'));

    // Try to extract username if present
    let username = null;
    const usernameMatch = html.match(/<span class="p-navgroup-linkText">([^<]+)<\/span>/i) ||
                          html.match(/data-xf-init="tooltip" title="Your account">([^<]+)<\/a>/i) ||
                          html.match(/<a href="\/members\/[^"]*" class="[^"]*p-navgroup-link--user[^"]*">[\s\S]*?<span[^>]*>([^<]+)<\/span>/i);

    if (usernameMatch) {
      username = usernameMatch[1].trim();
    }

    return new Response(JSON.stringify({
      ok: true,
      status: response.status,
      loggedIn: isLoggedIn,
      username: username || (detectedUserId ? `User #${detectedUserId}` : null),
      userId: detectedUserId
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: error.message || 'Failed to connect to LPSG'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
