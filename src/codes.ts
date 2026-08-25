// Room codes get read aloud, so the alphabet leaves out the pairs people
// mishear or mistype: no O or 0, no I or 1.
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export const makeCode = (length = 5): string => {
	const bytes = new Uint8Array(length)
	crypto.getRandomValues(bytes)
	return Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
}
