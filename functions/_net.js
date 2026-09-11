// Shared, stateless network helpers for Cloudflare Pages Functions.
// Dependency-free. Files prefixed with "_" are not routed by Pages, only imported.

/**
 * Async map with a bounded worker pool. Preserves input order.
 * `next++` is atomic in single-threaded JS (no await between read and increment),
 * so workers never claim the same index. Replaces unbounded `Promise.all(...)`.
 */
export async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push((async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) break;
        results[i] = await mapper(items[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

/**
 * fetch() with a hard timeout via AbortController. The timer is cleared as soon
 * as the response headers arrive (fetch resolves), so for a bodyless request
 * (e.g. HEAD) this is a clean connect/header timeout. The returned Response's
 * body — if any — is NOT aborted and can be streamed by the caller.
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Like fetchWithTimeout but also reads the response body as text under the same
 * timeout (the timer is cleared only after .text() resolves). Returns both the
 * Response (for status/headers) and the decoded text.
 */
export async function fetchTextWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    return { response, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Full-jitter exponential backoff: a random delay in [0, min(cap, base*2^(attempt-1))].
 * Jitter spreads retries so many clients don't re-hit the origin in lockstep.
 */
export function backoffDelay(attempt, base = 500, cap = 8000) {
  const ceiling = Math.min(cap, base * Math.pow(2, Math.max(0, attempt - 1)));
  return Math.floor(Math.random() * ceiling);
}

/**
 * Parse a Retry-After header (delta-seconds or HTTP-date) into a clamped ms delay.
 * Returns null when absent or unparseable.
 */
export function parseRetryAfter(headerValue, capMs = 10000) {
  if (!headerValue) return null;
  const trimmed = String(headerValue).trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.max(0, Math.min(capMs, parseInt(trimmed, 10) * 1000));
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.min(capMs, dateMs - Date.now()));
  }
  return null;
}

/** Promise-based sleep. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
