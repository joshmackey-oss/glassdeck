// ─────────────────────────────────────────────────────────────────
//  Glassdeck · analyze.js v3
//  Deploy: Vercel /api/analyze
//
//  Strategy (in priority order):
//    1. Browserless /function — runs real JS in headless Chrome.
//       Uses document.fonts, getComputedStyle, document.styleSheets.
//       Ground truth — no guessing. Requires BROWSERLESS_TOKEN env var.
//    2. Plain fetch + CSS parsing — fast fallback (~60% of sites).
//       Used when Browserless is unavailable or fails.
// ─────────────────────────────────────────────────────────────────

const https = require('https');
const http  = require('http');

// ── HELPERS ──────────────────────────────────────────────────────

function fetchRaw(url, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
      },
      timeout: 15000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchRaw(next, hops + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function browserlessRequest(path, payload, timeoutMs = 35000) {
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) return Promise.reject(new Error('BROWSERLESS_TOKEN not set'));
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'production-sfo.browserless.io',
      path:     `${path}?token=${token}&timeout=${timeoutMs - 2000}&stealth=true`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout:  timeoutMs
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`Browserless ${res.statusCode}: ${data.slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Browserless timed out')); });
    req.write(body);
    req.end();
  });
}

// ── STRATEGY 1: IN-BROWSER EXTRACTION ────────────────────────────
// Uses Browserless /function to run real JS inside headless Chrome.
// Gets document.fonts, getComputedStyle, styleSheets — ground truth.

async function extractInBrowser(url) {
  // Runs inside headless Chrome via Browserless /function (Puppeteer context).
  // Three-layer font detection:
  //   Layer 1: Network interception — capture every .woff2 URL that loads (ground truth)
  //   Layer 2: document.styleSheets @font-face rules — all declared fonts
  //   Layer 3: document.fonts + getComputedStyle — actually rendered fonts
  const extractionScript = `
    module.exports = async ({ page }) => {
      const loadedFontUrls = [];

      // Stealth: mask headless Chrome signals that trigger bot detection (e.g. Stripe)
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'plugins',   { get: () => [1,2,3,4,5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
        window.chrome = { runtime: {} };
      });
      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      );

      // Layer 1: intercept font file responses BEFORE navigation
      page.on('response', resp => {
        const u = resp.url();
        if (/\.woff2?(\?|$)/i.test(u)) loadedFontUrls.push(u);
      });

      await page.goto(${JSON.stringify(url)}, {
        waitUntil: 'networkidle2',
        timeout: 28000
      });

      // Wait for FontFace API to settle (replaces deprecated waitForTimeout)
      await page.evaluate(() => document.fonts.ready);
      // Extra settle time for lazy-loaded fonts
      await page.evaluate(() => new Promise(r => setTimeout(r, 1200)));

      const data = await page.evaluate((fontUrls) => {
        // ── 1. FONTS: @font-face from document.styleSheets ───────────
        // Most reliable — catches ALL declared fonts, even if not yet rendered.
        // document.fonts only has fonts used on visible text; this catches everything.
        const fontSeen = new Set();
        const fontSet  = [];

        const addFont = (family, weight, source) => {
          if (!family) return;
          family = family.replace(/['"]/g, '').trim();
          const key = family.toLowerCase();
          if (!key || fontSeen.has(key)) return;
          fontSeen.add(key);
          fontSet.push({ family, weight: weight || '400', source });
        };

        // Scan all stylesheets for @font-face rules
        try {
          for (const sheet of Array.from(document.styleSheets)) {
            try {
              for (const rule of Array.from(sheet.cssRules || [])) {
                // CSSRule.FONT_FACE_RULE = 5
                if (rule.type === 5) {
                  const fam = rule.style.getPropertyValue('font-family');
                  const wt  = rule.style.getPropertyValue('font-weight') || '400';
                  addFont(fam, wt, '@font-face');
                }
              }
            } catch(e) { /* cross-origin sheet — skip */ }
          }
        } catch(e) {}

        // ── 2. FONTS: document.fonts (rendered FontFace set) ────────
        // Catches fonts that ARE being used to render text right now.
        Array.from(document.fonts).forEach(f => {
          addFont(f.family, f.weight, 'rendered');
        });

        // ── 3. FONTS: computed font-family on key elements ───────────
        const bodyFam    = getComputedStyle(document.body).fontFamily.split(',')[0].replace(/['"]/g,'').trim();
        const headingEl  = document.querySelector('h1,h2,[class*="heading"],[class*="title"],[class*="hero"]');
        const headingFam = headingEl ? getComputedStyle(headingEl).fontFamily.split(',')[0].replace(/['"]/g,'').trim() : null;
        addFont(bodyFam,    '400', 'computed-body');
        if (headingFam && headingFam !== bodyFam) addFont(headingFam, '700', 'computed-heading');

        // ── 4. CSS CUSTOM PROPERTIES ─────────────────────────────────
        const rootStyle = getComputedStyle(document.documentElement);
        const cssVars = {};
        for (const prop of rootStyle) {
          if (prop.startsWith('--')) {
            cssVars[prop] = rootStyle.getPropertyValue(prop).trim();
          }
        }

        // ── 5. COLORS from computed styles ───────────────────────────
        const colorFreq = {};
        const bump = (val, w) => {
          if (!val || val === 'transparent' || val === 'rgba(0, 0, 0, 0)') return;
          colorFreq[val] = (colorFreq[val] || 0) + w;
        };

        bump(rootStyle.backgroundColor, 5);
        bump(rootStyle.color, 3);
        const bodyStyle = getComputedStyle(document.body);
        bump(bodyStyle.backgroundColor, 5);
        bump(bodyStyle.color, 3);

        // Buttons — highest value for brand colors
        document.querySelectorAll('button,[class*="btn"],[class*="cta"],[class*="button"]').forEach(el => {
          const s = getComputedStyle(el);
          bump(s.backgroundColor, 10);
          bump(s.color, 4);
        });

        // Nav, header — strong brand signal
        document.querySelectorAll('nav, header, [class*="nav"], [class*="header"]').forEach(el => {
          const s = getComputedStyle(el);
          bump(s.backgroundColor, 6);
          bump(s.color, 3);
        });

        // Headings + links
        document.querySelectorAll('h1,h2,h3,a').forEach(el => {
          const s = getComputedStyle(el);
          bump(s.color, 2);
          bump(s.backgroundColor, 1);
        });

        // Broad sample
        Array.from(document.querySelectorAll('*')).slice(0, 400).forEach(el => {
          const s = getComputedStyle(el);
          bump(s.backgroundColor, 1);
          bump(s.color, 1);
          bump(s.borderTopColor, 0.3);
          if (s.fill && s.fill !== 'none') bump(s.fill, 0.5);
        });

        // ── 6. Token colors (CSS vars) ───────────────────────────────
        const tokenColors = {};
        const colorVarRe = /^--(color|brand|primary|secondary|accent|bg|background|surface|text|fg|foreground|fill|ui|cta|button|link)/i;
        for (const [k, v] of Object.entries(cssVars)) {
          if (colorVarRe.test(k) && /^(#|rgb|hsl)/.test(v)) tokenColors[k] = v;
        }

        // ── 7. Colors from @font-face / sheet rules ──────────────────
        const sheetColors = [];
        try {
          for (const sheet of Array.from(document.styleSheets)) {
            try {
              for (const rule of Array.from((sheet.cssRules || [])).slice(0, 300)) {
                const text = rule.cssText || '';
                (text.match(/#[0-9A-Fa-f]{6}\\b/g) || []).forEach(h => sheetColors.push(h.toUpperCase()));
                (text.match(/rgba?\\([^)]+\\)/g) || []).forEach(r => sheetColors.push(r));
              }
            } catch(e) {}
          }
        } catch(e) {}

        // ── 8. Spacing from CSS vars ─────────────────────────────────
        const spacingVals = [];
        for (const [k, v] of Object.entries(cssVars)) {
          if (/spacing|space|gap|padding|margin/.test(k)) {
            const n = parseFloat(v); if (!isNaN(n) && n > 0 && n <= 128) spacingVals.push(n);
          }
        }

        // ── 9. Stack from globals ────────────────────────────────────
        const stackHints = [];
        if (window.__NEXT_DATA__ || document.getElementById('__NEXT_DATA__')) stackHints.push('Next.js');
        else if (window.React || document.querySelector('[data-reactroot]')) stackHints.push('React');
        if (window.__nuxt__ || window.$nuxt) stackHints.push('Nuxt.js');
        if (window.__svelte) stackHints.push('Svelte');
        if (window.angular || window.ng) stackHints.push('Angular');
        if (window.__remixContext) stackHints.push('Remix');
        if (window.__GATSBY) stackHints.push('Gatsby');
        if (window.Framer || document.querySelector('[data-framer-component-type]')) stackHints.push('Framer');
        if (window.gsap) stackHints.push('GSAP');
        if (window.Shopify) stackHints.push('Shopify');
        if (window.Webflow) stackHints.push('Webflow');
        if (window.wp) stackHints.push('WordPress');

        return {
          fonts: fontSet,
          fontUrls,
          bodyFamily: bodyFam,
          headingFamily: headingFam,
          cssVars,
          tokenColors,
          colorFreq,
          sheetColors,
          spacingVals,
          stackHints,
          title: document.title,
          hasTokens: Object.keys(tokenColors).length > 0
        };
      }, loadedFontUrls);  // pass intercepted URLs into page context

      return data;
    };
  `;

  const raw = await browserlessRequest('/function', { code: extractionScript });
  return JSON.parse(raw);
}



// ── STRATEGY 2: FALLBACK HTML PARSING ────────────────────────────
// Used when Browserless is unavailable. Fetches HTML + linked CSS
// and extracts what it can via regex.

async function fetchAllStylesheets(html, baseUrl, maxSheets = 4) {
  const sheets = [];
  try {
    const base = new URL(baseUrl.startsWith('http') ? baseUrl : 'https://' + baseUrl);

    // Inline <style> blocks
    const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    let sm;
    while ((sm = styleRe.exec(html)) !== null) {
      if (sm[1] && sm[1].length > 100) sheets.push(sm[1]);
    }

    // <link rel="preload" as="font"> — font file hints
    const preloadRe  = /<link[^>]+as=["']font["'][^>]+href=["']([^"']+)["']/gi;
    const preloadRe2 = /<link[^>]+href=["']([^"']+\.woff2?)["'][^>]+as=["']font["']/gi;
    let pm;
    while ((pm = preloadRe.exec(html))  !== null) sheets.push(`/* PRELOAD_FONT: ${pm[1]} */`);
    while ((pm = preloadRe2.exec(html)) !== null) sheets.push(`/* PRELOAD_FONT: ${pm[1]} */`);

    // <link rel="stylesheet"> — both attribute orders
    const hrefs = [];
    const linkRe1 = /<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']/gi;
    const linkRe2 = /<link[^>]+href=["']([^"'.][^"']*\.css[^"']*)["'][^>]+rel=["']stylesheet["']/gi;
    let lm;
    while ((lm = linkRe1.exec(html)) !== null) hrefs.push(lm[1]);
    while ((lm = linkRe2.exec(html)) !== null) hrefs.push(lm[1]);

    const seen = new Set();
    const resolved = hrefs
      .filter(h => { if (seen.has(h)) return false; seen.add(h); return !/google|typekit|fontawesome|bootstrap-icons|ionicons|normalize|reset/i.test(h); })
      .map(h => h.startsWith('http') ? h : new URL(h, base).href);

    const results = await Promise.all(resolved.slice(0, 8).map(u => fetchRaw(u).catch(() => '')));
    const sorted  = results.filter(Boolean).sort((a, b) => b.length - a.length);
    sheets.push(...sorted.slice(0, maxSheets));
  } catch(e) {}
  return sheets.join('\n');
}

// ── SHARED POST-PROCESSING ────────────────────────────────────────
// These functions work on both browser-extracted and fallback data.

// Icon/utility font blocklist
const FONT_BLOCKLIST = new Set([
  'videojs','video-js','vjs',
  'fontawesome','font-awesome','fa','fas','far','fab',
  'glyphicons','bootstrap-icons','material-icons','material-symbols',
  'ionicons','remixicon','feather','lucide','heroicons',
  'icomoon','linearicons','themify','themify-icons',
  'swiper-icons','dashicons','genericons',
  'codicons','vscode-codicons','octicons',
]);

function isIconFont(name) {
  const key = name.toLowerCase().replace(/[-_\s]/g, '');
  return FONT_BLOCKLIST.has(key) ||
    FONT_BLOCKLIST.has(name.toLowerCase()) ||
    /-icons?$|-glyphs?$|-symbols?$/i.test(name) ||
    /^[a-z]{1,2}$/i.test(name.trim());
}

function cleanFontName(name) {
  if (!name) return name;
  name = name.replace(/^['"]+|['"]+$/g, '').trim();
  const KNOWN = {
    // Klim / Swiss
    'sohne':'Söhne', 'söhne':'Söhne', 'sohne-var':'Söhne', 'soehne':'Söhne',
    'suisseintl':'Suisse Intl', 'uisseintl':'Suisse Intl', 'suisse intl':'Suisse Intl',
    'suisseworks':'Suisse Works', 'suissemono':'Suisse Mono',
    'tiempos':'Tiempos', 'tiempostext':'Tiempos Text', 'tiemposheadline':'Tiempos Headline',
    // Commercial sans
    'graphik':'Graphik', 'graphikcondensed':'Graphik Condensed',
    'circular':'Circular', 'circularpro':'Circular Pro', 'circularstd':'Circular',
    'favorit':'Favorit', 'favoritextended':'Favorit Extended',
    'roobert':'Roobert',
    'untitledsans':'Untitled Sans', 'untitled-sans':'Untitled Sans',
    'basiercircle':'Basier Circle', 'basier-circle':'Basier Circle',
    'monumentgrotesk':'Monument Grotesk',
    'neuehaasunica':'Neue Haas Unica', 'neuehaasgrotesk':'Neue Haas Grotesk',
    'neuefrutiger':'Neue Frutiger', 'neuefrutigerarabic':'Neue Frutiger Arabic',
    'aktiv-grotesk':'Aktiv Grotesk', 'aktivgrotesk':'Aktiv Grotesk',
    'camphor':'Camphor',
    // Google fonts
    'inter-var':'Inter', 'inter var':'Inter',
    'geist-sans':'Geist', 'geistsans':'Geist',
    'geist-mono':'Geist Mono', 'geistmono':'Geist Mono',
    'sourcecodepro':'Source Code Pro', 'source-code-pro':'Source Code Pro',
    'jetbrainsmono':'JetBrains Mono', 'jetbrains-mono':'JetBrains Mono',
    'ibmplexsans':'IBM Plex Sans', 'ibmplexmono':'IBM Plex Mono', 'ibmplexserif':'IBM Plex Serif',
    'dmsans':'DM Sans', 'dmserif':'DM Serif', 'dmmono':'DM Mono',
    'plusjakartasans':'Plus Jakarta Sans',
    'bricolagegrotesque':'Bricolage Grotesque',
    'nunitosans':'Nunito Sans',
    'figtree':'Figtree', 'outfit':'Outfit',
    // System
    'sfprodisplay':'SF Pro', 'sfprotext':'SF Pro', 'sfpro':'SF Pro',
    'sf pro display':'SF Pro', 'sf pro text':'SF Pro',
    // Brand/product
    'intercom-font':'Intercom', 'intercomfont':'Intercom',
    'pinsans':'Pin Sans', 'pin-sans':'Pin Sans',
    'airbnbcereal':'Airbnb Cereal',
    'lyftpro':'Lyft Pro', 'ubermove':'Uber Move',
  };
  const key = name.toLowerCase().replace(/\s+/g, '');
  if (KNOWN[key]) return KNOWN[key];
  if (KNOWN[name.toLowerCase()]) return KNOWN[name.toLowerCase()];
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/-(?:var|variable|display|text|italic|roman|regular|semibold|bold)$/i, '')
    .replace(/\s+(?:Variable|Display|Text|Italic|Regular)$/i, '')
    .trim();
}

function shapeFonts(rawFonts) {
  // rawFonts: array of { family, weight, style } from document.fonts
  // or from fallback extraction
  const seen = new Set();
  const out  = [];
  for (const f of rawFonts) {
    const name = cleanFontName(f.family || f.name || '');
    if (!name || isIconFont(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const isMono    = /mono|code|console|courier/i.test(name);
    const isDisplay = /display|heading|title|hero|syne|editorial/i.test(name);
    out.push({
      pre:     isMono ? '01' : name.charAt(0).toUpperCase(),
      name,
      weights: f.weight || '400',
      role:    isMono ? 'mono' : isDisplay ? 'display' : 'body',
      tags:    [f.source || f.src, f.weight && f.weight !== '400' && f.weight !== 'normal' ? `w${f.weight}` : null].filter(Boolean)
    });
    if (out.length === 4) break;
  }
  return out;
}

// Color processing — shared between browser and fallback paths
function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function toHex(str) {
  if (!str) return null;
  str = str.trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(str)) return str.toUpperCase();
  let m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(str);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map(x => Math.round(parseFloat(x)));
    if (r === 0 && g === 0 && b === 0) return null; // pure transparent black — skip
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  m = /hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%?[\s,]+([\d.]+)%/.exec(str);
  if (m) return hslToHex(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
  return null;
}

function processColors(freqMap) {
  const NOISE = new Set([
    '#4285F4','#34A853','#FBBC05','#EA4335',
    '#1877F2','#1DA1F2','#FF6201','#5865F2',
    '#FF0000','#25D366','#0A66C2',
  ]);

  function hexToRgb(h)   { return [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)]; }
  function brightness(h) { const [r,g,b] = hexToRgb(h); return (r*299+g*587+b*114)/1000; }
  function saturation(h) { const [r,g,b] = hexToRgb(h); const mx=Math.max(r,g,b), mn=Math.min(r,g,b); return mx===0?0:(mx-mn)/mx; }
  function colorDist(a,b){ const [r1,g1,b1]=hexToRgb(a),[r2,g2,b2]=hexToRgb(b); return Math.sqrt((r1-r2)**2*2+(g1-g2)**2*4+(b1-b2)**2*2); }
  function colorName(hex) {
    const [r,g,b] = hexToRgb(hex);
    const br = brightness(hex), sat = saturation(hex);
    if (br > 230 && sat < 0.15) return 'White';
    if (br < 15  && sat < 0.2)  return 'Black';
    if (br < 40  && sat < 0.25) return 'Near Black';
    if (br > 200 && sat < 0.10) return 'White';
    if (br > 170 && sat < 0.12) return 'Light Grey';
    if (br > 120 && sat < 0.12) return 'Grey';
    if (br < 100 && sat < 0.2)  return 'Dark Grey';
    const hue = Math.atan2(Math.sqrt(3)*(g-b), 2*r-g-b) * 180 / Math.PI;
    const h = (hue + 360) % 360;
    if (sat < 0.15) return 'Grey';
    // Reds
    if (h < 15 || h >= 345) return br < 80 ? 'Dark Red' : (r > 220 && br > 160) ? 'Coral' : 'Red';
    // Oranges
    if (h < 40)  return br < 100 ? 'Rust'   : 'Orange';
    // Yellows / golds
    if (h < 65)  return br < 170 ? 'Gold'   : 'Yellow';
    // Greens — split dark forest from bright/neon
    if (h < 150) {
      if (br < 80)  return 'Forest Green';
      if (br > 160) return 'Light Green';
      return sat > 0.7 ? 'Bright Green' : 'Green';
    }
    // Teals
    if (h < 195) return br < 100 ? 'Dark Teal' : 'Teal';
    // Blues
    if (h < 255) {
      if (br < 80)  return 'Dark Blue';
      if (b > 180 && sat > 0.6) return 'Electric Blue';
      return b > r + 40 ? 'Indigo' : 'Blue';
    }
    if (h < 290) return br < 100 ? 'Deep Purple' : 'Purple';
    if (h < 340) return br > 150 ? 'Pink' : 'Magenta';
    return 'Neutral';
  }
  function badgeBg(hex) {
    const br = brightness(hex), [r,g,b] = hexToRgb(hex);
    if (br > 200) return '#f0f0f2';
    return `rgb(${Math.min(255,r+170)},${Math.min(255,g+170)},${Math.min(255,b+170)})`;
  }
  function badgeFg(hex) {
    const br = brightness(hex), [r,g,b] = hexToRgb(hex);
    if (br > 200) return '#888';
    return `rgb(${Math.max(0,r-60)},${Math.max(0,g-60)},${Math.max(0,b-60)})`;
  }

  // Normalise freqMap keys to hex, accumulate weights
  const freq = {};
  for (const [raw, w] of Object.entries(freqMap)) {
    const hex = toHex(raw);
    if (!hex) continue;
    const br = brightness(hex);
    if (br > 252) continue; // pure white
    if (br < 5)  continue; // pure black / transparent
    if (NOISE.has(hex)) continue;
    freq[hex] = (freq[hex] || 0) + w;
  }

  // Boost saturated colors so brand colors outrank greys
  Object.keys(freq).forEach(hex => {
    const sat = saturation(hex), br = brightness(hex);
    if (sat > 0.45 && br > 30 && br < 220) freq[hex] *= (1 + sat);
  });

  const sorted = Object.keys(freq).sort((a, b) => freq[b] - freq[a]);

  // Perceptual deduplication
  const deduped = [];
  for (const hex of sorted) {
    const br  = brightness(hex), sat = saturation(hex);
    const isVeryDark  = br < 40  && sat < 0.3;
    const isSaturated = sat > 0.35;
    const tooClose = deduped.some(kept => {
      const kBr  = brightness(kept), kSat = saturation(kept);
      const dist = colorDist(hex, kept);
      if (isVeryDark && kBr < 40 && kSat < 0.3) return dist < 60;
      if (isSaturated && kSat > 0.35)            return dist < 80;
      return dist < 40;
    });
    if (!tooClose) deduped.push(hex);
    if (deduped.length === 5) break;
  }

  // Sort: neutrals first, then chromatic brand colors
  const neutrals  = deduped.filter(h => saturation(h) < 0.25).sort((a,b) => brightness(a)-brightness(b));
  const chromatic = deduped.filter(h => saturation(h) >= 0.25).sort((a,b) => freq[b]-freq[a]);
  const ordered   = [...neutrals, ...chromatic].slice(0, 5);

  const ROLES = ['Background','Primary','Accent','Surface','Muted'];
  return ordered.map((hex, i) => ({
    hex, name: colorName(hex), role: ROLES[i] || 'Color',
    rc: badgeBg(hex), rt: badgeFg(hex)
  }));
}

// ── FALLBACK FONT EXTRACTION (regex-based) ────────────────────────

function buildCssVarMap(html) {
  const map = {}, re = /--([a-zA-Z][a-zA-Z0-9-]*)\s*:\s*([^;}{]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const val = m[2].trim().replace(/['"]/g, '');
    if (val && !val.startsWith('var(')) map['--' + m[1]] = val;
  }
  return map;
}

function resolveFontVar(raw, varMap) {
  const vm = /var\(\s*(--[^,)]+)/.exec(raw);
  if (!vm) return raw;
  const resolved = varMap[vm[1].trim()];
  if (!resolved) return null;
  return resolved.split(',')[0].trim().replace(/['"]/g, '');
}

function extractFontsFromHtml(html) {
  const seen = {}, fonts = [], varMap = buildCssVarMap(html);
  const SKIP = new Set([
    'inherit','initial','unset','revert','none',
    'sans-serif','serif','monospace','cursive','fantasy','math',
    'system-ui','ui-sans-serif','ui-serif','ui-monospace','ui-rounded',
    '-apple-system','blinkmacsystemfont',
    'helvetica neue','helvetica','arial','georgia','times','times new roman',
    'verdana','tahoma','trebuchet ms','impact',
    'menlo','monaco','consolas','courier new','lucida console',
    'segoe ui','segoe ui emoji','pingfang sc','pingfang tc',
    'ans-serif','ans serif','erif',
  ]);

  const add = (name, src, weight = '400') => {
    if (!name) return;
    name = name.replace(/^['"]+|['"]+$/g, '').trim();
    if (!name || name.startsWith('var(') || name.startsWith('--')) return;
    if (isIconFont(name) || SKIP.has(name.toLowerCase())) return;
    const key = name.toLowerCase();
    if (!seen[key]) { seen[key] = true; fonts.push({ family: name, weight, source: src }); }
  };

  let m;
  // P0: preload font hints
  const preloadRe = /PRELOAD_FONT:\s*(\S+)/g;
  while ((m = preloadRe.exec(html)) !== null) {
    const file = m[1].trim().split('/').pop().replace(/\.woff2?(\?.*)?$/i, '');
    let slug = file;
    // Strip content hashes (Next.js/Vercel: fontname_n4.abc123longHash)
    slug = slug.replace(/[._][a-zA-Z0-9]{20,}.*$/, '');
    // Strip Next.js weight/style variant suffixes
    slug = slug.replace(/[_-][ni]\d$/i, '');
    // Strip standard weight/style words
    slug = slug.replace(/[-_](buch|regular|bold|medium|semibold|light|thin|italic|roman|web|var|variable|\d{3})$/i, '');
    slug = slug.replace(/[-_](buch|regular|bold|medium|light|italic|roman|web|var|\d{3})$/i, '');
    if (!slug || slug.length < 3) continue;
    if (/^[0-9a-f]{8,}$/i.test(slug)) continue;
    add(slug, 'preload');
  }

  // P1: @font-face
  const faceRe = /@font-face\s*\{([^}]+)\}/gi;
  while ((m = faceRe.exec(html)) !== null) {
    const block = m[1];
    const nm = /font-family\s*:\s*['"']?([^'";\n]+)['"']?/i.exec(block);
    if (!nm) continue;
    let name = nm[1].trim().replace(/['"]/g, '');
    if (name.startsWith('var(')) name = resolveFontVar(name, varMap) || '';
    if (!name) continue;
    const wm = /font-weight\s*:\s*([^;]+)/i.exec(block);
    add(name, '@font-face', wm ? wm[1].trim() : '400');
  }

  // P2: Google Fonts
  const gfRe = /fonts\.googleapis\.com\/css2?\?family=([^"' >\n&]+)/g;
  while ((m = gfRe.exec(html)) !== null) {
    try { decodeURIComponent(m[1]).split('|').forEach(f => add(f.split(':')[0].replace(/\+/g,' ').trim(), 'Google Fonts')); } catch(e) {}
  }

  // P3: woff2 filenames
  const woffSeen = new Set(), woffRe = /\/([a-zA-Z][a-zA-Z0-9_.-]{2,80})\.woff2?/g;
  while ((m = woffRe.exec(html)) !== null) {
    let slug = m[1];
    // Strip content hashes — Next.js/Vercel font optimization appends a dot + 20+ char hash
    // e.g. geist_n4.6e27f2oc83b0a07405... → geist_n4 → geist
    slug = slug.replace(/[._][a-zA-Z0-9]{20,}.*$/, '');
    // Strip Next.js weight/style variant suffixes: _n4 _n7 _i4 (normal/italic + weight digit)
    slug = slug.replace(/[_-][ni]\d$/i, '');
    // Strip standard weight/style words
    slug = slug.replace(/[-_](buch|regular|bold|medium|semibold|light|thin|italic|roman|web|var|variable|\d{3})$/i, '');
    slug = slug.replace(/[-_](buch|regular|bold|medium|light|italic|roman|web|var|\d{3})$/i, '');
    if (!slug || slug.length < 3) continue;
    if (/^\d+$/.test(slug) || /^[0-9a-f]{8,}$/i.test(slug)) continue; // pure number or hash
    if (woffSeen.has(slug.toLowerCase())) continue;
    woffSeen.add(slug.toLowerCase());
    const candidate = slug
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/(^|[-_])([a-z])/g, (_, pre, ch) => (pre?' ':'')+ch.toUpperCase())
      .replace(/[-_]/g,' ').replace(/\s+/g,' ').trim();
    add(candidate, 'woff');
  }

  // P4: font-family declarations
  const cssRe = /font-family\s*:\s*([^;}{\\n]{1,120})/gi;
  while ((m = cssRe.exec(html)) !== null) {
    let raw = m[1].trim();
    if (raw.startsWith('var(')) { raw = resolveFontVar(raw, varMap) || ''; if (!raw) continue; }
    const name = raw.split(',')[0].trim().replace(/['"]/g,'');
    if (name && !name.startsWith('var(')) add(name, 'CSS');
  }

  return shapeFonts(fonts);
}

function extractColorsFromHtml(html) {
  const freq = {};
  const bump = (hex, w) => { if (hex) freq[hex] = (freq[hex]||0) + w; };

  // CSS token properties (highest weight)
  const tokenRe = /--(?:color|brand|primary|secondary|accent|bg|background|surface|text|fg|foreground|fill|ui|cta|button|link|highlight)[^:]*\s*:\s*(#[0-9A-Fa-f]{6}|rgba?\([^)]+\)|hsla?\([^)]+\))/gi;
  let m;
  while ((m = tokenRe.exec(html)) !== null) { const h = toHex(m[1]); if (h) bump(h, 5); }

  const hexRe = /#([0-9A-Fa-f]{6})\b/g;
  while ((m = hexRe.exec(html)) !== null) bump('#'+m[1].toUpperCase(), 1);

  const rgbRe = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/g;
  while ((m = rgbRe.exec(html)) !== null) { const h = toHex(`rgb(${m[1]},${m[2]},${m[3]})`); if (h) bump(h, 1); }

  const hslRe = /hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%?[\s,]+([\d.]+)%/g;
  while ((m = hslRe.exec(html)) !== null) { try { const h = hslToHex(parseFloat(m[1]),parseFloat(m[2]),parseFloat(m[3])); if (h) bump(h,1); } catch(e){} }

  return processColors(freq);
}

// ── STACK DETECTION ───────────────────────────────────────────────
// Works on both browser hints and raw HTML

function detectStack(html, browserHints = []) {
  const s = [], h = html.toLowerCase();

  // Browser-detected globals are ground truth — add those first
  const browserMap = {
    'Next.js':      { ico:'▲',  cat:'Meta Framework' },
    'Nuxt.js':      { ico:'💚', cat:'Meta Framework' },
    'Remix':        { ico:'💿', cat:'Meta Framework' },
    'Gatsby':       { ico:'💜', cat:'Meta Framework' },
    'React':        { ico:'⚛️', cat:'UI Framework' },
    'Vue.js':       { ico:'💚', cat:'UI Framework' },
    'Svelte':       { ico:'🔥', cat:'UI Framework' },
    'Angular':      { ico:'🔴', cat:'UI Framework' },
    'GSAP':         { ico:'🎞️', cat:'Animation' },
    'Framer Motion':{ ico:'✨', cat:'Animation' },
    'Tailwind CSS': { ico:'🎨', cat:'Styling' },
    'Framer':       { ico:'🖼️', cat:'No-code' },
    'Shopify':      { ico:'🛍️', cat:'E-commerce' },
    'WordPress':    { ico:'📝', cat:'CMS' },
    'Webflow':      { ico:'🌊', cat:'No-code' },
  };

  const seen = new Set();
  for (const hint of browserHints) {
    if (browserMap[hint] && !seen.has(hint)) {
      seen.add(hint);
      s.push({ ico: browserMap[hint].ico, name: hint, cat: browserMap[hint].cat, det: true });
    }
  }

  // HTML-based detection for anything not caught by browser
  const add = (ico, name, cat) => {
    if (!seen.has(name)) { seen.add(name); s.push({ ico, name, cat, det: true }); }
  };

  if (!seen.has('Next.js') && (h.includes('__next') || h.includes('/_next/')))       add('▲',  'Next.js',        'Meta Framework');
  else if (!seen.has('React') && (h.includes('react') || h.includes('data-reactroot'))) add('⚛️', 'React',          'UI Framework');
  if (!seen.has('Vue.js') && h.includes('vue'))                                       add('💚', 'Vue.js',         'UI Framework');
  if (!seen.has('Svelte') && h.includes('svelte'))                                    add('🔥', 'Svelte',         'UI Framework');
  if (!seen.has('Angular') && h.includes('ng-version'))                               add('🔴', 'Angular',        'UI Framework');
  if (!seen.has('Tailwind CSS') && h.includes('tailwind'))                            add('🎨', 'Tailwind CSS',   'Styling');
  if (h.includes('emotion') || h.includes('css-in-js'))                              add('💅', 'Emotion',        'CSS-in-JS');
  if (h.includes('styled-components') || h.includes('sc-'))                          add('💅', 'styled-components','CSS-in-JS');
  if (h.includes('radix-ui') || h.includes('@radix'))                                add('🔲', 'Radix UI',       'Component System');
  if (h.includes('shadcn'))                                                           add('🪄', 'shadcn/ui',      'Component System');
  if (!seen.has('Framer Motion') && (h.includes('framer-motion') || h.includes('data-framer-motion')))
                                                                                      add('✨', 'Framer Motion',  'Animation');
  if (!seen.has('GSAP') && (h.includes('gsap') || h.includes('greensock')))          add('🎞️', 'GSAP',           'Animation');
  if (!seen.has('WordPress') && (h.includes('wordpress') || h.includes('wp-content'))) add('📝','WordPress',     'CMS');
  if (!seen.has('Shopify') && (h.includes('myshopify.com') || h.includes('shopify-section')))
                                                                                      add('🛍️', 'Shopify',        'E-commerce');
  if (!seen.has('Webflow') && h.includes('webflow'))                                  add('🌊', 'Webflow',        'No-code');
  if (!seen.has('Framer') && (h.includes('framer.com') || h.includes('__framer')))   add('🖼️', 'Framer',         'No-code');

  if (s.length === 0) s.push({ ico:'🌐', name:'Custom Stack', cat:'HTML/CSS/JS', det:false });
  return s.slice(0, 5);
}

function extractSpacingFromHtml(html) {
  const raw = new Set();
  const re  = /(?:padding|margin|gap)\s*:\s*(\d+)px/gi;
  let m;
  while ((m = re.exec(html)) !== null) { const v = parseInt(m[1]); if (v > 0 && v <= 128) raw.add(v); }
  const sorted = [...raw].sort((a, b) => a - b);
  return sorted.length >= 4 ? sorted.slice(0, 6) : [4, 8, 16, 24, 40, 64];
}

// ── SCORING & PERSONALITY ─────────────────────────────────────────

function scoreDesign({ fonts, colors, stack, hasTokens, rendered }) {
  let score = 58;
  if (fonts.length >= 2)                                       score += 7;
  if (fonts.some(f => f.role === 'mono'))                      score += 4;
  if (colors.length >= 4)                                      score += 8;
  if (hasTokens)                                               score += 10;
  if (stack.some(s => /Tailwind|Radix|shadcn/.test(s.name)))  score += 5;
  if (stack.some(s => /Motion|GSAP/.test(s.name)))             score += 5;
  if (rendered)                                                score += 3;
  return Math.min(score, 99);
}

function derivePersonality({ fonts, colors, stack, hasTokens }) {
  const hasMotion  = stack.some(s => /Motion|GSAP/.test(s.name));
  const hasMinimal = colors.length <= 3;
  const isModern   = hasTokens || stack.some(s => /Radix|shadcn|Tailwind/.test(s.name));
  const isPlayful  = fonts.some(f => /syne|display|rounded/i.test(f.name)) || hasMotion;
  return [
    { l:'Minimal',  r:'Maximal', v: hasMinimal ? 20 : colors.length >= 5 ? 65 : 40 },
    { l:'Playful',  r:'Serious', v: isPlayful ? 35 : 68 },
    { l:'Warm',     r:'Cool',    v: 62 },
    { l:'Classic',  r:'Modern',  v: isModern ? 82 : 50 },
  ];
}

// ── MAIN HANDLER ──────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')   { res.status(405).json({ error: 'POST only' }); return; }

  let url = req.body?.url;
  if (!url) { res.status(400).json({ error: 'URL required' }); return; }
  if (!url.startsWith('http')) url = 'https://' + url;

  const domain = (() => { try { return new URL(url).hostname.replace('www.', ''); } catch(e) { return url; } })();

  let fonts, colors, stack, spacing, hasTokens, title, rendered = false;
  const LABELS = ['xs','sm','md','lg','xl','2xl'];

  try {
    if (process.env.BROWSERLESS_TOKEN) {
      // ── PATH A: In-browser extraction (ground truth) ──────────────
      try {
        console.log('Attempting in-browser extraction for', domain);
        const bd = await extractInBrowser(url);
        rendered = true;
        title = bd.title || domain;

        // Fonts: 3-layer merge
        // Layer 1 (highest): network-intercepted .woff2 URLs — ground truth
        const urlFonts = (bd.fontUrls || []).map(u => {
          const file = u.split('/').pop().split('?')[0].replace(/\.woff2?(\?.*)?$/i, '');
          let slug = file;
          // Strip content hashes: any segment of 20+ alphanumeric chars after . or _
          // Catches Next.js/Vercel optimized filenames: geist_n4.6e27f2oc83b0... → geist
          slug = slug.replace(/[._][a-zA-Z0-9]{20,}.*$/, '');
          // Strip Next.js weight/style variant suffixes: _n4 _n7 _i4 (normal/italic + digit)
          slug = slug.replace(/[_-][ni]\d$/i, '');
          // Strip common weight/style words
          slug = slug.replace(/[-_](buch|regular|bold|medium|semibold|light|thin|italic|roman|web|var|variable|\d{3})$/i, '');
          slug = slug.replace(/[-_](buch|regular|bold|medium|light|italic|roman|web|var|\d{3})$/i, '');
          if (!slug || slug.length < 3) return null;
          // Skip if still looks like a hash (no real word chars)
          if (/^[0-9a-f]{8,}$/i.test(slug)) return null;
          const family = slug
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/(^|[-_])([a-z])/g, (_, p, c) => (p ? ' ' : '') + c.toUpperCase())
            .replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
          return { family, weight: '400', source: 'network' };
        }).filter(Boolean);

        // Layer 2: @font-face rules + document.fonts
        const browserFonts = [...urlFonts, ...(bd.fonts || [])];
        // Layer 3: fallback to computed families
        if (browserFonts.length === 0 && bd.bodyFamily) {
          browserFonts.push({ family: bd.bodyFamily, weight: '400', source: 'computed' });
        }
        if (bd.headingFamily && bd.headingFamily !== bd.bodyFamily) {
          browserFonts.push({ family: bd.headingFamily, weight: '700', source: 'computed-heading' });
        }
        fonts = shapeFonts(browserFonts);
        console.log('Fonts detected:', fonts.map(f => f.name).join(', ') || 'none');

        // If browser returned no real fonts (bot-blocked or lazy-loaded),
        // fall back to fetching CSS directly and parsing @font-face rules
        const isSystemOnly = fonts.length === 0 ||
          (fonts.length === 1 && /system.ui|system ui/i.test(fonts[0].name));
        if (isSystemOnly) {
          console.log('No real fonts from browser — running CSS font fallback for', domain);
          try {
            const rawHtml = await fetchRaw(url);
            const extraCss = await fetchAllStylesheets(rawHtml, url).catch(() => '');
            const fallbackFonts = extractFontsFromHtml(rawHtml + extraCss);
            if (fallbackFonts.length > 0) {
              fonts = fallbackFonts;
              console.log('CSS fallback fonts:', fonts.map(f => f.name).join(', '));
            }
          } catch(e) { console.warn('CSS font fallback failed:', e.message); }
        }

        // Colors: merge token colors (high weight) + computed freq map + sheet colors
        const colorFreq = { ...(bd.colorFreq || {}) };
        // Token colors get a big boost — they're intentional design decisions
        for (const [, val] of Object.entries(bd.tokenColors || {})) {
          const hex = toHex(val);
          if (hex) colorFreq[val] = (colorFreq[val] || 0) + 15;
        }
        // Sheet colors at medium weight
        for (const c of (bd.sheetColors || [])) {
          colorFreq[c] = (colorFreq[c] || 0) + 2;
        }
        colors = processColors(colorFreq);

        stack    = detectStack('', bd.stackHints || []);
        hasTokens = bd.hasTokens || false;

        // Spacing
        const spVals = bd.spacingVals?.length >= 3 ? bd.spacingVals.sort((a,b)=>a-b).slice(0,6) : [4,8,16,24,40,64];
        spacing = spVals.map((v, i) => ({ n: LABELS[i], v }));

        console.log(`In-browser: ${fonts.length} fonts, ${colors.length} colors, ${stack.length} stack items`);
      } catch (bErr) {
        console.warn('In-browser extraction failed, falling back to HTML parsing:', bErr.message);
        rendered = false;
        // Fall through to PATH B
        throw bErr;
      }
    } else {
      throw new Error('No Browserless token — using fallback');
    }
  } catch(_) {
    // ── PATH B: HTML parsing fallback ─────────────────────────────
    try {
      let html = await fetchRaw(url);
      title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1]?.trim() || domain;

      const extraCss = await fetchAllStylesheets(html, url).catch(() => '');
      if (extraCss) html += extraCss;

      hasTokens = /--(color|brand|primary|secondary|accent|bg|surface|fg)\b/.test(html);
      fonts     = extractFontsFromHtml(html);
      colors    = extractColorsFromHtml(html);
      stack     = detectStack(html);

      const spVals = extractSpacingFromHtml(html);
      spacing = spVals.map((v, i) => ({ n: LABELS[i], v }));
    } catch (fallbackErr) {
      return res.status(500).json({ error: fallbackErr.message });
    }
  }

  const tech = (() => {
    const found = stack.find(s => ['Next.js','Nuxt.js','SvelteKit','Gatsby','Remix'].includes(s.name))
               || stack.find(s => ['React','Vue.js','Svelte','Angular'].includes(s.name));
    return found ? found.name : stack[0]?.name || 'Custom';
  })();

  const score       = scoreDesign({ fonts, colors, stack, hasTokens, rendered });
  const personality = derivePersonality({ fonts, colors, stack, hasTokens });
  const hasMotion   = stack.some(s => /Motion|GSAP/.test(s.name));
  const motionStyle = stack.some(s => /Motion/.test(s.name)) ? 'Spring physics'
                    : stack.some(s => /GSAP/.test(s.name))   ? 'Timeline-based'
                    : 'CSS ease-in-out';

  res.status(200).json({
    meta: { url: domain, title },
    fonts:  fonts?.length  ? fonts  : [{ pre:'Aa', name:'System UI', weights:'400', role:'body', tags:['System'] }],
    colors: colors?.length ? colors : [{ hex:'#333333', name:'Dark', role:'Primary', rc:'#f0f0f2', rt:'#888' }],
    stack,
    score,
    tech,
    rendered,
    personality,
    motion: [
      { n:'Style',    v: motionStyle },
      { n:'Duration', v: hasMotion ? '300–600ms' : '150–250ms' },
      { n:'Easing',   v: hasMotion ? 'Spring / cubic-bezier' : 'ease-in-out' },
    ],
    fingerprint: [
      { k:'Framework', v: tech,                  s: 'Detected from markup' },
      { k:'Grid',      v: '8pt',                 s: '8px baseline grid' },
      { k:'Base Font', v: '16px',                s: 'Standard rem base' },
      { k:'Tokens',    v: hasTokens ? '✓' : '—', s: hasTokens ? 'CSS custom props found' : 'No token system detected' },
    ],
    spacing,
  });
};
