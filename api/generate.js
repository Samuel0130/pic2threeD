const Busboy = require('busboy');

const DEFAULT_BASE = 'https://api.tripo3d.ai/v2/openapi';

function tripoHeaders(apiKey, extraJson) {
  const h = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (extraJson) {
    h['Content-Type'] = 'application/json';
  }
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

function collectMultipart(req) {
  return new Promise((resolve, reject) => {
    const pending = [];
    const bb = Busboy({
      headers: req.headers,
      limits: { files: 8, fileSize: 12 * 1024 * 1024 },
    });

    bb.on('file', (fieldname, file, info) => {
      if (fieldname !== 'file') {
        file.resume();
        return;
      }
      pending.push(
        new Promise((res, rej) => {
          const chunks = [];
          file.on('data', (d) => chunks.push(d));
          file.on('limit', () => rej(new Error('单个文件超过大小限制')));
          file.on('end', () => {
            res({
              buffer: Buffer.concat(chunks),
              filename: info.filename || 'image.jpg',
              mime: (info.mimeType || '').toLowerCase(),
            });
          });
          file.on('error', rej);
        })
      );
    });

    bb.on('error', reject);
    bb.on('finish', async () => {
      try {
        resolve(await Promise.all(pending));
      } catch (e) {
        reject(e);
      }
    });

    req.pipe(bb);
  });
}

function allowedImage(mime) {
  return mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/jpg';
}

/**
 * 与官方 Python SDK `_image_to_file_content` 一致：带 `file_token` 时 `type` 恒为 `jpg`，
 * 不得按原图写成 png（否则会 1004）。见：
 * https://github.com/VAST-AI-Research/tripo-python-sdk/blob/master/tripo3d/client.py
 */
function fileDescriptorFromToken(fileToken) {
  return { type: 'jpg', file_token: fileToken };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const apiKey = process.env.TRIPO_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'TRIPO_API_KEY 未配置' });
    return;
  }

  const base = (process.env.TRIPO_OPENAPI_BASE || DEFAULT_BASE).replace(/\/$/, '');
  const modelVersion = process.env.TRIPO_MODEL_VERSION || 'v2.5-20250123';

  let parts;
  try {
    parts = await collectMultipart(req);
  } catch (e) {
    res.status(400).json({ error: e.message || '解析上传失败' });
    return;
  }

  if (parts.length === 0) {
    res.status(400).json({ error: '请至少上传一张图片（字段名 file）' });
    return;
  }

  for (const p of parts) {
    if (!allowedImage(p.mime)) {
      res.status(400).json({ error: '仅支持 JPG、PNG 图片' });
      return;
    }
  }

  const tokens = [];
  try {
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const fd = new FormData();
      const blob = new Blob([p.buffer], { type: p.mime });
      fd.append('file', blob, p.filename || (p.mime.includes('png') ? 'image.png' : 'image.jpg'));

      const up = await fetch(`${base}/upload`, {
        method: 'POST',
        headers: tripoHeaders(apiKey, false),
        body: fd,
      });
      const text = await up.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        res.status(502).json({ error: `Tripo 上传响应异常: ${text.slice(0, 200)}` });
        return;
      }
      if (json.code !== 0) {
        res.status(502).json({
          error: json.message || 'Tripo 上传失败',
          code: json.code,
          suggestion: json.suggestion,
        });
        return;
      }
      const token = json.data?.image_token || json.data?.file_token;
      if (!token) {
        res.status(502).json({ error: 'Tripo 上传未返回 token' });
        return;
      }
      tokens.push(token);
    }

    let taskBody;
    if (tokens.length === 1) {
      taskBody = {
        type: 'image_to_model',
        model_version: modelVersion,
        file: fileDescriptorFromToken(tokens[0]),
      };
    } else {
      taskBody = {
        type: 'multiview_to_model',
        model_version: modelVersion,
        files: tokens.map((t) => fileDescriptorFromToken(t)),
      };
    }

    const taskRes = await fetch(`${base}/task`, {
      method: 'POST',
      headers: tripoHeaders(apiKey, true),
      body: JSON.stringify(taskBody),
    });
    const taskText = await taskRes.text();
    let taskJson;
    try {
      taskJson = JSON.parse(taskText);
    } catch {
      res.status(502).json({ error: `Tripo 创建任务响应异常: ${taskText.slice(0, 200)}` });
      return;
    }
    if (taskJson.code !== 0) {
      res.status(502).json({
        error: taskJson.message || 'Tripo 创建任务失败',
        code: taskJson.code,
        suggestion: taskJson.suggestion,
      });
      return;
    }
    const taskId = taskJson.data?.task_id;
    if (!taskId) {
      res.status(502).json({ error: 'Tripo 未返回 task_id' });
      return;
    }

    res.status(200).json({ task_id: taskId });
  } catch (e) {
    res.status(500).json({ error: e.message || '服务器错误' });
  }
};
