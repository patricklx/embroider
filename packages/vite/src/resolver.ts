import type { PluginContext, ResolveIdResult } from 'rollup';
import type { Plugin } from 'vite';
import { join, resolve } from 'path';
import type { Resolution, ResolverFunction, AddonMeta } from '@embroider/core';
import { getAppMeta, ResolverLoader, virtualContent } from '@embroider/core';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { RollupModuleRequest, virtualPrefix } from './request';
import assertNever from 'assert-never';
import { generateDefineContent, generateEntries, generateTestEntries } from './virtual-files';
import { buildIfFileChanged, lockFiles } from './build';

const cwd = process.cwd();
const root = join(cwd, 'app');
const publicDir = join(cwd, 'public');
const tests = join(cwd, 'tests');
const embroiderDir = join(cwd, 'node_modules', '.embroider');
const rewrittenApp = join(embroiderDir, 'rewritten-app');

const appIndex = resolve(root, 'index.html').replace(/\\/g, '/');
const testsIndex = resolve(tests, 'index.html').replace(/\\/g, '/');
const rewrittenAppIndex = resolve(rewrittenApp, 'index.html');
const rewrittenTestIndex = resolve(rewrittenApp, 'tests', 'index.html');

let environment = 'production';

type Options = {
  entryFolders: string[];
};

