/**
 * 文件哈希存储层
 *
 * 管理 file_hashes.json 的读写。
 *
 * 参考：runtime-architecture.md §8
 */

type FileHashes = Record<string, string>;

export class FileHashStore {
  private hashes: FileHashes = {};

  /** 获取单个文件的哈希 */
  getHash(filePath: string): string | undefined {
    return this.hashes[filePath];
  }

  /** 设置单个文件的哈希 */
  setHash(filePath: string, hash: string): void {
    this.hashes[filePath] = hash;
  }

  /** 批量设置 */
  setHashes(hashes: FileHashes): void {
    this.hashes = { ...this.hashes, ...hashes };
  }

  /** 获取所有哈希 */
  getAll(): FileHashes {
    return { ...this.hashes };
  }

  /** 删除文件的哈希 */
  remove(filePath: string): void {
    delete this.hashes[filePath];
  }

  /** 检查文件哈希是否匹配 */
  isMatch(filePath: string, hash: string): boolean {
    const stored = this.hashes[filePath];
    return stored !== undefined && stored === hash;
  }

  /** 清除所有哈希 */
  clearAll(): void {
    this.hashes = {};
  }

  /** 序列化 */
  toJson(): string {
    return JSON.stringify(this.hashes, null, 2);
  }

  /** 反序列化 */
  fromJson(json: string): void {
    try {
      const parsed = JSON.parse(json);
      if (typeof parsed === 'object' && parsed !== null) {
        this.hashes = parsed as FileHashes;
      }
    } catch {
      this.hashes = {};
    }
  }

  /** 文件数 */
  count(): number {
    return Object.keys(this.hashes).length;
  }
}
