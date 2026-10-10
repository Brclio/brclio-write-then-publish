import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { handleStorageRequest } from '../cloudflare/github-storage.mjs';
import { createFakeGitHub, fakeGitHubEnvironment } from './helpers/fake_github.mjs';

const password = 'pagination-test-password';
function harness() {
  const fake = createFakeGitHub();
  const env = fakeGitHubEnvironment(fake);
  const messages = [];
  async function request(route, { token, method = 'GET', json } = {}) {
    const before = fake.requests.length;
    const response = await handleStorageRequest(new Request(`https://write.example/api/storage${route}`, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) },
      ...(json ? { body: JSON.stringify(json) } : {}),
    }), env, fake.fetch, { sendVerificationEmail: async (_, message) => { messages.push(message); } });
    return { status: response.status, data: await response.json(), gitCalls: fake.requests.length - before };
  }
  async function register(email) {
    assert.equal((await request('/auth/signup-code', { method: 'POST', json: { email } })).status, 200);
    const result = await request('/auth/signup', { method: 'POST', json: { email, password, code: messages.findLast(item => item.email === email).code } });
    assert.equal(result.status, 200);
    return result.data.session.access_token;
  }
  async function seed(token, count = 24) {
    for (let index = 0; index < count; index++) {
      const id = `project_${String(index).padStart(2, '0')}`;
      const result = await request(`/projects/${id}`, { token, method: 'PUT', json: { title: `稿件 ${index}`, data: { content: `# 稿件 ${index}\n\n原始快照内容。`, fontSize: 32 + index, images: {} } } });
      assert.equal(result.status, 200);
    }
  }
  return { fake, env, request, register, seed };
}

test('24 drafts page in bounded requests and stay on one Git snapshot across insert, edit and delete', async () => {
  const context = harness();
  const token = await context.register('pagination-writer@example.com');
  await context.seed(token);
  const legacy = await context.request('/projects', { token });
  assert.equal(legacy.status, 200);
  assert.ok(Array.isArray(legacy.data), 'no pagination query preserves the existing API');
  assert.equal(legacy.data.length, 24);
  const first = await context.request('/projects?limit=8', { token });
  assert.equal(first.status, 200);
  assert.equal(first.data.projects.length, 8);
  assert.ok(first.data.next_cursor);
  assert.ok(first.gitCalls <= 50, `first page used ${first.gitCalls} GitHub calls`);
  assert.deepEqual(first.data.projects, legacy.data.slice(0, 8));

  // Change records that have not yet appeared in the first page, and move the
  // branch/index order. Following a moving HEAD would skip or duplicate drafts.
  const edited = legacy.data[12];
  const removed = legacy.data[19];
  assert.equal((await context.request(`/projects/${edited.id}`, { token, method: 'PUT', json: { title: '另一设备修改', data: { ...edited.data, content: '另一设备的新正文。' }, revision: edited.revision } })).status, 200);
  assert.equal((await context.request(`/projects/${removed.id}`, { token, method: 'DELETE', json: { revision: removed.revision } })).status, 200);
  assert.equal((await context.request('/projects/new_during_pagination', { token, method: 'PUT', json: { title: '分页中插入', data: { content: '下一轮才应出现。', images: {} } } })).status, 200);

  const pages = [first];
  while (pages.at(-1).data.next_cursor) {
    const page = await context.request(`/projects?cursor=${encodeURIComponent(pages.at(-1).data.next_cursor)}`, { token });
    assert.equal(page.status, 200);
    assert.ok(page.gitCalls <= 50, `changed-HEAD page used ${page.gitCalls} GitHub calls`);
    pages.push(page);
    assert.ok(pages.length <= 3);
  }
  assert.deepEqual(pages.map(page => page.data.projects.length), [8, 8, 8]);
  const collected = pages.flatMap(page => page.data.projects);
  assert.deepEqual(collected, legacy.data, 'every row, Markdown and revision comes from the first immutable commit');
  assert.equal(new Set(collected.map(row => row.id)).size, 24);
  assert.equal(collected.find(row => row.id === removed.id).data.content, removed.data.content, 'a concurrent deletion does not drop an earlier snapshot row');
  const fresh = await context.request('/projects?limit=8', { token });
  assert.ok(fresh.data.projects.some(row => row.id === 'new_during_pagination'), 'a new first page starts at the latest branch');
  console.log(`Pagination GitHub calls: ${pages.map(page => page.gitCalls).join(', ')}; 24 complete drafts`);
});

