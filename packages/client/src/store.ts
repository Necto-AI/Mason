/**
 * A connector's own persistence, which is the SDK's only opinion about where state lives.
 *
 * Mason never holds a connector's data: the connector owns its repository and its durability, and this interface is the
 * seam the SDK uses for the two things it cannot keep in memory — the outbound replay journal, and whatever the vendor
 * implementation wants beside them.
 *
 * Values are JSON. A store that cannot survive a restart is not a store, which is why the in-memory one is named for
 * what it is and documented as test-only.
 */
export interface StoreEntry<T> {
	readonly key: string;
	readonly value: T;
	/** When it was written, epoch milliseconds. The ledger's pruning order is this, not the key. */
	readonly at: number;
}

export interface ConnectorStore {
	/** Which implementation this is, for a log line and for a connector that wants to assert on it. */
	readonly kind: string;
	close(): Promise<void>;
	read<T>(namespace: string, key: string): Promise<T | undefined>;
	write<T>(namespace: string, key: string, value: T): Promise<void>;
	delete(namespace: string, key: string): Promise<void>;
	/** Every entry in a namespace, oldest write first. */
	entries<T>(namespace: string): Promise<ReadonlyArray<StoreEntry<T>>>;
	/** Keep only the newest `keep` entries in a namespace and drop the rest. */
	prune(namespace: string, keep: number): Promise<void>;
}

/** The namespaces the SDK itself uses. A connector's own keys live under its own namespace. */
export const NAMESPACE = {
	/** Connector → mason calls that have not been acknowledged, replayed in `seq` order after a reconnect. */
	outbox: "sdk.outbox",
	/** `permissionId` → the answer this connector already reported, so an answer is applied once. */
	settled: "sdk.settled",
} as const;
