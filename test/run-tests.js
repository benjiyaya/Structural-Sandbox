/*
 * run-tests.js — zero-dependency test runner.
 * Registers tests via global `test`, provides a small assert helper,
 * runs every registered test, prints a summary, exit code 1 on failure.
 */
'use strict';

const tests = [];

global.test = function (name, fn) {
  tests.push({ name: name, fn: fn });
};

const assert = {
  ok: function (cond, msg) {
    if (!cond) throw new Error('assertion failed: ' + (msg || 'expected truthy value'));
  },
  equal: function (actual, expected, msg) {
    if (actual !== expected) {
      throw new Error('assertion failed: ' + (msg || 'expected ' + expected + ', got ' + actual));
    }
  },
  // approx-equal with relative tolerance (fraction, e.g. 0.01 = 1%)
  approx: function (actual, expected, tol, msg) {
    const err = Math.abs(actual - expected);
    const scale = Math.max(Math.abs(expected), 1e-12);
    if (err / scale > tol) {
      throw new Error(
        'assertion failed: ' + (msg || 'approx equal') +
        ' — expected ~' + expected + ', got ' + actual +
        ' (rel err ' + ((err / scale) * 100).toFixed(3) + '% > ' + tol * 100 + '%)'
      );
    }
  },
};

global.assert = assert;

// Test files register their tests here.
require('./solver.test.js');
require('./loads.test.js');
require('./project.test.js');

let passed = 0;
const failures = [];

for (const t of tests) {
  try {
    t.fn();
    passed++;
    console.log('  PASS  ' + t.name);
  } catch (e) {
    failures.push({ name: t.name, error: e });
    console.log('  FAIL  ' + t.name);
    console.log('        ' + String(e && e.message ? e.message : e).split('\n').join('\n        '));
  }
}

console.log('');
console.log(passed + '/' + tests.length + ' tests passed' +
  (failures.length ? ', ' + failures.length + ' FAILED' : ''));

if (failures.length) process.exit(1);
