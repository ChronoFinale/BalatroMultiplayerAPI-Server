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

// --- Player intake: report / appeal / mute-signal / held ---
// These feed the moderation service's review queue. Unlike /moderate they are
// NOT on the chat hot path — a failure never blocks gameplay; the caller
// decides whether to surface it (a report is worth retrying; a mute signal is
// best-effort). The mute ACTION itself is client-side; only the signal ships.

export type IntakeResult<T> =
	| { ok: true; data: T }
	| { ok: false; cause: string }

async function postIntake<T>(
	path: string,
	payload: unknown,
	opts: ModerationClientOptions,
): Promise<IntakeResult<T>> {
	const fetchFn = opts.fetchFn ?? fetch
	const timeoutMs = opts.timeoutMs ?? 1500
	let response: Response
	try {
		response = await fetchFn(`${opts.url}${path}`, {
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
		return { ok: false, cause: err instanceof Error ? err.name : 'fetch_error' }
	}
	if (!response.ok) return { ok: false, cause: `http_${response.status}` }
	try {
		return { ok: true, data: (await response.json()) as T }
	} catch {
		return { ok: false, cause: 'bad_json' }
	}
}

export function reportRemote(
	payload: {
		reporterId: string
		reportedPlayerId: string
		lobbyCode?: string
		message: string
		reason?: string
	},
	opts: ModerationClientOptions,
): Promise<IntakeResult<{ reportId: string }>> {
	return postIntake('/report', payload, opts)
}

export function appealRemote(
	payload: {
		playerId: string
		lobbyCode?: string
		message: string
		originalBand?: string
	},
	opts: ModerationClientOptions,
): Promise<IntakeResult<{ appealId: string }>> {
	return postIntake('/appeal', payload, opts)
}

export function muteSignalRemote(
	payload: { muterId: string; mutedPlayerId: string; lobbyCode?: string },
	opts: ModerationClientOptions,
): Promise<IntakeResult<{ distinctMuters: number; flagged: boolean }>> {
	return postIntake('/signal/mute', payload, opts)
}

export async function listHeldRemote(
	payload: { playerId: string; lobbyCode?: string },
	opts: ModerationClientOptions,
): Promise<
	IntakeResult<{
		held: Array<{ message: string; band: string | null; createdAt: number }>
	}>
> {
	const fetchFn = opts.fetchFn ?? fetch
	const params = new URLSearchParams({ playerId: payload.playerId })
	if (payload.lobbyCode) params.set('lobbyCode', payload.lobbyCode)
	let response: Response
	try {
		response = await fetchFn(`${opts.url}/held?${params.toString()}`, {
			headers: opts.bearerToken
				? { authorization: `Bearer ${opts.bearerToken}` }
				: {},
			signal: AbortSignal.timeout(opts.timeoutMs ?? 1500),
		})
	} catch (err) {
		return { ok: false, cause: err instanceof Error ? err.name : 'fetch_error' }
	}
	if (!response.ok) return { ok: false, cause: `http_${response.status}` }
	try {
		return { ok: true, data: (await response.json()) as { held: [] } }
	} catch {
		return { ok: false, cause: 'bad_json' }
	}
}
