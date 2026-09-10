// Permanent in-memory cache for resolved thread URLs (persists across requests in warm Cloudflare Workers isolates)
const threadCache = new Map();

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const { url, cookies, refresh } = body;

    if (!url || !url.includes('lpsg.com')) {
      return new Response(JSON.stringify({ 
        error: 'Invalid URL. Please provide an LPSG thread URL.' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Normalizing cache key based on URL (without fragment) and whether cookies are provided
    const normalizedUrl = url.trim().replace(/#.*$/, '');
    const cacheKey = `${normalizedUrl.toLowerCase()}::auth=${Boolean(cookies)}`;

    // Return permanently cached response if available and not forcing a refresh
    if (!refresh && threadCache.has(cacheKey)) {
      const entry = threadCache.get(cacheKey);
      return new Response(JSON.stringify({
        ...entry.data,
        cached: true,
        cachedAt: entry.timestamp
      }), {
        headers: {
          'Content-Type': 'application/json',
          'X-Cache': 'HIT'
        }
      });
    }

    // Extract post ID from URL if present
    const postIdMatch = url.match(/post-(\d+)/);
    const postId = postIdMatch ? postIdMatch[1] : null;

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

    // Attempt fetch with automatic retry on 403 / 429 / 5xx to absorb transient Cloudflare rate limits
    let response;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        response = await fetch(url, { headers, redirect: 'follow' });
        if (response.ok) {
          break;
        }
        // If LPSG returns 403 (Cloudflare WAF challenge/rate limit) or 429/5xx, wait briefly and retry
        if ((response.status === 403 || response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, attempt * 1200));
          continue;
        }
      } catch (err) {
        if (attempt < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, attempt * 1000));
          continue;
        }
        throw err;
      }
    }

    if (!response || !response.ok) {
      const status = response ? response.status : 502;
      let errorMsg = `Failed to fetch page: ${status}`;
      if (status === 403) {
        errorMsg = 'LPSG returned 403 (Forbidden). Cloudflare protection or rate-limit active. Please ensure your LPSG cookies are connected or wait a moment.';
      }
      return new Response(JSON.stringify({ 
        error: errorMsg 
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const html = await response.text();
    
    // If post ID specified, extract only that post's content
    let contentToSearch = html;
    if (postId) {
      contentToSearch = extractPostContent(html, postId);
    }
    
    let videos = await extractVideos(contentToSearch, postId, html);

    // Resilient fallback: If post ID was specified but yielded 0 videos, search the entire page
    if (postId && videos.length === 0) {
      videos = await extractVideos(html, null, html);
    }

    const payload = { 
      videos,
      postId: postId || 'all',
      totalFound: videos.length 
    };

    // Store successful extractions in cache
    if (videos && videos.length > 0) {
      threadCache.set(cacheKey, {
        data: payload,
        timestamp: Date.now()
      });
      if (threadCache.size > 500) {
        const oldest = threadCache.keys().next().value;
        threadCache.delete(oldest);
      }
    }

    return new Response(JSON.stringify({ 
      ...payload,
      cached: false
    }), {
      headers: {
        'Content-Type': 'application/json',
        'X-Cache': 'MISS'
      }
    });

  } catch (error) {
    return new Response(JSON.stringify({ 
      error: error.message || 'Internal server error' 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
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

async function extractVideos(html, postId, fullHtml = null) {
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
    
    const candidateExt = detectExtension(attachmentUrl, posterUrl, `${slug} ${innerContent}`);
    rawCandidates.push({
      type: 'video',
      posterUrl: posterUrl.startsWith('http') ? posterUrl : `https:${posterUrl}`,
      attachmentUrl: attachmentUrl.startsWith('http') ? attachmentUrl : `https://www.lpsg.com${attachmentUrl}`,
      userId,
      hash,
      candidateExt
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
          const candidateExt = detectExtension(attachmentUrl, posterUrl, `${slug} ${innerContent}`);
          rawCandidates.push({
            type: 'video',
            posterUrl: posterUrl.startsWith('http') ? posterUrl : `https:${posterUrl}`,
            attachmentUrl: attachmentUrl.startsWith('http') ? attachmentUrl : `https://www.lpsg.com${attachmentUrl}`,
            userId,
            hash,
            candidateExt
          });
        }
      }
    }
  }

  // Pattern 2: Direct CDN video URLs in HTML
  const cdnVideoPattern = /cdn-videos\.lpsg\.com\/data\/video\/(\d+)\/(\d+-[a-f0-9]+)\.(mp4|mov|webm|avi|mkv)/gi;
  while ((match = cdnVideoPattern.exec(html)) !== null) {
    const [, userId, hash, ext] = match;
    if (foundHashes.has(hash)) continue;
    foundHashes.add(hash);
    
    rawCandidates.push({
      type: 'cdn-direct',
      userId,
      hash,
      candidateExt: ext.toLowerCase()
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
      
      const candidateExt = detectExtension(attachmentUrl, '', lower);
      rawCandidates.push({
        type: 'video',
        posterUrl: `https://cdn-videos.lpsg.com/data/attachments/posters/${userId}/${hash}.jpg`,
        attachmentUrl: attachmentUrl.startsWith('http') ? attachmentUrl : `https://www.lpsg.com${attachmentUrl}`,
        userId,
        hash,
        candidateExt
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
    const candidateExt = detectExtension('', '', surrounding);
    
    rawCandidates.push({
      type: 'poster-derived',
      posterUrl: `https://cdn-videos.lpsg.com/data/attachments/posters/${userId}/${hash}.jpg`,
      userId,
      hash,
      candidateExt
    });
  }

  // Validate and verify the real working CDN extension for all candidates concurrently
  const videos = await Promise.all(rawCandidates.map(async (item) => {
    const finalExt = await verifyOrDetectExt(item.userId, item.hash, item.candidateExt);
    return {
      type: item.type,
      url: `https://cdn-videos.lpsg.com/data/video/${item.userId}/${item.hash}.${finalExt}`,
      posterUrl: item.posterUrl,
      attachmentUrl: item.attachmentUrl,
      userId: item.userId,
      hash: item.hash,
      extension: finalExt
    };
  }));

  return videos;
}

function detectExtension(attachmentPath, posterUrl, contextStr = '') {
  const combined = `${attachmentPath} ${posterUrl} ${contextStr}`.toLowerCase();

  // 1. Explicit extension in alt, title, data-name, or filename
  const explicitExt = combined.match(/\.(mov|mp4|webm|mkv|avi|m4v|wmv|flv)\b/i);
  if (explicitExt) {
    return explicitExt[1].toLowerCase();
  }

  // 2. XenForo slug format: ...-mov.12345 or ...-mp4.12345 or ...-webm.12345
  const slugExt = combined.match(/[-_.](mov|mp4|webm|mkv|avi|m4v|wmv|flv)\.\d+/i);
  if (slugExt) {
    return slugExt[1].toLowerCase();
  }

  // 3. iOS Screen Recording indicator (always .mov)
  if (combined.includes('rpreplay')) {
    return 'mov';
  }

  // 4. Keyword matches in slug/context
  if (combined.includes('-mov') || combined.includes('.mov')) return 'mov';
  if (combined.includes('-webm') || combined.includes('.webm')) return 'webm';
  if (combined.includes('-mkv') || combined.includes('.mkv')) return 'mkv';
  if (combined.includes('-avi') || combined.includes('.avi')) return 'avi';
  if (combined.includes('-mp4') || combined.includes('.mp4') || combined.includes('ap-mp4')) return 'mp4';

  return 'mp4'; // fallback candidate
}

async function verifyOrDetectExt(userId, hash, candidateExt) {
  const prioritizedExts = [candidateExt, 'mov', 'mp4', 'webm', 'mkv', 'avi'].filter((v, i, a) => a.indexOf(v) === i);
  const headHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Referer': 'https://www.lpsg.com/'
  };
  
  try {
    // Check candidate extension first
    const primaryRes = await fetch(`https://cdn-videos.lpsg.com/data/video/${userId}/${hash}.${candidateExt}`, {
      method: 'HEAD',
      headers: headHeaders
    });
    if (primaryRes.ok) {
      return candidateExt;
    }

    // If candidate extension returned 404, probe other possible extensions
    for (const altExt of prioritizedExts.slice(1)) {
      const altRes = await fetch(`https://cdn-videos.lpsg.com/data/video/${userId}/${hash}.${altExt}`, {
        method: 'HEAD',
        headers: headHeaders
      });
      if (altRes.ok) {
        return altExt;
      }
    }
  } catch (err) {
    // If network check fails, safely fallback to candidateExt
  }

  return candidateExt;
}
