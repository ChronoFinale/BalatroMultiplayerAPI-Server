import {
	RegExpMatcher,
	englishDataset,
	englishRecommendedTransformers,
} from 'obscenity'
import {
	insertFlaggedMessage,
	insertReportedLobbyMessage,
} from '../../infrastructure/gateways/chat.gateway.js'
import { mqttService } from '../../infrastructure/mqtt/mqtt.service.js'
import { getConfig } from '../../state/config.js'
import type { Lobby } from '../../state/lobby.js'
import {
	type ModerationClientOptions,
	type OutagePolicy,
	moderateRemote,
	moderationConfigFromEnv,
	outagePolicyFromEnv,
} from './moderation.client.js'

// --- Message normalization (for allowlist lookup only) ---
// The original message is always what gets published and logged.

/**
 * Normalizes a message string for allowlist comparison.
 *
 * Rules:
 * 1. trim()
 * 2. If empty after trim → return null (drop whitespace-only messages)
 * 3. toLowerCase()
 * 4. If the result consists entirely of '.', '!', '?' characters → return as-is
 *    (preserves entries like "?", "!", "...")
 * 5. If the last character is '.', '!', or '?' → remove it
 * 6. Return result
 */
export function normalizeForAllowlist(message: string): string | null {
	const trimmed = message.trim()
	if (trimmed === '') return null

	const lower = trimmed.toLowerCase()

	// Pure-punctuation messages: don't strip trailing character
	if (/^[.!?]+$/.test(lower)) return lower

	// Strip a single trailing punctuation mark
	if (lower.endsWith('.') || lower.endsWith('!') || lower.endsWith('?')) {
		return lower.slice(0, -1)
	}

	return lower
}

function isAllowlisted(message: string): boolean {
	const key = normalizeForAllowlist(message)
	if (key === null) return false
	return getConfig().chatAllowlist.has(key)
}

// --- Obscenity matcher ---

const matcher = new RegExpMatcher({
	...englishDataset.build(),
	...englishRecommendedTransformers,
})

type MatchRecord = {
	word: string
	startIndex: number
	endIndex: number
}

async function moderateMessage(
	message: string,
	playerId: string,
): Promise<{ allowed: boolean }> {
	const raw = matcher.getAllMatches(message)
	if (raw.length === 0) return { allowed: true }

	const matches: MatchRecord[] = raw.map((m) => ({
		word:
			englishDataset.getPayloadWithPhraseMetadata(m).phraseMetadata
				?.originalWord ?? '',
		startIndex: m.startIndex,
		endIndex: m.endIndex,
	}))

	await insertFlaggedMessage(playerId, message, matches)

	return { allowed: false }
}

// --- Main export ---

export type ChatResult = {
	ok: boolean
	reason?: string
	retryAfterMs?: number
	mutedUntil?: string
	// Set only when moderation rewrote the message: the text other players
	// actually received. Lets the sender's client show what was delivered.
	publishText?: string
}

export async function processAndPublishMessage(
	lobby: Lobby,
	playerId: string,
	displayName: string,
	message: string,
	// Injectable for tests; production reads env. null = legacy local pipeline.
	moderation: ModerationClientOptions | null = moderationConfigFromEnv(),
	outagePolicy: OutagePolicy = outagePolicyFromEnv(),
): Promise<ChatResult> {
	// Reject whitespace-only messages
	const normalized = normalizeForAllowlist(message)
	if (normalized === null) {
		return { ok: false, reason: 'empty' }
	}

	// What actually gets published. Defaults to the original; the moderation
	// service may return a rewritten form (publishText) that we publish instead
	// so the raw wording never reaches other players.
	let publishMessage = message

	if (moderation) {
		// Moderation service path (ADR-1): the service runs every content tier
		// (allowlist, blocklist, PII, ML, mutes, rate limit); we publish on allow.
		const result = await moderateRemote(
			{ playerId, displayName, lobbyCode: lobby.code, message },
			moderation,
		)

		if (result.status === 'unreachable') {
			// Fail closed (ADR-3). 'presets' outage policy still allows the
			// curated allowlist — safe by construction, moderation not needed.
			if (outagePolicy === 'presets' && isAllowlisted(message)) {
				// fall through to publish below
			} else {
				return { ok: false, reason: 'moderation_unavailable' }
			}
		} else if (result.status === 'shed') {
			return { ok: false, reason: 'busy', retryAfterMs: result.retryAfterMs }
		} else if (result.verdict.verdict === 'reject') {
			const v = result.verdict
			if (v.band === 'muted') {
				return { ok: false, reason: 'muted', mutedUntil: v.mutedUntil }
			}
			if (v.band === 'rate_limited') {
				return {
					ok: false,
					reason: 'rate_limited',
					retryAfterMs: v.retryAfterMs,
				}
			}
			return { ok: false, reason: 'moderated' }
		}
		// Allowed. Honor any rewrite the service applied (publishText); on the
		// fail-closed presets fall-through result.status is 'unreachable', so
		// the original stands.
		if (result.status === 'verdict' && result.verdict.publishText) {
			publishMessage = result.verdict.publishText
		}
	} else if (!isAllowlisted(message)) {
		// Legacy local pipeline (no moderation service configured).
		const result = await moderateMessage(message, playerId)
		if (!result.allowed) {
			return { ok: false, reason: 'moderated' }
		}
	}

	// Publish the moderated message (rewritten form if the service produced one,
	// else the user's original casing/punctuation) via system MQTT client.
	await mqttService.publishChatMessage(
		lobby.code,
		playerId,
		displayName,
		publishMessage,
	)

	const sentAt = new Date()
	lobby.bufferMessage({
		playerId,
		displayName,
		message: publishMessage,
		sentAt,
	})

	// If this lobby is under an active report, persist the message immediately
	if (lobby.isReported) {
		await insertReportedLobbyMessage({
			lobbyId: lobby.id,
			lobbyCode: lobby.code,
			playerId,
			displayName,
			message: publishMessage,
			sentAt,
		})
	}

	return {
		ok: true,
		publishText: publishMessage !== message ? publishMessage : undefined,
	}
}
