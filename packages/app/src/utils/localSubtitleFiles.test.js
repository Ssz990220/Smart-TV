import {TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder} from 'util';
import {decodeLocalSubtitle, escapeLocalSubtitleText, safeArchivePath, openSubtitleFiles} from './localSubtitleFiles';
import {parseSubtitleText} from './subtitleText';
import {sanitizeSubtitleHtml} from './subtitleConstants';

global.TextDecoder = NodeTextDecoder;
const utf8 = value => new NodeTextEncoder().encode(value);

test('reads UTF-8 and UTF-16 BOMs and mainland/traditional Chinese encodings', () => {
	expect(decodeLocalSubtitle(utf8('中文字幕 English'))).toBe('中文字幕 English');
	expect(decodeLocalSubtitle(new Uint8Array([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]))).toBe('中文');
	expect(decodeLocalSubtitle(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]))).toBe('中文');
	expect(decodeLocalSubtitle(new Uint8Array([0xa4, 0xa4, 0xa4, 0xe5]), 'big5')).toBe('中文');
});

test('an imported subtitle cannot inject HTML into the player overlay', () => {
	const text = '1\n00:00:01,000 --> 00:00:03,000\n中文 <img src=x onerror=alert(1)>\n';
	const events = parseSubtitleText(text);
	const node = document.createElement('div');
	node.innerHTML = sanitizeSubtitleHtml(escapeLocalSubtitleText(events[0].Text));
	expect(node.querySelector('img')).toBeNull();
	expect(node.textContent).toContain('中文');
	const assText = '<svg onload=alert(1)>中文';
	node.innerHTML = sanitizeSubtitleHtml(escapeLocalSubtitleText(assText));
	expect(node.querySelector('svg')).toBeNull();
});

test('rejects dangerous archive paths and oversized text files', () => {
	for (const name of ['../bad.srt', '/absolute.srt', 'C:\\bad.srt', '__proto__/bad.srt', 'x/constructor/bad.srt']) expect(safeArchivePath(name)).toBe(false);
	expect(safeArchivePath('Season 1/中文.srt')).toBe(true);
	expect(() => decodeLocalSubtitle(new Uint8Array(4 * 1024 * 1024 + 1))).toThrow();
});

test('plain file import uses the supplied bytes without any media-server request', async () => {
	const bytes = utf8('1\n00:00:01,000 --> 00:00:03,000\n中文 English\n');
	const archive = await openSubtitleFiles('test.srt', bytes);
	expect(archive.entries).toHaveLength(1);
	const text = decodeLocalSubtitle(await archive.entries[0].read());
	expect(parseSubtitleText(text)[0].Text).toBe('中文 English');
	archive.close();
});
