/**
 * glassdeck-auth.js
 * ─────────────────────────────────────────────────────────────────
 * Drop-in Supabase auth modal for Glassdeck.
 * Handles: Email+Password, Google SSO, Apple Sign In
 * Provides: session state, IS_PRO flag, nav avatar updates
 *
 * SETUP (two lines in your HTML, before </body>):
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/dist/umd/supabase.js"></script>
 *   <script src="/glassdeck-auth.js"></script>
 *
 * Then set your keys at the top of this file:
 *   SUPABASE_URL  → https://ywjpvweuqsbwvpebjnzq.supabase.co
 *   SUPABASE_ANON → Publishable key from Settings > API Keys
 *                   (the sb_publishable_... key — safe to expose publicly)
 *
 * NOTE: Supabase now uses sb_publishable_ / sb_secret_ key format.
 *   Publishable key = frontend (this file) ✅
 *   Secret key      = server only, never in browser code ❌
 * ─────────────────────────────────────────────────────────────────
 */

// ── CONFIG ── paste your real values here ─────────────────────────
const SUPABASE_URL  = 'https://ywjpvweuqsbwvpebjnzq.supabase.co';
const SUPABASE_ANON = 'sb_publishable_EJk-debbvouCmSHRzhImVA_xAat1kD6'; // sb_publishable_...
// ─────────────────────────────────────────────────────────────────

// ── INIT ─────────────────────────────────────────────────────────
let _supabase = null;

function getClient() {
  if (_supabase) return _supabase;
  if (typeof window.supabase !== 'undefined') {
    _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
    return _supabase;
  }
  console.warn('[GD Auth] Supabase SDK not loaded. Add the CDN script before glassdeck-auth.js');
  return null;
}

// ── PUBLIC API ────────────────────────────────────────────────────
window.GD_AUTH = {
  openModal,
  closeModal,
  signOut,
  getSession: async () => {
    const sb = getClient();
    if (!sb) return null;
    const { data: { session } } = await sb.auth.getSession();
    return session;
  },
};

// ── STATE ─────────────────────────────────────────────────────────
let _mode = 'signin'; // 'signin' | 'signup'
let _loading = false;

// ── INJECT CSS ────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&display=swap');

#gd-auth-backdrop {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(10,10,10,0.55);
  backdrop-filter: blur(10px) saturate(160%);
  -webkit-backdrop-filter: blur(10px) saturate(160%);
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
  opacity: 0; pointer-events: none;
  transition: opacity 0.2s ease;
}
#gd-auth-backdrop.open {
  opacity: 1; pointer-events: all;
}

#gd-auth-modal {
  background: #fff;
  border: 1px solid rgba(0,0,0,0.08);
  border-radius: 24px;
  padding: 36px 36px 32px;
  width: 100%; max-width: 400px;
  box-shadow: 0 24px 80px rgba(0,0,0,0.14), 0 8px 24px rgba(0,0,0,0.08);
  transform: translateY(10px) scale(0.98);
  transition: transform 0.25s cubic-bezier(0.34,1.56,0.64,1), opacity 0.2s ease;
  opacity: 0;
  font-family: 'Geist', -apple-system, sans-serif;
  position: relative;
}
#gd-auth-backdrop.open #gd-auth-modal {
  transform: translateY(0) scale(1);
  opacity: 1;
}

/* Logo */
.gd-auth-logo {
  display: flex; align-items: center; justify-content: center;
  margin-bottom: 28px;
}

/* Tab toggle */
.gd-auth-tabs {
  display: flex;
  background: #F0F0F2;
  border-radius: 12px;
  padding: 4px;
  margin-bottom: 28px;
}
.gd-auth-tab {
  flex: 1; padding: 9px 0;
  border: none; background: none; cursor: pointer;
  font-family: 'Geist', -apple-system, sans-serif;
  font-size: 14px; font-weight: 600;
  color: #6B6B78; border-radius: 9px;
  transition: all 0.18s;
}
.gd-auth-tab.active {
  background: #fff;
  color: #0F0F11;
  box-shadow: 0 1px 6px rgba(0,0,0,0.10), 0 0 0 1px rgba(0,0,0,0.04);
}

