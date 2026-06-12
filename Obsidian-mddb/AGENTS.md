# MD-DB — Obsidian Plugin

## Project overview

- **Target**: Obsidian Community Plugin (TypeScript → esbuild → bundled JavaScript).
- **Purpose**: Markdown 数据库引擎 — 将 `.md` 文件解析为内存 SQLite 数据库，支持结构化查询与 CRUD。
- Entry point: `src/main.ts` compiled to `main.js`.
- Required release artifacts: `main.js`, `manifest.json`, `styles.css`.
- Runtime dependency: `sql.js` (SQLite WASM, ~50KB gzip).

## Design documents

All architecture decisions are documented in `docs/specs/` at the project root:

| Document | Content |
|----------|---------|
| `storage-engine-design.md` | PK system, _binding table, CRUD, WAL, cold start |
| `parse-pipeline-design.md` | 6-stage parse pipeline (Schema → Lexer → TypeConverter → Validator → IndexWriter) |
| `query-engine-design.md` | Structured query (FilterGroup, ref follow, groupBy, sort) |
| `transaction-model-design.md` | Single/cross-file transactions, WAL-driven commit |
| `view-layer-design.md` | BaseViewModel, TableView, FormView, mddb-table/mddb-form |
| `implementation-roadmap.md` | 20-phase implementation plan with dependencies |
| `example-dataset.md` | Complete test dataset (personal finance) |
| `dependencies-and-references.md` | Dependencies, Obsidian APIs, reference projects |

Always consult these docs before implementing. The roadmap defines phase order; each phase references specific design decisions.

## Environment & tooling

- **Node.js**: LTS (18+).
- **Package manager: npm**.
- **Bundler: esbuild** — config in `esbuild.config.mjs`. `obsidian`, `electron`, `sql.js`, and CodeMirror packages set as `external`.
- **SQLite**: sql.js (WASM) — no native dependencies, works on desktop and mobile.
- **Testing**: vitest. Mock Obsidian API via inline stubs.
- **Types**: `obsidian` type definitions.

```bash
npm install        # Install dependencies
npm run dev        # Dev mode (watch)
npm run build      # Production build
npm test           # Run tests
npm run lint       # ESLint check
```

## File & folder conventions

- **Keep `main.ts` minimal**: plugin lifecycle only (onload, onunload, addCommand). Delegate features to separate modules.
- **Split by architecture layer**:
    ```
    src/
      main.ts            # Plugin entry, lifecycle management
      settings.ts        # Settings interface, defaults, settings tab
      constants.ts       # Paths, magic numbers, default values
      types.ts           # Shared TypeScript types (Schema, ParseResult, etc.)
      schema/            # Phase 3 — Schema resolver
      lexer/             # Phase 4 — mddb block detection, line classification
      converter/         # Phase 5 — 12 field type converters
      validator/         # Phase 6 — field count, required, PK uniqueness
      writer/            # Phase 7 — binding table + user table writes
      pipeline/          # Phase 8 — parseFile / parseAllFiles integration
      crud/              # Phase 9 — INSERT/UPDATE/DELETE/SELECT
      wal/               # Phase 10 — WalManager, retry loop
      rescan/            # Phase 11 — 3-tier rescan strategies
      coldstart/         # Phase 12 — cache-first cold start
      watcher/           # Phase 13 — Vault event handlers
      statusbar/         # Phase 14 — Status bar + logging
      query/             # Phase 15 — QueryEngine, SQLGenerator, ResultAssembler
      transaction/       # Phase 16 — TransactionManager, ConflictDetector
      view/              # Phase 17 — BaseViewModel, TableView, FormView, Parser
      binding/           # Phase 2 — SQLite init, _binding DDL, storage PK
      utils/             # sha256, UUID, file path helpers
    ```
- **One module per Phase**: don't intermix parse pipeline logic with query engine logic.
- **Do not commit**: `node_modules/`, `main.js`, `package-lock.json`.
- **File size**: if > 300 lines, consider splitting into sub-modules.
- **Generated output**: `main.js` at plugin root (esbuild output).

## Manifest rules (`manifest.json`)

- `id`: `md-db` — **never change after first release**.
- `name`: `MD-DB`.
- `minAppVersion`: `1.4.0` (Vault API + MarkdownPostProcessor required).
- `isDesktopOnly`: `false` (sql.js WASM works on mobile).

## Schema & data format (MD-DB specific)

