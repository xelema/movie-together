// Fil d'exécution du recalage : findOffset tient le processeur une à deux
// secondes sur un long métrage, hors du fil qui porte les séances.
import { parentPort, workerData } from 'node:worker_threads';
import { findOffset } from './subtitle-sync.js';

parentPort.postMessage(findOffset(workerData));
