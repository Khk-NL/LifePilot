import type { DataAdapter } from 'obsidian';
import type { Files } from '../../packages/core/store';
import { uid } from '../../packages/core/model';

export const ROOT = 'LifePilot';
export const DATA = ROOT + '/Data';
const STAGING = '.lifepilot-staging';

export async function ensureFolder(adapter: DataAdapter, path: string) {
  let current = '';
  for (const segment of path.split('/')) {
    current = current ? current + '/' + segment : segment;
    if (!(await adapter.exists(current))) {
      try { await adapter.mkdir(current); } catch (error) {
        if (!(await adapter.exists(current))) throw error;
      }
    }
    if ((await adapter.stat(current))?.type !== 'folder') throw Error(current + ' 不是目录');
  }
}

export function vaultFiles(adapter: DataAdapter): Files {
  return {
    async list(folder) {
      const dir = DATA + '/' + folder;
      if (!(await adapter.exists(dir))) return [];
      return (await adapter.list(dir)).files.map(path => path.split('/').at(-1)!);
    },
    read: path => adapter.read(DATA + '/' + path),
    async publish(path, body) {
      const dir = DATA + '/' + path.split('/')[0];
      const destination = DATA + '/' + path;
      await ensureFolder(adapter, dir);
      if (await adapter.exists(destination)) throw Error('该修订已存在，请刷新');
      // Keep incomplete writes out of the Vault file index and attachment sync.
      await ensureFolder(adapter, STAGING);
      const temp = STAGING + '/' + uid() + '.lifepilot-tmp';
      await adapter.write(temp, body);
      try {
        if (await adapter.exists(destination)) throw Error('该修订已存在，请刷新');
        await adapter.rename(temp, destination);
      } catch (error) {
        if (await adapter.exists(temp)) await adapter.remove(temp);
        throw error;
      }
    }
  };
}
