const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'script.js'), 'utf8');
const controller = new Function('node', 'msg', `${source};`);

const sampleMsg = {
  data: {
    p1c: 2.082,
    p1p: 0,
    accu: 2588,
    pv: 637,
    soc: 54,
    target: 0,
    prijs: 0.17468,
    laagsteprijs: 0.15343,
    hoogsteprijs: 0.43321,
    force_charge: 'off',
    force_discharge: 'off'
  }
};

const node = {
  status: (status) => {
    console.log('Node status:', JSON.stringify(status));
  }
};

const result = controller(node, sampleMsg);
console.log('Controller output:', JSON.stringify(result));
