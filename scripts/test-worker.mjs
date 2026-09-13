import assert from 'node:assert/strict'
import worker from '../workers/spark-proxy.js'

const originalFetch = globalThis.fetch
const origin = 'https://wiki.kcos.club'
const headers = { 'Origin': origin, 'Content-Type': 'application/json' }
let calls = 0
const capturedRequests = []

try {
    globalThis.fetch = async (url, options) => {
        calls++
        const request = JSON.parse(options.body)
        capturedRequests.push({ url, options, request })
        if (request.stream) {
            const body = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n'
            return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
        }
        if (calls === 1)
            return new Response(JSON.stringify({ error: { message: 'primary unavailable' } }), { status: 503 })
        return new Response(JSON.stringify({ choices: [{ message: { content: 'fallback' } }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })
    }

    const env = {
        SPARK_API_PASSWORD: 'test-primary',
        SPARK_ALLOWED_ORIGINS: origin,
        SPARK_FALLBACK_URL: 'https://fallback.example/v1/chat/completions',
        SPARK_FALLBACK_API_PASSWORD: 'test-fallback',
        SPARK_FALLBACK_NAME: 'test-fallback',
        SPARK_FALLBACK_MODEL: 'test-model',
    }
    const health = await worker.fetch(new Request('https://spark-api.kcos.club/health'), env)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { status: 'ok', fallbackConfigured: true })

    const preflight = await worker.fetch(new Request('https://spark-api.kcos.club/v1/chat/completions', {
        method: 'OPTIONS',
        headers: {
            'Origin': origin,
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type',
        },
    }), env)
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin)
    assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS')
    assert.equal(await preflight.text(), '')

    const forbidden = await worker.fetch(new Request('https://spark-api.kcos.club/telemetry', {
        method: 'POST',
        headers: { ...headers, Origin: 'https://evil.example' },
        body: JSON.stringify({ event: 'feedback' }),
    }), env)
    assert.equal(forbidden.status, 403)

    const invalid = await worker.fetch(new Request('https://spark-api.kcos.club/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({ messages: [] }),
    }), env)
    assert.equal(invalid.status, 400)

    const telemetry = await worker.fetch(new Request('https://spark-api.kcos.club/telemetry', {
        method: 'POST',
        headers,
        body: JSON.stringify({ event: 'search_zero', queryPreview: '校园网怎么连接 13800138000', rating: 1 }),
    }), env)
    assert.equal(telemetry.status, 202)

    calls = 0
    capturedRequests.length = 0
    const stream = await worker.fetch(new Request('https://spark-api.kcos.club/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }], stream: true }),
    }), env)
    assert.equal(stream.status, 200)
    assert.match(await stream.text(), /data: \[DONE\]/)

    calls = 0
    capturedRequests.length = 0
    const fallback = await worker.fetch(new Request('https://spark-api.kcos.club/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
    }), env)
    assert.equal(fallback.status, 200)
    assert.equal(calls, 2)
    assert.equal(capturedRequests[1].url, env.SPARK_FALLBACK_URL)
    assert.equal(capturedRequests[1].request.model, env.SPARK_FALLBACK_MODEL)
    assert.equal(capturedRequests[1].options.headers.Authorization, 'Bearer test-fallback')
    console.log('[test-worker] health, CORS, validation, telemetry, SSE, and fallback passed')
}
finally {
    globalThis.fetch = originalFetch
}
