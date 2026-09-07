# Changelog

## [4.17.0](https://github.com/chasef07/abita_agent/compare/4.16.0...4.17.0) (2026-09-07)


### Features

* **llm:** use Gemma with DeepSeek fallback through LiveKit ([#417](https://github.com/chasef07/abita_agent/issues/417)) ([421beb7](https://github.com/chasef07/abita_agent/commit/421beb73f7cf6a20c96ffb66f9d9068c800692ba))


### Bug Fixes

* **knowledge:** add NMB Labor Day closure ([#418](https://github.com/chasef07/abita_agent/issues/418)) ([5272b72](https://github.com/chasef07/abita_agent/commit/5272b72a4a483e84beb97c9315f040ba3bdc52ad))
* **knowledge:** add North Miami Beach store hours ([#415](https://github.com/chasef07/abita_agent/issues/415)) ([23dc06c](https://github.com/chasef07/abita_agent/commit/23dc06c789fa68e348d9801966a2909c7e1fae79))

## [4.16.0](https://github.com/chasef07/abita_agent/compare/4.15.0...4.16.0) (2026-09-06)


### Features

* **audio:** enable Krisp VIVA telephony voice isolation ([#413](https://github.com/chasef07/abita_agent/issues/413)) ([2ea7ca7](https://github.com/chasef07/abita_agent/commit/2ea7ca7413793b5b5e760efeb683b71d19c2372e))


### Bug Fixes

* **identity:** resolve fuzzy first-name phone matches ([#412](https://github.com/chasef07/abita_agent/issues/412)) ([e44bbfd](https://github.com/chasef07/abita_agent/commit/e44bbfdda28859ec0c0ee1038a99dd6119005eb8))

## [4.15.0](https://github.com/chasef07/abita_agent/compare/4.14.1...4.15.0) (2026-09-06)


### Features

* **agent:** use Baseten GLM primary and Luz for Hollywood ([#407](https://github.com/chasef07/abita_agent/issues/407)) ([6a7b229](https://github.com/chasef07/abita_agent/commit/6a7b2294a5bdcec230ca4fba0d6c4ce575dd2d8a))


### Bug Fixes

* **identity:** ask for first name before resolving phone matches ([#406](https://github.com/chasef07/abita_agent/issues/406)) ([d404fb2](https://github.com/chasef07/abita_agent/commit/d404fb2672790554250c533ebf6f4835b82a92ce))

## [4.14.1](https://github.com/chasef07/abita_agent/compare/4.14.0...4.14.1) (2026-09-06)


### Bug Fixes

* **identity:** resolve phone matches through one patient tool ([#401](https://github.com/chasef07/abita_agent/issues/401)) ([711817f](https://github.com/chasef07/abita_agent/commit/711817fefaca5d325ea76f6d6b6235dd644680e7))
* **prompts:** make receptionist concise and proactive ([91c7f0d](https://github.com/chasef07/abita_agent/commit/91c7f0dec1a4de76353cbe32495a9f8caf7fe11d))

## [4.14.0](https://github.com/chasef07/abita_agent/compare/4.13.6...4.14.0) (2026-09-06)


### Features

* **scheduling:** share appointment inventory across booking and rescheduling ([#399](https://github.com/chasef07/abita_agent/issues/399)) ([a67cce2](https://github.com/chasef07/abita_agent/commit/a67cce28f378ff173c9a0a89db536aba000b6004))


### Bug Fixes

* **knowledge:** recognize BrightView identity questions at NMB ([#398](https://github.com/chasef07/abita_agent/issues/398)) ([24e6550](https://github.com/chasef07/abita_agent/commit/24e65506d4b11894751890d306a15805e3f97f22))


### Performance Improvements

* enable preemptive generation with current turn context ([#395](https://github.com/chasef07/abita_agent/issues/395)) ([d286d54](https://github.com/chasef07/abita_agent/commit/d286d54db4ad46656b1a6e2bc087386bba744417))
* remove sentence buffering from speech guard ([#396](https://github.com/chasef07/abita_agent/issues/396)) ([615cd5f](https://github.com/chasef07/abita_agent/commit/615cd5f76c29bf6c46009bcbfc41f82869d6b236))

## [4.13.6](https://github.com/chasef07/abita_agent/compare/4.13.5...4.13.6) (2026-09-04)


### Bug Fixes

* update Spring Hill Humana insurance list ([#388](https://github.com/chasef07/abita_agent/issues/388)) ([a014a2a](https://github.com/chasef07/abita_agent/commit/a014a2a66455d2c12769fdbde4de63bc25298942))

## [4.13.5](https://github.com/chasef07/abita_agent/compare/4.13.4...4.13.5) (2026-09-04)


### Bug Fixes

* **turns:** recover from missing user transcriptions ([#390](https://github.com/chasef07/abita_agent/issues/390)) ([8eea3c1](https://github.com/chasef07/abita_agent/commit/8eea3c10cd09f0cfcad6696cc1eccbdc6630b573))

## [4.13.4](https://github.com/chasef07/abita_agent/compare/4.13.3...4.13.4) (2026-08-28)


### Bug Fixes

* **closeout:** stabilize Product call lifecycle ([#386](https://github.com/chasef07/abita_agent/issues/386)) ([3a660d4](https://github.com/chasef07/abita_agent/commit/3a660d42ac30a44498964aa8a5954b1e04385507))

## [4.13.3](https://github.com/chasef07/abita_agent/compare/4.13.2...4.13.3) (2026-08-27)


### Bug Fixes

* **prompt:** batch related booking details ([#384](https://github.com/chasef07/abita_agent/issues/384)) ([28d2231](https://github.com/chasef07/abita_agent/commit/28d223166ed7829145f8bb03eb153a67b6337982))

## [4.13.2](https://github.com/chasef07/abita_agent/compare/4.13.1...4.13.2) (2026-08-27)


### Miscellaneous Chores

* release 4.13.2 ([41e61b3](https://github.com/chasef07/abita_agent/commit/41e61b333e8f7dfa593b0b688dd7d45146193ab6))

## [4.13.1](https://github.com/chasef07/abita_agent/compare/4.13.0...4.13.1) (2026-08-26)


### Bug Fixes

* **tools:** enforce strict concise model contracts ([5d503ea](https://github.com/chasef07/abita_agent/commit/5d503ea30ddbeb7286013eda24cd4a19dfde03ae))

## [4.13.0](https://github.com/chasef07/abita_agent/compare/4.12.0...4.13.0) (2026-08-24)


### Features

* enable strict tool schemas ([#373](https://github.com/chasef07/abita_agent/issues/373)) ([95fa14b](https://github.com/chasef07/abita_agent/commit/95fa14b8bf0eec3712d1dae560c11c3b2bfd3023))


### Bug Fixes

* keep office tool catalog stable during calls ([#371](https://github.com/chasef07/abita_agent/issues/371)) ([a4c925d](https://github.com/chasef07/abita_agent/commit/a4c925d5505021499555538aaefb74f2a2959d99))

## [4.12.0](https://github.com/chasef07/abita_agent/compare/4.11.0...4.12.0) (2026-08-22)


### Features

* route specialty demos to Acuity Product ([#367](https://github.com/chasef07/abita_agent/issues/367)) ([975244c](https://github.com/chasef07/abita_agent/commit/975244c5f1a58f9b1c0d7e8eda88490263ca2c16))

## [4.11.0](https://github.com/chasef07/abita_agent/compare/4.10.2...4.11.0) (2026-08-22)


### Features

* **demo:** configure specialty demo phone profiles ([#364](https://github.com/chasef07/abita_agent/issues/364)) ([b4f3b4a](https://github.com/chasef07/abita_agent/commit/b4f3b4a308254abcaeb46c9cd1a4f33ab9b3b90a))

## [4.10.2](https://github.com/chasef07/abita_agent/compare/4.10.1...4.10.2) (2026-08-20)


### Bug Fixes

* **deps:** update all outdated packages ([#362](https://github.com/chasef07/abita_agent/issues/362)) ([bfd39cb](https://github.com/chasef07/abita_agent/commit/bfd39cb7db7e64058e27f4175379e668502eb328))

## [4.10.1](https://github.com/chasef07/abita_agent/compare/4.10.0...4.10.1) (2026-08-20)


### Bug Fixes

* use production TTS path for demo ([#360](https://github.com/chasef07/abita_agent/issues/360)) ([dc0a0dd](https://github.com/chasef07/abita_agent/commit/dc0a0ddab7bd976b3b99a984915e761849d9d133))

## [4.10.0](https://github.com/chasef07/abita_agent/compare/4.9.0...4.10.0) (2026-08-19)


### Features

* add Oscar routine vision notice ([#357](https://github.com/chasef07/abita_agent/issues/357)) ([b22eaa4](https://github.com/chasef07/abita_agent/commit/b22eaa49f9a9feaf2c05b2c9cd4a04648a242a2f))

## [4.9.0](https://github.com/chasef07/abita_agent/compare/4.8.1...4.9.0) (2026-08-18)


### Features

* **demo:** add rheumatology medication workflow ([#354](https://github.com/chasef07/abita_agent/issues/354)) ([8729b09](https://github.com/chasef07/abita_agent/commit/8729b098e2bf672d488f2fd6d26218132d3a2b63))
* **registration:** make routine vision SSN optional ([#351](https://github.com/chasef07/abita_agent/issues/351)) ([95bf144](https://github.com/chasef07/abita_agent/commit/95bf14412c644c3d14f67566b1c4ba5753a02066))
* **workflows:** refine staff task routing ([#353](https://github.com/chasef07/abita_agent/issues/353)) ([a7632c9](https://github.com/chasef07/abita_agent/commit/a7632c979b878e4bef87f3c860cc8e0c458040ab))


### Bug Fixes

* **prompt:** tighten human transfer policy ([#350](https://github.com/chasef07/abita_agent/issues/350)) ([87e9954](https://github.com/chasef07/abita_agent/commit/87e995495c983ce25260af1e5e19d0d2362ee684))

## [4.8.1](https://github.com/chasef07/abita_agent/compare/4.8.0...4.8.1) (2026-08-15)


### Bug Fixes

* announce office transfers before handoff ([#345](https://github.com/chasef07/abita_agent/issues/345)) ([c4b7cd1](https://github.com/chasef07/abita_agent/commit/c4b7cd1daf0aa31220598d1d60f22a1e8bb9dadd))

## [4.8.0](https://github.com/chasef07/abita_agent/compare/4.7.0...4.8.0) (2026-08-11)


### Features

* **tasks:** route staff tasks to Product ([#336](https://github.com/chasef07/abita_agent/issues/336)) ([a3c5748](https://github.com/chasef07/abita_agent/commit/a3c574859537f0baadff2d69dcef00d222377846))
* **tts:** use Rime inference on dev trunk ([#337](https://github.com/chasef07/abita_agent/issues/337)) ([348cdab](https://github.com/chasef07/abita_agent/commit/348cdabdd87b363573d71d27b8f29a4e78cc2c10))


### Bug Fixes

* **handoff:** restore Crystal River cell transfer ([#334](https://github.com/chasef07/abita_agent/issues/334)) ([2b97ea8](https://github.com/chasef07/abita_agent/commit/2b97ea882b3a2029dbc984140634d4fe2275c8a4))
* **transfer:** require tool-first human transfers ([#338](https://github.com/chasef07/abita_agent/issues/338)) ([9a47d20](https://github.com/chasef07/abita_agent/commit/9a47d20ad7a2282272ff1fd91ef7b9ffd11cf66d))

## [4.7.0](https://github.com/chasef07/abita_agent/compare/4.6.1...4.7.0) (2026-08-09)


### Features

* **closeout:** route AI call evidence to Product ([#326](https://github.com/chasef07/abita_agent/issues/326)) ([819095b](https://github.com/chasef07/abita_agent/commit/819095bc2b3ed4548c130bc9902149fe95496d15))
* **handoff:** route production offices through Product ([#332](https://github.com/chasef07/abita_agent/issues/332)) ([94eba96](https://github.com/chasef07/abita_agent/commit/94eba96879c5e62c449a0782e73c31b5b98004cc))
* **tts:** use Fish Audio on demo trunk ([#331](https://github.com/chasef07/abita_agent/issues/331)) ([d7b0d4e](https://github.com/chasef07/abita_agent/commit/d7b0d4e35d88cdcaa6d275912d337e7d594cd176))


### Bug Fixes

* **auth:** select Product credentials by tenant ([#333](https://github.com/chasef07/abita_agent/issues/333)) ([972ec21](https://github.com/chasef07/abita_agent/commit/972ec2126fb8541360eb9684ccd5e8becf37fa2a))

## [4.6.1](https://github.com/chasef07/abita_agent/compare/4.6.0...4.6.1) (2026-08-08)


### Bug Fixes

* **analytics:** stop sending call audio ([#327](https://github.com/chasef07/abita_agent/issues/327)) ([cab9039](https://github.com/chasef07/abita_agent/commit/cab9039a7e735ad5ec615e918540b18566aaf919))
* **scheduling:** preserve exact reschedule appointment types ([#310](https://github.com/chasef07/abita_agent/issues/310)) ([e12c875](https://github.com/chasef07/abita_agent/commit/e12c87553384f97e22f19cc870af56038a906e3f))

## [4.6.0](https://github.com/chasef07/abita_agent/compare/4.5.1...4.6.0) (2026-08-08)


### Features

* **tasks:** route demo tasks to Acuity Product ([#312](https://github.com/chasef07/abita_agent/issues/312)) ([bd60b6b](https://github.com/chasef07/abita_agent/commit/bd60b6b321718e346e5f4fc053a7586529195175))


### Bug Fixes

* **agent:** use native dynamic tool exposure ([#325](https://github.com/chasef07/abita_agent/issues/325)) ([dabcc45](https://github.com/chasef07/abita_agent/commit/dabcc454aa234e93dc4fdb52b6cf8753e46adc61))
* **insurance:** map Aetna government vision plans to iCare ([#323](https://github.com/chasef07/abita_agent/issues/323)) ([5c9763e](https://github.com/chasef07/abita_agent/commit/5c9763e45b6bee1f28529d3f6984657257eb3dce))

## [4.5.1](https://github.com/chasef07/abita_agent/compare/4.5.0...4.5.1) (2026-08-01)


### Reverts

* remove forced demo transfer fixes ([#320](https://github.com/chasef07/abita_agent/issues/320)) ([2f8502a](https://github.com/chasef07/abita_agent/commit/2f8502acd09c5dd8b73638987cf1a2302f139e7f))

## [4.5.0](https://github.com/chasef07/abita_agent/compare/4.4.0...4.5.0) (2026-08-01)


### Features

* improve transfer and office knowledge guidance ([#319](https://github.com/chasef07/abita_agent/issues/319)) ([82b1f2e](https://github.com/chasef07/abita_agent/commit/82b1f2e76a2fd2e33a2ab1d35eb22d1eadd9e277))
* **scheduling:** clarify medical and routine visit types ([#311](https://github.com/chasef07/abita_agent/issues/311)) ([a6d19a3](https://github.com/chasef07/abita_agent/commit/a6d19a3b55cb9a68dc58aebec37d180bf091906f))


### Bug Fixes

* guard internal model context from speech ([#313](https://github.com/chasef07/abita_agent/issues/313)) ([698db46](https://github.com/chasef07/abita_agent/commit/698db469fb66c80c6ade6425714c88ea195eb0db))
* **handoff:** simplify dev REFER transfer ([#315](https://github.com/chasef07/abita_agent/issues/315)) ([9a9a875](https://github.com/chasef07/abita_agent/commit/9a9a8753b2eb811eeded3ef30d7c3b21665fff29))
* **transfer:** force demo transfer tool ([#316](https://github.com/chasef07/abita_agent/issues/316)) ([bfe97c7](https://github.com/chasef07/abita_agent/commit/bfe97c778a26f6f250285d0edab77f51536fe887))
* **transfer:** use fallback-safe tool choice ([#317](https://github.com/chasef07/abita_agent/issues/317)) ([ea86fc4](https://github.com/chasef07/abita_agent/commit/ea86fc48009164e8a41381e50e1d2799b2a52a3d))

## [4.4.0](https://github.com/chasef07/abita_agent/compare/4.3.0...4.4.0) (2026-07-28)


### Features

* **handoff:** route demo transfers to Acuity Product ([41f889a](https://github.com/chasef07/abita_agent/commit/41f889a99df77a3298317bffc59a67a0bc472689))
* **scheduling:** resolve caller availability and speak weekdays ([#299](https://github.com/chasef07/abita_agent/issues/299)) ([3591f19](https://github.com/chasef07/abita_agent/commit/3591f19e1eb755f6f3e77983210a9fa7876697ca))
* **stt:** route AssemblyAI through LiveKit Inference ([#303](https://github.com/chasef07/abita_agent/issues/303)) ([8d2be46](https://github.com/chasef07/abita_agent/commit/8d2be46b0ea5ac493937084b5c11631402633fab))
* **transfers:** offer create_staff_task before transfer ([#306](https://github.com/chasef07/abita_agent/issues/306)) ([5385bb0](https://github.com/chasef07/abita_agent/commit/5385bb060788af50a0dc908e3963396cef40013a))


### Bug Fixes

* **handoff:** forward Acuity transfer token ([#309](https://github.com/chasef07/abita_agent/issues/309)) ([cf80eef](https://github.com/chasef07/abita_agent/commit/cf80eef5c4cbeff3030404831d2086af423077a8))
* harden office knowledge hook and upgrade LiveKit ([#300](https://github.com/chasef07/abita_agent/issues/300)) ([87bc0ae](https://github.com/chasef07/abita_agent/commit/87bc0aedb3430115a5524552c1647bbe0b374d66))
* **identity:** clarify patient identity ownership ([#297](https://github.com/chasef07/abita_agent/issues/297)) ([e83f02e](https://github.com/chasef07/abita_agent/commit/e83f02e3665c31c02955c14b07ff187eccdc3663))
* keep no-referrer marker internal and refresh README ([#305](https://github.com/chasef07/abita_agent/issues/305)) ([edb4f8f](https://github.com/chasef07/abita_agent/commit/edb4f8fca53134c49439bf5d68e82b38ac40be01))
* **knowledge:** recognize office location variants ([#308](https://github.com/chasef07/abita_agent/issues/308)) ([835524a](https://github.com/chasef07/abita_agent/commit/835524a388da6eae4dfd301b5bdf892734fe68d3))
* **runtime:** simplify voice language switching ([#301](https://github.com/chasef07/abita_agent/issues/301)) ([b2e4bab](https://github.com/chasef07/abita_agent/commit/b2e4bab3b1ee590110f38a9fe09e33ebfba48ecd))

## [4.3.0](https://github.com/chasef07/abita_agent/compare/4.2.1...4.3.0) (2026-07-26)


### Features

* enrich pre-call identity context ([#291](https://github.com/chasef07/abita_agent/issues/291)) ([b3b9a9c](https://github.com/chasef07/abita_agent/commit/b3b9a9c49a5ccc5446234454d3ef658d391230c3))

## [4.2.1](https://github.com/chasef07/abita_agent/compare/4.2.0...4.2.1) (2026-07-26)


### Bug Fixes

* **scheduling:** reuse complete availability safely ([5318948](https://github.com/chasef07/abita_agent/commit/5318948dfe934d6d91a5fc6c95b6df11fd0407d9))

## [4.2.0](https://github.com/chasef07/abita_agent/compare/4.1.0...4.2.0) (2026-07-26)


### Features

* replace knowledge tool with turn-time retrieval ([#281](https://github.com/chasef07/abita_agent/issues/281)) ([eb96133](https://github.com/chasef07/abita_agent/commit/eb96133b443712536185d7180cfa0e56f979f227))
* **scheduling:** resolve caller availability language ([#270](https://github.com/chasef07/abita_agent/issues/270)) ([f062800](https://github.com/chasef07/abita_agent/commit/f06280022b6862e301846cad8a6a420c3e32d898))
* **scheduling:** select cancellations by appointment reference ([#282](https://github.com/chasef07/abita_agent/issues/282)) ([8c5351a](https://github.com/chasef07/abita_agent/commit/8c5351abab59a5680f73c31a3b934dd3b04d60e6))
* use LiveKit Inference for LLMs ([#276](https://github.com/chasef07/abita_agent/issues/276)) ([4ccc53d](https://github.com/chasef07/abita_agent/commit/4ccc53d661b03c11dd8c571987fe343add37f7ab))


### Bug Fixes

* deduplicate LiveKit model analytics ([#278](https://github.com/chasef07/abita_agent/issues/278)) ([fef74e8](https://github.com/chasef07/abita_agent/commit/fef74e8b179213f1bc5c659d0244782b3b04c8b2))
* expose booked appointment reference for cancellation ([#288](https://github.com/chasef07/abita_agent/issues/288)) ([f569d6c](https://github.com/chasef07/abita_agent/commit/f569d6c9a37bdd26c48f89646c0daa0b81b9eac7))
* preserve closeout before office resolution ([#289](https://github.com/chasef07/abita_agent/issues/289)) ([cb7386e](https://github.com/chasef07/abita_agent/commit/cb7386e08b03807693d15938606628687a9c8bca))
* **runtime:** abandon startup on caller disconnect ([#286](https://github.com/chasef07/abita_agent/issues/286)) ([84152b4](https://github.com/chasef07/abita_agent/commit/84152b47153b6362381cc4317479603d91dadff5))


### Performance Improvements

* **identity:** defer pre-call candidate hydration ([#283](https://github.com/chasef07/abita_agent/issues/283)) ([9dd9fc1](https://github.com/chasef07/abita_agent/commit/9dd9fc163deb5438cdf4ebf91fe2f9d7c611ae9e))
* **scheduling:** reuse availability reads ([#285](https://github.com/chasef07/abita_agent/issues/285)) ([64db507](https://github.com/chasef07/abita_agent/commit/64db5076f0cffd56a46f921d2699ce8cd0c6bef9))

## [4.1.0](https://github.com/chasef07/abita_agent/compare/4.0.0...4.1.0) (2026-07-26)


### Features

* enable staff tasks for production offices ([#272](https://github.com/chasef07/abita_agent/issues/272)) ([0c616a3](https://github.com/chasef07/abita_agent/commit/0c616a359f4d3adaa6e9e4f466ad7ae98522c0ee))

## Changelog

Release Please maintains this file for releases after `4.0.0`. See
[GitHub Releases](https://github.com/chasef07/abita_agent/releases) for the
earlier release history.
