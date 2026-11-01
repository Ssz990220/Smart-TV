'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {createManager, checkedUrl, MAX_FILE} = require('../local-subtitles');
const subtitle = Buffer.from('1\n00:00:01,000 --> 00:00:05,000\n中文测试 / English\n');
const reply = value => ({status: 200, buffer: Buffer.from(JSON.stringify(value)), headers: {}});
async function fixture(options) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moonfin-subtitles-test-'));
  const manager = createManager({dataDir, port: 0, bind: '127.0.0.1', ...options});
  const session = await manager.start({itemKey: 'private-test-server:item:source', title: '原创测试片'});
  const api = (route, opts = {}) => fetch(session.baseUrl + route, {...opts, headers: {Authorization: 'Bearer ' + session.token, ...opts.headers}});
  const close = () => { manager.stop(); fs.rmSync(dataDir, {recursive: true, force: true}); };
  return {manager, session, api, dataDir, close};
}

test('upload is paired, private, item-scoped, persistent and independent of Emby', async () => {
  let providerCalls = 0;
  const x = await fixture({request: () => { providerCalls++; throw new Error('unexpected'); }});
  try {
    assert.equal((await fetch(x.session.baseUrl + '/api/state')).status, 401);
    const upload = await x.api('/api/upload', {method: 'PUT', headers: {'X-Subtitle-Name': encodeURIComponent('../中文.srt')}, body: subtitle});
    assert.equal(upload.status, 200);
    const file = await upload.json();
    assert.equal(file.name, '.._中文.srt');
    assert.equal((fs.statSync(path.join(x.dataDir, file.id)).mode & 0o777), 0o600);
    assert.equal((fs.statSync(x.dataDir).mode & 0o777), 0o700);
    assert.equal(await (await x.api('/api/files/' + file.id)).text(), subtitle.toString());
    assert.equal(providerCalls, 0);
    const other = await x.manager.start({itemKey: 'another-movie', title: '另一个测试'});
    assert.notEqual(other.token, x.session.token);
    assert.equal((await x.api('/api/state')).status, 401);
    const r = await fetch(other.baseUrl + '/api/files/' + file.id, {headers: {Authorization: 'Bearer ' + other.token}});
    assert.equal(r.status, 404);
  } finally { x.close(); }
});

test('cross-origin requests and unsupported files are rejected', async () => {
  const x = await fixture();
  try {
    assert.equal((await x.api('/api/state', {headers: {Origin: 'https://untrusted.example'}})).status, 403);
    assert.equal((await x.api('/api/upload', {method: 'PUT', headers: {'X-Subtitle-Name': 'payload.html'}, body: 'not a subtitle'})).status, 400);
    assert.throws(() => x.manager.store('huge.srt', Buffer.alloc(MAX_FILE + 1), 'x'), /FILE_TOO_LARGE/);
    assert.throws(() => checkedUrl('file:///etc/passwd'), /UNSUPPORTED_DOWNLOAD_HOST/);
    assert.throws(() => checkedUrl('https://127.0.0.1/private'), /UNSUPPORTED_DOWNLOAD_HOST/);
    assert.throws(() => checkedUrl('https://assrt.net.attacker.example/x'), /UNSUPPORTED_DOWNLOAD_HOST/);
    assert.equal(checkedUrl('http://file0.assrt.net/download/sub.srt').protocol, 'https:');
  } finally { x.close(); }
});

test('missing provider keys fail before sending any external requests', async () => {
  const x = await fixture({request: () => { throw new Error('must not send'); }});
  try {
    await assert.rejects(x.manager.search({provider: 'assrt', query: 'Test movie'}), /ASSRT_KEY_REQUIRED/);
    await assert.rejects(x.manager.search({provider: 'opensubtitles', query: 'Test movie'}), /OPEN_KEY_REQUIRED/);
  } finally { x.close(); }
});

