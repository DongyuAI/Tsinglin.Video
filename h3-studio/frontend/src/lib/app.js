import { createCanvas, setBackendOptions, setModels } from './comfy-canvas.js';
import { api, fileUrl } from './api.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
};

// 任务状态的中文名
const STATUS_ZH = {
  queued: '排队中', pending: '等待中', running: '运行中',
  completed: '已完成', failed: '失败', cancelled: '已取消',
};
const statusZh = (s) => STATUS_ZH[s] || s;

// surface any client error into the DOM so it is visible (and testable headless)
const errors = [];
function reportError(msg) {
  errors.push(String(msg));
  window.__h3errors = errors;
  document.body.setAttribute('data-h3-error', errors.join(' | ').slice(0, 800));
  const t = document.getElementById('toast');
  if (t) { t.textContent = '错误：' + msg; t.className = 'toast err'; }
}
addEventListener('error', (e) => reportError(e.message || e.error || 'error'));
addEventListener('unhandledrejection', (e) => reportError(e.reason?.message || e.reason || 'rejection'));

const state = {
  templates: [],
  current: null,       // template id
  doc: null,           // original ComfyUI doc
  canvas: null,
  poll: null,
  activeJob: null,
  health: null,
  uploads: [],
};

// ------------------------------------------------------------------ toast
let toastTimer = null;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast hidden'; }, isErr ? 6000 : 3200);
}

// ------------------------------------------------------------------ boot
async function boot() {
  state.canvas = createCanvas($('#graph-canvas'));
  window.__h3 = state;   // handy for debugging / headless checks
  state.canvas.on('select', showInspector);
  state.canvas.on('zoom', (z) => { $('#zoom-label').textContent = Math.round(z * 100) + '%'; });

  wireUI();
  await refreshHealth();
  // Models first: the canvas rebinds every model widget to the file sd.cpp
  // actually loads, so it must know them before the first template is built.
  await loadModels();
  await loadTemplates();
  await refreshUploads();
  await loadTemplate('t2v');
  setInterval(refreshHealth, 8000);
}

function wireUI() {
  $('#btn-run').onclick = runCurrent;
  $('#btn-fit').onclick = () => state.canvas.fit();
  $('#btn-zoom-in').onclick = () => state.canvas.setZoom(state.canvas.zoom() * 1.15, [innerWidth / 2, innerHeight / 2]);
  $('#btn-zoom-out').onclick = () => state.canvas.setZoom(state.canvas.zoom() / 1.15, [innerWidth / 2, innerHeight / 2]);
  $('#btn-sd-toggle').onclick = toggleServer;
  $('#btn-queue').onclick = () => showPanel('queue');
  $('#btn-refresh-jobs').onclick = refreshJobs;
  $('#btn-images').onclick = openImageManager;
  $('#btn-close-preview').onclick = () => $('#preview-panel').classList.add('hidden');
  document.querySelectorAll('.panel-tab').forEach(tab => {
    tab.onclick = () => showPanel(tab.dataset.panel);
  });
  document.querySelectorAll('.rail-btn[data-panel]').forEach(b => {
    b.onclick = () => showPanel(b.dataset.panel);
  });
  $('#modal-close').onclick = closeModal;
  $('#modal-backdrop').onclick = (e) => { if (e.target.id === 'modal-backdrop') closeModal(); };
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); runCurrent(); }
  });
}

function showPanel(name) {
  $('#side-panel').classList.remove('hidden');
  document.querySelectorAll('.panel-tab').forEach(t => t.classList.toggle('active', t.dataset.panel === name));
  document.querySelectorAll('.panel-view').forEach(v => v.classList.toggle('hidden', v.dataset.view !== name));
  document.querySelectorAll('.rail-btn[data-panel]').forEach(b => b.classList.toggle('active', b.dataset.panel === name));
  if (name === 'queue') refreshJobs();
  if (name === 'models') refreshModels();
}

