// Present a size-preserving SeekHead overlay to Starfish. All media bytes
// outside that small header region stream directly from the original source.
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const {Transform, pipeline} = require('stream');

const SEGMENT = 0x18538067;
const SEEK_HEAD = 0x114d9b74;
const CUES = 0x1c53bb6b;
const VOID = 0xec;
const PREFIX = 16 * 1024;
const TAIL = 256 * 1024;

function vint(bytes, at, id = false) {
	const first = bytes[at];
	if (!first) throw Error('Invalid EBML integer');
	const length = 8 - Math.floor(Math.log2(first));
	if (at + length > bytes.length || (id && length > 4)) throw Error('Truncated EBML integer');
	let value = id ? first : first & ((1 << (8 - length)) - 1);
	for (let i = 1; i < length; i++) value = value * 256 + bytes[at + i];
	if (!Number.isSafeInteger(value)) throw Error('Oversize EBML integer');
	return {value, length};
}

function element(bytes, offset) {
	const id = vint(bytes, offset, true);
	const size = vint(bytes, offset + id.length);
	const start = offset + id.length + size.length;
	return {id: id.value, offset, start, end: start + size.value, sizeWidth: size.length, idWidth: id.length};
}

function *children(bytes, start, end) {
	for (let at = start; at < end;) {
		const entry = element(bytes, at);
		yield entry;
		at = entry.end;
	}
}

function uint(bytes, entry) {
	if (entry.end > bytes.length || entry.end - entry.start > 6) throw Error('Invalid EBML offset');
	return bytes.readUIntBE(entry.start, entry.end - entry.start);
}

function tailCues(bytes) {
	const marker = Buffer.from('1c53bb6b', 'hex');
	for (let at = bytes.lastIndexOf(marker); at >= 0; at = at ? bytes.lastIndexOf(marker, at - 1) : -1) {
		try {
			const cue = element(bytes, at);
			if (cue.end > bytes.length) continue;
			let cluster;
			let count = 0;
			for (const point of children(bytes, cue.start, cue.end)) {
				if (point.id !== 0xbb || point.end > cue.end) throw Error('Invalid CuePoint');
				const fields = [...children(bytes, point.start, point.end)];
				if (fields.some(field => field.end > point.end)) throw Error('Invalid CuePoint fields');
				if (!fields.some(field => field.id === 0xb3)) throw Error('Missing CueTime');
				const track = fields.find(field => field.id === 0xb7);
				const position = track && [...children(bytes, track.start, track.end)].find(field => field.id === 0xf1);
				if (!position || position.end > track.end) throw Error('Missing CueClusterPosition');
				const offset = uint(bytes, position);
				if (cluster === undefined) cluster = offset;
				count++;
			}
			if (count >= 2) return {at, cluster};
		} catch (_) { /* The marker can occur inside media data. */ }
	}
	return null;
}

function smallElement(hex, data) {
	return Buffer.concat([Buffer.from(hex, 'hex'), Buffer.from([0x80 + data.length]), data]);
}

function findUnindexedHead(prefix) {
	const segment = [...children(prefix, 0, prefix.length)].find(entry => entry.id === SEGMENT);
	if (!segment) return null;
	const top = [...children(prefix, segment.start, prefix.length)];
	const head = top.find(entry => entry.id === SEEK_HEAD);
	const padding = head && top.find(entry => entry.offset === head.end && entry.id === VOID);
	if (!padding || padding.end > prefix.length) return null;
	for (const entry of children(prefix, head.start, head.end)) {
		if (entry.id !== 0x4dbb || entry.end > head.end) return null;
		for (const field of children(prefix, entry.start, entry.end)) {
			if (field.end > entry.end) return null;
			if (field.id === 0x53ab && uint(prefix, field) === CUES) return null;
		}
	}
	return {segment, head, padding};
}

function makeOverlay(prefix, tail, tailStart, layout = findUnindexedHead(prefix)) {
	if (!layout) return null;
	const {segment, head, padding} = layout;
	const cue = tailCues(tail);
	if (!cue) return null;
	const absolute = tailStart + cue.at;
	const relative = absolute - segment.start;
	if (relative <= 0 || relative >= 2 ** 48 || cue.cluster >= relative) return null;
	const offset = Buffer.alloc(6);
	offset.writeUIntBE(relative, 0, 6);
	const seek = smallElement('4dbb', Buffer.concat([
		smallElement('53ab', Buffer.from('1c53bb6b', 'hex')), smallElement('53ac', offset)
	]));
	const size = head.end - head.start + seek.length;
	const left = padding.end - head.end - seek.length;
	if (left < 2 || left > 128 || head.sizeWidth > 6 || size >= 2 ** (7 * head.sizeWidth) - 1) return null;
	const encoded = Buffer.alloc(head.sizeWidth);
	encoded.writeUIntBE(size + 2 ** (7 * head.sizeWidth), 0, head.sizeWidth);
	return {
		start: head.offset,
		cluster: segment.start + cue.cluster,
		bytes: Buffer.concat([prefix.subarray(head.offset, head.offset + head.idWidth), encoded,
			prefix.subarray(head.start, head.end), seek, smallElement('ec', Buffer.alloc(left - 2))])
	};
}

