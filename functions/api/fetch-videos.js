import {
  mapWithConcurrency,
  fetchWithTimeout,
  fetchTextWithTimeout,
  backoffDelay,
  parseRetryAfter,
  sleep
} from '../_net.js';

// Permanent in-memory cache for resolved thread URLs (persists across requests in warm Cloudflare Workers isolates)
const threadCache = new Map();
// Positive-only cache of verified CDN extensions, keyed by `${userId}/${hash}` (no TTL — a resolved file keeps its extension)
const extCache = new Map();
// Single-flight map: collapses concurrent identical requests onto one in-progress fetch
const inFlight = new Map();
// Short-lived negative cache so a hard failure isn't hammered on every retry
const negativeCache = new Map();

const POOL_SIZE = 4;              // max concurrent CDN HEAD probes (headroom under Cloudflare's 6-connection cap)
const MAX_SUBREQUESTS = 45;       // budget below the 50-subrequest/invocation free-plan cap (reserve for page fetch + redirects)
const MAX_ALT_PROBES = 4;         // politeness cap on the per-file extension walk (budget is the hard global cap)
const HEAD_TIMEOUT_MS = 4000;
const PAGE_TIMEOUT_MS = 8000;
const BACKOFF_BASE = 500;
const BACKOFF_CAP = 8000;
const RETRY_AFTER_CAP_MS = 10000;
const MAX_TOTAL_BACKOFF_MS = 6000; // ceiling on cumulative sleeping across page-fetch retries
const MAX_403_RETRIES = 1;         // a WAF 403 won't clear in seconds — retry at most once, and only when authenticated
const NEG_TTL_MS = 60000;
const THREAD_CACHE_MAX = 500;
const EXT_CACHE_MAX = 2000;
const NEG_CACHE_MAX = 200;

const CDN_HEAD_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Referer': 'https://www.lpsg.com/'
};

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders }
  });
}

function evict(map, max) {
  if (map.size > max) {
    map.delete(map.keys().next().value);
  }
}

function setExtCache(key, ext) {
  extCache.set(key, ext);
  evict(extCache, EXT_CACHE_MAX);
}

function setNegativeCache(cacheKey, error, status) {
  negativeCache.set(cacheKey, { error, status, expiresAt: Date.now() + NEG_TTL_MS });
  evict(negativeCache, NEG_CACHE_MAX);
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const { url, cookies, refresh } = body;

    // Validate that the target is genuinely an LPSG host over http(s).
    // A substring test like url.includes('lpsg.com') is an SSRF hole: it accepts
    // any host as long as the string appears somewhere (e.g. http://evil/?lpsg.com).
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      parsedUrl = null;
    }
    const host = parsedUrl ? parsedUrl.hostname.toLowerCase() : '';
    const isLpsgHost = host === 'lpsg.com' || host.endsWith('.lpsg.com');
    const isHttp = parsedUrl && (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:');

    if (!parsedUrl || !isHttp || !isLpsgHost) {
      return json({ error: 'Invalid URL. Please provide an LPSG thread URL.' }, 400);
    }

    // Normalizing cache key based on URL (without fragment) and whether cookies are provided
    const normalizedUrl = url.trim().replace(/#.*$/, '');
    const cacheKey = `${normalizedUrl.toLowerCase()}::auth=${Boolean(cookies)}`;

    // Return permanently cached response if available and not forcing a refresh
    if (!refresh && threadCache.has(cacheKey)) {
      const entry = threadCache.get(cacheKey);
      return json({ ...entry.data, cached: true, cachedAt: entry.timestamp }, 200, { 'X-Cache': 'HIT' });
    }

    // A refresh discards any remembered failure and forces fresh work
    if (refresh) {
      negativeCache.delete(cacheKey);
      inFlight.delete(cacheKey);
    } else if (negativeCache.has(cacheKey)) {
      const neg = negativeCache.get(cacheKey);
      if (neg.expiresAt > Date.now()) {
        return json({ error: neg.error }, neg.status, { 'X-Cache': 'NEG' });
      }
      negativeCache.delete(cacheKey);
    }

    // Extract post ID from URL if present
    const postIdMatch = url.match(/post-(\d+)/);
    const postId = postIdMatch ? postIdMatch[1] : null;

    // Single-flight: coalesce concurrent identical requests onto one worker
    let work = inFlight.get(cacheKey);
    if (!work) {
      work = doFetchAndExtract({ url, cookies, postId, cacheKey }).finally(() => {
        // Only clear our own entry (a concurrent refresh may have replaced it)
        if (inFlight.get(cacheKey) === work) {
          inFlight.delete(cacheKey);
        }
      });
      inFlight.set(cacheKey, work);
    }

    const result = await work;
    if (!result.ok) {
      return json({ error: result.errorMsg }, result.status, { 'X-Cache': 'MISS' });
    }
    return json({ ...result.payload, cached: false }, 200, { 'X-Cache': 'MISS' });

  } catch (error) {
    return json({ error: error.message || 'Internal server error' }, 500);
  }
}

