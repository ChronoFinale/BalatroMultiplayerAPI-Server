import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../env.js'
import { processAndPublishMessage } from '../../features/chat/chat.service.js'
import type { ModerationAttempt } from '../../features/chat/moderation.js'
import { normalizeForAllowlist } from '../../features/chat/normalization.js'
import { moderateMessage } from '../../features/chat/obscenity.js'
import { db } from '../../infrastructure/db/index.js'
import { callModerationService } from '../../infrastructure/gateways/moderation.gateway.js'
import { mqttService } from '../../infrastructure/mqtt/mqtt.service.js'
import { setConfig } from '../../state/config.js'
import { Lobby } from '../../state/lobby.js'

vi.mock('../../features/chat/obscenity.js', () => ({
	moderateMessage: vi.fn(),
}))

vi.mock('../../infrastructure/gateways/moderation.gateway.js', () => ({
	callModerationService: vi.fn(),
}))

const mockModerateMessage = vi.mocked(moderateMessage)
const mockCallModerationService = vi.mocked(callModerationService)

// env.ts's readonly typing is TS-only (no runtime freeze); tests flip the
// moderation-bridge flag directly rather than threading a test-only param
// through processAndPublishMessage.
const mutableEnv = env as { MODERATION_SERVICE_URL: string }
const originalModerationServiceUrl = env.MODERATION_SERVICE_URL

function makeLobby(): Lobby {
	return new Lobby('ABC123', 'mod1', 'host1')
}

describe('chat.service.processAndPublishMessage', () => {
	beforeEach(() => {
		mockModerateMessage.mockResolvedValue({ allowed: true })
		mutableEnv.MODERATION_SERVICE_URL = ''
	})

	afterEach(() => {
		mutableEnv.MODERATION_SERVICE_URL = originalModerationServiceUrl
	})

	describe('dormant (MODERATION_SERVICE_URL unset, the default)', () => {
		it('runs the legacy local obscenity path unchanged and publishes on allow', async () => {
			const lobby = makeLobby()

			const result = await processAndPublishMessage(
				lobby,
				'p1',
				'Alice',
				'hello there',
			)

			expect(result).toEqual({ ok: true })
			expect(mockModerateMessage).toHaveBeenCalledWith('hello there', 'p1')
			expect(mockCallModerationService).not.toHaveBeenCalled()
			expect(mqttService.publishChatMessage).toHaveBeenCalledWith(
				'ABC123',
				'p1',
				'Alice',
				'hello there',
			)
		})

		it('blocks with reason moderated when the local obscenity filter rejects it', async () => {
			mockModerateMessage.mockResolvedValue({ allowed: false })
			const lobby = makeLobby()

			const result = await processAndPublishMessage(
				lobby,
				'p1',
				'Alice',
				'bad word',
			)

			expect(result).toEqual({ ok: false, reason: 'moderated' })
			expect(mqttService.publishChatMessage).not.toHaveBeenCalled()
		})
	})

	describe('empty / allowlisted messages short-circuit regardless of moderation config', () => {
		it('returns reason empty for a message that normalizes to nothing', async () => {
			const lobby = makeLobby()
			const result = await processAndPublishMessage(lobby, 'p1', 'Alice', '   ')
			expect(result).toEqual({ ok: false, reason: 'empty' })
		})

		it('publishes an allowlisted message without calling either moderation path', async () => {
			const key = normalizeForAllowlist('gg')
			setConfig({
				tosVersion: 0,
				mods: [],
				chatAllowlist: new Set([key as string]),
			})
			const lobby = makeLobby()

			const result = await processAndPublishMessage(lobby, 'p1', 'Alice', 'gg')

			expect(result).toEqual({ ok: true })
			expect(mockModerateMessage).not.toHaveBeenCalled()
			expect(mockCallModerationService).not.toHaveBeenCalled()
			expect(mqttService.publishChatMessage).toHaveBeenCalledWith(
				'ABC123',
				'p1',
				'Alice',
				'gg',
			)
		})
	})

	// The full allow/reject/band decision matrix (moderated, rate_limited via
	// both signals, unavailable, unknown bands, ...) is asserted once, against
	// the pure core, in moderation.test.ts. These tests cover only what's
	// specific to this wiring: which path runs, and what gets published vs.
	// kept in evidence.
	describe('configured (MODERATION_SERVICE_URL set)', () => {
		function mockAttempt(attempt: ModerationAttempt) {
			mockCallModerationService.mockResolvedValue(attempt)
		}

		beforeEach(() => {
			mutableEnv.MODERATION_SERVICE_URL = 'http://moderation.local'
		})

		it('publishes the original text on allow', async () => {
			mockAttempt({ status: 200, body: { verdict: 'allow' } })
			const lobby = makeLobby()

			const result = await processAndPublishMessage(
				lobby,
				'p1',
				'Alice',
				'hello there',
			)

			expect(result).toEqual({ ok: true })
			expect(mockCallModerationService).toHaveBeenCalledWith({
				playerId: 'p1',
				displayName: 'Alice',
				lobbyCode: 'ABC123',
				message: 'hello there',
			})
			expect(mqttService.publishChatMessage).toHaveBeenCalledWith(
				'ABC123',
				'p1',
				'Alice',
				'hello there',
			)
		})

		it('publishes the rewrite from publishText, but keeps the original in the evidence buffer and report DB', async () => {
			mockAttempt({
				status: 200,
				body: { verdict: 'allow', publishText: '**** you' },
			})
			const lobby = makeLobby()
			lobby.isReported = true
			const valuesMock = vi.fn().mockResolvedValue(undefined)
			vi.mocked(db.insert).mockReturnValueOnce({ values: valuesMock } as never)

			const result = await processAndPublishMessage(
				lobby,
				'p1',
				'Alice',
				'fuck you',
			)

			expect(result).toEqual({ ok: true })
			// MQTT gets the rewritten text...
			expect(mqttService.publishChatMessage).toHaveBeenCalledWith(
				'ABC123',
				'p1',
				'Alice',
				'**** you',
			)
			// ...but the in-memory evidence buffer keeps the original typed text
			expect(lobby.messageBuffer.at(-1)?.message).toBe('fuck you')
			// ...and so does the reported-lobby DB row
			expect(valuesMock).toHaveBeenCalledWith(
				expect.objectContaining({ message: 'fuck you' }),
			)
		})

		it('fails closed as unavailable on a transport failure, and never publishes', async () => {
			mockAttempt(null)
			const lobby = makeLobby()

			const result = await processAndPublishMessage(lobby, 'p1', 'Alice', 'hi')

			expect(result).toEqual({ ok: false, reason: 'unavailable' })
			expect(mqttService.publishChatMessage).not.toHaveBeenCalled()
		})

		it('never calls the local obscenity filter once configured', async () => {
			mockAttempt({ status: 200, body: { verdict: 'allow' } })
			const lobby = makeLobby()

			await processAndPublishMessage(lobby, 'p1', 'Alice', 'hi')

			expect(mockModerateMessage).not.toHaveBeenCalled()
		})

		it('allowlisted messages never reach the remote service either', async () => {
			const key = normalizeForAllowlist('gg')
			setConfig({
				tosVersion: 0,
				mods: [],
				chatAllowlist: new Set([key as string]),
			})
			const lobby = makeLobby()

			const result = await processAndPublishMessage(lobby, 'p1', 'Alice', 'gg')

			expect(result).toEqual({ ok: true })
			expect(mockCallModerationService).not.toHaveBeenCalled()
		})
	})
})
