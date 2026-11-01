import {clearCapabilitiesCache, getJellyfinDeviceProfile} from '../../../platform-webos/src/deviceProfile';
import {getSupportedAudioCodecs} from '../../../platform-webos/src/video';

let mockDigitalOutput = 'auto';

jest.mock('@enact/webos/deviceinfo', () => ({
	__esModule: true,
	default: (callback) => callback({sdkVersion: '10.0.0', modelName: 'C5', uhd: true})
}));

jest.mock('@enact/webos/LS2Request', () => ({
	__esModule: true,
	default: class LunaRequestMock {
		send({service, method, parameters, onSuccess}) {
			if (service === 'luna://com.webos.settingsservice') {
				onSuccess({settings: parameters.keys.includes('soundOutputDigital')
					? {soundOutput: 'external_arc', soundOutputDigital: mockDigitalOutput} : {}});
			} else if (method === 'getConfigs') {
				onSuccess({configs: {'tv.hw.panelResolution': '4K'}});
			} else {
				onSuccess({});
			}
		}
	}
}));

const mkvCodecs = (profile) => profile.DirectPlayProfiles.find((p) =>
	p.Type === 'Video' && p.Container.split(',').includes('mkv')).AudioCodec.split(',');

describe('TrueHD original-track request profile', () => {
	beforeEach(() => {
		mockDigitalOutput = 'auto';
		clearCapabilitiesCache();
		jest.spyOn(console, 'log').mockImplementation(() => {});
		jest.spyOn(window.HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
	});

	afterEach(() => jest.restoreAllMocks());

	it('keeps TrueHD and eight-channel capacity in the Auto receiver profile', async () => {
		const profile = await getJellyfinDeviceProfile();
		expect(mkvCodecs(profile)).toContain('truehd');
		expect(profile.TranscodingProfiles.find((p) => p.Protocol === 'hls').MaxAudioChannels).toBe('8');
	});

	it('does not advertise automatic TrueHD while the TV explicitly requests PCM', async () => {
		mockDigitalOutput = 'pcm';
		expect(mkvCodecs(await getJellyfinDeviceProfile())).not.toContain('truehd');
	});

	it('retains the existing explicit Force request when capability detection is bypassed', async () => {
		mockDigitalOutput = 'pcm';
		const profile = await getJellyfinDeviceProfile({passthroughSettings: {forceTruehdPassthrough: true}});
		expect(mkvCodecs(profile)).toContain('truehd');
	});

	it('does not let a stale Force preference override the disabled master switch', async () => {
		const passthroughSettings = {passthroughEnabled: false, forceTruehdPassthrough: true};
		const profile = await getJellyfinDeviceProfile({passthroughSettings});
		expect(mkvCodecs(profile)).not.toContain('truehd');
		expect(getSupportedAudioCodecs({truehd: true}, 'mkv', passthroughSettings)).not.toContain('truehd');
		expect(getSupportedAudioCodecs({truehd: true}, 'mkv', passthroughSettings)).not.toContain('mlp');
	});

	it('removes TrueHD from both decision layers when its codec preference is off', async () => {
		const passthroughSettings = {truehdPassthrough: false};
		expect(mkvCodecs(await getJellyfinDeviceProfile({passthroughSettings}))).not.toContain('truehd');
		expect(getSupportedAudioCodecs({truehd: true}, 'mkv', passthroughSettings)).not.toContain('truehd');
	});

	it('rechecks the current output even when device capabilities are cached', async () => {
		expect(mkvCodecs(await getJellyfinDeviceProfile())).toContain('truehd');
		mockDigitalOutput = 'pcm';
		expect(mkvCodecs(await getJellyfinDeviceProfile())).not.toContain('truehd');
		mockDigitalOutput = 'passThrough';
		expect(mkvCodecs(await getJellyfinDeviceProfile())).toContain('truehd');
	});
});