test('ASSRT uses Bearer authentication and can download a selected standalone file', async () => {
  const requests = [];
  const x = await fixture({request: async (url, opts) => {
    requests.push({url, opts});
    if (url.includes('/search')) return reply({status: 0, sub: {subs: [{id: 123, native_name: '中文测试', lang: {desc: '双语'}, subtype: 'SubRip'}]}});
    if (url.includes('/detail')) return reply({status: 0, sub: {subs: [{filelist: [{f: '原创测试.srt', url: 'https://file0.assrt.net/test.srt'}]}]}});
    return {status: 200, buffer: subtitle};
  }});
  try {
    await x.manager.configure({assrtToken: 'FAKE-ASSRT-TEST-SECRET'});
    const results = await x.manager.search({provider: 'assrt', query: '中文测试'});
    assert.equal(requests[0].opts.headers.Authorization, 'Bearer FAKE-ASSRT-TEST-SECRET');
    assert.ok(!requests[0].url.includes('SECRET'));
    const choices = await x.manager.resolve(results[0].id);
    const file = await x.manager.download(choices[0].id, 'private-test-server:item:source');
    assert.equal(x.manager.read(file.id).buffer.toString(), subtitle.toString());
    assert.ok(!JSON.stringify(x.manager.status()).includes('SECRET'));
    assert.equal((fs.statSync(path.join(x.dataDir, 'settings.json')).mode & 0o777), 0o600);
  } finally { x.close(); }
});

test('OpenSubtitles login does not persist password and download is explicit', async () => {
  const requests = [];
  const x = await fixture({request: async (url, opts) => {
    requests.push({url, opts});
    if (url.endsWith('/login')) return reply({token: 'FAKE-LOGIN-TOKEN', base_url: 'vip-api.opensubtitles.com'});
    if (url.includes('/subtitles?')) return reply({data: [{attributes: {language: 'zh-cn', release: 'Test release', files: [{file_id: 42, file_name: 'test.srt'}]}}]});
    if (url.endsWith('/download')) return reply({link: 'https://dl.opensubtitles.com/test.srt', file_name: 'test.srt'});
    return {status: 200, buffer: subtitle};
  }});
  try {
    await x.manager.configure({openApiKey: 'FAKE-API-KEY', username: 'fake-test-user', password: 'DO-NOT-PERSIST-PASSWORD'});
    assert.ok(!fs.readFileSync(path.join(x.dataDir, 'settings.json'), 'utf8').includes('DO-NOT-PERSIST'));
    const results = await x.manager.search({provider: 'opensubtitles', query: 'Test episode', season: 1, episode: 2, language: 'zh-cn,en'});
    assert.ok(requests[1].url.startsWith('https://vip-api.opensubtitles.com/'));
    assert.ok(requests[1].url.includes('episode_number=2'));
    assert.equal(requests.filter(r => r.url.endsWith('/download')).length, 0);
    const choices = await x.manager.resolve(results[0].id);
    assert.equal(requests.filter(r => r.url.endsWith('/download')).length, 1);
    const file = await x.manager.download(choices[0].id, 'private-test-server:item:source');
    assert.ok(file.id);
    assert.ok(!JSON.stringify(x.manager.status()).includes('FAKE'));
    await x.manager.configure({openApiKey: null, logout: true});
    assert.equal(x.manager.status().configured.openLoggedIn, false);
  } finally { x.close(); }
});

test('provider failures return codes, never provider response bodies or keys', async () => {
  const x = await fixture({request: async () => ({status: 429, buffer: Buffer.from('sensitive-provider-body'), headers: {}})});
  try {
    await x.manager.configure({assrtToken: 'FAKE-SECRET'});
    const r = await x.api('/api/search', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({provider: 'assrt', query: 'test'})});
    assert.equal(r.status, 429);
    assert.deepEqual(await r.json(), {error: 'QUOTA_OR_RATE_LIMIT'});
  } finally { x.close(); }
});

