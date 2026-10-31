import SubtitlesOctopus from 'libass-wasm';
import {initAssCanvasRenderer, disposeAssRenderer} from './assRenderer';

jest.mock('libass-wasm', () => jest.fn());

test('ASS receives the offline CJK font while retaining embedded fonts and the track', async () => {
	SubtitlesOctopus.mockImplementation(() => ({dispose: jest.fn()}));
	const canvas = {};
	const view = await initAssCanvasRenderer(canvas, 'test.ass', ['embedded-style.ttf']);
	expect(view).not.toBeNull();
	expect(SubtitlesOctopus).toHaveBeenCalledWith(expect.objectContaining({
		canvas,
		subUrl: 'test.ass',
		fonts: ['embedded-style.ttf'],
		fallbackFont: 'NotoSansCJKsc-Regular.otf'
	}));
	disposeAssRenderer(view);
	expect(view.dispose).toHaveBeenCalledTimes(1);
});
