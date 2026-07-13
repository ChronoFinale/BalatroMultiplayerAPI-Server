// HTTP client for the moderation service (apps/moderation). The relay stays
// the edge authority (auth, membership, age gate); the service owns content
// decisions. Fail-closed per ADR-3: any transport/protocol failure is reported
// as `unreachable` and the caller applies the outage policy — free-form chat
// never proceeds unmoderated.

export type ModerationVerdict = {
	verdict: 'allow' | 'reject'
	band: string
	reason?: string
	retryAfterMs?: number
	mutedUntil?: string
	// Present when the service rewrote the message (e.g. "cock" -> "cocktail").
	// On allow, the relay publishes THIS instead of the original so the raw
	// form never reaches other players.
	publishText?: string
}

export type ModerationResult =
	| { status: 'verdict'; verdict: ModerationVerdict }
	| { status: 'shed'; retryAfterMs: number }
	| { status: 'unreachable'; cause: string }

export type ModerationClientOptions = {
	url: string
	bearerToken?: string
	timeoutMs?: number
	fetchFn?: typeof fetch
}

export function moderationConfigFromEnv(): ModerationClientOptions | null {
	const url = process.env.MODERATION_SERVICE_URL
	if (!url) return null
	return {
		url,
		bearerToken: process.env.MODERATION_BEARER_TOKEN,
		timeoutMs: Number(process.env.MODERATION_TIMEOUT_MS ?? '1500'),
	}
}

export type OutagePolicy = 'off' | 'presets'

export function outagePolicyFromEnv(): OutagePolicy {
	return process.env.MODERATION_OUTAGE_POLICY === 'presets' ? 'presets' : 'off'
}

export async function moderateRemote(
	payload: {
		playerId: string
		displayName: string
		lobbyCode: string
		message: string
	},
	opts: ModerationClientOptions,
): Promise<ModerationResult> {
	const fetchFn = opts.fetchFn ?? fetch
	const timeoutMs = opts.timeoutMs ?? 1500

	let response: Response
	try {
		response = await fetchFn(`${opts.url}/moderate`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(opts.bearerToken
					? { authorization: `Bearer ${opts.bearerToken}` }
					: {}),
			},
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(timeoutMs),
		})
	} catch (err) {
		return {
			status: 'unreachable',
			cause: err instanceof Error ? err.name : 'fetch_error',
		}
	}

	if (response.status === 429) {
		let retryAfterMs = 1000
		try {
			const body = (await response.json()) as { retryAfterMs?: number }
			if (typeof body.retryAfterMs === 'number')
				retryAfterMs = body.retryAfterMs
		} catch {
			// keep default
		}
		return { status: 'shed', retryAfterMs }
	}

	if (!response.ok) {
		// 503 model-not-loaded, 401 misconfig, 5xx — all fail closed.
		return { status: 'unreachable', cause: `http_${response.status}` }
	}

	try {
		const body = (await response.json()) as ModerationVerdict
		if (body.verdict !== 'allow' && body.verdict !== 'reject') {
			return { status: 'unreachable', cause: 'bad_verdict' }
		}
		return { status: 'verdict', verdict: body }
	} catch {
		return { status: 'unreachable', cause: 'bad_json' }
	}
}
