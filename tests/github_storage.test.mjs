import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import worker from '../cloudflare/worker.mjs';
import { handleStorageRequest, storageConfiguration } from '../cloudflare/github-storage.mjs';
import { createFakeGitHub, fakeGitHubEnvironment } from './helpers/fake_github.mjs';

const password = 'correct horse battery staple';
const digest = value => createHash('sha256').update(value).digest('hex');
const tokenFor = user => user.session.access_token;

function harness(options = {}) {
  const fake = createFakeGitHub(options);
  const env = fakeGitHubEnvironment(fake, options.env);
  async function request(route, { method = 'GET', token, json, body, headers = {} } = {}) {
    const result = await handleStorageRequest(new Request(`https://writing.example/api/storage${route}`, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(json === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(json === undefined && body === undefined ? {} : { body: json === undefined ? body : JSON.stringify(json) }),
    }), env, fake.fetch);
    return { status: result.status, headers: result.headers, data: result.headers.get('Content-Type')?.includes('application/json') ? await result.json() : new Uint8Array(await result.arrayBuffer()) };
  }
  async function register(email = 'writer@example.com') {
    const result = await request('/auth/signup', { method: 'POST', json: { email, password } });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  }
  return { fake, env, request, register };
}

async function upload(context, user, projectId, extension, bytes) {
  const file = `${digest(bytes)}.${extension}`;
  const result = await context.request(`/assets/${projectId}/${file}`, { method: 'PUT', token: tokenFor(user), body: bytes });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return { file, path: result.data.path };
}

function signedToken(env, payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', env.SESSION_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

test('registers isolated private-repository accounts, hashes passwords, and checks/revokes signed sessions', async () => {
  const context = harness();
  const { request, fake, env, register } = context;
  const alice = await register(' Alice@Example.com ');
  const bob = await register('bob@example.com');
  assert.equal(alice.user.email, 'alice@example.com');
  assert.equal(alice.user.id, digest('alice@example.com'));
  assert.notEqual(alice.user.id, bob.user.id);
  const root = `write-then-publish/users/${alice.user.id}`;
  const account = fake.json(`${root}/account.json`);
  assert.equal(account.password.algorithm, 'PBKDF2-SHA256');
  assert.equal(account.password.iterations, 100000);
  assert.equal(Buffer.from(account.password.salt, 'base64').length, 16);
  assert.equal(Buffer.from(account.password.hash, 'base64').length, 32);
  for (const content of fake.snapshotFiles().values()) assert.ok(!Buffer.from(content).includes(Buffer.from(password)), 'plaintext password is never committed');
  assert.deepEqual(fake.json(`${root}/projects/index.json`).projects, []);
  assert.ok(fake.json(`write-then-publish/users/${bob.user.id}/profile.json`));
  assert.equal((await request('/auth/signup', { method: 'POST', json: { email: 'alice@example.com', password } })).status, 409);
  assert.equal((await request('/auth/signin', { method: 'POST', json: { email: 'alice@example.com', password: 'wrong-password' } })).status, 401);
  const login = await request('/auth/signin', { method: 'POST', json: { email: 'ALICE@example.com', password } });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.id, alice.user.id);
  assert.equal((await request('/auth/session', { token: tokenFor(alice) })).data.session.user.id, alice.user.id);
  assert.equal((await request('/auth/session')).status, 401);
  const parts = tokenFor(alice).split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  const forged = [parts[0], Buffer.from(JSON.stringify({ ...payload, sub: bob.user.id, email: bob.user.email })).toString('base64url'), parts[2]].join('.');
  assert.equal((await request('/auth/session', { token: forged })).status, 401);
  assert.equal((await request('/auth/session', { token: signedToken(env, { ...payload, exp: Math.floor(Date.now() / 1000) - 1 }) })).status, 401);
  assert.equal((await request('/auth/session', { token: signedToken(env, { ...payload, aud: 'another-app' }) })).status, 401);
  assert.equal((await request('/auth/signout', { method: 'POST', token: tokenFor(alice) })).status, 200);
  assert.equal((await request('/auth/session', { token: tokenFor(alice) })).status, 401);
  assert.equal((await request('/auth/session', { token: tokenFor(login.data) })).status, 200, 'signout preserves another device session');
  assert.equal((await request('/auth/session', { token: tokenFor(bob) })).status, 200);
  assert.equal((await request('/auth/signin', { method: 'POST', json: { email: alice.user.email, password } })).status, 200);
  assert.ok(fake.requests.filter(call => call.method === 'PATCH').every(call => call.body.force === false));
});