test('pagination rejects malformed, expired and cross-user/session cursors and respects current revocation', async () => {
  const context = harness();
  const alice = await context.register('pagination-alice@example.com');
  const bob = await context.register('pagination-bob@example.com');
  await context.seed(alice, 9);
  const first = await context.request('/projects?limit=8', { token: alice });
  const cursor = first.data.next_cursor;
  assert.ok(cursor);
  for (const query of ['limit=0', 'limit=9', 'limit=1.5', 'limit=08', 'limit=8&limit=8', 'cursor=', 'cursor=../escape', `cursor=${encodeURIComponent(cursor)}&limit=8`, `cursor=${encodeURIComponent(cursor)}&cursor=${encodeURIComponent(cursor)}`]) {
    const result = await context.request(`/projects?${query}`, { token: alice });
    assert.equal(result.status, 400, query);
    assert.equal(result.data.code, 'invalid_cursor');
    assert.equal(result.gitCalls, 0, 'invalid input fails before GitHub reads');
  }
  const foreign = await context.request(`/projects?cursor=${encodeURIComponent(cursor)}`, { token: bob });
  assert.equal(foreign.status, 400);
  assert.equal(foreign.data.code, 'invalid_cursor');
  assert.equal(foreign.gitCalls, 0);
  const login = await context.request('/auth/signin', { method: 'POST', json: { email: 'pagination-alice@example.com', password } });
  assert.equal(login.status, 200);
  assert.equal((await context.request(`/projects?cursor=${encodeURIComponent(cursor)}`, { token: login.data.session.access_token })).data.code, 'invalid_cursor', 'a cursor is bound to the exact listing session');
  const [body] = cursor.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  for (const override of [{ offset: -1 }, { offset: 1008 }, { offset: 7 }, { limit: 9 }, { commit: '../escape' }]) {
    const modified = Buffer.from(JSON.stringify({ ...payload, ...override })).toString('base64url');
    const signature = createHmac('sha256', context.env.SESSION_SECRET).update(`project-page\0${modified}`).digest('base64url');
    assert.equal((await context.request(`/projects?cursor=${encodeURIComponent(`${modified}.${signature}`)}`, { token: alice })).data.code, 'invalid_cursor');
  }
  const modified = Buffer.from(JSON.stringify({ ...payload, offset: 16 })).toString('base64url');
  assert.equal((await context.request(`/projects?cursor=${encodeURIComponent(`${modified}.${cursor.split('.')[1]}`)}`, { token: alice })).data.code, 'invalid_cursor', 'changing an offset without re-signing is rejected');
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 901000;
    const expired = await context.request(`/projects?cursor=${encodeURIComponent(cursor)}`, { token: alice });
    assert.equal(expired.status, 410);
    assert.equal(expired.data.code, 'cursor_expired');
    assert.equal(expired.gitCalls, 0);
  } finally { Date.now = originalNow; }
  assert.equal((await context.request('/auth/signout', { token: alice, method: 'POST' })).status, 200);
  const revoked = await context.request(`/projects?cursor=${encodeURIComponent(cursor)}`, { token: alice });
  assert.equal(revoked.status, 401, 'authorization reads the latest account, not the cursor snapshot account');
  assert.equal(revoked.data.code, 'unauthorized');
  assert.equal((await context.request('/projects?limit=8', { token: login.data.session.access_token })).status, 200, 'another device session remains authorized');
});

test('empty and small pages terminate cleanly without requesting empty follow-up pages', async () => {
  const context = harness();
  const token = await context.register('pagination-empty@example.com');
  assert.deepEqual((await context.request('/projects?limit=8', { token })).data, { projects: [], next_cursor: null });
  await context.seed(token, 3);
  const rows = [];
  let route = '/projects?limit=1';
  for (let count = 0; route; count++) {
    assert.ok(count < 3);
    const page = await context.request(route, { token });
    assert.equal(page.data.projects.length, 1);
    rows.push(...page.data.projects);
    route = page.data.next_cursor ? `/projects?cursor=${encodeURIComponent(page.data.next_cursor)}` : '';
  }
  assert.equal(new Set(rows.map(row => row.id)).size, 3);
});
