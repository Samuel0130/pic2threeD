const getRawBody = require('raw-body');

const TRIPO_ORIGIN = 'https://api.tripo3d.ai';

module.exports = async function handler(req, res) {
  const apiKey = process.env.TRIPO_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'TRIPO_API_KEY 未在服务器环境变量中配置' });
    return;
  }

  const segments = req.query.path;
  const pathStr = Array.isArray(segments)
    ? segments.join('/')
    : segments || '';
  if (!pathStr || pathStr.includes('..')) {
    res.status(400).json({ error: '非法路径' });
    return;
  }

  const targetUrl = `${TRIPO_ORIGIN}/${pathStr}`;

  const headers = new Headers();
  headers.set('Authorization', `Bearer ${apiKey}`);
  const clientId = process.env.TRIPO_CLIENT_ID;
  if (clientId) {
    headers.set('X-Client-Id', clientId);
  }

  const incomingCt = req.headers['content-type'];
  if (incomingCt) {
    headers.set('Content-Type', incomingCt);
  }

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await getRawBody(req);
    if (body.length === 0) {
      body = undefined;
    }
  }

  const upstream = await fetch(targetUrl, {
    method: req.method,
    headers,
    body,
  });

  const buf = Buffer.from(await upstream.arrayBuffer());
  const ct = upstream.headers.get('content-type');
  if (ct) {
    res.setHeader('Content-Type', ct);
  }
  res.status(upstream.status).send(buf);
};
