export const PC_DIRECT_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>FeiArtical · 电脑直连</title>
<style>
  :root {
    --text: #000000;
    --muted: #595959;
    --bg: #FFFFFF;
    --bar: #FFFFFF;
    --subtle: #F7F7F7;
    --selected: #EFEFEF;
    --border: #C4C4C4;
    --btn-bg: #000000;
    --btn-text: #FFFFFF;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --text: #C8C8C8;
      --muted: #787878;
      --bg: #1A1A1A;
      --bar: #1F1F1F;
      --subtle: #232323;
      --selected: #262626;
      --border: #2A2A2A;
      --btn-bg: #C8C8C8;
      --btn-text: #1A1A1A;
    }
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; height: 100%; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", sans-serif;
    font-size: 14px;
  }
  .layout { display: flex; height: 100%; overflow: hidden; }
  .sidebar {
    width: 280px; min-width: 220px; border-right: 1px solid var(--border);
    background: var(--bar); display: flex; flex-direction: column;
  }
  .sidebar-header {
    padding: 14px 16px; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  .brand { font-size: 15px; font-weight: 600; color: var(--text); }
  .hint { font-size: 12px; color: var(--muted); }
  .sidebar-actions {
    padding: 10px 12px; border-bottom: 1px solid var(--border);
    display: flex; gap: 6px; flex-wrap: wrap;
  }
  .tree { flex: 1; overflow-y: auto; padding: 10px 8px; }
  .folder-row, .doc-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 7px 10px; border-radius: 8px; cursor: pointer; gap: 8px;
    color: var(--text); user-select: none;
  }
  .folder-row { font-weight: 500; margin-top: 4px; }
  .doc-row { padding-left: 24px; }
  .folder-row:hover, .doc-row:hover { background: var(--subtle); }
  .active { background: var(--selected) !important; }
  .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .count { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .main { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--bg); }
  .toolbar {
    padding: 12px 24px; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
  }
  .toolbar-group { display: flex; align-items: center; gap: 8px; }
  button {
    border: 1px solid var(--border); background: var(--subtle); color: var(--text);
    height: 32px; padding: 0 12px; border-radius: 8px; cursor: pointer; font-size: 13px;
  }
  button:hover { background: var(--selected); }
  button.primary {
    border: none; background: var(--btn-bg); color: var(--btn-text); font-weight: 500;
  }
  button.primary:hover { opacity: 0.9; }
  button:disabled { opacity: 0.4; cursor: default; }
  .editor-wrap {
    flex: 1; overflow-y: auto; padding: 28px 32px; max-width: 820px; width: 100%; margin: 0 auto;
    display: flex; flex-direction: column; gap: 16px;
  }
  .title-input {
    width: 100%; border: none; outline: none; background: transparent;
    color: var(--text); font-size: 22px; font-weight: 600;
  }
  .body-input {
    flex: 1; width: 100%; min-height: 420px; border: none; outline: none; resize: none;
    background: transparent; color: var(--text); font-size: 15.5px; line-height: 1.85;
    font-family: inherit;
  }
  .title-input::placeholder, .body-input::placeholder { color: var(--muted); }
  .empty {
    flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 10px; color: var(--muted); padding: 24px; text-align: center;
  }
  .toast {
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: var(--btn-bg); color: var(--btn-text);
    padding: 8px 16px; border-radius: 8px; font-size: 12.5px; display: none; z-index: 90;
  }
  .inline-input {
    width: 100%; height: 34px; padding: 0 10px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--bg); color: var(--text); outline: none;
  }
  .auth-overlay {
    position: fixed; inset: 0; background: var(--bg); z-index: 80;
    display: none; align-items: center; justify-content: center; padding: 20px;
  }
  .auth-card {
    width: 100%; max-width: 340px; border: 1px solid var(--border); border-radius: 14px;
    padding: 20px; background: var(--bar); display: flex; flex-direction: column; gap: 12px;
  }
  .auth-title { font-size: 16px; font-weight: 600; }
  .auth-error { font-size: 12px; color: var(--muted); min-height: 16px; }
  @media (max-width: 720px) {
    .layout { flex-direction: column; }
    .sidebar { width: 100%; max-height: 42vh; border-right: none; border-bottom: 1px solid var(--border); }
    .editor-wrap { padding: 18px; }
  }
