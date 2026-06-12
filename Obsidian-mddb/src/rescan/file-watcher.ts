/**
 * 文件监视器 (FileWatcher)
 *
 * 负责检测 Obsidian vault 中的文件变更事件。
 *
 * 参考：v2 roadmap §3（FileWatcher）
 *
 * 支持事件：
 * - file-create: 新文件包含 mddb 块 → 解析并索引
 * - file-modify: 已有文件变更 → diff 后增量或整文件重建
 * - file-delete: 删除文件 → 清理该文件贡献的数据
 * - file-rename: 文件重命名 → 更新 filePath 引用
 *
 * 自改识别：
 * - TransactionManager 设置 write owner
 * - 通过 ownerId 识别自改事件，跳过重复处理或精确同步
 */

import type { FileOperator } from '../write/types';

// ============================================================
// 事件类型
// ============================================================

export type FileChangeType = 'create' | 'modify' | 'delete' | 'rename';

export interface FileChangeEvent {
  type: FileChangeType;
  filePath: string;
  oldPath?: string; // rename 时使用
  /** 写入所有者标识（自改时由 CRUDExecutor 设置） */
  ownerId?: string;
}

export type FileChangeHandler = (event: FileChangeEvent) => void | Promise<void>;

// ============================================================
// 文件监视器
// ============================================================

export class FileWatcher {
  private handlers = new Map<FileChangeType, Set<FileChangeHandler>>();
  private _activeOwners = new Set<string>();
  private _shutdown = false;

  constructor() {
    for (const type of ['create', 'modify', 'delete', 'rename'] as FileChangeType[]) {
      this.handlers.set(type, new Set());
    }
  }

  // ============================================================
  // 自改识别
  // ============================================================

  /**
   * 注册一个活跃写入所有者
   */
  registerOwner(ownerId: string): void {
    this._activeOwners.add(ownerId);
  }

  /**
   * 注销一个写入所有者
   */
  unregisterOwner(ownerId: string): void {
    this._activeOwners.delete(ownerId);
  }

  /**
   * 判断事件是否为自改（应该被跳过或特殊处理）
   */
  isSelfChange(event: FileChangeEvent): boolean {
    if (event.ownerId && this._activeOwners.has(event.ownerId)) {
      return true;
    }
    return false;
  }

  // ============================================================
  // 事件处理
  // ============================================================

  /**
   * 注册变更处理器
   */
  on(type: FileChangeType, handler: FileChangeHandler): () => void {
    const handlers = this.handlers.get(type);
    if (!handlers) {
      throw new Error(`Unknown file change type: ${type}`);
    }
    handlers.add(handler);

    // 返回取消注册函数
    return () => {
      handlers.delete(handler);
    };
  }

  /**
   * 触发变更事件
   *
   * 根据自改识别结果决定是否跳过处理。
   */
  async emit(event: FileChangeEvent): Promise<void> {
    if (this._shutdown) return;

    // 自改事件：跳过处理
    if (this.isSelfChange(event)) {
      return;
    }

    const handlers = this.handlers.get(event.type);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        await handler(event);
      } catch {
        // 单个 handler 异常不影响其他 handler
      }
    }
  }

  // ============================================================
  // 外部接口
  // ============================================================

  /**
   * 通知文件创建
   */
  async onFileCreate(filePath: string): Promise<void> {
    await this.emit({ type: 'create', filePath });
  }

  /**
   * 通知文件修改
   */
  async onFileModify(filePath: string, ownerId?: string): Promise<void> {
    await this.emit({ type: 'modify', filePath, ownerId });
  }

  /**
   * 通知文件删除
   */
  async onFileDelete(filePath: string): Promise<void> {
    await this.emit({ type: 'delete', filePath });
  }

  /**
   * 通知文件重命名
   */
  async onFileRename(oldPath: string, newPath: string): Promise<void> {
    await this.emit({ type: 'rename', filePath: newPath, oldPath });
  }

  // ============================================================
  // 生命周期
  // ============================================================

  /**
   * 关闭监视器
   */
  shutdown(): void {
    this._shutdown = true;
    this.handlers.clear();
    this._activeOwners.clear();
  }
}
