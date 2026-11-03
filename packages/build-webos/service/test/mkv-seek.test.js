const assert = require('node:assert/strict');
const http = require('node:http');
const {test} = require('node:test');
const {start} = require('../mkv-seek');

const ebml = (id, bytes) => Buffer.concat([Buffer.from(id, 'hex'), Buffer.from([128 + bytes.length]), bytes]);
const uint = (id, value) => ebml(id, Buffer.from([value]));
const seek = id => ebml('4dbb', Buffer.concat([ebml('53ab', Buffer.from(id, 'hex')), uint('53ac', 8)]));
const point = (time, cluster) => ebml('bb', Buffer.concat([
	uint('b3', time), ebml('b7', Buffer.concat([uint('f7', 1), uint('f1', cluster)]))
]));

function fixture(indexed = false, withCues = true) {
	const header = ebml('1a45dfa3', Buffer.alloc(0));
	const head = ebml('114d9b74', seek(indexed ? '1c53bb6b' : '1549a966'));
	const metadata = Buffer.concat([head, ebml('ec', Buffer.alloc(28))]);
	const cluster = Buffer.concat([Buffer.from('1f43b675', 'hex'), Buffer.from([0x28, 0, 1]), Buffer.alloc(524289)]);
	const cues = withCues ? ebml('1c53bb6b', Buffer.concat([point(1, metadata.length), point(2, metadata.length)])) : Buffer.alloc(0);
	const segment = Buffer.concat([metadata, cluster, cues]);
	const size = Buffer.alloc(4);
	size.writeUInt32BE(segment.length + 2 ** 28);
	return {bytes: Buffer.concat([header, Buffer.from('18538067', 'hex'), size, segment]),
		head: header.length + 8, media: header.length + 8 + metadata.length, cues: header.length + 8 + metadata.length + cluster.length};
}

async function source(t, bytes) {
	const requests = [];
	const server = http.createServer((req, res) => {
		const [, from, through] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
		const start = Number(from);
		const end = Math.min(Number(through), bytes.length - 1);
		requests.push([start, end]);
		res.writeHead(206, {'Content-Range': 'bytes ' + start + '-' + end + '/' + bytes.length});
		res.end(bytes.subarray(start, end + 1));
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise(resolve => server.close(resolve)));
	return {url: 'http://127.0.0.1:' + server.address().port, requests};
}

test('exposes tail Cues with a size-preserving header overlay and unchanged media ranges', async t => {
	const {bytes, head, media, cues} = fixture();
	const input = await source(t, bytes);
	const proxy = await start(input.url, {});
	assert.ok(proxy);
	t.after(proxy.stop);
	assert.equal(input.requests.length, 3);
	const from = head + 3;
	const prefix = await fetch(proxy.url, {headers: {Range: 'bytes=' + from + '-' + (media + 15)}});
	assert.equal(prefix.status, 206);
	assert.equal(prefix.headers.get('content-range'), 'bytes ' + from + '-' + (media + 15) + '/' + bytes.length);
	const patch = Buffer.from(await prefix.arrayBuffer());
	assert.notDeepEqual(patch, bytes.subarray(from, media + 16));
	assert.ok(patch.includes(Buffer.from('1c53bb6b', 'hex')));
	assert.deepEqual(patch.subarray(-16), bytes.subarray(media, media + 16));
	const response = await fetch(proxy.url, {headers: {Range: 'bytes=' + cues + '-'}});
	assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(cues));
	assert.equal((await fetch(new URL('/wrong', proxy.url))).status, 404);
	proxy.stop();
	await assert.rejects(fetch(proxy.url));
});

test('leaves indexed files alone and skips the tail probe', async t => {
	const input = await source(t, fixture(true).bytes);
	assert.equal(await start(input.url, {}), null);
	assert.equal(input.requests.length, 1);
});

test('falls back when the bounded tail has no complete Cues', async t => {
	const input = await source(t, fixture(false, false).bytes);
	assert.equal(await start(input.url, {}), null);
	assert.equal(input.requests.length, 2);
});
