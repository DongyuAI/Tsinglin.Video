const BASE = '/api';

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.error || data.detail || `HTTP ${res.status}`);
  return data;
}

export const api = {
  health: () => req('/health'),
  models: () => req('/models'),
  sdStatus: () => req('/sdserver/status'),
  sdStart: (body = {}) => req('/sdserver/start', { method: 'POST', body: JSON.stringify(body) }),
  sdStop: () => req('/sdserver/stop', { method: 'POST' }),
  sdLog: (n = 120) => req(`/sdserver/log?n=${n}`),

  templates: () => req('/templates'),
  template: (id) => req(`/templates/${id}`),
  interpret: (body) => req('/interpret', { method: 'POST', body: JSON.stringify(body) }),

  run: (body) => req('/run', { method: 'POST', body: JSON.stringify(body) }),
  jobs: (limit = 50) => req(`/jobs?limit=${limit}`),
  job: (id) => req(`/jobs/${id}`),

  upload: async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(BASE + '/upload', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
    return res.json();
  },
  uploads: () => req('/uploads'),
};

export const fileUrl = (rel) => rel && rel.startsWith('/') ? rel : `/api${rel}`;
