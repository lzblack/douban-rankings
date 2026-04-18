import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { createHttpClient } from '../../src/util/http.mjs';

function startServer(handler) {
    return new Promise(resolve => {
        const server = createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                port,
                base: `http://127.0.0.1:${port}`,
                close: () => new Promise(r => server.close(r)),
            });
        });
    });
}

test('sends configured User-Agent', async () => {
    let receivedUa;
    const srv = await startServer((req, res) => {
        receivedUa = req.headers['user-agent'];
        res.end('ok');
    });
    try {
        const http = createHttpClient({
            userAgent: 'TestBot/1.0',
            defaultMinDelay: 0,
        });
        await http.fetch(srv.base);
        assert.equal(receivedUa, 'TestBot/1.0');
    } finally {
        await srv.close();
    }
});

test('enforces defaultMinDelay between requests to same host', async () => {
    const srv = await startServer((_, res) => res.end('ok'));
    try {
        const http = createHttpClient({ defaultMinDelay: 120 });
        const start = Date.now();
        await http.fetch(`${srv.base}/a`);
        await http.fetch(`${srv.base}/b`);
        const elapsed = Date.now() - start;
        assert.ok(
            elapsed >= 120,
            `expected >=120ms between requests, got ${elapsed}ms`,
        );
    } finally {
        await srv.close();
    }
});

test('per-host rateLimits override defaultMinDelay', async () => {
    const srv = await startServer((_, res) => res.end('ok'));
    try {
        const http = createHttpClient({
            defaultMinDelay: 0,
            rateLimits: { '127.0.0.1': { minDelay: 150 } },
        });
        const start = Date.now();
        await http.fetch(`${srv.base}/a`);
        await http.fetch(`${srv.base}/b`);
        assert.ok(Date.now() - start >= 150);
    } finally {
        await srv.close();
    }
});

test('retries on 500 then gives up', async () => {
    let calls = 0;
    const srv = await startServer((_, res) => {
        calls++;
        res.statusCode = 500;
        res.end('bad');
    });
    try {
        const http = createHttpClient({
            defaultMinDelay: 0,
            maxRetries: 2,
            backoffBase: 5,
            backoffMax: 10,
        });
        const res = await http.fetch(srv.base);
        assert.equal(res.status, 500);
        assert.equal(calls, 3); // initial + 2 retries
    } finally {
        await srv.close();
    }
});

test('retries on 429 and succeeds on recovery', async () => {
    let calls = 0;
    const srv = await startServer((_, res) => {
        calls++;
        if (calls < 3) {
            res.statusCode = 429;
            res.end('slow down');
        } else {
            res.end('ok');
        }
    });
    try {
        const http = createHttpClient({
            defaultMinDelay: 0,
            maxRetries: 3,
            backoffBase: 5,
            backoffMax: 10,
        });
        const res = await http.fetch(srv.base);
        assert.equal(res.status, 200);
        assert.equal(calls, 3);
    } finally {
        await srv.close();
    }
});

test('redirect: manual returns 302 without following', async () => {
    const srv = await startServer((req, res) => {
        if (req.url === '/redirect') {
            res.statusCode = 302;
            res.setHeader('Location', '/target');
            res.end();
        } else {
            res.end('target body');
        }
    });
    try {
        const http = createHttpClient({ defaultMinDelay: 0 });
        const res = await http.fetch(`${srv.base}/redirect`, {
            redirect: 'manual',
        });
        assert.equal(res.status, 302);
        assert.equal(res.headers.get('location'), '/target');
    } finally {
        await srv.close();
    }
});

test('does not rate-limit across different hosts', async () => {
    const srvA = await startServer((_, res) => res.end('a'));
    const srvB = await startServer((_, res) => res.end('b'));
    try {
        const http = createHttpClient({ defaultMinDelay: 200 });
        // Two distinct hostnames: '127.0.0.1' vs 'localhost'.
        const start = Date.now();
        await http.fetch(`http://127.0.0.1:${srvA.port}/`);
        await http.fetch(`http://localhost:${srvB.port}/`);
        assert.ok(
            Date.now() - start < 200,
            'different hosts should not block each other',
        );
    } finally {
        await srvA.close();
        await srvB.close();
    }
});
