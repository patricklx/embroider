import { join } from 'path/posix';
import { fork } from 'child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import type { Plugin } from 'vite';
import { statSync } from 'fs-extra';

const cwd = process.cwd();
const embroiderDir = join(cwd, 'node_modules', '.embroider');
const cacheKeyPath = join(embroiderDir, 'cache-key.json');

export const lockFiles = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'package.json'];

function getCacheKey(file: string) {
  if (existsSync(cacheKeyPath)) {
    return JSON.parse(readFileSync(cacheKeyPath).toString())[file];
  }
  return null;
}

function updateCacheKey(file: string, key: string | null) {
  let json: Record<string, string | null> = {};
  if (existsSync(cacheKeyPath)) {
    json = JSON.parse(readFileSync(cacheKeyPath).toString());
  }
  json[file] = key;
  writeFileSync(cacheKeyPath, JSON.stringify(json));
}

function computeCacheKeyForFile(file: string) {
  if (existsSync(file)) {
    return statSync(file).mtimeMs.toString();
  }
  return null;
}

export function emberBuild(mode: string): Promise<void> {
  if (mode === 'build') {
    return new Promise((resolve, reject) => {
      const child = fork('./node_modules/ember-cli/bin/ember', ['build', '--production'], { silent: true });
      child.on('exit', code => (code === 0 ? resolve() : reject()));
    });
  }
  return new Promise((resolve, reject) => {
    const child = fork('./node_modules/ember-cli/bin/ember', ['build', '--watch'], { silent: true });
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error('ember build --watch failed'))));
    child.on('spawn', () => {
      child.stderr?.on('data', data => {
        console.error(data.toString());
      });
      child.stdout!.on('data', data => {
        console.log(data.toString());
        if (data.toString().includes('Build successful')) {
          resolve();
        }
      });
    });
  });
}

export async function buildIfFileChanged(path: string | null | undefined): Promise<boolean> {
  if (path && lockFiles.includes(path)) {
    const key = computeCacheKeyForFile(path);
    if (key !== getCacheKey(path)) {
      updateCacheKey(path, key);
      return true;
    }
  }
  return false;
}

export function compatPrebuild(): Plugin {
  let mode = 'build';
  return {
    name: 'embroider-builder',
    enforce: 'pre',
    configureServer(server) {
      const files = readdirSync('.');
      files.forEach(f => {
        if (lockFiles.includes(f)) {
          const key = computeCacheKeyForFile(f);
          updateCacheKey(f, key);
          server.watcher.add('./' + f);
        }
      });
      server.watcher.on('change', async path => {
        const needRestart = await buildIfFileChanged(path);
        if (needRestart) {
          await server.restart(true);
        }
      });
    },
    async buildStart() {
      await emberBuild(mode);
    },
  };
}
