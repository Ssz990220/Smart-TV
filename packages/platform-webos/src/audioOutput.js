// These settings describe the TV output policy. They permit requesting the
// original audio from a server; they do not report the receiver's input codec.
const value = (...values) => values.find((entry) =>
	typeof entry === 'string' && entry.trim().length > 0);

export const mergeAudioOutputStatus = (status = {}, settings = {}) => ({
	...status,
	// Fresh settings take priority over a cached/undocumented avoutput response.
	soundOutput: value(settings.soundOutput, status.soundOutput),
	soundOutputDigital: value(settings.soundOutputDigital, settings.digitalSoundOutput,
		status.soundOutputDigital, status.digitalSoundOutput)
});

export const canRequestReceiverAudio = (status = {}) => {
	const output = String(status.soundOutput || '').trim().toLowerCase();
	const digital = String(status.soundOutputDigital || '').trim().toLowerCase();
	return ['arc', 'earc', 'external_arc', 'external_earc'].includes(output) &&
		['auto', 'passthrough'].includes(digital);
};

export const requestAudioOutputStatus = async (request) => {
	const read = async (service, method, parameters) => {
		try {
			const result = await request(service, method, parameters);
			return result?.returnValue === false ? {} : (result || {});
		} catch (e) {
			return {};
		}
	};
	const [status, current] = await Promise.all([
		read('com.webos.service.avoutput', 'audio/getStatus'),
		read('com.webos.settingsservice', 'getSystemSettings', {
			category: 'sound', keys: ['soundOutput', 'soundOutputDigital']
		})
	]);
	const settings = current.settings || {};
	if (value(settings.soundOutputDigital, settings.digitalSoundOutput)) {
		return mergeAudioOutputStatus(status, settings);
	}
	// Older firmware may expose the inverse spelling. Query it separately so
	// an unsupported key cannot make the current firmware's whole request fail.
	const legacy = await read('com.webos.settingsservice', 'getSystemSettings', {
		category: 'sound', keys: ['soundOutput', 'digitalSoundOutput']
	});
	const oldSettings = legacy.settings || {};
	const combined = {
		...oldSettings,
		...settings,
		soundOutput: value(settings.soundOutput, oldSettings.soundOutput)
	};
	return mergeAudioOutputStatus(status, combined);
};
