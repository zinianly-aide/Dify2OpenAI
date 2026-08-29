import { randomUUID } from 'node:crypto';
import { sha256 } from '@zinianly-aide/dify-core';

export function newTraceId() {
  return randomUUID();
}

export function sessionHash(sessionId) {
  return sha256(String(sessionId)).slice(0, 16);
}

export function emitTrace(logger, event) {
  const payload = JSON.stringify({
    ts: new Date().toISOString(),
    component: 'dsh-dify-provider',
    ...event,
  });
  if (logger?.info) logger.info(payload);
  else console.log(payload);
}