// Fetches the thread page (with polite retry), extracts + resolves videos, and
// writes the positive/negative caches. Returns a structured result the handler
// turns into a Response. Runs under a single per-invocation subrequest budget.
async function doFetchAndExtract({ url, cookies, postId, cacheKey }) {
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
    'Cache-Control': 'max-age=0'
  };
  if (cookies) {
    headers['Cookie'] = cookies;
  }

  const budget = { used: 0, cap: MAX_SUBREQUESTS };

  // --- Polite retry loop for the thread page fetch ---
  // 429 -> honor Retry-After (clamped) else jittered backoff; 5xx/network -> jittered backoff;
  // 403 -> retry at most once and only when authenticated (a WAF block won't clear in seconds).
  let response = null;
  let html = null;
  let lastStatus = null;
  let spentMs = 0;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (budget.used >= budget.cap) break;
    budget.used++;
    try {
      const res = await fetchTextWithTimeout(url, { headers, redirect: 'follow' }, PAGE_TIMEOUT_MS);
      response = res.response;
      lastStatus = response.status;
      if (response.ok) {
        html = res.text;
        break;
      }

      let waitMs = null;
      const status = response.status;
      if (status === 429 && attempt < maxAttempts) {
        const ra = parseRetryAfter(response.headers.get('retry-after'), RETRY_AFTER_CAP_MS);
        waitMs = ra != null ? ra : backoffDelay(attempt, BACKOFF_BASE, BACKOFF_CAP);
      } else if (status >= 500 && attempt < maxAttempts) {
        waitMs = backoffDelay(attempt, BACKOFF_BASE, BACKOFF_CAP);
      } else if (status === 403 && cookies && attempt <= MAX_403_RETRIES) {
        waitMs = backoffDelay(attempt, BACKOFF_BASE, BACKOFF_CAP);
      }

      if (waitMs != null && spentMs + waitMs <= MAX_TOTAL_BACKOFF_MS) {
        await sleep(waitMs);
        spentMs += waitMs;
        response = null; // not a usable result; keep retrying
        continue;
      }
      break; // terminal non-ok response
    } catch (err) {
      response = null;
      lastStatus = null;
      if (attempt < maxAttempts) {
        const waitMs = backoffDelay(attempt, BACKOFF_BASE, BACKOFF_CAP);
        if (spentMs + waitMs <= MAX_TOTAL_BACKOFF_MS) {
          await sleep(waitMs);
          spentMs += waitMs;
          continue;
        }
      }
      break; // terminal network/timeout error
    }
  }

  if (!response || !response.ok || html == null) {
    const status = lastStatus || 502;
    let errorMsg = `Failed to fetch page: ${status}`;
    if (status === 403) {
      errorMsg = 'LPSG returned 403 (Forbidden). Cloudflare protection or rate-limit active. Please ensure your LPSG cookies are connected or wait a moment.';
    }
    setNegativeCache(cacheKey, errorMsg, 502);
    return { ok: false, status: 502, errorMsg };
  }

  // If post ID specified, extract only that post's content
  let contentToSearch = html;
  if (postId) {
    contentToSearch = extractPostContent(html, postId);
  }

  let videos = await extractVideos(contentToSearch, postId, html, budget);

  // Resilient fallback: If post ID was specified but yielded 0 videos, search the entire page
  if (postId && videos.length === 0) {
    videos = await extractVideos(html, null, html, budget);
  }

  const payload = {
    videos,
    postId: postId || 'all',
    totalFound: videos.length,
    // true when the subrequest budget was exhausted before every extension was verified
    partial: budget.used >= budget.cap
  };

  // Store successful extractions in cache
  if (videos && videos.length > 0) {
    threadCache.set(cacheKey, { data: payload, timestamp: Date.now() });
    evict(threadCache, THREAD_CACHE_MAX);
  }

  return { ok: true, payload };
}

