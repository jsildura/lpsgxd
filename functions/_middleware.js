// Cloudflare Pages Functions: Global Authentication Middleware
import { isAuthenticated } from "./_auth.js";

// Whitelisted public routes that bypass authentication
const PUBLIC_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/logout",
  "/api/download",
  "/logo.png",
  "/favicon.ico",
]);

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // Allow explicitly public paths
  if (PUBLIC_PATHS.has(url.pathname)) {
    return next();
  }

  // Check if user has a valid permanent authentication cookie
  const authenticated = await isAuthenticated(request, env);
  if (authenticated) {
    return next();
  }

  // If unauthenticated and requesting an API endpoint, return 401 Unauthorized JSON
  if (url.pathname.startsWith("/api/")) {
    return new Response(
      JSON.stringify({
        error: "Unauthorized: Access password required.",
        code: 401,
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      }
    );
  }

  // If unauthenticated and requesting a page or static asset, render the Lock Screen
  return new Response(renderLockScreenHtml(), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}

/**
 * Generates the sleek, responsive, dark-mode Lock Screen HTML.
 */
function renderLockScreenHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LPSG Fetcher - Locked</title>
  <link rel="icon" type="image/png" href="/logo.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-canvas: #1a1a1e;
      --bg-surface: #222228;
      --bg-surface-elevated: #292932;
      --border-subtle: rgba(255, 255, 255, 0.08);
      --border-strong: rgba(255, 255, 255, 0.16);
      --accent-primary: #3b82f6;
      --accent-hover: #2563eb;
      --text-primary: #f8fafc;
      --text-secondary: #94a3b8;
      --text-muted: #64748b;
      --danger: #ef4444;
      --danger-bg: rgba(239, 68, 68, 0.12);
      --success: #10b981;
      --radius-md: 14px;
      --radius-lg: 20px;
      --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
      -webkit-font-smoothing: antialiased;
    }

    body {
      font-family: var(--font-sans);
      background-color: var(--bg-canvas);
      background-image:
        radial-gradient(ellipse 60% 40% at 50% -10%, rgba(59, 130, 246, 0.12), transparent 80%),
        radial-gradient(circle at 100% 100%, rgba(22, 22, 26, 0.8), transparent 50%);
      background-attachment: fixed;
      min-height: 100vh;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px 16px;
    }

    .lock-card {
      width: 100%;
      max-width: 420px;
      background: rgba(34, 34, 40, 0.88);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 36px 32px;
      box-shadow: 0 16px 40px -10px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.04);
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      animation: cardAppear 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }

    @keyframes cardAppear {
      from {
        opacity: 0;
        transform: translateY(12px) scale(0.98);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    .lock-icon-badge {
      width: 58px;
      height: 58px;
      border-radius: 50%;
      background: rgba(59, 130, 246, 0.12);
      border: 1px solid rgba(59, 130, 246, 0.3);
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 20px;
      color: var(--accent-primary);
    }

    .brand-title {
      font-size: 1.45rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--text-primary);
      margin-bottom: 6px;
    }

    .brand-desc {
      font-size: 0.87rem;
      color: var(--text-secondary);
      line-height: 1.45;
      margin-bottom: 28px;
    }

    .lock-form {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .input-wrapper {
      position: relative;
      width: 100%;
      display: flex;
      align-items: center;
    }

    .input-icon {
      position: absolute;
      left: 14px;
      color: var(--text-muted);
      pointer-events: none;
      display: flex;
      align-items: center;
    }

    .password-input {
      width: 100%;
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 13px 44px 13px 42px;
      font-family: var(--font-sans);
      font-size: 0.95rem;
      color: var(--text-primary);
      outline: none;
      transition: all 0.18s ease;
    }

    .password-input:focus {
      border-color: var(--accent-primary);
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2);
    }

    .toggle-visibility-btn {
      position: absolute;
      right: 12px;
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      padding: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      transition: color 0.15s ease;
    }

    .toggle-visibility-btn:hover {
      color: var(--text-primary);
    }

    .error-banner {
      display: none;
      width: 100%;
      padding: 10px 14px;
      background: var(--danger-bg);
      border: 1px solid rgba(239, 68, 68, 0.25);
      border-radius: 10px;
      font-size: 0.82rem;
      color: #fca5a5;
      text-align: left;
      align-items: center;
      gap: 8px;
    }

    .error-banner.visible {
      display: flex;
    }

    .shake {
      animation: shakeAnim 0.35s cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
    }

    @keyframes shakeAnim {
      10%, 90% { transform: translate3d(-1px, 0, 0); }
      20%, 80% { transform: translate3d(2px, 0, 0); }
      30%, 50%, 70% { transform: translate3d(-4px, 0, 0); }
      40%, 60% { transform: translate3d(4px, 0, 0); }
    }

    .submit-btn {
      width: 100%;
      background: var(--accent-primary);
      color: #ffffff;
      border: none;
      border-radius: var(--radius-md);
      padding: 13px 20px;
      font-family: var(--font-sans);
      font-size: 0.92rem;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: all 0.18s ease;
    }

    .submit-btn:hover:not(:disabled) {
      background: var(--accent-hover);
      transform: translateY(-1px);
    }

    .submit-btn:active:not(:disabled) {
      transform: translateY(0);
    }

    .submit-btn:disabled {
      opacity: 0.65;
      cursor: not-allowed;
    }

    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-radius: 50%;
      border-top-color: #fff;
      animation: spin 0.8s linear infinite;
      display: none;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .card-footer {
      margin-top: 24px;
      font-size: 0.74rem;
      color: var(--text-muted);
      letter-spacing: 0.01em;
    }
  </style>
</head>
<body>
  <div class="lock-card" id="lock-card">
    <div class="lock-icon-badge">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
      </svg>
    </div>

    <h1 class="brand-title">LPSG Fetcher</h1>
    <p class="brand-desc">This tool is password protected.<br>Enter your access password to continue.</p>

    <form class="lock-form" id="lock-form">
      <div class="input-wrapper" id="input-container">
        <span class="input-icon">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
        </span>
        <input
          type="password"
          id="password"
          class="password-input"
          placeholder="Enter password..."
          autocomplete="current-password"
          required
          autofocus
        >
        <button type="button" class="toggle-visibility-btn" id="toggle-pwd-btn" title="Show/hide password" aria-label="Toggle password visibility">
          <svg id="eye-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
        </button>
      </div>

      <div class="error-banner" id="error-banner">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        <span id="error-text">Incorrect password. Please try again.</span>
      </div>

      <button type="submit" class="submit-btn" id="submit-btn">
        <div class="spinner" id="btn-spinner"></div>
        <span id="btn-label">Unlock Tool</span>
        <svg id="btn-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="5" y1="12" x2="19" y2="12"></line>
          <polyline points="12 5 19 12 12 19"></polyline>
        </svg>
      </button>
    </form>

    <div class="card-footer">
      Session stays unlocked permanently on this device
    </div>
  </div>

  <script>
    const form = document.getElementById('lock-form');
    const pwdInput = document.getElementById('password');
    const toggleBtn = document.getElementById('toggle-pwd-btn');
    const eyeIcon = document.getElementById('eye-icon');
    const submitBtn = document.getElementById('submit-btn');
    const btnSpinner = document.getElementById('btn-spinner');
    const btnLabel = document.getElementById('btn-label');
    const btnArrow = document.getElementById('btn-arrow');
    const errorBanner = document.getElementById('error-banner');
    const errorText = document.getElementById('error-text');
    const card = document.getElementById('lock-card');

    // Toggle password visibility
    let isShowing = false;
    toggleBtn.addEventListener('click', () => {
      isShowing = !isShowing;
      pwdInput.type = isShowing ? 'text' : 'password';
      if (isShowing) {
        eyeIcon.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>';
      } else {
        eyeIcon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
      }
    });

    // Form submit
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = pwdInput.value;
      if (!password) return;

      // Loading state
      submitBtn.disabled = true;
      btnSpinner.style.display = 'inline-block';
      btnArrow.style.display = 'none';
      btnLabel.textContent = 'Verifying...';
      errorBanner.classList.remove('visible');

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        });

        const data = await res.json().catch(() => ({}));

        if (res.ok && data.success) {
          btnSpinner.style.display = 'none';
          btnLabel.textContent = 'Unlocked!';
          submitBtn.style.background = 'var(--success)';
          // Reload immediately to access full workspace
          window.location.reload();
        } else {
          // Failure
          showError(data.error || 'Incorrect password. Please try again.');
        }
      } catch (err) {
        showError('Network error. Please try again.');
      } finally {
        submitBtn.disabled = false;
        btnSpinner.style.display = 'none';
        btnArrow.style.display = 'inline';
        btnLabel.textContent = 'Unlock Workspace';
      }
    });

    function showError(msg) {
      errorText.textContent = msg;
      errorBanner.classList.add('visible');
      card.classList.remove('shake');
      void card.offsetWidth; // trigger reflow
      card.classList.add('shake');
      pwdInput.focus();
      pwdInput.select();
    }
  </script>
</body>
</html>`;
}