/* Close button */
.gd-auth-close {
  position: absolute; top: 16px; right: 16px;
  width: 32px; height: 32px; border-radius: 50%;
  border: none; background: #F0F0F2;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  font-size: 15px; color: #6B6B78;
  transition: background 0.15s, color 0.15s;
}
.gd-auth-close:hover { background: #E0E0E4; color: #0F0F11; }

/* SSO buttons */
.gd-auth-sso {
  display: flex; flex-direction: column; gap: 10px;
  margin-bottom: 20px;
}
.gd-auth-sso-btn {
  display: flex; align-items: center; justify-content: center; gap: 10px;
  width: 100%; padding: 12px 16px;
  border: 1.5px solid #E8E8EC;
  border-radius: 12px; background: #fff;
  font-family: 'Geist', -apple-system, sans-serif;
  font-size: 14px; font-weight: 600; color: #0F0F11;
  cursor: pointer; transition: all 0.15s;
}
.gd-auth-sso-btn:hover {
  background: #FAFAFA;
  border-color: #C8C8D0;
  box-shadow: 0 2px 8px rgba(0,0,0,0.06);
}
.gd-auth-sso-btn:active { transform: scale(0.99); }
.gd-auth-sso-btn svg { flex-shrink: 0; }

/* Apple button specific */
.gd-auth-sso-btn.apple {
  background: #0A0A0A; color: #fff; border-color: #0A0A0A;
}
.gd-auth-sso-btn.apple:hover { background: #222; border-color: #222; }

/* Divider */
.gd-auth-divider {
  display: flex; align-items: center; gap: 12px;
  margin-bottom: 20px;
}
.gd-auth-divider span {
  font-size: 12px; color: #A0A0AD; font-weight: 500; white-space: nowrap;
}
.gd-auth-divider::before,
.gd-auth-divider::after {
  content: ''; flex: 1; height: 1px; background: #E8E8EC;
}

/* Form fields */
.gd-auth-field { margin-bottom: 12px; }
.gd-auth-label {
  display: block;
  font-size: 12.5px; font-weight: 600; color: #4A4A55;
  margin-bottom: 6px; letter-spacing: -0.01em;
}
.gd-auth-input-wrap { position: relative; }
.gd-auth-input {
  width: 100%; padding: 11px 14px;
  border: 1.5px solid #E8E8EC; border-radius: 11px;
  font-family: 'Geist', -apple-system, sans-serif;
  font-size: 14.5px; color: #0F0F11;
  background: #fff; outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
  -webkit-appearance: none;
}
.gd-auth-input:focus {
  border-color: #FFC60B;
  box-shadow: 0 0 0 3px rgba(255,198,11,0.18);
}
.gd-auth-input.error { border-color: #DC2626; }
.gd-auth-input.error:focus { box-shadow: 0 0 0 3px rgba(220,38,38,0.12); }

/* Password toggle */
.gd-auth-pw-toggle {
  position: absolute; right: 12px; top: 50%; transform: translateY(-50%);
  background: none; border: none; cursor: pointer; padding: 4px;
  color: #A0A0AD; transition: color 0.15s;
  display: flex; align-items: center;
}
.gd-auth-pw-toggle:hover { color: #4A4A55; }

/* Error message */
.gd-auth-error {
  font-size: 12px; color: #DC2626; margin-top: 5px;
  display: none; font-weight: 500;
}
.gd-auth-error.show { display: block; }

/* Global error */
.gd-auth-global-error {
  background: #FEF2F2; border: 1px solid #FECACA;
  border-radius: 10px; padding: 10px 14px;
  font-size: 13px; color: #DC2626; font-weight: 500;
  margin-bottom: 16px; display: none;
}
.gd-auth-global-error.show { display: block; }

/* Submit button */
.gd-auth-submit {
  width: 100%; padding: 13px;
  background: #FFC60B; border: none; border-radius: 12px;
  font-family: 'Geist', -apple-system, sans-serif;
  font-size: 15px; font-weight: 700; color: #1A1400;
  cursor: pointer; margin-top: 4px;
  transition: all 0.18s;
  display: flex; align-items: center; justify-content: center; gap: 8px;
  letter-spacing: -0.02em;
}
.gd-auth-submit:hover:not(:disabled) {
  background: #E6B000;
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(255,198,11,0.38);
}
.gd-auth-submit:disabled {
  opacity: 0.65; cursor: not-allowed; transform: none;
}

/* Spinner */
.gd-auth-spinner {
  width: 16px; height: 16px; border-radius: 50%;
  border: 2px solid rgba(26,20,0,0.2);
  border-top-color: #1A1400;
  animation: gd-spin 0.6s linear infinite; display: none;
}
@keyframes gd-spin { to { transform: rotate(360deg); } }

/* Footer */
.gd-auth-footer {
  text-align: center; margin-top: 18px;
  font-size: 13px; color: #6B6B78;
}
.gd-auth-footer a {
  color: #0F0F11; font-weight: 600; cursor: pointer;
  text-decoration: none; transition: color 0.15s;
}
.gd-auth-footer a:hover { color: #C98A00; }

/* Success state */
.gd-auth-success {
  text-align: center; padding: 16px 0 4px;
  display: none;
}
.gd-auth-success-icon {
  width: 56px; height: 56px; border-radius: 50%;
  background: #DCFCE7;
  display: flex; align-items: center; justify-content: center;
  font-size: 26px; margin: 0 auto 16px;
}
.gd-auth-success h3 {
  font-size: 18px; font-weight: 700; color: #0F0F11;
  letter-spacing: -0.03em; margin-bottom: 6px;
}
.gd-auth-success p {
  font-size: 14px; color: #6B6B78; line-height: 1.5;
}

/* Forgot password link */
.gd-auth-forgot {
  display: block; text-align: right;
  font-size: 12px; font-weight: 500; color: #A0A0AD;
  cursor: pointer; margin-top: 6px; text-decoration: none;
  transition: color 0.15s;
}
.gd-auth-forgot:hover { color: #4A4A55; }

/* Terms */
.gd-auth-terms {
  font-size: 11.5px; color: #A0A0AD; text-align: center;
  margin-top: 14px; line-height: 1.5;
}
.gd-auth-terms a { color: #6B6B78; text-decoration: underline; }

@media (max-width: 440px) {
  #gd-auth-modal { padding: 28px 22px 24px; border-radius: 20px; }
}
`;

function injectStyles() {
  if (document.getElementById('gd-auth-styles')) return;
  const el = document.createElement('style');
  el.id = 'gd-auth-styles';
  el.textContent = CSS;
  document.head.appendChild(el);
}

// ── HTML ──────────────────────────────────────────────────────────
function buildHTML() {
  return `
<div id="gd-auth-backdrop">
  <div id="gd-auth-modal" role="dialog" aria-modal="true" aria-label="Sign in to Glassdeck">
    <button class="gd-auth-close" id="gd-auth-close-btn" aria-label="Close">✕</button>

    <!-- Logo -->
    <div class="gd-auth-logo">
      <svg height="28" viewBox="0 0 648 216" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path fill="#0A0A0A" d="M54.03,34.95c-.49-5.98-3.55-11.8-7.97-16.21-4.53-4.47-10.35-7.54-16.27-8.03.49,5.98,3.55,11.74,7.97,16.16,4.47,4.47,10.35,7.59,16.27,8.08ZM2.31,38.18c.49,5.98,3.55,11.74,7.97,16.16,4.47,4.47,10.35,7.59,16.27,8.08-.49-5.98-3.55-11.8-8.03-16.21-4.47-4.47-10.29-7.54-16.21-8.03ZM29.79,62.43c5.93-.49,11.74-3.61,16.27-8.08,4.42-4.42,7.49-10.19,7.97-16.16-5.93.49-11.8,3.55-16.27,8.03-4.42,4.42-7.49,10.24-7.97,16.21ZM2.31,34.95c5.93-.54,11.74-3.61,16.21-8.08,4.47-4.42,7.54-10.19,8.03-16.16-5.93.49-11.8,3.55-16.27,8.03-4.42,4.42-7.49,10.24-7.97,16.21Z"/>
        <path fill="#FFC60B" d="M54.03,34.95c-.49-5.98-3.55-11.8-7.97-16.21C41.53,14.27,35.71,11.2,29.79,10.71c.49,5.98,3.55,11.74,7.97,16.16,4.47,4.47,10.35,7.59,16.27,8.08Z" opacity="0.5"/>
      </svg>
    </div>

    <!-- Tab toggle -->
    <div class="gd-auth-tabs" role="tablist">
      <button class="gd-auth-tab active" id="gd-tab-signin" role="tab" onclick="GD_AUTH._setMode('signin')">Sign in</button>
      <button class="gd-auth-tab" id="gd-tab-signup" role="tab" onclick="GD_AUTH._setMode('signup')">Create account</button>
    </div>

    <!-- Global error -->
    <div class="gd-auth-global-error" id="gd-global-error"></div>

    <!-- SSO buttons -->
    <div class="gd-auth-sso">
      <button class="gd-auth-sso-btn" onclick="GD_AUTH._ssoGoogle()">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
          <path d="M9 18c2.43 0 4.467-.806 5.956-2.18L12.048 13.56c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
          <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
          <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
        </svg>
        Continue with Google
      </button>
      <button class="gd-auth-sso-btn apple" onclick="GD_AUTH._ssoApple()">
        <svg width="17" height="18" viewBox="0 0 17 18" fill="none">
          <path d="M14.24 9.47c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.49-2.6-1.7-3.16-1.72-1.35-.14-2.63.8-3.31.8-.68 0-1.73-.78-2.84-.76-1.46.02-2.8.85-3.55 2.16C1.7 9.06 2.76 13.27 4.37 15.6c.8 1.15 1.76 2.45 3.02 2.4 1.21-.05 1.67-.78 3.14-.78 1.46 0 1.87.78 3.15.76 1.3-.02 2.13-1.18 2.93-2.34.93-1.34 1.31-2.64 1.33-2.71-.03-.01-2.68-1.03-2.7-4.06zM12.06 3.07c.66-.8 1.1-1.92.98-3.03-.95.04-2.09.63-2.77 1.43-.61.7-1.14 1.83-1 2.9 1.06.08 2.14-.54 2.79-1.3z" fill="white"/>
        </svg>
        Continue with Apple
      </button>
    </div>

    <!-- Divider -->
    <div class="gd-auth-divider"><span>or</span></div>

    <!-- Form -->
    <form id="gd-auth-form" onsubmit="GD_AUTH._submit(event)">

      <!-- Name field (signup only) -->
      <div class="gd-auth-field" id="gd-name-field" style="display:none">
        <label class="gd-auth-label" for="gd-name">Full name</label>
        <input class="gd-auth-input" id="gd-name" type="text" placeholder="Your name" autocomplete="name" />
        <span class="gd-auth-error" id="gd-name-error"></span>
      </div>

      <!-- Email -->
      <div class="gd-auth-field">
        <label class="gd-auth-label" for="gd-email">Email</label>
        <input class="gd-auth-input" id="gd-email" type="email" placeholder="you@example.com"
               autocomplete="email" required />
        <span class="gd-auth-error" id="gd-email-error"></span>
      </div>

      <!-- Password -->
      <div class="gd-auth-field">
        <label class="gd-auth-label" for="gd-password">Password</label>
        <div class="gd-auth-input-wrap">
          <input class="gd-auth-input" id="gd-password" type="password"
                 placeholder="••••••••" autocomplete="current-password" required
                 style="padding-right: 42px" />
          <button type="button" class="gd-auth-pw-toggle" onclick="GD_AUTH._togglePw()" aria-label="Show password">
            <svg id="gd-pw-eye" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
        </div>
        <span class="gd-auth-error" id="gd-pw-error"></span>
        <a class="gd-auth-forgot" id="gd-forgot-link" onclick="GD_AUTH._forgotPassword()">Forgot password?</a>
      </div>

      <button class="gd-auth-submit" id="gd-submit-btn" type="submit">
        <span id="gd-submit-label">Sign in</span>
        <div class="gd-auth-spinner" id="gd-spinner"></div>
      </button>

      <p class="gd-auth-terms" id="gd-terms" style="display:none">
        By creating an account you agree to our <a href="/terms" target="_blank">Terms</a>
        and <a href="/privacy" target="_blank">Privacy Policy</a>.
      </p>
    </form>

    <!-- Success state (magic link / signup confirmation) -->
    <div class="gd-auth-success" id="gd-success">
      <div class="gd-auth-success-icon">✉️</div>
      <h3>Check your inbox</h3>
      <p>We sent a confirmation link to<br><strong id="gd-success-email"></strong></p>
    </div>

    <!-- Footer toggle -->
    <div class="gd-auth-footer">
      <span id="gd-footer-text">Don't have an account?</span>
      <a id="gd-footer-link" onclick="GD_AUTH._setMode('signup')"> Create one</a>
    </div>
  </div>
</div>
`;
}

// ── MODAL LIFECYCLE ───────────────────────────────────────────────
function openModal(mode = 'signin') {
  injectStyles();
  if (!document.getElementById('gd-auth-backdrop')) {
    document.body.insertAdjacentHTML('beforeend', buildHTML());
    bindEvents();
  }
  _setMode(mode);
  requestAnimationFrame(() => {
    document.getElementById('gd-auth-backdrop').classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(() => document.getElementById('gd-email')?.focus(), 200);
  });
}

function closeModal() {
  const backdrop = document.getElementById('gd-auth-backdrop');
  if (!backdrop) return;
  backdrop.classList.remove('open');
  document.body.style.overflow = '';
  clearErrors();
}

function bindEvents() {
  const backdrop = document.getElementById('gd-auth-backdrop');
  backdrop.addEventListener('click', e => {
    if (e.target === backdrop) closeModal();
  });
  document.getElementById('gd-auth-close-btn').addEventListener('click', closeModal);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
  }, { once: false });
}

// ── MODE TOGGLE ───────────────────────────────────────────────────
function _setMode(mode) {
  _mode = mode;
  clearErrors();
  resetSuccess();

  const isSignup = mode === 'signup';
  document.getElementById('gd-tab-signin').classList.toggle('active', !isSignup);
  document.getElementById('gd-tab-signup').classList.toggle('active', isSignup);
  document.getElementById('gd-name-field').style.display = isSignup ? 'block' : 'none';
  document.getElementById('gd-submit-label').textContent = isSignup ? 'Create account' : 'Sign in';
  document.getElementById('gd-forgot-link').style.display = isSignup ? 'none' : 'block';
  document.getElementById('gd-terms').style.display = isSignup ? 'block' : 'none';
  document.getElementById('gd-footer-text').textContent = isSignup ? 'Already have an account?' : "Don't have an account?";
  document.getElementById('gd-footer-link').textContent = isSignup ? ' Sign in' : ' Create one';
  document.getElementById('gd-footer-link').onclick = () => _setMode(isSignup ? 'signin' : 'signup');
  document.getElementById('gd-password').autocomplete = isSignup ? 'new-password' : 'current-password';
}

// ── FORM SUBMIT ───────────────────────────────────────────────────
async function _submit(e) {
  e.preventDefault();
  if (_loading) return;

  clearErrors();

  const email    = document.getElementById('gd-email').value.trim();
  const password = document.getElementById('gd-password').value;
  const name     = document.getElementById('gd-name')?.value?.trim() || '';

  // Validate
  let valid = true;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showFieldError('gd-email', 'gd-email-error', 'Enter a valid email address');
    valid = false;
  }
  if (!password || password.length < 8) {
    showFieldError('gd-password', 'gd-pw-error', 'Password must be at least 8 characters');
    valid = false;
  }
  if (_mode === 'signup' && !name) {
    showFieldError('gd-name', 'gd-name-error', 'Please enter your name');
    valid = false;
  }
  if (!valid) return;

  setLoading(true);

  const sb = getClient();
  if (!sb) {
    showGlobalError('Auth service unavailable. Check your Supabase configuration.');
    setLoading(false);
    return;
  }

  try {
    if (_mode === 'signup') {
      const { data, error } = await sb.auth.signUp({
        email, password,
        options: { data: { full_name: name } }
      });
      if (error) throw error;
      // Supabase sends a confirmation email by default
      showSuccess(email);
    } else {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      // Success — onAuthStateChange will fire
      closeModal();
    }
  } catch (err) {
    const msg = friendlyError(err.message);
    showGlobalError(msg);
  } finally {
    setLoading(false);
  }
}

// ── SSO ───────────────────────────────────────────────────────────
async function _ssoGoogle() {
  const sb = getClient();
  if (!sb) return;
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href }
  });
  if (error) showGlobalError(error.message);
}

async function _ssoApple() {
  const sb = getClient();
  if (!sb) return;
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'apple',
    options: { redirectTo: window.location.href }
  });
  if (error) showGlobalError(error.message);
}

// ── FORGOT PASSWORD ───────────────────────────────────────────────
async function _forgotPassword() {
  const email = document.getElementById('gd-email').value.trim();
  if (!email) {
    showFieldError('gd-email', 'gd-email-error', 'Enter your email first, then click Forgot password');
    return;
  }
  const sb = getClient();
  if (!sb) return;
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/reset-password`,
  });
  if (error) {
    showGlobalError(error.message);
  } else {
    showSuccess(email);
  }
}

// ── PASSWORD TOGGLE ───────────────────────────────────────────────
function _togglePw() {
  const input = document.getElementById('gd-password');
  input.type = input.type === 'password' ? 'text' : 'password';
}

// ── AUTH STATE ────────────────────────────────────────────────────
function initAuthListener() {
  const sb = getClient();
  if (!sb) return;

  sb.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session) {
      await onSignIn(session);
    } else if (event === 'SIGNED_OUT') {
      onSignOut();
    }
  });

  // Check existing session on load
  sb.auth.getSession().then(({ data: { session } }) => {
    if (session) onSignIn(session);
  });
}

async function onSignIn(session) {
  const user = session.user;

  // ── Check Pro status ──────────────────────────────────────────
  // Looks for a 'pro' role in user metadata or a subscriptions table.
  // Swap this out with your actual Pro check once billing is wired.
  const isPro = user?.user_metadata?.is_pro === true
             || user?.app_metadata?.is_pro === true;
  window.IS_PRO = isPro;

  // ── Update nav avatar ─────────────────────────────────────────
  const initials = getInitials(user?.user_metadata?.full_name || user?.email);
  updateNavAvatar(initials, isPro);

  // ── Dispatch event for any page to hook into ──────────────────
  window.dispatchEvent(new CustomEvent('gd:signin', { detail: { user, session, isPro } }));

  // Re-lock or unlock Pro buttons if present
  syncProButtons(isPro);
}

function onSignOut() {
  window.IS_PRO = false;
  resetNavAvatar();
  window.dispatchEvent(new CustomEvent('gd:signout'));
  syncProButtons(false);
}

async function signOut() {
  const sb = getClient();
  if (!sb) return;
  await sb.auth.signOut();
}

// ── NAV AVATAR ────────────────────────────────────────────────────
function updateNavAvatar(initials, isPro) {
  document.querySelectorAll('.nav-avatar, .nav-signin, .nav-cta').forEach(el => {
    // Remove existing sign-in / CTA links
    if (el.classList.contains('nav-signin') || el.classList.contains('nav-cta')) {
      el.style.display = 'none';
    }
  });

  let avatar = document.querySelector('.nav-avatar[data-gd]');
  if (!avatar) {
    avatar = document.createElement('a');
    avatar.className = 'nav-avatar';
    avatar.setAttribute('data-gd', '1');
    avatar.href = '/dashboard.html';
    // Try to inject into nav-right
    const navRight = document.querySelector('.nav-right, .nav-r');
    if (navRight) navRight.appendChild(avatar);
  }
  avatar.textContent = initials;
  avatar.style.display = 'flex';

  // Show sign-out option on click via simple dropdown
  avatar.onclick = (e) => {
    e.preventDefault();
    showUserMenu(avatar);
  };
}

function resetNavAvatar() {
  const avatar = document.querySelector('.nav-avatar[data-gd]');
  if (avatar) avatar.remove();
  document.querySelectorAll('.nav-signin, .nav-cta').forEach(el => {
    el.style.display = '';
  });
}

function showUserMenu(anchor) {
  let menu = document.getElementById('gd-user-menu');
  if (menu) { menu.remove(); return; }

  menu = document.createElement('div');
  menu.id = 'gd-user-menu';
  menu.style.cssText = `
    position:absolute; right:0; top:calc(100% + 8px);
    background:#fff; border:1px solid #E8E8EC; border-radius:14px;
    box-shadow:0 8px 28px rgba(0,0,0,0.12); padding:6px;
    min-width:180px; z-index:500;
    font-family:'Geist',-apple-system,sans-serif;
  `;

  const item = (label, href, danger = false) => {
    const a = document.createElement(href ? 'a' : 'button');
    if (href) a.href = href;
    a.style.cssText = `
      display:block; width:100%; padding:9px 12px;
      border-radius:9px; border:none; background:none;
      font-size:13.5px; font-weight:500; text-align:left;
      color:${danger ? '#DC2626' : '#0F0F11'}; cursor:pointer;
      text-decoration:none; transition:background 0.12s;
    `;
    a.textContent = label;
    a.onmouseenter = () => a.style.background = danger ? '#FEF2F2' : '#F0F0F2';
    a.onmouseleave = () => a.style.background = 'none';
    return a;
  };

  menu.appendChild(item('Dashboard', '/dashboard.html'));
  const divider = document.createElement('div');
  divider.style.cssText = 'height:1px;background:#E8E8EC;margin:4px 0;';
  menu.appendChild(divider);
  const signOutBtn = item('Sign out', null, true);
  signOutBtn.onclick = () => { menu.remove(); signOut(); };
  menu.appendChild(signOutBtn);

  anchor.style.position = 'relative';
  anchor.appendChild(menu);

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function close(e) {
      if (!menu.contains(e.target) && e.target !== anchor) {
        menu.remove();
        document.removeEventListener('click', close);
      }
    });
  }, 0);
}

