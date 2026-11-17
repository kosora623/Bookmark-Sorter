// vitest を起動する。Windows では作業ディレクトリのドライブ文字が小文字（c:\ など）のまま渡ると
// vitest が二重に読み込まれて全テストが失敗するので、正規のパス（C:\）に直してから起動する。
// （VS Code のターミナルは c:\ で開くことがある。他の OS では何も変わらない）
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

const cwd = realpathSync.native(process.cwd());
const vitest = join(cwd, 'node_modules', 'vitest', 'vitest.mjs');

const result = spawnSync(process.execPath, [vitest, ...process.argv.slice(2)], { cwd, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
