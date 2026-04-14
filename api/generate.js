const Busboy = require('busboy');

const DEFAULT_BASE = 'https://api.tripo3d.ai/v2/openapi';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function tripoHeaders(apiKey, extraJson) {
  const h = {
    Authorization: `Bearer ${apiKey}`,
    'User-Agent': 'pic2threeD/vercel',
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

/**
 * Tripo 或中间层偶发返回 502 HTML；免费版 Vercel 函数默认约 10s 超时也会表现为网关错误。
 * 对可重试状态做有限次重试，并并行上传多张图以压缩总耗时。
 */
async function fetchTripoJson(url, init, label) {
  const maxAttempts = 4;
  const backoffMs = [0, 500, 1200, 2500];
  let lastDetail = '';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (backoffMs[attempt] > 0) {
      await sleep(backoffMs[attempt]);
    }

    let res;
    try {
      res = await fetch(url, { ...init, headers: { ...init.headers } });
    } catch (e) {
      lastDetail = e.message || String(e);
      if (attempt < maxAttempts - 1) {
        continue;
      }
      throw new Error(`${label}: 网络异常（已重试）: ${lastDetail}`);
    }

    const text = await res.text();
    const isHtml502 =
      text.includes('502') &&
      (text.includes('Bad Gateway') || text.includes('<html'));

    if (!res.ok) {
      const retryable =
        res.status === 502 ||
        res.status === 503 ||
        res.status === 504 ||
        isHtml502;
      if (retryable && attempt < maxAttempts - 1) {
        lastDetail = `HTTP ${res.status}`;
        continue;
      }
      try {
        const json = JSON.parse(text);
        return { res, json, text };
      } catch {
        throw new Error(
          `${label}: HTTP ${res.status} — ${isHtml502 ? '网关/上游暂时不可用，请稍后重试；若频繁出现可减少同时上传张数或检查 Vercel 函数超时设置。' : ''} ${text.slice(0, 200)}`
        );
      }
    }

    try {
      const json = JSON.parse(text);
      return { res, json, text };
    } catch {
      if (attempt < maxAttempts - 1) {
        lastDetail = '响应非 JSON';
        continue;
      }
      throw new Error(`${label}: 无法解析 JSON — ${text.slice(0, 200)}`);
    }
  }

  throw new Error(`${label}: 重试耗尽 ${lastDetail}`);
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
 * 与官方 Python SDK `_image_to_file_content` 一致：带 `file_token` 时 `type` 恒为 `jpg`。
 * https://github.com/VAST-AI-Research/tripo-python-sdk/blob/master/tripo3d/client.py
 */
function fileDescriptorFromToken(fileToken) {
  return { type: 'jpg', file_token: fileToken };
}

async function uploadOnePart(base, apiKey, p) {
  const fd = new FormData();
  const blob = new Blob([p.buffer], { type: p.mime });
  fd.append('file', blob, p.filename || (p.mime.includes('png') ? 'image.png' : 'image.jpg'));

  const { json } = await fetchTripoJson(
    `${base}/upload`,
    {
      method: 'POST',
      headers: tripoHeaders(apiKey, false),
      body: fd,
    },
    'Tripo 上传'
  );

  if (json.code !== 0) {
    const err = new Error(json.message || 'Tripo 上传失败');
    err.code = json.code;
    err.suggestion = json.suggestion;
    throw err;
  }
  const token = json.data?.image_token || json.data?.file_token;
  if (!token) {
    throw new Error('Tripo 上传未返回 token');
  }
  return token;
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

  try {
    const tokens = await Promise.all(parts.map((p) => uploadOnePart(base, apiKey, p)));

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

    const { json: taskJson } = await fetchTripoJson(
      `${base}/task`,
      {
        method: 'POST',
        headers: tripoHeaders(apiKey, true),
        body: JSON.stringify(taskBody),
      },
      'Tripo 创建任务'
    );

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
    const body = {
      error: e.message || '服务器错误',
    };
    if (e.code) {
      body.code = e.code;
    }
    if (e.suggestion) {
      body.suggestion = e.suggestion;
    }
    res.status(502).json(body);
  }
};