### Two fence types

| Fence | Content | Parser behavior |
|-------|---------|----------------|
| ` ```dmdb-schema ` | `@` directives only | Parse `@table`, `@pk`, `@fields`, `@types`, etc. |
| ` ```mddb ` | Data rows only | Split on `\|`, type convert, validate |

### Data row format

- Fields separated by `|`. Leading/trailing `|` optional — parser normalizes before split.
- `\|` escapes literal pipe; `\\` escapes literal backslash.
- `-` = NULL (default null marker, configurable via `@nullMarker`).

### Schema directives

`@table`, `@pk`, `@fields`, `@types`, `@required`, `@sort`, `@indexes`, `@relations`, `@nullMarker`, `@strict`

### PK strategies

- Single column: `@pk name`
- Composite: `@pk (日期, 金额, 商户)`
- Auto UUID: `@pk $uuid` (PK not in fields list, engine generates)

### Type system (12 types)

`string`, `integer`, `decimal(N)`, `boolean`, `date`, `datetime`, `enum(v1,v2,...)`, `text`, `tags`, `ref(table)`, `phone`, `email`

### Multi-table files

Data blocks in multi-table files MUST use `schema=` info string:

````markdown
```mddb schema=monthly_budgets
2024-01 | 8000.00 | 7650.50 | on_track
```
````

## Key architecture decisions

1. **INSERT always appends to end of file** — physical order = write order; display order via `@sort`.
2. **Single-file transactions use surgical line editing** — `vault.process()` callback modifies specific lines, preserving free text.
3. **Cross-file transactions use WAL-driven commit** — `wal/{txId}.json` files with exponential backoff retry.
4. **Ref integrity checked at query time** — ref values stored as-is; broken refs return NULL.
5. **File-level lock (Set<string>)** prevents cold-start background verify and file watcher from racing.
6. **`_binding` table includes `table_name` column** — supports multiple tables per file.
7. **`FieldType` stores full type string** (e.g. `"decimal(2)"`) — downstream formatters parse precision.

## Commands & settings

| Command ID | Name |
|-----------|------|
| `rescan-vault` | Rescan vault |
| `show-stats` | Show stats |
| `clear-cache` | Clear cache and rebuild |

Settings: `logLevel` (error|warn|info|debug), `autoScanOnStart` (bool), `backgroundRescanIntervalMin` (number). Persisted via `this.loadData()` / `this.saveData()`.

## View code blocks (Phase 17)

- `mddb-table`: from / show / sort by / where / limit
- `mddb-form`: to / fields / mode / layout / keep-open

Registered via `this.registerMarkdownCodeBlockProcessor()`.

## Performance

- **Defer heavy work**: `onLayoutReady()` before cold-start scan.
- **Batch disk access**: Phase 12 validates files one at a time, throttled.
- **Debounce file watcher**: vault.on('modify') with diffs, not full rescan.
- **sql.js in memory**: _binding + user tables kept in WASM memory; `binding.db` is a cache snapshot.

## Coding conventions

- TypeScript with `"strict": true`.
- `async/await` over promise chains.
- `this.register*` helpers for all listeners, intervals, events.
- Stable command IDs — never rename after release.
- Prefer `crypto.randomUUID()` for UUIDs, `crypto.subtle.digest('SHA-256', ...)` for hashing.
- No network calls (fully offline); no telemetry.

## Mobile

- `isDesktopOnly: false`.
- sql.js WASM works on iOS/Android.
- Avoid large in-memory structures; `_binding` table indexes keep queries fast.

## Agent do/don't

**Do**
- Consult `docs/specs/` design documents before implementing any phase.
- Follow the roadmap's phase dependency order.
- Use existing example data in `example/` for test cases.
- Add commands with stable IDs.
- Register all listeners/intervals with `this.register*` helpers.
- Update `implementation-roadmap.md` if design decisions change during implementation.

**Don't**
- Introduce network calls or cloud dependencies.
- Rename command IDs or schema directives after release.
- Put business logic in `main.ts` — delegate to phase modules.
- Commit `node_modules/` or `main.js`.

## References

- Project design docs: `../docs/specs/` (at project root)
- Example vault: `../example/` (at project root)
- Obsidian API docs: https://docs.obsidian.md
- Obsidian sample plugin: https://github.com/obsidianmd/obsidian-sample-plugin
- Developer policies: https://docs.obsidian.md/Developer+policies
