// ─────────────────────────────────────────────────────────────────
//  Glassdeck  ·  analyze.js  v2
//  Deploy: Vercel /api/analyze  (no Railway needed)
//
//  Strategy:
//    1. Plain fetch  — fast, free, works for ~60% of sites
//    2. Browserless  — full JS rendering for SPAs (React/Next/Vue)
//       Sign up free at browserless.io, set BROWSERLESS_TOKEN in
//       Vercel env vars. 500 minutes/month free — plenty for launch.
// ─────────────────────────────────────────────────────────────────

const https = require('https');
const http  = require('http');

// ── 1. FETCHERS ──────────────────────────────────────────────────

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
      timeout: 12000
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

// Browserless REST — returns fully JS-rendered HTML.
// Uses the /chrome/content endpoint (Browserless v2 API).
function fetchRendered(url) {
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) return Promise.reject(new Error('BROWSERLESS_TOKEN not set'));

  // Browserless v2: minimal payload — just url
  const payload = JSON.stringify({ url });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'production-sfo.browserless.io',
      path:     `/content?token=${token}&timeout=25000&stealth=true`,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 28000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`Browserless ${res.statusCode}: ${data.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Browserless timed out')); });
    req.write(payload);
    req.end();
  });
}

// Fetches the first external stylesheet linked in the HTML (catches self-hosted font @font-face)
async function fetchFirstStylesheet(html, baseUrl) {
  try {
    const base = new URL(baseUrl.startsWith('http') ? baseUrl : 'https://' + baseUrl);
    const linkRe = /<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']/gi;
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      const href = m[1];
      if (href.includes('google') || href.includes('typekit')) continue; // skip known font CDNs
      const cssUrl = href.startsWith('http') ? href : new URL(href, base).href;
      try {
        const css = await fetchRaw(cssUrl);
        if (css && css.includes('@font-face')) return css;
      } catch(e) {}
    }
  } catch(e) {}
  return '';
}


// ── 2. FONT EXTRACTION ───────────────────────────────────────────

function extractFonts(html) {
  const seen  = {};
  const fonts = [];

  const add = (name, src, weight = '400') => {
    const key = name.toLowerCase();
    if (!seen[key] && name.length > 1) {
      seen[key] = true;
      fonts.push({ name, src, weight });
    }
  };

  // Priority 1: @font-face blocks (most accurate — catches self-hosted fonts)
  const fontFaceRe = /@font-face\s*\{([^}]+)\}/gi;
  let m;
  while ((m = fontFaceRe.exec(html)) !== null) {
    const block  = m[1];
    const nameM  = /font-family\s*:\s*['"]?([^'";]+)['"]?/i.exec(block);
    if (!nameM) continue;
    const name    = nameM[1].trim().replace(/['"]/g, '');
    const weightM = /font-weight\s*:\s*([^;]+)/i.exec(block);
    add(name, '@font-face', weightM ? weightM[1].trim() : '400');
  }

  // Priority 2: Google Fonts URL params
  const gfRe = /fonts\.googleapis\.com\/css2?\?family=([^"' >\n&]+)/g;
  while ((m = gfRe.exec(html)) !== null) {
    try {
      decodeURIComponent(m[1]).split('|').forEach(f => {
        const name = f.split(':')[0].replace(/\+/g, ' ').trim();
        if (name) add(name, 'Google Fonts');
      });
    } catch(e) {}
  }

  // Priority 3: font-family declarations (catch CSS-in-JS / inline styles)
  const SKIP = new Set([
    'inherit','initial','unset','sans-serif','serif','monospace',
    'system-ui','ui-sans-serif','ui-serif','ui-monospace','ui-rounded',
    '-apple-system','blinkmacsystemfont','helvetica neue','helvetica',
    'arial','georgia','times','verdana','trebuchet ms','cursive','fantasy'
  ]);
  const cssRe = /font-family\s*:\s*['"]?([A-Za-z][^'";,\n{}]{1,50})['"]?/gi;
  while ((m = cssRe.exec(html)) !== null) {
    const raw  = m[1].trim().replace(/['"]/g, '');
    const name = raw.split(',')[0].trim();
    if (name && !SKIP.has(name.toLowerCase())) add(name, 'CSS');
  }

  // Shape for render()
  return fonts.slice(0, 4).map(f => {
    const isMono    = /mono|code|console|courier/i.test(f.name);
    const isDisplay = /display|heading|title|hero|syne|editorial/i.test(f.name);
    return {
      pre:     isMono ? '01' : (f.name.charAt(0).toUpperCase() || 'Aa'),
      name:    f.name,
      weights: f.weight,
      role:    isMono ? 'mono' : isDisplay ? 'display' : 'body',
      tags:    [f.src, f.weight && f.weight !== '400' ? `w${f.weight}` : null].filter(Boolean)
    };
  });
}

// ── 3. COLOR EXTRACTION ──────────────────────────────────────────

function rgbToHex(str) {
  if (!str) return null;
  str = str.trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(str)) return str.toUpperCase();
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(str);
  if (!m) return null;
  return '#' + [m[1], m[2], m[3]]
    .map(x => parseInt(x).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function colorName(hex) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  if (r > 220 && g > 220 && b > 220) return 'White';
  if (r < 40  && g < 40  && b < 40)  return 'Black';
  if (r < 80  && g < 80  && b < 80)  return 'Dark';
  if (r > 200 && g > 180 && b < 80)  return 'Gold';
  if (r > 220 && g > 100 && b < 80)  return 'Orange';
  if (r > 180 && g < 100 && b < 100) return 'Red';
  if (g > r && g > b)                 return 'Green';
  if (b > r && b > g)                 return r > 120 ? 'Periwinkle' : 'Blue';
  if (r > 150 && b > 150 && g < 120) return 'Purple';
  return 'Neutral';
}

function extractColors(html) {
  const freq = {};

  // Known noise: Google, Facebook, Twitter, and other
  // tracking/analytics script colors that bleed into extraction
  const NOISE = new Set([
    '#4285F4','#34A853','#FBBC05','#EA4335', // Google
    '#1877F2','#42B72A',                     // Facebook
    '#1DA1F2',                               // Twitter/X
    '#FF6201','#FF6200',                     // GTM/Firebase orange
    '#0070F3',                               // Vercel blue (if analyzing other sites)
    '#5865F2',                               // Discord
    '#FF0000',                               // YouTube red
    '#25D366',                               // WhatsApp
    '#0A66C2',                               // LinkedIn
  ]);

  const bump = (hex, weight = 1) => {
    if (!hex) return;
    if (hex === '#FFFFFF' || hex === '#000000') return;
    if (NOISE.has(hex)) return; // filter tracking script colors
    freq[hex] = (freq[hex] || 0) + weight;
  };

  // Priority 1: CSS custom properties (design tokens — sign of a real system)
  // e.g. --color-primary: #5E6AD2  or  --brand: rgb(94, 106, 210)
  const tokenRe = /--(?:color|brand|primary|secondary|accent|bg|background|surface|text|fg|foreground|fill)[^:]*\s*:\s*(#[0-9A-Fa-f]{6}|rgba?\([^)]+\))/gi;
  let m;
  while ((m = tokenRe.exec(html)) !== null) {
    const hex = rgbToHex(m[1]);
    if (hex) bump(hex, 4); // weight tokens 4× — they're intentional
  }

  // Priority 2: All hex colors by frequency
  const hexRe = /#([0-9A-Fa-f]{6})\b/g;
  while ((m = hexRe.exec(html)) !== null) {
    bump('#' + m[1].toUpperCase(), 1);
  }

  // Priority 3: rgb/rgba values
  const rgbRe = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/g;
  while ((m = rgbRe.exec(html)) !== null) {
    const hex = rgbToHex(`rgb(${m[1]},${m[2]},${m[3]})`);
    if (hex) bump(hex, 1);
  }

  // Deduplicate perceptually similar colors (avoids '3× near-black' problem)
  function hexToRgb(h) {
    return [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
  }
  function colorDist(a, b) {
    const [r1,g1,b1] = hexToRgb(a), [r2,g2,b2] = hexToRgb(b);
    return Math.sqrt((r1-r2)**2 + (g1-g2)**2 + (b1-b2)**2);
  }

  const sorted = Object.keys(freq).sort((a, b) => freq[b] - freq[a]);
  const deduped = [];
  for (const hex of sorted) {
    const tooClose = deduped.some(kept => colorDist(hex, kept) < 45);
    if (!tooClose) deduped.push(hex);
    if (deduped.length === 5) break;
  }

  const ROLES = ['Background','Primary','Accent','Surface','Muted'];
  return deduped.map((hex, i) => ({
    hex,
    name: colorName(hex),
    role: ROLES[i] || 'Color',
    rc:   '#f0f0f2',
    rt:   '#888'
  }));
}

// ── 4. STACK DETECTION ───────────────────────────────────────────

function detectStack(html) {
  const h = html.toLowerCase();
  const s = [];

  // Meta-frameworks (detect before raw React/Vue to avoid double entries)
  if (h.includes('__next') || h.includes('/_next/'))
    s.push({ ico:'▲',  name:'Next.js',    cat:'Meta Framework', det:true });
  else if (h.includes('__nuxt') || h.includes('/_nuxt/'))
    s.push({ ico:'💚', name:'Nuxt.js',    cat:'Meta Framework', det:true });
  else if (h.includes('sveltekit') || h.includes('/_app/'))
    s.push({ ico:'🧡', name:'SvelteKit',  cat:'Meta Framework', det:true });
  else if (h.includes('gatsby'))
    s.push({ ico:'💜', name:'Gatsby',     cat:'Meta Framework', det:true });

  // UI frameworks
  if (!s.length || !['Next.js','Nuxt.js'].includes(s[0]?.name)) {
    if (h.includes('react-dom') || h.includes('__reactfiber') || h.includes('data-reactroot'))
      s.push({ ico:'⚛️', name:'React',   cat:'UI Framework', det:true });
    if (h.includes('data-v-') || (h.includes('vue') && !h.includes('nuxt')))
      s.push({ ico:'💚', name:'Vue.js',   cat:'UI Framework', det:true });
    if (h.includes('ng-version') || h.includes('angular'))
      s.push({ ico:'🔴', name:'Angular',  cat:'UI Framework', det:true });
    if (h.includes('svelte') && !h.includes('sveltekit'))
      s.push({ ico:'🧡', name:'Svelte',   cat:'UI Framework', det:true });
  }

  // Styling
  if (h.includes('tailwind') || h.includes('tw-'))
    s.push({ ico:'🎨', name:'Tailwind CSS',      cat:'Styling',          det:true });
  if (h.includes('styled-component') || h.includes('"sc-'))
    s.push({ ico:'💅', name:'Styled Components', cat:'CSS-in-JS',        det:true });
  if (h.includes('emotion') || h.includes('css-'))
    s.push({ ico:'👩‍🎤', name:'Emotion',          cat:'CSS-in-JS',        det:true });

  // Component systems
  if (h.includes('radix-ui') || h.includes('@radix'))
    s.push({ ico:'🔲', name:'Radix UI',          cat:'Component System', det:true });
  if (h.includes('shadcn') || h.includes('cmdk'))
    s.push({ ico:'🪄', name:'shadcn/ui',          cat:'Component System', det:true });

  // Animation
  if (h.includes('framer-motion') || h.includes('data-framer-motion'))
    s.push({ ico:'✨', name:'Framer Motion',      cat:'Animation',        det:true });
  if (h.includes('gsap') || h.includes('greensock'))
    s.push({ ico:'🎞️', name:'GSAP',              cat:'Animation',        det:true });

  // Platforms
  if (h.includes('wordpress') || h.includes('wp-content'))
    s.push({ ico:'📝', name:'WordPress',          cat:'CMS',              det:true });
  if (h.includes('myshopify.com') || h.includes('cdn.shopify.com') || h.includes('shopify-section') || h.includes('shopify.theme'))
    s.push({ ico:'🛍️', name:'Shopify',           cat:'E-commerce',       det:true });
  if (h.includes('webflow'))
    s.push({ ico:'🌊', name:'Webflow',            cat:'No-code',          det:true });
  if (h.includes('framer.com') || h.includes('__framer'))
    s.push({ ico:'🖼️', name:'Framer',            cat:'No-code',          det:true });

  if (s.length === 0)
    s.push({ ico:'🌐', name:'Custom Stack',       cat:'HTML/CSS/JS',      det:false });

  return s.slice(0, 5);
}

// ── 5. SPACING ───────────────────────────────────────────────────

function extractSpacing(html) {
  // Look for a consistent spacing scale in CSS (padding, margin, gap)
  const raw = new Set();
  const re  = /(?:padding|margin|gap)\s*:\s*(\d+)px/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const v = parseInt(m[1]);
    if (v > 0 && v <= 128) raw.add(v);
  }
  const sorted = [...raw].sort((a, b) => a - b);
  // Return at most 6 values; pad with 8pt-grid defaults if needed
  const defaults = [4, 8, 16, 24, 40, 64];
  return sorted.length >= 4 ? sorted.slice(0, 6) : defaults;
}

// ── 6. DESIGN SCORE ──────────────────────────────────────────────

function scoreDesign({ fonts, colors, stack, hasTokens, rendered }) {
  let score = 58;
  if (fonts.length >= 2)                                       score += 7;
  if (fonts.some(f => f.role === 'mono'))                      score += 4;
  if (colors.length >= 4)                                      score += 8;
  if (hasTokens)                                               score += 10; // intentional design system
  if (stack.some(s => /Tailwind|Radix|shadcn/.test(s.name)))  score += 5;
  if (stack.some(s => /Motion|GSAP/.test(s.name)))             score += 5;
  if (rendered)                                                score += 3;  // we got real computed output
  return Math.min(score, 99);
}

// ── 7. PERSONALITY (derived from signals) ────────────────────────

function derivePersonality({ fonts, colors, stack, hasTokens }) {
  const hasMotion  = stack.some(s => /Motion|GSAP/.test(s.name));
  const hasMinimal = colors.length <= 3;
  const isModern   = hasTokens || stack.some(s => /Radix|shadcn|Tailwind/.test(s.name));
  const isPlayful  = fonts.some(f => /syne|display|rounded/i.test(f.name)) || hasMotion;

  return [
    { l:'Minimal',  r:'Maximal', v: hasMinimal ? 20 : colors.length >= 5 ? 65 : 40 },
    { l:'Playful',  r:'Serious', v: isPlayful   ? 35 : 68 },
    { l:'Warm',     r:'Cool',    v: 62 },
    { l:'Classic',  r:'Modern',  v: isModern    ? 82 : 50 },
  ];
}

// ── 8. MAIN HANDLER ──────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')   { res.status(405).json({ error: 'POST only' }); return; }

  let url = req.body?.url;
  if (!url) { res.status(400).json({ error: 'URL required' }); return; }
  if (!url.startsWith('http')) url = 'https://' + url;

  let html        = '';
  let rendered    = false;

  try {
    // ── Strategy: Browserless FIRST (gets real CSS tokens, @font-face,
    //    computed styles). Fall back to plain fetch if unavailable/fails.
    if (process.env.BROWSERLESS_TOKEN) {
      try {
        html     = await fetchRendered(url);
        rendered = true;
      } catch (bErr) {
        console.warn('Browserless failed, falling back to raw fetch:', bErr.message);
        html = await fetchRaw(url);
      }
    } else {
      html = await fetchRaw(url);
    }

    // ── Extract everything
    const domain    = (() => { try { return new URL(url).hostname.replace('www.', ''); } catch(e) { return url; } })();
    const titleM    = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title     = titleM ? titleM[1].trim() : domain;
    const hasTokens = /--(color|brand|primary|secondary|accent|bg|surface|fg)\b/.test(html);

    // Augment html with first linked stylesheet (catches self-hosted @font-face)
    if (!extractFonts(html).length || extractFonts(html)[0].name === 'System UI') {
      try {
        const extraCss = await fetchFirstStylesheet(html, url);
        if (extraCss) html = html + extraCss;
      } catch(e) {}
    }

    const fonts  = extractFonts(html);
    const colors = extractColors(html);
    const stack  = detectStack(html);
    const spVals = extractSpacing(html);

    const tech = (() => {
      const found = stack.find(s => ['Next.js','Nuxt.js','SvelteKit','Gatsby'].includes(s.name))
                 || stack.find(s => ['React','Vue.js','Svelte','Angular'].includes(s.name));
      return found ? found.name : stack[0]?.name || 'Custom';
    })();

    const score       = scoreDesign({ fonts, colors, stack, hasTokens, rendered });
    const personality = derivePersonality({ fonts, colors, stack, hasTokens });
    const LABELS      = ['xs','sm','md','lg','xl','2xl'];
    const spacing     = spVals.slice(0,6).map((v, i) => ({ n: LABELS[i], v }));

    // Motion heuristics
    const hasMotion  = stack.some(s => /Motion|GSAP/.test(s.name));
    const motionStyle = stack.some(s => /Motion/.test(s.name)) ? 'Spring physics'
                      : stack.some(s => /GSAP/.test(s.name))   ? 'Timeline-based'
                      : 'CSS ease-in-out';

    res.status(200).json({
      meta: { url: domain, title },
      fonts:  fonts.length  ? fonts  : [{ pre:'Aa', name:'System UI', weights:'400,500', role:'body',  tags:['System'] }],
      colors: colors.length ? colors : [{ hex:'#333333', name:'Dark', role:'Primary', rc:'#f0f0f2', rt:'#888' }],
      stack,
      score,
      tech,
      rendered,     // lets the UI show "JS-rendered" badge if you want
      personality,
      motion: [
        { n:'Style',          v: motionStyle },
        { n:'Duration',       v: hasMotion ? '300–600ms' : '150–250ms' },
        { n:'Easing',         v: hasMotion ? 'Spring / cubic-bezier' : 'ease-in-out' },
      ],
      fingerprint: [
        { k:'Framework', v: tech,             s: 'Detected from markup' },
        { k:'Grid',      v: '8pt',            s: '8px baseline grid' },
        { k:'Base Font', v: '16px',           s: 'Standard rem base' },
        { k:'Tokens',    v: hasTokens ? '✓' : '—', s: hasTokens ? 'CSS custom props found' : 'No token system detected' },
      ],
      spacing,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
