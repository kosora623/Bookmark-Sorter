import { defineConfig, type Plugin } from 'vite';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * バージョンの正本は package.json。public/manifest.json には version を書かず、
 * ビルド後の dist/manifest.json に差し込む。
 */
function manifestVersion(): Plugin {
  return {
    name: 'manifest-version',
    apply: 'build',
    closeBundle() {
      const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as { version: string };
      const manifestPath = resolve(__dirname, 'dist/manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
      // manifest_version の直後に置いて、手書きのときと同じ並びにする
      const { manifest_version, name, ...rest } = manifest;
      const output = { manifest_version, name, version: pkg.version, ...rest };
      writeFileSync(manifestPath, `${JSON.stringify(output, null, 2)}\n`);
    },
  };
}

export default defineConfig({
  plugins: [manifestVersion()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        dashboard: resolve(__dirname, 'index.html'),
        content: resolve(__dirname, 'src/content.ts'),
        background: resolve(__dirname, 'src/background.ts'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
      },
    },
  },
});
