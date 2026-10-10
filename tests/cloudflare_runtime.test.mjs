import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createFakeGitHub, fakeGitHubEnvironment } from './helpers/fake_github.mjs';

const staticHtml = await readFile('index.html', 'utf8');
const staticCss = await readFile('src/styles.css', 'utf8');
const staticSitemap = await readFile('sitemap.xml', 'utf8');
const staticRobots = await readFile('robots.txt', 'utf8');
const modules = await Promise.all(['worker.mjs', 'github-storage.mjs', 'smtp.mjs'].map(async name => ({
  type: 'ESModule', path: path.resolve('cloudflare', name), contents: await readFile(`cloudflare/${name}`, 'utf8'),
})));
// Run the real auth/storage/SMTP configuration in workerd. Only replace the
// delivery boundary; SMTP protocol and socket behavior have dedicated tests.
const smtpModule = modules.find(module => module.path.endsWith('/smtp.mjs'));
const originalSmtp = smtpModule.contents;
smtpModule.contents = smtpModule.contents.replace(/export\s+async\s+function\s+sendVerificationEmail\b/, 'async function sendVerificationEmailViaSmtp');
assert.notEqual(smtpModule.contents, originalSmtp, 'SMTP delivery export is intercepted only for this runtime fixture');
smtpModule.contents += `\nexport async function sendVerificationEmail(env, message) {
  const response = await fetch('https://mail.test/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message),
  });
  if (!response.ok) throw new Error('Injected SMTP delivery failure');
}\n`;
const github = createFakeGitHub();
const bindings = fakeGitHubEnvironment(github);
delete bindings.AUTH_RATE_LIMIT;
const deliveries = [];
let rejectMail = false;
async function assets(request) {
  const url = new URL(request.url);
  if (url.pathname === '/' || url.pathname === '/index.html') return new Response(staticHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  if (url.pathname === '/src/styles.css') return new Response(staticCss, { headers: { 'Content-Type': 'text/css' } });
  if (url.pathname === '/sitemap.xml') return new Response(staticSitemap, { headers: { 'Content-Type': 'application/xml' } });
  if (url.pathname === '/robots.txt') return new Response(staticRobots, { headers: { 'Content-Type': 'text/plain' } });
  return new Response('Not found', { status: 404 });
}

const runtime = new Miniflare(convertV4MiniflareOptions({
  name: 'storage-runtime-test',
  modules,
  compatibilityDate: '2026-10-10',
  serviceBindings: { ASSETS: assets },
}));
try {
  const response = await runtime.dispatchFetch('https://app.example/');
  assert.equal(await response.text(), staticHtml, 'disabled deployment returns the original page byte for byte');
  assert.equal(await (await runtime.dispatchFetch('https://app.example/sitemap.xml')).text(), staticSitemap);
  assert.equal(await (await runtime.dispatchFetch('https://app.example/robots.txt')).text(), staticRobots);
  await runtime.setOptions(convertV4MiniflareOptions({
    name: 'storage-runtime-test',
    modules,
    compatibilityDate: '2026-10-10', serviceBindings: { ASSETS: assets },
    bindings,
    outboundService: async request => {
      if (new URL(request.url).origin === 'https://mail.test') {
        if (rejectMail) return new Response('Mail delivery rejected', { status: 503 });
        deliveries.push(await request.json());
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      }
      return github.fetch(request.url, {
        method: request.method, headers: Object.fromEntries(request.headers),
        ...(!['GET', 'HEAD'].includes(request.method) ? { body: await request.text() } : {}),
      });
    },
    ratelimits: { AUTH_RATE_LIMIT: { namespace_id: '1001', simple: { limit: 10, period: 60 } } },
  }));
  const html = await (await runtime.dispatchFetch('https://app.example/')).text();
  assert.match(html, /src="\/api\/storage\/config.js"/);
  assert.match(html, /src="\/src\/github-storage.js"/);
  assert.equal(html.replace('<script src="/api/storage/config.js"></script><script src="/src/github-storage.js"></script>', ''), staticHtml.replaceAll('https://fawen.fun', 'https://app.example'));
  assert.match(html, /rel="canonical" href="https:\/\/app\.example\/"/);
  assert.match(html, /property="og:url" content="https:\/\/app\.example\/"/);
  assert.match(html, /property="og:image" content="https:\/\/app\.example\/brand\/og-image\.png"/);
  assert.match(html, /name="twitter:image" content="https:\/\/app\.example\/brand\/og-image\.png"/);
  assert.equal(await (await runtime.dispatchFetch('https://app.example/sitemap.xml')).text(), staticSitemap.replaceAll('https://fawen.fun', 'https://app.example'));
  assert.equal(await (await runtime.dispatchFetch('https://app.example/robots.txt')).text(), staticRobots.replaceAll('https://fawen.fun', 'https://app.example'));
  assert.equal(await (await runtime.dispatchFetch('https://app.example/?mode=local')).text(), staticHtml);
  assert.equal(await (await runtime.dispatchFetch('https://app.example/src/styles.css')).text(), staticCss);
  const config = await runtime.dispatchFetch('https://app.example/api/storage/config.js');
  assert.equal(config.headers.get('cache-control'), 'no-store');
  const script = await config.text();
  assert.match(script, /"provider":"github"/);
  assert.ok(!script.includes(github.token));
  assert.ok(!script.includes(bindings.SESSION_SECRET));
  assert.ok(!script.includes(bindings.SMTP_PASSWORD));
  assert.doesNotMatch(script, /GITHUB_TOKEN|SESSION_SECRET|SMTP_PASSWORD|private-writing-data/);
  const credentials = { email: 'runtime@example.com', password: 'test-runtime-password' };
  const postAuth = (route, body, ip = '192.0.2.1') => runtime.dispatchFetch(`https://app.example/api/storage/auth/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify(body),
  });
  const unverified = await postAuth('signup', credentials);
  assert.equal(unverified.status, 400, await unverified.clone().text());
  assert.equal(deliveries.length, 0);
  assert.ok(!Array.from(github.snapshotFiles().keys()).some(name => name.includes('/users/')), 'unverified signup never creates an account');
  const sendCode = await postAuth('signup-code', { email: credentials.email });
  assert.equal(sendCode.status, 200, await sendCode.clone().text());
  const sent = await sendCode.json();
  assert.equal(sent.sent, true);
  assert.equal(sent.expires_in, 600);
  assert.equal(sent.retry_after, 60);
  assert.equal(deliveries.length, 1);
  const { code } = deliveries[0];
  assert.equal(deliveries[0].email, credentials.email);
  assert.match(code, /^\d{6}$/);
  assert.ok(!JSON.stringify(sent).includes(code), 'API never returns the email verification code');
  for (const [name, file] of github.snapshotFiles()) {
    if (name.endsWith('.json')) assert.doesNotMatch(Buffer.from(file).toString(), /"code"\s*:\s*"?\d{6}"?/, 'GitHub stores no plaintext verification code');
  }
  assert.ok(!Array.from(github.snapshotFiles().keys()).some(name => name.includes('/users/')), 'sending email does not create a user directory');
  const resend = await postAuth('signup-code', { email: credentials.email });
  assert.equal(resend.status, 429, await resend.clone().text());
  assert.equal(deliveries.length, 1, 'cooldown prevents another email');
  const wrongCode = await postAuth('signup', { ...credentials, code: code === '000000' ? '000001' : '000000' });
  assert.equal(wrongCode.status, 400, await wrongCode.clone().text());
  const signup = await postAuth('signup', { ...credentials, code });
  assert.equal(signup.status, 200, await signup.clone().text());
  const { session } = await signup.json();
  const reused = await postAuth('signup', { ...credentials, code });
  assert.ok([400, 409].includes(reused.status), 'a used code cannot register again');
  const signin = await postAuth('signin', credentials);
  assert.equal(signin.status, 200, await signin.clone().text());
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` };
  const save = await runtime.dispatchFetch('https://app.example/api/storage/projects/runtime-draft', {
    method: 'PUT', headers, body: JSON.stringify({ title: '真实运行时', data: { content: '# Markdown 正文', images: {} } }),
  });
  assert.equal(save.status, 200, await save.clone().text());
  const list = await runtime.dispatchFetch('https://app.example/api/storage/projects', { headers });
  assert.equal((await list.json())[0].data.content, '# Markdown 正文');
  rejectMail = true;
  const failedEmail = await postAuth('signup-code', { email: 'failed-mail@example.com' }, '192.0.2.2');
  assert.equal(failedEmail.status, 503, await failedEmail.clone().text());
  assert.equal(deliveries.length, 1);
  const failedBody = await failedEmail.text();
  assert.ok(!failedBody.includes(bindings.SMTP_PASSWORD));
  assert.ok(!failedBody.includes(bindings.SESSION_SECRET));
  const stillReadable = await runtime.dispatchFetch('https://app.example/api/storage/projects', { headers });
  assert.equal(stillReadable.status, 200, 'mail outage does not interrupt existing users');
  assert.equal((await stillReadable.json())[0].data.content, '# Markdown 正文');
  // The account adapter uses bounded pages so a 24-draft workspace fits the
  // Workers Free limit on every incoming request rather than one large list.
  for (let index = 1; index < 24; index++) {
    const draft = await runtime.dispatchFetch(`https://app.example/api/storage/projects/page-draft-${index}`, {
      method: 'PUT', headers, body: JSON.stringify({ title: `分页稿件 ${index}`, data: { content: `# 不同正文 ${index}`, images: {} } }),
    });
    assert.equal(draft.status, 200, await draft.clone().text());
  }
  const userRoot = `write-then-publish/users/${session.user.id}`;
  const expectedIndex = github.json(`${userRoot}/projects/index.json`).projects;
  assert.equal(expectedIndex.length, 24);
  const expectedRows = new Map(expectedIndex.map(project => [project.id, {
    ...github.json(`${userRoot}/projects/${project.id}/project.json`),
    content: github.text(`${userRoot}/projects/${project.id}/content.md`),
  }]));
  const pageRequestCounts = [];
  async function readPage(cursor) {
    const before = github.requests.length;
    const url = cursor ? `https://app.example/api/storage/projects?cursor=${encodeURIComponent(cursor)}` : 'https://app.example/api/storage/projects?limit=8';
    const response = await runtime.dispatchFetch(url, { headers });
    assert.equal(response.status, 200, await response.clone().text());
    const page = await response.json();
    assert.ok(Array.isArray(page.projects));
    assert.ok(page.projects.length <= 8);
    assert.ok(page.next_cursor === null || typeof page.next_cursor === 'string');
    const count = github.requests.length - before;
    assert.ok(count < 50, `each page must fit Workers Free: observed ${count} GitHub fetches`);
    pageRequestCounts.push(count);
    return page;
  }
  const firstPage = await readPage();
  assert.equal(firstPage.projects.length, 8);
  assert.equal(typeof firstPage.next_cursor, 'string');
  const oldCursor = firstPage.next_cursor;
  const edited = expectedIndex[10];
  const deleted = expectedIndex[18];
  const update = await runtime.dispatchFetch(`https://app.example/api/storage/projects/${edited.id}`, {
    method: 'PUT', headers, body: JSON.stringify({ title: '分页途中更新', data: { content: '# 分页之后的新版本', images: {} }, revision: edited.revision }),
  });
  assert.equal(update.status, 200, await update.clone().text());
  const deletion = await runtime.dispatchFetch(`https://app.example/api/storage/projects/${deleted.id}`, {
    method: 'DELETE', headers, body: JSON.stringify({ revision: deleted.revision }),
  });
  assert.equal(deletion.status, 200, await deletion.clone().text());
  const insertion = await runtime.dispatchFetch('https://app.example/api/storage/projects/inserted-during-pagination', {
    method: 'PUT', headers, body: JSON.stringify({ title: '分页途中插入', data: { content: '# 下一轮同步可见', images: {} } }),
  });
  assert.equal(insertion.status, 200, await insertion.clone().text());
  const rows = [...firstPage.projects];
  let cursor = oldCursor;
  while (cursor) {
    const page = await readPage(cursor);
    rows.push(...page.projects);
    cursor = page.next_cursor;
    assert.ok(pageRequestCounts.length <= 3, '24 drafts complete in exactly three pages');
  }
  assert.equal(rows.length, 24);
  assert.equal(new Set(rows.map(project => project.id)).size, 24);
  assert.deepEqual(rows.map(project => project.id), expectedIndex.map(project => project.id), 'insert/edit/delete between pages never skip, duplicate, or change snapshot rows');
  for (const project of rows) {
    const expected = expectedRows.get(project.id);
    assert.equal(project.title, expected.title);
    assert.equal(project.revision, expected.revision);
    assert.equal(project.data.content, expected.content);
  }
  const signout = await runtime.dispatchFetch('https://app.example/api/storage/auth/signout', { method: 'POST', headers });
  assert.equal(signout.status, 200, await signout.clone().text());
  const revokedPage = await runtime.dispatchFetch(`https://app.example/api/storage/projects?cursor=${encodeURIComponent(oldCursor)}`, { headers });
  assert.equal(revokedPage.status, 401, 'a signed old snapshot cursor cannot bypass current account session revocation');
  assert.equal(await (await runtime.dispatchFetch('https://app.example/?mode=local')).text(), staticHtml);
  assert.equal(await (await runtime.dispatchFetch('https://app.example/src/styles.css')).text(), staticCss);
  console.log(`OK: workerd email code, verified registration/login/save/read and mail outage; 24-draft stable pages use ${pageRequestCounts.join('/')} GitHub fetches and reject revoked sessions; HTML injection, local/default modes and CSS unchanged; config contains no secrets`);
} finally {
  await runtime.dispose();
}
