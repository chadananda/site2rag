// Thumbnail generation worker pool using isolated Worker threads. Exports: generateThumb. Deps: worker_threads, os
import { Worker } from 'worker_threads';
import { resolve } from 'path';
import { cpus } from 'os';

const THUMB_WORKERS = Math.max(4, Math.floor(cpus().length / 4));
const WORKER_SCRIPT = resolve(import.meta.dirname, 'thumb-worker.js');

let _jobId = 0;
const _pending = new Map();
const _queue = [];
const _workers = [];

const _dispatch = (slot) => {
  if (!_queue.length) { slot.busy = false; return; }
  const job = _queue.shift();
  slot.busy = true;
  slot.worker.postMessage(job);
};

const _makeWorker = () => {
  const slot = { worker: new Worker(WORKER_SCRIPT), busy: false };
  const onMsg = ({ jobId, success, error }) => {
    const p = _pending.get(jobId); _pending.delete(jobId);
    if (p) (success ? p.resolve : p.reject)(success ? undefined : new Error(error));
    _dispatch(slot);
  };
  slot.worker.on('message', onMsg);
  slot.worker.on('error', (e) => {
    console.error('[thumb-worker] crashed:', e.message);
    slot.worker.terminate();
    Object.assign(slot, { worker: new Worker(WORKER_SCRIPT), busy: false });
    slot.worker.on('message', onMsg);
    slot.worker.on('error', () => _dispatch(slot));
    _dispatch(slot);
  });
  return slot;
};

for (let i = 0; i < THUMB_WORKERS; i++) _workers.push(_makeWorker());

/** Queue a thumbnail generation job; resolves when the file is written. */
export const generateThumb = (pdfPath, outPath, targetW = 300, pageNo = 1, targetH = null) =>
  new Promise((resolve, reject) => {
    const jobId = ++_jobId;
    _pending.set(jobId, { resolve, reject });
    const free = _workers.find(w => !w.busy);
    if (free) { free.busy = true; free.worker.postMessage({ jobId, pdfPath, outPath, targetW, targetH, pageNo }); }
    else _queue.push({ jobId, pdfPath, outPath, targetW, targetH, pageNo });
  });
