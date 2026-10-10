const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync('src/app.js', 'utf8');
const adapter = fs.readFileSync('src/github-storage.js', 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `missing ${start}`);
  return source.slice(first, last);
}
const session = { access_token: 'user-a-token', refresh_token: 'user-a-token', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'a', email: 'a@example.com' } };
const gif = fs.readFileSync('tests/fixtures/portable/animated.gif');
const png = fs.readFileSync('tests/fixtures/portable/still.png');
const video = fs.readFileSync('tests/fixtures/portable/source.mp4');
const dataUrl = (bytes, type) => `data:${type};base64,${bytes.toString('base64')}`;
const draft = () => ({ id: 'project_test', title: '明文稿件', createdAt: Date.now(), updatedAt: 123, data: {
  content: '# 明文稿件\n[[image:gif]]\n[[image:live]]', fontSize: 36, images: {
    gif: { name: 'animated.gif', src: dataUrl(gif, 'image/gif') },
    live: { name: 'cover.png', src: '', srcKey: 'cached-cover', kind: 'live', videoKey: 'live-key', videoName: 'source.mp4', liveSettings: { aspect: '.75' } },
  },
} });

function appContext(project = draft(), overrides = {}) {
  const uploads = [], saves = [], removals = [], timers = new Map(), local = new Map();
  let timer = 0, revision = 0;
  let copyId = 0;
  const api = {
    provider: 'github', configured: true,
    uploadProjectAsset: async (projectId, assetId, blob, options) => {
      uploads.push({ projectId, assetId, bytes: Buffer.from(await blob.arrayBuffer()), options });
      return { path: `users/a/projects/${projectId}/assets/${assetId}` };
    },
    saveProject: async (item, options) => { saves.push({ item, options }); return { revision: `revision-${++revision}` }; },
    deleteProject: async (id, rev, options) => { removals.push({ id, rev, options }); return {}; },
    getProfile: async () => ({ display_name: 'Author', avatar_url: '' }), listProjects: async () => [],
    upsertProfile: async () => ({ display_name: 'Author', avatar_url: '' }),
  };
  Object.assign(api, overrides);
  const ctx = {
    Blob, Buffer, fetch, crypto: webcrypto, console,
    localStorage: { getItem: key => local.get(key), setItem: (key, value) => local.set(key, value), removeItem: key => local.delete(key) },
    window: { WriteThenPublishCloud: api, clearTimeout: id => timers.delete(id), setTimeout: fn => { timers.set(++timer, fn); return timer; } },
    cloudApi: () => api, cloudIsReady: () => Boolean(ctx.cloudState.user),
    cloudState: { user: session.user, session, loadingWorkspace: false }, activeStorageScope: 'user_a',
    accountScope: id => `user_${id}`, state: { projects: [project] },
    els: { accountSyncStatus: {}, status: {}, displayName: { value: 'Author' }, avatarPreview: { src: dataUrl(png, 'image/png') } },
    liveMediaFiles: new Map([['live-key', { blob: new Blob([video], { type: 'video/mp4' }) }]]),
    readImageSource: async key => key === 'cached-cover' ? dataUrl(png, 'image/png') : null,
    readLiveMediaBlob: async () => null, isBuiltInProject: () => false,
    saveProjectStore() { ctx.cachedProjects = JSON.parse(JSON.stringify(ctx.state.projects)); ctx.scheduleGitHubProjectSync(); },
    loadProjectStoreForScope: () => ({ projects: ctx.cached || [], activeId: project.id }),
    cloudProjectFromRow: row => ({ id: row.id, title: row.title, updatedAt: 999, cloudSyncedAt: 999, cloudRevision: row.revision, data: row.data }),
    loadAuthorProfileForScope: () => null, normalizeAuthorProfile: value => value,
    setAccountBusy() {}, updateAccountUi() {}, setAccountNotice() {},
    createProject: data => ({ id: `conflict_copy_${++copyId}`, data }),
    projectTitleFromData: data => String(data.content || 'Untitled').slice(0, 24), updateProjectHistory() {},
    updateAvatarPreview: async () => {}, saveState() {},
    hydrateCloudProjectOnce: async () => 0,
    activateWorkspaceScope: async (scope, projects, profile) => { ctx.activeStorageScope = scope; ctx.state.projects = projects; ctx.activatedProfile = profile; },
  };
  vm.createContext(ctx);
  vm.runInContext([
    section('function githubStorageEnabled()', 'function cloudIsReady()'),
    section('function portableMediaExtension(', 'function portableProjectMigrationUnits('),
    section('async function loadGitHubWorkspace(', 'async function handleCloudSession('),
    section('function scheduleCloudProfileSync(', 'async function importLocalProjectsToAccount('),
    section('async function waitForCloudSyncBeforeAccountSwitch()', '// Supabase 的 refresh token'),
    section('function githubProjectDataFromRow(', '/** blob: 链接'),
  ].join('\n'), ctx);
  return { ctx, api, uploads, saves, removals, local, sync: vm.runInContext('githubProjectSync', ctx) };
}

