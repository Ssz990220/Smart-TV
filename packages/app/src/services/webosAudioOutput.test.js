import {canRequestReceiverAudio, mergeAudioOutputStatus, requestAudioOutputStatus} from '../../../platform-webos/src/audioOutput';

describe('webOS receiver audio requests', () => {
	it('does not advertise receiver audio when the actual C5 setting is PCM', async () => {
		const request = jest.fn((service) => Promise.resolve(service === 'com.webos.settingsservice'
			? {settings: {soundOutput: 'external_arc', soundOutputDigital: 'pcm'}}
			: {}));
		const status = await requestAudioOutputStatus(request);
		expect(status.soundOutputDigital).toBe('pcm');
		expect(canRequestReceiverAudio(status)).toBe(false);
		expect(request).toHaveBeenCalledWith('com.webos.settingsservice', 'getSystemSettings', {
			category: 'sound', keys: ['soundOutput', 'soundOutputDigital']
		});
		expect(request).toHaveBeenCalledTimes(2);
	});

	it.each(['auto', 'passThrough', 'PassThrough'])('permits original audio requests with %s', (digital) => {
		expect(canRequestReceiverAudio({soundOutput: 'external_arc', soundOutputDigital: digital})).toBe(true);
	});

	it('uses current settings instead of stale avoutput values', () => {
		const status = mergeAudioOutputStatus({soundOutput: 'external_arc', soundOutputDigital: 'auto'},
			{soundOutput: 'tv_speaker', soundOutputDigital: 'pcm'});
		expect(status.soundOutput).toBe('tv_speaker');
		expect(status.soundOutputDigital).toBe('pcm');
		expect(canRequestReceiverAudio(status)).toBe(false);
	});

	it('falls back to the older key without discarding the current output', async () => {
		const request = jest.fn((service, method, params) => {
			if (service === 'com.webos.service.avoutput') return Promise.resolve({});
			return Promise.resolve({settings: params.keys.includes('soundOutputDigital')
				? {soundOutput: 'external_arc'} : {digitalSoundOutput: 'passThrough'}});
		});
		const status = await requestAudioOutputStatus(request);
		expect(status).toMatchObject({soundOutput: 'external_arc', soundOutputDigital: 'passThrough'});
		expect(canRequestReceiverAudio(status)).toBe(true);
	});

	it('continues through legacy settings when the current-key call is rejected', async () => {
		const request = jest.fn((service, method, params) => {
			if (service === 'com.webos.service.avoutput') return Promise.resolve({});
			if (params.keys.includes('soundOutputDigital')) return Promise.resolve({returnValue: false});
			return Promise.resolve({settings: {soundOutput: 'earc', digitalSoundOutput: 'auto'}});
		});
		expect(canRequestReceiverAudio(await requestAudioOutputStatus(request))).toBe(true);
	});

	it('does not replace a valid legacy output with an empty current value', async () => {
		const request = jest.fn((service, method, params) => {
			if (service === 'com.webos.service.avoutput') return Promise.resolve({});
			return Promise.resolve({settings: params.keys.includes('soundOutputDigital')
				? {soundOutput: ''} : {soundOutput: 'external_arc', digitalSoundOutput: 'auto'}});
		});
		expect(canRequestReceiverAudio(await requestAudioOutputStatus(request))).toBe(true);
	});

	it('does not infer a bitstream policy from an unknown mode or failed requests', async () => {
		expect(canRequestReceiverAudio({soundOutput: 'external_arc'})).toBe(false);
		const status = await requestAudioOutputStatus(() => Promise.reject(new Error('unavailable')));
		expect(canRequestReceiverAudio(status)).toBe(false);
	});

	it('does not enable receiver requests for TV speakers or optical', () => {
		for (const soundOutput of ['tv_speaker', 'external_optical', 'bluetooth']) {
			expect(canRequestReceiverAudio({soundOutput, soundOutputDigital: 'auto'})).toBe(false);
		}
	});
});
