#!/usr/bin/env bash
# ============================================================
# 构建并部署 MD-DB Obsidian 插件到指定插件目录
#
# 用法:
#   ./scripts/deploy.sh                           # 部署到默认目录
#   ./scripts/deploy.sh /path/to/vault/.obsidian/plugins/md-db
#   npm run deploy                                # 同上（使用默认目录）
#   npm run deploy -- /path/to/vault              # 指定 vault 路径
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# 默认部署路径
DEFAULT_TARGET="/c/Users/cgf/Desktop/税法/CPA项目与财务工作笔记/.obsidian/plugins/md-db"

# 参数 1：目标路径（可选），未提供则用默认
TARGET="${1:-$DEFAULT_TARGET}"

echo "📦 构建 MD-DB 插件..."
cd "$PROJECT_DIR"

# esbuild 构建（跳过 tsc 类型检查，因存在上游遗留的 TS 错误）
node esbuild.config.mjs production

echo "📋 部署到: $TARGET"
cp main.js manifest.json "$TARGET"
# main.css 由 esbuild 从 React 组件 CSS import 生成
# 重命名为 styles.css 供 Obsidian 加载
cp main.css "$TARGET/styles.css"

echo "✅ 部署完成"
echo "   main.js     $(du -h main.js | cut -f1)"
echo "   manifest.json"
echo "   styles.css  $(du -h main.css | cut -f1)"
echo ""
echo "🔄 在 Obsidian 中重新加载插件即可生效"
