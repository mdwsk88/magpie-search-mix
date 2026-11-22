import { USER_AGENT, VERSION, field } from "./vendors.js"

const MAX_BYTES = 10 * 1024 * 1024
const LATEST_PROTOCOL_VERSION = "2025-11-25"

const invalid = (label, what) => new Error(`Invalid ${label} MCP response: ${what}`)

function failure(status, message, retryAfter) {
  const e = new Error(message)
  e.status = status
  if (retryAfter) e.retryAfter = retryAfter
  return e
}

function words(json, body, status) {
  const word = field(field(json, "error"), "message") ?? field(json, "message") ?? field(json, "error")
  if (typeof word === "string" && word.trim()) return `${status} ${word.trim().slice(0, 200)}`
  const text = String(body ?? "").replace(/\s+/g, " ").trim().slice(0, 200)
  return text ? `${status} ${text}` : `${status}: it turned the search away`
}

function secretsOf(headers) {
  const out = []
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value !== "string" || !value) continue
    const key = name.toLowerCase()
    if (key === "authorization" || key === "x-api-key") out.push(value)
    if (key === "authorization") {
      const token = value.replace(/^Bearer\s+/i, "")
      if (token.length >= 8) out.push(token)
    }
  }
  return out
}

function redact(error, secrets) {
  let message = String(error?.message ?? error)
  for (const secret of secrets) message = message.split(String(secret)).join("[redacted]")
  message = message.slice(0, 300)
  if (error instanceof Error) {
    error.message = message
    return error
  }
  return new Error(message)
}

function headersFor(extra) {
  return {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    ...extra,
  }
}

function discard(res) {
  try {
    const p = res?.body?.cancel?.()
    if (p && typeof p.catch === "function") p.catch(() => {})
  } catch {}
}

async function send(fetchImpl, url, init, signal) {
  let res
  try {
    res = await fetchImpl(url, { ...init, signal, redirect: "manual" })
  } catch (e) {
    if (signal?.aborted) throw new Error("no answer in time")
    throw new Error(`request failed: ${e?.message ?? e}`)
  }
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`${res.status}: it sends the search on to another address, which isn't given its key; set that address instead`)
  }
  if (res.status < 200 || res.status >= 300) {
    const retryAfter = res.headers?.get?.("retry-after") ?? ""
    let body = ""
    try {
      body = await res.text()
    } catch {}
    let json
    try {
      json = JSON.parse(body)
    } catch {}
    throw failure(res.status, words(json, body, res.status), retryAfter)
  }
  return res
}

function matching(message, id, label) {
  if (!message || typeof message !== "object" || Array.isArray(message)) throw invalid(label, "expected a JSON-RPC message")
  if (message.id !== id) return undefined
  if (message.jsonrpc !== "2.0") throw invalid(label, "expected JSON-RPC 2.0")
  if (message.error !== undefined) {
    const detail = field(message.error, "message") ?? message.error
    throw new Error(`${label} MCP error: ${String(detail).slice(0, 200)}`)
  }
  if (!message.result || typeof message.result !== "object" || Array.isArray(message.result)) throw invalid(label, "missing result")
  return message.result
}

function parseJSON(raw, label) {
  try {
    return JSON.parse(raw)
  } catch {
    throw invalid(label, "malformed JSON")
  }
}

async function readEventStream(res, signal, id, label) {
  if (!res.body) throw invalid(label, "missing body")
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let data = []
  let bytes = 0
  const cancel = () => {
    try {
      const p = reader.cancel()
      if (p && typeof p.catch === "function") p.catch(() => {})
    } catch {}
  }
  const onAbort = () => cancel()
  signal?.addEventListener?.("abort", onAbort, { once: true })
  const dispatch = () => {
    const raw = data.join("\n")
    data = []
    if (!raw || raw === "[DONE]") return undefined
    return matching(parseJSON(raw, label), id, label)
  }
  const line = (value) => {
    if (value === "") return dispatch()
    if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""))
    return undefined
  }
  const feed = (text) => {
    let end
    while ((end = text.indexOf("\n")) >= 0) {
      let one = text.slice(0, end)
      text = text.slice(end + 1)
      if (one.endsWith("\r")) one = one.slice(0, -1)
      const result = line(one)
      if (result !== undefined) return { rest: text, result }
    }
    return { rest: text }
  }
  try {
    for (;;) {
      signal?.throwIfAborted?.()
      const { value, done } = await reader.read()
      if (done) break
      bytes += value?.byteLength ?? 0
      if (bytes > MAX_BYTES) throw invalid(label, `payload exceeds ${MAX_BYTES} bytes`)
      buffer += decoder.decode(value, { stream: true })
      const step = feed(buffer)
      buffer = step.rest
      if (step.result !== undefined) return step.result
    }
    buffer += decoder.decode()
    if (buffer) {
      if (buffer.endsWith("\r")) buffer = buffer.slice(0, -1)
      const result = line(buffer)
      if (result !== undefined) return result
      const last = dispatch()
      if (last !== undefined) return last
    }
    throw invalid(label, "no matching response before stream ended")
  } finally {
    signal?.removeEventListener?.("abort", onAbort)
    cancel()
    try {
      reader.releaseLock()
    } catch {}
  }
}

async function readReply(res, signal, id, label) {
  const type = String(res.headers?.get?.("content-type") ?? "").toLowerCase()
  if (type.includes("text/event-stream")) return readEventStream(res, signal, id, label)
  return matching(parseJSON(await res.text(), label), id, label)
}

