(function initializeGitHubStorage() {
  const config = window.WRITE_THEN_PUBLISH_STORAGE;
  if (!config || !["github", "disabled"].includes(config.provider)) return;
  const configured = config.provider === "github" && config.configured !== false;
  const apiBase = String(config.apiBase || "/api/storage").replace(/\/$/, "");
  const sessionKey = "writeThenPublishGitHubSession.v1";
  const listeners = new Set();
  let session = null;
  try { session = JSON.parse(localStorage.getItem(sessionKey) || "null"); } catch { /* New browser. */ }

  function rememberSession(next, event) {
    session = next || null;
    try {
      if (session) localStorage.setItem(sessionKey, JSON.stringify(session));
      else localStorage.removeItem(sessionKey);
    } catch { /* The current tab can still use the session. */ }
    if (event) listeners.forEach((callback) => callback(event, session));
    return session;
  }

  async function request(path, { method = "GET", body, session: boundSession = session, binary = false } = {}) {
    if (!configured) throw new Error(config.configurationError || config.error || "GitHub 私有仓库存储尚未配置，请联系站点管理员。");
    const headers = new Headers();
    if (boundSession?.access_token) headers.set("Authorization", `Bearer ${boundSession.access_token}`);
    if (body instanceof Blob) headers.set("Content-Type", body.type || "application/octet-stream");
    else if (body !== undefined) headers.set("Content-Type", "application/json");
    const response = await fetch(`${apiBase}${path}`, {
      method, headers, cache: "no-store",
      body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
    });
    if (binary && response.ok) return response.blob();
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || result.message || `GitHub 存储请求失败（${response.status}）。`);
      error.code = result.code || "";
      error.status = response.status;
      error.retryAfter = Number(response.headers.get("Retry-After")) || Number(result.retry_after) || 0;
      throw error;
    }
    return result;
  }

  async function authenticate(action, email, password, code) {
    const result = await request(`/auth/${action}`, {
      method: "POST", body: { email, password, ...(action === "signup" ? { code } : {}) }, session: null,
    });
    rememberSession(result.session, "SIGNED_IN");
    return result;
  }

  async function getSession() {
    if (!session) return null;
    const current = session;
    try {
      const result = await request("/auth/session", { session: current });
      if (session === current) rememberSession(result.session);
      return result.session || null;
    } catch (error) {
      if (error.status === 401) {
        if (session === current) rememberSession(null);
        return null;
      }
      // An offline browser can reopen its own cached workspace; writes still report failure.
      if (!error.status && Number(current.expires_at) * 1000 > Date.now()) return current;
      throw error;
    }
  }

  async function setSession(next) {
    if (!next?.access_token) throw new Error("这个账号的登录状态已失效，请重新登录。");
    const result = await request("/auth/session", { session: next });
    rememberSession(result.session, "SIGNED_IN");
    return { session: result.session, user: result.session?.user };
  }

  async function signOut() {
    const current = session;
    if (current) await request("/auth/signout", { method: "POST", session: current });
    if (session === current) rememberSession(null, "SIGNED_OUT");
  }

  window.WriteThenPublishCloud = {
    provider: "github", configured, supportsProjectSync: true, livePhotoConfigured: false,
    configurationError: configured ? "" : config.configurationError || config.error || "GitHub 私有仓库存储尚未配置，请联系站点管理员。",
    signUp: (email, password, code) => authenticate("signup", email, password, code),
    requestSignupCode: (email) => request("/auth/signup-code", { method: "POST", body: { email }, session: null }),
    signIn: (email, password) => authenticate("signin", email, password),
    getSession, setSession, signOut, signOutLocal: signOut,
    onAuthStateChange(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    googleSignInAvailable: async () => false,
    isServiceRestricted: () => false,
    getAccountPolicy: async () => ({ migration_open: false }),
    getProfile: (options) => request("/profile", options),
    upsertProfile: (profile, options = {}) => request("/profile", {
      ...options, method: "PUT", body: {
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl ?? (/^data:image\/(?:png|jpe?g|webp|gif);base64,/.test(profile.avatar || "") ? profile.avatar : ""),
      },
    }),
    // The private avatar is part of the authenticated profile, so an <img> needs no public URL.
    uploadAvatar: async (dataUrl) => dataUrl,
    listProjects: (options) => request("/projects", options).then((result) => Array.isArray(result) ? result : result.projects || []),
    saveProject: (project, options = {}) => request(`/projects/${encodeURIComponent(project.id)}`, {
      ...options, method: "PUT", body: {
        title: project.title, data: project.data, revision: project.revision || null,
        created_at: project.createdAt ? new Date(project.createdAt).toISOString() : null,
      },
    }),
    deleteProject: (id, revision, options = {}) => request(`/projects/${encodeURIComponent(id)}`, {
      ...options, method: "DELETE", body: { revision: revision || null },
    }),
    uploadProjectAsset: (projectId, assetId, blob, options = {}) => request(
      `/assets/${encodeURIComponent(projectId)}/${encodeURIComponent(assetId)}`,
      { ...options, method: "PUT", body: blob },
    ),
    downloadProjectAsset: (path, options = {}) => request(`/assets?path=${encodeURIComponent(path)}`, { ...options, binary: true }),
  };
})();
