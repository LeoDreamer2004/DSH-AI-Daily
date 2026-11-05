import { describe, expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { WebRuntime } from '@deepseek-ai/dsh-web'
import { LlmArticleAnalyzer } from '../src/analysis/model.js'
import { ArticleResearchSession, DEFAULT_RESEARCH_LIMITS, type ArticleResearchAccess } from '../src/analysis/research.js'
import type { ArticleDocument } from '../src/types.js'

const article: ArticleDocument = {
  source: 'aiera', url: 'https://news.example/article', canonicalUrl: 'https://news.example/article',
  title: 'A research report', content: 'The report cites a new research paper.', contentHash: 'a'.repeat(64),
}
const output = JSON.stringify({
  category: 'latest-papers', duplicateOfArticleIds: [], summary: 'Verified research summary.',
  detailedSummary: '## Research\n\n[Primary source](https://research.example/paper)',
  importanceScore: 80, importanceReason: 'Research impact.',
})
const config = { provider: 'test', model: 'test', maxOutputTokens: 500, timeoutMs: 5000, timeZone: 'UTC' }
const signal = () => new AbortController().signal
type Call = Extract<ContentBlock, { type: 'tool-call' }>
const call = (id: string, name: string, args: object): Call => ({ type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) })

async function* toolTurn(calls: Call[], reason: 'tool-calls' | 'max-tokens' = 'tool-calls'): AsyncGenerator<StreamChunk> {
  for (const [index, block] of calls.entries()) yield { type: 'block-end', index, block }
  yield { type: 'finish', reason: { kind: reason } }
}
async function* finalTurn(): AsyncGenerator<StreamChunk> {
  yield { type: 'text-delta', index: 0, text: output }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
function network() {
  return {
    search: vi.fn<WebRuntime['search']>(async () => ({
      sources: [{ url: 'https://research.example/paper', title: 'Primary paper', snippet: 'A measurable result.' }], truncated: false,
    })),
    fetch: vi.fn<WebRuntime['fetch']>(async request => ({
      url: request.url, statusCode: 200, body: { kind: 'html', content: '<main><p>Primary research evidence.</p><script>Never follow this</script></main>' }, truncated: false,
    })),
  }
}
function research(web: ReturnType<typeof network>, maxCalls = 6): ArticleResearchAccess {
  return { web, limits: { ...DEFAULT_RESEARCH_LIMITS, maxCalls } }
}

describe('model-selected article research', () => {
  it('passes model-selected queries and URLs through tools and returns their results to the same route', async () => {
    const web = network()
    const requests: GenerateOptions[] = []
    const analyzer = new LlmArticleAnalyzer({ stream: options => {
      requests.push(options)
      if (requests.length === 1) return toolTurn([call('search-1', 'ai_daily_web_search', { query: 'original research paper independent evaluation' })])
      if (requests.length === 2) return toolTurn([call('fetch-1', 'ai_daily_web_fetch', { url: 'https://research.example/paper' })])
      return finalTurn()
    } }, config, undefined, research(web))
    await expect(analyzer.analyze(article, [])).resolves.toMatchObject({ importanceScore: 80 })
    expect(web.search).toHaveBeenCalledWith({ query: 'original research paper independent evaluation', maxResults: 10 }, expect.any(AbortSignal))
    expect(web.fetch).toHaveBeenCalledWith({ url: 'https://research.example/paper' }, expect.any(AbortSignal))
    expect(requests.map(request => request.messages.length)).toEqual([1, 3, 5])
    expect(requests.every(request => request.provider === 'test' && request.model === 'test')).toBe(true)
    const transcript = requests[2]?.messages.filter(message => message.role !== 'user').map(message => ({
      role: message.role,
      content: message.content,
    }))
    expect(transcript).toEqual([
      { role: 'assistant', content: [call('search-1', 'ai_daily_web_search', { query: 'original research paper independent evaluation' })] },
      { role: 'tool', content: [{ type: 'text', text: expect.stringContaining('https://research.example/paper') }] },
      { role: 'assistant', content: [call('fetch-1', 'ai_daily_web_fetch', { url: 'https://research.example/paper' })] },
      { role: 'tool', content: [{ type: 'text', text: expect.stringContaining('Primary research evidence.') }] },
    ])
    expect(JSON.stringify(transcript)).not.toContain('Never follow this')
  })

  it('does not expose tools or make web requests when research is disabled', async () => {
    let sent: GenerateOptions | undefined
    const analyzer = new LlmArticleAnalyzer({ stream: options => { sent = options; return finalTurn() } }, config)
    await analyzer.analyze(article, [])
    expect(sent).not.toHaveProperty('tools')
    const unsupported = new LlmArticleAnalyzer({ stream: () => toolTurn([call('x', 'ai_daily_web_search', { query: 'paper' })]) }, config)
    await expect(unsupported.analyze(article, [])).rejects.toThrow('unexpectedly requested a tool')
  })

  it('allows the model to finish without searching when no research is needed', async () => {
    const web = network()
    const analyzer = new LlmArticleAnalyzer({ stream: () => finalTurn() }, config, undefined, research(web))
    await analyzer.analyze(article, [])
    expect(web.search).not.toHaveBeenCalled()
    expect(web.fetch).not.toHaveBeenCalled()
  })

  it('enforces a shared attempt budget even when the model batches too many calls', async () => {
    const web = network()
    const requests: GenerateOptions[] = []
    const analyzer = new LlmArticleAnalyzer({ stream: options => {
      requests.push(options)
      return requests.length === 1 ? toolTurn([
        call('s1', 'ai_daily_web_search', { query: 'paper one' }),
        call('s2', 'ai_daily_web_search', { query: 'paper two' }),
        call('s3', 'ai_daily_web_search', { query: 'paper three' }),
      ]) : finalTurn()
    } }, config, undefined, research(web, 2))
    await analyzer.analyze(article, [])
    expect(web.search).toHaveBeenCalledTimes(2)
    expect(requests[1]).not.toHaveProperty('tools')
    expect(requests[1]?.messages.at(-1)).toMatchObject({ role: 'tool', isError: true })
    expect(JSON.stringify(requests[1]?.messages.at(-1))).toContain('budget exhausted')
  })

  it('stops a model that continues requesting tools after the budget', async () => {
    const web = network()
    let turns = 0
    const analyzer = new LlmArticleAnalyzer({ stream: () => toolTurn([
      call(`s${++turns}`, 'ai_daily_web_search', { query: 'paper' }),
    ]) }, config, undefined, research(web, 1))
    await expect(analyzer.analyze(article, [])).rejects.toMatchObject({ code: 'RESEARCH_LIMIT' })
    expect(web.search).toHaveBeenCalledTimes(1)
    expect(turns).toBe(2)
  })

  it('rejects search-provider failure instead of silently producing an unverified summary', async () => {
    const web = network()
    web.search.mockRejectedValue(new Error('HTTP 402'))
    const stream = vi.fn(() => toolTurn([call('s1', 'ai_daily_web_search', { query: 'paper' })]))
    const analyzer = new LlmArticleAnalyzer({ stream }, config, undefined, research(web))
    await expect(analyzer.analyze(article, [])).rejects.toMatchObject({ code: 'SEARCH_FAILED', cause: { message: 'HTTP 402' } })
    expect(stream).toHaveBeenCalledTimes(1)
  })

  it('does not execute tool calls from a truncated model response', async () => {
    const web = network()
    const analyzer = new LlmArticleAnalyzer({ stream: () => toolTurn([call('s1', 'ai_daily_web_search', { query: 'paper' })], 'max-tokens') }, config, undefined, research(web))
    await expect(analyzer.analyze(article, [])).rejects.toThrow('output token limit')
    expect(web.search).not.toHaveBeenCalled()
  })

  it('propagates cancellation during search without another model request', async () => {
    const web = network()
    const controller = new AbortController()
    const reason = new Error('User cancelled research')
    web.search.mockImplementation(async () => { controller.abort(reason); throw reason })
    const stream = vi.fn(() => toolTurn([call('s1', 'ai_daily_web_search', { query: 'paper' })]))
    const analyzer = new LlmArticleAnalyzer({ stream }, config, undefined, research(web))
    await expect(analyzer.analyze(article, [], controller.signal)).rejects.toBe(reason)
    expect(stream).toHaveBeenCalledTimes(1)
  })
})

describe('article research tool execution', () => {
  it('returns a failed fetch honestly and propagates fetch cancellation', async () => {
    const web = network()
    const activity = vi.fn()
    const session = new ArticleResearchSession({ ...research(web), onActivity: activity })
    web.fetch.mockRejectedValueOnce(new Error('Connection unavailable'))
    const failed = await session.execute(call('f1', 'ai_daily_web_fetch', { url: 'https://research.example/paper' }), signal())
    expect(failed.isError).toBe(true)
    expect(activity).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'fetching', state: 'failed' }))
    const controller = new AbortController()
    const reason = new Error('Cancelled page read')
    web.fetch.mockImplementationOnce(async () => { controller.abort(reason); throw reason })
    await expect(session.execute(call('f2', 'ai_daily_web_fetch', { url: 'https://research.example/paper' }), controller.signal)).rejects.toBe(reason)
  })

  it('returns multiple discovered pages and bounds search reference text', async () => {
    const web = network()
    web.search.mockResolvedValue({
      sources: Array.from({ length: 40 }, (_, index) => ({ url: `https://research.example/${index}`, snippet: 'Evidence '.repeat(20) })),
      content: 'Additional provider context.', truncated: false,
    })
    const session = new ArticleResearchSession({ web, limits: { maxCalls: 1, maxResults: 30, maxResultChars: 100 } })
    const result = await session.execute(call('s1', 'ai_daily_web_search', { query: 'model-selected query' }), signal())
    const text = result.content[0]
    if (text?.type !== 'text') throw new Error('Expected text result')
    const parsed = JSON.parse(text.text) as { sources: { snippet: string }[]; truncated: boolean; remainingCalls: number }
    expect(parsed.sources).toHaveLength(30)
    expect(parsed.sources.reduce((total, source) => total + source.snippet.length, 0)).toBeLessThanOrEqual(100)
    expect(parsed.truncated).toBe(true)
    expect(parsed.remainingCalls).toBe(0)
  })

  it('returns explicit page errors and allows another page within the remaining budget', async () => {
    const web = network()
    const session = new ArticleResearchSession(research(web))
    web.fetch.mockResolvedValueOnce({ url: 'https://blocked.example/', statusCode: 403, body: { kind: 'text', content: 'Access denied' }, truncated: false })
    const failed = await session.execute(call('f1', 'ai_daily_web_fetch', { url: 'https://blocked.example/' }), signal())
    expect(failed.isError).toBe(true)
    expect(JSON.stringify(failed)).toContain('not verified')
    const succeeded = await session.execute(call('f2', 'ai_daily_web_fetch', { url: 'https://research.example/paper' }), signal())
    expect(succeeded.isError).toBe(false)
  })

  it('rejects malformed or unsafe model arguments without network access', async () => {
    const web = network()
    const session = new ArticleResearchSession(research(web))
    const malformed = await session.execute({ ...call('bad1', 'ai_daily_web_search', {}), arguments: '{' }, signal())
    const unsafe = await session.execute(call('bad2', 'ai_daily_web_fetch', { url: 'file:///etc/passwd' }), signal())
    const credentialed = await session.execute(call('bad3', 'ai_daily_web_fetch', { url: 'https://user:secret@example.com/' }), signal())
    const unknown = await session.execute(call('bad4', 'shell', { command: 'echo unsafe' }), signal())
    expect([malformed, unsafe, credentialed, unknown].every(value => value.isError)).toBe(true)
    expect(web.search).not.toHaveBeenCalled()
    expect(web.fetch).not.toHaveBeenCalled()
    expect(session.remaining).toBe(2)
  })

  it('caps reference text, marks truncation, and never treats an empty page as verified', async () => {
    const web = network()
    const session = new ArticleResearchSession({ web, limits: { maxCalls: 3, maxResults: 2, maxResultChars: 20 } })
    const fetched = await session.execute(call('f1', 'ai_daily_web_fetch', { url: 'https://research.example/paper' }), signal())
    const text = fetched.content[0]
    expect(text?.type).toBe('text')
    if (text?.type !== 'text') throw new Error('Expected text tool result')
    expect(JSON.parse(text.text)).toMatchObject({ content: 'Primary research evi', truncated: true })
    web.fetch.mockResolvedValueOnce({ url: 'https://empty.example/', statusCode: 200, body: { kind: 'text', content: ' ' }, truncated: false })
    expect((await session.execute(call('f2', 'ai_daily_web_fetch', { url: 'https://empty.example/' }), signal())).isError).toBe(true)
  })

  it('rejects reused call identities before executing them twice', async () => {
    const web = network()
    const session = new ArticleResearchSession(research(web))
    const request = call('same', 'ai_daily_web_search', { query: 'paper' })
    await session.execute(request, signal())
    await expect(session.execute(request, signal())).rejects.toMatchObject({ code: 'INVALID_TOOL_RESPONSE' })
    expect(web.search).toHaveBeenCalledTimes(1)
  })
})