export function resolver(options?: Options): Plugin {
  let resolverLoader = new ResolverLoader(process.cwd());
  const engine = resolverLoader.resolver.options.engines[0];
  engine.root = root;
  engine.activeAddons.forEach(addon => {
    addon.canResolveFromFile = addon.canResolveFromFile.replace(rewrittenApp, cwd);
  });
  const appMeta = getAppMeta(cwd);
  const pkg = resolverLoader.resolver.packageCache.get(cwd);
  pkg.packageJSON['ember-addon'] = pkg.packageJSON['ember-addon'] || {};
  pkg.packageJSON['keywords'] = pkg.packageJSON['keywords'] || [];
  pkg.packageJSON['ember-addon'].version = 2;
  pkg.packageJSON['ember-addon'].type = 'app';
  pkg.packageJSON['keywords'].push('ember-addon', 'ember-engine');
  pkg.meta!['auto-upgraded'] = true;
  (pkg as any).plainPkg.root = root;
  const json = pkg.packageJSON;
  Object.defineProperty(Object.getPrototypeOf((pkg as any).plainPkg), 'internalPackageJSON', {
    get() {
      if (this.isApp || this.root === root) {
        return json;
      }
      return JSON.parse(readFileSync(join(this.root, 'package.json'), 'utf8'));
    },
  });
  return {
    name: 'embroider-resolver',
    enforce: 'pre',
    configureServer(server) {
      const files = readdirSync('.');
      files.forEach(f => {
        if (lockFiles.includes(f)) {
          server.watcher.add('./' + f);
        }
      });
      server.watcher.add('./app/index.html');
      server.watcher.on('change', async path => {
        await buildIfFileChanged(path);
        server.restart(true);
      });
      environment = 'development';
      server.middlewares.use((req, _res, next) => {
        if (req.originalUrl?.match(/\/tests($|\?)/) || req.originalUrl?.startsWith('/tests/index.html')) {
          environment = 'test';
          if (!req.originalUrl.startsWith('/tests/index.html')) {
            req.originalUrl = req.originalUrl.replace('/tests', '/tests/index.html');
          }
          (req as any).url = req.originalUrl;
          return next();
        }
        if (req.originalUrl === '/') {
          req.originalUrl = '/app/index.html';
          (req as any).url = '/app/index.html';
          return next();
        }
        if (req.originalUrl?.includes('?')) {
          return next();
        }
        if (req.originalUrl && req.originalUrl.length > 1) {
          let pkg = resolverLoader.resolver.packageCache.ownerOfFile(req.originalUrl);
          let p = join(publicDir, req.originalUrl);
          if (pkg && pkg.isV2App() && existsSync(p)) {
            req.originalUrl = '/' + p;
            (req as any).url = '/' + p;
            return next();
          }
          p = join('node_modules', req.originalUrl);
          pkg = resolverLoader.resolver.packageCache.ownerOfFile(p);
          if (pkg && pkg.meta && (pkg.meta as AddonMeta)['public-assets']) {
            const asset = Object.entries((pkg.meta as any)['public-assets']).find(
              ([_key, a]) => a === req.originalUrl
            )?.[0];
            const local = asset ? join(cwd, p) : null;
            if (local && existsSync(local)) {
              req.originalUrl = '/' + p;
              (req as any).url = '/' + p;
              return next();
            }
          }
          return next();
        }
        return next();
      });
    },
    async resolveId(source, importer, options) {
      if (source.startsWith('/assets/')) {
        return resolve(root, '.' + source);
      }
      if (importer?.includes('/app/assets/') && !source.match(/-embroider-implicit-.*modules.js$/)) {
        if (source.startsWith('./')) {
          return resolve(root, 'assets', source);
        }
      }
      let request = RollupModuleRequest.from(source, importer, options.custom);
      if (!request) {
        // fallthrough to other rollup plugins
        return null;
      }
      let resolution = await resolverLoader.resolver.resolve(request, defaultResolve(this));
      switch (resolution.type) {
        case 'found':
          return resolution.result;
        case 'not_found':
          return null;
        default:
          throw assertNever(resolution);
      }
    },
    load(id) {
      id = id.split('?')[0];
      if (id.endsWith('/testem.js')) {
        return '';
      }
      if (id === join(cwd, 'config', 'environment.js').replace(/\\/g, '/')) {
        const code = readFileSync(id).toString();
        return code.replace('module.exports = ', 'export default ');
      }
      if (id.startsWith(root + '/assets/')) {
        if (id.endsWith(appMeta.name + '.js')) {
          return generateEntries({
            environment,
            root,
            engine,
            pkg,
            entryFolders: options?.entryFolders,
          });
        }
        if (id.endsWith('/test.js')) {
          return `
            // fix for qunit
            import './test-setup.js';
            import './test-entries.js'
          `;
        }
        if (id.endsWith('/test-setup.js')) {
          return `
            import * as EmberTesting from 'ember-testing';
            define('ember-testing', () => EmberTesting);
          `;
        }
        if (id.endsWith('/test-entries.js')) {
          return generateTestEntries({
            pkg,
            entryFolders: options?.entryFolders,
          });
        }
        return readFileSync(rewrittenApp + id.replace(root + '/assets/', '/assets/').split('?')[0]).toString();
      }

      if (id.startsWith(virtualPrefix)) {
        if (id.slice(virtualPrefix.length) === 'define') {
          return generateDefineContent();
        }
        return virtualContent(id.slice(virtualPrefix.length), resolverLoader.resolver);
      }
    },
    transformIndexHtml: {
      order: 'pre',
      handler(_html, ctx) {
        if (ctx.filename === appIndex) {
          return readFileSync(rewrittenAppIndex).toString();
        }
        if (ctx.filename === testsIndex) {
          return readFileSync(rewrittenTestIndex).toString();
        }
      },
    },
  };
}

function defaultResolve(context: PluginContext): ResolverFunction<RollupModuleRequest, Resolution<ResolveIdResult>> {
  return async (request: RollupModuleRequest) => {
    if (request.isVirtual) {
      return {
        type: 'found',
        result: { id: request.specifier, resolvedBy: request.fromFile },
      };
    }
    let result = await context.resolve(request.specifier, request.fromFile, {
      skipSelf: true,
      custom: {
        embroider: {
          enableCustomResolver: false,
          meta: request.meta,
        },
      },
    });
    if (!result) {
      result = await context.resolve(request.specifier, request.fromFile.replace(root, rewrittenApp), {
        skipSelf: true,
        custom: {
          embroider: {
            enableCustomResolver: false,
            meta: request.meta,
          },
        },
      });
    }
    if (result) {
      return { type: 'found', result };
    } else {
      return { type: 'not_found', err: undefined };
    }
  };
}
