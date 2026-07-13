import { describe, expect, it, vi } from 'vitest'
import { processAndPublishMessage } from '../../features/chat/chat.service.js'
import {
	type ModerationClientOptions,
	moderateRemote,
} from '../../features/chat/moderation.client.js'
import { mqttService } from '../../infrastructure/mqtt/mqtt.service.js'
import { setConfig } from '../../state/config.js'
import { Lobby, createSession, lobbies } from '../../state/index.js'

function fetchStub(status: number, body: unknown): typeof fetch {
	return async () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' },
		})
}

function opts(fetchFn: typeof fetch): ModerationClientOptions {
	return { url: 'http://moderation.test', bearerToken: 't', fetchFn }
}

const PAYLOAD = {
	playerId: 'p1',
	displayName: 'Tester',
	lobbyCode: 'ABCD',
	message: 'hello',
}

describe('moderateRemote', () => {
	it('passes through an allow verdict', async () => {
		const r = await moderateRemote(
			PAYLOAD,
			opts(fetchStub(200, { verdict: 'allow', band: 'clean', latency_ms: 5 })),
		)
		expect(r).toMatchObject({
			status: 'verdict',
			verdict: { verdict: 'allow' },
		})
	})

	it('passes through reject verdicts with band details', async () => {
		const r = await moderateRemote(
			PAYLOAD,
			opts(
				fetchStub(200, {
					verdict: 'reject',
					band: 'rate_limited',
					retryAfterMs: 1500,
				}),
			),
		)
		expect(r).toMatchObject({
			status: 'verdict',
			verdict: { band: 'rate_limited', retryAfterMs: 1500 },
		})
	})

	it('maps 429 to shed with retryAfterMs', async () => {
		const r = await moderateRemote(
			PAYLOAD,
			opts(fetchStub(429, { band: 'shed', retryAfterMs: 2000 })),
		)
		expect(r).toMatchObject({ status: 'shed', retryAfterMs: 2000 })
	})

	it('maps 5xx/503/401 to unreachable (fail closed)', async () => {
		for (const status of [500, 503, 401]) {
			const r = await moderateRemote(PAYLOAD, opts(fetchStub(status, {})))
			expect(r).toMatchObject({
				status: 'unreachable',
				cause: `http_${status}`,
			})
		}
	})

	it('maps network errors and timeouts to unreachable', async () => {
		const rejecting: typeof fetch = async () => {
			const err = new Error('timed out')
			err.name = 'TimeoutError'
			throw err
		}
		const r = await moderateRemote(PAYLOAD, opts(rejecting))
		expect(r).toMatchObject({ status: 'unreachable', cause: 'TimeoutError' })
	})

	it('maps malformed bodies to unreachable', async () => {
		const r = await moderateRemote(PAYLOAD, opts(fetchStub(200, { nope: 1 })))
		expect(r).toMatchObject({ status: 'unreachable', cause: 'bad_verdict' })
	})
})

describe('processAndPublishMessage — moderation service branch', () => {
	function setupLobby(code = 'MODB') {
		const lobby = new Lobby(code, 'test_mod', 'host1')
		lobbies.set(code, lobby)
		const session = createSession('Host', {
			id: 'host1',
			tosAcceptedVersion: 1,
			chatEnabled: true,
		})
		lobby.addPlayer(session)
		return lobby
	}

	it('publishes when the service allows', async () => {
		const lobby = setupLobby()
		const r = await processAndPublishMessage(
			lobby,
			'host1',
			'Host',
			'hello there',
			opts(fetchStub(200, { verdict: 'allow', band: 'clean' })),
			'off',
		)
		expect(r.ok).toBe(true)
	})

	it('publishes the rewritten publishText, not the original, on allow', async () => {
		const lobby = setupLobby('MODG')
		vi.mocked(mqttService.publishChatMessage).mockClear()
		const r = await processAndPublishMessage(
			lobby,
			'host1',
			'Host',
			'suck my cock',
			opts(
				fetchStub(200, {
					verdict: 'allow',
					band: 'clean',
					publishText: 'suck my cocktail',
				}),
			),
			'off',
		)
		expect(r.ok).toBe(true)
		// The raw wording never reaches other players — the cocktail form does.
		expect(mqttService.publishChatMessage).toHaveBeenCalledWith(
			'MODG',
			'host1',
			'Host',
			'suck my cocktail',
		)
		// The sender's client is told what was actually delivered.
		expect(r.publishText).toBe('suck my cocktail')
	})

	it('publishes the original when the verdict carries no rewrite', async () => {
		const lobby = setupLobby('MODH')
		vi.mocked(mqttService.publishChatMessage).mockClear()
		const r = await processAndPublishMessage(
			lobby,
			'host1',
			'Host',
			'hello there',
			opts(fetchStub(200, { verdict: 'allow', band: 'clean' })),
			'off',
		)
		expect(mqttService.publishChatMessage).toHaveBeenCalledWith(
			'MODH',
			'host1',
			'Host',
			'hello there',
		)
		// No rewrite → no publishText, so the client shows no correction line.
		expect(r.publishText).toBeUndefined()
	})

	it('maps service rejections to reasons', async () => {
		const lobby = setupLobby('MODC')
		const r = await processAndPublishMessage(
			lobby,
			'host1',
			'Host',
			'bad message',
			opts(fetchStub(200, { verdict: 'reject', band: 'blocklist' })),
			'off',
		)
		expect(r).toMatchObject({ ok: false, reason: 'moderated' })

		const muted = await processAndPublishMessage(
			lobby,
			'host1',
			'Host',
			'hi',
			opts(
				fetchStub(200, {
					verdict: 'reject',
					band: 'muted',
					mutedUntil: '2026-07-04T00:00:00Z',
				}),
			),
			'off',
		)
		expect(muted).toMatchObject({
			ok: false,
			reason: 'muted',
			mutedUntil: '2026-07-04T00:00:00Z',
		})
	})

	it('fails closed on outage with policy=off', async () => {
		const lobby = setupLobby('MODD')
		const r = await processAndPublishMessage(
			lobby,
			'host1',
			'Host',
			'hello',
			opts(fetchStub(503, {})),
			'off',
		)
		expect(r).toMatchObject({ ok: false, reason: 'moderation_unavailable' })
	})

	it('outage with policy=presets allows allowlisted, rejects free text', async () => {
		setConfig({ tosVersion: 0, mods: [], chatAllowlist: new Set(['gg']) })
		const lobby = setupLobby('MODE')
		const down = opts(fetchStub(503, {}))

		const preset = await processAndPublishMessage(
			lobby,
			'host1',
			'Host',
			'GG!',
			down,
			'presets',
		)
		expect(preset.ok).toBe(true)

		const free = await processAndPublishMessage(
			lobby,
			'host1',
			'Host',
			'nice one',
			down,
			'presets',
		)
		expect(free).toMatchObject({ ok: false, reason: 'moderation_unavailable' })
	})

	it('legacy path unchanged when moderation is null', async () => {
		const lobby = setupLobby('MODF')
		const r = await processAndPublishMessage(
			lobby,
			'host1',
			'Host',
			'hello legacy',
			null,
			'off',
		)
		expect(r.ok).toBe(true)
	})
})
