const { URL } = require('url');

const DEFAULT_BASE = 'https://api.tripo3d.ai/v2/openapi';

function tripoHeaders(apiKey) {
  const h = { Authorization: `Bearer ${apiKey}` };
  const clientId = process.env.TRIPO_CLIENT_ID;
  if (clientId) {
    h['X-Client-Id'] = clientId;
  }
  const region = process.env.TRIPO_REGION;
  if (region) {
    h['X-Tripo-Region'] = region;
  }
  return h;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const apiKey = process.env.TRIPO_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'TRIPO_API_KEY 未配置' });
    return;
  }

  const { searchParams } = new URL(req.url || '/', 'http://localhost');
  const taskId = (searchParams.get('id') || '').trim();
  if (!taskId || taskId.includes('..') || taskId.includes('/')) {
    res.status(400).json({ error: '无效的任务 id' });
    return;
  }

  const base = (process.env.TRIPO_OPENAPI_BASE || DEFAULT_BASE).replace(/\/$/, '');

  try {
    const upstream = await fetch(`${base}/task/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      headers: tripoHeaders(apiKey),
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    const ct = upstream.headers.get('content-type') || 'application/json';
    res.status(upstream.status).setHeader('Content-Type', ct).send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message || '查询失败' });
  }
};
