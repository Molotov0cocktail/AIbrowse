import { describe, expect, it, vi } from 'vitest';
import { TrayController } from './tray-controller';

function setup() {
  const steps: string[] = [];
  let visible = true;
  let destroyed = false;
  let onShow = () => {};
  let onQuit = () => {};
  const tray = {
    destroy: vi.fn(() => {
      destroyed = true;
      steps.push('destroy');
    }),
    isDestroyed: () => destroyed,
  };
  const ports = {
    createTray: vi.fn((show: () => void, quit: () => void) => {
      steps.push('create');
      onShow = show;
      onQuit = quit;
      return tray;
    }),
    saveEnabled: vi.fn((value: boolean) => {
      steps.push(`save:${value}`);
    }),
    showWindow: vi.fn(() => {
      visible = true;
      steps.push('show');
    }),
    hideWindow: vi.fn(() => {
      visible = false;
      steps.push('hide');
    }),
    isWindowVisible: () => visible,
    canHide: vi.fn(() => true),
    requestQuit: vi.fn(() => {
      steps.push('quit');
    }),
    reportError: vi.fn(),
  };
  const controller = new TrayController(ports);
  const close = () => {
    const event = { preventDefault: vi.fn() };
    const handled = controller.handleClose(event);
    return { handled, event };
  };
  return {
    controller,
    ports,
    steps,
    tray,
    close,
    onShow: () => onShow(),
    onQuit: () => onQuit(),
    visible: () => visible,
  };
}

describe('托盘生命周期', () => {
  it('默认关闭放行关闭窗口，启用先建托盘后保存且关闭只隐藏', () => {
    const h = setup();
    h.controller.initialize(false);
    expect(h.close().handled).toBe(false);
    h.controller.setEnabled(true);
    expect(h.steps).toEqual(['create', 'save:true']);
    expect(h.close().event.preventDefault).toHaveBeenCalledOnce();
    expect(h.visible()).toBe(false);
    expect(h.ports.requestQuit).not.toHaveBeenCalled();
    h.onShow();
    expect(h.visible()).toBe(true);
  });

  it('已保存启用在启动重建托盘而不重复写盘', () => {
    const h = setup();
    h.controller.initialize(true);
    expect(h.controller.isEnabled()).toBe(true);
    expect(h.ports.saveEnabled).not.toHaveBeenCalled();
    expect(h.close().handled).toBe(true);
  });

  it('创建失败不会保存且窗口仍能正常关闭', () => {
    const h = setup();
    h.ports.createTray.mockImplementation(() => {
      throw new Error('private-native-detail');
    });
    expect(() => h.controller.setEnabled(true)).toThrow('无法创建托盘');
    expect(h.ports.saveEnabled).not.toHaveBeenCalled();
    expect(h.close().handled).toBe(false);
    h.controller.initialize(true);
    expect(h.ports.reportError).toHaveBeenCalledWith('无法创建托盘，关闭窗口将退出应用。');
  });

  it('保存启用失败销毁候选托盘并保留禁用状态', () => {
    const h = setup();
    h.ports.saveEnabled.mockImplementation(() => {
      throw new Error('private-disk-detail');
    });
    expect(() => h.controller.setEnabled(true)).toThrow('无法保存托盘设置');
    expect(h.tray.destroy).toHaveBeenCalledOnce();
    expect(h.controller.isEnabled()).toBe(false);
    expect(h.close().handled).toBe(false);
  });

  it('隐藏时禁用先恢复窗口后保存和销毁，保存失败保留托盘', () => {
    const h = setup();
    h.controller.initialize(true);
    h.close();
    h.steps.length = 0;
    h.ports.saveEnabled.mockImplementationOnce(() => {
      throw new Error('disk');
    });
    expect(() => h.controller.setEnabled(false)).toThrow('无法保存托盘设置');
    expect(h.visible()).toBe(true);
    expect(h.controller.isEnabled()).toBe(true);
    expect(h.tray.destroy).not.toHaveBeenCalled();
    h.close();
    h.steps.length = 0;
    h.controller.setEnabled(false);
    expect(h.steps).toEqual(['show', 'save:false', 'destroy']);
    expect(h.close().handled).toBe(false);
  });

  it('明确退出恢复窗口后调用正常退出，取消后重新允许隐藏', () => {
    const h = setup();
    h.controller.initialize(true);
    h.close();
    h.steps.length = 0;
    h.onQuit();
    expect(h.steps).toEqual(['show', 'quit']);
    expect(h.close().handled).toBe(false);
    h.controller.cancelQuit();
    expect(h.close().handled).toBe(true);
    h.controller.beginQuit();
    expect(h.visible()).toBe(true);
    expect(h.close().handled).toBe(false);
  });

  it('非正常运行期间不拦截关闭', () => {
    const h = setup();
    h.controller.initialize(true);
    h.ports.canHide.mockReturnValue(false);
    expect(h.close().handled).toBe(false);
    expect(h.ports.hideWindow).not.toHaveBeenCalled();
  });

  it('托盘已毁时恢复隐藏窗口并放行关闭', () => {
    const h = setup();
    h.controller.initialize(true);
    h.close();
    h.tray.destroy();
    expect(h.controller.isEnabled()).toBe(false);
    expect(h.visible()).toBe(true);
    expect(h.close().handled).toBe(false);
  });

  it('销毁幂等且不遗留隐藏窗口，销毁后不能重新启用', () => {
    const h = setup();
    h.controller.initialize(true);
    h.close();
    h.controller.dispose();
    h.controller.dispose();
    expect(h.visible()).toBe(true);
    expect(h.tray.destroy).toHaveBeenCalledOnce();
    expect(h.close().handled).toBe(false);
    expect(() => h.controller.setEnabled(true)).toThrow('托盘已关闭');
  });

  it('窗口恢复失败时不移除托盘、不保存禁用', () => {
    const h = setup();
    h.controller.initialize(true);
    h.close();
    h.ports.showWindow.mockImplementation(() => {
      throw new Error('window');
    });
    expect(() => h.controller.setEnabled(false)).toThrow('无法恢复主窗口');
    expect(h.ports.saveEnabled).not.toHaveBeenCalled();
    expect(h.tray.destroy).not.toHaveBeenCalled();
  });

  it('隐藏失败保留恢复入口，并可明确退出且不重复退出', () => {
    const h = setup();
    h.controller.initialize(true);
    h.ports.hideWindow.mockImplementation(() => {
      throw new Error('private-native-error');
    });
    expect(h.close().handled).toBe(true);
    expect(h.visible()).toBe(true);
    expect(h.ports.reportError).toHaveBeenCalledWith('无法隐藏主窗口，请通过托盘菜单退出应用。');
    h.controller.requestQuit();
    h.controller.requestQuit();
    expect(h.ports.requestQuit).toHaveBeenCalledOnce();
  });

  it('退出过程中拒绝修改配置，重复初始化不重复创建托盘', () => {
    const h = setup();
    h.controller.initialize(true);
    h.controller.initialize(true);
    expect(h.ports.createTray).toHaveBeenCalledOnce();
    h.controller.beginQuit();
    expect(() => h.controller.setEnabled(false)).toThrow('托盘已关闭');
    expect(h.ports.saveEnabled).not.toHaveBeenCalled();
  });

  it('创建时已毁的托盘不构成可隐藏窗口的有效入口', () => {
    const h = setup();
    h.tray.destroy();
    h.controller.initialize(true);
    expect(h.controller.isEnabled()).toBe(false);
    expect(h.close().handled).toBe(false);
    expect(h.ports.saveEnabled).not.toHaveBeenCalled();
  });
});
