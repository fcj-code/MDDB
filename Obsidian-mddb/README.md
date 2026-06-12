# MD-DB — Markdown Database Engine for Obsidian

将 `.md` 文件中的结构化数据解析为可查询的内存 SQLite 数据库，提供完整的 CRUD、事务、崩溃恢复能力。

## 快速开始

```bash
git clone <repo>
cd Obsidian-mddb
npm install
npm run dev       # 开发模式（watch）
npm run build     # 生产构建
npm test          # 运行测试
npm run lint      # ESLint 检查
```

## 手动安装

将 `main.js`、`manifest.json`、`styles.css` 复制到 Vault 的 `.obsidian/plugins/md-db/` 目录。

## 技术栈

- TypeScript + esbuild
- sql.js (SQLite WASM)
- Obsidian Plugin API

## 参考

- obsidian-sample-plugin (脚手架模板)
- obsidian-dataview (索引-查询-渲染)
- obsidian-modal-form (表单)
- obsidian-dataloom (表格)