function extractPostContent(html, postId) {
  // LPSG/XenForo uses article elements with data-content="post-XXXXXX" and id="js-post-XXXXXX"
  // Example: <article class="message message--post js-post js-inlineModContainer" data-author="WLC" data-content="post-196556241" id="js-post-196556241">...</article>

  // 1. Direct match on full <article> element for this post
  const articlePattern = new RegExp(
    `<article[^>]*(?:data-content=["']post-${postId}["']|id=["'](?:js-)?post-${postId}["'])[^>]*>[\\s\\S]*?</article>`,
    'i'
  );
  const articleMatch = html.match(articlePattern);
  if (articleMatch) {
    return articleMatch[0];
  }

  // 2. Starting at post identifier, search backward for <article and forward to next post
  const postMarkerPattern = new RegExp(`(?:data-content=["']post-${postId}["']|id=["'](?:js-)?post-${postId}["'])`, 'i');
  const postMarkerIndex = html.search(postMarkerPattern);
  if (postMarkerIndex !== -1) {
    const preChunk = html.substring(Math.max(0, postMarkerIndex - 500), postMarkerIndex);
    const artOpenIdx = preChunk.lastIndexOf('<article');
    const startIdx = artOpenIdx !== -1 ? Math.max(0, postMarkerIndex - 500) + artOpenIdx : postMarkerIndex;

    const sub = html.substring(startIdx);
    const nextPostRelIdx = sub.substring(100).search(/<article[^>]+(?:js-post|data-content=["']post-)/i);
    if (nextPostRelIdx !== -1) {
      return sub.substring(0, nextPostRelIdx + 100);
    }
    const endArtIdx = sub.indexOf('</article>');
    if (endArtIdx !== -1) {
      return sub.substring(0, endArtIdx + 10);
    }
    return sub.substring(0, 50000);
  }

  // If no post found, return original HTML
  return html;
}

async function extractVideos(html, postId, fullHtml = null, budget = null) {
  const rawCandidates = [];
  const foundHashes = new Set();

  // Pattern 1: Attachment links with their poster images
  // Matches both relative (/attachments/...) and absolute (https://www.lpsg.com/attachments/...)
  const posterAttachPattern = /<a[^>]*href=["']((?:https?:\/\/[^"'\s\/]+)?\/attachments\/([^"'\s]+)\.(\d+)\/?)["'][^>]*>([\s\S]*?<img[^>]*(?:data-src|src)=["']([^"']*(?:cdn-videos\.lpsg\.com|lpsg\.com)\/data\/attachments\/(?:posters\/)?(\d+)\/(\d+-[a-f0-9]+)\.\w+)["'][\s\S]*?)<\/a>/gi;
  let match;

  while ((match = posterAttachPattern.exec(html)) !== null) {
    const [, attachmentUrl, slug, attachId, innerContent, posterUrl, userId, hash] = match;

    if (foundHashes.has(hash)) continue;
    foundHashes.add(hash);

    const { ext: candidateExt, confidence } = classifyExtension(attachmentUrl, posterUrl, `${slug} ${innerContent}`);
    rawCandidates.push({
      type: 'video',
      posterUrl: posterUrl.startsWith('http') ? posterUrl : `https:${posterUrl}`,
      attachmentUrl: attachmentUrl.startsWith('http') ? attachmentUrl : `https://www.lpsg.com${attachmentUrl}`,
      userId,
      hash,
      candidateExt,
      confidence
    });
  }

  // Pattern 1b: Quoted attachment links (e.g. View attachment 179231441 or /attachments/179231441/post)
  if (fullHtml) {
    const quotedAttachPattern = /(?:\/attachments\/(\d+)\/post|View attachment\s+(\d+)|href=["'][^"']*\/attachments\/(\d+)\/?["'])/gi;
    let quoteMatch;
    while ((quoteMatch = quotedAttachPattern.exec(html)) !== null) {
      const quotedAttachId = quoteMatch[1] || quoteMatch[2] || quoteMatch[3];
      if (!quotedAttachId) continue;

      const pageAttachRegex = new RegExp(
        `<a[^>]*href=["']((?:https?:\\/\\/[^"'\\s\\/]+)?\\/attachments\\/([^"'\\s]+)\\.${quotedAttachId}\\/?)["'][^>]*>([\\s\\S]*?<img[^>]*(?:data-src|src)=["']([^"']*(?:cdn-videos\\.lpsg\\.com|lpsg\\.com)\\/data\\/attachments\\/(?:posters\\/)?(\\d+)\\/(\\d+-[a-f0-9]+)\\.\\w+)["'][\\s\\S]*?)<\\/a>`,
        'i'
      );
      const pageMatch = fullHtml.match(pageAttachRegex);
      if (pageMatch) {
        const [, attachmentUrl, slug, innerContent, posterUrl, userId, hash] = pageMatch;
        if (!foundHashes.has(hash)) {
          foundHashes.add(hash);
          const { ext: candidateExt, confidence } = classifyExtension(attachmentUrl, posterUrl, `${slug} ${innerContent}`);
          rawCandidates.push({
            type: 'video',
            posterUrl: posterUrl.startsWith('http') ? posterUrl : `https:${posterUrl}`,
            attachmentUrl: attachmentUrl.startsWith('http') ? attachmentUrl : `https://www.lpsg.com${attachmentUrl}`,
            userId,
            hash,
            candidateExt,
            confidence
          });
        }
      }
    }
  }

  // Pattern 2: Direct CDN video URLs in HTML — the extension is copied from a live
  // CDN link, so it is trustworthy and needs no verifying probe.
  const cdnVideoPattern = /cdn-videos\.lpsg\.com\/data\/video\/(\d+)\/(\d+-[a-f0-9]+)\.(mp4|mov|webm|avi|mkv)/gi;
  while ((match = cdnVideoPattern.exec(html)) !== null) {
    const [, userId, hash, ext] = match;
    if (foundHashes.has(hash)) continue;
    foundHashes.add(hash);

    rawCandidates.push({
      type: 'cdn-direct',
      userId,
      hash,
      candidateExt: ext.toLowerCase(),
      confidence: 'certain'
    });
  }

  // Pattern 3: Attachment links without poster images
  const attachmentOnlyPattern = /<a[^>]*href="((?:https?:\/\/[^"\/]+)?\/attachments\/([^"]+)\.(\d+)\/)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = attachmentOnlyPattern.exec(html)) !== null) {
    const [, attachmentUrl, filename, attachId, innerContent] = match;

    const lower = `${filename} ${innerContent}`.toLowerCase();
    if (!lower.match(/\.(mp4|mov|webm|avi|mkv|rpreplay|ap-mp4)/)) continue;

    // Try to find associated poster image nearby
    const nearbyContent = html.substring(match.index, match.index + 800);
    const posterMatch = nearbyContent.match(/cdn-videos\.lpsg\.com\/data\/attachments\/(?:posters\/)?(\d+)\/(\d+-[a-f0-9]+)\.\w+/i);

    if (posterMatch) {
      const [, userId, hash] = posterMatch;
      if (foundHashes.has(hash)) continue;
      foundHashes.add(hash);

      const { ext: candidateExt, confidence } = classifyExtension(attachmentUrl, '', lower);
      rawCandidates.push({
        type: 'video',
        posterUrl: `https://cdn-videos.lpsg.com/data/attachments/posters/${userId}/${hash}.jpg`,
        attachmentUrl: attachmentUrl.startsWith('http') ? attachmentUrl : `https://www.lpsg.com${attachmentUrl}`,
        userId,
        hash,
        candidateExt,
        confidence
      });
    }
  }

  // Pattern 4: Poster images only (fallback)
  const posterPattern = /cdn-videos\.lpsg\.com\/data\/attachments\/(?:posters\/)?(\d+)\/(\d+-[a-f0-9]+)\.(jpg|jpeg|png)/gi;
  while ((match = posterPattern.exec(html)) !== null) {
    const [, userId, hash] = match;
    if (foundHashes.has(hash)) continue;
    foundHashes.add(hash);

    const surrounding = html.substring(Math.max(0, match.index - 1000), Math.min(html.length, match.index + 1000));
    const { ext: candidateExt, confidence } = classifyExtension('', '', surrounding);

    rawCandidates.push({
      type: 'poster-derived',
      posterUrl: `https://cdn-videos.lpsg.com/data/attachments/posters/${userId}/${hash}.jpg`,
      userId,
      hash,
      candidateExt,
      confidence
    });
  }

  // Validate/resolve the real working CDN extension for all candidates with a
  // bounded worker pool (never an unbounded burst at the CDN).
  const videos = await mapWithConcurrency(rawCandidates, POOL_SIZE, async (item) => {
    const resolved = await resolveExt(item.userId, item.hash, item.candidateExt, item.confidence, budget);
    return {
      type: item.type,
      url: `https://cdn-videos.lpsg.com/data/video/${item.userId}/${item.hash}.${resolved.ext}`,
      posterUrl: item.posterUrl,
      attachmentUrl: item.attachmentUrl,
      userId: item.userId,
      hash: item.hash,
      extension: resolved.ext,
      verified: resolved.verified
    };
  });

  return videos;
}

