// El mantenimiento programado escribe (SLA, escalaciones y poda de
// notificaciones). Para que una prueba de arranque contra SQL Server no escriba
// en la base, `JOBS_ENABLED=false` debe impedir que el job se programe o que se
// ejecute la pasada inicial. No se abre ninguna conexión aquí: se comprueba la
// puerta antes de tocar la base.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { jobsEnabled } from '../src/config.js';
import { startJobs } from '../src/utils/jobs.js';

describe('jobsEnabled: interpretación de JOBS_ENABLED', () => {
  it('está activado por defecto', () => {
    assert.equal(jobsEnabled({}), true);
    assert.equal(jobsEnabled({ JOBS_ENABLED: '' }), true);
    assert.equal(jobsEnabled({ JOBS_ENABLED: 'true' }), true);
  });

  it('se desactiva con 0/false/no/off', () => {
    for (const value of ['0', 'false', 'FALSE', 'no', 'off']) {
      assert.equal(jobsEnabled({ JOBS_ENABLED: value }), false, `JOBS_ENABLED=${value}`);
    }
  });
});

describe('startJobs: no programa nada cuando JOBS_ENABLED=false', () => {
  it('no llama a setInterval ni ejecuta la pasada inicial', () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevJobs = process.env.JOBS_ENABLED;
    const realSetInterval = global.setInterval;
    let intervalCalls = 0;
    global.setInterval = (...args) => {
      intervalCalls += 1;
      return realSetInterval(...args);
    };

    // NODE_ENV=development evita la salida temprana del modo test y deja que la
    // única razón para no programar sea la puerta JOBS_ENABLED.
    process.env.NODE_ENV = 'development';
    process.env.JOBS_ENABLED = 'false';
    try {
      const scheduled = startJobs();
      assert.equal(scheduled, false);
      assert.equal(intervalCalls, 0, 'no debería programar el job periódico');
    } finally {
      global.setInterval = realSetInterval;
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevJobs === undefined) delete process.env.JOBS_ENABLED;
      else process.env.JOBS_ENABLED = prevJobs;
    }
  });
});
