#!/usr/bin/env bash
# 把 MLTDLocalServer 抓到的曲名数据同步到门户仓库（方案 A）。
#
# 为什么这样做：MLTDLocalServer 是私有仓库，门户的服务器匿名拉不到它的数据；而门户仓库是
# 公开的，服务器每天例行拉取门户仓库时就能顺带拿到曲名对照。所以由对方 CI 主动推送这一个文件。
#
# 运行位置：**门户仓库的检出目录里**（CI 先 clone 门户仓库，再 cd 进去执行）。
# 用法：
#   bash ops/publish-song-names.sh <content-overlay.sqlite 的绝对路径>
#
# 前置条件：
#   - node 22+（脚本会带 --experimental-sqlite）、git；
#   - 门户仓库的检出带可推送的令牌（见同目录 mltdlocalserver-ci-step.yml 的说明）；
#   - 可选：GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL / GIT_COMMITTER_NAME / GIT_COMMITTER_EMAIL。
#
# 安全阀（任一触发都只报错、不提交、不改动工作区）：
#   1. 导出的对照里有指向不存在曲目的条目；
#   2. 对照条数比上一次少 20% 以上（防止 CI 读到空库或陈旧库，把已经修好的对照冲掉）。
set -euo pipefail

DB="${1:-}"
if [ -z "$DB" ] || [ ! -f "$DB" ]; then
  echo "[曲名同步] 用法：bash ops/publish-song-names.sh <content-overlay.sqlite 路径>" >&2
  exit 2
fi

TARGET="public/lib/song-variants.json"
FLAGS="--experimental-sqlite --disable-warning=ExperimentalWarning"
export MLTD_OVERLAY_SQLITE="$(cd "$(dirname "$DB")" && pwd)/$(basename "$DB")"
export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-mltd-local-server-ci}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-mltd-local-server-ci@users.noreply.github.com}"
export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-$GIT_AUTHOR_NAME}"
export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-$GIT_AUTHOR_EMAIL}"

count_of() {
  if [ -f "$TARGET" ]; then
    node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));console.log(Object.keys(d.variants||{}).length)" "$TARGET"
  else
    echo 0
  fi
}

echo "[曲名同步] 源：$MLTD_OVERLAY_SQLITE"
echo "[曲名同步] 第 1 步：一致性检查（有问题就中止，不写文件）"
node $FLAGS scripts/import_song_names.mjs --check

BEFORE="$(count_of)"
echo "[曲名同步] 第 2 步：导出对照（当前 $BEFORE 条）"
node $FLAGS scripts/import_song_names.mjs
AFTER="$(count_of)"

if [ "$BEFORE" -gt 0 ] && [ "$AFTER" -lt $(( BEFORE * 80 / 100 )) ]; then
  echo "[曲名同步] 条数从 $BEFORE 掉到 $AFTER（缩减超过 20%），中止且不提交。" >&2
  echo "[曲名同步] 若确实应缩减，请人工确认后手动更新该文件。" >&2
  git checkout -- "$TARGET" 2>/dev/null || true
  exit 1
fi

if git diff --quiet -- "$TARGET" && git diff --cached --quiet -- "$TARGET"; then
  echo "[曲名同步] 第 3 步：数据没变（$AFTER 条），无需提交。"
  exit 0
fi

echo "[曲名同步] 第 3 步：提交并推送"
git add "$TARGET"
git commit -m "chore(song-names): 从 MLTDLocalServer 抓包刷新曲名对照（$AFTER 条）"
if git push; then
  echo "[曲名同步] 完成：已推送 $AFTER 条对照。门户服务器下次例行拉取时会自动生效。"
else
  # 推送失败（最常见是没配令牌）时把这次提交撤掉，避免在别人的检出里留下半截提交。
  echo "[曲名同步] 推送失败（多半是没配置令牌）。已撤销本次提交，工作区保持干净。" >&2
  git reset --hard HEAD~1
  exit 1
fi