export async function callMCPTool(endpoint, name, args, options = {}) {
  const { headers = {}, signal, fetchImpl = fetch, label = "search" } = options
  try {
    const res = await send(
      fetchImpl,
      endpoint,
      {
        method: "POST",
        headers: headersFor(headers),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      },
      signal,
    )
    const result = await readReply(res, signal, 1, label)
    if (result.isError === true) throw new Error(`${label} MCP search tool failed`)
    return result
  } catch (e) {
    throw redact(e, secretsOf(headers))
  }
}

export function extractMCPResults(result, label, options = {}) {
  const { arrayKeys = ["results"], maxJSONDepth = 1, decodeStructuredContent = false } = options
  const primary = arrayKeys[0]
  const extract = (value, depth) => {
    let decoded = value
    for (let i = 0; i < depth && typeof decoded === "string"; i++) {
      try {
        decoded = JSON.parse(decoded)
      } catch {
        return undefined
      }
    }
    if (Array.isArray(decoded)) return primary === "results" ? { results: decoded } : undefined
    if (decoded === null || typeof decoded !== "object") return undefined
    for (const key of arrayKeys) {
      if (Array.isArray(decoded[key])) return key === primary ? decoded : { ...decoded, [primary]: decoded[key] }
    }
    return undefined
  }
  const structured = extract(result?.structuredContent, decodeStructuredContent ? maxJSONDepth : 0)
  if (structured) return structured
  for (const part of Array.isArray(result?.content) ? result.content : []) {
    if (part?.type !== "text" || typeof part.text !== "string") continue
    const parsed = extract(part.text, maxJSONDepth)
    if (parsed) return parsed
  }
  throw new Error(`Invalid ${label} MCP search result: expected results array`)
}

export async function callMCPSearch(endpoint, name, args, options = {}) {
  const { label = "search", arrayKeys = ["results"], maxJSONDepth = 1, decodeStructuredContent = false } = options
  const result = await callMCPTool(endpoint, name, args, options)
  return extractMCPResults(result, label, { arrayKeys, maxJSONDepth, decodeStructuredContent })
}

const validSessionID = (value) =>
  typeof value === "string" && value.length > 0 && [...value].every((c) => c.charCodeAt(0) >= 0x21 && c.charCodeAt(0) <= 0x7e)

export async function callSessionMCPTool(options) {
  const { endpoint, headers = {}, toolNames = [], argumentsForSchema, signal, fetchImpl = fetch, label = "search" } = options
  let sessionID
  let protocolVersion
  let requestID = 0
  const head = () => ({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    ...headers,
    ...(sessionID ? { "Mcp-Session-Id": sessionID } : {}),
    ...(protocolVersion ? { "MCP-Protocol-Version": protocolVersion } : {}),
  })
  const request = async (method, params) => {
    const id = ++requestID
    const body = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }
    const res = await send(fetchImpl, endpoint, { method: "POST", headers: head(), body: JSON.stringify(body) }, signal)
    return { res, result: await readReply(res, signal, id, label) }
  }
  const notify = async (method) => {
    const res = await send(fetchImpl, endpoint, { method: "POST", headers: head(), body: JSON.stringify({ jsonrpc: "2.0", method }) }, signal)
    discard(res)
  }
  const secrets = () => {
    const out = [...secretsOf(headers)]
    if (sessionID) out.push(sessionID)
    return out
  }
  try {
    const initializeID = ++requestID
    const res = await send(
      fetchImpl,
      endpoint,
      {
        method: "POST",
        headers: head(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: initializeID,
          method: "initialize",
          params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "magpie-search-mix", version: VERSION } },
        }),
      },
      signal,
    )
    const initialized = await readReply(res, signal, initializeID, label)
    const sid = String(res.headers?.get?.("mcp-session-id") ?? "").trim()
    if (!sid) throw invalid(label, "missing session ID")
    if (!validSessionID(sid)) throw invalid(label, "invalid session ID")
    sessionID = sid
    if (typeof initialized.protocolVersion === "string" && initialized.protocolVersion) protocolVersion = initialized.protocolVersion
    await notify("notifications/initialized")
    const { result: listed } = await request("tools/list", {})
    if (!Array.isArray(listed?.tools)) throw invalid(label, "tools must be an array")
    const tool = toolNames.map((name) => listed.tools.find((entry) => entry?.name === name)).find(Boolean)
    if (!tool) {
      const available = listed.tools
        .map((entry) => (typeof entry?.name === "string" ? entry.name : ""))
        .filter(Boolean)
        .slice(0, 8)
        .join(", ")
      throw new Error(`${label} MCP server did not publish a supported Web Search tool${available ? ` (available: ${available})` : ""}`)
    }
    const schema = tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema) ? tool.inputSchema : {}
    const args = await argumentsForSchema(schema, tool.name)
    const { result } = await request("tools/call", { name: tool.name, arguments: args })
    if (result.isError === true) throw new Error(`${label} MCP search tool failed`)
    return { result, toolName: tool.name, schema, arguments: args }
  } catch (error) {
    throw redact(error, secrets())
  } finally {
    if (sessionID) {
      try {
        const res = await fetchImpl(endpoint, { method: "DELETE", headers: head(), redirect: "manual", signal: AbortSignal.timeout(1000) })
        discard(res)
      } catch {}
    }
  }
}
