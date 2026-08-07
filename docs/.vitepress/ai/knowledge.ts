import type { AIKnowledgeSource } from './types'

export interface KnowledgeEntry {
    title: string
    section?: string
    content: string
    url: string
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
]

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

function scoreEntry(entry: KnowledgeEntry, terms: WeightedTerm[]) {
    const title = normalize(entry.title)
    const section = normalize(entry.section || '')
    const url = normalize(decodeURIComponent(entry.url))
    const content = normalize(entry.content)

    return terms.reduce((scores, term) => {
        if (title.includes(term.value))
            scores.metadata += term.weight * 12
        if (section.includes(term.value))
            scores.metadata += term.weight * 8
        if (url.includes(term.value))
            scores.metadata += term.weight * 6
        scores.content += countOccurrences(content, term.value) * term.weight
        return scores
    }, { metadata: 0, content: 0 })
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

    const pages = new Map<string, ScoredEntry[]>()
    for (const entry of entries) {
        const scores = scoreEntry(entry, terms)
        const score = scores.metadata + scores.content
        if (score < MIN_SOURCE_SCORE)
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
