/* eslint-disable no-console */
import { autoRegister } from 'js-reporters';
import qunit from 'qunit';

export async function setupQunit() {
  const runner = autoRegister();
  const tap = qunit.reporters.tap;
  tap.init(runner, { log: console.info });

  QUnit.config.urlConfig.push({
    id: 'smoke_tests',
    label: 'Enable Smoke Tests',
    tooltip: 'Enable Smoke Tests',
  });

  QUnit.config.urlConfig.push({
    id: 'ci',
    label: 'Enable CI Mode',
    tooltip: 'CI mode makes tests run faster by sacrificing UI responsiveness',
  });

  await Promise.resolve();

  console.log(`[HARNESS] ci=${hasFlag('ci')}`);

  if (!hasFlag('ci')) {
    // since all of our tests are synchronous, the QUnit
    // UI never has a chance to rerender / update. This
    // leads to a very long "white screen" when running
    // the tests
    //
    // this adds a very small amount of async, just to allow
    // the QUnit UI to rerender once per module completed
    const pause = () =>
      new Promise((res) => {
        setTimeout(res, 1);
      });

    let start = performance.now();
    qunit.testDone(async () => {
      let gap = performance.now() - start;
      if (gap > 200) {
        await pause();
        start = performance.now();
      }
    });

    qunit.moduleDone(pause);
  }

  qunit.done((details) => {
    console.log(JSON.stringify({ ...details, type: '[HARNESS] done' }));
  });
}

function hasFlag(flag) {
  let location = typeof window !== 'undefined' && window.location;
  return location && new RegExp(`[?&]${flag}`).test(location.search);
}