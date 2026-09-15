const test = require('node:test');
const assert = require('node:assert/strict');

const controllerModule = require('../script.js');

const makeMsg = (overrides = {}) => ({
  data: {
    p1c: 0,
    p1p: 0,
    accu: 0,
    pv: 0,
    soc: 50,
    target: 0,
    prijs: 0.17,
    laagsteprijs: 0.15343,
    hoogsteprijs: 0.43321,
    force_charge: 'off',
    force_discharge: 'off',
    ...overrides,
  },
});

test('exports controller and pure logic helpers', () => {
  assert.equal(typeof controllerModule.controller, 'function');
  assert.equal(typeof controllerModule.determineSetpoint, 'function');
});

test('valid cheap-price scenario charges the battery', () => {
  const node = { status() {} };
  const msg = makeMsg({
    p1c: 0,
    p1p: 0,
    accu: 0,
    pv: 100,
    soc: 50,
    target: 0,
    prijs: 0.17,
    laagsteprijs: 0.15343,
    hoogsteprijs: 0.43321,
  });

  const result = controllerModule.controller(node, msg);
  assert.ok(Array.isArray(result));
  assert.equal(result[0].payload2.data.power, -350);
});

test('price comparisons support near-equality tolerance', () => {
  const node = { status() {} };
  const msg = makeMsg({
    prijs: 0.15343000001,
    laagsteprijs: 0.15343,
    hoogsteprijs: 0.43321,
    soc: 40,
  });

  const result = controllerModule.controller(node, msg);
  assert.ok(Array.isArray(result));
  assert.equal(result[0].payload2.data.power, -350);
});

test('negative price triggers aggressive charging', () => {
  const node = { status() {} };
  const msg = makeMsg({
    p1c: 0,
    p1p: 0,
    accu: 0,
    pv: 0,
    soc: 55,
    target: 0,
    prijs: -0.12,
    laagsteprijs: -0.12,
    hoogsteprijs: 0.42,
  });

  const result = controllerModule.controller(node, msg);
  assert.ok(Array.isArray(result));
  assert.equal(result[0].payload2.data.power, -350);
  assert.match(result[1].payload.value, /Negatieve prijs|Laagste prijs is negatief/);
});

test('low price with heavy house load does not discharge below break-even', () => {
  const node = { status() {} };
  const msg = makeMsg({
    p1c: 1.5,
    p1p: 0,
    accu: 0,
    pv: 0,
    soc: 70,
    target: 0,
    prijs: 0.12,
    laagsteprijs: 0.12,
    hoogsteprijs: 0.12,
  });

  const result = controllerModule.controller(node, msg);
  assert.ok(Array.isArray(result));
  assert.equal(result[0], null);
  assert.match(result[1].payload.value, /Ontladen geblokkeerd|break-even/);
});

test('invalid sensor data returns a null-first output tuple', () => {
  const node = { status() {} };
  const msg = { data: { p1c: 'abc', p1p: 0, accu: 0, pv: 0, soc: 50, target: 0 } };

  const result = controllerModule.controller(node, msg);
  assert.ok(Array.isArray(result));
  assert.equal(result[0], null);
});
