import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, link, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Files } from '../../packages/core/store';
import { uid } from '../../packages/core/model';

const allowed = /^(day|week|rubric|proposal)(?:\/([a-f0-9-]+|active)--[a-f0-9-]{36}\.md)?$/;

export async function nodeFiles(path: string): Promise<Files> {
  if (!isAbsolute(path) || basename(path) !== 'Data' || basename(dirname(path)) !== 'LifePilot')
    throw Error('--root 必须是绝对路径 <vault>/LifePilot/Data');
  const root = await realpath(path);
  if (root !== resolve(path) || !(await lstat(root)).isDirectory()) throw Error('数据根目录必须是实际目录');
  async function checked(folder: string, create = false) {
    if (!allowed.test(folder) || folder.includes('/')) throw Error('无效业务目录');
    const dir = join(root, folder);
    if (create) await mkdir(dir).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stats = await lstat(dir).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!stats) return;
    if (!stats.isDirectory() || await realpath(dir) !== dir) throw Error('业务子目录不能是链接');
    return dir;
  }
  async function read(path: string) {
    if (!allowed.test(path) || !path.includes('/')) throw Error('无效业务文件路径');
    const [folder, name] = path.split('/');
    const dir = await checked(folder);
    if (!dir) throw Error('找不到业务目录');
    const file = join(dir, name);
    const stats = await lstat(file);
    if (!stats.isFile() || stats.nlink !== 1 || stats.size > 4_000_000 || await realpath(file) !== file) throw Error('业务文件类型或大小不符合要求');
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { return await handle.readFile('utf8'); }
    finally { await handle.close(); }
  }
  return {
    async list(folder) {
      const dir = await checked(folder);
      return dir ? await readdir(dir) : [];
    },
    read,
    async publish(path, body) {
      if (!/^proposal\//.test(path) || !allowed.test(path)) throw Error('DSH 只允许追加提案文件');
      const dir = (await checked('proposal', true))!;
      const destination = join(dir, basename(path));
      const temp = join(dir, uid() + '.lifepilot-tmp');
      const handle = await open(temp, 'wx');
      try {
        try { await handle.writeFile(body, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        await link(temp, destination);
      } finally { await unlink(temp); }
    }
  };
}