// ------------------------------------------------------------------ health
async function refreshHealth() {
  try {
    const h = await api.health();
    state.health = h;
    const sd = h.sd_server;
    const pill = $('#sd-status');
    pill.className = 'status-pill ' + (sd.running ? 'on' : 'off');
    pill.querySelector('.label').textContent = sd.running
      ? `sd.cpp · ${sd.model?.name || '模型'}`
      : 'sd.cpp 离线';
    $('#btn-sd-toggle').textContent = sd.running ? '停止引擎' : '启动引擎';
    if (sd.running) {
      setBackendOptions({ samplers: sd.samplers, schedulers: sd.schedulers });
      const d = sd.defaults || {};
      $('#sd-detail').innerHTML = '';
      const rows = [
        ['模式', sd.mode], ['模型', sd.model?.name],
        ['视频', `${d.width || '?'}×${d.height || '?'}`],
        ['格式', (sd.output_formats || []).join('、')],
        ['采样器', (sd.samplers || []).length],
      ];
      for (const [k, v] of rows) {
        const row = el('div', 'kv');
        row.append(el('span', 'k', k), el('span', 'v', String(v)));
        $('#sd-detail').append(row);
      }
    }
  } catch (e) {
    $('#sd-status').className = 'status-pill off';
    $('#sd-status .label').textContent = '后端离线';
  }
}

async function toggleServer() {
  const running = state.health?.sd_server?.running;
  try {
    if (running) { await api.sdStop(); toast('正在停止 sd.cpp…'); }
    else { toast('正在加载 MiniMax-H3（可能需要一分钟）…'); await api.sdStart(); toast('sd.cpp 就绪'); }
  } catch (e) { toast('引擎错误：' + e.message, true); }
  await refreshHealth();
}

// --------------------------------------------------------------- templates
async function loadTemplates() {
  const { templates } = await api.templates();
  state.templates = templates;
  const list = $('#tpl-list');
  list.innerHTML = '';
  for (const t of templates) {
    const card = el('div', 'tpl-card' + (t.id === state.current ? ' active' : ''));
    card.dataset.id = t.id;
    card.append(el('div', 'tpl-name', t.label), el('div', 'tpl-mode', t.mode + (t.exists ? '' : ' · 缺失')));
    card.onclick = () => loadTemplate(t.id);
    list.append(card);
  }
}

async function loadTemplate(id) {
  try {
    const doc = await api.template(id);
    state.doc = doc;
    state.current = id;
    document.querySelectorAll('.tpl-card').forEach(c => c.classList.toggle('active', c.dataset.id === id));
    renderDoc(doc);
    const t = state.templates.find(x => x.id === id);
    $('#workflow-name').textContent = t ? t.label : id;
    $('#preview-panel').classList.add('hidden');
    toast(`已加载 ${t?.label || id}`);
  } catch (e) { toast('加载失败：' + e.message, true); }
}

function renderDoc(doc) {
  const c = state.canvas;
  c.clear();
  const nodes = [...(doc.nodes || [])];
  // subgraph definitions let instance nodes show their real name instead of a UUID
  const subgraphs = {};
  for (const sg of doc.definitions?.subgraphs || []) subgraphs[sg.id] = sg;
  // draw notes first so real nodes sit on top
  nodes.sort((a, b) => (a.type === 'MarkdownNote' ? -1 : 0) - (b.type === 'MarkdownNote' ? -1 : 0));
  for (const def of nodes) {
    try { c.add(def, subgraphs); } catch (e) { console.warn('node failed', def.type, e); }
  }
  try { c.connect(doc); } catch (e) { console.warn('links failed', e); }
  requestAnimationFrame(() => c.fit());
}

// ---------------------------------------------------------------- inspector
function showInspector(node) {
  const box = $('#inspector');
  if (!node) { box.innerHTML = '<div class="hint">选择一个节点以查看详情。</div>'; return; }
  box.innerHTML = '';
  const head = el('div', 'section-title', node.title || node._comfy.type);
  box.append(head);
  const kv = (k, v) => {
    const r = el('div', 'kv');
    r.append(el('span', 'k', k), el('span', 'v', String(v)));
    box.append(r);
  };
  kv('类型', node._comfy.type);
  for (const [k, v] of Object.entries(node._comfy.widgets || {})) {
    const s = String(v ?? '');
    kv(k, s.length > 60 ? s.slice(0, 60) + '…' : s);
  }
  if (node._comfy.type === 'LoadImage') {
    const b = el('button', 'btn sm', '选择图像…');
    b.style.marginTop = '10px';
    b.onclick = () => openImagePicker(node);
    box.append(b);
  }
}

