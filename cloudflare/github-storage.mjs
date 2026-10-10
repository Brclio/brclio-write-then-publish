// GitHub credentials and account password hashes stay in the Worker/private repository.
// Business documents are deliberately readable JSON, Markdown and original media files.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const API_VERSION = '2026-03-10';
const JSON_LIMIT = 4 * 1024 * 1024;
const ASSET_LIMIT = 10 * 1024 * 1024;
const PASSWORD_ITERATIONS = 100000;
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const authAttempts = new Map();

export class StorageError extends Error {
  constructor(status, message, code = 'storage_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, message, code) { throw new StorageError(status, message, code); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function jsonFile(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function segment(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value) || value.includes('..')) {
    fail(400, '文件或项目标识无效。', 'invalid_path');
  }
  return value;
}
function safePath(value) {
  return typeof value === 'string' && value.length <= 1024 && value.split('/').every(part => {
    return part && part !== '.' && part !== '..' && /^[A-Za-z0-9_.-]+$/.test(part);
  });
}
export function storageConfiguration(env) {
  if (env.STORAGE_PROVIDER !== 'github') return { provider: 'disabled', error: '未启用 GitHub 私有仓库存储。' };
  const prefix = env.GITHUB_DATA_PREFIX || 'write-then-publish';
  const branch = env.GITHUB_BRANCH || 'main';
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(env.GITHUB_OWNER || '')
      || !/^[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPO || '') || ['.', '..'].includes(env.GITHUB_REPO)
      || !safePath(prefix) || prefix.startsWith('.git') || prefix.length > 240
      || typeof env.GITHUB_TOKEN !== 'string' || !env.GITHUB_TOKEN.trim()
      || typeof env.SESSION_SECRET !== 'string' || env.SESSION_SECRET.length < 32
      || typeof branch !== 'string' || !branch || branch.length > 200
      || /[\x00-\x20~^:?*\[\\]/.test(branch) || branch.includes('..') || branch.includes('@{')
      || branch === '@' || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.')
      || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    return { provider: 'disabled', error: 'GitHub 存储环境变量未配置完整或格式无效，请联系部署管理员。' };
  }
  return { provider: 'github', apiBase: '/api/storage' };
}

export function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(binary);
}
function base64ToBytes(value) { return Uint8Array.from(atob(value.replace(/\s/g, '')), c => c.charCodeAt(0)); }
function base64url(bytes) { return bytesToBase64(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function unbase64url(value) { return base64ToBytes(value.replace(/-/g, '+').replace(/_/g, '/')); }
async function sha256(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
}
async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PASSWORD_ITERATIONS }, key, 256));
}
function constantEqual(a, b) {
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) difference |= (a[index] || 0) ^ (b[index] || 0);
  return difference === 0;
}
function normalizeCredentials(body) {
  if (!object(body) || typeof body.email !== 'string' || typeof body.password !== 'string') fail(400, '请输入邮箱和密码。', 'invalid_credentials');
  const email = body.email.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, '邮箱格式无效。', 'invalid_email');
  if (body.password.length < 8 || body.password.length > 128) fail(400, '密码长度应为 8 至 128 个字符。', 'invalid_password');
  return { email, password: body.password };
}
function throttleAuth(request, email) {
  const key = `${request.headers.get('CF-Connecting-IP') || 'unknown'}:${email}`;
  const now = Date.now();
  let entry = authAttempts.get(key);
  if (!entry || entry.until < now) entry = { count: 0, until: now + 10 * 60 * 1000 };
  if (++entry.count > 20) fail(429, '登录尝试过于频繁，请稍后重试。', 'auth_rate_limit');
  authAttempts.set(key, entry);
  if (authAttempts.size > 2000) {
    for (const [id, record] of authAttempts) if (record.until < now) authAttempts.delete(id);
    while (authAttempts.size > 2000) authAttempts.delete(authAttempts.keys().next().value);
  }
}

