import type { AIKnowledgeSource } from './types'

export interface KnowledgeEntry {
    title: string
    section?: string
    content: string
    url: string
    embedding?: string
}

interface WeightedTerm {
    value: string
    weight: number
}

interface ScoredEntry extends KnowledgeEntry {
    metadataScore: number
    score: number
}

export interface KnowledgeSource extends AIKnowledgeSource {
    metadataScore: number
    relevanceScore: number
}

const MAX_SOURCES = 4
const MAX_SOURCE_LENGTH = 1_600
const MIN_SOURCE_SCORE = 6
const MAX_CHUNKS_PER_PAGE = 4
const EMBEDDING_DIMENSION = 384

const LOW_SIGNAL_TERMS = new Set([
    '一下',
    '什么',
    '介绍',
    '可以',
    '哪些',
    '如何',
    '怎么样',
    '怎么',
    '是否',
    '有关',
    '条件',
    '相关',
    '请问',
])

const TOPIC_ALIASES = [
    ['宿舍', '寝室', '住宿', '公寓'],
    ['食堂', '餐厅', '餐饮', '吃饭'],
    ['选课', '课程选择'],
    ['快递', '取件', '驿站'],
    ['校园网', '宽带', '网络'],
    ['实验室', '工作室'],
    ['社团', '协会', '学生组织'],
    ['转专业', '专业调整'],
    ['图书馆', '借书'],
    ['军训', '军事训练'],
    ['校区', '成都校区', '什邡校区', '成都', '什邡'],
    ['奖学金', '奖项', '奖励', '助学金'],
    ['专升本', '升本', '专科升本科'],
]

const FOLLOW_UP_PATTERN = /^(?:[那它这该还也]|上面|前面)|^(?:周末|晚上|几点|多久|多少钱|怎么办)\s*[呢吗？?]?$/u

function normalize(value: string) {
    return value.toLowerCase().replace(/[\s\p{P}]/gu, '')
}

function addTerm(terms: Map<string, number>, value: string, weight: number) {
    const normalized = normalize(value)
    if (normalized.length < 2 || LOW_SIGNAL_TERMS.has(normalized))
        return
    terms.set(normalized, Math.max(terms.get(normalized) || 0, weight))
}

function getQueryTerms(query: string): WeightedTerm[] {
    const normalizedQuery = normalize(query)
    const terms = new Map<string, number>()

    if (/转.{0,6}专业/u.test(normalizedQuery)) {
        for (const alias of TOPIC_ALIASES.find(aliases => aliases.includes('转专业')) || [])
            addTerm(terms, alias, alias === '转专业' ? 10 : 7)
    }

    for (const aliases of TOPIC_ALIASES) {
        const matchedAlias = aliases.find(alias => normalizedQuery.includes(normalize(alias)))
        if (!matchedAlias)
            continue

        for (const alias of aliases)
            addTerm(terms, alias, alias === matchedAlias ? 8 : 5)
    }

    for (let length = 4; length >= 2; length--) {
        for (let index = 0; index <= normalizedQuery.length - length; index++)
            addTerm(terms, normalizedQuery.slice(index, index + length), length)
    }

    return [...terms].map(([value, weight]) => ({ value, weight }))
}

function countOccurrences(content: string, term: string) {
    let count = 0
    let offset = 0
    while (count < 3) {
        const index = content.indexOf(term, offset)
        if (index < 0)
            break
        count++
        offset = index + term.length
    }
    return count
}

function normalizeEmbeddingText(value: string) {
    return [...value.toLowerCase()]
        .filter(character => !/\s/u.test(character) && !/\p{P}/u.test(character))
        .join('')
}

function fnv1a(bytes: Uint8Array) {
    let value = 2166136261
    for (const byte of bytes)
        value = Math.imul(value ^ byte, 16777619) >>> 0
    return value
}

function buildQueryEmbedding(value: string) {
    const text = normalizeEmbeddingText(value)
    const vector = new Float32Array(EMBEDDING_DIMENSION)
    const encoder = new TextEncoder()
    for (const length of [2, 3, 4]) {
        for (let index = 0; index <= text.length - length; index++) {
            const hash = fnv1a(encoder.encode(text.slice(index, index + length)))
            const bucket = hash % EMBEDDING_DIMENSION
            const weight = length === 3 ? 1.35 : 1
            vector[bucket] += ((hash >> 8) & 1) ? weight : -weight
        }
    }

    let norm = 0
    for (const component of vector)
        norm += component * component
    norm = Math.sqrt(norm) || 1
    for (let index = 0; index < vector.length; index++)
        vector[index] /= norm
    return vector
}

function decodeEmbedding(value?: string) {
    if (!value)
        return null
    try {
        const binary = atob(value)
        if (binary.length !== EMBEDDING_DIMENSION)
            return null
        return Int8Array.from(binary, character => character.charCodeAt(0) > 127
            ? character.charCodeAt(0) - 256
            : character.charCodeAt(0))
    }
    catch {
        return null
    }
}

function cosineSimilarity(queryVector: Float32Array, entryVector: Int8Array | null) {
    if (!entryVector)
        return 0
    let dot = 0
    let entryNorm = 0
    for (let index = 0; index < queryVector.length; index++) {
        dot += queryVector[index] * entryVector[index]
        entryNorm += entryVector[index] * entryVector[index]
    }
    return entryNorm ? dot / Math.sqrt(entryNorm) : 0
}

