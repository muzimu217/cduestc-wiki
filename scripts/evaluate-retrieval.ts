import type { KnowledgeEntry } from '../docs/.vitepress/ai/knowledge'
import fs from 'node:fs'
import { searchKnowledge } from '../docs/.vitepress/ai/knowledge'

interface Case {
    query: string
    page: string
}

const entries = JSON.parse(fs.readFileSync('docs/public/knowledge.json', 'utf8')) as KnowledgeEntry[]
const cases = JSON.parse(fs.readFileSync('scripts/retrieval-eval.json', 'utf8')) as Case[]
let hits = 0
let reciprocalRank = 0

for (const testCase of cases) {
    const results = searchKnowledge(entries, testCase.query)
    const rank = results.findIndex(result => result.url.split('#')[0] === testCase.page)
    if (rank >= 0) {
        hits++
        reciprocalRank += 1 / (rank + 1)
    }
}

const recallAt4 = hits / cases.length
const mrr = reciprocalRank / cases.length
const report = {
    cases: cases.length,
    hits,
    recallAt4: Number(recallAt4.toFixed(4)),
    mrr: Number(mrr.toFixed(4)),
}
console.log(JSON.stringify(report, null, 2))

if (recallAt4 < 0.7 || mrr < 0.5)
    throw new Error(`retrieval regression: Recall@4=${recallAt4.toFixed(3)}, MRR=${mrr.toFixed(3)}`)
