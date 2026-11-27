// 空闲事件：idle.start / idle.end，用来从活跃时长里剔除离开电脑的时间。
export const idle = {
  id: 'idle',
  kinds: ['idle.start', 'idle.end'],
  parse(event) {
    return {
      type: event.kind === 'idle.start' ? 'idle-start' : 'idle-end',
      idleMs: event.data?.idle_ms ?? null,
      thresholdS: event.data?.threshold_s ?? null,
    };
  },
};
