#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 audio/ 上传到 Cloudflare R2（S3 兼容接口）。

为什么要拆：
  Cloudflare Pages 免费版每次部署上限 20,000 个文件，本项目音频占 16,018 个，
  只剩约 3,900 个余量 —— 每加一个词新增 19 个文件，也就是再加 200 词就撞墙。
  音频搬到 R2 后 Pages 上只剩几十个文件，词库想加多少加多少。
  R2 免费额度：10GB 存储，**出网流量不计费**。

前置（都在 Cloudflare 控制台点，不需要信用卡之外的任何东西）：
  1. R2 → Create bucket，名字如 krlearn-audio
  2. 进 bucket → Settings → Public access，开一个 r2.dev 子域（测试够用）
     或绑自己的域名（生产推荐，r2.dev 有速率限制）
  3. R2 → Manage R2 API Tokens → Create API token，权限给 Object Read & Write
     记下 Access Key ID 和 Secret Access Key
  4. Account ID 在控制台右侧边栏 / 地址栏里
  5. pip install boto3

用法（Git Bash，在项目根目录）：
  export R2_ACCOUNT_ID=xxxxxxxx
  export R2_ACCESS_KEY_ID=xxxxxxxx
  export R2_SECRET_ACCESS_KEY=xxxxxxxx
  export R2_BUCKET=krlearn-audio
  export R2_PUBLIC_BASE=https://pub-xxxx.r2.dev/     # 可选，只是最后打印提示

  python tools/upload_r2.py --dry    # 只统计，不传
  python tools/upload_r2.py          # 开传（已存在的自动跳过，可重复跑）
  python tools/upload_r2.py --force  # 强制全量重传

对象 key 保留 audio/ 前缀（audio/words/w0001.mp3），所以 index.html 里
window.KR_AUDIO_BASE 填站点根即可，脚本末尾会打印应填的完整值。
"""
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
AUDIO = ROOT / "audio"


def die(msg):
    print("错误：" + msg)
    sys.exit(1)


def get_cfg():
    cfg = {k: os.environ.get("R2_" + k, "").strip() for k in
           ("ACCOUNT_ID", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY", "BUCKET", "PUBLIC_BASE")}
    missing = [k for k in ("ACCOUNT_ID", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY", "BUCKET")
               if not cfg[k]]
    if missing:
        die("缺少环境变量：" + ", ".join("R2_" + k for k in missing)
            + "\n   见本文件顶部注释。")
    return cfg


def main():
    args = set(sys.argv[1:])
    dry = "--dry" in args
    force = "--force" in args

    if not AUDIO.is_dir():
        die("找不到 audio/ 目录：" + str(AUDIO))

    files = sorted(AUDIO.rglob("*.mp3"))
    if not files:
        die("audio/ 下没有 mp3")

    total_bytes = sum(f.stat().st_size for f in files)
    print("本地音频：%d 个文件，%.1f MB" % (len(files), total_bytes / 1048576))

    if dry:
        print("\n--dry 模式，不上传。去掉 --dry 即开始。")
        return

    try:
        import boto3
        from botocore.config import Config
        from botocore.exceptions import ClientError
    except ImportError:
        die("没装 boto3。先跑：pip install boto3")

    cfg = get_cfg()
    s3 = boto3.client(
        "s3",
        endpoint_url="https://%s.r2.cloudflarestorage.com" % cfg["ACCOUNT_ID"],
        aws_access_key_id=cfg["ACCESS_KEY_ID"],
        aws_secret_access_key=cfg["SECRET_ACCESS_KEY"],
        region_name="auto",
        config=Config(retries={"max_attempts": 3, "mode": "standard"},
                      max_pool_connections=32),
    )
    bucket = cfg["BUCKET"]

    # 先拉远端已有 key 列表，一次 list 比逐个 head 快得多
    remote = set()
    if not force:
        print("读取远端已有对象…")
        t0 = time.time()
        token = None
        while True:
            kw = {"Bucket": bucket, "MaxKeys": 1000}
            if token:
                kw["ContinuationToken"] = token
            try:
                r = s3.list_objects_v2(**kw)
            except ClientError as e:
                die("列举失败（bucket 名对吗？权限给了 Object Read & Write 吗？）\n   "
                    + str(e))
            for o in r.get("Contents", []):
                remote.add(o["Key"])
            if not r.get("IsTruncated"):
                break
            token = r.get("NextContinuationToken")
        print("  远端已有 %d 个对象（%.1fs）" % (len(remote), time.time() - t0))

    todo = []
    for f in files:
        key = f.relative_to(ROOT).as_posix()   # audio/words/w0001.mp3
        if key in remote:
            continue
        todo.append((f, key))

    print("待上传：%d 个（跳过 %d 个）" % (len(todo), len(files) - len(todo)))
    if not todo:
        print("\n全部已存在，无需上传。")
        print_base(cfg)
        return

    done = 0
    failed = []
    t0 = time.time()
    lock_n = {"n": 0}

    def up(item):
        f, key = item
        body = f.read_bytes()
        s3.put_object(
            Bucket=bucket,
            Key=key,
            Body=body,
            ContentType="audio/mpeg",
            CacheControl="public, max-age=86400",
        )
        return key, len(body)

    with ThreadPoolExecutor(max_workers=24) as ex:
        futs = [ex.submit(up, it) for it in todo]
        for fu in as_completed(futs):
            done += 1
            try:
                fu.result()
            except Exception as e:
                failed.append(str(e)[:120])
            if done % 200 == 0 or done == len(todo):
                el = time.time() - t0
                rate = done / el if el > 0 else 0
                print("  %d/%d  %.0f 个/秒  已用 %.0fs"
                      % (done, len(todo), rate, el))

    print("\n完成：成功 %d，失败 %d，用时 %.1fs"
          % (len(todo) - len(failed), len(failed), time.time() - t0))
    if failed:
        print("部分失败（前 5 条）：")
        for m in failed[:5]:
            print("  " + m)
        print("直接重跑本脚本即可续传（已成功的不再重传）。")
    print_base(cfg)


def print_base(cfg):
    base = cfg.get("PUBLIC_BASE") or ""
    print("\n下一步：把 index.html 里这一行改成")
    if base:
        b = base if base.endswith("/") else base + "/"
        print("  window.KR_AUDIO_BASE = '%s';" % b)
        print("\n（填站点根或填到 .../audio/ 都行，代码会自动归一化。）")
    else:
        print("  window.KR_AUDIO_BASE = 'https://<你的R2公开域名>/';")
        print("\n没设 R2_PUBLIC_BASE，所以不知道你的公开域名。")
        print("在 R2 bucket 的 Settings → Public access 里能看到。")


if __name__ == "__main__":
    main()
