import { generateKeyPairSync } from 'node:crypto';
import { get } from 'node:https';
import { connect } from 'node:net';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';

const TUNNEL_TIMEOUT_MS = 15_000;
const VERIFY_TIMEOUT_MS = 8_000;
const FORCE_CLOSE_MS = 2_000;
const SSH_HOST = 'a.pinggy.io';
const SSH_PORT = 443;
const SSH_USER = 'a';
const BUFFER_LIMIT = 8_000;

/** 服务站点自身的链接，不是隧道地址。 */
const SERVICE_HOSTS =
  /^(?:www\.|docs\.|admin\.|dashboard\.|a\.)?(?:pinggy\.io|pinggy\.net|pinggy-free\.link|serveo\.net|localhost\.run)$/i;
const URL_PATTERN = /https:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,12}(?=[^a-z0-9.-]|$)/gi;
const ANSI_ESCAPE =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/g;
const BOX_CHARS = /[│┃|]/g;

export interface TunnelHandle {
  readonly url: string;
  close(): void;
  onClosed(callback: (reason: string) => void): void;
}

export interface TunnelFactory {
  open(port: number): Promise<TunnelHandle>;
}

export interface PinggyTunnelDeps {
  createClient?: () => Client;
  verifyUrl?: (url: string) => Promise<boolean>;
}

export function stripTerminalNoise(text: string): string {
  return text.replace(ANSI_ESCAPE, '').replace(CONTROL_CHARS, '');
}

/** pinggy 的终端界面会混入 ANSI 与制表符，这里从滚动缓冲里挑出候选公网地址。 */
export function findTunnelUrls(buffer: string): string[] {
  const flat = stripTerminalNoise(buffer).replace(BOX_CHARS, ' ');
  const found: string[] = [];
  for (const match of flat.match(URL_PATTERN) ?? []) {
    const url = match.replace(/[.,;:]+$/, '');
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (SERVICE_HOSTS.test(host)) continue;
    if (!found.includes(url)) found.push(url);
  }
  return found;
}

/**
 * 只有请求真的穿过隧道打到房主服务（未带令牌的轮询返回 401 JSON）才算地址可用，
 * 避免把终端里出现的其它 https 链接误当邀请地址。
 */
function verifyThroughTunnel(url: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const target = `${url.replace(/\/+$/, '')}/xq/v1/poll?rev=0`;
    const request = get(
      target,
      { timeout: VERIFY_TIMEOUT_MS, headers: { 'user-agent': 'Xiangqi/0.1' } },
      (response) => {
        const contentType = response.headers['content-type'];
        const proven =
          response.statusCode === 401 &&
          typeof contentType === 'string' &&
          contentType.includes('application/json');
        response.resume();
        resolve(proven);
      },
    );
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

export function createPinggyTunnelFactory(deps: PinggyTunnelDeps = {}): TunnelFactory {
  const createClient = deps.createClient ?? (() => new Client());
  const verifyUrl = deps.verifyUrl ?? verifyThroughTunnel;

  return {
    open(port: number): Promise<TunnelHandle> {
      return new Promise<TunnelHandle>((resolve, reject) => {
        const client = createClient();
        const listeners: Array<(reason: string) => void> = [];
        const candidates: string[] = [];
        const tried = new Set<string>();
        let buffer = '';
        let settled = false;
        let closed = false;
        let verifying = false;
        let closedReason: string | null = null;

        const notify = (reason: string): void => {
          closedReason = reason;
          for (const listener of listeners) listener(reason);
        };

        const shutdown = (): void => {
          if (closed) return;
          closed = true;
          try {
            client.end();
          } catch {
            // 连接已断开时重复 end 直接忽略。
          }
          // 优雅断开卡住时强制销毁套接字，确保没有残留连接。
          const force = setTimeout(() => {
            try {
              client.destroy();
            } catch {
              // 已销毁时忽略。
            }
          }, FORCE_CLOSE_MS);
          force.unref?.();
        };

        const fail = (message: string): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          shutdown();
          reject(new Error(message));
        };

        const timer = setTimeout(() => fail('内网穿透不可用（启动超时）'), TUNNEL_TIMEOUT_MS);
        timer.unref?.();

        const tryNextCandidate = (): void => {
          if (settled || verifying) return;
          const next = candidates.find((url) => !tried.has(url));
          if (!next) return;
          tried.add(next);
          verifying = true;
          verifyUrl(next).then(
            (ok) => {
              verifying = false;
              if (settled) return;
              if (!ok) {
                tryNextCandidate();
                return;
              }
              settled = true;
              clearTimeout(timer);
              resolve({
                url: next,
                close: shutdown,
                onClosed: (callback) => {
                  if (closedReason) {
                    callback(closedReason);
                    return;
                  }
                  listeners.push(callback);
                },
              });
            },
            () => {
              verifying = false;
              if (!settled) tryNextCandidate();
            },
          );
        };

        const handleMessage = (text: string): void => {
          if (settled) return;
          buffer = (buffer + stripTerminalNoise(text)).slice(-BUFFER_LIMIT);
          let changed = false;
          for (const url of findTunnelUrls(buffer)) {
            if (!candidates.includes(url)) {
              candidates.push(url);
              changed = true;
            }
          }
          if (changed) tryNextCandidate();
        };

        client.on('banner', (message: string | Buffer) => handleMessage(message.toString()));

        client.on('tcp connection', (_info: unknown, accept: () => ClientChannel) => {
          let channel: ClientChannel;
          try {
            channel = accept();
          } catch {
            return;
          }
          const local = connect(port, '127.0.0.1');
          channel.pipe(local).pipe(channel);
          channel.on('error', () => undefined);
          local.on('error', () => channel.destroy());
        });

        client.on('ready', () => {
          client.forwardIn('localhost', 0, (error) => {
            if (error) {
              fail(`内网穿透不可用：${error.message}`);
              return;
            }
            client.shell({ term: 'xterm-256color', cols: 120, rows: 40 }, (shellError, stream) => {
              if (shellError) {
                fail(`内网穿透不可用：${shellError.message}`);
                return;
              }
              stream.on('data', (chunk: Buffer | string) => handleMessage(chunk.toString()));
              stream.stderr.on('data', (chunk: Buffer | string) => handleMessage(chunk.toString()));
              stream.on('error', () => undefined);
            });
          });
        });

        client.on('close', () => {
          if (!settled) {
            fail('内网穿透不可用（穿透连接已关闭）');
            return;
          }
          shutdown();
          notify('穿透连接已关闭');
        });

        client.on('error', (error: Error) => {
          if (!settled) {
            fail(`内网穿透不可用：${error.message}`);
            return;
          }
          shutdown();
          notify(`穿透连接中断：${error.message}`);
        });

        const { privateKey } = generateKeyPairSync('rsa', {
          modulusLength: 2048,
          privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
          publicKeyEncoding: { type: 'spki', format: 'pem' },
        });
        const config: ConnectConfig = {
          host: SSH_HOST,
          port: SSH_PORT,
          username: SSH_USER,
          privateKey,
          // 公共中继没有可预先固定的主机密钥，与 ssh 的 StrictHostKeyChecking=no 一致。
          hostVerifier: () => true,
          readyTimeout: TUNNEL_TIMEOUT_MS,
          keepaliveInterval: 15_000,
          keepaliveCountMax: 3,
        };
        try {
          client.connect(config);
        } catch (error) {
          fail(`内网穿透不可用：${error instanceof Error ? error.message : String(error)}`);
        }
      });
    },
  };
}

export const pinggyTunnelFactory: TunnelFactory = createPinggyTunnelFactory();
