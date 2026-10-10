# Cloudflare + GitHub 私有仓库存储

这是可选的独立部署模式。Cloudflare Worker 托管现有页面与同源 API，GitHub 私有仓库保存账号资料、草稿、排版设置和素材；不需要 Supabase 数据库。未设置 `STORAGE_PROVIDER=github` 时沿用原有部署行为，`?mode=local` 继续使用本地无账号模式。

## 1. 准备数据仓库

创建一个**私有** GitHub 仓库，勾选添加 README，以初始化默认分支。建议数据仓库与应用源码仓库分开。服务端会验证仓库是私有的，公开仓库、未初始化的分支、失效或无权限的 token 都会停止读写并返回提示。

创建 fine-grained personal access token，只选择这个数据仓库，赋予 **Contents: Read and write** 权限。组织仓库还需完成组织要求的审批。token 只用于服务端，不填入 `src/supabase-config.js`、前端脚本或任何 Git 提交。

## 2. 配置 Cloudflare

在 Cloudflare Workers & Pages 中创建 Worker 并连接本应用源码仓库。构建命令使用 `npm ci`，部署命令使用 `npm run deploy:cloudflare`；仓库内的 Wrangler 配置会先执行静态资源构建，并通过 `keep_vars` 保留控制台配置的运行时变量。也可以在本机使用 Node.js 22 或更高版本安装依赖后运行 `npx wrangler login`、`npm run deploy:cloudflare`。

在 Worker 的 **Settings → Variables and Secrets** 中配置下表。部署构建使用的变量与 Worker 运行时变量不同，这些值必须在运行时可用。

| 名称 | 类型 | 值 |
|---|---|---|
| `STORAGE_PROVIDER` | Variable | `github`，显式启用 |
| `GITHUB_OWNER` | Variable | 数据仓库所属账号或组织 |
| `GITHUB_REPO` | Variable | 私有数据仓库名称 |
| `GITHUB_BRANCH` | Variable | 已初始化的存储分支，默认 `main` |
| `GITHUB_DATA_PREFIX` | Variable | 仓库内根目录，默认 `write-then-publish` |
| `GITHUB_TOKEN` | **Secret** | 该数据仓库的 Contents 读写 token |
| `SESSION_SECRET` | **Secret** | 独立随机字符串，至少 32 个字符，用于签署登录会话 |

`SESSION_SECRET` 可用 `openssl rand -hex 32` 生成，轮换后所有旧会话失效，需要重新登录。不要把 Secret 配置成公开前端变量。CLI 可用 `npx wrangler secret put GITHUB_TOKEN` 和 `npx wrangler secret put SESSION_SECRET` 安全输入；普通运行时变量也可在 Cloudflare 控制台设置。首次部署配置变量后，需要使配置生效再验证注册。

本地测试：复制 `.dev.vars.example` 为 `.dev.vars`，填入测试私有仓库及凭证，运行 `npm ci` 和 `npm run dev:cloudflare`。`.dev.vars` 已加入忽略列表。不要使用生产用户数据进行测试。

## 3. 数据结构

```text
write-then-publish/
└── users/
    ├── <用户标识 A>/
    │   ├── account.json
    │   ├── profile.json
    │   └── projects/
    │       ├── index.json
    │       └── <稿件标识>/
    │           ├── project.json
    │           ├── content.md
    │           └── assets/
    │               ├── <素材标识>.png
    │               ├── <素材标识>.gif
    │               └── <素材标识>.mp4
    └── <用户标识 B>/
        └── ...
```

每位用户注册时创建专属目录。用户标识由服务端根据规范化邮箱计算，不接受客户端指定用户目录。`account.json` 保存邮箱、密码哈希及会话版本；`profile.json` 保存昵称与头像；`index.json` 只保存稿件摘要和版本；正文为 UTF-8 Markdown，排版参数与素材引用为可读 JSON；图片、GIF 和实况原视频为各自独立文件，保留原始字节。实际素材文件名由内容摘要确定。

**业务数据不加密，拥有仓库权限的人可以直接阅读正文、资料与素材。密码仅保存随机盐和 PBKDF2 哈希，不保存明文密码。** GitHub 仓库的提交历史也会保留旧版本；应用内删除草稿会删除当前分支对应文件，不会擦除 Git 历史。

## 4. 使用与验收

打开部署域名，通过现有「登录 / 注册」入口注册邮箱账号，立即进入工作区。GitHub 模式使用独立账号体系，原 Supabase 账号需重新注册；旧稿可通过现有 ZIP 原稿导出、导入功能搬入。此模式不提供 Google 登录、邮件确认和邮件找回密码，相应入口自动隐藏。

草稿在本机缓存后自动同步，账号面板显示同步状态。确认同步完成后，使用另一浏览器登录，核对正文、排版、普通图片、原始 GIF、Live Photo 原视频和头像昵称；同时检查数据仓库内是否出现上述多文件目录。再注册第二个账号，确认两位用户只能读取自己的草稿，分别修改、删除也不会影响对方。

草稿保存使用版本校验。同一稿件被另一设备修改后，服务端会拒绝旧版本覆盖。应用保留远端最新稿件，并把本机未同步内容另存为「本机冲突副本」，两份内容可在历史记录中分别打开、导出和合并。副本使用独立项目目录，图片和视频也复制到该目录。仓库写入竞争会重新读取最新分支后重试，提交不会强制覆盖其它用户的更新。

## 5. 容量与运维

单个素材最多 10 MiB；超限或上传失败会明确提示尚未同步，本机草稿仍可编辑和导出。GitHub 模式适合个人或小规模使用；每次同步涉及 GitHub API 和 Git 提交，受 token 限额、二级限流、仓库容量以及 Cloudflare 运行时限额约束。**建议使用 Workers Paid**：读取较多稿件和素材时会超过 Free 每请求 50 次子请求或 CPU 限额，例如 24 篇稿件的多文件读取已需要超过 50 次 GitHub 请求。网络失败和限流不会被显示成同步成功。

Wrangler 配置包含 `AUTH_RATE_LIMIT` 绑定，同一来源每分钟最多 10 次注册 / 登录请求。部署时必须保留此绑定，缺失时服务端会停止认证操作；它不会把账号、文章或素材写入 Cloudflare 数据库。

数据目录、仓库和分支应在启用后保持稳定。修改这些变量会切换到另一套存储位置，不会自动搬迁旧数据。不要直接编辑 `account.json` 的哈希和会话字段。备份需同时保存整个数据仓库与 Cloudflare 运行时配置，Secret 应通过独立安全渠道保存。

代码检查使用 `npm test`；Worker 与静态资源打包检查使用 `npx wrangler deploy --dry-run`。本地模拟测试不代表已完成真实 Cloudflare 部署或真实 GitHub 仓库验收，生产启用后仍应按上面的双账号、跨浏览器流程确认。

实现参考：[Cloudflare Static Assets 配置](https://developers.cloudflare.com/workers/static-assets/binding/)、[GitHub Git Trees API](https://docs.github.com/en/rest/git/trees)、[GitHub Git References API](https://docs.github.com/en/rest/git/refs)。
