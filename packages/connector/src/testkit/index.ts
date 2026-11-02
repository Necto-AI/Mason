/**
 * The fake mason and the conformance suite, for a connector's own repository.
 *
 * `runConformance(fixture)` is the whole surface: a fixture describes its faces, its medium and its handlers, and the
 * suite drives a real socket through every case the protocol defines. Nothing here imports mason.
 */

export {
	CONNECTOR_ANSWERED_METHODS,
	type ConformanceCase,
	type ConformanceContext,
	type ConformanceFaces,
	ConformanceFailure,
	type ConformanceFixture,
	type ConformanceOptions,
	type ConformanceResult,
	conformanceCases,
	type Observed,
	open,
	runConformance,
	type UserFace,
	waitFor,
} from "./conformance.ts";
export {
	createFakeMason,
	type DeliveryRecord,
	type FakeMason,
	type FakeMasonGrants,
	type FakeMasonOptions,
	type InteractionRecord,
	type Recorded,
} from "./fake-mason.ts";
