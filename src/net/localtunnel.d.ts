declare module 'localtunnel' {
  import type { EventEmitter } from 'node:events';

  export interface TunnelOptions {
    port: number;
    local_host?: string;
    subdomain?: string;
  }

  export interface Tunnel extends EventEmitter {
    url: string;
    close(): void;
    on(event: 'close', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
  }

  export default function localtunnel(options: TunnelOptions): Promise<Tunnel>;
}