</style>
</head>
<body>
<div id="authOverlay" class="auth-overlay">
  <form id="authForm" class="auth-card">
    <div class="auth-title">FeiArtical · 安全验证</div>
    <div class="hint">请输入软件中设置的「加密密码」以连接手机端（采用 HMAC-SHA256 校验，密码不会明文传输）</div>
    <input id="authPassword" type="password" class="inline-input" placeholder="输入加密密码" autocomplete="current-password" />
    <div id="authError" class="auth-error"></div>
    <button id="btnAuthSubmit" type="submit" class="primary" style="height:36px;">验证并连接</button>
  </form>
</div>
<div class="layout">
  <aside class="sidebar">
    <div class="sidebar-header">
      <span class="brand">FeiArtical</span>
      <span class="hint">电脑直连</span>
    </div>
    <div class="sidebar-actions">
      <button id="btnNewFolder" type="button">新建目录</button>
      <button id="btnNewDoc" type="button">新建文章</button>
      <button id="btnImport" type="button">传书/文档</button>
      <button id="btnRefresh" type="button">刷新</button>
      <input id="fileInput" type="file" multiple accept=".txt,.md,.markdown,.epub,.mobi,.azw3,.kf8,.fb2,text/plain" style="display:none" />
    </div>
    <div id="newFolderWrap" style="display:none;padding:8px 12px;border-bottom:1px solid var(--border);">
      <input id="newFolderInput" class="inline-input" placeholder="输入目录名称，回车确认" />
    </div>
    <div id="tree" class="tree"></div>
  </aside>
  <main class="main">
    <div class="toolbar">
      <span id="statusText" class="hint">正在连接手机端…</span>
      <div class="toolbar-group">
        <button id="btnDownload" type="button" disabled>导出 .txt</button>
        <button id="btnDelete" type="button" disabled>删除</button>
        <button id="btnSave" type="button" class="primary" disabled>保存到手机</button>
      </div>
    </div>
    <div id="editorWrap" class="editor-wrap" style="display:none;">
      <input id="docTitle" class="title-input" placeholder="标题" />
      <textarea id="docContent" class="body-input" placeholder="开始输入正文…"></textarea>
    </div>
    <div id="emptyState" class="empty">
      <div>在左侧选择文档，或直接拖入 .txt / .md / .epub / .mobi 电子书传到手机</div>
      <div class="hint">带插图的电子书会自动在手机端提取插图并保存至本地 images/ 目录</div>
    </div>
  </main>