async function testAdapter() {
  const storage = new Map(), requests = [];
  const ctx = { window: { WRITE_THEN_PUBLISH_STORAGE: { provider: 'github' } }, localStorage: {
    getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key),
  }, Blob, Headers, Date, fetch: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/auth/signup')) return Response.json({ session, user: session.user });
    if (url.endsWith('/auth/session')) return Response.json({ session });
    if (url.includes('/assets?')) return new Response(png, { headers: { 'Content-Type': 'image/png' } });
    return Response.json({ display_name: 'Author', avatar_url: '' });
  } };
  vm.createContext(ctx); vm.runInContext(adapter, ctx);
  const api = ctx.window.WriteThenPublishCloud, events = [];
  api.onAuthStateChange((event, value) => events.push({ event, value }));
  assert.equal((await api.signUp('a@example.com', 'password123', '123456')).session.user.id, 'a');
  assert.equal(JSON.parse(requests.at(-1).options.body).code, '123456', 'signup carries the email verification code');
  assert.equal(events[0].event, 'SIGNED_IN');
  assert.equal((await api.getSession()).user.id, 'a');
  await api.requestSignupCode('a@example.com');
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), { email: 'a@example.com' });
  assert.equal(requests.at(-1).options.headers.has('Authorization'), false, 'email verification requests do not borrow a signed-in account session');
  await api.upsertProfile({ displayName: 'Author' });
  assert.equal(JSON.parse(requests.at(-1).options.body).avatarUrl, '', 'nickname updates satisfy the server profile contract');
  const oldSession = { ...session, access_token: 'bound-old-token' };
  assert.equal((await api.downloadProjectAsset('users/a/asset.png', { session: oldSession })).size, png.length);
  assert.equal(requests.at(-1).options.headers.get('Authorization'), 'Bearer bound-old-token');
  ctx.window.WRITE_THEN_PUBLISH_STORAGE = { provider: 'disabled', error: '配置错误明细' };
  vm.runInContext(adapter, ctx);
  assert.equal(ctx.window.WriteThenPublishCloud.configured, false);
  assert.equal(ctx.window.WriteThenPublishCloud.configurationError, '配置错误明细');
  await assert.rejects(ctx.window.WriteThenPublishCloud.signIn('a@example.com', 'password123'), /配置错误明细/);
}

