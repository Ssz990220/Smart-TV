export const MAX_SUBTITLE_BYTES = 4 * 1024 * 1024;
export const isSubtitleName = name => /\.(srt|ass|ssa|vtt)$/i.test(name || '');
export const safeArchivePath = name => {
	const s = String(name || '').replace(/\\/g, '/');
	return !!s && !s.startsWith('/') && !/^[a-z]:/i.test(s) &&
		!s.split('/').some(p => p === '..' || p === '__proto__' || p === 'constructor' || p === 'prototype');
};

export const decodeLocalSubtitle = (bytes, encoding = 'auto') => {
	const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	if (!data.length || data.length > MAX_SUBTITLE_BYTES) throw new Error('单份字幕需在 4 MiB 以内。');
	let codec = encoding;
	if (codec === 'auto') {
		if (data[0] === 0xff && data[1] === 0xfe) codec = 'utf-16le';
		else if (data[0] === 0xfe && data[1] === 0xff) codec = 'utf-16be';
		else {
			try { return new TextDecoder('utf-8', {fatal: true}).decode(data).replace(/^\uFEFF/, ''); }
			catch { codec = 'gb18030'; }
		}
	}
	try { return new TextDecoder(codec, {fatal: true}).decode(data).replace(/^\uFEFF/, ''); }
	catch { throw new Error('字幕编码不匹配，请尝试 UTF-8、GB18030 或 Big5。'); }
};

// Local plain text must never become executable HTML in the existing overlay.
export const escapeLocalSubtitleText = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const openSubtitleFiles = async (name, bytes) => {
	if (isSubtitleName(name)) return {entries: [{name, read: async () => bytes}], close: () => {}};
	if (!/\.(zip|rar|7z)$/i.test(name)) throw new Error('不支持此文件类型。');
	const {Archive} = await import('libarchive.js/main.js');
	class SubtitleArchive extends Archive {
		_workerMsg(event) {
			const entry = event?.data?.entry;
			if (entry && (!safeArchivePath(entry.path) || (entry.fileName && !safeArchivePath(entry.fileName)))) return;
			return super._workerMsg(event);
		}
	}
	const archive = new SubtitleArchive(new File([bytes], name), {workerUrl: 'reader/libarchive-worker.js'});
	const close = () => archive._worker?.terminate();
	let timer;
	try {
		await Promise.race([archive.open(), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('字幕包读取超时。')), 15000); })]);
		clearTimeout(timer);
		if (await archive.hasEncryptedData()) throw new Error('请先在电脑解密字幕包，再导入字幕文件。');
		const files = await archive.getFilesArray();
		if (files.length > 2000) throw new Error('压缩包文件过多，请解压后单独导入字幕。');
		const selected = files.filter(e => safeArchivePath(e.path + e.file.name) && isSubtitleName(e.file.name));
		if (selected.length > 100) throw new Error('字幕文件过多，请单独导入需要的字幕。');
		if (!selected.length) throw new Error('压缩包中没有 SRT、ASS、SSA 或 VTT 字幕。');
		return {entries: selected.map(({file, path}) => ({name: path + file.name, read: async () => {
			if (file.size > MAX_SUBTITLE_BYTES) throw new Error('字幕文件超过 4 MiB。');
			const extracted = await file.extract();
			if (extracted.size > MAX_SUBTITLE_BYTES) throw new Error('字幕文件超过 4 MiB。');
			return extracted.arrayBuffer();
		}})), close};
	} catch (error) { clearTimeout(timer); close(); throw error; }
};
