import type { ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import {
  mltInternalErrorReport,
  probeMlt,
  type MltProbeReport,
} from '../mlt/probe.ts';

export interface ExportBackendsPluginOptions {
  probe?: () => Promise<MltProbeReport>;
  /** Short server-side cache prevents repeated clicks from spawning duplicate probes. */
  cacheTtlMs?: number;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * Capability inspection only. It never accepts an executable, argv, media URI,
 * output path, or render request from HTTP.
 */
export function exportBackendsPlugin(options: ExportBackendsPluginOptions = {}): Plugin {
  const runProbe = options.probe ?? (() => probeMlt());
  const cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 10_000);
  let cached: { at: number; report: MltProbeReport } | undefined;
  let inFlight: Promise<MltProbeReport> | undefined;

  const inspect = (): Promise<MltProbeReport> => {
    const now = Date.now();
    if (cached && now - cached.at < cacheTtlMs) return Promise.resolve(cached.report);
    if (inFlight) return inFlight;
    inFlight = runProbe().then((report) => {
      cached = { at: Date.now(), report };
      return report;
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  };

  return {
    name: 'cutai-export-backends',
    configureServer(server) {
      server.middlewares.use('/api/export/backends/mlt/probe', async (req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        if (pathname !== '/' && pathname !== '') {
          sendJson(res, 404, { error: 'unknown MLT probe route' });
          return;
        }
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET');
          sendJson(res, 405, { error: 'method not allowed — use GET' });
          return;
        }
        try {
          sendJson(res, 200, await inspect());
        } catch (error) {
          sendJson(res, 500, mltInternalErrorReport(error));
        }
      });
    },
  };
}
