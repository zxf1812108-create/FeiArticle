export const PC_DIRECT_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>FeiArtical · 电脑直连</title>
<style>
  :root {
    --text: #2E2D2A;
    --muted: #6E6B64;
    --bg: #F6F4EE;
    --bar: #EFECE5;
    --subtle: #EDEAE1;
    --selected: #E3DFD4;
    --border: #E4E0D6;
    --btn-bg: #2E2D2A;
    --btn-text: #FAF8F4;
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
    padding: 8px 16px; border-radius: 8px; font-size: 12.5px; display: none;
  }
  .inline-input {
    width: 100%; height: 32px; padding: 0 10px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--bg); color: var(--text); outline: none;
  }
  @media (max-width: 720px) {
    .layout { flex-direction: column; }
    .sidebar { width: 100%; max-height: 42vh; border-right: none; border-bottom: 1px solid var(--border); }
    .editor-wrap { padding: 18px; }
  }
</style>
</head>
<body>
<div class="layout">
  <aside class="sidebar">
    <div class="sidebar-header">
      <span class="brand">FeiArtical</span>
      <span class="hint">电脑直连</span>
    </div>
    <div class="sidebar-actions">
      <button id="btnNewFolder" type="button">新建目录</button>
      <button id="btnNewDoc" type="button">新建文章</button>
      <button id="btnImport" type="button">导入文本</button>
      <button id="btnRefresh" type="button">刷新</button>
      <input id="fileInput" type="file" multiple accept=".txt,.md,.markdown,text/plain" style="display:none" />
    </div>
    <div id="newFolderWrap" style="display:none;padding:8px 12px;border-bottom:1px solid var(--border);">
      <input id="newFolderInput" class="inline-input" placeholder="输入目录名称，回车确认" />
    </div>
    <div id="tree" class="tree"></div>
  </aside>
  <main class="main">
    <div class="toolbar">
      <span id="statusText" class="hint">已连接手机端</span>
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
      <div>在左侧选择文档，或直接拖入 .txt / .md 文件导入到手机</div>
      <div class="hint">所有修改会实时同步回手机端</div>
    </div>
  </main>
</div>
<div id="toast" class="toast"></div>
<script>
  let state = { folders: [], docs: [] };
  let activeFolderId = null;
  let activeDocId = null;
  let dirty = false;

  const $ = (id) => document.getElementById(id);

  function showToast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(window.__t);
    window.__t = setTimeout(() => { el.style.display = 'none'; }, 2800);
  }

  async function apiGetState() {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error('读取失败');
    state = await res.json();
    state.folders = Array.isArray(state.folders) ? state.folders : [];
    state.docs = Array.isArray(state.docs) ? state.docs.filter(d => !d.deleted) : [];
    if (!activeFolderId && state.folders.length > 0) {
      const firstRegular = state.folders.find(f => f.id !== '__inbox__');
      activeFolderId = firstRegular ? firstRegular.id : null;
    }
    render();
  }

  async function apiAction(payload) {
    const res = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('同步失败');
    return res.json();
  }

  function render() {
    const tree = $('tree');
    tree.innerHTML = '';
    const folders = [...state.folders]
      .filter(f => f.id !== '__inbox__')
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    const inboxDocs = state.docs
      .filter(d => d.folderId === '__inbox__')
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    if (folders.length === 0 && state.docs.length === 0) {
      const div = document.createElement('div');
      div.className = 'hint';
      div.style.padding = '16px 10px';
      div.textContent = '暂无目录，请先点击上方「新建目录」';
      tree.appendChild(div);
    }

    if (inboxDocs.length > 0) {
      const fRow = document.createElement('div');
      fRow.className = 'folder-row';
      fRow.innerHTML = '<span class="truncate">inbox</span><span class="count"></span>';
      fRow.children[1].textContent = String(inboxDocs.length);
      tree.appendChild(fRow);

      for (const doc of inboxDocs) {
        const dRow = document.createElement('div');
        dRow.className = 'doc-row' + (activeDocId === doc.id ? ' active' : '');
        dRow.innerHTML = '<span class="truncate"></span><span class="count"></span>';
        dRow.children[0].textContent = doc.title || '无标题文档';
        dRow.children[1].textContent = doc.encrypted ? '*' : '';
        dRow.onclick = () => selectDoc(doc.id);
        tree.appendChild(dRow);
      }
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
    if (name.toLowerCase() === 'inbox') {
      showToast('inbox 为云端投递箱保留名称');
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

  async function importFileList(files) {
    if (!activeFolderId && state.folders.length === 0) {
      showToast('请先新建一个目标目录');
      return;
    }
    const folderId = activeFolderId || state.folders[0].id;
    const items = [];
    for (const file of Array.from(files)) {
      if (!/\\.(txt|md|markdown|text)$/i.test(file.name) && !file.type.startsWith('text/')) continue;
      const content = await file.text();
      const title = file.name.replace(/\\.(txt|md|markdown|text)$/i, '').trim() || '导入文档';
      items.push({ title, content, folderId, format: 'txt' });
    }
    if (items.length === 0) return;
    await apiAction({ type: 'importDocs', items });
    showToast('已导入 ' + items.length + ' 篇文档至手机');
    setTimeout(() => apiGetState().catch(() => {}), 300);
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
