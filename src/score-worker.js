// Worker thread: scores a single PDF and returns metrics via postMessage.
import { workerData, parentPort } from 'worker_threads';
import { scorePdf } from './score.js';

try {
  const metrics = await scorePdf(workerData.pdfPath);
  parentPort.postMessage({ ok: true, metrics });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message });
}