async function hmacKey(env) { return crypto.subtle.importKey('raw', encoder.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
async function makeSession(env, account) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: account.id, email: account.email, sv: account.session_version, jti: crypto.randomUUID(), iat: now, exp: now + SESSION_SECONDS, aud: 'write-then-publish' };
  const encoded = `${base64url(encoder.encode('{"alg":"HS256","typ":"JWT"}'))}.${base64url(encoder.encode(JSON.stringify(payload)))}`;
  const token = `${encoded}.${base64url(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env), encoder.encode(encoded))))}`;
  return { access_token: token, refresh_token: token, expires_at: payload.exp, user: { id: account.id, email: account.email } };
}
async function verifySession(request, env) {
  const token = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1];
  try {
    if (!token || token.length > 2048) throw new Error();
    const [header, body, signature, extra] = token.split('.');
    if (!header || !body || !signature || extra) throw new Error();
    const metadata = JSON.parse(decoder.decode(unbase64url(header)));
    const payload = JSON.parse(decoder.decode(unbase64url(body)));
    if (metadata.alg !== 'HS256' || metadata.typ !== 'JWT' || !/^[a-f0-9]{64}$/.test(payload.sub)
        || typeof payload.email !== 'string' || !Number.isSafeInteger(payload.sv)
        || typeof payload.jti !== 'string' || !/^[a-f0-9-]{36}$/.test(payload.jti)
        || payload.aud !== 'write-then-publish' || !Number.isSafeInteger(payload.exp)
        || payload.exp <= Math.floor(Date.now() / 1000)) throw new Error();
    if (!await crypto.subtle.verify('HMAC', await hmacKey(env), unbase64url(signature), encoder.encode(`${header}.${body}`))) throw new Error();
    return { token, payload };
  } catch { fail(401, '登录已失效，请重新登录。', 'unauthorized'); }
}

