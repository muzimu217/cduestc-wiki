import fs from 'node:fs'
import path from 'node:path'

const distRoot = path.resolve('docs/.vitepress/dist')
const knowledgePath = path.join(distRoot, 'knowledge.json')
for (const requiredFile of ['index.html', 'knowledge.json', 'sitemap.xml', 'robots.txt', 'CNAME']) {
    if (!fs.existsSync(path.join(distRoot, requiredFile)))
        throw new Error(`missing required build artifact: ${requiredFile}`)
}
const entries = JSON.parse(fs.readFileSync(knowledgePath, 'utf8'))

if (!Array.isArray(entries) || entries.length === 0)
    throw new Error('knowledge.json must contain at least one entry')

const pageCache = new Map()

function resolvePage(pageUrl) {
    const normalizedPath = decodeURIComponent(pageUrl || '/').replace(/\/$/, '') || '/'
    const candidates = normalizedPath === '/'
        ? [path.join(distRoot, 'index.html')]
        : [
                path.join(distRoot, `${normalizedPath}.html`),
                path.join(distRoot, normalizedPath, 'index.html'),
            ]

    const pagePath = candidates.find(candidate => fs.existsSync(candidate))
    if (!pagePath)
        throw new Error(`knowledge entry points to missing page: ${pageUrl}`)
    return pagePath
}

function getPageIds(pagePath) {
    if (pageCache.has(pagePath))
        return pageCache.get(pagePath)

    const html = fs.readFileSync(pagePath, 'utf8')
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]))
    pageCache.set(pagePath, ids)
    return ids
}

for (const entry of entries) {
    if (!entry || typeof entry.url !== 'string')
        throw new Error('knowledge entry is missing a URL')

    const [pageUrl, anchor] = entry.url.split('#')
    const pagePath = resolvePage(pageUrl)
    if (anchor && !getPageIds(pagePath).has(decodeURIComponent(anchor)))
        throw new Error(`knowledge entry points to missing anchor: ${entry.url}`)
}

console.log(`[verify-knowledge] verified ${entries.length} entries across ${pageCache.size} pages`)