test('profile, split Markdown projects, exact media round trips, revisions, isolation, and deletion', async () => {
  const context = harness();
  const { request, fake, register } = context;
  const alice = await register('project-alice@example.com');
  const bob = await register('project-bob@example.com');
  const token = tokenFor(alice);
  const profile = { displayName: '  作家 Alice  ', avatarUrl: 'data:image/png;base64,iVBORw0KGgo=' };
  const profileResult = await request('/profile', { method: 'PUT', token, json: profile });
  assert.equal(profileResult.status, 200);
  assert.equal((await request('/profile', { token })).data.display_name, '作家 Alice');
  assert.equal((await request('/profile', { token: tokenFor(bob) })).data.display_name, '');
  assert.equal((await request('/profile', { method: 'PUT', token, json: { displayName: 'X', avatarUrl: 'https://untrusted.example/a.svg' } })).status, 400);
  const projectId = 'draft-one';
  const media = [
    { extension: 'png', type: 'image/png', bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128, 65]) },
    { extension: 'gif', type: 'image/gif', bytes: Uint8Array.from([...Buffer.from('GIF89a'), 0, 1, 254, 255, 0, 59]) },
    { extension: 'mp4', type: 'video/mp4', bytes: Uint8Array.from([0, 0, 0, 24, ...Buffer.from('ftypisom'), 0, 128, 255, 0, 10]) },
  ];
  const paths = [];
  for (const item of media) {
    const result = await upload(context, alice, projectId, item.extension, item.bytes);
    paths.push(result.path);
    const downloaded = await request(`/assets?path=${encodeURIComponent(result.path)}`, { token });
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get('Content-Type'), item.type);
    assert.match(downloaded.headers.get('Cache-Control'), /private.*no-store/);
    assert.deepEqual(downloaded.data, item.bytes);
    assert.deepEqual(fake.snapshotFiles().get(result.path), item.bytes, 'repository holds original bytes');
    assert.equal((await request(`/assets?path=${encodeURIComponent(result.path)}`, { token: tokenFor(bob) })).status, 403);
  }
  const badName = await request(`/assets/${projectId}/${'0'.repeat(64)}.png`, { method: 'PUT', token, body: media[0].bytes });
  assert.equal(badName.status, 400);
  assert.equal((await request(`/assets/${projectId}/${digest(new Uint8Array())}.png`, { method: 'PUT', token, body: new Uint8Array() })).status, 400);
  const content = '# 明文文章\n\n你好，GitHub。\n\n![动图](asset:gif)\n\n```js\nconst price = "$9";\n```\n';
  const data = { content, images: { png: { storagePath: paths[0], originalName: '中文 图片.png' }, gif: { storagePath: paths[1] }, clip: { videoStoragePath: paths[2] } }, theme: 'warm', customSetting: { width: 1080 } };
  const first = await request(`/projects/${projectId}`, { method: 'PUT', token, json: { title: '第一篇文章', data } });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const base = `write-then-publish/users/${alice.user.id}/projects/${projectId}`;
  assert.equal(fake.text(`${base}/content.md`), content);
  assert.equal(fake.json(`${base}/project.json`).title, '第一篇文章');
  assert.equal(fake.json(`${base}/project.json`).data.content, undefined, 'content is split from metadata');
  assert.deepEqual(fake.json(`${base}/project.json`).data.customSetting, { width: 1080 });
  assert.equal(fake.json(`write-then-publish/users/${alice.user.id}/projects/index.json`).projects[0].id, projectId);
  const listed = await request('/projects', { token });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data[0].data, data);
  assert.deepEqual((await request('/projects', { token: tokenFor(bob) })).data, []);
  assert.equal((await request(`/projects/${projectId}`, { method: 'PUT', token, json: { title: 'stale', data } })).data.code, 'revision_conflict');
  const second = await request(`/projects/${projectId}`, { method: 'PUT', token, json: { title: '已编辑', data: { ...data, content: `${content}\n第二版` }, revision: first.data.revision } });
  assert.equal(second.status, 200);
  assert.notEqual(second.data.revision, first.data.revision);
  assert.equal((await request(`/projects/${projectId}`, { method: 'DELETE', token, json: { revision: first.data.revision } })).status, 409);
  const foreignPath = `write-then-publish/users/${bob.user.id}/projects/${projectId}/assets/${digest(media[0].bytes)}.png`;
  assert.equal((await request('/projects/foreign', { method: 'PUT', token, json: { title: 'invalid', data: { content: '', images: { bad: { storagePath: foreignPath } } } } })).status, 400);
  assert.equal((await request('/projects/another-project', { method: 'PUT', token, json: { title: 'invalid', data } })).status, 400, 'assets must belong to the same project');
  for (const path of [`${base}/../../account.json`, `${base}/project.json`, `write-then-publish/users/${bob.user.id}/account.json`]) {
    assert.equal((await request(`/assets?path=${encodeURIComponent(path)}`, { token })).status, 403);
  }
  const bobProject = await request(`/projects/${projectId}`, { method: 'PUT', token: tokenFor(bob), json: { title: 'Bob 独立的同名项目', data: { content: 'Bob 独立内容', images: {} } } });
  assert.equal(bobProject.status, 200);
  assert.equal((await request(`/projects/${projectId}`, { method: 'DELETE', token, json: { revision: second.data.revision } })).status, 200);
  assert.ok(!Array.from(fake.snapshotFiles().keys()).some(path => path.startsWith(`${base}/`)), 'delete removes Markdown, metadata, and media');
  assert.deepEqual((await request('/projects', { token })).data, []);
  assert.equal((await request('/projects', { token: tokenFor(bob) })).data[0].data.content, 'Bob 独立内容');
  assert.ok(fake.text('README.md'), 'unrelated repository files survive');
});

