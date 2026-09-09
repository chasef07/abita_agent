# Packaged greetings

The opening uses a Rime-generated WAV through LiveKit `session.say(text, { audio })`.
All later speech is synthesized live. Greeting timing and interruption policy are
unchanged; packaging does not establish a fix for SIP dropouts or interruptions.

Generate with Node 22 and `RIME_API_KEY` in the environment or `.env.local`:

```sh
pnpm greetings:generate
```

The script uses the same WebSocket model, voice, language, and sample rate as live
speech. Files are keyed by greeting text and TTS options; identical combinations
share an asset. A profile/config change requires regeneration. Listen to each new
clip before shipping, include its WAV in the change, and remove obsolete WAVs.
The normal Docker build includes this directory without a synthesis request.

`src/__tests__/greeting-audio.test.ts` checks asset availability for every office,
decoding without lost samples, and greeting playback/transcript without TTS.
Text simulations keep the greeting text without loading audio.

Playback reads only the generator's fixed mono PCM WAV format and uses LiveKit
audio frames directly. The LiveKit 1.8 FFmpeg file helper dropped 1,024 samples
from each generated file in the exact-sample regression check.

Reference: [LiveKit audio customization](https://docs.livekit.io/agents/multimodality/audio/customization/).
