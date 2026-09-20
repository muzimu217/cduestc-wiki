#!/usr/bin/env node
import http from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    SLOT_VARS,
    UPSTREAM_PRESETS,
    normalizeChatCompletionsUrl,
    upsertJsoncString,
} from './switch-ai-upstream.mjs'
import { listOpenAIModels, probeOpenAICompatible } from './ai-upstream-models.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WRANGLER_PATH = resolve(ROOT, 'wrangler.jsonc')
const HTML_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'ai-upstream-console.html')
const HOST = '127.0.0.1'
const PORT = Number(process.env.AI_CONSOLE_PORT || 8799)

export function readWranglerVars(text = readFileSync(WRANGLER_PATH, 'utf8')) {
    const vars = {}
    for (const match of text.matchAll(/"(SPARK_[A-Z0-9_]+)"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
        vars[match[1]] = JSON.parse(`"${match[2]}"`)
    }
    return vars
}

export function currentUpstreamStatus() {
    const vars = readWranglerVars()
    return {
        primary: {
            name: vars.SPARK_PRIMARY_NAME || vars.SPARK_PRIMARY_PRESET || 'spark-primary',
            url: vars.SPARK_OPENAI_URL || '',
            model: vars.SPARK_MODEL || '',
            preset: vars.SPARK_PRIMARY_PRESET || '',
            secret: SLOT_VARS.primary.secret,
        },
        fallback: {
            name: vars.SPARK_FALLBACK_NAME || vars.SPARK_FALLBACK_PRESET || 'fallback',
            url: vars.SPARK_FALLBACK_URL || '',
            model: vars.SPARK_FALLBACK_MODEL || '',
            preset: vars.SPARK_FALLBACK_PRESET || '',
            secret: SLOT_VARS.fallback.secret,
        },
        presets: UPSTREAM_PRESETS,
    }
}

function writeSlotConfig(slotName, item) {
    const slot = SLOT_VARS[slotName]
    let text = readFileSync(WRANGLER_PATH, 'utf8')
    text = upsertJsoncString(text, slot.url, item.url)
    text = upsertJsoncString(text, slot.model, item.model)
    text = upsertJsoncString(text, slot.name, item.name)
    text = upsertJsoncString(text, slot.preset, item.preset || item.name)
    writeFileSync(WRANGLER_PATH, text)
}

function runCaptured(command, args, { inputText, timeoutMs = 180000 } = {}) {
    const result = spawnSync(command, args, {
        cwd: ROOT,
        encoding: 'utf8',
        input: inputText,
        timeout: timeoutMs,
        maxBuffer: 4_000_000,
    })
    return {
        status: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        error: result.error ? String(result.error.message || result.error) : '',
    }
}

function putSlotSecret(slotName, secret, { github = true } = {}) {
    const slot = SLOT_VARS[slotName]
    const wranglerBin = resolve(ROOT, 'node_modules/.bin/wrangler')
    const put = runCaptured(wranglerBin, ['secret', 'put', slot.secret, '--config', 'wrangler.jsonc'], { inputText: secret })
    if (put.status !== 0)
        throw new Error(`${slot.secret} 写入 Worker 失败
${put.stdout}
${put.stderr}
${put.error}`)
    if (slot.github && github) {
        const gh = runCaptured('gh', ['secret', 'set', slot.secret], { inputText: secret })
        if (gh.status !== 0)
            throw new Error(`${slot.secret} 写入 GitHub Secret 失败`)
    }
}

function redactSecrets(text, secrets) {
    let output = String(text || '')
    for (const secret of secrets) {
        if (secret)
            output = output.split(secret).join('[redacted]')
    }
    return output.slice(0, 8000)
}


export async function applyUpstreamPlan(plan, onLog = () => {}) {
    const prepared = {}
    for (const slotName of ['primary', 'fallback']) {
        const item = plan?.[slotName]
        if (!item) continue
        const url = String(item.url || '').trim()
        const model = String(item.model || '').trim()
        const key = String(item.key || '').trim()
        if (!url && !model && !key) continue
        if (!url || !model)
            throw new Error(`${slotName === 'primary' ? '主上游' : '备用上游'}需要 API 地址和模型名`)
        prepared[slotName] = {
            url: normalizeChatCompletionsUrl(url),
            model,
            name: String(item.name || slotName).trim() || slotName,
            preset: String(item.preset || item.name || slotName).trim() || slotName,
            key,
        }
    }
    if (!Object.keys(prepared).length)
        throw new Error('没有要更新的上游')

    const secrets = Object.values(prepared).map(item => item.key).filter(Boolean)

    if (plan.probe) {
        for (const [slotName, item] of Object.entries(prepared)) {
            if (!item.key) {
                onLog({ step: 'probe', slot: slotName, skipped: true, message: '未填密钥，跳过连通性探测' })
                continue
            }
            onLog({ step: 'probe', slot: slotName, message: `正在探测 ${item.url}` })
            const result = await probeOpenAICompatible(item)
            onLog({ step: 'probe', slot: slotName, ok: result.ok, status: result.status, content: result.content, error: result.error, endpoint: result.endpoint })
            if (!result.ok)
                throw new Error(`${slotName === 'primary' ? '主上游' : '备用上游'}探测失败：HTTP ${result.status} ${result.error}`)
        }
    }

    for (const [slotName, item] of Object.entries(prepared)) {
        onLog({ step: 'write', slot: slotName, url: item.url, model: item.model, name: item.name })
        writeSlotConfig(slotName, item)
        if (item.key) {
            onLog({ step: 'secret', slot: slotName, message: `写入 ${SLOT_VARS[slotName].secret}` })
            putSlotSecret(slotName, item.key, { github: plan.syncGithub !== false })
            onLog({ step: 'secret', slot: slotName, ok: true })
        }
    }

    onLog({ step: 'test', message: '运行 pnpm test:worker' })
    const test = runCaptured('pnpm', ['test:worker'])
    onLog({ step: 'test', ok: test.status === 0, output: redactSecrets(`${test.stdout}\n${test.stderr}\n${test.error}`, secrets) })
    if (test.status !== 0)
        throw new Error('本地测试失败，已停止部署')

    if (plan.deploy !== false) {
        onLog({ step: 'deploy', message: '正在部署 Cloudflare Worker' })
        const deploy = runCaptured(resolve(ROOT, 'node_modules/.bin/wrangler'), ['deploy', '--config', 'wrangler.jsonc'], { timeoutMs: 180000 })
        onLog({ step: 'deploy', ok: deploy.status === 0, output: redactSecrets(`${deploy.stdout}\n${deploy.stderr}\n${deploy.error}`, secrets) })
        if (deploy.status !== 0)
            throw new Error('Worker 部署失败')

        onLog({ step: 'live', message: '检查线上 /health' })
        const healthRes = await fetch('https://spark-api.kcos.club/health')
        const healthText = await healthRes.text()
        let health = null
        try { health = JSON.parse(healthText) }
        catch { health = { raw: healthText.slice(0, 200) } }
        onLog({ step: 'live', ok: healthRes.ok, status: healthRes.status, health })
        if (!healthRes.ok)
            throw new Error(`线上 health 失败：HTTP ${healthRes.status}`)

        onLog({ step: 'live-chat', message: '检查线上问答' })
        const chatRes = await fetch('https://spark-api.kcos.club/v1/chat/completions', {
            method: 'POST',
            headers: {
                Origin: 'https://wiki.kcos.club',
                'Content-Type': 'application/json',
                'User-Agent': 'cduestc-wiki-console',
            },
            body: JSON.stringify({
                messages: [{ role: 'user', content: '请只回答：连通性测试通过' }],
                stream: false,
            }),
        })
        const chatText = await chatRes.text()
        let chatJson = null
        try { chatJson = JSON.parse(chatText) }
        catch { chatJson = null }
        const content = chatJson?.choices?.[0]?.message?.content || ''
        onLog({ step: 'live-chat', ok: chatRes.ok && Boolean(content), status: chatRes.status, content: String(content).slice(0, 80) })
        if (!chatRes.ok)
            throw new Error(`线上问答失败：HTTP ${chatRes.status}`)
    }

    if (plan.push) {
        onLog({ step: 'git', message: '只提交 wrangler.jsonc' })
        const add = runCaptured('git', ['add', '--', 'wrangler.jsonc'])
        if (add.status !== 0)
            throw new Error('git add 失败')
        const changed = runCaptured('git', ['diff', '--cached', '--name-only', '--', 'wrangler.jsonc'])
        if (!String(changed.stdout || '').trim()) {
            onLog({ step: 'git', skipped: true, message: 'wrangler.jsonc 没有可提交的变更' })
        }
        else {
            const commit = runCaptured('git', ['commit', '-m', 'chore(ai): switch OpenAI-compatible upstream'])
            onLog({ step: 'git', ok: commit.status === 0, output: `${commit.stdout}\n${commit.stderr}` })
            if (commit.status !== 0)
                throw new Error('git commit 失败')
            const push = runCaptured('git', ['push', 'origin', 'HEAD'])
            onLog({ step: 'push', ok: push.status === 0, output: `${push.stdout}\n${push.stderr}` })
            if (push.status !== 0)
                throw new Error('git push 失败。若 Worker 已部署，线上配置仍然在。')
        }
    }

    const status = currentUpstreamStatus()
    onLog({ step: 'done', ok: true, status })
    return status
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

function readBody(req) {
    return new Promise((resolvePromise, reject) => {
        const chunks = []
        let size = 0
        req.on('data', (chunk) => {
            size += chunk.length
            if (size > 1_000_000) {
                reject(new Error('payload too large'))
                req.destroy()
                return
            }
            chunks.push(chunk)
        })
        req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
    })
}

function isLocalHost(req) {
    const host = String(req.headers.host || '').split(':')[0]
    return host === '127.0.0.1' || host === 'localhost'
}

async function handle(req, res) {
    if (!isLocalHost(req)) {
        send(res, 403, { error: 'only localhost' })
        return
    }
    const url = new URL(req.url, `http://${HOST}:${PORT}`)
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        send(res, 200, readFileSync(HTML_PATH, 'utf8'), 'text/html; charset=utf-8')
        return
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
        let live = null
        try {
            const healthRes = await fetch('https://spark-api.kcos.club/health')
            live = { ok: healthRes.ok, status: healthRes.status, body: await healthRes.json() }
        }
        catch (error) {
            live = { ok: false, error: String(error.message || error) }
        }
        send(res, 200, { ok: true, current: currentUpstreamStatus(), live })
        return
    }
    if (req.method === 'POST' && url.pathname === '/api/probe') {
        const payload = JSON.parse(await readBody(req))
        const result = await probeOpenAICompatible(payload)
        send(res, result.ok ? 200 : 502, result)
        return
    }
    if (req.method === 'POST' && url.pathname === '/api/models') {
        const payload = JSON.parse(await readBody(req))
        const result = await listOpenAIModels(payload)
        send(res, result.ok ? 200 : 502, result)
        return
    }
    if (req.method === 'POST' && url.pathname === '/api/apply') {
        const plan = JSON.parse(await readBody(req))
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
        })
        const log = (event) => {
            res.write(`data: ${JSON.stringify(event)}\n\n`)
        }
        try {
            await applyUpstreamPlan(plan, log)
        }
        catch (error) {
            log({ step: 'error', ok: false, message: String(error.message || error) })
        }
        res.end()
        return
    }
    send(res, 404, { error: 'not found' })
}

export function startConsoleServer() {
    const server = http.createServer((req, res) => {
        handle(req, res).catch((error) => {
            if (!res.headersSent)
                send(res, 500, { error: String(error.message || error) })
            else
                res.end()
        })
    })
    server.listen(PORT, HOST, () => {
        const page = `http://${HOST}:${PORT}/`
        console.log(`AI 上游编排台：${page}`)
        console.log('只监听本机。密钥不会写入仓库。')
        spawnSync('open', [page], { stdio: 'ignore' })
    })
    return server
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    startConsoleServer()
}