// ------------------------------------------------------------------- run
function editedDoc() {
  const doc = JSON.parse(JSON.stringify(state.doc));
  const edits = new Map(state.canvas.collect().map(n => [String(n.comfyId), n.widgets]));
  for (const n of doc.nodes || []) {
    const w = edits.get(String(n.id));
    if (w) n.widgets_values_named = { ...(n.widgets_values_named || {}), ...w };
  }
  return doc;
}

async function runCurrent() {
  if (!state.health?.sd_server?.running) {
    toast('sd.cpp 引擎未运行——正在启动…');
    await toggleServer();
    if (!state.health?.sd_server?.running) return;
  }
  $('#btn-run').disabled = true;
  try {
    const job = await api.run({ graph: editedDoc(), template: state.current });
    state.activeJob = job.id;
    toast(`已排队 ${job.id} · ${job.meta.mode} · ${job.meta.duration_s} 秒`);
    showPanel('queue');
    startPolling(job.id);
  } catch (e) {
    toast('运行失败：' + e.message, true);
  } finally {
    setTimeout(() => { $('#btn-run').disabled = false; }, 600);
  }
}

function startPolling(jobId) {
  clearInterval(state.poll);
  state.poll = setInterval(async () => {
    try {
      const job = await api.job(jobId);
      renderActive(job);
      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        clearInterval(state.poll);
        state.poll = null;
        await refreshJobs();
        if (job.status === 'completed') showPreview(job);
        else toast(`任务${statusZh(job.status)}：${job.error || ''}`, true);
      }
    } catch (e) { /* keep polling */ }
  }, 2000);
  refreshJobs();
}

function renderActive(job) {
  $('#active-job').innerHTML = '';
  const row = el('div', 'job-row');
  const top = el('div', 'jr-top');
  top.append(el('span', 'jr-id', job.id), badge(job.status));
  row.append(top);
  row.append(el('div', 'jr-meta',
    `${job.meta?.mode} · ${job.payload?.width}×${job.payload?.height} · ${job.payload?.video_frames} 帧 · ${Math.round(job.elapsed)} 秒`));
  $('#active-job').append(row);
}

function badge(status) {
  return el('span', 'badge ' + status, statusZh(status));
}

