/**
 * Thin wrapper over the Automerge package surface we use. Exists so tests can
 * type-check against our vocabulary instead of Automerge's, and so a future
 * switch to /slim or a different init strategy touches only this file.
 */
export type {
	Doc,
	ChangeFn,
} from "@automerge/automerge/slim";

import type { Doc } from "@automerge/automerge/slim";
import type { SampleDocument } from "./AutomergeDocumentStore";

export type SampleDocHandle = Doc<SampleDocument>;
