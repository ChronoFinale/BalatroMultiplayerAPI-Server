import { env } from '../../env.js'
import { insertReportedLobbyMessage } from '../../infrastructure/gateways/chat.gateway.js'
import { callModerationService } from '../../infrastructure/gateways/moderation.gateway.js'
import { mqttService } from '../../infrastructure/mqtt/mqtt.service.js'
import { getConfig } from '../../state/config.js'
import type { Lobby } from '../../state/lobby.js'
import { decideModerationOutcome } from './moderation.js'
import { normalizeForAllowlist } from './normalization.js'
import { moderateMessage } from './obscenity.js'

function isAllowlisted(message: string): boolean {
	const key = normalizeForAllowlist(message)
	if (key === null) return false
	return getConfig().chatAllowlist.has(key)
}

export async function processAndPublishMessage(
	lobby: Lobby,
	playerId: string,
	displayName: string,
	message: string,
): Promise<{ ok: boolean; reason?: string; publishText?: string }> {
	const normalized = normalizeForAllowlist(message)
	if (normalized === null) {
		return { ok: false, reason: 'empty' }
	}

	// textToPublish may be rewritten by the moderation service; message (the
	// original typed text) always goes to the evidence buffer/report DB — a
	// rewrite must never launder what the player actually typed.
	let textToPublish = message

	if (!isAllowlisted(message)) {
		// Dormant when MODERATION_SERVICE_URL is unset — chat keeps using the
		// local obscenity filter, unchanged. A plain property read on the
		// already-parsed env object, so re-reading it per message costs nothing.
		if (env.MODERATION_SERVICE_URL) {
			const attempt = await callModerationService({
				playerId,
				displayName,
				lobbyCode: lobby.code,
				message,
			})
			const outcome = decideModerationOutcome(attempt)
			if (!outcome.allowed) {
				return { ok: false, reason: outcome.reason }
			}
			textToPublish = outcome.publishText ?? message
		} else {
			const result = await moderateMessage(message, playerId)
			if (!result.allowed) {
				return { ok: false, reason: 'moderated' }
			}
		}
	}

	await mqttService.publishChatMessage(
		lobby.code,
		playerId,
		displayName,
		textToPublish,
	)

	const sentAt = new Date()
	lobby.bufferMessage({ playerId, displayName, message, sentAt })

	if (lobby.isReported) {
		await insertReportedLobbyMessage({
			lobbyId: lobby.id,
			lobbyCode: lobby.code,
			playerId,
			displayName,
			message,
			sentAt,
		})
	}

	// Only when a rewrite happened: the sender's client shows what other
	// players actually received, so a rewrite is never silent.
	if (textToPublish !== message) {
		return { ok: true, publishText: textToPublish }
	}
	return { ok: true }
}
