import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createFakeGitHub, fakeGitHubEnvironment } from './helpers/fake_github.mjs';

const staticHtml = await readFile('index.html', 'utf8');
const staticCss = await readFile('src/styles.css', 'utf8');
const modules = await Promise.all(['worker.mjs', 'github-storage.mjs'].map(async name => ({
  type: 'ESModule', path: path.resolve('cloudflare', name), contents: await readFile(`cloudflare/${name}`, 'utf8'),
})));
const github = createFakeGitHub();
const bindings = fakeGitHubEnvironment(github);
delete bindings.AUTH_RATE_LIMIT;
async function assets(request) {
  const url = new URL(request.url);
  if (url.pathname === '/' || url.pathname === '/index.html') return new Response(staticHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  if (url.pathname === '/src/styles.css') return new Response(staticCss, { headers: { 'Content-Type': 'text/css' } });
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
  await runtime.setOptions(convertV4MiniflareOptions({
    name: 'storage-runtime-test',
    modules,
    compatibilityDate: '2026-10-10', serviceBindings: { ASSETS: assets },
    bindings,
    outboundService: async request => github.fetch(request.url, {
      method: request.method, headers: Object.fromEntries(request.headers),
      ...(!['GET', 'HEAD'].includes(request.method) ? { body: await request.text() } : {}),
    }),
    ratelimits: { AUTH_RATE_LIMIT: { namespace_id: '1001', simple: { limit: 10, period: 60 } } },
  }));
  const html = await (await runtime.dispatchFetch('https://app.example/')).text();
  assert.match(html, /src="\/api\/storage\/config.js"/);
  assert.match(html, /src="\/src\/github-storage.js"/);
  assert.equal(html.replace('<script src="/api/storage/config.js"></script><script src="/src/github-storage.js"></script>', ''), staticHtml);
  assert.equal(await (await runtime.dispatchFetch('https://app.example/?mode=local')).text(), staticHtml);
  assert.equal(await (await runtime.dispatchFetch('https://app.example/src/styles.css')).text(), staticCss);
  const config = await runtime.dispatchFetch('https://app.example/api/storage/config.js');
  assert.equal(config.headers.get('cache-control'), 'no-store');
  const script = await config.text();
  assert.match(script, /"provider":"github"/);
  assert.ok(!script.includes(github.token));
  assert.ok(!script.includes(bindings.SESSION_SECRET));
  assert.doesNotMatch(script, /GITHUB_TOKEN|SESSION_SECRET|private-writing-data/);
  const signup = await runtime.dispatchFetch('https://app.example/api/storage/auth/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'runtime@example.com', password: 'test-runtime-password' }),
  });
  assert.equal(signup.status, 200, await signup.clone().text());
  const { session } = await signup.json();
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` };
  const save = await runtime.dispatchFetch('https://app.example/api/storage/projects/runtime-draft', {
    method: 'PUT', headers, body: JSON.stringify({ title: '真实运行时', data: { content: '# Markdown 正文', images: {} } }),
  });
  assert.equal(save.status, 200, await save.clone().text());
  const list = await runtime.dispatchFetch('https://app.example/api/storage/projects', { headers });
  assert.equal((await list.json())[0].data.content, '# Markdown 正文');
  console.log('OK: workerd registration/save/read through native fetch; HTML injection, local/default modes and CSS unchanged; config contains no secrets');
} finally {
  await runtime.dispose();
}
