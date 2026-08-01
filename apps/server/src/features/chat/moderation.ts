// Pure decision core for the remote moderation bridge. No I/O — the shell
// (infrastructure/gateways/moderation.gateway.ts) performs the HTTP call and
// hands the outcome in as plain data.

export type ModerationAttempt = { status: number; body: unknown } | null

export type ModerationOutcome =
	| { allowed: true; publishText: string | null }
	| { allowed: false; reason: 'moderated' | 'rate_limited' | 'unavailable' }

type ModerationResponseBody = {
	verdict: 'allow' | 'reject'
	band?: string
	publishText?: string
}

function isModerationResponseBody(
	value: unknown,
): value is ModerationResponseBody {
	if (typeof value !== 'object' || value === null) return false
	const record = value as Record<string, unknown>
	if (record.verdict !== 'allow' && record.verdict !== 'reject') return false
	if (record.band !== undefined && typeof record.band !== 'string') return false
	if (
		record.publishText !== undefined &&
		typeof record.publishText !== 'string'
	)
		return false
	return true
}

// Any transport failure, non-200 status, unparseable body, or unrecognised
// verdict shape fails closed as 'unavailable' — never allow on uncertainty.
// That deliberately includes HTTP 429: the service sheds load globally with
// that status, which is a capacity problem, not this player sending too fast.
// Per-player rate limiting arrives as 200 + {verdict:'reject',
// band:'rate_limited'} and is the only thing told to slow down.
// Unknown/future reject bands fail closed as the generic 'moderated' block.
export function decideModerationOutcome(
	attempt: ModerationAttempt,
): ModerationOutcome {
	if (
		attempt === null ||
		attempt.status !== 200 ||
		!isModerationResponseBody(attempt.body)
	) {
		return { allowed: false, reason: 'unavailable' }
	}

	const { verdict, band, publishText } = attempt.body

	if (verdict === 'allow') {
		return { allowed: true, publishText: publishText || null }
	}

	// guard_unavailable is the service rejecting because its own model was
	// unavailable, not because the message was bad — the player must not be
	// told they broke a rule.
	if (band === 'rate_limited') return { allowed: false, reason: 'rate_limited' }
	if (band === 'guard_unavailable')
		return { allowed: false, reason: 'unavailable' }
	return { allowed: false, reason: 'moderated' }
}