// A snapshot pins every read to one commit; retries rebuild changes on the newest
// tree rather than overwriting another user's writes with a stale snapshot.
export class GitHubRepository {
  constructor(env, fetcher = fetch) {
    this.env = env;
    this.fetcher = fetcher;
    this.prefix = env.GITHUB_DATA_PREFIX || 'write-then-publish';
    this.branch = env.GITHUB_BRANCH || 'main';
    this.base = `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}`;
    this.verified = false;
  }
  async api(path, options = {}, allow404 = false) {
    let response;
    try {
      // Workers' native fetch rejects a GitHubRepository receiver (Illegal invocation).
      const fetcher = this.fetcher;
      response = await fetcher(`${this.base}${path}`, {
        method: options.method || 'GET', headers: {
          Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.env.GITHUB_TOKEN}`,
          'X-GitHub-Api-Version': API_VERSION, 'User-Agent': 'write-then-publish-cloudflare',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        }, ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch { fail(503, '暂时无法连接 GitHub，请稍后重试。', 'github_unavailable'); }
    if (allow404 && response.status === 404) return null;
    if (!response.ok) {
      if (response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))) {
        fail(429, 'GitHub 请求额度暂时用尽，请稍后重试。', 'github_rate_limit');
      }
      if (response.status === 409 || response.status === 422) fail(409, 'GitHub 分支发生并发变更，请重试。', 'git_conflict');
      if (response.status === 401 || response.status === 403) fail(503, 'GitHub 仓库授权不可用，请联系部署管理员。', 'github_authorization');
      if (response.status === 404) fail(503, 'GitHub 仓库或已初始化的分支不存在，请联系部署管理员。', 'github_configuration');
      fail(503, 'GitHub 存储暂时不可用，请稍后重试。', 'github_unavailable');
    }
    return response.json();
  }
  async snapshot() {
    if (!this.verified) {
      const repository = await this.api('');
      if (repository.private !== true) fail(503, 'GitHub 存储仅允许使用私有仓库，请联系部署管理员。', 'public_repository');
      this.verified = true;
    }
    const reference = await this.api(`/git/ref/heads/${this.branch.split('/').map(encodeURIComponent).join('/')}`);
    const commit = await this.api(`/git/commits/${reference.object.sha}`);
    return { head: reference.object.sha, root: commit.tree.sha, trees: new Map(), blobs: new Map() };
  }
  tree(snapshot, sha, recursive = false) {
    const key = `${sha}:${recursive}`;
    if (!snapshot.trees.has(key)) snapshot.trees.set(key, this.api(`/git/trees/${sha}${recursive ? '?recursive=1' : ''}`).then(result => {
      if (result.truncated) fail(503, '用户文件目录过大，无法完整读取，请联系部署管理员。', 'tree_too_large');
      return result.tree;
    }));
    return snapshot.trees.get(key);
  }
  async entry(snapshot, path) {
    let sha = snapshot.root;
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index++) {
      const item = (await this.tree(snapshot, sha)).find(entry => entry.path === parts[index]);
      if (!item) return null;
      if (index === parts.length - 1) return item;
      if (item.type !== 'tree') fail(503, 'GitHub 数据目录结构无效。', 'invalid_repository_data');
      sha = item.sha;
    }
    return null;
  }
  async bytes(snapshot, path) {
    const item = await this.entry(snapshot, path);
    if (!item) return null;
    if (item.type !== 'blob') fail(503, 'GitHub 文件结构无效。', 'invalid_repository_data');
    if (!snapshot.blobs.has(item.sha)) snapshot.blobs.set(item.sha, this.api(`/git/blobs/${item.sha}`).then(blob => base64ToBytes(blob.content)));
    return snapshot.blobs.get(item.sha);
  }
  async json(snapshot, path, fallback = null) {
    const bytes = await this.bytes(snapshot, path);
    if (!bytes) return fallback;
    try { return JSON.parse(decoder.decode(bytes)); } catch { fail(503, 'GitHub 数据文件格式无效，请联系部署管理员。', 'invalid_repository_data'); }
  }
  async write(message, calculate) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const snapshot = await this.snapshot();
      const { changes, result } = await calculate(snapshot);
      if (!changes.length) return result;
      const entries = [];
      for (const change of changes) {
        if (change.bytes) {
          const blob = await this.api('/git/blobs', { method: 'POST', body: { content: bytesToBase64(change.bytes), encoding: 'base64' } });
          entries.push({ path: change.path, type: 'blob', mode: '100644', sha: blob.sha });
        } else if (change.delete) {
          entries.push({ path: change.path, type: 'blob', mode: '100644', sha: null });
        } else {
          entries.push({ path: change.path, type: 'blob', mode: '100644', content: change.text });
        }
      }
      const tree = await this.api('/git/trees', { method: 'POST', body: { base_tree: snapshot.root, tree: entries } });
      const commit = await this.api('/git/commits', { method: 'POST', body: { message, tree: tree.sha, parents: [snapshot.head] } });
      try {
        await this.api(`/git/refs/heads/${this.branch.split('/').map(encodeURIComponent).join('/')}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
        return result;
      } catch (error) {
        if (error.code !== 'git_conflict' || attempt === 3) throw error;
      }
    }
  }
}

async function requestBytes(request, maximum) {
  const declared = request.headers.get('Content-Length');
  if (declared && Number(declared) > maximum) fail(413, '文件或请求内容超过大小限制。', 'payload_too_large');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maximum) {
      await reader.cancel();
      fail(413, '文件或请求内容超过大小限制。', 'payload_too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
async function requestJson(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) fail(415, '请求内容必须为 JSON。', 'invalid_content_type');
  try {
    const value = JSON.parse(decoder.decode(await requestBytes(request, JSON_LIMIT)));
    if (!object(value)) fail(400, '请求数据格式无效。', 'invalid_request');
    return value;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    fail(400, '请求数据格式无效。', 'invalid_json');
  }
}
function responseJson(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(status === 429 ? { 'Retry-After': '60' } : {}) } });
}
function userRoot(repository, id) { return `${repository.prefix}/users/${id}`; }
async function authenticatedAccount(repository, snapshot, identity) {
  const account = await repository.json(snapshot, `${userRoot(repository, identity.payload.sub)}/account.json`);
  if (!account || account.id !== identity.payload.sub || account.email !== identity.payload.email
      || account.session_version !== identity.payload.sv || account.revoked_sessions?.some(item => item.id === identity.payload.jti)) {
    fail(401, '登录已失效，请重新登录。', 'unauthorized');
  }
  return account;
}
function checkRevision(existing, revision) {
  if (existing ? revision !== existing.revision : revision !== undefined && revision !== null) {
    fail(409, '此内容已在另一设备更新，请重新同步后再保存；本机内容已保留。', 'revision_conflict');
  }
}
function projectBase(root, id) { return `${root}/projects/${segment(id)}`; }
function normalizeProfile(body, id) {
  if (typeof body.displayName !== 'string' || body.displayName.length > 100 || typeof body.avatarUrl !== 'string' || body.avatarUrl.length > 2 * 1024 * 1024) fail(400, '昵称或头像格式无效。', 'invalid_profile');
  // Data URLs keep private avatars usable in ordinary <img> elements without exposing a bearer token.
  if (body.avatarUrl && !/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(body.avatarUrl)) fail(400, '头像必须为 PNG、JPEG、WebP 或 GIF 图片。', 'invalid_avatar');
  return { user_id: id, display_name: body.displayName.trim(), avatar_url: body.avatarUrl, updated_at: new Date().toISOString() };
}
function assetPathAllowed(path, root) {
  if (!safePath(path) || !path.startsWith(`${root}/projects/`)) return false;
  const pieces = path.slice(`${root}/projects/`.length).split('/');
  return pieces.length === 3 && pieces[1] === 'assets' && pieces[0] && pieces[2];
}
function mediaType(path) {
  const extension = path.split('.').pop().toLowerCase();
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', heic: 'image/heic', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', bin: 'application/octet-stream' }[extension] || 'application/octet-stream';
}
async function mapLimited(items, action, concurrency = 4) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await action(items[index]); }
  }));
  return results;
}

