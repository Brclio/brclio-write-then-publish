import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist/cloudflare');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
// 白名单发布浏览器资源，禁止把服务端、测试、.dev.vars 或仓库元数据变成公开静态文件。
for (const name of [
  'index.html', 'src', 'brand', 'docs/guide-assets',
  'favicon.svg', 'favicon.ico', 'site.webmanifest', 'robots.txt',
  'sitemap.xml', 'googlec57d762f5ce04339.html',
]) {
  const destination = path.join(output, name);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(root, name), destination, { recursive: true });
}
console.log('Cloudflare 静态资源已生成：dist/cloudflare');
