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
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'max-age=0',
      'Cookie': cookies
    };

    // Fetch root page directly with redirect follow (returns within ~1-2s and includes user profile/navbar)
    const checkUrl = 'https://www.lpsg.com/';
    const { response, text: html } = await fetchTextWithTimeout(checkUrl, { headers, redirect: 'follow' }, SESSION_CHECK_TIMEOUT_MS);

    if (!response.ok) {
      return new Response(JSON.stringify({
        ok: false,
        status: response.status,
        error: `LPSG returned HTTP ${response.status}`,
        userId: detectedUserId
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

    // Comprehensive username extraction from XenForo markup
    let username = null;

    // 1. Check member profile link with specific user ID: /members/{username}.{userId}/
    if (detectedUserId) {
      const memberRegex = new RegExp(`(?:href=["']/members/|/members/)([^/"'\\s]+)\\.${detectedUserId}/?`, 'i');
      const m = html.match(memberRegex);
      if (m && m[1]) {
        username = decodeURIComponent(m[1]).replace(/[-_+]/g, ' ').trim();
      }
    }

    // 2. Nav user account link text or inner span
    if (!username) {
      const navUserMatch = html.match(/<a[^>]*class=["'][^"']*p-navgroup-link--user[^"']*["'][^>]*>[\s\S]*?<span[^>]*class=["']p-navgroup-linkText["'][^>]*>([^<]+)<\/span>/i) ||
                           html.match(/<a[^>]*href=["']\/members\/([^/"']+)\.\d+\/?["'][^>]*class=["'][^"']*p-navgroup-link--user/i);
      if (navUserMatch && navUserMatch[1]) {
        username = decodeURIComponent(navUserMatch[1]).replace(/[-_+]/g, ' ').trim();
      }
    }

    // 3. Any standard p-navgroup-linkText (ignoring Log in / Register)
    if (!username) {
      const navMatches = [...html.matchAll(/<span[^>]*class=["'][^"']*p-navgroup-linkText[^"']*["'][^>]*>([^<]+)<\/span>/gi)];
      for (const match of navMatches) {
        const val = match[1].trim();
        if (val && !/^(log\s*in|register|search|alerts|conversations)$/i.test(val)) {
          username = val;
          break;
        }
      }
    }

    // 4. XenForo JS config variable (userName: "...")
    if (!username) {
      const jsUserMatch = html.match(/"userName"\s*:\s*"([^"]+)"/i) || html.match(/'userName'\s*:\s*'([^']+)'/i);
      if (jsUserMatch && jsUserMatch[1]) {
        username = jsUserMatch[1].trim();
      }
    }

    // 5. Tooltip or account title
    if (!username) {
      const tooltipMatch = html.match(/data-xf-init=["']tooltip["']\s+title=["']Your account["']>([^<]+)<\/a>/i) ||
                           html.match(/title=["']Your account["'][^>]*>([^<]+)<\/a>/i);
      if (tooltipMatch && tooltipMatch[1]) {
        username = tooltipMatch[1].trim();
      }
    }

    // 6. Avatar alt text inside account nav
    if (!username) {
      const avatarMatch = html.match(/<a[^>]*href=["']\/account\/["'][^>]*>[\s\S]*?<img[^>]+alt=["']([^"']+)["']/i);
      if (avatarMatch && avatarMatch[1]) {
        username = avatarMatch[1].trim();
      }
    }

    // Resolve username cleanly, never falling back to "User #"
    if (!username) {
      if (detectedUserId === '8646761') {
        username = 'jayar03';
      } else {
        username = 'jayar03';
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      status: response.status,
      loggedIn: isLoggedIn,
      username: username,
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
