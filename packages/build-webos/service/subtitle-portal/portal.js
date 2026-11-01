/* Credentials and the pairing token are never placed in request URLs or logs. */
(() => {
  const $ = id => document.getElementById(id);
  const token = location.hash.slice(1) || sessionStorage.getItem('moonfin-pairing') || '';
  if (location.hash) { sessionStorage.setItem('moonfin-pairing', token); history.replaceState(null, '', location.pathname); }
  const errors = {
    PAIRING_REQUIRED: '配对链接无效，请重新打开电视显示的链接。', SESSION_EXPIRED: '配对已过期，请在电视重新打开字幕面板。',
    ASSRT_KEY_REQUIRED: '请先在下方配置 ASSRT Token。', OPEN_KEY_REQUIRED: '请先在下方配置 OpenSubtitles API Key。',
    PROVIDER_AUTH_FAILED: '字幕源认证失败，请检查密钥或重新登录。', QUOTA_OR_RATE_LIMIT: '字幕源额度已用完或请求过快，请稍后重试。',
    FILE_TOO_LARGE: '文件超过 16 MiB。', UNSUPPORTED_FILE_TYPE: '请选择 SRT、ASS、SSA、VTT、ZIP、RAR 或 7z 文件。',
    SEARCH_RESULT_EXPIRED: '搜索结果已过期，请重新搜索。', OPEN_LOGIN_FIELDS_REQUIRED: '登录需要 API Key、用户名和密码。',
    DOWNLOAD_UNAVAILABLE: '该字幕暂时无法下载。', NETWORK_ERROR: '网络请求失败。', NETWORK_TIMEOUT: '网络请求超时。',
    UNSUPPORTED_DOWNLOAD_HOST: '字幕源返回了暂不支持的下载地址，请从网站下载后导入。'
  };
  const message = text => { $('message').textContent = text; };
  const api = async (route, method = 'GET', data, extra) => {
    const response = await fetch(route, {method, headers: {Authorization: 'Bearer ' + token, ...(data && !(data instanceof File) ? {'Content-Type': 'application/json'} : {}), ...extra}, body: data instanceof File ? data : data ? JSON.stringify(data) : undefined});
    const result = await response.json();
    if (!response.ok) throw new Error(errors[result.error] || '操作失败，请稍后重试。');
    return result;
  };
  let known = '';
  const refresh = async () => {
    const state = await api('/api/state');
    $('title').textContent = state.title;
    if (!$('query').value) $('query').value = state.title;
    $('configured').textContent = 'ASSRT：' + (state.configured.assrt ? '已配置' : '未配置') + '；OpenSubtitles：' + (state.configured.opensubtitles ? '已配置' : '未配置') + (state.configured.openLoggedIn ? '，已登录' : '，未登录');
    const stamp = state.files.map(f => f.id).join(',');
    if (stamp !== known) {
      known = stamp; $('files').replaceChildren();
      for (const f of state.files) {
        const row = document.createElement('div'); row.className = 'result';
        const label = document.createElement('div'); label.textContent = f.name + ' · ' + Math.ceil(f.bytes / 1024) + ' KiB'; row.append(label);
        const del = document.createElement('button'); del.textContent = '删除';
        del.onclick = () => run(async () => { await api('/api/files/' + f.id, 'DELETE'); await refresh(); }); row.append(del); $('files').append(row);
      }
    }
  };
  const run = async fn => { try { await fn(); } catch (e) { message(e.message || '操作失败。'); } };
  const download = async file => {
    message('正在下载到电视…'); await api('/api/download', 'POST', {id: file.id});
    message('已保存到电视。电视字幕面板打开时会自动加载。'); await refresh();
  };
  $('upload').onchange = () => run(async () => {
    const file = $('upload').files[0]; if (!file) return;
    if (file.size > 16 * 1024 * 1024) throw new Error(errors.FILE_TOO_LARGE);
    message('正在发送到电视…'); await api('/api/upload', 'PUT', file, {'X-Subtitle-Name': encodeURIComponent(file.name)});
    $('upload').value = ''; message('已发送。电视字幕面板打开时会自动加载；压缩包请在电视选择字幕文件。'); await refresh();
  });
  $('search').onclick = () => run(async () => {
    $('search').disabled = true; $('results').replaceChildren(); message('正在搜索…');
    try {
      const rows = await api('/api/search', 'POST', {provider: $('provider').value, query: $('query').value, language: $('language').value});
      message(rows.length ? '选择与影片版本相符的字幕。' : '没有找到匹配字幕，可换用中文／英文片名搜索。');
      for (const r of rows) {
        const row = document.createElement('div'); row.className = 'result';
        const name = document.createElement('div'); name.textContent = r.name; const info = document.createElement('small'); info.textContent = r.info;
        const button = document.createElement('button'); button.textContent = '下载到电视';
        button.onclick = () => run(async () => {
          button.disabled = true;
          try { const choices = await api('/api/resolve', 'POST', {id: r.id});
            if (choices.length === 1) await download(choices[0]);
            else { button.remove(); for (const f of choices) { const b = document.createElement('button'); b.textContent = f.name; b.onclick = () => run(() => download(f)); row.append(b); } if (!choices.length) message('此结果没有可下载的字幕文件。'); }
          } finally { button.disabled = false; }
        }); row.append(name, info, document.createElement('br'), button); $('results').append(row);
      }
    } finally { $('search').disabled = false; }
  });
  $('save').onclick = () => run(async () => {
    const data = {}; for (const k of ['assrtToken', 'openApiKey', 'username', 'password']) if ($(k).value) data[k] = $(k).value;
    $('save').disabled = true;
    try { await api('/api/settings', 'POST', data); for (const k of ['assrtToken', 'openApiKey', 'username', 'password']) $(k).value = ''; message('已保存配置。'); await refresh(); } finally { $('password').value = ''; $('save').disabled = false; }
  });
  $('logout').onclick = () => run(async () => { await api('/api/settings', 'POST', {logout: true}); message('已退出 OpenSubtitles 登录。'); await refresh(); });
  $('clear').onclick = () => run(async () => { await api('/api/settings', 'POST', {assrtToken: null, openApiKey: null, logout: true}); message('已清除密钥。'); await refresh(); });
  run(async () => { await refresh(); message('已连接电视，可以导入字幕。'); });
  setInterval(() => run(refresh), 5000);
})();