function scoreEntry(
    entry: KnowledgeEntry,
    terms: WeightedTerm[],
    documentFrequency: Map<string, number>,
    documentCount: number,
    averageContentLength: number,
    queryEmbedding: Float32Array,
) {
    const title = normalize(entry.title)
    const section = normalize(entry.section || '')
    const url = normalize(decodeURIComponent(entry.url))
    const content = normalize(entry.content)

    const contentLength = Math.max(content.length, 1)
    const scores = terms.reduce((result, term) => {
        const idf = Math.log((documentCount + 1) / ((documentFrequency.get(term.value) || 0) + 1)) + 1
        if (title.includes(term.value))
            result.metadata += term.weight * 8 * idf
        if (section.includes(term.value))
            result.metadata += term.weight * 5 * idf
        if (url.includes(term.value))
            result.metadata += term.weight * 3 * idf

        const termFrequency = countOccurrences(content, term.value)
        if (termFrequency) {
            const lengthNormalization = 1 - 0.75 + 0.75 * contentLength / Math.max(averageContentLength, 1)
            const bm25 = termFrequency * 2.2 / (termFrequency + 1.2 * lengthNormalization)
            result.content += bm25 * term.weight * idf * 4
        }
        return result
    }, { metadata: 0, content: 0 })
    return {
        ...scores,
        semantic: cosineSimilarity(queryEmbedding, decodeEmbedding(entry.embedding)),
    }
}

export function rewriteRetrievalQuery(message: string, previousQueries: string[]) {
    const previous = previousQueries.filter(Boolean).slice(-2)
    if (!previous.length || !FOLLOW_UP_PATTERN.test(message.trim()))
        return message
    return [...previous, message].join(' ')
}

function getPageUrl(url: string) {
    return url.split('#')[0]
}

function getSourceId(url: string) {
    let hash = 0x811C9DC5
    for (let index = 0; index < url.length; index++) {
        hash ^= url.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193)
    }
    return `kb_${(hash >>> 0).toString(36)}`
}

export function searchKnowledge(entries: KnowledgeEntry[], query: string): KnowledgeSource[] {
    const terms = getQueryTerms(query)
    if (!entries.length || !terms.length)
        return []

    const queryEmbedding = buildQueryEmbedding(query)
    const documentFrequency = new Map<string, number>()
    const averageContentLength = entries.reduce((total, entry) => total + normalize(entry.content).length, 0) / entries.length
    for (const term of terms) {
        const frequency = entries.reduce((count, entry) => {
            const document = normalize(`${entry.title} ${entry.section || ''} ${entry.content} ${entry.url}`)
            return count + (document.includes(term.value) ? 1 : 0)
        }, 0)
        documentFrequency.set(term.value, frequency)
    }

    const pages = new Map<string, ScoredEntry[]>()
    for (const entry of entries) {
        const scores = scoreEntry(entry, terms, documentFrequency, entries.length, averageContentLength, queryEmbedding)
        const lexicalScore = scores.metadata + scores.content
        const score = lexicalScore + Math.max(0, scores.semantic - 0.35) * 8
        if (score < MIN_SOURCE_SCORE && scores.semantic < 0.78)
            continue

        const pageUrl = getPageUrl(entry.url)
        const pageEntries = pages.get(pageUrl) || []
        pageEntries.push({ ...entry, metadataScore: scores.metadata, score })
        pages.set(pageUrl, pageEntries)
    }

    return [...pages.entries()]
        .map(([pageUrl, pageEntries]) => {
            const rankedEntries = pageEntries.sort((a, b) => b.score - a.score)
            const bestEntry = rankedEntries[0]
            const content = rankedEntries.slice(0, MAX_CHUNKS_PER_PAGE)
                .map(entry => `${entry.section || entry.title}\n${entry.content}`)
                .join('\n\n')
                .slice(0, MAX_SOURCE_LENGTH)

            return {
                source: {
                    id: getSourceId(pageUrl),
                    title: bestEntry.title,
                    section: bestEntry.section || bestEntry.title,
                    content,
                    url: bestEntry.url,
                    metadataScore: bestEntry.metadataScore,
                    relevanceScore: bestEntry.score,
                },
                score: bestEntry.score,
            }
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_SOURCES)
        .map(result => result.source)
}

export function selectRelatedSources(
    sources: KnowledgeSource[],
    citedSourceIds: string[],
) {
    const citedIds = new Set(citedSourceIds.map(id => id.toLowerCase()))
    const citedSources = sources.filter(source => citedIds.has(source.id))
    if (citedSources.length)
        return citedSources

    const bestSource = sources[0]
    if (!bestSource || bestSource.relevanceScore < MIN_SOURCE_SCORE)
        return []

    // Retrieval already applies a relevance threshold. Keep the fallback useful
    // when a provider fails or omits the citation marker, while avoiding weak tail results.
    const relevanceFloor = Math.max(MIN_SOURCE_SCORE, bestSource.relevanceScore * 0.35)
    const fallbackSources = sources.filter(source => source.relevanceScore >= relevanceFloor)
    return fallbackSources.slice(0, 3)
}
