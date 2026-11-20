import localtunnel from 'localtunnel';

const TUNNEL_TIMEOUT_MS = 15_000;

export interface TunnelHandle {
  readonly url: string;
  close(): void;
  onClosed(callback: (reason: string) => void): void;
}

export interface TunnelFactory {
  open(port: number): Promise<TunnelHandle>;
}

/**
 * 超时后迟到的隧道先挂一个空 `'error'` 监听再关闭：
 * teardown 期间的错误事件如果没有监听者会升级成未捕获异常，直接崩掉主进程。
 */
function discardLateTunnel(value: unknown): void {
  const late = value as {
    close(): void;
    on?: (event: 'error', listener: (error: Error) => void) => unknown;
  };
  try {
    late.on?.('error', () => undefined);
  } catch {
    // 句柄不支持事件监听时直接关闭。
  }
  try {
    late.close();
  } catch {
    // 超时后迟到的隧道直接关闭，避免遗留连接。
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error('内网穿透不可用（启动超时）'));
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        if (timedOut) {
          discardLateTunnel(value);
          return;
        }
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export const localTunnelFactory: TunnelFactory = {
  async open(port: number): Promise<TunnelHandle> {
    const tunnel = await withTimeout(
      localtunnel({ port, local_host: '127.0.0.1' }),
      TUNNEL_TIMEOUT_MS,
    );
    const listeners: Array<(reason: string) => void> = [];
    const notify = (reason: string): void => {
      for (const listener of listeners) listener(reason);
    };
    tunnel.on('close', () => notify('穿透连接已关闭'));
    tunnel.on('error', (error) => notify(`穿透连接中断：${error.message}`));
    let closed = false;
    return {
      url: tunnel.url,
      close: () => {
        if (closed) return;
        closed = true;
        try {
          tunnel.close();
        } catch {
          // 已关闭时重复 close 直接忽略。
        }
      },
      onClosed: (callback) => listeners.push(callback),
    };
  },
};