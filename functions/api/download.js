// Cloudflare Pages Function: Stream Download Proxy
// Proxies CDN video files with Content-Disposition: attachment to guarantee a real file download in the browser.

import { fetchWithTimeout } from '../_net.js';

const DOWNLOAD_CONNECT_TIMEOUT_MS = 10000;

export async function onRequestGet(context) {
  try {
    const { searchParams } = new URL(context.request.url);
    const targetUrl = searchParams.get('url');
    let filename = searchParams.get('filename') || 'video.mp4';

    if (!targetUrl) {
      return new Response('Missing "url" query parameter', { status: 400 });
    }

    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return new Response('Invalid target URL', { status: 400 });
    }

    // Security check: Only allow lpsg.com and its subdomains over http(s).
    // Note: a bare endsWith('lpsg.com') would also match attacker domains like
    // "evillpsg.com", so match the exact apex or a dot-delimited subdomain.
    const host = parsed.hostname.toLowerCase();
    const isLpsgHost = host === 'lpsg.com' || host.endsWith('.lpsg.com');
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    if (!isHttp || !isLpsgHost) {
      return new Response('Forbidden: Domain not permitted', { status: 403 });
    }

    // Sanitize filename
    filename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');

    // Forward range request if browser requested partial content
    const fetchHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Referer': 'https://www.lpsg.com/'
    };

    const range = context.request.headers.get('range');
    if (range) {
      fetchHeaders['Range'] = range;
    }

    // Connect timeout only: fetchWithTimeout clears its abort timer the moment
    // the response headers arrive, so the streaming body below is never aborted
    // mid-transfer (a slow-but-progressing download still completes).
    let cdnResponse;
    try {
      cdnResponse = await fetchWithTimeout(targetUrl, { headers: fetchHeaders }, DOWNLOAD_CONNECT_TIMEOUT_MS);
    } catch (err) {
      return new Response('Upstream timed out while connecting to CDN', { status: 504 });
    }

    if (!cdnResponse.ok && cdnResponse.status !== 206) {
      return new Response(`Failed to fetch file from CDN (${cdnResponse.status})`, {
        status: cdnResponse.status
      });
    }

    const responseHeaders = new Headers();
    responseHeaders.set('Content-Disposition', `attachment; filename="${filename}"`);
    
    // Copy key content headers
    const contentType = cdnResponse.headers.get('content-type') || 'application/octet-stream';
    responseHeaders.set('Content-Type', contentType);

    const contentLength = cdnResponse.headers.get('content-length');
    if (contentLength) {
      responseHeaders.set('Content-Length', contentLength);
    }

    const contentRange = cdnResponse.headers.get('content-range');
    if (contentRange) {
      responseHeaders.set('Content-Range', contentRange);
    }

    const acceptRanges = cdnResponse.headers.get('accept-ranges');
    if (acceptRanges) {
      responseHeaders.set('Accept-Ranges', acceptRanges);
    }

    responseHeaders.set('Cache-Control', 'private, no-cache');

    return new Response(cdnResponse.body, {
      status: cdnResponse.status,
      headers: responseHeaders
    });

  } catch (err) {
    return new Response(`Download proxy error: ${err.message}`, { status: 500 });
  }
}
