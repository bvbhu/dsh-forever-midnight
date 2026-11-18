/**
 * forever-midnight
 *
 * Rewrites the durable `time-context` reading that the built-in
 * @deepseek-ai/dsh-time-context plugin appends during `agent/pre-step`, so the
 * timestamp lands in a configurable deep-night hour.
 *
 * The remap keeps the sampled absolute instant intact and merely displays it in
 * a real fixed-offset IANA zone (Etc/GMT±N) where the local hour is the target.
 * The offset, zone label and wall-clock time stay mutually consistent:
 * `03:00:02-12:00[Etc/GMT+12]` is the same instant as
 * `23:00:02+08:00[Asia/Shanghai]`. The system clock, session event times,
 * browser zone guidance and every other message are untouched.
 */

export const name = 'forever-midnight'

/** No service dependency: the rewrite hooks the agent lifecycle only. */
export const inject = []

/** Only the exact fixed-offset timestamp shape emitted by dsh-time-context. */
const TS_RE = /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-])(\d{2}):(\d{2})\[([^\]]+)\]/

const formatters = new Map()

function formatterFor(zone) {
  let formatter = formatters.get(zone)
  if (formatter) return formatter
  formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    hour12: false,
    timeZoneName: 'longOffset',
  })
  formatters.set(zone, formatter)
  return formatter
}

function formatTimestamp(ms, formatter, zone) {
  const parts = Object.fromEntries(
    formatter.formatToParts(ms).map((part) => [part.type, part.value]),
  )
  const offset = parts.timeZoneName.replace(/^GMT$/, 'GMT+00:00').slice(3)
  return `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}:${parts['second']}${offset}[${zone}]`
}

/**
 * Map one time-context reading to a deep-night reading of the same instant.
 * Returns null when the text holds no recognised time-context timestamp.
 */
function remapText(text, targetHour) {
  if (typeof text !== 'string') return null
  const match = TS_RE.exec(text)
  if (!match) return null

  const [, Y, M, D, H, Mi, S, sign, offH, offM] = match
  const localAsUtc = Date.UTC(+Y, +M - 1, +D, +H, +Mi, +S)
  const sourceOffsetMs = (sign === '+' ? 1 : -1) * (+offH * 3600 + +offM * 60) * 1000
  const instant = localAsUtc - sourceOffsetMs
  const utcHour = new Date(instant).getUTCHours()

  // Choose a fixed offset whose wall-clock hour equals the target for `instant`.
  // IANA Etc/GMT signs are POSIX (inverted): Etc/GMT-N is UTC+N.
  let offsetHours = ((targetHour - utcHour) % 24 + 24) % 24
  if (offsetHours > 14) offsetHours -= 24

  let zone
  if (offsetHours === 0) zone = 'Etc/GMT'
  else if (offsetHours > 0) zone = `Etc/GMT-${offsetHours}`
  else zone = `Etc/GMT+${-offsetHours}`

  let newTimestamp
  try {
    newTimestamp = formatTimestamp(instant, formatterFor(zone), zone)
  } catch {
    return null
  }

  return text.replace(match[0], newTimestamp)
}

function resolveConfig(config = {}) {
  const targetHour = config.targetHour ?? 3
  if (!Number.isInteger(targetHour) || targetHour < 0 || targetHour > 23) {
    throw new TypeError(`forever-midnight: targetHour must be an integer 0-23, got ${String(targetHour)}`)
  }
  return { targetHour }
}

export function apply(ctx, config) {
  const { targetHour } = resolveConfig(config)

  const makeHandler = () => async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || payload.signal?.aborted) return decision

    let changed = false
    const messages = decision.messages.map((message) => {
      if (!message || message.role !== 'user' || !message.source || message.source.kind !== 'time-context') {
        return message
      }

      let newText = null
      let replaced = false
      const blocks = Array.isArray(message.content) ? message.content : []
      const nextBlocks = blocks.map((block) => {
        if (!replaced && block && block.type === 'text') {
          const candidate = remapText(block.text, targetHour)
          if (candidate !== null && candidate !== block.text) {
            newText = candidate
            replaced = true
            return { ...block, text: candidate }
          }
        }
        return block
      })
      if (newText === null) return message
      changed = true

      const sections = Array.isArray(message.source.sections)
        ? message.source.sections.map((section) =>
            section && section.name === 'time-context' ? { ...section, text: newText } : section,
          )
        : message.source.sections

      return {
        ...message,
        content: nextBlocks,
        source: { ...message.source, sections },
      }
    })

    return changed ? { ...decision, messages } : decision
  }

  // The rewrite must be the OUTERMOST pre-step listener so it observes the
  // decision after the built-in time-context plugin has appended its message.
  // Register inside `agent/created`, which fires after preset plugins (including
  // time-context) have been mounted on `agent.ctx`; `prepend` then unshifts us
  // ahead of them. Registrations on agent.ctx die with the agent; keep a second
  // map owned by this plugin so unloading also tears them down immediately.
  const owned = new Map()

  ctx.effect(() => {
    ctx.on('agent/created', ({ agent }) => {
      if (owned.has(agent)) return
      const dispose = agent.ctx.on('agent/pre-step', makeHandler(), { prepend: true })
      owned.set(agent, dispose)
    })

    ctx.on('agent/disposed', ({ agent }) => {
      const dispose = owned.get(agent)
      if (dispose) {
        try { dispose() } catch { /* scope may already be gone */ }
        owned.delete(agent)
      }
    })

    return () => {
      for (const dispose of owned.values()) {
        try { dispose() } catch { /* best effort on unload */ }
      }
      owned.clear()
    }
  })
}
