import type { Plugin } from 'vite';
import { getKey } from '../keystore.ts';
import { proxyMiddleware } from '../proxy.ts';
import { trimApiBaseUrl } from '../../shared/transcription-providers.ts';

function headers(): Record<string, string> {
  const key = getKey('TRANSCRIPTION_CUSTOM_API_KEY');
  return key ? { Authorization: `Bearer ${key}` } : {};
}

export function transcriptionCompatiblePlugin(): Plugin {
  return {
    name: 'openchatcut-transcription-compatible',
    configureServer(server) {
      server.middlewares.use('/transcription-compatible', proxyMiddleware({
        target: () => trimApiBaseUrl(getKey('TRANSCRIPTION_CUSTOM_BASE_URL')),
        headers,
        forceJsonContentType: true,
        errorMessage: (status) => (
          `自定义转写服务返回 HTTP ${status}。请到“设置 → 素材 · 转写 → 转写 / 口播剪辑”检查地址、密钥和模型。`
        ),
      }));
    },
  };
}
