const SERVICE = 'luna://org.moonfin.webos.service/';

function call(method, payload) {
	return new Promise(resolve => {
		if (typeof window.PalmServiceBridge !== 'function') {
			resolve(null);
			return;
		}
		const bridge = new window.PalmServiceBridge();
		let finished = false;
		let timer;
		const finish = result => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			try { bridge.cancel(); } catch { /* Bridge already closed. */ }
			resolve(result);
		};
		timer = setTimeout(() => finish(null), 8500);
		bridge.onservicecallback = raw => {
			try { finish(JSON.parse(raw)); } catch { finish(null); }
		};
		try { bridge.call(SERVICE + method, JSON.stringify(payload)); }
		catch { finish(null); }
	});
}

export async function openMkvSeekStream(url) {
	const result = await call('mkvSeekStart', {url});
	if (!result?.returnValue || !/^[a-f0-9]{48}$/.test(result.token || '') ||
		!new RegExp('^http://127\\.0\\.0\\.1:[0-9]+/' + result.token + '/stream\\.mkv$').test(result.url || '')) return null;
	return {url: result.url, close: () => call('mkvSeekStop', {token: result.token})};
}
