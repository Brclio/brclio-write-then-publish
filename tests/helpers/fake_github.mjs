import { createHash } from 'node:crypto';

const utf8 = new TextEncoder();
const text = new TextDecoder();
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});
const digest = value => createHash('sha1').update(value).digest('hex');
const bytes = value => typeof value === 'string' ? utf8.encode(value) : new Uint8Array(value);

/** In-memory Git Data API, including immutable trees/commits and fast-forward refs. */
export function createFakeGitHub(options = {}) {
  const owner = options.owner || 'writing-owner';
  const repo = options.repo || 'private-writing-data';
  const branch = options.branch || 'main';
  const token = options.token || 'github-secret-never-public';
  const blobs = new Map();
  const trees = new Map();
  const commits = new Map();
  const failures = [];
  const requests = [];
  let privateRepository = options.private !== false;
  let refBarrier;
  let refConflicts = 0;

  function storeBlob(value) {
    const content = bytes(value);
    const sha = digest(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]));
    blobs.set(sha, content);
    return sha;
  }
  function storeTree(files) {
    const directories = new Map();
    const direct = [];
    for (const [path, sha] of files) {
      const slash = path.indexOf('/');
      if (slash < 0) direct.push({ path, type: 'blob', mode: '100644', sha, size: blobs.get(sha).length });
      else {
        const name = path.slice(0, slash);
        if (!directories.has(name)) directories.set(name, new Map());
        directories.get(name).set(path.slice(slash + 1), sha);
      }
    }
    for (const [path, directory] of directories) direct.push({ path, type: 'tree', mode: '040000', sha: storeTree(directory) });
    direct.sort((a, b) => a.path.localeCompare(b.path));
    const sha = digest(JSON.stringify(direct));
    trees.set(sha, direct);
    return sha;
  }
  function flattenTree(sha, prefix = '', target = new Map()) {
    if (!trees.has(sha)) throw new Error(`Unknown tree ${sha}`);
    for (const entry of trees.get(sha)) {
      const path = `${prefix}${entry.path}`;
      if (entry.type === 'tree') flattenTree(entry.sha, `${path}/`, target);
      else target.set(path, entry.sha);
    }
    return target;
  }
  function storeCommit(tree, parents, message) {
    const sha = digest(JSON.stringify({ tree, parents, message, sequence: commits.size }));
    commits.set(sha, { sha, tree: { sha: tree }, parents: parents.map(sha => ({ sha })), message });
    return sha;
  }
  const seedFiles = new Map(Object.entries(options.files || { 'README.md': '# Private writing storage\n' }).map(([path, value]) => [path, storeBlob(value)]));
  let head = storeCommit(storeTree(seedFiles), [], 'Initialize private repository');

  function isAncestor(ancestor, child) {
    if (ancestor === child) return true;
    return commits.get(child)?.parents.some(parent => isAncestor(ancestor, parent.sha)) || false;
  }
  function recursiveEntries(sha, prefix = '', target = []) {
    for (const entry of trees.get(sha)) {
      const item = { ...entry, path: `${prefix}${entry.path}` };
      target.push(item);
      if (entry.type === 'tree') recursiveEntries(entry.sha, `${item.path}/`, target);
    }
    return target;
  }

  const fake = {
    owner, repo, branch, token, requests,
    get head() { return head; },
    get refConflicts() { return refConflicts; },
    setPrivate(value) { privateRepository = value; },
    failNext(failure) { failures.push(failure); },
    barrierRefUpdates(participants = 2) {
      let release;
      const ready = new Promise(resolve => { release = resolve; });
      refBarrier = { participants, arrived: 0, ready, release };
    },
    snapshotFiles() {
      return new Map(Array.from(flattenTree(commits.get(head).tree.sha), ([path, sha]) => [path, new Uint8Array(blobs.get(sha))]));
    },
    text(path) {
      const content = fake.snapshotFiles().get(path);
      return content ? text.decode(content) : null;
    },
    json(path) {
      const content = fake.text(path);
      return content === null ? null : JSON.parse(content);
    },
    async fetch(input, init = {}) {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const method = (init.method || input.method || 'GET').toUpperCase();
      const headers = new Headers(init.headers || input.headers);
      const rawBody = init.body === undefined && typeof input.clone === 'function' ? await input.clone().text() : init.body;
      const body = rawBody === undefined || rawBody === '' ? undefined : JSON.parse(rawBody);
      const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      if (url.origin !== 'https://api.github.com' || !url.pathname.startsWith(base)) return response({ message: 'Not Found' }, 404);
      const path = decodeURIComponent(url.pathname.slice(base.length));
      requests.push({ method, path, search: url.search, body, headers });
      const failureIndex = failures.findIndex(failure => (!failure.method || failure.method === method)
        && (!failure.path || (failure.path instanceof RegExp ? failure.path.test(path) : failure.path === path)));
      if (failureIndex >= 0) {
        const failure = failures.splice(failureIndex, 1)[0];
        if (failure.throw) throw new Error('Injected upstream network failure');
        return response(failure.body || { message: 'Injected upstream failure', secret: token }, failure.status || 503, failure.headers);
      }
      if (headers.get('Authorization') !== `Bearer ${token}`) return response({ message: 'Bad credentials' }, 401);
      if (method === 'GET' && path === '') return response({ private: privateRepository, default_branch: branch, full_name: `${owner}/${repo}` });
      if (method === 'GET' && path === `/git/ref/heads/${branch}`) return response({ ref: `refs/heads/${branch}`, object: { type: 'commit', sha: head } });
      if (method === 'GET' && path.startsWith('/git/commits/')) {
        const commit = commits.get(path.slice('/git/commits/'.length));
        return commit ? response(commit) : response({ message: 'Not Found' }, 404);
      }
      if (method === 'GET' && path.startsWith('/git/trees/')) {
        const sha = path.slice('/git/trees/'.length);
        return trees.has(sha) ? response({ sha, truncated: false, tree: url.searchParams.get('recursive') ? recursiveEntries(sha) : trees.get(sha) }) : response({ message: 'Not Found' }, 404);
      }
      if (method === 'GET' && path.startsWith('/git/blobs/')) {
        const sha = path.slice('/git/blobs/'.length);
        const content = blobs.get(sha);
        return content ? response({ sha, size: content.length, encoding: 'base64', content: Buffer.from(content).toString('base64').replace(/.{1,60}/g, '$&\n') }) : response({ message: 'Not Found' }, 404);
      }
      if (method === 'POST' && path === '/git/blobs') {
        if (body.encoding !== 'base64') return response({ message: 'Unsupported blob encoding' }, 422);
        return response({ sha: storeBlob(Buffer.from(body.content, 'base64')) }, 201);
      }
      if (method === 'POST' && path === '/git/trees') {
        if (!trees.has(body.base_tree)) return response({ message: 'Unknown base tree' }, 422);
        const files = flattenTree(body.base_tree);
        for (const entry of body.tree) {
          if (entry.type !== 'blob' || entry.mode !== '100644') return response({ message: 'Unsupported tree entry' }, 422);
          if (entry.sha === null) {
            if (!files.delete(entry.path)) return response({ message: 'Cannot delete missing path' }, 422);
          } else {
            const sha = entry.content === undefined ? entry.sha : storeBlob(entry.content);
            if (!blobs.has(sha)) return response({ message: 'Unknown blob' }, 422);
            files.set(entry.path, sha);
          }
        }
        return response({ sha: storeTree(files) }, 201);
      }
      if (method === 'POST' && path === '/git/commits') {
        if (!trees.has(body.tree) || !body.parents.every(parent => commits.has(parent))) return response({ message: 'Unknown commit parent/tree' }, 422);
        return response({ sha: storeCommit(body.tree, body.parents, body.message) }, 201);
      }
      if (method === 'PATCH' && path === `/git/refs/heads/${branch}`) {
        if (refBarrier) {
          const barrier = refBarrier;
          if (++barrier.arrived >= barrier.participants) {
            refBarrier = undefined;
            barrier.release();
          }
          await barrier.ready;
        }
        if (body.force !== false) return response({ message: 'Force updates are forbidden in this fixture' }, 422);
        if (!commits.has(body.sha) || !isAncestor(head, body.sha)) {
          refConflicts++;
          return response({ message: 'Update is not a fast forward' }, 422);
        }
        head = body.sha;
        return response({ ref: `refs/heads/${branch}`, object: { type: 'commit', sha: head } });
      }
      return response({ message: `Unhandled fake endpoint: ${method} ${path}` }, 404);
    },
  };
  return fake;
}

export function fakeGitHubEnvironment(fake, overrides = {}) {
  return {
    STORAGE_PROVIDER: 'github', GITHUB_OWNER: fake.owner, GITHUB_REPO: fake.repo,
    GITHUB_BRANCH: fake.branch, GITHUB_TOKEN: fake.token, GITHUB_DATA_PREFIX: 'write-then-publish',
    SESSION_SECRET: 'test-session-secret-with-at-least-32-bytes',
    SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465', SMTP_USERNAME: 'test-sender@gmail.com',
    SMTP_PASSWORD: 'test-google-app-password', SMTP_FROM: 'test-sender@gmail.com',
    AUTH_RATE_LIMIT: { async limit() { return { success: true }; } },
    ...overrides,
  };
}
