// 应用生命周期事件：app.start / app.stop。
// 注意：app 为 null 的 app.start 是采集器自身的启动标记，分析器忽略。
export const appLifecycle = {
  id: 'app.lifecycle',
  kinds: ['app.start', 'app.stop'],
  parse(event) {
    const isStart = event.kind === 'app.start';
    if (!event.app && isStart && event.data?.version) {
      // 采集器自身启动，记一下但不参与应用统计
      return { type: 'lifecycle', phase: 'collector-start', data: event.data };
    }
    if (!isStart && event.data?.reason) {
      return { type: 'lifecycle', phase: 'collector-stop', data: event.data };
    }
    return {
      type: 'lifecycle',
      phase: isStart ? 'start' : 'stop',
      app: event.app,
      data: event.data,
    };
  },
};
