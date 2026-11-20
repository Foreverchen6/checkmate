declare module 'ssh2' {
  import type { EventEmitter } from 'node:events';
  import type { Duplex, Readable } from 'node:stream';

  export interface ClientChannel extends Duplex {
    readonly stderr: Readable;
  }

  export interface ConnectConfig {
    host: string;
    port?: number;
    username?: string;
    privateKey?: string | Buffer;
    hostVerifier?: (key: Buffer) => boolean;
    readyTimeout?: number;
    keepaliveInterval?: number;
    keepaliveCountMax?: number;
  }

  export interface ShellOptions {
    term?: string;
    cols?: number;
    rows?: number;
  }

  export class Client extends EventEmitter {
    connect(config: ConnectConfig): void;
    end(): void;
    destroy(): void;
    forwardIn(
      bindAddr: string,
      bindPort: number,
      callback: (error: Error | undefined, assignedPort: number) => void,
    ): void;
    shell(
      options: ShellOptions | false,
      callback: (error: Error | undefined, stream: ClientChannel) => void,
    ): void;
  }
}
