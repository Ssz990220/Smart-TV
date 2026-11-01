/* Standalone subtitle storage/providers. No Emby requests or media-server credentials. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const os = require('os');
const {URL} = require('url');

const MAX_FILE = 16 * 1024 * 1024;
const MAX_CACHE = 96 * 1024 * 1024;
const SESSION_MS = 30 * 60 * 1000;
const DEVICE_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE = 'MoonfinSubtitleDevice';
const EXTENSIONS = /\.(srt|ass|ssa|vtt|zip|rar|7z)$/i;
const HOSTS = ['assrt.net', 'makedie.me', 'opensubtitles.com'];
const fail = (code, status) => Object.assign(new Error(code), {code, status});
const safeName = (name) => String(name || 'subtitle.srt').replace(/[/\\\x00-\x1f\x7f]/g, '_').slice(0, 180);
const id = () => crypto.randomBytes(18).toString('hex');
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function checkedUrl(value) {
  let u;
  try { u = new URL(value); } catch (_) { throw fail('INVALID_DOWNLOAD_URL'); }
  if (u.protocol === 'http:' && HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) u.protocol = 'https:';
  if (u.protocol !== 'https:' || u.username || u.password || !HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) {
    throw fail('UNSUPPORTED_DOWNLOAD_HOST');
  }
  return u;
}

function fetchBytes(value, opts, ca, redirects) {
  const u = checkedUrl(value);
  opts = opts || {};
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    const request = https.request(u, {
      method: opts.method || 'GET',
      headers: Object.assign({'User-Agent': 'Moonfin-LocalSubtitles v3.0.5', 'Accept-Encoding': 'identity'}, opts.headers),
      ...(ca && ca.length ? {ca} : {}),
      rejectUnauthorized: true
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirects >= 3) return reject(fail('TOO_MANY_REDIRECTS'));
        let next;
        try { next = checkedUrl(new URL(response.headers.location, u).href); } catch (e) { return reject(e); }
        const headers = Object.assign({}, opts.headers);
        if (next.origin !== u.origin) {
          Object.keys(headers).forEach(k => { if (/authorization|api-key/i.test(k)) delete headers[k]; });
        }
        return fetchBytes(next.href, {...opts, headers}, ca, redirects + 1).then(resolve, reject);
      }
      let size = 0;
      const chunks = [];
      response.on('data', b => {
        size += b.length;
        if (size > (opts.maxBytes || MAX_FILE)) { response.destroy(); request.destroy(); reject(fail('FILE_TOO_LARGE')); }
        else chunks.push(b);
      });
      response.on('end', () => resolve({status: response.statusCode, headers: response.headers, buffer: Buffer.concat(chunks)}));
      response.on('error', () => reject(fail('NETWORK_ERROR')));
    });
    request.setTimeout(20000, () => { request.destroy(); reject(fail('NETWORK_TIMEOUT')); });
    request.on('error', () => reject(fail('NETWORK_ERROR')));
    if (opts.body) request.write(opts.body);
    request.end();
  });
}

function createManager(options) {
  options = options || {};
  const dataDir = options.dataDir || '/media/internal/.moonfin-local-subtitles';
  const assetsDir = options.assetsDir || path.join(__dirname, 'subtitle-portal');
  const request = options.request || ((url, opts) => fetchBytes(url, opts, options.ca));
  let cfg = {};
  let files = [];
  let devices = [];
  let preferences = {};
  let server = null;
  let session = null;
  let timer = null;
  let lastPort = 0;
  const results = new Map();
  const candidateFiles = new Map();
  const usbFiles = new Map();
  const pendingDevices = new Map();
  const privateWrite = (name, value) => {
    const tmp = path.join(dataDir, name + '.new');
    fs.writeFileSync(tmp, JSON.stringify(value), {mode: 0o600});
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, path.join(dataDir, name));
  };
  const init = () => {
    fs.mkdirSync(dataDir, {recursive: true, mode: 0o700});
    fs.chmodSync(dataDir, 0o700);
    try { cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')); } catch (_) { cfg = {}; }
    try { files = JSON.parse(fs.readFileSync(path.join(dataDir, 'files.json'), 'utf8')); } catch (_) { files = []; }
    try { devices = JSON.parse(fs.readFileSync(path.join(dataDir, 'devices.json'), 'utf8')); } catch (_) { devices = []; }
    try { preferences = JSON.parse(fs.readFileSync(path.join(dataDir, 'preferences.json'), 'utf8')); } catch (_) { preferences = {}; }
    if (!preferences || Array.isArray(preferences) || typeof preferences !== 'object') preferences = {};
    if (!Array.isArray(files)) files = [];
    if (!Array.isArray(devices)) devices = [];
    devices = devices.filter(d => /^[a-f0-9]{64}$/.test(d.hash) && d.expires > Date.now());
    files = files.filter(f => /^[a-f0-9]{36}$/.test(f.id) && fs.existsSync(path.join(dataDir, f.id)));
  };
  const flags = () => ({assrt: !!cfg.assrtToken, opensubtitles: !!cfg.openApiKey, openLoggedIn: !!cfg.openToken});
  const publicFile = f => ({id: f.id, name: f.name, bytes: f.bytes, source: f.source, created: f.created});
  const itemHash = key => digest(key || 'unassigned');
  const list = key => files.filter(f => f.item === itemHash(key)).map(publicFile);
  const trackKey = (fileId, entry) => digest(JSON.stringify([fileId, entry]));
  const preference = key => {
    const pref = preferences[itemHash(key)] || {};
    const available = list(key);
    const selectedFile = pref.selected && available.find(f => f.id === pref.selected.fileId);
    const fallback = [...available].reverse().find(f => f.source === 'import' || f.source === 'usb') || available[available.length - 1];
    const selection = selectedFile ? pref.selected : fallback ? {fileId: fallback.id, encoding: 'auto'} : null;
    const track = selection && pref.tracks && pref.tracks[trackKey(selection.fileId, selection.entry || '')];
    return {enabled: pref.enabled !== false, selection: selection ? {...selection, offsetSeconds: track ? track.offsetSeconds : 0} : null};
  };
  const updatePreference = (key, input) => {
    // Private Luna calls also work after the HTTP session closes, so the last
    // offset queued while leaving playback is still persisted.
    init();
    const hash = itemHash(key);
    const pref = preferences[hash] || {tracks: {}};
    const tracks = pref.tracks || {};
    let track = null;
    if (input.fileId) {
      const file = files.find(f => f.id === input.fileId && f.item === hash);
      if (!file) throw fail('FILE_NOT_FOUND', 404);
      const entry = String(input.entry || file.name).slice(0, 1024);
      const encoding = input.encoding || 'auto';
      if (!['auto', 'utf-8', 'gb18030', 'big5', 'utf-16le', 'utf-16be'].includes(encoding)) throw fail('INVALID_ENCODING', 400);
      const index = trackKey(file.id, entry);
      track = tracks[index] || {fileId: file.id, entry, encoding, offsetSeconds: 0};
      if (input.action === 'save') {
        if (input.offsetSeconds !== undefined && (!Number.isFinite(input.offsetSeconds) || Math.abs(input.offsetSeconds) > 86400)) throw fail('INVALID_OFFSET', 400);
        track = {...track, encoding, ...(input.offsetSeconds !== undefined ? {offsetSeconds: input.offsetSeconds} : {})};
        tracks[index] = track;
        if (input.select === true) { pref.selected = {fileId: file.id, entry, encoding}; pref.enabled = true; }
      }
    }
    if (input.action === 'save') {
      if (typeof input.enabled === 'boolean') pref.enabled = input.enabled;
      pref.tracks = tracks;
      preferences[hash] = pref;
      privateWrite('preferences.json', preferences);
    }
    return {preference: preference(key), track};
  };
  const prunePreferences = () => {
    const valid = new Set(files.map(f => f.id));
    const items = new Set(files.map(f => f.item));
    for (const [key, pref] of Object.entries(preferences)) {
      if (!items.has(key)) { delete preferences[key]; continue; }
      if (pref.selected && !valid.has(pref.selected.fileId)) delete pref.selected;
      for (const [track, value] of Object.entries(pref.tracks || {})) if (!valid.has(value.fileId)) delete pref.tracks[track];
    }
    privateWrite('preferences.json', preferences);
  };
  const requireSession = () => {
    if (!session || session.expires < Date.now()) throw fail('SESSION_EXPIRED', 401);
    return session;
  };
  const pending = () => {
    for (const [key, p] of pendingDevices) if (p.expires <= Date.now()) pendingDevices.delete(key);
    return [...pendingDevices.values()].map(p => ({id: p.id, name: p.name, expires: p.expires}));
  };
  const approveDevice = input => {
    pending();
    if (input.forgetAll) { devices = []; pendingDevices.clear(); privateWrite('devices.json', devices); return; }
    const entry = [...pendingDevices.entries()].find(([, p]) => p.id === input.id);
    if (!entry) throw fail('PAIRING_EXPIRED', 400);
    pendingDevices.delete(entry[0]);
    if (input.allow === true) {
      devices = [...devices.filter(d => d.hash !== entry[0] && d.expires > Date.now()), {hash: entry[0], name: entry[1].name, expires: Date.now() + DEVICE_MS}].slice(-16);
      privateWrite('devices.json', devices);
    }
  };
  const store = (name, buffer, itemKey, source) => {
    name = safeName(name);
    if (!EXTENSIONS.test(name)) throw fail('UNSUPPORTED_FILE_TYPE', 400);
    if (!buffer.length || buffer.length > MAX_FILE) throw fail('FILE_TOO_LARGE', 413);
    const file = {id: id(), name, bytes: buffer.length, item: itemHash(itemKey), source: source || 'import', created: Date.now()};
    fs.writeFileSync(path.join(dataDir, file.id), buffer, {mode: 0o600});
    files.push(file);
    let total = files.reduce((n, f) => n + f.bytes, 0);
    while (total > MAX_CACHE || files.length > 120) {
      const old = files.shift(); total -= old.bytes;
      try { fs.unlinkSync(path.join(dataDir, old.id)); } catch (_) {}
    }
    privateWrite('files.json', files);
    prunePreferences();
    return publicFile(file);
  };
  const read = fileId => {
    const file = files.find(f => f.id === fileId);
    if (!file) throw fail('FILE_NOT_FOUND', 404);
    return {file, buffer: fs.readFileSync(path.join(dataDir, file.id))};
  };
  const remove = fileId => {
    const file = files.find(f => f.id === fileId);
    if (file) { try { fs.unlinkSync(path.join(dataDir, file.id)); } catch (_) {} }
    files = files.filter(f => f.id !== fileId); privateWrite('files.json', files); prunePreferences();
  };
  const jsonRequest = async (url, opts) => {
    const r = await request(url, Object.assign({maxBytes: 2 * 1024 * 1024}, opts));
    if (r.status < 200 || r.status >= 300) throw fail(r.status === 429 || r.status === 406 ? 'QUOTA_OR_RATE_LIMIT' : r.status === 401 || r.status === 403 ? 'PROVIDER_AUTH_FAILED' : 'PROVIDER_REQUEST_FAILED', r.status);
    try { return JSON.parse(r.buffer.toString('utf8')); } catch (_) { throw fail('INVALID_PROVIDER_RESPONSE'); }
  };
  const openBase = () => cfg.openBase === 'https://vip-api.opensubtitles.com/api/v1' ? cfg.openBase : 'https://api.opensubtitles.com/api/v1';
  const openHeaders = () => ({'Api-Key': cfg.openApiKey, Accept: 'application/json', ...(cfg.openToken ? {Authorization: 'Bearer ' + cfg.openToken} : {})});
  const configure = async input => {
    const next = Object.assign({}, cfg);
    for (const key of ['assrtToken', 'openApiKey']) {
      if (input[key] === null) delete next[key];
      else if (typeof input[key] === 'string' && input[key].trim()) next[key] = input[key].trim().slice(0, 512);
    }
    if (next.openApiKey !== cfg.openApiKey) { delete next.openToken; delete next.openBase; }
    if (input.logout) { delete next.openToken; delete next.openBase; }
    if (input.username || input.password) {
      if (!next.openApiKey || !input.username || !input.password) throw fail('OPEN_LOGIN_FIELDS_REQUIRED', 400);
      const data = await jsonRequest('https://api.opensubtitles.com/api/v1/login', {
        method: 'POST', headers: {'Api-Key': next.openApiKey, 'Content-Type': 'application/json'},
        body: JSON.stringify({username: String(input.username), password: String(input.password)})
      });
      if (!data.token) throw fail('PROVIDER_AUTH_FAILED', 401);
      next.openToken = data.token;
      // The API may return only the hostname. Never accept an arbitrary login-supplied origin.
      next.openBase = /^(https:\/\/)?vip-api\.opensubtitles\.com(\/api\/v1)?\/?$/.test(data.base_url || '') ? 'https://vip-api.opensubtitles.com/api/v1' : 'https://api.opensubtitles.com/api/v1';
    }
    cfg = next;
    privateWrite('settings.json', cfg);
    return flags();
  };
  const search = async input => {
    const provider = input.provider;
    const query = String(input.query || '').trim().slice(0, 200);
    if (query.length < 2 && !input.imdbId) throw fail('QUERY_REQUIRED', 400);
    // Bound result maps and avoid retaining provider URLs across unrelated searches.
    results.clear(); candidateFiles.clear();
    let found = [];
    if (provider === 'assrt') {
      if (!cfg.assrtToken) throw fail('ASSRT_KEY_REQUIRED', 400);
      const u = new URL('https://api.assrt.net/v1/sub/search');
      u.searchParams.set('q', query); u.searchParams.set('cnt', '15');
      const data = await jsonRequest(u.href, {headers: {Authorization: 'Bearer ' + cfg.assrtToken}});
      if (data.status !== 0) throw fail(data.status === 101 ? 'PROVIDER_AUTH_FAILED' : 'PROVIDER_REQUEST_FAILED');
      found = (data.sub && data.sub.subs || []).slice(0, 25).map(r => ({
        provider, remoteId: r.id, name: r.native_name || r.videoname || 'Subtitle',
        info: [r.lang && r.lang.desc, r.subtype, r.videoname].filter(Boolean).join(' · ')
      }));
    } else if (provider === 'opensubtitles') {
      if (!cfg.openApiKey) throw fail('OPEN_KEY_REQUIRED', 400);
      const u = new URL(openBase() + '/subtitles');
      const imdb = String(input.imdbId || '').replace(/^tt/, '');
      if (/^\d+$/.test(imdb)) u.searchParams.set('imdb_id', imdb); else u.searchParams.set('query', query);
      const language = String(input.language || 'zh-cn,zh-tw,en');
      if (!/^[a-z,-]{2,30}$/i.test(language)) throw fail('INVALID_LANGUAGE', 400);
      u.searchParams.set('languages', language);
      if (Number.isInteger(input.season) && input.season >= 0) u.searchParams.set('season_number', input.season);
      if (Number.isInteger(input.episode) && input.episode >= 0) u.searchParams.set('episode_number', input.episode);
      const data = await jsonRequest(u.href, {headers: openHeaders()});
      found = (data.data || []).slice(0, 30).flatMap(r => {
        const a = r.attributes || {};
        return (a.files || []).slice(0, 10).map(f => ({provider, fileId: f.file_id,
          name: f.file_name || a.release || 'Subtitle',
          info: [a.language, a.release, a.hearing_impaired ? 'SDH' : '', a.foreign_parts_only ? 'Forced' : ''].filter(Boolean).join(' · ')
        }));
      }).slice(0, 50);
    } else throw fail('UNKNOWN_PROVIDER', 400);
    return found.map(r => { const key = id(); results.set(key, {...r, created: Date.now()}); return {id: key, name: String(r.name).slice(0, 240), info: String(r.info || '').slice(0, 350), provider}; });
  };
  const resolve = async resultId => {
    const r = results.get(resultId);
    if (!r || Date.now() - r.created > SESSION_MS) throw fail('SEARCH_RESULT_EXPIRED', 400);
    if (r.provider === 'opensubtitles') {
      // A user explicitly chooses a result before this quota-consuming call.
      const d = await jsonRequest(openBase() + '/download', {
        method: 'POST', headers: {...openHeaders(), 'Content-Type': 'application/json'}, body: JSON.stringify({file_id: r.fileId, sub_format: 'srt'})
      });
      if (!d.link) throw fail('DOWNLOAD_UNAVAILABLE');
      const downloadName = d.file_name || (/\.srt$/i.test(r.name) ? r.name : r.name.replace(/\.[^.]+$/, '') + '.srt');
      checkedUrl(d.link);
      const key = id(); candidateFiles.set(key, {url: d.link, name: downloadName, provider: r.provider});
      return [{id: key, name: safeName(downloadName)}];
    }
    const u = new URL('https://api.assrt.net/v1/sub/detail'); u.searchParams.set('id', r.remoteId);
    const d = await jsonRequest(u.href, {headers: {Authorization: 'Bearer ' + cfg.assrtToken}});
    const detail = d.sub && d.sub.subs && d.sub.subs[0];
    if (d.status !== 0 || !detail) throw fail('DOWNLOAD_UNAVAILABLE');
    const choices = detail.filelist && detail.filelist.length ? detail.filelist.map(f => ({url: f.url, name: f.f})) : [{url: detail.url, name: detail.filename}];
    return choices.filter(f => f.url && EXTENSIONS.test(f.name || '')).slice(0, 100).map(f => {
      checkedUrl(f.url); const key = id(); candidateFiles.set(key, {...f, provider: r.provider});
      return {id: key, name: safeName(f.name)};
    });
  };
  const download = async (fileId, itemKey) => {
    const f = candidateFiles.get(fileId);
    if (!f) throw fail('SEARCH_RESULT_EXPIRED', 400);
    const r = await request(checkedUrl(f.url).href, {maxBytes: MAX_FILE});
    if (r.status !== 200) throw fail('DOWNLOAD_UNAVAILABLE', r.status);
    return store(f.name, r.buffer, itemKey, f.provider);
  };
  const scanUsb = () => {
    usbFiles.clear();
    const roots = ['/tmp/usb', '/media/removable'];
    const found = [];
    const queue = roots.filter(r => fs.existsSync(r)).map(r => ({root: fs.realpathSync(r), dir: fs.realpathSync(r), depth: 0}));
    let seen = 0;
    while (queue.length && seen++ < 1500 && found.length < 200) {
      const current = queue.shift();
      let names; try { names = fs.readdirSync(current.dir); } catch (_) { continue; }
      for (const name of names.slice(0, 1000)) {
        if (name.startsWith('.')) continue;
        const full = path.join(current.dir, name);
        let stat; try { stat = fs.lstatSync(full); } catch (_) { continue; }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory() && current.depth < 5) queue.push({...current, dir: full, depth: current.depth + 1});
        else if (stat.isFile() && EXTENSIONS.test(name) && stat.size <= MAX_FILE) {
          const key = id(); usbFiles.set(key, {path: full, root: current.root});
          found.push({id: key, name: path.relative(current.root, full), bytes: stat.size});
        }
        if (found.length >= 200) break;
      }
    }
    return found;
  };
  const importUsb = (key, itemKey) => {
    const file = usbFiles.get(key);
    if (!file) throw fail('FILE_NOT_FOUND', 404);
    const real = fs.realpathSync(file.path);
    if (!real.startsWith(file.root + path.sep) || fs.lstatSync(file.path).isSymbolicLink() || fs.statSync(real).size > MAX_FILE) throw fail('FILE_NOT_FOUND', 404);
    return store(path.basename(real), fs.readFileSync(real), itemKey, 'usb');
  };
  const address = () => {
    const addresses = [];
    const networks = os.networkInterfaces();
    Object.keys(networks).forEach(k => networks[k].forEach(a => {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) addresses.push(a.address);
    }));
    return addresses;
  };
  const status = (privateState = true) => {
    const s = requireSession();
    return {configured: flags(), title: s.title, item: itemHash(s.itemKey), files: list(s.itemKey), preference: preference(s.itemKey), expires: s.expires,
      ...(privateState ? {pairingRequests: pending(), pairedDevices: devices.filter(d => d.expires > Date.now()).length} : {})};
  };
  const body = (req, max) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', b => { size += b.length; if (size > max) { reject(fail('FILE_TOO_LARGE', 413)); req.destroy(); } else chunks.push(b); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => reject(fail('UPLOAD_FAILED', 400)));
  });
  const respond = (res, code, data, type) => {
    res.writeHead(code, {'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'});
    res.end(type ? data : JSON.stringify(data));
  };
  const handle = async (req, res) => {
    try {
      const route = new URL(req.url, 'http://localhost').pathname;
      const origin = req.headers.origin;
      const own = 'http://' + req.headers.host;
      const host = new URL(own).hostname;
      if (!['127.0.0.1', 'localhost', '[::1]', ...address()].includes(host)) throw fail('HOST_REJECTED', 403);
      if (origin && origin !== 'null' && origin !== own) throw fail('ORIGIN_REJECTED', 403);
      if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Subtitle-Name, X-Moonfin-Item');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') return respond(res, 204, '');
      if (route === '/' && req.method === 'GET') return respond(res, 200, fs.readFileSync(path.join(assetsDir, 'index.html')), 'text/html; charset=utf-8');
      if (route === '/portal.js' && req.method === 'GET') return respond(res, 200, fs.readFileSync(path.join(assetsDir, 'portal.js')), 'text/javascript; charset=utf-8');
      const s = requireSession();
      const cookieValue = String(req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith(COOKIE + '='));
      let deviceSecret = cookieValue ? cookieValue.slice(COOKIE.length + 1) : '';
      if (!/^[a-f0-9]{72}$/.test(deviceSecret)) deviceSecret = '';
      const deviceHash = deviceSecret ? digest(deviceSecret) : '';
      const approved = devices.some(d => d.hash === deviceHash && d.expires > Date.now());
      if (route === '/api/pair' && (req.method === 'GET' || req.method === 'POST')) {
        pending();
        if (approved) return respond(res, 200, {state: 'approved'});
        if (req.method === 'GET') return respond(res, 200, {state: pendingDevices.has(deviceHash) ? 'pending' : 'unpaired'});
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw fail('INVALID_REQUEST', 400);
        const input = JSON.parse((await body(req, 1024)).toString('utf8'));
        if (pendingDevices.has(deviceHash)) return respond(res, 200, {state: 'pending'});
        if (pendingDevices.size >= 8) throw fail('PAIRING_BUSY', 429);
        deviceSecret = id() + id();
        pendingDevices.set(digest(deviceSecret), {id: id(), name: safeName(input.name || 'Browser').slice(0, 60), expires: Date.now() + 120000});
        res.setHeader('Set-Cookie', COOKIE + '=' + deviceSecret + '; Path=/; Max-Age=' + DEVICE_MS / 1000 + '; HttpOnly; SameSite=Strict');
        return respond(res, 200, {state: 'pending'});
      }
      const supplied = String(req.headers.authorization || '').replace(/^Bearer /, '');
      const a = Buffer.from(supplied), b = Buffer.from(s.token);
      const tv = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (!tv && !approved) throw fail('PAIRING_REQUIRED', 401);
      if (!tv && ['POST', 'PUT', 'DELETE'].includes(req.method) && route !== '/api/settings' && req.headers['x-moonfin-item'] !== itemHash(s.itemKey)) throw fail('VIDEO_CHANGED', 409);
      if (route === '/api/state' && req.method === 'GET') return respond(res, 200, status(tv));
      if (route === '/api/usb' && req.method === 'GET') return respond(res, 200, scanUsb());
      if (route === '/api/usb/import' && req.method === 'POST') {
        const p = JSON.parse((await body(req, 2048)).toString('utf8')); return respond(res, 200, importUsb(p.id, s.itemKey));
      }
      if (route === '/api/settings' && req.method === 'POST') return respond(res, 200, await configure(JSON.parse((await body(req, 8192)).toString('utf8'))));
      if (route === '/api/search' && req.method === 'POST') return respond(res, 200, await search(JSON.parse((await body(req, 8192)).toString('utf8'))));
      if (route === '/api/resolve' && req.method === 'POST') {
        const p = JSON.parse((await body(req, 2048)).toString('utf8')); return respond(res, 200, await resolve(p.id));
      }
      if (route === '/api/download' && req.method === 'POST') {
        const p = JSON.parse((await body(req, 2048)).toString('utf8')); return respond(res, 200, await download(p.id, s.itemKey));
      }
      if (route === '/api/upload' && req.method === 'PUT') {
        let name; try { name = decodeURIComponent(req.headers['x-subtitle-name'] || 'subtitle.srt'); } catch (_) { throw fail('INVALID_FILE_NAME', 400); }
        return respond(res, 200, store(name, await body(req, MAX_FILE), s.itemKey, 'import'));
      }
      const match = /^\/api\/files\/([a-f0-9]{36})$/.exec(route);
      if (match && req.method === 'GET') {
        const r = read(match[1]);
        if (r.file.item !== itemHash(s.itemKey)) throw fail('FILE_NOT_FOUND', 404);
        return respond(res, 200, r.buffer, 'application/octet-stream');
      }
      if (match && req.method === 'DELETE') {
        const r = read(match[1]); if (r.file.item !== itemHash(s.itemKey)) throw fail('FILE_NOT_FOUND', 404);
        remove(match[1]); return respond(res, 200, {removed: true});
      }
      throw fail('NOT_FOUND', 404);
    } catch (e) {
      if (!res.headersSent && !res.destroyed) respond(res, e.status && e.status >= 400 && e.status <= 599 ? e.status : 400, {error: /^[A-Z_]+$/.test(e.code || '') ? e.code : 'SUBTITLE_OPERATION_FAILED'});
    }
  };
  const stop = () => {
    clearTimeout(timer); timer = null; session = null;
    results.clear(); candidateFiles.clear(); pendingDevices.clear();
    if (server) { server.close(); server = null; }
    if (options.onStop) options.onStop();
  };
  const start = async input => {
    init();
    if (!server) {
      server = http.createServer((req, res) => { handle(req, res).catch(() => { if (!res.headersSent) respond(res, 500, {error: 'SUBTITLE_OPERATION_FAILED'}); }); });
      server.headersTimeout = 10000;
      server.requestTimeout = 30000;
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port == null ? 17832 : options.port, options.bind || '0.0.0.0', resolve); });
      lastPort = server.address().port;
      if (options.onStart) options.onStart();
    }
    const same = session && session.expires > Date.now() && session.itemKey === input.itemKey;
    if (!same) { results.clear(); candidateFiles.clear(); }
    session = {token: same ? session.token : id() + id(), itemKey: String(input.itemKey || ''), title: String(input.title || 'Subtitle import').slice(0, 240), expires: Date.now() + SESSION_MS};
    clearTimeout(timer); timer = setTimeout(stop, SESSION_MS); if (timer.unref) timer.unref();
    return {baseUrl: 'http://127.0.0.1:' + lastPort, token: session.token,
      portalUrls: address().map(a => 'http://' + a + ':' + lastPort), ...status()};
  };
  const stopItem = input => { if (!input.itemKey || (session && session.itemKey === input.itemKey)) stop(); };
  return {start, stop, stopItem, status, preference, updatePreference, approveDevice, configure, search, resolve, download, store, read, list, remove};
}

function register(service, options) {
  let activity;
  const manager = createManager({...options,
    onStart: () => service.activityManager.create('local-subtitles', a => { activity = a; }),
    onStop: () => { if (activity) { service.activityManager.complete(activity, {}, () => {}); activity = null; } }
  });
  service.register('subtitlesStart', message => {
    manager.start(message.payload || {}).then(data => message.respond({returnValue: true, ...data}), () => message.respond({returnValue: false, errorText: 'SUBTITLE_SERVICE_UNAVAILABLE'}));
  });
  service.register('subtitlesStop', message => { manager.stopItem(message.payload || {}); message.respond({returnValue: true}); });
  service.register('subtitlesPair', message => {
    try { manager.approveDevice(message.payload || {}); message.respond({returnValue: true}); }
    catch (_) { message.respond({returnValue: false, errorText: 'PAIRING_EXPIRED'}); }
  });
  service.register('subtitlesPreference', message => {
    try {
      const input = message.payload || {};
      if (!input.itemKey) throw fail('ITEM_REQUIRED');
      message.respond({returnValue: true, ...manager.updatePreference(input.itemKey, input)});
    } catch (_) { message.respond({returnValue: false, errorText: 'SUBTITLE_PREFERENCE_FAILED'}); }
  });
}
module.exports = {createManager, register, checkedUrl, fetchBytes, safeName, MAX_FILE};
