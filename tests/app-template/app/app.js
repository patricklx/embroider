import Application from '@ember/application';
import '@embroider/core/entrypoint';
import coreModules from '@embroider/core/entrypoint';
import Resolver from 'ember-resolver';
import loadInitializers from 'ember-load-initializers';
import config from './config/environment';

let d = window.define;

for (const [name, module] of Object.entries(coreModules)) {
  d(name, function () {
    return module;
  });
}

export default class App extends Application {
  modulePrefix = config.modulePrefix;
  podModulePrefix = config.podModulePrefix;
  Resolver = Resolver;
}

loadInitializers(App, config.modulePrefix);
