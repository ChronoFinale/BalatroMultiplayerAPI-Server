import { db } from '../db/index.js'
import { flaggedMessages } from '../db/schema.js'

type MatchRecord = {
	word: string
	startIndex: number
	endIndex: number
}

export async function insertFlaggedMessage(
	playerId: string,
	message: string,
	matches: MatchRecord[],
): Promise<void> {
	const threeMonths = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
	await db.insert(flaggedMessages).values({
		playerId,
		message,
		matches,
		expiresAt: threeMonths,
	})
}