(async () => {
  await testAdapter();
  const success = appContext();
  success.ctx.scheduleGitHubProjectSync();
  await success.ctx.flushGitHubProjectSync();
  assert.equal(success.uploads.length, 3, 'GIF, live cover, and original video are all uploaded');
  assert.ok(success.uploads.some(item => item.bytes.equals(gif)), 'animated GIF bytes are unchanged');
  assert.ok(success.uploads.some(item => item.bytes.equals(video)), 'original video bytes are unchanged');
  const saved = success.saves[0].item;
  assert.equal(saved.data.content, draft().data.content);
  assert.equal(saved.data.fontSize, 36);
  assert.equal(saved.data.images.gif.src, '');
  assert.equal(saved.data.images.live.srcKey, undefined);
  assert.match(saved.data.images.live.videoStoragePath, /\.mp4$/);
  assert.equal(success.ctx.state.projects[0].cloudRevision, 'revision-1');
  assert.equal(success.ctx.cachedProjects[0].cloudSyncedAt, 123);
  success.ctx.state.projects[0].data.content += '\nsecond edit';
  success.ctx.state.projects[0].updatedAt++;
  success.ctx.scheduleGitHubProjectSync(); await success.ctx.flushGitHubProjectSync();
  assert.equal(success.uploads.length, 3, 'unchanged content-addressed assets are reused');
  assert.equal(success.saves[1].item.revision, 'revision-1');

  const missing = appContext({ id: 'missing', title: 'Missing', updatedAt: 123, data: { images: { missing: { src: '', name: 'lost.gif' } } } });
  missing.ctx.scheduleGitHubProjectSync(); await missing.ctx.flushGitHubProjectSync();
  assert.equal(missing.saves.length, 0, 'missing original media never produces a successful project save');
  assert.equal(missing.ctx.state.projects[0].cloudSyncedAt, undefined);
  assert.match(missing.ctx.els.status.textContent, /未同步/);

  const conflict = appContext(draft(), { saveProject: async () => { const error = new Error('conflict'); error.status = 409; throw error; } });
  conflict.ctx.scheduleGitHubProjectSync(); await conflict.ctx.flushGitHubProjectSync();
  assert.equal(conflict.ctx.state.projects[0].cloudSyncedAt, undefined);
  assert.equal(conflict.sync.blocked.size, 1);
  assert.match(conflict.ctx.els.status.textContent, /另一设备/);

  const switched = appContext();
  switched.ctx.scheduleGitHubProjectSync();
  switched.ctx.cloudState.user = { id: 'b' }; switched.ctx.activeStorageScope = 'user_b';
  await switched.ctx.flushGitHubProjectSync();
  assert.equal(switched.uploads.length, 0, 'an old account debounce cannot write after switching accounts');

  let resolveSave, started;
  const savingStarted = new Promise(resolve => { started = resolve; });
  const deletion = appContext(draft(), { saveProject: async () => { started(); return new Promise(resolve => { resolveSave = resolve; }); } });
  deletion.ctx.scheduleGitHubProjectSync();
  const pendingSave = deletion.ctx.flushGitHubProjectSync(); await savingStarted;
  deletion.ctx.scheduleGitHubProjectSync();
  const pendingDelete = deletion.ctx.deleteGitHubProject(deletion.ctx.state.projects[0]);
  resolveSave({ revision: 'last-revision' });
  await pendingSave; assert.equal(await pendingDelete, true);
  assert.equal(deletion.removals.length, 1);
  assert.equal(deletion.removals[0].rev, 'last-revision');
  assert.equal(deletion.sync.pending.size, 0, 'deletion cancels pending saves that could recreate the project');

  const offline = appContext(); offline.ctx.cached = [draft()];
  await offline.ctx.loadGitHubWorkspace(session);
  assert.equal(offline.ctx.state.projects.length, 1, 'an empty repository preserves unsynced local drafts');
  const refresh = appContext(); refresh.ctx.cached = [{ ...draft(), cloudRevision: 'old', cloudSyncedAt: 122 }];
  refresh.api.listProjects = async () => [{ ...draft(), revision: 'new' }];
  await refresh.ctx.loadGitHubWorkspace(session);
  assert.equal(refresh.ctx.state.projects.find(project => project.id === 'project_test').cloudRevision, 'new', 'the original ID opens the newest cloud version');
  const preserved = refresh.ctx.state.projects.find(project => project.cloudConflictCopy);
  assert.ok(preserved, 'unsynced local content gets a separate conflict copy');
  assert.equal(preserved.cloudRevision, undefined);
  assert.equal(preserved.data.content, draft().data.content);
  assert.equal(refresh.sync.blocked.size, 0, 'a preserved conflict does not permanently block account switching');
  await refresh.ctx.flushGitHubProjectSync();
  assert.equal(refresh.saves[0].item.id, preserved.id);
  assert.ok(refresh.uploads.every(asset => asset.projectId === preserved.id), 'a conflict copy uploads media into its own project folder');

  const duringSave = appContext(draft(), {
    listProjects: async () => [{ ...draft(), revision: 'other-device-revision' }],
    saveProject: async item => {
      if (item.id === 'project_test') { const error = new Error('revision conflict'); error.status = 409; throw error; }
      return { revision: 'preserved-copy-revision' };
    },
  });
  duringSave.ctx.state.currentProjectId = 'project_test';
  duringSave.ctx.scheduleGitHubProjectSync(); await duringSave.ctx.flushGitHubProjectSync();
  assert.equal(duringSave.ctx.state.projects.find(project => project.id === 'project_test').cloudRevision, 'other-device-revision');
  assert.equal(duringSave.ctx.state.projects.find(project => project.cloudConflictCopy).cloudRevision, 'preserved-copy-revision', 'a revision conflict during autosave safely synchronizes a separate local copy');

  const profile = appContext(draft(), { upsertProfile: async () => { throw new Error('offline'); } });
  profile.ctx.state.projects = [];
  profile.ctx.els.displayName.value = '本机离线昵称';
  profile.ctx.scheduleCloudProfileSync(); await profile.ctx.flushCloudProfileSync();
  assert.equal(profile.ctx.cloudState.pendingProfileSync, true, 'nickname-only failures retain their own dirty flag');
  assert.ok(profile.local.get('writeThenPublishGitHubPendingProfile.v1.user_a'), 'profile dirtiness survives refresh');
  await assert.rejects(profile.ctx.waitForCloudSyncBeforeAccountSwitch(), /资料仍未同步/);
  let profileWrites = 0;
  profile.api.upsertProfile = async value => { profileWrites++; return { display_name: value.displayName, avatar_url: '' }; };
  await profile.ctx.flushCloudProfileSync();
  assert.equal(profile.ctx.cloudState.pendingProfileSync, false);
  profile.ctx.scheduleCloudProfileSync(); await profile.ctx.flushCloudProfileSync();
  assert.equal(profileWrites, 1, 'unchanged author information does not produce repeated repository commits');
  const restoreProfile = appContext();
  restoreProfile.local.set('writeThenPublishGitHubPendingProfile.v1.user_a', JSON.stringify({ avatar: false }));
  restoreProfile.ctx.loadAuthorProfileForScope = () => ({ displayName: '本机离线昵称', avatar: dataUrl(png, 'image/png') });
  await restoreProfile.ctx.loadGitHubWorkspace(session);
  assert.equal(restoreProfile.ctx.activatedProfile.display_name, '本机离线昵称', 'refresh cannot overwrite an unsynced local nickname with an older remote profile');

  const guestSwitch = appContext();
  guestSwitch.ctx.cloudState.user = null; guestSwitch.ctx.activeStorageScope = 'guest';
  await guestSwitch.ctx.waitForCloudSyncBeforeAccountSwitch();
  assert.equal(guestSwitch.uploads.length, 0, 'switching from guest does not treat a guest draft as an account upload');

  const version = appContext();
  const oldRow = { ...draft(), data: { images: { live: { kind: 'live', videoKey: 'shared-key', videoStoragePath: 'users/a/projects/project_test/assets/old.mp4' } } } };
  const newRow = JSON.parse(JSON.stringify(oldRow));
  newRow.data.images.live.videoStoragePath = 'users/a/projects/project_test/assets/new.mp4';
  const oldData = version.ctx.githubProjectDataFromRow(oldRow), newData = version.ctx.githubProjectDataFromRow(newRow);
  assert.notEqual(oldData.images.live.videoKey, newData.images.live.videoKey, 'remote source video versions use separate browser cache keys');
  version.ctx.liveMediaFiles.set(oldData.images.live.videoKey, { blob: new Blob(['old video'], { type: 'video/mp4' }) });
  let videoReads = 0;
  version.api.downloadProjectAsset = async (path, options) => { videoReads++; assert.equal(options.session.user.id, 'a'); return new Blob([video], { type: 'video/mp4' }); };
  version.ctx.writeLiveMediaBlob = async () => {};
  version.ctx.replaceLiveMediaCache = (key, blob) => version.ctx.liveMediaFiles.set(key, { blob });
  vm.runInContext(section('async function hydrateCloudProject(', '// 新稿只存在本机'), version.ctx);
  await version.ctx.hydrateCloudProject({ id: oldRow.id, data: newData });
  assert.equal(videoReads, 1, 'a new remote video path cannot reuse an old cached source');
  assert.deepEqual(Buffer.from(await version.ctx.liveMediaFiles.get(newData.images.live.videoKey).blob.arrayBuffer()), video);

  const editingVideo = appContext();
  const originalVideo = new Blob(['immutable original video'], { type: 'video/mp4' });
  const replacementVideo = new Blob(['replacement local video'], { type: 'video/mp4' });
  replacementVideo.name = 'replacement.mp4';
  const remoteData = editingVideo.ctx.githubProjectDataFromRow(oldRow);
  const originalKey = remoteData.images.live.videoKey;
  const videoDatabase = new Map([[originalKey, originalVideo]]);
  editingVideo.ctx.liveMediaFiles.set(originalKey, { blob: originalVideo });
  Object.assign(editingVideo.ctx, {
    livePhotoState: { editingId: 'live', file: replacementVideo, generating: false },
    livePhotoSelectionIsValid: () => true, updateLivePhotoGenerateState() {}, setLivePhotoServiceMessage() {},
    captureLivePhotoCover: async () => dataUrl(png, 'image/png'), normalizeLiveMediaSettings: value => value,
    normalizedLivePhotoCrop: () => null, defaultNewImageLayout: () => ({}), updateImageList() {}, closeLivePhotoModal() {}, render: async () => {},
    writeLiveMediaBlob: async (key, blob) => videoDatabase.set(key, blob),
    replaceLiveMediaCache: (key, blob) => editingVideo.ctx.liveMediaFiles.set(key, { blob }),
  });
  Object.assign(editingVideo.ctx.els, { livePhotoStart: { value: 0 }, livePhotoCover: { value: 0 }, livePhotoSound: { checked: true } });
  editingVideo.ctx.state.images = remoteData.images;
  vm.runInContext(section('async function applyLivePhotoAsset(', '// 渲染序号'), editingVideo.ctx);
  await editingVideo.ctx.applyLivePhotoAsset({ preventDefault() {} });
  assert.notEqual(editingVideo.ctx.state.images.live.videoKey, originalKey, 'editing a remote video allocates an independent local cache key');
  assert.equal(videoDatabase.get(originalKey), originalVideo, 'local replacement never overwrites the immutable remote-path IndexedDB entry');
  assert.equal(editingVideo.ctx.liveMediaFiles.get(originalKey).blob, originalVideo, 'the remote-path memory cache also retains its original bytes');
  assert.equal(videoDatabase.get(editingVideo.ctx.state.images.live.videoKey), replacementVideo);
  const restoredRemote = editingVideo.ctx.githubProjectDataFromRow(oldRow);
  assert.equal(editingVideo.ctx.liveMediaFiles.get(restoredRemote.images.live.videoKey).blob, originalVideo, 'restoring a cloud revision after conflict reads the original video rather than the replacement');

  const opening = appContext();
  opening.ctx.state.currentProjectId = opening.ctx.state.projects[0].id;
  let form = JSON.parse(JSON.stringify(opening.ctx.state.projects[0].data));
  Object.assign(opening.ctx, { readForm: () => form, isBuiltInProjectId: () => false, saveAuthorProfile() {},
    withExternalizedImages: data => data, storageForScope: () => ({ setItem() {} }), scopedStorageKey: key => key, STORAGE_KEY: 'current' });
  vm.runInContext(section('function saveState()', 'function loadState()'), opening.ctx);
  opening.ctx.cloudState.loadingWorkspace = true;
  opening.ctx.saveState();
  assert.equal(opening.ctx.state.projects[0].updatedAt, 123, 'loading a remote project does not mark it as edited');
  opening.ctx.cloudState.loadingWorkspace = false;
  opening.ctx.rememberGitHubFormSnapshot();
  opening.ctx.saveState();
  assert.equal(opening.sync.pending.size, 0, 'rendering an unchanged open project does not upload it again');
  form = { ...form, content: 'actual edit' };
  opening.ctx.saveState();
  assert.equal(opening.sync.pending.size, 1, 'actual edits still schedule project synchronization');
  console.log('OK: GitHub adapter, disabled config, original GIF/video sync, asset reuse, missing-media failure, conflict preservation, account isolation, deletion ordering and cache merge');
})().catch(error => { console.error(error); process.exitCode = 1; });