// Classifies the likely CDN extension AND how much to trust it, mapping the
// existing detection tiers to a confidence level:
//   certain  -> copied from a live CDN URL (caller sets this directly)
//   high     -> explicit extension token, XenForo slug, or rpreplay(->mov)
//   low      -> keyword-only guess or bare mp4 fallback
function classifyExtension(attachmentPath, posterUrl, contextStr = '') {
  const combined = `${attachmentPath} ${posterUrl} ${contextStr}`.toLowerCase();

  // 1. Explicit extension in alt, title, data-name, or filename
  const explicitExt = combined.match(/\.(mov|mp4|webm|mkv|avi|m4v|wmv|flv)\b/i);
  if (explicitExt) {
    return { ext: explicitExt[1].toLowerCase(), confidence: 'high' };
  }

  // 2. XenForo slug format: ...-mov.12345 or ...-mp4.12345 or ...-webm.12345
  const slugExt = combined.match(/[-_.](mov|mp4|webm|mkv|avi|m4v|wmv|flv)\.\d+/i);
  if (slugExt) {
    return { ext: slugExt[1].toLowerCase(), confidence: 'high' };
  }

  // 3. iOS Screen Recording indicator (always .mov)
  if (combined.includes('rpreplay')) {
    return { ext: 'mov', confidence: 'high' };
  }

  // 4. Keyword matches in slug/context (weaker signal)
  if (combined.includes('-mov') || combined.includes('.mov')) return { ext: 'mov', confidence: 'low' };
  if (combined.includes('-webm') || combined.includes('.webm')) return { ext: 'webm', confidence: 'low' };
  if (combined.includes('-mkv') || combined.includes('.mkv')) return { ext: 'mkv', confidence: 'low' };
  if (combined.includes('-avi') || combined.includes('.avi')) return { ext: 'avi', confidence: 'low' };
  if (combined.includes('-mp4') || combined.includes('.mp4') || combined.includes('ap-mp4')) return { ext: 'mp4', confidence: 'low' };

  return { ext: 'mp4', confidence: 'low' }; // fallback candidate
}

