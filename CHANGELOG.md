# Changelog

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
