# 账号服务（Cloudflare Worker + KV）

前端已经写好了，这里是把「云端那一半」跑起来的全部步骤。**只跑一次，之后不用管。**

## 0. 你需要什么

- 一个 Cloudflare 账号（你已经在用了 —— `askdiandian.com` 的 Worker 就在这上面）
- 一个能挂子域的域名（`krlearn-api.askdiandian.com`）

不需要：邮箱服务、数据库、服务器、备案。

## 1. 建 KV 命名空间

```bash
cd server
npx wrangler login          # 浏览器点一下授权
npx wrangler kv namespace create KR
```

输出长这样，把 `id` 抄下来：

```
[[kv_namespaces]]
binding = "KR"
id = "a1b2c3d4e5f6..."
```

填进 `server/wrangler.toml` 里那行占位符。

## 2. 部署

```bash
npx wrangler deploy
```

成功后会给你一个 `*.workers.dev` 地址。**别拿它当正式地址** —— 国内基本打不开。

## 3. 挂自定义域（关键一步）

Cloudflare 控制台 → Workers & Pages → `krlearn-api` → Settings → **Domains & Routes** →
Add → Custom domain → 填 `krlearn-api.askdiandian.com`（等几十秒生效）。

验证：

```bash
curl https://krlearn-api.askdiandian.com/health
# {"ok":true,"service":"krlearn-api"}
```

## 4. 把地址告诉前端

改 `assets/account.js` 第 30 行左右：

```js
const CLOUD_DEFAULT = 'https://krlearn-api.askdiandian.com';
```

提交推送即可。已经打开过的页面可以在控制台临时试：`KR.setCloud('https://krlearn-api.askdiandian.com')`
（它会写进 localStorage 并刷新，正式上线还是要改源码，否则别的用户拿不到）。

## 5. 验收

浏览器控制台：

```js
await KR.stats()          // {ok:true, users:1, active7d:1, active1d:1}
KR.info()                 // synced:true 才是真的在同步
```

注册一个新号 → 背两个词 → 设置页应显示「云同步已开启 / 刚刚」→ 换浏览器登录同一个号，
进度应该在。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/register` | `{u,p}` → `{ok,token}`；用户名重复回 409 `exists` |
| POST | `/api/login` | `{u,p}` → `{ok,token,db,updatedAt}`；连错 10 次锁 15 分钟 |
| POST | `/api/sync` | `Bearer token` + `{db,updatedAt}` → `{ok,rev}`；云端更新时回 `{adopted:true,db}` |
| GET | `/api/stats` | `{users,active7d,active1d}` |
| GET | `/api/me` | 校验 token |

## 几个设计取舍（免得以后自己看不懂）

- **密码**：`PBKDF2-SHA256`，12 万轮，随机盐。存哈希不存明文，也不做可逆加密。
- **token**：HMAC 签名，180 天，不需要会话表。好处是不用每次登录都写 KV；
  代价是 token 签发后无法单个吊销 —— 要踢人得换 `cfg:secret`（所有人一起重登）。
- **同步**：`updatedAt` 谁新谁赢。同一账号两台设备同时背词会互相覆盖，
  换来的是没有合并算法、没有冲突弹窗。一个人用完全够。
- **配额**：免费版 KV 每天 10 万读 / 1000 写 / 1GB。前端 2.5 秒节流 + 离开页面补一次，
  一天背 100 个词大概 30–40 次写；换成几百个活跃用户差不多到顶。
  真到瓶颈就换 D1（写额度高一个量级），`worker.js` 里只有读写那几行要改。
- **数据在哪**：`npx wrangler kv key list --namespace-id <id> --prefix "u:"` 能看到所有用户；
  删账号就是 `npx wrangler kv key delete --namespace-id <id> "u:kr-xxxxxx"`。

## 不想让人随便注册？

现在没有邀请码。要加的话在 `handleRegister` 开头加一行校验：

```js
if (body.code !== env.INVITE) return json({ ok: false, err: 'code' }, 403);
```

前端在注册表单里加一个输入框一起提交即可。要我加就说一声。
