import type { Asset, EmberAsset, Engine, RewrittenPackageCache } from '@embroider/core';
import {extensionsPattern, getAppMeta, locateEmbroiderWorkingDir, Resolver, ResolverLoader} from '@embroider/core';
import { join, dirname } from 'path/posix';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { AppFiles } from '@embroider/core/src/app-files';
import glob from 'fast-glob';
import CompatApp from '@embroider/compat/src/compat-app';
import type { InMemoryAsset } from '@embroider/core/src/asset';
import type { Plugin, ViteDevServer} from 'vite';
import {readJSONSync} from 'fs-extra';

type Options = {
  root: string;
  compatAppDir?: string;
  rewrittenPackageCache: RewrittenPackageCache;
};

let InMemoryAssets: Record<string, string> = {};

let environment = 'production';

function getCompatAppBuilder({rewrittenPackageCache, root, compatAppDir}: Options) {
  const workingDir = locateEmbroiderWorkingDir(dirname(root));
  const rewrittenApp = join(workingDir, 'rewritten-app');
  const options = readJSONSync(join(workingDir, 'resolver.json'));
  const env = readJSONSync(join(workingDir, 'environment.json'));
  const legacyApp = readJSONSync(join(workingDir, 'legacy-app-info.json'));
  legacyApp.project.configPath = () => join(root, 'config', 'environment.js');
  legacyApp.tests = true;
  const compatApp = new CompatApp(legacyApp, options);
  compatApp['config']['lastConfig'] = env;
  console.log('rew', rewrittenApp)

  const compatAppBuilder = compatApp['instantiate'](compatAppDir || rewrittenApp, rewrittenPackageCache, compatApp['config']);

  compatAppBuilder['assetIsValid'] = () => false;

  const engines = compatAppBuilder['partitionEngines'](root);
  const extensions = compatAppBuilder['resolvableExtensions']().concat(['.ts', '.gts']);

  const appFiles = engines.map((engine: Engine) => {
    const isTest = engine.sourcePath.endsWith('/tests');
    let files = glob.sync(`**/*{${extensions.join(',')}}`, {
      cwd: engine.sourcePath,
    });
    if (isTest) {
      files = files.map(f => `tests/${f}`);
    }
    files.push('config/environment.js');
    return new AppFiles(
        engine,
        new Set(files),
        new Set(),
        extensionsPattern(extensions),
        compatAppBuilder['podModulePrefix']()
    );
  });
  const assets: Asset[] = [];
  for (let asset of compatAppBuilder['emberEntrypoints']('.')) {
    if (asset.relativePath === 'index.html') {
      (asset as EmberAsset).sourcePath = join(workingDir, 'ember-index.html');
    }
    if (asset.relativePath === 'tests/index.html') {
      (asset as EmberAsset).sourcePath = join(workingDir, 'ember-test-index.html');
    }
    assets.push(asset);
  }
  return {compatAppBuilder, assets, appFiles};
}

function generateEmberHtml({root}: Options) {
  const cwd = dirname(root);
  const workingDir = locateEmbroiderWorkingDir(cwd);
  const legacyApp = readJSONSync(join(workingDir, 'legacy-app-info.json'));
  let html = readFileSync(join(cwd, 'index.html')).toString();
  let testhtml = readFileSync(join(cwd, 'tests', 'index.html')).toString();
  const env = environment === 'production' ? 'prodcution' : 'development';
  legacyApp.configReplacePatterns[env].forEach((pattern: any) => {
    html = html.replace(new RegExp(pattern.exact, 'g'), pattern.replacement);
  });
  legacyApp.configReplacePatterns.test.forEach((pattern: any) => {
    testhtml = testhtml.replace(new RegExp(pattern.exact, 'g'), pattern.replacement);
  });
  legacyApp.configReplacePatterns[env].forEach((pattern: any) => {
    html = html.replace(new RegExp(pattern.match, 'g'), pattern.replacement);
  });
  legacyApp.configReplacePatterns.test.forEach((pattern: any) => {
    testhtml = testhtml.replace(new RegExp(pattern.match, 'g'), pattern.replacement);
  });
  writeFileSync(join(workingDir, 'ember-index.html'), html);
  writeFileSync(join(workingDir, 'ember-test-index.html'), testhtml);
}

