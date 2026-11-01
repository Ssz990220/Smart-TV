import {render as renderView, act} from '@testing-library/react';
import LocalSubtitlePanel from './LocalSubtitlePanel';
import {subtitleServiceCall, localSubtitleRequest} from '../../services/localSubtitles';
import {openSubtitleFiles, decodeLocalSubtitle} from '../../utils/localSubtitleFiles';

// Enact's test runner maps React to its own version, but leaves JSX's runtime
// pointed at the app version. Create test elements with the mapped React too.
jest.mock('react/jsx-dev-runtime', () => ({jsxDEV: (type, props, key) => require('react').createElement(type, {...props, key})}));
jest.mock('@enact/spotlight', () => ({__esModule: true, default: {focus: jest.fn()}}));
jest.mock('@enact/spotlight/Spottable', () => ({__esModule: true, default: () => elementProps => { const attrs = {...elementProps}; delete attrs.spotlightId; return require('react').createElement('button', attrs); }}));
jest.mock('../../components/SpottableInput/SpottableInput', () => () => null);
jest.mock('../../utils/spotlightContainers', () => ({ModalContainer: elementProps => { const attrs = {...elementProps}; delete attrs.spotlightId; return require('react').createElement('div', attrs); }}));
jest.mock('../../utils/qrCanvas', () => ({drawQrCode: jest.fn()}));
jest.mock('../../utils/localSubtitleFiles', () => ({openSubtitleFiles: jest.fn(), decodeLocalSubtitle: jest.fn()}));
jest.mock('../../services/localSubtitles', () => ({
	subtitleServiceCall: jest.fn(), localSubtitleRequest: jest.fn(),
	localSubtitleItemKey: (item, source) => JSON.stringify([item.Id, source])
}));

const a = {id: 'file-a', name: 'pack.zip'};
const b = {id: 'file-b', name: 'newer.srt'};
let view, container, session, onLoad, onRequestOpen, archive;
const panelProps = () => ({item: {Id: 'original-movie', Name: 'Original test'}, mediaSourceId: 'source', serverUrl: 'fake', visible: false, onLoad, onRequestOpen, onClose: jest.fn()});
const renderPanel = async extra => {
	view = renderView(<LocalSubtitlePanel {...panelProps()} {...extra} />, {container});
	await act(async () => { await Promise.resolve(); });
};

beforeEach(() => {
	global.IS_REACT_ACT_ENVIRONMENT = true;
	jest.useFakeTimers(); jest.clearAllMocks();
	container = document.createElement('div'); document.body.append(container); view = null;
	session = {baseUrl: 'http://fake', token: 'FAKE', portalUrls: [], files: [a, b], configured: {},
		preference: {enabled: true, selection: {fileId: a.id, entry: 'zh/selected.ass', encoding: 'big5', offsetSeconds: 2.3}}};
	subtitleServiceCall.mockImplementation(() => Promise.resolve(session));
	localSubtitleRequest.mockImplementation((s, route) => Promise.resolve(route === '/api/state' ? session : new ArrayBuffer(1)));
	archive = {entries: ['en/other.srt', 'zh/selected.ass'].map(name => ({name, read: jest.fn().mockResolvedValue(new Uint8Array([1]))})), close: jest.fn()};
	openSubtitleFiles.mockResolvedValue(archive);
	decodeLocalSubtitle.mockReturnValue('1\n00:00:00,000 --> 00:00:05,000\nOriginal test');
	onLoad = jest.fn().mockResolvedValue(); onRequestOpen = jest.fn();
});

afterEach(() => {
	view?.unmount(); container.remove(); jest.useRealTimers();
});

test('restores the preferred cached archive member and encoding with the panel closed', async () => {
	await renderPanel();
	expect(container.childElementCount).toBe(0);
	expect(openSubtitleFiles).toHaveBeenCalledWith(a.name, expect.any(ArrayBuffer));
	expect(decodeLocalSubtitle).toHaveBeenCalledWith(expect.any(Uint8Array), 'big5');
	expect(onLoad).toHaveBeenCalledWith(expect.objectContaining({name: 'zh/selected.ass', restore: true,
		local: expect.objectContaining({fileId: a.id, entry: 'zh/selected.ass', encoding: 'big5'})}));
	await act(async () => { jest.advanceTimersByTime(4000); });
	expect(onLoad).toHaveBeenCalledTimes(1);
	expect(onRequestOpen).not.toHaveBeenCalled();
	expect(archive.close).toHaveBeenCalled();
});

test('remembering None prevents restoration but a newly uploaded file still loads', async () => {
	session.preference.enabled = false;
	await renderPanel(); expect(onLoad).not.toHaveBeenCalled();
	const fresh = {id: 'new-upload', name: 'fresh.srt'};
	session = {...session, files: [...session.files, fresh]};
	archive.entries = [{name: fresh.name, read: jest.fn().mockResolvedValue(new Uint8Array([1]))}];
	await act(async () => { jest.advanceTimersByTime(2000); });
	expect(onLoad).toHaveBeenCalledWith(expect.objectContaining({name: fresh.name, restore: false}));
});

test('an explicit initial server track prevents cached automatic restoration', async () => {
	await renderPanel({allowRestore: false});
	expect(onLoad).not.toHaveBeenCalled();
	expect(openSubtitleFiles).not.toHaveBeenCalled();
});

test('an old movie archive that finishes after leaving cannot replace the new track', async () => {
	let finish;
	openSubtitleFiles.mockReturnValue(new Promise(resolve => { finish = resolve; }));
	await renderPanel();
	view.rerender(null);
	await act(async () => { finish(archive); });
	expect(onLoad).not.toHaveBeenCalled();
	expect(archive.close).toHaveBeenCalled();
});
