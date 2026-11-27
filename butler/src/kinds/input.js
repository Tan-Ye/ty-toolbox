// 输入事件：input.click 与 input.wheel。
// input.move / input.key 已在采集端关闭；旧数据里残留时注册表直接跳过。
export const input = {
  id: 'input',
  kinds: ['input.click', 'input.wheel'],
  parse(event) {
    if (event.kind === 'input.click') {
      // down/up 成对出现，只取 down 计一次点击
      if (event.data?.action !== 'down') return null;
      return {
        type: 'click',
        app: event.app,
        x: event.data?.x ?? null,
        y: event.data?.y ?? null,
        button: event.data?.button ?? 'left',
      };
    }
    if (event.kind === 'input.wheel') {
      return { type: 'wheel', direction: event.data?.direction ?? null, amount: event.data?.rotation ?? 0 };
    }
    return null;
  },
};
