# Changelog

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
