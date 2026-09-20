import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HELPER = resolve(dirname(fileURLToPath(import.meta.url)), 'openai-compat-fetch.py')

export function modelsEndpoint(value) {
    const raw = String(value || '').trim()
    if (!raw)
        throw new Error('API 地址不能为空')
    let url
    try {
        url = new URL(raw)
    }
    catch {
        throw new Error('API 地址必须是 http(s) URL')
    }
    if (/\/models$/u.test(url.pathname))
        return url.toString().replace(/\/+$/u, '')
    if (/\/chat\/completions$/u.test(url.pathname)) {
        url.pathname = url.pathname.replace(/\/chat\/completions$/u, '/models')
        return url.toString().replace(/\/+$/u, '')
    }
    url.pathname = `${url.pathname.replace(/\/+$/u, '')}/models`
    return url.toString().replace(/\/+$/u, '')
}

export function isChatModel(id) {
    const value = String(id || '').toLowerCase()
    if (!value)
        return false
    return !/whisper|tts|orpheus|prompt-guard|embed|rerank|image|audio|asr|safeguard/.test(value)
}

export function recommendChatModel(ids) {
    const ranked = [
        /qwen/i,
        /glm/i,
        /llama-3\.3-70b/i,
        /llama.*versatile/i,
        /gpt-oss-20b/i,
        /gpt-oss-120b/i,
        /deepseek/i,
    ]
    const chatIds = ids.filter(isChatModel)
    for (const pattern of ranked) {
        const hit = chatIds.find(id => pattern.test(id))
        if (hit)
            return hit
    }
    return chatIds[0] || ids[0] || ''
}

function pythonRequest({ method, url, key, body }) {
    const result = spawnSync('python3', [HELPER], {
        encoding: 'utf8',
        input: JSON.stringify({ method, url, body: body || null }),
        env: { ...process.env, OPENAI_COMPAT_KEY: String(key || '') },
        timeout: 25000,
        maxBuffer: 2_000_000,
    })
    if (result.error)
        return { ok: false, status: 0, text: String(result.error.message || result.error) }
    try {
        return JSON.parse(result.stdout || '{}')
    }
    catch {
        return { ok: false, status: 0, text: String(result.stdout || result.stderr || 'python helper failed').slice(0, 240) }
    }
}

export async function listOpenAIModels({ url, key }) {
    const endpoint = modelsEndpoint(url)
    const result = pythonRequest({ method: 'GET', url: endpoint, key })
    let parsed = null
    try {
        parsed = JSON.parse(result.text || '{}')
    }
    catch {
        parsed = null
    }
    const ids = [...new Set((parsed?.data || []).map(item => item?.id).filter(Boolean))].sort()
    return {
        ok: Boolean(result.ok) && ids.length > 0,
        status: result.status,
        endpoint,
        models: ids,
        chatModels: ids.filter(isChatModel),
        recommended: recommendChatModel(ids),
        error: String(parsed?.error?.message || parsed?.message || (!result.ok ? result.text : '')).slice(0, 240),
    }
}

export async function probeOpenAICompatible({ url, model, key }) {
    const { normalizeChatCompletionsUrl } = await import('./switch-ai-upstream.mjs')
    const endpoint = normalizeChatCompletionsUrl(url)
    const result = pythonRequest({
        method: 'POST',
        url: endpoint,
        key,
        body: {
            model,
            messages: [{ role: 'user', content: '请只回答：连通性测试通过' }],
            temperature: 0.2,
            max_tokens: 32,
            stream: false,
        },
    })
    let parsed = null
    try {
        parsed = JSON.parse(result.text || '{}')
    }
    catch {
        parsed = null
    }
    const content = parsed?.choices?.[0]?.message?.content || parsed?.choices?.[0]?.delta?.content || ''
    return {
        ok: Boolean(result.ok) && Boolean(String(content).trim()),
        status: result.status,
        endpoint,
        content: String(content).trim().slice(0, 120),
        error: String(parsed?.error?.message || parsed?.message || (!result.ok ? result.text : '')).slice(0, 240),
    }
}