export async function handleStorageRequest(request, env, fetcher = fetch) {
  try {
    const configuration = storageConfiguration(env);
    if (configuration.provider !== 'github') fail(503, configuration.error, 'storage_not_configured');
    const url = new URL(request.url);
    if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) fail(403, '不允许跨站访问账号存储。', 'cross_origin');
    if (request.headers.get('Sec-Fetch-Site') === 'cross-site') fail(403, '不允许跨站访问账号存储。', 'cross_origin');
    const route = url.pathname.slice('/api/storage'.length);
    const repository = new GitHubRepository(env, fetcher);
    if (request.method === 'POST' && (route === '/auth/signup' || route === '/auth/signin')) {
      if (!env.AUTH_RATE_LIMIT?.limit) fail(503, '账号请求限流尚未配置，请联系部署管理员。', 'auth_rate_limit_not_configured');
      const { success } = await env.AUTH_RATE_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'local-test' });
      if (!success) fail(429, '账号请求过于频繁，请稍后重试。', 'auth_rate_limit');
      const credentials = normalizeCredentials(await requestJson(request));
      throttleAuth(request, credentials.email);
      const id = await sha256(credentials.email);
      const root = userRoot(repository, id);
      let account;
      if (route === '/auth/signup') {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const now = new Date().toISOString();
        account = { schema_version: 1, id, email: credentials.email, password: { algorithm: 'PBKDF2-SHA256', iterations: PASSWORD_ITERATIONS, salt: bytesToBase64(salt), hash: bytesToBase64(await passwordHash(credentials.password, salt)) }, session_version: 1, revoked_sessions: [], created_at: now };
        await repository.write('Create writing account', async snapshot => {
          if (await repository.json(snapshot, `${root}/account.json`)) fail(409, '此邮箱已注册，请直接登录。', 'account_exists');
          return { changes: [
            { path: `${root}/account.json`, text: jsonFile(account) },
            { path: `${root}/profile.json`, text: jsonFile({ user_id: id, display_name: '', avatar_url: '', updated_at: now }) },
            { path: `${root}/projects/index.json`, text: jsonFile({ schema_version: 1, projects: [] }) },
          ] };
        });
      } else {
        const snapshot = await repository.snapshot();
        account = await repository.json(snapshot, `${root}/account.json`);
        const salt = account?.password?.salt ? base64ToBytes(account.password.salt) : new Uint8Array(16);
        const actual = await passwordHash(credentials.password, salt);
        if (!account || account.password?.algorithm !== 'PBKDF2-SHA256' || account.password.iterations !== PASSWORD_ITERATIONS || !constantEqual(actual, base64ToBytes(account.password.hash))) fail(401, '邮箱或密码不正确。', 'invalid_credentials');
      }
      const session = await makeSession(env, account);
      return responseJson({ session, user: session.user });
    }
    const identity = await verifySession(request, env);
    const root = userRoot(repository, identity.payload.sub);
    if (route === '/auth/signout' && request.method === 'POST') {
      await repository.write('Revoke writing account session', async snapshot => {
        const account = await authenticatedAccount(repository, snapshot, identity);
        const now = Math.floor(Date.now() / 1000);
        const revoked = (account.revoked_sessions || []).filter(item => item.expires_at > now);
        revoked.push({ id: identity.payload.jti, expires_at: identity.payload.exp });
        return { changes: [{ path: `${root}/account.json`, text: jsonFile({ ...account, revoked_sessions: revoked }) }] };
      });
      return responseJson({});
    }
    if (route === '/profile' && request.method === 'PUT') {
      const profile = normalizeProfile(await requestJson(request), identity.payload.sub);
      const result = await repository.write('Update writing profile', async snapshot => {
        await authenticatedAccount(repository, snapshot, identity);
        return { changes: [{ path: `${root}/profile.json`, text: jsonFile(profile) }], result: profile };
      });
      return responseJson(result);
    }
    const assetUpload = route.match(/^\/assets\/([^/]+)\/([^/]+)$/);
    if (assetUpload && request.method === 'PUT') {
      const path = `${projectBase(root, assetUpload[1])}/assets/${segment(assetUpload[2])}`;
      const bytes = await requestBytes(request, ASSET_LIMIT);
      if (!bytes.length) fail(400, '不能上传空文件。', 'empty_asset');
      const hash = await sha256(bytes);
      if (!assetUpload[2].startsWith(`${hash}.`)) fail(400, '资源文件名与文件内容校验不一致。', 'asset_hash_mismatch');
      await repository.write('Store writing media', async snapshot => {
        await authenticatedAccount(repository, snapshot, identity);
        const existing = await repository.bytes(snapshot, path);
        if (existing && !constantEqual(existing, bytes)) fail(409, '同名资源已存在，请重新上传。', 'asset_conflict');
        return { changes: existing ? [] : [{ path, bytes }] };
      });
      return responseJson({ path });
    }
    const projectRoute = route.match(/^\/projects\/([^/]+)$/);
    if (projectRoute && request.method === 'PUT') {
      const id = segment(projectRoute[1]);
      const body = await requestJson(request);
      if (typeof body.title !== 'string' || body.title.length > 500 || !object(body.data) || typeof body.data.content !== 'string') fail(400, '项目内容格式无效。', 'invalid_project');
      const base = projectBase(root, id);
      for (const image of Object.values(body.data.images || {})) for (const key of ['storagePath', 'videoStoragePath']) {
        if (image?.[key] && (!assetPathAllowed(image[key], root) || !image[key].startsWith(`${base}/assets/`))) fail(400, '项目资源路径无效。', 'invalid_asset_path');
      }
      const result = await repository.write('Save writing project', async snapshot => {
        await authenticatedAccount(repository, snapshot, identity);
        const existing = await repository.json(snapshot, `${base}/project.json`);
        checkRevision(existing, body.revision);
        const index = await repository.json(snapshot, `${root}/projects/index.json`, { schema_version: 1, projects: [] });
        if (!existing && index.projects.length >= 1000) fail(409, '项目数量已达到当前部署上限。', 'project_limit');
        const now = new Date().toISOString();
        const created = existing?.created_at || (typeof body.created_at === 'string' && !Number.isNaN(Date.parse(body.created_at)) ? new Date(body.created_at).toISOString() : now);
        const { content, ...data } = body.data;
        const row = { id, title: body.title, data, created_at: created, updated_at: now, revision: crypto.randomUUID() };
        const metadata = { id, title: row.title, created_at: created, updated_at: now, revision: row.revision };
        const projects = index.projects.filter(project => project.id !== id).concat(metadata).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        return { changes: [
          { path: `${base}/project.json`, text: jsonFile(row) },
          { path: `${base}/content.md`, text: content },
          { path: `${root}/projects/index.json`, text: jsonFile({ schema_version: 1, projects }) },
        ], result: { ...row, data: { ...data, content } } };
      });
      return responseJson(result);
    }
    if (projectRoute && request.method === 'DELETE') {
      const id = segment(projectRoute[1]);
      const body = await requestJson(request);
      const base = projectBase(root, id);
      await repository.write('Delete writing project and media', async snapshot => {
        await authenticatedAccount(repository, snapshot, identity);
        const existing = await repository.json(snapshot, `${base}/project.json`);
        if (!existing) return { changes: [] };
        checkRevision(existing, body.revision);
        const index = await repository.json(snapshot, `${root}/projects/index.json`, { schema_version: 1, projects: [] });
        const directory = await repository.entry(snapshot, base);
        const files = await repository.tree(snapshot, directory.sha, true);
        return { changes: [
          ...files.filter(file => file.type === 'blob').map(file => ({ path: `${base}/${file.path}`, delete: true })),
          { path: `${root}/projects/index.json`, text: jsonFile({ schema_version: 1, projects: index.projects.filter(project => project.id !== id) }) },
        ] };
      });
      return responseJson({});
    }
    const snapshot = await repository.snapshot();
    const account = await authenticatedAccount(repository, snapshot, identity);
    if (route === '/auth/session' && request.method === 'GET') return responseJson({ session: { access_token: identity.token, refresh_token: identity.token, expires_at: identity.payload.exp, user: { id: account.id, email: account.email } } });
    if (route === '/profile' && request.method === 'GET') return responseJson(await repository.json(snapshot, `${root}/profile.json`, { user_id: account.id, display_name: '', avatar_url: '' }));
    if (route === '/projects' && request.method === 'GET') {
      const index = await repository.json(snapshot, `${root}/projects/index.json`, { projects: [] });
      const rows = await mapLimited(index.projects, async metadata => {
        const base = projectBase(root, metadata.id);
        const [row, bytes] = await Promise.all([repository.json(snapshot, `${base}/project.json`), repository.bytes(snapshot, `${base}/content.md`)]);
        if (!row || !bytes) fail(503, '项目文件缺失，请联系部署管理员。', 'invalid_repository_data');
        return { ...row, data: { ...row.data, content: decoder.decode(bytes) } };
      });
      return responseJson(rows);
    }
    if (route === '/assets' && request.method === 'GET') {
      const path = url.searchParams.get('path');
      if (!assetPathAllowed(path, root)) fail(403, '无权读取此资源。', 'forbidden_asset');
      const bytes = await repository.bytes(snapshot, path);
      if (!bytes) fail(404, '资源不存在。', 'asset_not_found');
      return new Response(bytes, { headers: { 'Content-Type': mediaType(path), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
    }
    fail(404, '存储接口不存在。', 'not_found');
  } catch (error) {
    if (error instanceof StorageError) return responseJson({ error: error.message, code: error.code }, error.status);
    // Do not return upstream payloads, repository names, secrets or stack traces.
    return responseJson({ error: '存储处理失败，请稍后重试。', code: 'internal_error' }, 500);
  }
}
