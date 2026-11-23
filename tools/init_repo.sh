#!/usr/bin/env bash
# 初始化 git 仓库，分 5 批提交（避免 300MB 一次推送中途断掉）
# 用法：bash tools/init_repo.sh
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> 当前目录：$(pwd)"
echo

# --- 检查 git 身份 ---
if ! git config user.email >/dev/null 2>&1; then
  echo "!! 还没有设置 git 身份，先跑这两条（只需一次）："
  echo '   git config --global user.name  "你的名字"'
  echo '   git config --global user.email "你的邮箱@example.com"'
  exit 1
fi

# --- init ---
if [ -d .git ]; then
  echo "==> 已有 .git，跳过初始化"
else
  git init -q
  echo "==> 已初始化空仓库"
fi

# 换行策略由 .gitattributes 的 `* -text` 兜住，这里再锁一次防意外
git config core.autocrlf false
git config core.safecrlf false

echo
echo "==> 开始分批提交（每批一个 commit，推送中断可直接重跑 git push）"
echo

commit_batch() {
  local msg="$1"; shift
  local n
  n=$(git diff --cached --name-only | wc -l)
  if [ "$n" -eq 0 ]; then
    echo "  [跳过] $msg —— 没有新增文件"
    return 0
  fi
  git commit -q -m "$msg"
  echo "  [完成] $msg（$n 个文件）"
}

# 第 1 批：站点外壳 + 词库数据 + 部署配置（约 4MB，最快）
git add .gitignore .gitattributes _headers README.md DEPLOY.md \
        index.html serve.py assets vendor data
git add -- "启动.bat"
commit_batch "chore: 站点外壳、词库数据与部署配置"

# 第 2 批：字母 / 音节 / 变位音频（652 条源 + 3090 条变位 ≈ 3.5k 文件）
git add audio/letters audio/syl audio/conj
commit_batch "audio: 字母、音节、变位形式"

# 第 3 批：单词音频（5926 条）
git add audio/words
commit_batch "audio: 单词"

# 第 4 批：例句音频（6556 条，最大的一批）
git add audio/sent
commit_batch "audio: 例句"

# 第 5 批：构建与校验脚本
git add tools
commit_batch "tools: 词库构建、变位引擎、音频校验"

# 兜底：把剩下的一起收掉（正常情况下没有剩余）
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  commit_batch "chore: 收尾"
fi

echo
echo "==> 仓库就绪"
echo "    提交数：$(git rev-list --count HEAD 2>/dev/null || echo 0)"
echo "    跟踪文件：$(git ls-files | wc -l) 个"
echo "    仓库体积：$(du -sh .git | cut -f1)"
echo "    工作区体积：$(git ls-files -z | xargs -0 du -ch 2>/dev/null | tail -1 | cut -f1)"
echo
echo "下一步（把 用户名 换成你自己的）："
echo "  git remote add origin https://github.com/用户名/krlearn.git"
echo "  git branch -M main"
echo "  git push -u origin main"
echo
echo "详细步骤见 DEPLOY.md"
