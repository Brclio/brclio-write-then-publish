import { handleStorageRequest, storageConfiguration } from './github-storage.mjs';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/storage/config.js') {
      const configuration = storageConfiguration(env);
      return new Response(`window.WRITE_THEN_PUBLISH_STORAGE=${JSON.stringify(configuration)};\n`, {
        headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      });
    }
    if (url.pathname === '/api/storage' || url.pathname.startsWith('/api/storage/')) {
      return handleStorageRequest(request, env);
    }
    const injectStorage = env.STORAGE_PROVIDER === 'github' && url.searchParams.get('mode') !== 'local'
      && (url.pathname === '/' || url.pathname === '/index.html');
    let assetRequest = request;
    if (injectStorage) {
      // Runtime configuration must not reuse a pre-GitHub HTML response via a static ETag.
      assetRequest = new Request(request);
      assetRequest.headers.delete('If-None-Match');
      assetRequest.headers.delete('If-Modified-Since');
    }
    const response = await env.ASSETS.fetch(assetRequest);
    if (env.STORAGE_PROVIDER === 'github' && ['/robots.txt', '/sitemap.xml'].includes(url.pathname) && response.status === 200) {
      const result = new Response((await response.text()).replaceAll('https://fawen.fun', url.origin), response);
      result.headers.delete('ETag');
      result.headers.delete('Last-Modified');
      result.headers.delete('Content-Length');
      result.headers.delete('Content-Encoding');
      result.headers.set('Cache-Control', 'no-store');
      return result;
    }
    if (env.STORAGE_PROVIDER !== 'github' || !['/', '/index.html'].includes(url.pathname) || url.searchParams.get('mode') === 'local'
        || !response.headers.get('Content-Type')?.includes('text/html') || response.status !== 200) return response;
    // The first inline script loads the existing account adapter. Inserting before
    // it lets the GitHub adapter take ownership without changing the static/local app.
    let inserted = false;
    const rewriter = new HTMLRewriter()
      .on('link[rel="canonical"]', { element(element) { element.setAttribute('href', `${url.origin}/`); } })
      .on('meta[property="og:url"]', { element(element) { element.setAttribute('content', `${url.origin}/`); } })
      .on('meta[property="og:image"], meta[name="twitter:image"]', {
        element(element) { element.setAttribute('content', `${url.origin}/brand/og-image.png`); },
      });
    const rewritten = rewriter.on('script:not([src])', {
      element(element) {
        if (inserted) return;
        inserted = true;
        element.before('<script src="/api/storage/config.js"></script><script src="/src/github-storage.js"></script>', { html: true });
      },
    }).transform(response);
    const result = new Response(rewritten.body, rewritten);
    result.headers.set('Cache-Control', 'no-store');
    result.headers.delete('ETag');
    result.headers.delete('Last-Modified');
    return result;
  },
};