// ── PRO BUTTONS ───────────────────────────────────────────────────
function syncProButtons(isPro) {
  document.querySelectorAll('.locked').forEach(btn => {
    btn.classList.toggle('locked', !isPro);
  });
}

// ── HELPERS ───────────────────────────────────────────────────────
function getInitials(str = '') {
  return str.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

function setLoading(on) {
  _loading = on;
  const btn     = document.getElementById('gd-submit-btn');
  const spinner = document.getElementById('gd-spinner');
  const label   = document.getElementById('gd-submit-label');
  if (!btn) return;
  btn.disabled = on;
  spinner.style.display = on ? 'block' : 'none';
  label.style.opacity = on ? '0' : '1';
}

function showFieldError(inputId, errorId, msg) {
  document.getElementById(inputId)?.classList.add('error');
  const el = document.getElementById(errorId);
  if (el) { el.textContent = msg; el.classList.add('show'); }
}

function showGlobalError(msg) {
  const el = document.getElementById('gd-global-error');
  if (el) { el.textContent = msg; el.classList.add('show'); }
}

function clearErrors() {
  document.querySelectorAll('.gd-auth-input').forEach(i => i.classList.remove('error'));
  document.querySelectorAll('.gd-auth-error').forEach(e => e.classList.remove('show'));
  const ge = document.getElementById('gd-global-error');
  if (ge) ge.classList.remove('show');
}

function showSuccess(email) {
  document.getElementById('gd-auth-form').style.display = 'none';
  document.querySelector('.gd-auth-sso').style.display = 'none';
  document.querySelector('.gd-auth-divider').style.display = 'none';
  document.getElementById('gd-success').style.display = 'block';
  const emailEl = document.getElementById('gd-success-email');
  if (emailEl) emailEl.textContent = email;
}

function resetSuccess() {
  const form = document.getElementById('gd-auth-form');
  if (form) form.style.display = 'block';
  const sso = document.querySelector('.gd-auth-sso');
  if (sso) sso.style.display = 'flex';
  const div = document.querySelector('.gd-auth-divider');
  if (div) div.style.display = 'flex';
  const success = document.getElementById('gd-success');
  if (success) success.style.display = 'none';
}

function friendlyError(msg = '') {
  if (msg.includes('Invalid login credentials'))  return 'Incorrect email or password.';
  if (msg.includes('Email not confirmed'))         return 'Please confirm your email first. Check your inbox.';
  if (msg.includes('User already registered'))    return 'An account with this email already exists. Try signing in.';
  if (msg.includes('Password should be'))         return 'Password must be at least 8 characters.';
  if (msg.includes('rate limit'))                 return 'Too many attempts. Wait a moment and try again.';
  return msg || 'Something went wrong. Please try again.';
}

// ── EXPOSE INTERNAL METHODS FOR HTML ONCLICK ──────────────────────
Object.assign(window.GD_AUTH, {
  _setMode, _submit, _ssoGoogle, _ssoApple,
  _forgotPassword, _togglePw, closeModal,
});

// ── BOOT ─────────────────────────────────────────────────────────
// Wire sign-in / sign-up triggers on any page that uses the standard nav classes
function wireNavButtons() {
  document.querySelectorAll('[data-gd-signin], .nav-signin').forEach(el => {
    el.addEventListener('click', e => { e.preventDefault(); openModal('signin'); });
  });
  document.querySelectorAll('[data-gd-signup], .nav-cta').forEach(el => {
    el.addEventListener('click', e => { e.preventDefault(); openModal('signup'); });
  });
}

function boot() {
  injectStyles();
  wireNavButtons();
  initAuthListener();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