async function generateHtml({rewrittenPackageCache, root}: Options, appOrTest: 'app' | 'test') {
  const file = appOrTest === 'app' ? 'index.html' : 'tests/index.html';
  if (InMemoryAssets[file]) {
    return InMemoryAssets[file];
  }
  generateEmberHtml({rewrittenPackageCache, root});
  const {compatAppBuilder, assets, appFiles} = getCompatAppBuilder({rewrittenPackageCache, root});

  const emberENV = compatAppBuilder['configTree'].readConfig().EmberENV;

  // TODO: improve internal code to only rebuild html file and not assets
  const internalAssets = await compatAppBuilder['updateAssets'](assets, appFiles, emberENV);
  const indexFile = internalAssets.find(a => (a as any).relativePath === file)!;
  InMemoryAssets[file] = (indexFile as InMemoryAsset).source.toString();
  return InMemoryAssets[file];
}

async function generateAppEntries({rewrittenPackageCache, root}: Options) {
  const pkg = rewrittenPackageCache.get(root);
  if (InMemoryAssets[`assets/${pkg.name}.js`]) {
    return InMemoryAssets[`assets/${pkg.name}.js`];
  }
  const {compatAppBuilder, assets, appFiles} = getCompatAppBuilder({rewrittenPackageCache, root});

  const emberENV = compatAppBuilder['configTree'].readConfig().EmberENV;
  // TODO: improve code to only rebuild app asset
  // const asset = assets.filter(a => (a as OnDiskAsset).relativePath.endsWith(`assets/${pkg.name}.js`));
  const internalAssets = await compatAppBuilder['updateAssets'](assets, appFiles, emberENV);
  const appFile = internalAssets.find(a => (a as any).relativePath === `assets/${pkg.name}.js`)!;
  InMemoryAssets[`assets/${pkg.name}.js`] = (appFile as InMemoryAsset).source.toString();
  InMemoryAssets[`assets/${pkg.name}.js`] += `
    import buildAppEnv from '../../config/environment.js';
    function merge(source, target) {
        for (const [key, val] of Object.entries(source)) {
          if (val !== null && typeof val === \`object\`) {
            target[key] ??=new val.__proto__.constructor();
            merge(val, target[key]);
          } else {
            target[key] = val;
          }
        }
        return target; // we're replacing in-situ, so this is more for chaining than anything else
      }
      merge(buildAppEnv(runningTests ? 'test' : '${environment}'), require('${pkg.name}/config/environment').default);
    `;
  return InMemoryAssets[`assets/${pkg.name}.js`];
}

async function generateTestEntries({rewrittenPackageCache, root}: Options) {
  //const pkg = rewrittenPackageCache.get(root);
  const {compatAppBuilder, assets, appFiles} = getCompatAppBuilder({rewrittenPackageCache, root});

  const emberENV = compatAppBuilder['configTree'].readConfig().EmberENV;
  const internalAssets = await compatAppBuilder['updateAssets'](assets, appFiles, emberENV);

  const appFile = internalAssets.find(a => (a as any).relativePath === `assets/test.js`)!;
  InMemoryAssets[`assets/test.js`] = (appFile as InMemoryAsset).source.toString();

  return InMemoryAssets[`assets/test.js`];
}

function findPublicAsset(relativePath: string, resolver: Resolver, embroiderWorkingDir: string) {
  const packageCache = resolver.packageCache;
  const cwd = process.cwd();
  const publicDir = join(cwd, 'public');
  // check public path
  let pkg = packageCache.ownerOfFile(relativePath);
  let p = join(publicDir, relativePath);
  if (pkg && pkg.isV2App() && existsSync(p)) {
    return '/' + p;
  }

  for (const engine of resolver.options.engines) {
    for (const addon of engine.activeAddons) {
      pkg = packageCache.ownerOfFile(addon.root);
      if (pkg && pkg.meta && pkg.isV2Addon() && pkg.meta['public-assets']) {
        const asset = Object.entries(pkg.meta['public-assets']).find(([_key, a]) => a === relativePath)?.[0];
        let local = asset ? join(addon.root, asset) : null;
        if (!local?.includes(embroiderWorkingDir) && asset) {
          // remap to local path without symlinks so vite can find it
          const localNodeModulePath = local?.split('/node_modules/').slice(-1)[0]!;
          local = join('node_modules', localNodeModulePath);
        }
        if (local && existsSync(local)) {
          return '/' + local;
        }
      }
    }
  }

}

