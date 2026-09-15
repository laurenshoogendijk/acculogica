const { test } = require('node:test');
const assert = require('node:assert/strict');

const controllerModule = require('../script_ignore_boilers.js');

const makeMsg = (overrides = {}) => ({
  data: {
    p1_hw: 0,
    b1vermogen: 0,
    b2vermogen: 0,
    accu_nu: 0,
    pvhuisvermogen: 0,
    pvschuurvermogen: 0,
    soc: 50,
    ...overrides,
  },
});

test('exports controller and pure logic helpers', () => {
  assert.equal(typeof controllerModule.controller, 'function');
  assert.equal(typeof controllerModule.determineSetpoint, 'function');
});

test('does not import when solar is available', () => {
  const node = { status() {} };
  const msg = makeMsg({
    p1_hw: -500,
    b1vermogen: 0,
    b2vermogen: 0,
    accu_nu: 0,
    pvhuisvermogen: 900,
    pvschuurvermogen: 200,
    soc: 60,
  });

  const result = controllerModule.controller(node, msg);
  assert.ok(Array.isArray(result));
  assert.ok(result[0].payload2.data.power < 0, 'solar should charge the battery rather than importing from the grid');
});

test('battery stops charging when a boiler is starting up and using power', () => {
  const node = { status() {} };
  const msg = makeMsg({
    p1_hw: 0,
    b1vermogen: 1200,
    b2vermogen: 0,
    accu_nu: 0,
    pvhuisvermogen: 1200,
    pvschuurvermogen: 0,
    soc: 60,
  });

  const result = controllerModule.controller(node, msg);
  assert.ok(Array.isArray(result));
  assert.equal(result[0], null);
  assert.match(result[1].payload.value, /Balans|Boiler start|deadband/i);
});

test('battery only charges on solar', () => {
  const node = { status() {} };
  const msg = makeMsg({
    p1_hw: -200,
    b1vermogen: 0,
    b2vermogen: 0,
    accu_nu: 0,
    pvhuisvermogen: 0,
    pvschuurvermogen: 0,
    soc: 60,
  });

  const result = controllerModule.controller(node, msg);
  assert.ok(Array.isArray(result));
  assert.equal(result[0], null);
  assert.match(result[1].payload.value, /geen PV-overschot|Laden geblokkeerd/i);
});

test('solar surplus still charges when net consumption is zero', () => {
  const node = { status() {} };
  const msg = makeMsg({
    p1_hw: 0,
    b1vermogen: 0,
    b2vermogen: 0,
    accu_nu: 0,
    pvhuisvermogen: 4122,
    pvschuurvermogen: 0,
    soc: 60,
  });

  const result = controllerModule.controller(node, msg);
  assert.ok(Array.isArray(result));
  assert.ok(result[0].payload2.data.power < 0, 'a real solar surplus should be used to charge even when the net meter reads 0');
});

test('treats negative PV sensor values as generation instead of blocking charge', () => {
  const node = { status() {} };
  const msg = makeMsg({
    p1_hw: -500,
    b1vermogen: 0,
    b2vermogen: 0,
    accu_nu: 0,
    pvhuisvermogen: -900,
    pvschuurvermogen: -200,
    soc: 60,
  });

  const result = controllerModule.controller(node, msg);
  assert.ok(Array.isArray(result));
  assert.ok(result[0].payload2.data.power < 0, 'negative PV readings should still count as solar production and allow charging');
});

test('charging is allowed when PV surplus exceeds house demand at high SoC', () => {
  const node = { status() {} };
  const msg = makeMsg({
    p1_hw: 0,
    b1vermogen: 0,
    b2vermogen: 0,
    accu_nu: 0,
    pvhuisvermogen: 3053,
    pvschuurvermogen: 0,
    soc: 80,
  });

  const result = controllerModule.controller(node, msg);
  assert.ok(Array.isArray(result));
  assert.ok(result[0].payload2.data.power < 0, 'with 3053 W PV and no house load, the controller should charge');
});

test('logic steers to a 0-meter balance', () => {
  const node = { status() {} };
  const msg = makeMsg({
    p1_hw: 300,
    b1vermogen: 0,
    b2vermogen: 0,
    accu_nu: 0,
    pvhuisvermogen: 0,
    pvschuurvermogen: 0,
    soc: 60,
  });

  const result = controllerModule.controller(node, msg);
  assert.ok(Array.isArray(result));
  assert.equal(result[0].payload2.data.power, 300);
});

