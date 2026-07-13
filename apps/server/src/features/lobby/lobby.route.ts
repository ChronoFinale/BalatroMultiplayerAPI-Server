import { Router } from 'express'
import { authenticate } from '../../middleware/authenticate.js'
import { AppError } from '../../shared/utils/errors.js'
import { getLobby, getSession } from '../../state/index.js'
import { processAndPublishMessage } from '../chat/chat.service.js'
import * as lobbyService from './lobby.service.js'

const router = Router()

router.use(authenticate)

router.post('/', async (req, res, next) => {
	try {
		const { modId, maxPlayers } = req.body
		if (!modId || typeof modId !== 'string') {
			throw new AppError('Missing or invalid modId', 400)
		}

		if (
			maxPlayers !== undefined &&
			(!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 128)
		) {
			throw new AppError('maxPlayers must be an integer between 2 and 128', 400)
		}

		const { lobby, token } = await lobbyService.createLobby(
			req.player!,
			modId,
			maxPlayers,
		)

		res.status(201).json({
			token,
			lobby: {
				code: lobby.code,
				modId: lobby.modId,
				hostId: lobby.hostId,
				maxPlayers: lobby.maxPlayers,
				metadata: lobby.metadata,
				isHost: true,
				players: Array.from(lobby.players.values()).map((p) => ({
					id: p.playerId,
					displayName: p.getDisplayName(),
					preferredJoker: p.preferredJoker,
				})),
			},
		})
	} catch (err) {
		next(err)
	}
})

router.post('/:code/join', async (req, res, next) => {
	try {
		const { code } = req.params
		const { lobby, token } = await lobbyService.joinLobby(req.player!, code)

		res.json({
			token,
			lobby: {
				code: lobby.code,
				modId: lobby.modId,
				hostId: lobby.hostId,
				maxPlayers: lobby.maxPlayers,
				metadata: lobby.metadata,
				isHost: lobby.hostId === req.player!.playerId,
				players: Array.from(lobby.players.values()).map((p) => ({
					id: p.playerId,
					displayName: p.getDisplayName(),
					preferredJoker: p.preferredJoker,
				})),
			},
		})
	} catch (err) {
		next(err)
	}
})

router.post('/:code/leave', async (req, res, next) => {
	try {
		const { code } = req.params
		const { token } = await lobbyService.leaveLobby(req.player!, code)
		res.json({ token })
	} catch (err) {
		next(err)
	}
})

router.get('/:code', async (req, res, next) => {
	try {
		const lobby = lobbyService.getLobbyInfo(req.params.code)

		res.json({
			lobby: {
				code: lobby.code,
				modId: lobby.modId,
				hostId: lobby.hostId,
				maxPlayers: lobby.maxPlayers,
				metadata: lobby.metadata,
				isHost: lobby.hostId === req.player!.playerId,
				players: Array.from(lobby.players.values()).map((p) => ({
					id: p.playerId,
					displayName: p.getDisplayName(),
					preferredJoker: p.preferredJoker,
				})),
			},
		})
	} catch (err) {
		next(err)
	}
})

router.get('/:code/players', async (req, res, next) => {
	try {
		const players = lobbyService.getLobbyPlayers(req.params.code)
		res.json({ players })
	} catch (err) {
		next(err)
	}
})

router.post('/:code/chat', async (req, res, next) => {
	try {
		const { code } = req.params
		const session = getSession(req.player!.playerId)
		if (!session) throw new AppError('Session not found', 401)

		if (!session.chatEnabled || session.chatBlocked) {
			throw new AppError('Chat is not enabled for this account', 403)
		}

		const lobby = getLobby(code)
		if (!lobby) throw new AppError('Lobby not found', 404)
		if (!lobby.hasPlayer(session.playerId))
			throw new AppError('Not a member of this lobby', 403)

		const { message } = req.body
		if (!message || typeof message !== 'string') {
			throw new AppError('Missing or invalid message', 400)
		}
		if (message.length > 500) {
			throw new AppError('Message too long (max 500 characters)', 400)
		}

		const displayName = session.getDisplayName()
		const result = await processAndPublishMessage(
			lobby,
			session.playerId,
			displayName,
			message,
		)

		if (!result.ok) {
			if (result.reason === 'empty')
				throw new AppError('Message cannot be empty', 400)
			if (result.reason === 'moderated')
				throw new AppError('Message was rejected by moderation', 403)
			if (result.reason === 'muted') {
				throw new AppError(
					result.mutedUntil
						? `You are muted until ${result.mutedUntil}`
						: 'You are muted',
					403,
				)
			}
			if (result.reason === 'rate_limited' || result.reason === 'busy') {
				res.setHeader(
					'Retry-After',
					Math.ceil((result.retryAfterMs ?? 1000) / 1000),
				)
				throw new AppError('Slow down and try again shortly', 429)
			}
			if (result.reason === 'moderation_unavailable') {
				throw new AppError('Chat is temporarily unavailable', 503)
			}
			throw new AppError('Failed to send message', 500)
		}

		// publishText is present only when moderation rewrote the message — the
		// sender's client uses it to show what other players actually received.
		res.json({ ok: true, publishText: result.publishText })
	} catch (err) {
		next(err)
	}
})

router.put('/:code/metadata', async (req, res, next) => {
	try {
		const { metadata } = req.body
		if (!metadata || typeof metadata !== 'object') {
			throw new AppError('Missing or invalid metadata object', 400)
		}

		const merged = await lobbyService.setMetadata(
			req.player!,
			req.params.code,
			metadata,
		)

		res.json({ metadata: merged })
	} catch (err) {
		next(err)
	}
})

export default router