export function assets(options?: { entryDirectories?: string[] }): Plugin {
  const cwd = process.cwd();
  const root = join(cwd, 'app');
  const embroiderWorkingDir = locateEmbroiderWorkingDir(cwd);
  const rewrittenApp = join(embroiderWorkingDir, 'rewritten-app');
  const resolverLoader = new ResolverLoader(cwd);
  const appMeta = getAppMeta(cwd);
  const tests = join(cwd, 'tests');
  const appIndex = join(cwd, 'index.html').replace(/\\/g, '/');
  const testsIndex = join(tests, 'index.html').replace(/\\/g, '/');

  const entries = ['routes', 'templates', 'controllers'].concat(options?.entryDirectories || []);
  let viteDevServer: ViteDevServer;

  return {
    name: 'assets',
    enforce: 'pre',
    configureServer(server) {
      viteDevServer = server;
      const watcher = server.watcher;
      // this is required because we do not open the /tests url directly and via the middleware
      watcher.on('add', filename => {
        if (entries.find(e => filename.startsWith(join(root, e)))) {
          delete InMemoryAssets[`assets/${appMeta.name}.js`];
          const module = server.moduleGraph.getModuleById(join(root, `assets/${appMeta.name}.js`))!;
          server.moduleGraph.invalidateModule(module);
        }
        if (filename.startsWith('tests/')) {
          delete InMemoryAssets[`assets/test.js`];
        }
      });
      watcher.on('unlink', filename => {
        if (entries.find(e => filename.startsWith(join(root, e)))) {
          delete InMemoryAssets[`assets/${appMeta.name}.js`];
        }
        if (filename.startsWith(tests)) {
          delete InMemoryAssets[`assets/test.js`];
        }
      });
      watcher.on('change', filename => {
        if (appIndex === filename) {
          delete InMemoryAssets['index.html'];
        }
        if (testsIndex === filename) {
          delete InMemoryAssets['tests/index.html'];
          server.ws.send({
            type: 'full-reload',
          });
        }
      });
      server.middlewares.use((req, _res, next) => {
        // this is necessary so that /tests will load tests/index
        // otherwise this would only happen when /tests/ or /tests/index.html is opened
        if (req.originalUrl?.match(/\/tests($|\?)/) || req.originalUrl?.startsWith('/tests/index.html')) {
          req.originalUrl = '/tests/index.html';
          (req as any).url = '/tests/index.html';
          if (InMemoryAssets['index.html']) {
            // need to invalidate modules when switching between app and tests
            server.moduleGraph.invalidateAll();
            InMemoryAssets = {};
          }
          return next();
        }
        if (req.originalUrl === '/' || req.originalUrl === '/index.html') {
          // need to invalidate modules when switching between app and tests
          if (InMemoryAssets['tests/index.html']) {
            server.moduleGraph.invalidateAll();
            InMemoryAssets = {};
          }
          return next();
        }
        if (req.originalUrl?.includes('?')) {
          return next();
        }
        if (req.originalUrl && req.originalUrl.length > 1) {
          const newUrl = findPublicAsset(req.originalUrl, resolverLoader.resolver, embroiderWorkingDir);
          if (newUrl) {
            req.originalUrl = newUrl;
            (req as any).url = newUrl;
          }
          return next();
        }
        return next();
      });
    },
    transformIndexHtml: {
      order: 'pre',
      async handler(_html, ctx) {
        if (ctx.filename === appIndex) {
          if (viteDevServer) environment = 'development';
          return await generateHtml({ rewrittenPackageCache: resolverLoader.resolver.packageCache, root }, 'app');
        }
        if (ctx.filename === testsIndex) {
          if (viteDevServer && environment !== 'test') {
            delete InMemoryAssets[`assets/${appMeta.name}.js`];
            const module = viteDevServer.moduleGraph.getModuleById(join(root, `assets/${appMeta.name}.js`))!;
            if (module) {
              viteDevServer.moduleGraph.invalidateModule(module);
            }
            environment = 'test';
          }
          return await generateHtml({ rewrittenPackageCache: resolverLoader.resolver.packageCache, root }, 'test');
        }
      },
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
          return generateAppEntries({
            root,
            rewrittenPackageCache: resolverLoader.resolver.packageCache,
          });
        }
        if (id.endsWith('/test.js')) {
          return `
            // fix for qunit
            import '/assets/test-setup.js';
            import '/assets/test-entries.js';
          `;
        }
        if (id.endsWith('/assets/test-setup.js')) {
          return `
            import * as EmberTesting from 'ember-testing';
            define('ember-testing', () => EmberTesting);
          `;
        }
        if (id.endsWith('/assets/test-entries.js')) {
          return generateTestEntries({
            root: tests,
            rewrittenPackageCache: resolverLoader.resolver.packageCache,
          });
        }
        return readFileSync(rewrittenApp + id.replace(root + '/assets/', '/assets/').split('?')[0]).toString();
      }
    },
    async writeBundle(options) {
      const { compatAppBuilder } = getCompatAppBuilder({
        rewrittenPackageCache: resolverLoader.resolver.packageCache,
        root,
        compatAppDir: options.dir || join(cwd, 'dist'),
      });
      const assets = compatAppBuilder['gatherAssets']({
        publicTree: 'public',
      } as any);
      await compatAppBuilder['updateAssets'](assets, [], {});
    },
  };
}
