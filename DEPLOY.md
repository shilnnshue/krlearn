# 部署到公网（免费）

目标：把这个软件放到一个大家能访问的网址上，以后改了东西 `git push` 一下自动更新。

推荐路径：**GitHub 存代码 + Cloudflare Pages 托管**。原因见文末「为什么是这家」。
全部免费，不需要信用卡，不需要备案。

---

## 一、先接受一个事实

你的情况是「国内用户为主 + 会公开发」。这里有个绕不过去的矛盾：

**免费方案里，没有哪个能同时做到「国内快」和「能在微信里直接点开」。**

原因不是技术，是政策：

- 国内节点加速（腾讯云 EdgeOne 中国大陆可用区）→ 域名必须工信部备案
- 备案要求服务器在境内 → Cloudflare 在境外，备不了
- 微信内置浏览器会拦截未备案域名，显示「已停止访问该网页」

所以能拿到的最好结果是：

| 场景 | 能不能用 |
|---|---|
| 把网址发给人，对方复制到 Chrome / Safari / Edge 打开 | ✅ 能，Cloudflare 免费版够用 |
| 在微信里点链接直接打开 | ❌ 会被拦（所有海外免费平台都一样） |
| 微信里长按链接 → 「在浏览器打开」 | ✅ 能，多一步操作 |
| 国内速度 | ⚠️ 中等偏慢，但音频文件小（一条 20–50KB），实际体感可以接受 |

**要真正解决微信传播，只有一条路：买个域名（`.top` / `.xyz` 十几块一年）→ 备案 → 走 EdgeOne 国内节点。** 这步不急，先把测试版跑起来验证内容，等确认要正式推了再办。

---

## 二、准备：把本地变成 git 仓库

项目目录已经准备好 `.gitignore` 和 `_headers`。在 **Git Bash** 里执行：

```bash
cd "D:/workbuddy工作台/2026-11-22-20-01-46/krlearn"
bash tools/init_repo.sh
```

这个脚本做三件事：

1. `git init`
2. 分 5 批提交（外壳 → 字母/变位音频 → 单词音频 → 例句音频 → 工具脚本）
3. 打印最终文件数和体积

**为什么分批提交**：总共 300MB、1.6 万个文件，一次推上去容易中途断。分批的话断了只要重跑 `git push`，已传的部分 git 不会重传。

---

## 三、建 GitHub 仓库

### 3.1 建空仓库

打开 https://github.com/new

- Repository name：`krlearn`（可以随意，只影响网址）
- 选 **Private 或 Public 都行**（Cloudflare Pages 两种都支持；Public 的话别人能看到源码，但你的内容本来就是给人用的）
- **不要**勾 Add README / .gitignore / license —— 会跟本地冲突
- 点 Create repository

### 3.2 推上去

创建完页面会显示仓库地址，复制 HTTPS 那条，然后：

```bash
cd "D:/workbuddy工作台/2026-11-22-20-01-46/krlearn"

git remote add origin https://github.com/你的用户名/krlearn.git
git branch -M main
git push -u origin main
```

会有两个提示要处理：

1. **认证**：首次会弹浏览器窗口让你登录 GitHub，登录授权即可。如果命令行里问账号密码，密码要填 **Personal Access Token**（Settings → Developer settings → Personal access tokens → Generate new token，勾 `repo` 权限），不是登录密码 —— GitHub 早就不支持密码推送了。
2. **上传时间**：300MB 上行，视你宽带可能 **10–40 分钟**。进度条卡着不动是正常的，别关窗口。中断了就重新 `git push`，会接着传。

推完去 GitHub 页面刷新，看文件在不在。

---

## 四、接到 Cloudflare Pages

1. 注册 https://dash.cloudflare.com/sign-up （邮箱 + 密码，不收信用卡）
2. 左侧菜单 **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
3. 授权 GitHub，选中刚建的 `krlearn` 仓库 → Begin setup
4. 构建设置**全部留空**，只填一项：

   | 字段 | 填什么 |
   |---|---|
   | Framework preset | `None` |
   | Build command | **留空** |
   | Build output directory | `/` |

5. Save and Deploy

等 5–15 分钟（它要把 1.6 万个文件传上 Cloudflare 边缘网络）。完成后你会拿到：

