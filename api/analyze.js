const https = require('https');
const http = require('http');

function fetchUrl(url, hops) {
  hops = hops || 0;
  return new Promise(function(resolve, reject) {
    if (hops > 5) return reject(new Error('Too many redirects'));
    var lib = url.startsWith('https') ? https : http;
    var req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Glassdeck/1.0)' },
      timeout: 12000
    }, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        var next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
        return fetchUrl(next, hops + 1).then(resolve).catch(reject);
      }
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() { resolve(data); });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function extractFonts(html) {
  var seen = {}; var fonts = [];
  var m; var gfRe = /fonts\.googleapis\.com\/css2?\?family=([^"' >]+)/g;
  while ((m = gfRe.exec(html)) !== null) {
    try { decodeURIComponent(m[1]).split('|').forEach(function(f) {
      var name = f.split(':')[0].replace(/\+/g,' ').trim();
      if (name && !seen[name]) { seen[name]=1; fonts.push({name:name,src:'Google Fonts'}); }
    }); } catch(e) {}
  }
  var cssRe = /font-family\s*:\s*['"]?([A-Za-z][^'";,\n{}]{1,40})['"]?\s*[;,{}]/g;
  while ((m = cssRe.exec(html)) !== null) {
    var name = m[1].trim().replace(/['"]/g,'');
    var skip = ['inherit','sans-serif','serif','monospace','system-ui','ui-sans-serif','ui-serif'];
    if (name && !seen[name] && skip.indexOf(name)===-1) { seen[name]=1; fonts.push({name:name,src:'CSS'}); }
  }
  return fonts.slice(0,4).map(function(f) {
    return { pre:/mono|code/i.test(f.name)?'01':'Aa', name:f.name, weights:'400,500,700', role:/mono|code/i.test(f.name)?'mono':'body', tags:[f.src] };
  });
}

function extractColors(html) {
  var freq={}; var m; var re=/#([0-9A-Fa-f]{6})\b/g;
  while ((m=re.exec(html))!==null) { var h='#'+m[1].toUpperCase(); freq[h]=(freq[h]||0)+1; }
  function cname(h) { var r=parseInt(h.slice(1,3),16),g=parseInt(h.slice(3,5),16),b=parseInt(h.slice(5,7),16); if(r>200&&g>200&&b>200)return'White'; if(r<60&&g<60&&b<60)return'Black'; if(b>r&&b>g)return'Blue'; if(r>g&&r>b)return'Red'; if(g>r&&g>b)return'Green'; return'Custom'; }
  var roles=['Background','Primary','Accent','Surface','Muted'];
  return Object.keys(freq).filter(function(h){return h!=='#FFFFFF'&&h!=='#000000';}).sort(function(a,b){return freq[b]-freq[a];}).slice(0,5).map(function(hex,i){ return {hex:hex,name:cname(hex),role:roles[i]||'Color',rc:'#f0f0f2',rt:'#888'}; });
}

function detectStack(html) {
  var h=html.toLowerCase(); var s=[];
  if(h.indexOf('__next')>-1||h.indexOf('/_next/')>-1) s.push({ico:'▲',name:'Next.js',cat:'Meta Framework',det:true});
  else if(h.indexOf('react')>-1) s.push({ico:'⚛️',name:'React',cat:'UI Framework',det:true});
  if(h.indexOf('vue')>-1) s.push({ico:'💚',name:'Vue.js',cat:'UI Framework',det:true});
  if(h.indexOf('tailwind')>-1) s.push({ico:'🎨',name:'Tailwind CSS',cat:'Styling',det:true});
  if(h.indexOf('framer-motion')>-1) s.push({ico:'✨',name:'Framer Motion',cat:'Animation',det:true});
  if(h.indexOf('gsap')>-1) s.push({ico:'🎞️',name:'GSAP',cat:'Animation',det:true});
  if(h.indexOf('wordpress')>-1||h.indexOf('wp-content')>-1) s.push({ico:'📝',name:'WordPress',cat:'CMS',det:true});
  if(h.indexOf('shopify')>-1) s.push({ico:'🛍️',name:'Shopify',cat:'E-commerce',det:true});
  if(h.indexOf('webflow')>-1) s.push({ico:'🌊',name:'Webflow',cat:'No-code',det:true});
  if(s.length===0) s.push({ico:'🌐',name:'Custom Stack',cat:'HTML/CSS/JS',det:false});
  return s.slice(0,5);
}

module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  // Vercel parses body automatically
  var url = req.body && req.body.url;
  if (!url) { res.status(400).json({ error: 'URL required' }); return; }
  if (!url.startsWith('http')) url = 'https://' + url;

  try {
    var html = await fetchUrl(url);
    var domain = '';
    try { domain = new URL(url).hostname.replace('www.',''); } catch(e) { domain = url; }
    var fonts = extractFonts(html);
    var colors = extractColors(html);
    var stack = detectStack(html);
    var names = stack.map(function(s){return s.name;});
    var tech = names.indexOf('Next.js')>-1?'React + Next.js':names.indexOf('React')>-1?'React':names.indexOf('Vue.js')>-1?'Vue.js':'Custom';
    var score = Math.min(70+(fonts.length>=2?5:0)+(colors.length>=4?5:0)+(stack.some(function(s){return s.det;})?10:0),99);
    res.status(200).json({
      meta:{url:domain,title:(html.match(/<title[^>]*>([^<]+)<\/title>/i)||[])[1]||domain},
      fonts:fonts.length?fonts:[{pre:'Aa',name:'System UI',weights:'400,500',role:'body',tags:['System']}],
      colors:colors.length?colors:[{hex:'#333333',name:'Dark',role:'Primary',rc:'#f0f0f2',rt:'#888'}],
      stack:stack,score:score,tech:tech,
      personality:[{l:'Minimal',r:'Maximal',v:35},{l:'Playful',r:'Serious',v:65},{l:'Warm',r:'Cool',v:70},{l:'Classic',r:'Modern',v:80}],
      motion:[{n:'Duration',v:'200ms'},{n:'Style',v:'ease-in-out'}],
      fingerprint:[{k:'Framework',v:tech,s:'Detected'},{k:'Grid',v:'8pt',s:'8px baseline'},{k:'Base Font',v:'16px',s:'Standard'},{k:'Radius',v:'4px',s:'Sharp'}],
      spacing:[{n:'xs',v:4},{n:'sm',v:8},{n:'md',v:16},{n:'lg',v:24},{n:'xl',v:40},{n:'2xl',v:64}]
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
};
