import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createStaticServer } from '../scripts/serve.mjs';

test('embedding is opt-in and limited to the local Workbench entry page', async () => {
  for (const workbenchEmbed of [false, true]) {
    const server = await createStaticServer({ workbenchEmbed });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      for (const path of ['/', '/?embed=workbench', '/index.html?embed=workbench', '/licenses.html?embed=workbench', '/?embed=other']) {
        const response = await fetch(origin + path, { method: 'HEAD' });
        assert.equal(response.status, 200);
        const ancestors = response.headers.get('content-security-policy').split('; ').find(rule => rule.startsWith('frame-ancestors'));
        if (workbenchEmbed && ['/?embed=workbench', '/index.html?embed=workbench'].includes(path)) {
          assert.equal(ancestors, 'frame-ancestors http://127.0.0.1:4747 http://localhost:4747 http://[::1]:4747');
          assert.equal(response.headers.get('x-frame-options'), null);
        } else {
          assert.equal(ancestors, "frame-ancestors 'none'");
          assert.equal(response.headers.get('x-frame-options'), 'DENY');
        }
      }
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
});
