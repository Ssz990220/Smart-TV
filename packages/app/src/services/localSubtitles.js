const URI = 'luna://org.moonfin.webos.service/';

export const subtitleServiceCall = (method, payload = {}) => new Promise((resolve, reject) => {
	if (typeof window.PalmServiceBridge !== 'function') { reject(new Error('此功能需要 LG webOS 电视。')); return; }
	const bridge = new window.PalmServiceBridge();
	let done = false;
	let timer = null;
	const finish = (error, value) => {
		if (done) return;
		done = true;
		clearTimeout(timer);
		try { bridge.cancel(); } catch { /* already closed */ }
		if (error) reject(error); else resolve(value);
	};
	timer = setTimeout(() => finish(new Error('电视字幕服务没有响应，请重新打开面板。')), 12000);
	bridge.onservicecallback = raw => {
		try {
			const data = JSON.parse(raw);
			if (!data.returnValue) finish(new Error('字幕服务不可用，请确认安装了完整修复版。'));
			else finish(null, data);
		} catch { finish(new Error('字幕服务返回了无效响应。')); }
	};
	bridge.call(URI + method, JSON.stringify(payload));
});

const errors = {
	ASSRT_KEY_REQUIRED: '请用局域网配置页面填写 ASSRT Token。', OPEN_KEY_REQUIRED: '请用局域网配置页面填写 OpenSubtitles API Key。',
	PROVIDER_AUTH_FAILED: '字幕源认证失败，请检查密钥或重新登录。', QUOTA_OR_RATE_LIMIT: '字幕源下载额度已用完，或请求过快。',
	SEARCH_RESULT_EXPIRED: '搜索结果已过期，请重新搜索。', DOWNLOAD_UNAVAILABLE: '这份字幕暂时无法下载。',
	PAIRING_REQUIRED: '配对已失效，请重新打开字幕面板。', SESSION_EXPIRED: '配对已过期，请重新打开字幕面板。',
	UNSUPPORTED_DOWNLOAD_HOST: '下载地址暂不支持，请在网站下载后导入。', FILE_TOO_LARGE: '字幕包超过 16 MiB。',
	NETWORK_TIMEOUT: '字幕源连接超时，请稍后重试。', NETWORK_ERROR: '字幕源网络连接失败。'
};

export const localSubtitleRequest = async (session, route, method = 'GET', data, binary = false) => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 45000);
	try {
		const response = await fetch(session.baseUrl + route, {
			method, signal: controller.signal,
			headers: {Authorization: 'Bearer ' + session.token, ...(data ? {'Content-Type': 'application/json'} : {})},
			body: data ? JSON.stringify(data) : undefined
		});
		if (!response.ok) {
			const error = await response.json();
			throw new Error(errors[error.error] || '字幕操作失败，请稍后重试。');
		}
		return binary ? await response.arrayBuffer() : await response.json();
	} catch (error) {
		if (error.name === 'AbortError') throw new Error('字幕操作超时，请稍后重试。');
		throw error;
	} finally { clearTimeout(timer); }
};

export const localSubtitleItemKey = (item, mediaSourceId, fallbackServer = '') =>
	JSON.stringify([item?._serverId || item?._serverUrl || fallbackServer, item?.Id || '', mediaSourceId || '']);

// Keep rapid +/- presses ordered. Luna persists even if the player has already
// stopped its HTTP session, so leaving immediately does not lose the last click.
let preferenceQueue = Promise.resolve();
export const localSubtitlePreference = payload => {
	const next = preferenceQueue.then(() => subtitleServiceCall('subtitlesPreference', payload));
	preferenceQueue = next.catch(() => {});
	return next;
};