test('concurrent users and concurrent projects preserve every write through fast-forward retry', async () => {
  const context = harness();
  context.fake.barrierRefUpdates(2);
  const [alice, bob] = await Promise.all([context.register('concurrent-alice@example.com'), context.register('concurrent-bob@example.com')]);
  assert.ok(context.fake.refConflicts >= 1, 'registration encountered a real non-fast-forward race');
  for (const user of [alice, bob]) assert.ok(context.fake.json(`write-then-publish/users/${user.user.id}/account.json`));
  context.fake.barrierRefUpdates(2);
  const results = await Promise.all(['first', 'second'].map(id => context.request(`/projects/${id}`, { method: 'PUT', token: tokenFor(alice), json: { title: id, data: { content: `${id} markdown`, images: {} } } })));
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  const list = await context.request('/projects', { token: tokenFor(alice) });
  assert.deepEqual(list.data.map(project => project.id).sort(), ['first', 'second']);
  assert.equal(context.fake.json(`write-then-publish/users/${alice.user.id}/projects/index.json`).projects.length, 2);
  const existing = list.data[0];
  context.fake.barrierRefUpdates(2);
  const sameProject = await Promise.all(['edit-one', 'edit-two'].map(content => context.request(`/projects/${existing.id}`, { method: 'PUT', token: tokenFor(alice), json: { title: content, data: { content }, revision: existing.revision } })));
  assert.deepEqual(sameProject.map(result => result.status).sort(), [200, 409], 'same revision permits one winner and reports the other conflict');
  assert.ok(context.fake.refConflicts >= 3);
});