function dedupe(arr) {
  return arr.filter((v, i, a) => a.indexOf(v) === i);
}

// Resolves the working CDN extension for one file, minimizing HEAD probes:
//   - extCache hit or `certain` confidence  -> 0 probes
//   - otherwise verify the candidate with 1 HEAD
//   - on 404, walk a small prevalence-ordered set of alternates (bounded)
// The `budget` is reserved synchronously before each probe (reserve-then-await),
// so the pool of workers can never overshoot the per-invocation subrequest cap.
// Only verified (positive) results are cached — a 404 may be transient/auth-gated.
async function resolveExt(userId, hash, candidateExt, confidence, budget) {
  const key = `${userId}/${hash}`;

  const cached = extCache.get(key);
  if (cached) {
    return { ext: cached, verified: true };
  }

  if (confidence === 'certain') {
    setExtCache(key, candidateExt);
    return { ext: candidateExt, verified: true };
  }

  // Reserve a subrequest slot, then probe. Returns true/false for a real HTTP
  // result, or null when we couldn't probe (budget exhausted or network/timeout).
  const headOk = async (ext) => {
    if (!budget || budget.used >= budget.cap) return null;
    budget.used++;
    try {
      const res = await fetchWithTimeout(
        `https://cdn-videos.lpsg.com/data/video/${userId}/${hash}.${ext}`,
        { method: 'HEAD', headers: CDN_HEAD_HEADERS },
        HEAD_TIMEOUT_MS
      );
      return res.ok;
    } catch {
      return null;
    }
  };

  const primary = await headOk(candidateExt);
  if (primary === true) {
    setExtCache(key, candidateExt);
    return { ext: candidateExt, verified: true };
  }
  if (primary === null) {
    return { ext: candidateExt, verified: false }; // couldn't probe → best-effort guess
  }

  // primary === false (404): walk a small, prevalence-ordered alternate set.
  const alternates = dedupe(['mp4', 'mov', 'webm', 'mkv', 'avi']).filter((e) => e !== candidateExt);
  let altProbes = 0;
  for (const altExt of alternates) {
    if (altProbes >= MAX_ALT_PROBES) break;
    const ok = await headOk(altExt);
    if (ok === null) break; // budget exhausted or network error → stop, fall back
    altProbes++;
    if (ok === true) {
      setExtCache(key, altExt);
      return { ext: altExt, verified: true };
    }
  }

  return { ext: candidateExt, verified: false };
}
