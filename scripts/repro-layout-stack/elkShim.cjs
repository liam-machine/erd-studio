// Stands in for 'elkjs/lib/elk-api' in the repro bundle: the real ELK engine,
// run in-process (elkjs's FakeWorker), so `node --stack-size=N` limits it.
// REPRO_ELK=full uses the unminified worker for readable stack frames.
const ELKApi = require('elkjs/lib/elk-api.js').default;
const workerPath = process.env.REPRO_ELK === 'full' ? 'elkjs/lib/elk-worker.js' : 'elkjs/lib/elk-worker.min.js';
const { Worker } = require(workerPath);
class ELK extends ELKApi {
  constructor() {
    super({ workerFactory: (url) => new Worker(url) });
  }
}
module.exports = ELK;
module.exports.default = ELK;
