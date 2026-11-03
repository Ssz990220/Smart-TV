// An explicit opt-in for the C5's installed decoder extension. This only
// describes which original streams Moonfin may deliver to the TV decoder.
export const canRequestLocalSurround = (caps, preferences, container = '') =>
	caps.webosVersion >= 25 && preferences.webosLocalSurround === true &&
	container.split(',').some(value => ['mkv', 'matroska'].includes(value.trim().toLowerCase()));

export const LOCAL_SURROUND_CODECS = ['dts', 'dca', 'dts-hd', 'dtshd', 'truehd', 'mlp'];