</div>
<div id="toast" class="toast"></div>
<script>
  let state = { folders: [], docs: [] };
  let activeFolderId = null;
  let activeDocId = null;
  let dirty = false;
  let authToken = sessionStorage.getItem('fei_lan_token') || '';

  const $ = (id) => document.getElementById(id);

  // Pure-JS SHA-256 & HMAC-SHA256 so Challenge-Response works on plain http://192.168.x.x without crypto.subtle
  function utf8Bytes(str) {
    return new TextEncoder().encode(str);
  }
  function sha256Bytes(msgBytes) {
    const K = [
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ];
    const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    const len = msgBytes.length;
    const bitLen = len * 8;
    const paddedLen = Math.ceil((len + 9) / 64) * 64;
    const buf = new Uint8Array(paddedLen);
    buf.set(msgBytes);
    buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
    dv.setUint32(paddedLen - 4, bitLen >>> 0, false);
    const W = new Uint32Array(64);
    for (let offset = 0; offset < paddedLen; offset += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(offset + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const s0 = ((W[i-15] >>> 7) | (W[i-15] << 25)) ^ ((W[i-15] >>> 18) | (W[i-15] << 14)) ^ (W[i-15] >>> 3);
        const s1 = ((W[i-2] >>> 17) | (W[i-2] << 15)) ^ ((W[i-2] >>> 19) | (W[i-2] << 13)) ^ (W[i-2] >>> 10);
        W[i] = (W[i-16] + s0 + W[i-7] + s1) >>> 0;
      }
      let [a,b,c,d,e,f,g,h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0]=(H[0]+a)>>>0; H[1]=(H[1]+b)>>>0; H[2]=(H[2]+c)>>>0; H[3]=(H[3]+d)>>>0;
      H[4]=(H[4]+e)>>>0; H[5]=(H[5]+f)>>>0; H[6]=(H[6]+g)>>>0; H[7]=(H[7]+h)>>>0;
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i], false);
    return out;
  }
  function hmacSha256Hex(keyBytes, msgStr) {
    const blockSize = 64;
    const key = keyBytes.length > blockSize ? sha256Bytes(keyBytes) : keyBytes;
    const oPad = new Uint8Array(blockSize).fill(0x5c);
    const iPad = new Uint8Array(blockSize).fill(0x36);
    for (let i = 0; i < key.length; i++) { oPad[i] ^= key[i]; iPad[i] ^= key[i]; }
    const msg = utf8Bytes(msgStr);
    const innerInput = new Uint8Array(blockSize + msg.length);
    innerInput.set(iPad); innerInput.set(msg, blockSize);
    const innerHash = sha256Bytes(innerInput);
    const outerInput = new Uint8Array(blockSize + 32);
    outerInput.set(oPad); outerInput.set(innerHash, blockSize);
    const finalHash = sha256Bytes(outerInput);
    return Array.from(finalHash).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function showToast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(window.__t);
    window.__t = setTimeout(() => { el.style.display = 'none'; }, 3000);
  }

  function showAuthGate(errText) {
    $('authOverlay').style.display = 'flex';
    $('authError').textContent = errText || '';
    setTimeout(() => $('authPassword').focus(), 50);
  }

  function hideAuthGate() {
    $('authOverlay').style.display = 'none';
    $('authError').textContent = '';
  }

  function authHeaders(extra) {
    const h = Object.assign({}, extra || {});
    if (authToken) h['X-Lan-Token'] = authToken;
    return h;
  }

  async function apiGetState() {
    const res = await fetch('/api/state', { cache: 'no-store', headers: authHeaders() });
    if (res.status === 401) {
      authToken = '';
      sessionStorage.removeItem('fei_lan_token');
      showAuthGate('');
      return;
    }
    if (!res.ok) throw new Error('读取失败');
    hideAuthGate();
    state = await res.json();
    state.folders = Array.isArray(state.folders) ? state.folders : [];
    state.docs = Array.isArray(state.docs) ? state.docs.filter(d => !d.deleted) : [];
    if (!activeFolderId && state.folders.length > 0) {
      const firstRegular = state.folders.find(f => f.id !== '__inbox__');
      activeFolderId = firstRegular ? firstRegular.id : null;
    }
    $('statusText').textContent = '已连接手机端';
    render();
  }

  async function apiAction(payload) {
    const res = await fetch('/api/action', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (res.status === 401) {
      authToken = '';
      sessionStorage.removeItem('fei_lan_token');
      showAuthGate('登录已过期，请重新输入加密密码');
      throw new Error('需要验证加密密码');
    }
    if (!res.ok) throw new Error('同步失败');
    return res.json();
  }

  $('authForm').onsubmit = async (e) => {
    e.preventDefault();
    const pwd = $('authPassword').value;
    if (!pwd) {
      $('authError').textContent = '请输入加密密码';
      return;
    }
    $('btnAuthSubmit').disabled = true;
    $('authError').textContent = '正在核验…';
    try {
      const chRes = await fetch('/api/auth/challenge', { cache: 'no-store' });
      const chData = await chRes.json().catch(() => ({}));
      if (!chRes.ok) {
        $('authError').textContent = chData.error || '获取校验码失败';
        return;
      }
      if (!chData.required) {
        authToken = 'open';
        hideAuthGate();
        await apiGetState();
        return;
      }
      const authKey = sha256Bytes(utf8Bytes('fei-lan-auth-v1:' + pwd));
      const proof = hmacSha256Hex(authKey, 'pc:' + chData.nonce);
      const loginRes = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: chData.nonce, proof }),
      });
      const loginData = await loginRes.json().catch(() => ({}));
      if (!loginRes.ok || !loginData.ok) {
        $('authError').textContent = loginData.error || '加密密码错误';
        return;
      }
      authToken = loginData.token || '';
      sessionStorage.setItem('fei_lan_token', authToken);
      $('authPassword').value = '';
      hideAuthGate();
      await apiGetState();
    } catch {
      $('authError').textContent = '连接失败，请确认手机端电脑直连已开启';
    } finally {
      $('btnAuthSubmit').disabled = false;
    }
  };

  function render() {
    const tree = $('tree');
    tree.innerHTML = '';
    const folders = [...state.folders]
      .filter(f => f.id !== '__inbox__')
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    if (folders.length === 0 && state.docs.length === 0) {
      const div = document.createElement('div');
      div.className = 'hint';
      div.style.padding = '16px 10px';
      div.textContent = '暂无目录，请先点击上方「新建目录」';
      tree.appendChild(div);
    }

    for (const folder of folders) {
      const fDocs = state.docs
        .filter(d => d.folderId === folder.id)
        .sort((a, b) => (a.order || 0) - (b.order || 0));

      const fRow = document.createElement('div');
      fRow.className = 'folder-row' + (activeFolderId === folder.id && !activeDocId ? ' active' : '');
      fRow.innerHTML = '<span class="truncate"></span><span class="count"></span>';
      fRow.children[0].textContent = folder.name;
      fRow.children[1].textContent = String(fDocs.length);
      fRow.onclick = () => {
        activeFolderId = folder.id;
        render();
      };
      tree.appendChild(fRow);

      for (const doc of fDocs) {
        const dRow = document.createElement('div');
        dRow.className = 'doc-row' + (activeDocId === doc.id ? ' active' : '');
        dRow.innerHTML = '<span class="truncate"></span><span class="count"></span>';
        dRow.children[0].textContent = doc.title || '无标题文档';
        dRow.children[1].textContent = doc.encrypted ? '*' : '';
        dRow.onclick = () => selectDoc(doc.id);
        tree.appendChild(dRow);
      }
    }

    const orphans = state.docs.filter(d => !d.folderId);
    if (orphans.length > 0) {
      for (const doc of orphans) {
        const dRow = document.createElement('div');
        dRow.className = 'doc-row' + (activeDocId === doc.id ? ' active' : '');
        dRow.style.paddingLeft = '12px';
        dRow.innerHTML = '<span class="truncate"></span><span class="count"></span>';
        dRow.children[0].textContent = doc.title || '无标题文档';
        dRow.children[1].textContent = doc.encrypted ? '*' : '';
        dRow.onclick = () => selectDoc(doc.id);
        tree.appendChild(dRow);
      }
    }

    const current = state.docs.find(d => d.id === activeDocId);
    if (current) {
      $('emptyState').style.display = 'none';
      $('editorWrap').style.display = 'flex';
      if (!dirty) {
        $('docTitle').value = current.title || '';
        $('docContent').value = current.content || '';
      }
      $('btnSave').disabled = false;
      $('btnDownload').disabled = false;
      $('btnDelete').disabled = false;
    } else {
      $('emptyState').style.display = 'flex';
      $('editorWrap').style.display = 'none';
      $('btnSave').disabled = true;
      $('btnDownload').disabled = true;
      $('btnDelete').disabled = true;
    }
  }

  function selectDoc(id) {
    activeDocId = id;
    const doc = state.docs.find(d => d.id === id);
    if (doc && doc.folderId && doc.folderId !== '__inbox__') activeFolderId = doc.folderId;
    dirty = false;
    render();
  }

  $('docTitle').oninput = () => { dirty = true; $('statusText').textContent = '有未保存更改'; };
  $('docContent').oninput = () => { dirty = true; $('statusText').textContent = '有未保存更改'; };

  $('btnSave').onclick = async () => {
    if (!activeDocId) return;
    const title = $('docTitle').value.trim() || '无标题文档';
    const content = $('docContent').value;
    await apiAction({ type: 'saveDoc', docId: activeDocId, title, content });
    const target = state.docs.find(d => d.id === activeDocId);
    if (target) { target.title = title; target.content = content; }
    dirty = false;
    $('statusText').textContent = '已同步到手机';
    render();
    showToast('已保存到手机');
  };

  $('btnNewFolder').onclick = () => {
    const wrap = $('newFolderWrap');
    wrap.style.display = wrap.style.display === 'none' ? 'block' : 'none';
    if (wrap.style.display === 'block') $('newFolderInput').focus();
  };

  $('newFolderInput').onkeydown = async (e) => {
    if (e.key === 'Escape') { $('newFolderWrap').style.display = 'none'; return; }
    if (e.key !== 'Enter') return;
    const name = $('newFolderInput').value.trim();
    if (!name) return;
    if (name.toLowerCase() === 'images' || name.toLowerCase() === 'assets') {
      showToast('images/assets 为图片保留目录名');
      return;
    }
    const id = 'folder_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    await apiAction({ type: 'createFolder', id, name });
    state.folders.push({ id, name, parentId: null, order: state.folders.length, updatedAt: Date.now() });
    activeFolderId = id;
    $('newFolderInput').value = '';
    $('newFolderWrap').style.display = 'none';
    render();
    showToast('已新建目录「' + name + '」');
  };

  $('btnNewDoc').onclick = async () => {
    if (!activeFolderId && state.folders.length === 0) {
      showToast('请先新建一个目录');
      return;
    }
    const folderId = activeFolderId || state.folders[0].id;
    const id = 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    await apiAction({ type: 'createDoc', id, folderId, title: '无标题文档', content: '' });
    state.docs.push({ id, folderId, title: '无标题文档', content: '', order: state.docs.length, updatedAt: Date.now() });
    selectDoc(id);
    showToast('已新建文章');
  };

  $('btnDelete').onclick = async () => {
    if (!activeDocId) return;
    await apiAction({ type: 'deleteDoc', docId: activeDocId });
    state.docs = state.docs.filter(d => d.id !== activeDocId);
    activeDocId = null;
    dirty = false;
    render();
    showToast('已删除文档');
  };

  $('btnDownload').onclick = () => {
    const doc = state.docs.find(d => d.id === activeDocId);
    if (!doc) return;
    const blob = new Blob([$('docContent').value], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (doc.title || '文档') + '.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    return btoa(binary);
  }

  async function importFileList(files) {
    if (!activeFolderId && state.folders.length === 0) {
      showToast('请先新建一个目标目录');
      return;
    }
    const folderId = activeFolderId || state.folders[0].id;
    const textItems = [];
    let ebookCount = 0;
    for (const file of Array.from(files)) {
      if (/\\.(epub|mobi|azw3|kf8|fb2)$/i.test(file.name)) {
        showToast('正在上传电子书「' + file.name + '」…');
        const buf = await file.arrayBuffer();
        await apiAction({
          type: 'importEbook',
          fileName: file.name,
          base64: arrayBufferToBase64(buf),
          folderId,
        });
        ebookCount++;
      } else if (/\\.(txt|md|markdown|text)$/i.test(file.name) || file.type.startsWith('text/')) {
        const content = await file.text();
        const title = file.name.replace(/\\.(txt|md|markdown|text)$/i, '').trim() || '导入文档';
        textItems.push({ title, content, folderId, format: 'txt' });
      }
    }
    if (textItems.length > 0) {
      await apiAction({ type: 'importDocs', items: textItems });
    }
    const total = textItems.length + ebookCount;
    if (total > 0) {
      showToast('已传输 ' + total + ' 个文件至手机' + (ebookCount > 0 ? '（电子书正在手机端解析插图）' : ''));
      setTimeout(() => apiGetState().catch(() => {}), ebookCount > 0 ? 1800 : 400);
    }
  }

  $('btnImport').onclick = () => $('fileInput').click();
  $('fileInput').onchange = (e) => {
    if (e.target.files && e.target.files.length > 0) importFileList(e.target.files);
    e.target.value = '';
  };

  document.body.ondragover = (e) => { e.preventDefault(); };
  document.body.ondrop = (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      e.preventDefault();
      importFileList(e.dataTransfer.files);
    }
  };

  $('btnRefresh').onclick = () => apiGetState().then(() => showToast('已刷新')).catch(() => showToast('连接已断开'));

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (activeDocId) $('btnSave').click();
    }
  });

  apiGetState().catch(() => {
    $('statusText').textContent = '无法连接手机端，请确认手机端电脑直连已开启';
  });
</script>
</body>
</html>`;
