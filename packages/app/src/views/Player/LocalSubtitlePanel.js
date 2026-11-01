import {useState, useEffect, useRef, useCallback} from 'react';
import {drawQrCode} from '../../utils/qrCanvas';
import Spottable from '@enact/spotlight/Spottable';
import Spotlight from '@enact/spotlight';
import SpottableInput from '../../components/SpottableInput/SpottableInput';
import {ModalContainer} from '../../utils/spotlightContainers';
import {isBackKey} from '../../utils/keys';
import {subtitleServiceCall, localSubtitleRequest, localSubtitleItemKey} from '../../services/localSubtitles';
import {openSubtitleFiles, decodeLocalSubtitle} from '../../utils/localSubtitleFiles';
import css from './LocalSubtitlePanel.module.less';

const Button = Spottable('button');
const LocalSubtitlePanel = ({item, mediaSourceId, serverUrl, visible, onRequestOpen, onLoad, onClose}) => {
	const [session, setSession] = useState(null);
	const [state, setState] = useState(null);
	const [provider, setProvider] = useState('assrt');
	const [query, setQuery] = useState(item?.Type === 'Episode' ? item.SeriesName || item.Name || '' : item?.Name || '');
	const [message, setMessage] = useState('正在启动电视字幕服务…');
	const [busy, setBusy] = useState(false);
	const [results, setResults] = useState([]);
	const [choices, setChoices] = useState([]);
	const [encoding, setEncoding] = useState('auto');
	const archiveRef = useRef(null);
	const loadingRef = useRef(false);
	const knownRef = useRef(new Set());
	const alive = useRef(true);
	const entriesRef = useRef([]);
	const qrRef = useRef(null);
	const requestedRef = useRef(new Set());
	const itemKey = localSubtitleItemKey(item, mediaSourceId, serverUrl);
	const title = item?.Name || '字幕导入';
	useEffect(() => { if (visible && session?.portalUrls?.[0]) drawQrCode(qrRef.current, session.portalUrls[0]); }, [session, visible]);

	const generation = useRef(0);

	useEffect(() => {
		alive.current = true;
		let active = true;
		setChoices([]); setResults([]); setSession(null); setState(null);
		const start = () => subtitleServiceCall('subtitlesStart', {itemKey, title});
		start().then(s => {
			if (!active) return;
			knownRef.current = new Set(s.files.map(f => f.id));
			setSession(s); setState(s); setMessage('手机／Mac 打开固定地址，首次在电视允许配对，以后自动连接当前影片。');
		}).catch(() => { if (active) setMessage('无法启动字幕服务，请确认安装了完整的 webOS 修复版。'); });
		const heartbeat = setInterval(() => { start().then(s => { if (active) setSession(s); }).catch(() => {}); }, 5 * 60 * 1000);
		return () => {
			active = false; alive.current = false;
			clearInterval(heartbeat);
			subtitleServiceCall('subtitlesStop', {itemKey}).catch(() => {});
			generation.current++; // eslint-disable-line react-hooks/exhaustive-deps
			archiveRef.current?.close();
		};
	}, [itemKey, title]);

	const applyEntry = useCallback(async entry => {
		const text = decodeLocalSubtitle(await entry.read(), encoding);
		if (!alive.current) return;
		await onLoad({name: entry.name, text, format: /\.(ass|ssa)$/i.test(entry.name) ? 'ass' : 'text'});
		archiveRef.current?.close(); archiveRef.current = null; entriesRef.current = [];
	}, [encoding, onLoad]);

	const applyFile = useCallback(async file => {
		if (!session || loadingRef.current) return;
		loadingRef.current = true; setBusy(true); setMessage('正在读取字幕…');
		const current = ++generation.current;
		try {
			knownRef.current.add(file.id);
			const bytes = await localSubtitleRequest(session, '/api/files/' + file.id, 'GET', null, true);
			const archive = await openSubtitleFiles(file.name, bytes);
			if (!alive.current || current !== generation.current) { archive.close(); return; }
			archiveRef.current?.close(); archiveRef.current = archive; entriesRef.current = archive.entries;
			if (archive.entries.length === 1) await applyEntry(archive.entries[0]);
			else { setChoices(archive.entries.map((e, i) => ({id: 'entry-' + i, name: e.name, entry: i}))); setMessage('请选择压缩包中的字幕。'); onRequestOpen(); }
		} catch (e) { if (alive.current) { setMessage(e.message || '读取字幕失败。'); onRequestOpen(); } }
		finally { loadingRef.current = false; if (alive.current) setBusy(false); }
	}, [session, applyEntry, onRequestOpen]);

	useEffect(() => {
		if (!session) return;
		let active = true;
		const poll = async () => {
			try {
				const next = await localSubtitleRequest(session, '/api/state');
				if (!active) return;
				setState(next);
				const pairing = next.pairingRequests?.find(p => !requestedRef.current.has(p.id));
				if (pairing) { requestedRef.current.add(pairing.id); onRequestOpen(); }
				const fresh = next.files.find(f => !knownRef.current.has(f.id));
				if (fresh && !loadingRef.current) await applyFile(fresh);
			} catch (e) { if (active) setMessage(e.message || '连接已断开，请重新打开面板。'); }
		};
		const timer = setInterval(poll, 2000);
		return () => { active = false; clearInterval(timer); };
	}, [session, applyFile, onRequestOpen]);

	useEffect(() => { if (visible) Spotlight.focus('local-subtitles-close'); }, [visible]);
	const answerPairing = useCallback(async e => {
		setBusy(true);
		try { await subtitleServiceCall('subtitlesPair', {id: e.currentTarget.dataset.id, allow: e.currentTarget.dataset.allow === 'yes'}); setState(await localSubtitleRequest(session, '/api/state')); }
		catch { setMessage('配对请求已过期，请在浏览器重新连接。'); }
		finally { setBusy(false); }
	}, [session]);
	const forgetDevices = useCallback(async () => {
		try { await subtitleServiceCall('subtitlesPair', {forgetAll: true}); setState(await localSubtitleRequest(session, '/api/state')); setMessage('已清除浏览器配对。下次连接需要重新在电视允许。'); }
		catch { setMessage('清除配对失败，请重试。'); }
	}, [session]);
	const search = useCallback(async () => {
		if (!session) return;
		setBusy(true); setResults([]); setChoices([]); setMessage('正在搜索字幕…');
		try {
			const rows = await localSubtitleRequest(session, '/api/search', 'POST', {provider, query, language: 'zh-cn,zh-tw,en',
				imdbId: item?.Type === 'Episode' ? undefined : item?.ProviderIds?.Imdb, season: item?.ParentIndexNumber, episode: item?.Type === 'Episode' ? item.IndexNumber : undefined});
			if (alive.current) { setResults(rows); setMessage(rows.length ? '请选择与影片版本相符的字幕。' : '没有结果，请尝试另一种片名或字幕源。'); }
		} catch (e) { if (alive.current) setMessage(e.message); }
		finally { if (alive.current) setBusy(false); }
	}, [session, provider, query, item]);
	const download = useCallback(async file => {
		setBusy(true); loadingRef.current = true; setMessage('正在下载到电视…');
		try {
			const cached = await localSubtitleRequest(session, '/api/download', 'POST', {id: file.id});
			knownRef.current.add(cached.id); loadingRef.current = false; await applyFile(cached);
		} catch (e) { if (alive.current) setMessage(e.message); }
		finally { loadingRef.current = false; if (alive.current) setBusy(false); }
	}, [session, applyFile]);
	const choose = useCallback(async result => {
		setBusy(true); setMessage('正在获取字幕文件…');
		try {
			const files = await localSubtitleRequest(session, '/api/resolve', 'POST', {id: result.id});
			if (!alive.current) return;
			if (files.length === 1) await download(files[0]);
			else { setChoices(files); setMessage(files.length ? '请选择需要的字幕文件。' : '此结果没有可下载文件。'); }
		} catch (e) { if (alive.current) setMessage(e.message); }
		finally { if (alive.current) setBusy(false); }
	}, [session, download]);
	const scanUsb = useCallback(async () => {
		if (!session) return;
		setBusy(true); setMessage('正在查找 USB 字幕…');
		try { const files = await localSubtitleRequest(session, '/api/usb'); setChoices(files.map(f => ({...f, usb: true}))); setMessage(files.length ? '请选择 USB 中的字幕。' : '未找到 USB 字幕。也可用手机／Mac 发送。'); }
		catch (e) { setMessage(e.message); } finally { setBusy(false); }
	}, [session]);
	const importUsb = useCallback(async file => {
		setBusy(true); loadingRef.current = true;
		try { const cached = await localSubtitleRequest(session, '/api/usb/import', 'POST', {id: file.id}); knownRef.current.add(cached.id); loadingRef.current = false; await applyFile(cached); }
		catch (e) { setMessage(e.message); } finally { loadingRef.current = false; setBusy(false); }
	}, [session, applyFile]);
	const cycleProvider = useCallback(() => setProvider(previous => previous === 'assrt' ? 'opensubtitles' : 'assrt'), []);
	const cycleEncoding = useCallback(() => { const all = ['auto', 'utf-8', 'gb18030', 'big5', 'utf-16le']; setEncoding(previous => all[(all.indexOf(previous) + 1) % all.length]); }, []);
	const changeQuery = useCallback(e => setQuery(e.target.value), []);
	const clickResult = useCallback(e => { const result = results.find(r => r.id === e.currentTarget.dataset.id); if (result) choose(result); }, [results, choose]);
	const clickCached = useCallback(e => { const file = state.files.find(f => f.id === e.currentTarget.dataset.id); if (file) applyFile(file); }, [state, applyFile]);
	const clickChoice = useCallback(e => {
		const c = choices.find(f => f.id === e.currentTarget.dataset.id);
		if (!c) return;
		if (c.usb) importUsb(c);
		else if (c.entry !== undefined) applyEntry(entriesRef.current[c.entry]).catch(error => setMessage(error.message));
		else download(c);
	}, [choices, importUsb, applyEntry, download]);
	const onPanelKeyDown = useCallback(e => { if (isBackKey(e)) { e.preventDefault(); e.stopPropagation(); onClose(); } }, [onClose]);
	if (!visible) return null;
	return (
		<div className={css.backdrop} onKeyDown={onPanelKeyDown}>
			<ModalContainer className={css.panel} spotlightId="localSubtitles-modal" data-modal="localSubtitles">
				<h2 className={css.title}>电视字幕：ASSRT / OpenSubtitles / 本地导入</h2>
				<div className={css.row}>
					<Button className={css.button} spotlightId="local-subtitles-close" onClick={onClose}>返回影片</Button>
					<Button className={css.button} onClick={cycleProvider}>来源：{provider === 'assrt' ? 'ASSRT' : 'OpenSubtitles'}</Button>
					<Button className={css.button} onClick={cycleEncoding}>编码：{encoding}</Button>
				</div>
				<p className={css.info}>{message}</p>
				{session && <div><canvas className={css.qr} ref={qrRef} role="img" aria-label="扫码打开固定字幕地址" /><p className={css.info}>用同一 Wi-Fi 的手机／Mac 打开固定地址，无需复制 token。首次在电视允许浏览器配对，以后 30 天内自动连接当前影片。</p><p className={css.url}>{session.portalUrls[0] || '未找到局域网地址，请检查电视网络。'}</p><p className={css.info}>影片播放或暂停时均可上传，关闭此面板后仍会自动加载。切换影片时网页同步更新。</p></div>}
				{state?.pairingRequests?.map(p => <div key={p.id}><h3>允许浏览器连接？</h3><p className={css.info}>{p.name} 请求上传字幕及配置字幕源。</p><Button className={css.button} disabled={busy} data-id={p.id} data-allow="yes" onClick={answerPairing}>允许并记住此浏览器</Button><Button className={css.button} disabled={busy} data-id={p.id} data-allow="no" onClick={answerPairing}>拒绝</Button></div>)}
				<div className={css.row}>
					<SpottableInput className={css.input} value={query} onChange={changeQuery} placeholder="中文或英文片名" spotlightId="local-subtitle-query" />
					<Button className={css.button} disabled={busy || !session} onClick={search}>搜索字幕</Button>
					<Button className={css.button} disabled={busy || !session} onClick={scanUsb}>从 USB 导入</Button>
				</div>
				{state && <p className={css.info}>ASSRT：{state.configured.assrt ? '已配置' : '需要 Token'} OpenSubtitles：{state.configured.opensubtitles ? '已配置' : '需要 API Key'}</p>}
				<div className={css.list}>
					{choices.map(c => <Button className={`${css.button} ${css.entry}`} key={c.id} disabled={busy} data-id={c.id} onClick={clickChoice}>{c.name}</Button>)}
					{results.map(r => <Button className={`${css.button} ${css.entry}`} key={r.id} disabled={busy} data-id={r.id} onClick={clickResult}>{r.name}<br /><small>{r.info}</small></Button>)}
				</div>
				{!!state?.files?.length && <div><h3>已保存在电视的字幕</h3><div className={css.list}>{state.files.map(f => <Button key={f.id} className={`${css.button} ${css.entry}`} disabled={busy} data-id={f.id} onClick={clickCached}>{f.name}</Button>)}</div></div>}
				{!!state?.pairedDevices && <Button className={css.button} onClick={forgetDevices}>清除已配对浏览器（{state.pairedDevices}）</Button>}
			</ModalContainer>
		</div>
	);
};
export default LocalSubtitlePanel;
