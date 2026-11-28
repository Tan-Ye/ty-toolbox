/**
 * 文件写入队列。
 *
 * 同一个队列中的写操作严格按提交顺序执行，避免多个异步调用同时
 * 修改同一数据目录时互相覆盖或交错写入。操作失败不会阻塞后续操作。
 */
export class FileWriteQueue {
  /** 队列尾部；始终被转换为已解决状态，保证队列可以继续运行。 */
  private tail: Promise<void> = Promise.resolve();

  /** 将一个文件写操作加入队列，并返回该操作的结果。 */
  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queuedOperation = this.tail.then(operation, operation);
    this.tail = queuedOperation.then(
      () => undefined,
      () => undefined,
    );
    return queuedOperation;
  }

  /** 等待当前已经提交的写操作全部完成。 */
  async drain(): Promise<void> {
    await this.tail;
  }
}
