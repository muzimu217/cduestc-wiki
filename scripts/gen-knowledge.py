#!/usr/bin/env python3
import json, re, os, unicodedata

docs_dir = 'docs'
skip_files = {'changelog.md', 'contributing.md'}
knowledge = []

def clean_md(text):
    """清理 markdown 语法，保留纯文本"""
    text = re.sub(r'^---.*?---\s*', '', text, flags=re.DOTALL)
    text = re.sub(r'```[\s\S]*?```', '', text)
    text = re.sub(r'<[^>]+>', '', text)
    text = re.sub(r'!\[.*?\]\(.*?\)', '', text)
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    text = re.sub(r':::.*?\n', '', text)
    text = re.sub(r':::', '', text)
    # 移除 JS/Vue import 语句
    text = re.sub(r'^import\s+.*$', '', text, flags=re.MULTILINE)
    text = re.sub(r'^const\s+\w+\s*=\s*import.*$', '', text, flags=re.MULTILINE)
    # 移除 frontmatter 残留
    text = re.sub(r'^(sidebar|author|layout)\s*:.*$', '', text, flags=re.MULTILINE)
    text = re.sub(r'\*\*([^*]+)\*\*', r'\1', text)
    text = re.sub(r'\*([^*]+)\*', r'\1', text)
    text = re.sub(r'\`([^`]+)\`', r'\1', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()

def get_url(filepath):
    rel = os.path.relpath(filepath, docs_dir)
    url = '/' + rel.replace('.md', '').replace('\\', '/')
    if url.endswith('/index'):
        url = url[:-5]
    return url

def slugify(text):
    """复刻 VitePress 默认 slugify，确保知识库深链和页面锚点一致。"""
    text = re.sub(r'!\[([^\]]*)\]\([^)]*\)', r'\1', text)
    text = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', text)
    text = unicodedata.normalize('NFKD', text)
    text = re.sub(r'[\u0300-\u036f]', '', text)
    text = re.sub(r'[\x00-\x1f]', '', text)
    text = text.strip().lower()
    text = re.sub(r'[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"\'“”‘’<>,.?/]+', '-', text)
    text = re.sub(r'-{2,}', '-', text)
    text = re.sub(r'^-+|-+$', '', text)
    return re.sub(r'^(\d)', r'_\1', text)

def split_by_sections(content, page_title, page_url):
    """按 ## / ### 标题分块，每块带 section 和 anchor"""
    # 提取所有标题及其位置
    heading_pattern = re.compile(r'^(#{1,4})\s+(.+)$', re.MULTILINE)
    masked_content = re.sub(
        r'```[\s\S]*?```',
        lambda match: re.sub(r'[^\n]', ' ', match.group(0)),
        content,
    )
    headings = list(heading_pattern.finditer(masked_content))

    if not headings:
        # 没有子标题，整篇作为一个块
        cleaned = clean_md(content)
        if len(cleaned) > 50:
            return [{'title': page_title, 'section': '', 'content': cleaned, 'url': page_url}]
        return []

    sections = []
    used_anchors = {}
    heading_stack = []
    # 标题前的内容（引言）
    intro_end = headings[0].start()
    intro = content[:intro_end].strip()
    if intro:
        cleaned = clean_md(intro)
        if len(cleaned) > 50:
            sections.append({
                'title': page_title,
                'section': '',
                'content': cleaned,
                'url': page_url
            })

    # 按标题分块
    for i, match in enumerate(headings):
        level = len(match.group(1))  # ## = 2, ### = 3
        heading_text = clean_md(match.group(2).strip())
        base_anchor = slugify(heading_text)
        duplicate_count = used_anchors.get(base_anchor, 0)
        used_anchors[base_anchor] = duplicate_count + 1
        anchor = base_anchor if duplicate_count == 0 else f'{base_anchor}-{duplicate_count}'

        # 块内容：从当前标题到下一个同级或更高级标题
        start = match.end()
        end = headings[i + 1].start() if i + 1 < len(headings) else len(content)
        section_content = content[start:end].strip()

        # 构建层级上下文（如"宿舍 > 成都校区"）
        while heading_stack and heading_stack[-1][0] >= level:
            heading_stack.pop()
        heading_stack.append((level, heading_text))
        section_path = ' > '.join(item[1] for item in heading_stack)

        cleaned = clean_md(section_content)
        if len(cleaned) > 30:
            # 长内容再拆分（每块最多约 1200 字，相邻块带 150 字重叠保上下文）
            if len(cleaned) > 1200:
                overlap = 150
                paragraphs = [p.strip() for p in cleaned.split('\n\n') if p.strip()]
                chunks = []
                cur = ''
                for p in paragraphs:
                    if len(cur) + len(p) > 1200 and cur:
                        chunks.append(cur.strip())
                        cur = (cur[-overlap:] + '\n\n' + p) if len(cur) > overlap else (cur + '\n\n' + p)
                    else:
                        cur = (cur + '\n\n' + p) if cur else p
                if cur.strip():
                    chunks.append(cur.strip())
                for ch in chunks:
                    sections.append({
                        'title': page_title,
                        'section': section_path,
                        'content': ch,
                        'url': f'{page_url}#{anchor}'
                    })
            else:
                sections.append({
                    'title': page_title,
                    'section': section_path,
                    'content': cleaned,
                    'url': f'{page_url}#{anchor}'
                })

    return sections

# 遍历所有 markdown 文件
for root, dirs, files in os.walk(docs_dir):
    for f in sorted(files):
        if not f.endswith('.md') or f in skip_files:
            continue
        path = os.path.join(root, f)
        with open(path, 'r', encoding='utf-8') as fh:
            content = fh.read()

        title_match = re.search(r'^#\s+(.+)', content, re.MULTILINE)
        title = title_match.group(1).strip() if title_match else f.replace('.md', '')
        url = get_url(path)

        sections = split_by_sections(content, title, url)
        knowledge.extend(sections)

output_path = 'docs/public/knowledge.json'
with open(output_path, 'w', encoding='utf-8') as f:
    json.dump(knowledge, f, ensure_ascii=False, indent=2)

print(f'Generated {len(knowledge)} knowledge chunks -> {output_path}')

# 统计
has_section = sum(1 for k in knowledge if k.get('section'))
has_anchor = sum(1 for k in knowledge if '#' in k.get('url', ''))
print(f'  with section: {has_section}, with anchor: {has_anchor}')