test('rejects public repositories, upstream authorization/rate/network errors, and cross-site mutations without leaking credentials', async () => {
  const publicContext = harness({ private: false });
  const publicResult = await publicContext.request('/auth/signup', { method: 'POST', json: { email: 'public@example.com', password } });
  assert.equal(publicResult.status, 503);
  assert.equal(publicResult.data.code, 'public_repository');
  assert.equal(publicContext.fake.snapshotFiles().size, 1);
  for (const failure of [
    { status: 429, expected: 429, code: 'github_rate_limit' },
    { status: 403, headers: { 'x-ratelimit-remaining': '0' }, expected: 429, code: 'github_rate_limit' },
    { status: 403, headers: { 'retry-after': '60' }, expected: 429, code: 'github_rate_limit' },
    { status: 401, expected: 503, code: 'github_authorization' },
    { status: 403, expected: 503, code: 'github_authorization' },
    { status: 404, expected: 503, code: 'github_configuration' },
    { status: 500, expected: 503, code: 'github_unavailable' },
    { throw: true, expected: 503, code: 'github_unavailable' },
  ]) {
    const context = harness();
    context.fake.failNext({ method: 'GET', path: '', ...failure });
    const result = await context.request('/auth/signin', { method: 'POST', json: { email: `${failure.status || 'network'}-${failure.code}@example.com`, password } });
    assert.equal(result.status, failure.expected);
    assert.equal(result.data.code, failure.code);
    assert.ok(!JSON.stringify(result.data).includes(context.fake.token));
    assert.ok(!JSON.stringify(result.data).includes(context.fake.repo));
  }
  const context = harness();
  for (const headers of [{ Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const result = await context.request('/auth/signup', { method: 'POST', json: { email: 'origin@example.com', password }, headers });
    assert.equal(result.status, 403);
    assert.equal(result.data.code, 'cross_origin');
  }
  assert.equal(context.fake.requests.length, 0);
  assert.equal((await context.request('/auth/signup', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await context.request('/auth/signup', { method: 'POST', body: 'broken JSON', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await context.request('/auth/signup', { method: 'POST', json: { email: 'invalid', password } })).status, 400);
  const missingRateLimit = harness({ env: { AUTH_RATE_LIMIT: undefined } });
  assert.equal((await missingRateLimit.request('/auth/signup', { method: 'POST', json: { email: 'limit@example.com', password } })).status, 503);
  const blocked = harness({ env: { AUTH_RATE_LIMIT: { async limit() { return { success: false }; } } } });
  assert.equal((await blocked.request('/auth/signin', { method: 'POST', json: { email: 'blocked@example.com', password } })).status, 429);
});

test('failed commits leave the visible project intact, cap conflict retries, and reject oversized input', async () => {
  const context = harness();
  const user = await context.register('atomic-writer@example.com');
  const token = tokenFor(user);
  const original = { title: 'Original', data: { content: 'Original Markdown', images: {} } };
  const first = await context.request('/projects/atomic', { method: 'PUT', token, json: original });
  assert.equal(first.status, 200);
  const modified = { title: 'Changed', data: { content: 'Changed Markdown', images: {} }, revision: first.data.revision };
  for (const path of ['/git/trees', '/git/commits', '/git/refs/heads/main']) {
    const head = context.fake.head;
    context.fake.failNext({ method: path.includes('/refs/') ? 'PATCH' : 'POST', path, status: 429 });
    const result = await context.request('/projects/atomic', { method: 'PUT', token, json: modified });
    assert.equal(result.status, 429);
    assert.equal(context.fake.head, head, 'unpublished tree/commit objects never change visible HEAD');
    const list = await context.request('/projects', { token });
    assert.equal(list.data[0].title, original.title);
    assert.equal(list.data[0].data.content, original.data.content);
    assert.equal(list.data[0].revision, first.data.revision);
  }
  const refUpdates = () => context.fake.requests.filter(call => call.method === 'PATCH').length;
  const before = refUpdates();
  for (let retry = 0; retry < 4; retry++) context.fake.failNext({ method: 'PATCH', path: '/git/refs/heads/main', status: 422 });
  const exhausted = await context.request('/projects/atomic', { method: 'PUT', token, json: modified });
  assert.equal(exhausted.status, 409);
  assert.equal(exhausted.data.code, 'git_conflict');
  assert.equal(refUpdates() - before, 4, 'bounded retry stops at four attempts');
  assert.equal((await context.request('/projects/atomic', { method: 'PUT', token, json: modified })).status, 200, 'original revision remains saveable after failures');
  const oversizedProject = await context.request('/projects/oversized', { method: 'PUT', token, json: { title: 'large', data: { content: 'x' } }, headers: { 'Content-Length': String(4 * 1024 * 1024 + 1) } });
  assert.equal(oversizedProject.status, 413);
  const content = Uint8Array.from([1, 2, 3]);
  const oversizedAsset = await context.request(`/assets/atomic/${digest(content)}.png`, { method: 'PUT', token, body: content, headers: { 'Content-Length': String(10 * 1024 * 1024 + 1) } });
  assert.equal(oversizedAsset.status, 413);
  context.fake.failNext({ method: 'GET', path: /^\/git\/trees\//, status: 200, body: { truncated: true, tree: [] } });
  const truncated = await context.request('/projects', { token });
  assert.equal(truncated.status, 503);
  assert.equal(truncated.data.code, 'tree_too_large');
});

test('Worker config publishes only provider/API details and fails closed for invalid environment variables', async () => {
  const { env, fake } = harness({ branch: 'storage/main', env: { GITHUB_DATA_PREFIX: 'writing/data' } });
  assert.deepEqual(storageConfiguration(env), { provider: 'github', apiBase: '/api/storage' });
  const result = await worker.fetch(new Request('https://writing.example/api/storage/config.js'), env);
  assert.equal(result.status, 200);
  assert.match(result.headers.get('Content-Type'), /javascript/);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  const source = await result.text();
  assert.match(source, /provider.*github/);
  for (const secret of [fake.token, env.SESSION_SECRET, env.GITHUB_OWNER, env.GITHUB_REPO]) assert.ok(!source.includes(secret));
  for (const overrides of [
    { STORAGE_PROVIDER: 'unknown' }, { GITHUB_TOKEN: '' }, { SESSION_SECRET: 'too-short' },
    { GITHUB_OWNER: '../owner' }, { GITHUB_REPO: 'repo/name' }, { GITHUB_DATA_PREFIX: '../escape' },
    { GITHUB_DATA_PREFIX: '.git/config' }, { GITHUB_BRANCH: 'unsafe..branch' }, { GITHUB_BRANCH: 'a/.hidden' },
  ]) {
    const invalid = { ...env, ...overrides };
    assert.equal(storageConfiguration(invalid).provider, 'disabled');
    const invalidResult = await worker.fetch(new Request('https://writing.example/api/storage/config.js'), invalid);
    const invalidSource = await invalidResult.text();
    assert.ok(!invalidSource.includes(fake.token));
    assert.ok(!invalidSource.includes(env.SESSION_SECRET));
    const apiResult = await handleStorageRequest(new Request('https://writing.example/api/storage/auth/session'), invalid, fake.fetch);
    assert.equal(apiResult.status, 503);
  }
  const staticResponse = await worker.fetch(new Request('https://writing.example/src/app.js'), { ...env, ASSETS: { fetch() { return new Response('existing source', { headers: { 'Content-Type': 'text/javascript' } }); } } });
  assert.equal(await staticResponse.text(), 'existing source');
  const localResponse = await worker.fetch(new Request('https://writing.example/?mode=local'), { ...env, ASSETS: { fetch() { return new Response('<html>Existing local interface</html>', { headers: { 'Content-Type': 'text/html' } }); } } });
  assert.equal(await localResponse.text(), '<html>Existing local interface</html>');
});
