# 账号服务（Cloudflare Worker + KV）

前端已经写好了，这里是把「云端那一半」跑起来的全部步骤。**只跑一次，之后不用管。**

## 0. 现在的状态（2026-11-24）

已经做完的部分，不用再重复：

| 项 | 值 |
|---|---|
| Cloudflare 账号 | `shilinxue66@gmail.com` / `94cf08bee225570ba5be37a97e70ea31` |
| KV 命名空间 | `KR` = `fb9a1aec72dd4a41b0e1233dd7a380c4`（已写进 `wrangler.toml`） |
| Worker | `krlearn-api` 已部署，地址 `https://krlearn-api.shilinxue66.workers.dev` |
| 两个脚本 | `deploy.py`（部署）、`attach_domain.py`（挂域名 + 验证） |

**唯一卡点：这个账号里没有任何域名（`/zones` 返回 0 条）。**

- `workers.dev` 在国内 DNS 被污染（解析到 `108.160.163.117`，21 秒超时），不能当正式地址
- `askdiandian.com` 的 NS 是 `ns3/ns4.dnsv4.com`，**在 DNSPod 上，不在 Cloudflare**
- Cloudflare Worker 只能挂**自己账号里已托管域名**的子域，所以必须先把域名搬过来

## 1. 把 askdiandian.com 加到 Cloudflare（免费，约 10 分钟）

1. 打开 https://dash.cloudflare.com → **Add a site** → 输入 `askdiandian.com` → 选 **Free**
2. Cloudflare 会扫一遍现有解析，核对这 4 条 A 记录都在，**并且全部改成「仅 DNS」（灰色云朵）**：

   | 名称 | 值 |
   |---|---|
   | `www` | `139.196.16.27`、`8.153.95.178` |
   | `note3-prev-api` | `139.224.187.188`、`47.102.139.206` |

   灰云很重要：原来的阿里云 WAF / CDN 还在链路里，套上橙云会变成「CF → 阿里云」两层代理，
   反而容易出问题。
3. 继续到底，Cloudflare 会给你两个 NS（形如 `kate.ns.cloudflare.com`）
4. 去域名注册商那里改 NS：把 `ns3.dnsv4.com` / `ns4.dnsv4.com` 换成上面那两个
   （在哪里注册的就到哪里改：阿里云「域名 → DNS修改」，或腾讯云/DNSPod 的域名管理）
5. 等激活（通常几分钟，偶尔几小时）。随时可以查：

```bash
cd server
python attach_domain.py --check
```

## 2. 挂自定义域 + 重新部署（一条命令）

激活之后再跑：

```bash
cd server
python attach_domain.py
```

它会做四件事：写 `[[routes]] custom_domain = true` → `wrangler deploy` →
**从本机（国内网络）直连** `https://krlearn-api.askdiandian.com/api/stats` 验证 → 报告结果。

浏览器需要 DNS 缓存刷新的话：`ipconfig /flushdns`。

## 3. 把地址告诉前端

改 `assets/account.js` 第 30 行左右：

```js
const CLOUD_DEFAULT = 'https://krlearn-api.askdiandian.com';
```

提交推送即可。已经打开过的页面可以在控制台临时试：`KR.setCloud('https://krlearn-api.askdiandian.com')`
（它会写进 localStorage 并刷新，正式上线还是要改源码，否则别的用户拿不到）。

## 4. 验收

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
- **配额**：免费版 KV 每天 10 万读 / **1000 写（整个账号共用）** / 1GB 存储。前端攒 45 秒推一次 + 切后台补一次，
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