```
https://krlearn.pages.dev
```

打开测一下：能翻卡片、能出声、学几个词刷新后进度还在，就成了。

### 4.1 先看预览版再放行

之后你每次 `git push`，Cloudflare 会同时生成两个部署：

- **Production**：`krlearn.pages.dev`（正式版，别人在用的）
- **Preview**：`<commit-hash>.krlearn.pages.dev`（这一版专属，链接在部署详情里）

改完东西先点 Preview 链接自己验一遍，确认没问题再去 Cloudflare 后台把那次部署 **Promote to production**。这样不会出现「刚更新完别人打开是坏的」。

---

## 五、以后怎么更新

改完词库或代码，标准流程就三条命令：

```bash
cd "D:/workbuddy工作台/2026-11-22-20-01-46/krlearn"

bash tools/check_all.sh            # 先本地验一遍（数据 + 视图 + 音频）
git add -A
git commit -m "补 50 个 TOPIK 中级词"
git push
```

推送后 Cloudflare 自动重新部署，**只传变化的文件**（音频没动就一条都不重传），通常 1–3 分钟。

> 注意：如果改了词库导致 id 重排，**必须先跑音频修复**，否则线上会出现「词和音频对不上」。
> 具体见 README 的「加词前必读」那一节。上传前本地 `python tools/audit_audio.py --stale` 确认 0 条。

---

## 六、那张 2 万文件的限额

Cloudflare Pages 免费版**每次部署最多 20,000 个文件**。你现在是 16,170 个（音频占 16,018），余量 3,830。

每加一个词会新增 **19 个文件**（词 1 + 例句 3 + 变位 15）：

```
3830 ÷ 19 ≈ 200 个词
```

也就是说**再加 200 个词就会撞墙**，那时部署会直接失败并报 `Too many files`。

到那一步有三个选择：

1. **音频拆到 Cloudflare R2**（推荐）
   R2 免费给 10GB 存储，**出网流量完全免费**。音频全部搬过去，Pages 上只剩 20 来个文件，从此不受限额。
   要做的话告诉我，改 `assets/app.js:199` 的 `URLS` 常量加一个 base 前缀即可，约 4 行。
2. **只上传用到的那几个词本**，其余音频留在本地（按词本切目录）
3. **升级 Cloudflare Pages 付费版**（$20/月，文件上限提到 10 万）——测试版没必要

---

## 七、备选：不建 GitHub，直接传

如果你暂时不想碰 git，可以用 wrangler 命令行直传。**缺点：每次更新都是全量重传 1.6 万个文件，很慢**，只适合应急。

```bat
双击  deploy.bat
```

首次运行会让你在浏览器里登录 Cloudflare 授权一次，之后就能直接用。

---

## 八、为什么选 Cloudflare Pages

| | Cloudflare Pages | GitHub Pages | EdgeOne Makers |
|---|---|---|---|
| 文件数上限 | 20,000 ✅ 刚够 | 无硬限 ✅ | 20,000 |
| 容量 | 无限 | 1GB（你 300MB） | 5GB |
| 带宽 | **无限** ✅ | 100GB/月软限 | 不限 |
| 国内速度 | 中等 | 差（github.io 常被污染） | 快（**但要备案**） |
| 更新方式 | push 自动 + 预览版 ✅ | push 自动 | push / CLI |
| 需要备案 | 否 | 否 | 国内节点需要 |

带宽这一项是决定性的：你这软件每学一个词要拉 1 条单词音频 + 3 条例句音频，一个用户一天 20 词就是 80 次请求。免费额度里真敢写「不限量」的只有 Cloudflare。

---

## 九、本次准备的文件

| 文件 | 作用 |
|---|---|
| `.gitignore` | 排除验证产物、`__pycache__`、CDP 步骤文件、一次性日志 |
| `_headers` | Cloudflare 缓存策略：音频 1 天强缓存、页面和词库每次验证 |
| `tools/init_repo.sh` | 初始化仓库 + 分 5 批提交 |
| `deploy.bat` | wrangler 直传（备选路径） |
| `DEPLOY.md` | 就是本文件 |

`启动.bat` 和 `serve.py` 是本地开发用的，部署到线上用不到，但留着无害。