// ------------------------------------------------------------------ queue
async function refreshJobs() {
  try {
    const { jobs } = await api.jobs(30);
    const list = $('#job-list');
    list.innerHTML = '';
    if (!jobs.length) { list.append(el('div', 'hint', '暂无任务。')); return; }
    for (const j of jobs) {
      const row = el('div', 'job-row');
      const top = el('div', 'jr-top');
      top.append(el('span', 'jr-id', j.id), badge(j.status));
      row.append(top);
      row.append(el('div', 'jr-meta',
        `${j.meta?.mode || ''} · ${j.payload?.width || '?'}×${j.payload?.height || '?'} · ${j.payload?.video_frames || '?'} 帧`));
      if (j.error) row.append(el('div', 'jr-meta', j.error));
      if (j.media?.length) {
        const b = el('button', 'btn sm', '查看');
        b.style.marginTop = '6px';
        b.onclick = () => showPreview(j);
        row.append(b);
      }
      list.append(row);
    }
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- preview
function showPreview(job) {
  const panel = $('#preview-panel');
  panel.classList.remove('hidden');
  $('#preview-title').textContent = `输出 · ${job.id}`;
  const body = $('#preview-body');
  body.innerHTML = '';
  const media = job.media || [];
  const video = media.find(m => m.kind === 'video');
  if (video) {
    const v = document.createElement('video');
    v.src = fileUrl(video.url);
    v.controls = true; v.autoplay = true; v.loop = true; v.muted = false;
    body.append(v);
  } else {
    body.append(el('div', 'placeholder', '暂无媒体'));
  }
  $('#preview-meta').textContent =
    `${job.meta?.mode} · ${job.payload?.width}×${job.payload?.height} · ${job.payload?.video_frames} 帧 · `
    + `${job.meta?.duration_s} 秒 · 随机种子 ${job.payload?.seed} · 用时 ${Math.round(job.elapsed)} 秒`;
}

// ------------------------------------------------------------------ models
/** Feed the canvas the sd.cpp model inventory (see MODEL_ROLE_BY_WIDGET). */
async function loadModels() {
  try {
    const m = await api.models();
    setModels(m);
    return m;
  } catch { return null; }
}

async function refreshModels() {
  try {
    const m = await api.models();
    setModels(m);
    const box = $('#models-view');
    box.innerHTML = '';
    for (const [role, label] of Object.entries(m.roles)) {
      box.append(el('div', 'section-title', label));
      const items = m.discovered[role] || [];
      if (!items.length) { box.append(el('div', 'hint', '未找到')); continue; }
      for (const it of items) {
        const row = el('div', 'kv');
        const active = m.picked[role] === it.path;
        row.append(el('span', 'k', (active ? '● ' : '○ ') + it.name),
          el('span', 'v', (it.size / 1e9).toFixed(1) + ' GB'));
        box.append(row);
      }
    }
  } catch (e) { toast('模型：' + e.message, true); }
}

// ----------------------------------------------------------------- images
async function refreshUploads() {
  try { const r = await api.uploads(); state.uploads = r.uploads || []; } catch { state.uploads = []; }
}

async function openImageManager() {
  await refreshUploads();
  const body = $('#modal-body');
  $('#modal-title').textContent = '输入图像';
  body.innerHTML = '';
  const loaders = (state.doc?.nodes || []).filter(n => n.type === 'LoadImage');
  if (!loaders.length) {
    body.append(el('div', 'hint', '此工作流没有“加载图像”节点。'));
  }
  for (const n of loaders) {
    const w = n.widgets_values_named || {};
    const card = el('div', 'field');
    card.append(el('label', null, `节点 #${n.id} · ${w.image || '（未设置）'}`));
    const row = el('div', 'field-row');
    const sel = document.createElement('select');
    sel.append(new Option('— 选择已上传 —', ''));
    for (const u of state.uploads) sel.append(new Option(u.name, u.ref));
    sel.onchange = () => {
      n.widgets_values_named = { ...w, image: sel.value };
      const cnode = (state.canvas.graph._nodes || []).find(x => String(x._comfyId) === String(n.id));
      if (cnode) { const wg = (cnode.widgets || []).find(x => x.name === 'image'); if (wg) wg.value = sel.value; }
      toast(`已设置 ${n.id} → ${sel.value}`);
    };
    const up = document.createElement('input');
    up.type = 'file'; up.accept = 'image/*';
    up.onchange = async () => {
      if (!up.files[0]) return;
      const r = await api.upload(up.files[0]);
      await refreshUploads();
      n.widgets_values_named = { ...w, image: r.ref };
      const cnode = (state.canvas.graph._nodes || []).find(x => String(x._comfyId) === String(n.id));
      if (cnode) { const wg = (cnode.widgets || []).find(x => x.name === 'image'); if (wg) wg.value = r.ref; }
      toast(`已上传 → ${r.ref}`);
      openImageManager();
    };
    row.append(sel, up);
    card.append(row);
    body.append(card);
  }
  openModal();
}

async function openImagePicker(node) {
  await refreshUploads();
  const body = $('#modal-body');
  $('#modal-title').textContent = `节点 #${node._comfyId} 的图像`;
  body.innerHTML = '';
  for (const u of state.uploads) {
    const b = el('button', 'btn', u.name);
    b.style.marginRight = '6px';
    b.onclick = () => {
      const wg = (node.widgets || []).find(x => x.name === 'image');
      if (wg) { wg.value = u.ref; node.onWidgetChanged('image', u.ref); }
      closeModal();
      toast(`已设置 ${u.name}`);
    };
    body.append(b);
  }
  const up = document.createElement('input');
  up.type = 'file'; up.accept = 'image/*';
  up.onchange = async () => {
    if (!up.files[0]) return;
    const r = await api.upload(up.files[0]);
    await refreshUploads();
    const wg = (node.widgets || []).find(x => x.name === 'image');
    if (wg) { wg.value = r.ref; node.onWidgetChanged('image', r.ref); }
    closeModal(); toast('已上传');
  };
  body.append(el('div', 'section-title', '上传'), up);
  openModal();
}

function openModal() { $('#modal-backdrop').classList.remove('hidden'); }
function closeModal() { $('#modal-backdrop').classList.add('hidden'); }

boot();