function upstream(url, range, tls, timeout = 2500) {
	return new Promise((resolve, reject) => {
		const transport = url.protocol === 'https:' ? https : http;
		const req = transport.get(url, {...tls, headers: {Range: range, 'Accept-Encoding': 'identity'}}, resolve);
		req.setTimeout(timeout, () => req.destroy(Error('Range timeout')));
		const deadline = setTimeout(() => req.destroy(Error('Range headers timeout')), timeout);
		req.once('response', () => clearTimeout(deadline));
		req.once('close', () => clearTimeout(deadline));
		req.on('error', reject);
	});
}

function contentRange(response) {
	const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '');
	if (response.statusCode !== 206 || !match || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') return null;
	const [start, end, total] = match.slice(1).map(Number);
	return [start, end, total].every(Number.isSafeInteger) && start <= end && end < total ? {start, end, total} : null;
}

async function probe(url, start, count, tls, total) {
	const response = await upstream(url, 'bytes=' + start + '-' + (start + count - 1), tls);
	const deadline = setTimeout(() => response.destroy(Error('Range body timeout')), 2500);
	try {
		const range = contentRange(response);
		if (!range || range.start !== start || range.end !== Math.min(start + count, range.total) - 1 || (total && total !== range.total)) throw Error('Invalid Range response');
		const chunks = [];
		let length = 0;
		for await (const chunk of response) {
			length += chunk.length;
			if (length > count) throw Error('Excess Range data');
			chunks.push(chunk);
		}
		if (length !== range.end - start + 1) throw Error('Truncated Range response');
		return {bytes: Buffer.concat(chunks), total: range.total};
	} finally { clearTimeout(deadline); response.destroy(); }
}

async function start(source, tls, onClose = () => {}) {
	const url = new URL(source);
	if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
	const {bytes, total} = await probe(url, 0, PREFIX, tls);
	const layout = findUnindexedHead(bytes);
	if (!layout) return null;
	const tailStart = Math.max(0, total - TAIL);
	const tail = await probe(url, tailStart, total - tailStart, tls, total);
	const overlay = makeOverlay(bytes, tail.bytes, tailStart, layout);
	if (!overlay) return null;
	const sample = await probe(url, overlay.cluster, 16, tls, total);
	if (element(sample.bytes, 0).id !== 0x1f43b675) return null;

	const token = crypto.randomBytes(24).toString('hex');
	const route = '/' + token + '/stream.mkv';
	const sockets = new Set();
	let timer;
	let closed = false;
	const stop = () => {
		if (closed) return;
		closed = true;
		clearTimeout(timer);
		for (const socket of sockets) socket.destroy();
		server.close();
		onClose();
	};
	const expire = ms => {
		clearTimeout(timer);
		timer = setTimeout(stop, ms);
	};
	const server = http.createServer(async (request, response) => {
		if (request.url !== route || !['GET', 'HEAD'].includes(request.method)) {
			response.writeHead(404).end();
			return;
		}
		const requested = request.headers.range;
		const match = /^bytes=(\d+)-(\d*)$/.exec(requested || '');
		const first = match ? Number(match[1]) : 0;
		const last = match && match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
		if ((requested && !match) || !Number.isSafeInteger(first) || first > last) {
			response.writeHead(416, {'Content-Range': 'bytes */' + total}).end();
			return;
		}
		expire(30 * 60 * 1000);
		const headers = {'Content-Type': 'video/x-matroska', 'Accept-Ranges': 'bytes',
			'Content-Length': last - first + 1, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*'};
		if (requested) headers['Content-Range'] = 'bytes ' + first + '-' + last + '/' + total;
		const status = requested ? 206 : 200;
		if (request.method === 'HEAD') {
			response.writeHead(status, headers).end();
			return;
		}
		try {
			const data = await upstream(url, 'bytes=' + first + '-' + last, tls, 15000);
			const range = contentRange(data);
			if (response.destroyed || !range || range.start !== first || range.end !== last || range.total !== total) {
				data.destroy();
				if (!response.destroyed) response.writeHead(502).end();
				return;
			}
			response.writeHead(status, headers);
			let at = first;
			pipeline(data, new Transform({
				transform(chunk, encoding, callback) {
					const from = Math.max(at, overlay.start);
					const to = Math.min(at + chunk.length, overlay.start + overlay.bytes.length);
					if (from < to) overlay.bytes.copy(chunk, from - at, from - overlay.start, to - overlay.start);
					at += chunk.length;
					callback(null, chunk);
				}
			}), response, () => {});
		} catch (_) {
			if (!response.headersSent && !response.destroyed) response.writeHead(502).end();
			else response.destroy();
		}
	});
	server.on('connection', socket => {
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	expire(25 * 1000);
	return {token, url: 'http://127.0.0.1:' + server.address().port + route, stop};
}

function register(service, tls) {
	const sessions = new Map();
	service.register('mkvSeekStart', async message => {
		let activity;
		let closed = false;
		let session;
		try {
			session = await start((message.payload || {}).url, tls, () => {
				closed = true;
				sessions.delete(session.token);
				if (activity) service.activityManager.complete(activity, {}, () => {});
			});
			if (session) {
				sessions.set(session.token, session);
				service.activityManager.create('mkv-seek-' + session.token, value => {
					activity = value;
					if (closed && activity) service.activityManager.complete(activity, {}, () => {});
				});
			}
			message.respond(session ? {returnValue: true, token: session.token, url: session.url} : {returnValue: true});
		} catch (_) {
			if (session) session.stop();
			message.respond({returnValue: true});
		}
	});
	service.register('mkvSeekStop', message => {
		const session = sessions.get((message.payload || {}).token);
		if (session) session.stop();
		message.respond({returnValue: true});
	});
}

module.exports = {makeOverlay, start, register};
