import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'cozy2025';

const DATA_DIR = path.join(__dirname, 'data');
const IMAGE_DIR = path.join(DATA_DIR, 'images');
const ITEMS_FILE = path.join(DATA_DIR, 'items.json');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function isAuthorized(req) {
  return req.headers['x-admin-password'] === ADMIN_PASSWORD;
}

async function ensureStorage() {
  await mkdir(IMAGE_DIR, { recursive: true });
  try {
    await stat(ITEMS_FILE);
  } catch {
    await writeFile(ITEMS_FILE, '[]\n', 'utf8');
  }
}

async function readItems() {
  await ensureStorage();
  try {
    const raw = await readFile(ITEMS_FILE, 'utf8');
    const items = JSON.parse(raw);
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

async function writeItems(items) {
  await ensureStorage();
  const temp = ITEMS_FILE + '.tmp';
  await writeFile(temp, JSON.stringify(items, null, 2) + '\n', 'utf8');
  await rename(temp, ITEMS_FILE);
}

function cleanId(value) {
  const raw = String(value || '').trim();
  if (/^[a-zA-Z0-9_-]{1,80}$/.test(raw)) return raw;
  return 'user_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function cleanText(value) {
  return String(value || '').trim();
}

function imageExtension(mime) {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  return '.jpg';
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+)(;base64)?,([\s\S]+)$/.exec(String(dataUrl || ''));
  if (!match) return null;
  const mime = match[1] || 'application/octet-stream';
  try {
    const bytes = match[2]
      ? Buffer.from(match[3], 'base64')
      : Buffer.from(decodeURIComponent(match[3]));
    return bytes.length ? { bytes, mime } : null;
  } catch {
    return null;
  }
}

async function saveImage(id, bytes, mime) {
  await mkdir(IMAGE_DIR, { recursive: true });
  const safeMime = String(mime || 'image/jpeg').split(';')[0].toLowerCase();
  const fileName = id + imageExtension(safeMime);
  const filePath = path.join(IMAGE_DIR, fileName);
  await writeFile(filePath, Buffer.from(bytes));
  return { imageFile: fileName, mime: safeMime, imageVersion: Date.now() };
}

async function deleteImageFile(fileName) {
  if (!fileName) return;
  const resolved = path.resolve(IMAGE_DIR, fileName);
  if (!resolved.startsWith(path.resolve(IMAGE_DIR) + path.sep)) return;
  try { await unlink(resolved); } catch {}
}

function projectItem(item) {
  return {
    id: item.id,
    title: item.title || '',
    category: item.category || '',
    description: item.description || item.title || '',
    image: `/api/items/${encodeURIComponent(item.id)}/image?v=${item.imageVersion || 1}`,
  };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readUpload(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (contentType.includes('multipart/form-data')) {
    const request = new Request('http://localhost' + req.url, {
      method: req.method,
      headers: req.headers,
      body: Readable.toWeb(req),
      duplex: 'half',
    });
    const form = await request.formData();
    const fields = {};
    for (const [key, value] of form.entries()) {
      if (key !== 'image' && typeof value === 'string') fields[key] = value;
    }
    const file = form.get('image');
    if (file && typeof file.arrayBuffer === 'function' && file.size > 0) {
      return {
        fields,
        imageBytes: Buffer.from(await file.arrayBuffer()),
        imageMime: file.type || 'image/jpeg',
      };
    }
    return { fields };
  }
  return { body: await readJsonBody(req) };
}

async function handleApi(req, res, url) {
  const method = String(req.method || 'GET').toUpperCase();
  const imageMatch = /^\/api\/items\/([^/]+)\/image\/?$/.exec(url.pathname);
  const itemMatch = /^\/api\/items\/([^/]+)\/?$/.exec(url.pathname);

  if (url.pathname === '/api/auth') {
    if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    if (!isAuthorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    return sendJson(res, 200, { ok: true });
  }

  if (imageMatch) {
    if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    const id = decodeURIComponent(imageMatch[1]);
    const item = (await readItems()).find(entry => entry.id === id);
    if (!item || !item.imageFile) return sendJson(res, 404, { error: 'image not found' });
    const imagePath = path.resolve(IMAGE_DIR, item.imageFile);
    if (!imagePath.startsWith(path.resolve(IMAGE_DIR) + path.sep)) {
      return sendJson(res, 400, { error: 'invalid image path' });
    }
    try {
      const image = await readFile(imagePath);
      res.writeHead(200, {
        'Content-Type': item.mime || 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Length': image.length,
      });
      return res.end(image);
    } catch {
      return sendJson(res, 404, { error: 'image not found' });
    }
  }

  if (url.pathname === '/api/items' && method === 'GET') {
    const items = await readItems();
    return sendJson(res, 200, { items: items.map(projectItem) });
  }

  if (!isAuthorized(req)) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  if (url.pathname === '/api/items' && method === 'POST') {
    const upload = await readUpload(req);
    const current = await readItems();

    if (upload.body && Array.isArray(upload.body.items)) {
      const byId = new Map(current.map(item => [item.id, item]));
      const created = [];
      for (const raw of upload.body.items) {
        const id = cleanId(raw.id);
        const title = cleanText(raw.title);
        const category = cleanText(raw.category);
        if (!title || !category || !raw.image) continue;
        const parsed = parseDataUrl(raw.image);
        if (!parsed) continue;
        const previous = byId.get(id);
        const imageMeta = await saveImage(id, parsed.bytes, parsed.mime);
        if (previous && previous.imageFile !== imageMeta.imageFile) await deleteImageFile(previous.imageFile);
        const item = {
          id,
          title,
          category,
          description: cleanText(raw.description) || title,
          ...imageMeta,
        };
        byId.set(id, item);
        created.push(projectItem(item));
      }
      const next = [...byId.values()].sort((a, b) => (b.imageVersion || 0) - (a.imageVersion || 0));
      await writeItems(next);
      return sendJson(res, 200, { items: created });
    }

    const source = upload.fields || upload.body || {};
    const id = cleanId(source.id);
    const title = cleanText(source.title);
    const category = cleanText(source.category);
    if (!title || !category) return sendJson(res, 400, { error: 'title and category are required' });

    let imageMeta = null;
    if (upload.imageBytes) imageMeta = await saveImage(id, upload.imageBytes, upload.imageMime);
    else if (upload.body && upload.body.image) {
      const parsed = parseDataUrl(upload.body.image);
      if (parsed) imageMeta = await saveImage(id, parsed.bytes, parsed.mime);
    }
    if (!imageMeta) return sendJson(res, 400, { error: 'image is required' });

    const next = current.filter(item => item.id !== id);
    const item = {
      id,
      title,
      category,
      description: cleanText(source.description) || title,
      ...imageMeta,
    };
    next.unshift(item);
    await writeItems(next);
    return sendJson(res, 200, { item: projectItem(item) });
  }

  if (itemMatch && method === 'PUT') {
    const id = decodeURIComponent(itemMatch[1]);
    const items = await readItems();
    const index = items.findIndex(item => item.id === id);
    if (index === -1) return sendJson(res, 404, { error: 'not found' });
    const upload = await readUpload(req);
    const source = upload.fields || upload.body || {};
    const existing = items[index];
    const updated = {
      ...existing,
      title: source.title != null ? cleanText(source.title) : existing.title,
      category: source.category != null ? cleanText(source.category) : existing.category,
      description: source.description != null ? cleanText(source.description) : existing.description,
    };
    if (upload.imageBytes) {
      const imageMeta = await saveImage(id, upload.imageBytes, upload.imageMime);
      if (existing.imageFile !== imageMeta.imageFile) await deleteImageFile(existing.imageFile);
      Object.assign(updated, imageMeta);
    } else if (upload.body && upload.body.image) {
      const parsed = parseDataUrl(upload.body.image);
      if (!parsed) return sendJson(res, 400, { error: 'image must be a valid data URL' });
      const imageMeta = await saveImage(id, parsed.bytes, parsed.mime);
      if (existing.imageFile !== imageMeta.imageFile) await deleteImageFile(existing.imageFile);
      Object.assign(updated, imageMeta);
    }
    if (!updated.title || !updated.category) {
      return sendJson(res, 400, { error: 'title and category are required' });
    }
    items[index] = updated;
    await writeItems(items);
    return sendJson(res, 200, { item: projectItem(updated) });
  }

  if (itemMatch && method === 'DELETE') {
    const id = decodeURIComponent(itemMatch[1]);
    const items = await readItems();
    const item = items.find(entry => entry.id === id);
    const next = items.filter(entry => entry.id !== id);
    if (item) await deleteImageFile(item.imageFile);
    await writeItems(next);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 405, { error: 'method not allowed' });
}

async function serveStatic(req, res, url) {
  const requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const resolved = path.resolve(__dirname, '.' + requested);
  if (!resolved.startsWith(__dirname + path.sep)) {
    return sendText(res, 403, 'Forbidden');
  }
  try {
    const file = await readFile(resolved);
    const type = MIME_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': file.length,
      'Cache-Control': requested.startsWith('/assets/') ? 'public, max-age=86400' : 'no-store',
    });
    res.end(file);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: 'server error', detail: error.message });
  }
});

await ensureStorage();
server.listen(PORT, () => {
  console.log(`Cozy Home Ideas is running: http://localhost:${PORT}`);
  console.log('Admin panel: http://localhost:' + PORT + '/admin.html');
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
