/** Obsidian 插件 ID */
export const PLUGIN_ID = 'md-db';

/** 插件在 .obsidian/plugins/ 下的目录名 */
export const PLUGIN_DIR = 'md-db';

/** 缓存子目录 */
export const CACHE_DIR = 'cache';

/** WAL 子目录 */
export const WAL_DIR = 'wal';

/** 日志子目录 */
export const LOG_DIR = 'logs';

/** 绑定表 SQLite 文件名 */
export const BINDING_DB = 'binding.db';

/** 文件哈希缓存文件名 */
export const FILE_HASHES = 'file_hashes.json';

/** Schema 注册表文件名 */
export const SCHEMA_REGISTRY = 'schema_registry.json';

/** 默认空值占位符 */
export const DEFAULT_NULL_MARKER = '-';

/** 日志保留天数 */
export const LOG_RETENTION_DAYS = 7;

/** WAL 最大重试次数 */
export const WAL_MAX_RETRIES = 10;

/** WAL 指数退避间隔（秒） */
export const WAL_BACKOFF_SECONDS = [1, 2, 4, 8, 16, 30, 60, 120, 300, 600];

/** 事件递归最大深度 */
export const EVENT_MAX_RECURSION = 10;