test('fixed URL pairs through TV approval and follows movies without URL secrets', async () => {
  const x = await fixture();
  try {
    assert.ok(x.session.portalUrls.every(url => !url.includes('#') && !url.includes('?')));
    const pair = await fetch(x.session.baseUrl + '/api/pair', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: 'Test browser'})});
    const cookie = pair.headers.get('set-cookie').split(';')[0];
    assert.match(pair.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.deepEqual(await pair.json(), {state: 'pending'});
    const browser = (route, opts = {}) => fetch(x.session.baseUrl + route, {...opts, headers: {Cookie: cookie, ...opts.headers}});
    assert.equal((await browser('/api/state')).status, 401);
    const pending = x.manager.status().pairingRequests;
    assert.equal(pending.length, 1);
    x.manager.approveDevice({id: pending[0].id, allow: true});
    const state = await (await browser('/api/state')).json();
    assert.equal(state.title, '原创测试片');
    assert.equal(state.pairingRequests, undefined);
    const put = item => browser('/api/upload', {method: 'PUT', headers: {'X-Moonfin-Item': item, 'X-Subtitle-Name': 'original.srt'}, body: subtitle});
    const file = await (await put(state.item)).json();
    assert.ok(file.id);
    await x.manager.start({itemKey: 'second-movie', title: 'Second original movie'});
    const next = await (await browser('/api/state')).json();
    assert.equal(next.title, 'Second original movie');
    assert.notEqual(state.item, next.item);
    assert.equal(next.files.length, 0);
    assert.equal((await put(state.item)).status, 409);
    assert.equal((await browser('/api/files/' + file.id)).status, 404);
    assert.equal((await put(next.item)).status, 200);
    x.manager.stopItem({itemKey: 'old-item-cleanup'});
    assert.equal((await browser('/api/state')).status, 200);
  } finally { x.close(); }
});

test('browser approval persists across restart and can be revoked from TV', async () => {
  const x = await fixture();
  try {
    const r = await fetch(x.session.baseUrl + '/api/pair', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
    const cookie = r.headers.get('set-cookie').split(';')[0];
    x.manager.approveDevice({id: x.manager.status().pairingRequests[0].id, allow: true});
    const saved = fs.readFileSync(path.join(x.dataDir, 'devices.json'), 'utf8');
    assert.ok(!saved.includes(cookie.split('=')[1]));
    assert.equal(fs.statSync(path.join(x.dataDir, 'devices.json')).mode & 0o777, 0o600);
    x.manager.stop();
    const s = await x.manager.start({itemKey: 'new-session', title: 'Resumed original movie'});
    const headers = {Cookie: cookie};
    assert.deepEqual(await (await fetch(s.baseUrl + '/api/pair', {headers})).json(), {state: 'approved'});
    assert.equal((await fetch(s.baseUrl + '/api/state', {headers})).status, 200);
    x.manager.approveDevice({forgetAll: true});
    assert.equal((await fetch(s.baseUrl + '/api/state', {headers})).status, 401);
    assert.deepEqual(await (await fetch(s.baseUrl + '/api/pair', {headers})).json(), {state: 'unpaired'});
  } finally { x.close(); }
});

test('unapproved browsers cannot pair cross-origin or through unrelated Host headers', async () => {
  const x = await fixture();
  try {
    const r = await fetch(x.session.baseUrl + '/api/pair', {method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'https://untrusted.example'}, body: '{}'});
    assert.equal(r.status, 403);
    const hostStatus = await new Promise((resolve, reject) => { const req = require('http').get(x.session.baseUrl + '/api/pair', {headers: {Host: 'untrusted.example'}}, r => { r.resume(); resolve(r.statusCode); }); req.on('error', reject); });
    assert.equal(hostStatus, 403);
    assert.equal((await fetch(x.session.baseUrl + '/api/pair', {method: 'POST', body: '{}'})).status, 400);
    const request = await fetch(x.session.baseUrl + '/api/pair', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
    const cookie = request.headers.get('set-cookie').split(';')[0];
    x.manager.approveDevice({id: x.manager.status().pairingRequests[0].id, allow: false});
    assert.equal((await fetch(x.session.baseUrl + '/api/state', {headers: {Cookie: cookie}})).status, 401);
    assert.equal(x.manager.status().pairedDevices, 0);
  } finally { x.close(); }
});
